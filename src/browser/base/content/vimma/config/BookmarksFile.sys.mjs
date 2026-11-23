/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// bookmarks.toml, mirrored into Places (docs/specs/bookmarks-file.md, Delivery slices 1 to 4:
// the mirror, Vimma's write-back, the outside write-back and `:bookmarks export`). One per app,
// started and fed by ConfigHost: it hands over config.toml's text after each read (inline tables,
// D2) and calls `tick` on each of its polls. The file is read beside config.toml's path (D1),
// settled (D15), checked by core's bookmarks-file.mjs, and applied to each table's workspace
// folder in Places as one plan (D4-D6). A change made in Places to a mirrored folder (the Library,
// Sync, an import) is written to the file a second after its burst under `write_back = "all"`,
// the default, merged three ways with the file and the base (core's bookmarks-merge.mjs,
// Behaviour 13), and put back from the file under "vimma" and "none" (Behaviour 14); one made from
// a private window is never written (Behaviour 12). A file with an error, or a missing file
// after one existed, pauses both directions (D9) until it reads again or `:bookmarks forget`
// (Behaviour 19); a run that deletes many bookmarks, or takes over a folder that has bookmarks
// the file lacks, asks first, and a yes approves those removals and no more (D14, Behaviour 18).
// Vimma's own bookmark keys in mirrored folders (host/bookmark-ops.mjs, setMirroredFolders) edit
// the file first and Places after it (Behaviour 10, D18) under `[bookmarks] write_back = "all"`
// or "vimma", and refuse under "none" or in a private window (Behaviour 11, 12). A table whose
// folder already has bookmarks takes them into the file (D7). A bookmark put back three times in
// ten minutes pauses its table both ways (open question 2). Every edit and apply runs in
// ConfigHost's one queue (D11).

import {
  BOOKMARKS_FILE,
  MAX_BOOKMARKS_FILE_BYTES,
  inlineBookmarkTables,
  formatBase,
  formatBookmarksFileError,
  parseBase,
  planMirror,
  readBookmarks,
  tooManyRemoved,
} from "../core/bookmarks-file.mjs";
import { mergeOutside } from "../core/bookmarks-merge.mjs";
import { PLACES_ROOTS } from "../core/bookmarks.mjs";
import {
  PUT_BACK_TIMES,
  PUT_BACK_WINDOW_MS,
  baseAfterEdit,
  editBookmarks,
  locateInBase,
  notePutBacks,
  serialQueue,
} from "../core/bookmarks-edit.mjs";
import { describeBookmarksFile, exportBookmarks } from "../core/bookmarks-export.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import {
  MIRRORED_REFUSAL,
  NONE_REFUSAL,
  PRIVATE_REFUSAL,
  setMirroredFolders,
} from "../host/bookmark-ops.mjs";
import { openUrl } from "../host/tab-ops.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/**
 * @import { Base, BookmarksFileError, BookmarksSource, MirrorOp, PlacesNode, WriteBack }
 *   from "../core/bookmarks-file.mjs"
 * @import { BookmarkChange, TreeNode } from "../core/bookmarks-edit.mjs"
 * @import { BookmarkletsSetting } from "../core/bookmarks.mjs"
 * @import { FileChange, FileChangeResult, FileWriter } from "../host/bookmark-ops.mjs"
 */

const lazy = /** @type {Lazy<"clearTimeout" | "setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Prefs for tests: the settle (D15), the burst (D15) and the question's time (Behaviour 7). */
const SETTLE_PREF = "vimma.bookmarks.settleMs";
const BURST_PREF = "vimma.bookmarks.burstMs";
const ASK_PREF = "vimma.bookmarks.askMs";
const DEFAULT_SETTLE_MS = 500;
const DEFAULT_BURST_MS = 1000;
const DEFAULT_ASK_MS = 60_000;
/** A key held or typed as the question appears is not its answer (`y` on a page). */
const ASK_SETTLE_MS = 1000;
/** The base (D4), in the profile: the model both sides last agreed on, with guids. */
const BASE_FILE = "vimma-bookmarks.json";
/**
 * Where `:bookmarks export!` keeps the file it replaces, beside it (Behaviour 17): `.bak`, then
 * `.bak.2`, `.bak.3`, …, each a new file, so no backup ever replaces an older one.
 */
const BACKUP_FILE = `${BOOKMARKS_FILE}.bak`;
const BACKUP_NAME = /^bookmarks\.toml\.bak(?:\.([1-9]\d{0,8}))?$/;

/** Places events that change a mirrored folder (PlacesEvent.webidl). */
const EVENTS = [
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-title-changed",
  "bookmark-url-changed",
  // Sync's dedupe gives a local item the guid of the same item from another device (D6): the
  // run finds it again by its place and URL, and the base takes the new guid.
  "bookmark-guid-changed",
];

/** @returns {PlacesUtilsApi} */
function places() {
  return ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;
}

/** IOUtils rejects with a DOMException named NotFoundError for a missing file. */
const notFound = (/** @type {unknown} */ e) => /** @type {Thrown} */ (e)?.name === "NotFoundError";

/**
 * The file a path names after its symbolic links (nsIFile's target follows the chain, also to
 * nothing), or the path itself when it is no link.
 * @param {string} path
 */
function resolved(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  try {
    return file.isSymlink() ? file.target : path;
  } catch {
    return path;
  }
}

/**
 * What a polled file (config.toml, routes.toml, bookmarks.toml) looks like now: "missing" when
 * nothing is at the path, else the file a link resolves to, its type, time and size, and for a
 * regular file within `maxBytes` the digest of its text (hashed off the main thread). The time
 * and size alone miss a change that keeps both: the Nix store gives every file the time 1, so a
 * `home-manager switch` that repoints the link at a file of the same size looked unchanged, as
 * did `cp -p` and `rsync -t` (#1474; the Omarchy theme poll had the same gap, #1455). Only a
 * regular file is hashed (a FIFO would block); a digest that fails, as for a file without read
 * permission, says "unreadable", so that the reader is asked and says why.
 * @param {string} path
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function fileSignature(path, maxBytes) {
  let info;
  try {
    info = await IOUtils.stat(path);
  } catch (e) {
    if (notFound(e)) return "missing";
    throw e;
  }
  const head = `${resolved(path)}|${info.type}|${info.lastModified}|${info.size}`;
  if (info.type !== "regular" || (info.size ?? 0) > maxBytes) return head;
  const digest = await IOUtils.computeHexDigest(path, "sha256").catch(() => "unreadable");
  return `${head}|${digest}`;
}

/** @param {string} text */
function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  return hash.finish(true);
}

/**
 * A PlacesBookmark event: the fields read here (PlacesEvent.webidl).
 * @typedef {{ type: string, guid: string, parentGuid?: string, oldParentGuid?: string,
 *   source: number, isTagging?: boolean, itemType?: number }} BookmarkEvent
 */

/**
 * What starts a run, and what a `y` approved: `approved` is the number of removals the
 * question showed, `asked` what the run read when it asked; `vimma` is the run after one of
 * Vimma's own edits (D18), `adopted` what a takeover wrote to the file before this run (D7).
 * `outside` is the number of removals from the file a `y` to Behaviour 13's question approved;
 * `keepRemovals`, its `n` or no answer: the removals are put back from the file and the rest of
 * the change is written. `retried`: the
 * run after one whose apply failed (a second failure pauses).
 * @typedef {{ trigger: "start" | "file" | "config" | "places" | "vimma", approved?: number,
 *   asked?: string, adopted?: string, outside?: number, keepRemovals?: boolean,
 *   retried?: boolean }} RunHow
 */

/**
 * Writes `path` in the edit queue (ConfigHost's writeFileNow): `compute` gets its text.
 * @typedef {(path: string, compute: (text: string | null) => { text: string | null } |
 *   { error: string }) => Promise<{ text: string | null } | { error: string, changed?: boolean }>}
 *   WriteFile
 */

/**
 * How a notice names who made a change (Behaviour 14): Firefox stands for every
 * DEFAULT-source change (the Library, the star, the menus, an add-on).
 * @param {number} source
 */
function sourceName(source) {
  const S = places().bookmarks.SOURCES;
  if (source === S.SYNC || source === S.SYNC_REPARENT_REMOVED_FOLDER_CHILDREN) return "Sync";
  if (source === S.IMPORT) return "import";
  if (source === S.RESTORE) return "restore";
  return "Firefox";
}

/** @param {number} n @param {string} word */
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Who changed `tables` in a burst, for a notice or a question: "Sync", "Firefox", ….
 * @param {Map<string, Set<string>>} burst
 * @param {readonly string[]} tables
 */
function whoChanged(burst, tables) {
  /** @type {Set<string>} */
  const who = new Set();
  for (const t of tables) for (const w of burst.get(t) ?? []) who.add(w);
  return who.size ? [...who].join(", ") : "Firefox";
}

/**
 * The hash of what the bookmarks file holds, for `:bookmarks forget`: bookmarks.toml's text, or
 * config.toml's inline tables alone (an unrelated config.toml edit changes nothing); "" when
 * there is no bookmarks file or it cannot be read.
 * @param {ReturnType<typeof readBookmarks> | null} r
 * @param {string | null} fileText
 */
function contentHash(r, fileText) {
  if (!r || r.from === null) return "";
  if (r.from === BOOKMARKS_FILE) return sha256(fileText ?? "");
  return sha256(JSON.stringify(r.tables));
}

export class BookmarksFileImpl {
  /**
   * @param {{ configPath: () => string, basePath?: string,
   *   initComplete?: () => Promise<void>, say?: (text: string) => void,
   *   ask?: (win: BrowserWindow | null, question: string, yes: () => void, no: () => void) =>
   *     (() => void) | null,
   *   whenFree?: (fn: (win: BrowserWindow | null) => void) => () => void,
   *   showErrors?: (errors: BookmarksFileError[]) => void,
   *   mirrored?: (guids: ReadonlySet<string>, refusal: string, write: FileWriter | null) =>
   *     void,
   *   queue?: ReturnType<typeof serialQueue>, writeFile?: WriteFile,
   *   reloadConfig?: () => void, newDatabase?: () => boolean,
   *   privateNow?: () => boolean,
   *   confirm?: (win: BrowserWindow | null, question: string, yes: () => void, no: () => void) =>
   *     (() => void) | null,
   *   open?: (win: BrowserWindow, path: string) => void }} options
   *   `configPath`: config.toml's path, not its symlink's target (D1); `queue`: the one edit queue (D11); `writeFile`: an atomic write of a file in it,
   *   without which nothing is written back; `reloadConfig`: config.toml is read again after
   *   an edit of its inline tables; `newDatabase`: Places made a new database at this start
   *   (D17); `privateNow`: the change came from a private window (Behaviour 12); `confirm`: the y/N
   *   of a command the user typed (`:bookmarks export!`), in its window; `open`: shows the file
   *   in a tab; the rest default to
   *   the profile, Places and the most recent window, and are replaced by tests
   */
  constructor(options) {
    this.configPath = options.configPath;
    this.basePath = options.basePath ?? PathUtils.join(PathUtils.profileDir, BASE_FILE);
    this.initComplete = options.initComplete ?? placesInitComplete;
    this.say = options.say ?? sayInRecentWindow;
    this.ask = options.ask ?? askInWindow;
    this.whenFree = options.whenFree ?? whenRecentWindowFree;
    this.showErrors = options.showErrors ?? (() => {});
    this.mirrored = options.mirrored ?? setMirroredFolders;
    /** The one queue of edits and applies (D11). */
    this.edits = options.queue ?? serialQueue();
    this.writeFile = options.writeFile ?? null;
    this.reloadConfig = options.reloadConfig ?? (() => {});
    this.newDatabase = options.newDatabase ?? placesDatabaseIsNew;
    this.privateNow = options.privateNow ?? changeWindowIsPrivate;
    this.confirm = options.confirm ?? confirmInWindow;
    this.open = options.open ?? openInTab;
    /**
     * `[bookmarks] write_back` of the last config.toml that applied (Behaviour 9, D12).
     * @type {WriteBack}
     */
    this.writeBack = "all";
    /** Places made a new database at this start: the first run writes nothing back (D17). */
    this.freshDatabase = false;
    /** @type {Set<string>} items added in a mirrored folder from a private window (Behaviour 12) */
    this.privateAdded = new Set();
    /** @type {Set<string>} items changed there from a private window: put back, never written */
    this.privateChanged = new Set();
    /** @type {Set<string>} items changed from a normal window: taken off the base's `local` */
    this.publicChanged = new Set();
    /** Counts the events above, so that a run forgets only what no event touched during it. */
    this.windowSeq = 0;
    /** @type {Map<string, number>} each guid's last event in those sets, by `windowSeq` */
    this.windowSeen = new Map();
    /** @type {Set<string>} items the file cannot hold that a notice already named */
    this.keptSaid = new Set();
    /** @type {Set<string>} tables paused both ways by the put-back loop guard */
    this.held = new Set();
    /** @type {Map<string, number[]>} each put-back bookmark's times (notePutBacks) */
    this.putBacks = new Map();
    /** @type {Map<string, string>} the table of each guid a burst's events named */
    this.eventTables = new Map();
    /** The bookmarks' content hash when the loop guard paused: a change of it lifts the pause. */
    this.heldContent = "";
    /** @type {FileWriter} */
    this.writer = (change) => this.edit(change);
    /**
     * config.toml's text as last read: undefined before ConfigHost's first read, null when the
     * file is missing. The first run waits for it, so inline tables are never read as gone.
     * @type {string | null | undefined}
     */
    this.configText = undefined;
    /**
     * `[bookmarks] bookmarklets` of the last config.toml that applied (D12, D13): a file with
     * errors, or one `:source <file>` loaded, allows nothing.
     * @type {BookmarkletsSetting}
     */
    this.bookmarklets = "none";
    /** @type {Base | null | undefined} undefined until read from disk */
    this.base = undefined;
    /** Places' start-up is done (D17). */
    this.placesReady = false;
    /** The first run has been asked for; runs before it are not. */
    this.ready = false;
    /** Running: start() was called and stop() was not. */
    this.active = false;
    /** start() was called (ConfigHost's first window). */
    this.started = false;
    /** @type {string} bookmarks.toml's stat at the last read; "" forces one */
    this.signature = "";
    /** @type {string | null} a changed stat waiting to settle */
    this.settling = null;
    /**
     * @type {{ why: "error" | "missing" | "declined" | "failed", input: string,
     *   file?: string } | null}
     */
    this.paused = null;
    /** @type {string} what the last applied run read: the file, the settings */
    this.lastInput = "";
    /** A run is applying: Places events wait for its closing compare (D5). */
    this.applying = false;
    /** @type {number | null} */
    this.burstTimer = null;
    /** @type {number | null} */
    this.settleTimer = null;
    /** @type {Map<string, Set<string>>} table → who changed it in the current burst */
    this.burst = new Map();
    /** @type {Map<string, string>} each mirrored guid → its table */
    this.tableOf = new Map();
    /** @type {(() => void) | null} closes the open (or waiting) question */
    this.cancelAsk = null;
    /** @type {((events: unknown[]) => void) | null} */
    this.listener = null;
    /** @type {BookmarksFileError[]} */
    this.errors = [];
    /** @type {BookmarksFileError[]} */
    this.warnings = [];
  }

  get path() {
    return PathUtils.join(PathUtils.parent(this.configPath()) ?? "/", BOOKMARKS_FILE);
  }

  /** Once, with ConfigHost's first window. */
  start() {
    if (this.started) return;
    this.started = true;
    this.activate();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    trackLibraryOpeners();
    this.initComplete()
      .then(async () => {
        if (!this.active) return;
        this.placesReady = true;
        try {
          this.freshDatabase = this.newDatabase();
        } catch (e) {
          console.warn("vimma: Places' database status unknown", e);
        }
        // Keys refuse and outside changes are watched from the start, before the first run:
        // a change made while a question waits, or the file is broken, is not lost (D9).
        this.follow(await this.loadBase());
        this.maybeFirstRun();
      })
      .catch((e) => console.error("vimma: bookmarks.toml not mirrored at start", e));
  }

  /** The first run, once Places is ready and config.toml has been read once (D17). */
  maybeFirstRun() {
    if (this.ready || !this.active || !this.placesReady || this.configText === undefined) return;
    this.ready = true;
    this.enqueue({ trigger: "start" });
  }

  deactivate() {
    this.active = false;
    this.ready = false;
    this.placesReady = false;
    for (const t of [this.burstTimer, this.settleTimer]) if (t !== null) lazy.clearTimeout(t);
    this.burstTimer = this.settleTimer = null;
    this.cancelAsk?.();
    this.unlisten();
    this.mirrored(new Set(), MIRRORED_REFUSAL, null);
    this.held.clear();
    this.putBacks.clear();
    this.privateAdded.clear();
    this.privateChanged.clear();
    this.publicChanged.clear();
    this.windowSeen.clear();
    this.report([], []);
    this.signature = "";
    this.lastInput = "";
  }

  stop() {
    this.started = false;
    this.deactivate();
  }

  /**
   * `:bookmarks forget` (Behaviour 19): turns the mirror off, across restarts, until the
   * bookmarks file's content changes or a file appears again; Places keeps every bookmark it
   * has. The base keeps only the hash of the content it was forgotten for.
   * @returns {Promise<string>} what to tell the user
   */
  forget() {
    if (!this.active) return Promise.resolve(":bookmarks forget: bookmarks in a file are off");
    /** @type {Promise<string>} */
    const run = this.edits.run(async () => {
      this.cancelAsk?.();
      this.burst.clear();
      this.held.clear();
      this.putBacks.clear();
      this.report([], []);
      const { text, problem } = await this.readFile();
      const r = problem ? null : readBookmarks({ file: text, config: this.configText ?? null });
      this.paused = null;
      this.lastInput = "";
      await this.saveBase({
        version: 1,
        source: r?.from ?? this.base?.source ?? BOOKMARKS_FILE,
        tables: [],
        forgotten: contentHash(r, text),
      });
      return `${BOOKMARKS_FILE} forgotten: Places keeps every bookmark; the mirror is off until the file changes`;
    });
    run.catch((e) => console.error("vimma: bookmarks base not dropped", e));
    return run;
  }

  /** The words `:bookmarks` takes while the mirror runs, for Tab. */
  words() {
    return this.active ? ["export", "export!", "forget"] : [];
  }

  /**
   * `:bookmarks export` and `:bookmarks export!` (Behaviour 17): Places' workspace folders
   * written as a new bookmarks.toml, then opened in a tab. An existing file is replaced only with
   * `!` and after a y/N that says what it holds; the old text is kept as bookmarks.toml.bak first,
   * so that nothing the file held is lost. Never from a private window (Behaviour 12). The
   * question is asked outside the edit queue and the export computed again inside it after a
   * `y`, from the file and Places as they are then (D11).
   * @param {BrowserWindow | null} win  the window the command was typed in
   * @param {boolean} replace  `export!`
   * @returns {Promise<string>} what to tell the user
   */
  async exportFile(win, replace) {
    if (!this.active) return ":bookmarks export: bookmarks in a file are off";
    if (win && isPrivate(win)) return PRIVATE_REFUSAL;
    if (!this.writeFile) return `${BOOKMARKS_FILE} cannot be written here; nothing exported`;
    const first = await this.edits.run(() => this.exportNow(win, replace, null));
    if (!("ask" in first)) return this.afterExport(first);
    /** @type {"yes" | "no" | "busy"} */
    const answer = await new Promise((resolve) => {
      const close = this.confirm(
        win,
        first.ask,
        () => resolve("yes"),
        () => resolve("no"),
      );
      if (!close) resolve("busy");
    });
    if (answer === "busy") {
      return `another question is open; nothing exported (:bookmarks export! again after it)`;
    }
    if (answer === "no") return `${BOOKMARKS_FILE} kept as it is; nothing exported`;
    const again = await this.edits.run(() => this.exportNow(win, true, first.existing));
    if ("ask" in again) {
      return `${BOOKMARKS_FILE} changed meanwhile; nothing written (:bookmarks export! again)`;
    }
    return this.afterExport(again);
  }

  /**
   * What an export says, once the mirror's run of the new file has ended: said last, so a
   * notice of that run (a bookmarklet not added) never hides what was written and left out.
   * @param {{ said: string, wrote?: boolean }} r
   */
  async afterExport(r) {
    if (r.wrote) await this.settledRuns();
    return r.said;
  }

  /**
   * The export, in the edit queue. `confirmed`: the text of the file a `y` agreed to replace;
   * a file that holds anything else is asked about again.
   * @param {BrowserWindow | null} win
   * @param {boolean} replace
   * @param {string | null} confirmed
   * @returns {Promise<{ said: string, wrote?: boolean } | { ask: string, existing: string }>}
   */
  async exportNow(win, replace, confirmed) {
    /** @type {string | null} */
    let backup = null;
    const writeFile = this.writeFile;
    if (!writeFile) return { said: `${BOOKMARKS_FILE} cannot be written here; nothing exported` };
    const { text: existing, problem } = await this.readFile();
    if (problem) return { said: `${BOOKMARKS_FILE} exists but is ${problem}; nothing exported` };
    // The base names the tables already mirrored, which the export must keep.
    await this.loadBase();
    const PU = places();
    const tree = /** @type {PlacesNode} */ (await PU.promiseBookmarksTree(""));
    // Each table's folder as the mirror's first load of the file will find it (D6).
    const r = exportBookmarks({
      places: tree,
      workspaces: WorkspaceStore.definitions.workspaces.map((d) => ({
        name: d.name,
        folder: d.bookmarksFolder ?? null,
      })),
      base: this.base,
    });
    if (!r.ok) return { said: r.error };
    const count = plural(r.bookmarks, "bookmark");
    if (existing !== null) {
      const holds = describeBookmarksFile(existing);
      if (!replace) {
        return { said: `${BOOKMARKS_FILE} exists (${holds}); :bookmarks export! replaces it` };
      }
      const plan = await this.backupPlan(existing);
      if (confirmed !== existing) {
        const keep = plan.path
          ? `keeping the old file as ${PathUtils.filename(plan.path)}`
          : `whose text is already in ${plan.same}`;
        return {
          ask: `replace ${BOOKMARKS_FILE} (${holds}) with ${count} from Firefox, ${keep}? y/N`,
          existing,
        };
      }
      // The old text in a backup of its own, right before the replace and only for one: if it
      // cannot be kept, nothing is replaced. A file that changed since the question is asked
      // about again, with no backup written.
      if ((await this.readFile()).text !== existing) return { ask: "changed", existing };
      if (plan.path) {
        const target = plan.path;
        const kept = await writeFile(target, (text) =>
          text === null
            ? { text: existing }
            : { error: `${PathUtils.filename(target)} appeared meanwhile; nothing replaced` },
        );
        if ("error" in kept) return { said: `${BOOKMARKS_FILE} not replaced: ${kept.error}` };
      }
      backup = plan.path ? PathUtils.filename(plan.path) : plan.same;
    }
    const w = await writeFile(this.path, (text) =>
      text === existing
        ? { text: r.text }
        : { error: `${BOOKMARKS_FILE} changed meanwhile; nothing written` },
    );
    if ("error" in w) return { said: w.error };
    // Behaviour 15: Places takes the names the file holds, so the first run finds both alike.
    const renamed = await this.renameInPlaces(r.renames);
    // Read now (after this task), not at the next poll.
    this.enqueue({ trigger: "file" });
    if (win && !win.closed) this.open(win, this.path);
    const tables = r.tables.map((t) => JSON.stringify(t.name));
    const shown = tables.length > 3 ? [...tables.slice(0, 3), `${tables.length - 3} more`] : tables;
    const out = [`${BOOKMARKS_FILE} written: ${count} in ${shown.join(", ") || "no table"}`];
    const left = [];
    const L = r.leftOut;
    if (L.outside) left.push(`${L.outside} outside workspace folders`);
    if (L.data) left.push(`${plural(L.data, "data: URL")}`);
    if (L.unholdable) left.push(`${L.unholdable} with a URL the file refuses`);
    if (L.deep) left.push(`${L.deep} deeper than 32 folders`);
    if (left.length) out.push(`left out: ${left.join(", ")}`);
    if (renamed) out.push(`${renamed} renamed in Firefox to match`);
    if (backup) out.push(`the old file is ${backup}`);
    if (inlineBookmarkTables(this.configText ?? "").length) {
      out.push(`config.toml's [bookmarks.<name>] tables are now ignored`);
    }
    return { said: out.join("; "), wrote: true };
  }

  /**
   * Where `export!` keeps the text it replaces (M1 of its review): `same`, the newest backup
   * when that already holds `text` (nothing is written again), else `path`, a name beside the
   * file that no file has: one past the highest numbered backup. A backup is never replaced.
   * @param {string} text
   * @returns {Promise<{ path: string, same: null } | { path: null, same: string }>}
   */
  async backupPlan(text) {
    const dir = PathUtils.parent(this.path) ?? "/";
    let newest = 0;
    let newestName = "";
    try {
      for (const child of await IOUtils.getChildren(dir)) {
        const name = PathUtils.filename(child);
        const m = BACKUP_NAME.exec(name);
        if (!m) continue;
        const n = m[1] ? Number(m[1]) : 1;
        if (n > newest) {
          newest = n;
          newestName = name;
        }
      }
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    if (newest) {
      const at = PathUtils.join(dir, newestName);
      const info = await IOUtils.stat(at).catch(() => null);
      if (info?.type === "regular" && (info.size ?? 0) <= MAX_BOOKMARKS_FILE_BYTES) {
        const held = await IOUtils.readUTF8(at).catch(() => null);
        if (held === text) return { path: null, same: newestName };
      }
    }
    const name = newest ? `${BACKUP_FILE}.${newest + 1}` : BACKUP_FILE;
    return { path: PathUtils.join(dir, name), same: null };
  }

  /**
   * Gives Places' items the names an export wrote for them; an item gone meanwhile is skipped
   * (the mirror's run then finds it as it is). Returns how many were renamed.
   * @param {readonly { guid: string, title: string }[]} renames
   */
  async renameInPlaces(renames) {
    const B = places().bookmarks;
    let n = 0;
    this.applying = true;
    try {
      for (const { guid, title } of renames) {
        try {
          await B.update({ guid, title });
          n++;
        } catch (e) {
          console.warn("vimma: exported bookmark not renamed in Places", e);
        }
      }
    } finally {
      this.applying = false;
      this.burst.clear();
    }
    return n;
  }

  /** Settles once every run asked for so far has ended (and every other queued edit, D11). */
  settledRuns() {
    return this.edits.idle();
  }

  /**
   * config.toml was read (ConfigHost): its inline tables and the settings may have changed.
   * @param {string | null} text  null: there is no config.toml
   * @param {BookmarkletsSetting} [bookmarklets]  of the last config.toml that applied
   * @param {WriteBack} [writeBack]  of the last config.toml that applied; applies live
   */
  configRead(text, bookmarklets = "none", writeBack = "all") {
    const first = this.configText === undefined;
    const changed = this.configText !== text || this.bookmarklets !== bookmarklets;
    this.configText = text;
    this.bookmarklets = bookmarklets;
    if (this.writeBack !== writeBack) {
      this.writeBack = writeBack;
      if (this.base !== undefined && this.active) this.follow(this.base);
    }
    if (first) this.maybeFirstRun();
    else if (this.ready && changed) this.enqueue({ trigger: "config" });
  }

  /**
   * ConfigHost's poll: reads bookmarks.toml once its stat is the same at two reads a settle
   * apart (D15). `force` (`:source`) reads it now.
   * @param {boolean} [force]
   * @returns {Promise<void>}
   */
  async tick(force = false) {
    if (!this.ready) return;
    const now = await this.stat();
    if (force) {
      this.signature = now;
      this.settling = null;
      return this.enqueue({ trigger: "file" });
    }
    if (now === this.signature) {
      this.settling = null;
      return undefined;
    }
    if (this.settling !== now) {
      this.settling = now;
      if (this.settleTimer !== null) lazy.clearTimeout(this.settleTimer);
      const ms = Services.prefs.getIntPref(SETTLE_PREF, DEFAULT_SETTLE_MS);
      this.settleTimer = lazy.setTimeout(() => {
        this.settleTimer = null;
        this.settled(now).catch((e) => console.error("vimma: bookmarks.toml check failed", e));
      }, ms);
    }
    return undefined;
  }

  /** @param {string} seen */
  async settled(seen) {
    const now = await this.stat();
    if (now !== seen) {
      this.settling = null;
      return this.tick();
    }
    this.settling = null;
    this.signature = now;
    return this.enqueue({ trigger: "file" });
  }

  stat() {
    return fileSignature(this.path, MAX_BOOKMARKS_FILE_BYTES);
  }

  /**
   * @param {RunHow} how
   * @returns {Promise<void>}
   */
  enqueue(how) {
    return this.edits
      .run(() => (this.active ? this.run(how) : undefined))
      .catch((e) => console.error("vimma: bookmarks.toml run failed", e));
  }

  async loadBase() {
    if (this.base !== undefined) return this.base;
    try {
      this.base = parseBase(await IOUtils.readUTF8(this.basePath));
    } catch (e) {
      if (!notFound(e)) console.warn("vimma: bookmarks base unreadable; matching by path", e);
      this.base = null;
    }
    return this.base;
  }

  /**
   * Keeps `base` and saves it in the profile. A save that fails (a full disk) never stops the
   * change it follows (#1347): the base in memory is right, and the next save writes it whole;
   * a step left undone after a file write would leave an item in neither the file nor the base.
   * @param {Base | null} base
   * @returns {Promise<boolean>} whether it was saved
   */
  async saveBase(base) {
    this.base = base;
    this.follow(base);
    try {
      if (!base) {
        await IOUtils.remove(this.basePath, { ignoreAbsent: true });
      } else {
        await IOUtils.writeUTF8(this.basePath, formatBase(base), {
          tmpPath: `${this.basePath}.tmp`,
        });
      }
      return true;
    } catch (e) {
      console.error("vimma: bookmarks base not saved; kept in memory until the next save", e);
      return false;
    }
  }

  /**
   * Keeps the keys' refusal (bookmark-ops) and the Places listener in step with the base; a
   * missing file's pause says how out of it.
   * @param {Base | null} base
   */
  follow(base) {
    this.tableOf = new Map();
    for (const t of base?.tables ?? []) {
      this.tableOf.set(t.folder, t.name);
      for (const e of t.entries) this.tableOf.set(e.guid, t.name);
    }
    this.keys((base?.tables ?? []).map((t) => t.folder));
    if (base?.tables.length) this.listen();
    else this.unlisten();
  }

  /**
   * Tells the bookmark keys which folders are mirrored and how a change there goes now: written
   * through the file, or refused.
   * @param {Iterable<string>} folders
   */
  keys(folders) {
    const write = !this.paused && this.writable() ? this.writer : null;
    this.mirrored(new Set(folders), this.refusal(), write);
  }

  /** What a key refused in a mirrored folder says now (Behaviour 11, D9). */
  refusal() {
    const file = this.paused?.file ?? BOOKMARKS_FILE;
    if (this.paused?.why === "missing") {
      return `${file} is missing, so these bookmarks are paused: restore it, or :bookmarks forget`;
    }
    if (this.paused?.why === "error") {
      return `${BOOKMARKS_FILE} has errors, so these bookmarks are paused until it reads again`;
    }
    if (this.paused) return `${BOOKMARKS_FILE} is paused until the file changes; nothing written`;
    if (this.writeBack === "none") return NONE_REFUSAL;
    return MIRRORED_REFUSAL;
  }

  listen() {
    if (this.listener) return;
    this.listener = (events) => this.onEvents(/** @type {BookmarkEvent[]} */ (events));
    places().observers.addListener(EVENTS, this.listener);
  }

  unlisten() {
    if (!this.listener) return;
    places().observers.removeListener(EVENTS, this.listener);
    this.listener = null;
  }

  /**
   * A change to a mirrored folder starts a burst, written to the file (Behaviour 13) or put back
   * (Behaviour 14) a second after its last event. The mirror's own writes, and the startup
   * restore's (D17), start none.
   * @param {BookmarkEvent[]} events
   */
  onEvents(events) {
    const S = places().bookmarks.SOURCES;
    let any = false;
    /** @type {Map<string, string>} */
    const named = new Map();
    /** @type {BookmarkEvent[]} */
    const mine = [];
    for (const e of events) {
      if (e.isTagging || e.source === S.RESTORE_ON_STARTUP) continue;
      const table =
        this.tableOf.get(e.guid) ??
        (e.parentGuid ? this.tableOf.get(e.parentGuid) : undefined) ??
        (e.oldParentGuid ? this.tableOf.get(e.oldParentGuid) : undefined);
      if (e.type === "bookmark-guid-changed") {
        // A table's folder deduped against another device's has a guid no table knows: the run
        // finds it by its name at the toolbar's top (D6).
        if (table ? !this.held.has(table) : e.parentGuid === PLACES_ROOTS.toolbar) {
          any = true;
        }
        continue;
      }
      if (!table || this.held.has(table)) continue;
      any = true;
      named.set(e.guid, table);
      mine.push(e);
      const who = this.burst.get(table) ?? new Set();
      who.add(sourceName(e.source));
      this.burst.set(table, who);
    }
    if (!any || this.applying || this.paused || !this.ready) {
      if (this.applying || this.paused) this.burst.clear();
      return;
    }
    // Behaviour 12: what is added or changed from a private window is never written; an addition
    // stays in Places only, a change is put back. The event names no window, so the window it
    // came from is the focused one, or the browser window that opened it (the Library, a
    // bookmark dialog). A later change from a normal window makes the item an ordinary one.
    if (this.writeBack === "all" && mine.some((e) => e.source === S.DEFAULT)) {
      const isPrivate = this.privateNow();
      for (const e of mine) {
        if (e.source !== S.DEFAULT || e.type === "bookmark-removed") continue;
        if (!isPrivate) {
          // Only a change to the item itself: a sort moves every bookmark of the folder, and a
          // folder made in a private window holds bookmarks no normal window touched.
          const own =
            e.itemType === places().bookmarks.TYPE_BOOKMARK &&
            (e.type !== "bookmark-moved" || e.parentGuid !== e.oldParentGuid);
          if (!own) continue;
          this.windowSeen.set(e.guid, ++this.windowSeq);
          this.publicChanged.add(e.guid);
          this.privateAdded.delete(e.guid);
          this.privateChanged.delete(e.guid);
          continue;
        }
        this.windowSeen.set(e.guid, ++this.windowSeq);
        this.publicChanged.delete(e.guid);
        if (e.type === "bookmark-added") this.privateAdded.add(e.guid);
        else if (!this.privateAdded.has(e.guid)) this.privateChanged.add(e.guid);
      }
    }
    // Only a burst that will be put back names its items for the loop guard.
    for (const [g, t] of named) this.eventTables.set(g, t);
    if (this.burstTimer !== null) lazy.clearTimeout(this.burstTimer);
    this.burstTimer = lazy.setTimeout(
      () => {
        this.burstTimer = null;
        this.enqueue({ trigger: "places" });
      },
      Services.prefs.getIntPref(BURST_PREF, DEFAULT_BURST_MS),
    );
  }

  /**
   * Reads bookmarks.toml; null when it does not exist. Only a regular file is read (a FIFO
   * would block the queue), and never more than the limit, even if it grows meanwhile
   * (Behaviour 4).
   * @returns {Promise<{ text: string | null, problem: string | null }>}
   */
  async readFile() {
    try {
      const info = await IOUtils.stat(this.path);
      if (info.type !== "regular") return { text: null, problem: "not a regular file; not read" };
      if ((info.size ?? 0) > MAX_BOOKMARKS_FILE_BYTES) {
        return { text: null, problem: "larger than 4 MiB; not read" };
      }
      const bytes = await IOUtils.read(this.path, { maxBytes: MAX_BOOKMARKS_FILE_BYTES + 1 });
      if (bytes.length > MAX_BOOKMARKS_FILE_BYTES) {
        return { text: null, problem: "larger than 4 MiB; not read" };
      }
      return { text: new TextDecoder().decode(bytes), problem: null };
    } catch (e) {
      if (notFound(e)) return { text: null, problem: null };
      throw e;
    }
  }

  /**
   * Sets the errors and warnings the status bar keeps, and logs a change of them.
   * @param {BookmarksFileError[]} errors
   * @param {BookmarksFileError[]} warnings
   */
  report(errors, warnings) {
    warnings = [...warnings, ...this.holdWarnings()];
    const key = JSON.stringify([errors, warnings]);
    if (key !== JSON.stringify([this.errors, this.warnings])) {
      if (errors.length) {
        console.error(
          `vimma: bookmarks paused: ${errors.length} error(s):\n  ${errors
            .map(formatBookmarksFileError)
            .join("\n  ")}`,
        );
      }
      if (warnings.length) {
        console.warn(`vimma: ${warnings.map(formatBookmarksFileError).join("\n  ")}`);
      }
    }
    this.errors = errors;
    this.warnings = warnings;
    this.showErrors([...errors, ...warnings]);
  }

  /** The status bar's line for each table the put-back loop guard paused (open question 2). */
  holdWarnings() {
    return [...this.held].map((t) => ({
      file: BOOKMARKS_FILE,
      line: 0,
      message: `${JSON.stringify(t)} paused both ways: a bookmark was put back ${PUT_BACK_TIMES} times in ${
        PUT_BACK_WINDOW_MS / 60_000
      } minutes (another device changing it back?); edit the file to go on`,
    }));
  }

  /**
   * Pauses for a missing file (D9): the bookmarks file, or config.toml holding the inline
   * tables, existed and is gone; nothing is deleted.
   * @param {string} file
   * @param {string} input
   * @param {BookmarksFileError[]} warnings
   */
  pauseMissing(file, input, warnings) {
    if (this.paused?.why !== "missing") this.say(`${file} is missing; bookmarks paused`);
    this.paused = { why: "missing", input, file };
    this.report([], warnings);
    this.follow(this.base ?? null);
  }

  /**
   * One run (D4, D5): reads the bookmarks file and Places; under `write_back = "all"` first writes
   * Places' outside changes to the file, merged three ways (Behaviour 13); then plans, asks when it
   * must, applies, and ends with one more compare, so that a change that landed during the apply
   * is handled then. Runs one at a time (enqueue).
   * @param {RunHow} how
   * @returns {Promise<void>}
   */
  async run(how) {
    if (!this.ready) return;
    // Who changed what since the last run (Behaviour 14), taken now, so that a change that lands
    // during this run is named by the run that writes it.
    const burst = new Map(this.burst);
    this.burst.clear();
    const eventTables = new Map(this.eventTables);
    this.eventTables.clear();
    // What a private window touched until now: cleared once this run has handled it.
    const privateSeen = [...this.privateAdded, ...this.privateChanged, ...this.publicChanged];
    const seenBefore = this.windowSeq;
    let base = await this.loadBase();
    let { text: fileText, problem } = await this.readFile();
    let configText = this.configText ?? null;
    const bookmarklets = this.bookmarklets;
    /** @returns {ReturnType<typeof readBookmarks>} */
    const readAll = () =>
      problem
        ? {
            from: /** @type {const} */ ("bookmarks.toml"),
            tables: [],
            errors: [{ file: BOOKMARKS_FILE, line: 0, message: problem }],
            warnings: [],
          }
        : readBookmarks({ file: fileText, config: configText });
    let r = readAll();
    const source = r.from;
    const inputOf = () =>
      JSON.stringify([
        source,
        fileText === null ? "" : sha256(fileText),
        source === "config.toml" && configText !== null ? sha256(configText) : "",
        bookmarklets,
      ]);
    let input = inputOf();

    // `:bookmarks forget` holds, across restarts, until the bookmarks' content changes or a
    // file appears again (Behaviour 19); then the run is a first load.
    if (base?.forgotten !== undefined) {
      if (source === null || contentHash(problem ? null : r, fileText) === base.forgotten) {
        this.report([], r.warnings);
        return;
      }
      base = null;
    }
    // D9: a missing file after one existed is a pause, never "delete every bookmark".
    if (!problem && fileText === null && base?.source === BOOKMARKS_FILE) {
      this.pauseMissing(BOOKMARKS_FILE, input, r.warnings);
      return;
    }
    if (!problem && fileText === null && base?.source === "config.toml" && configText === null) {
      this.pauseMissing("config.toml", input, r.warnings);
      return;
    }
    if (source === null && !base) {
      this.paused = null;
      this.report([], r.warnings);
      this.follow(null);
      return;
    }
    if (r.errors.length) {
      // config.toml that does not parse says so itself; it pauses only inline tables in use.
      if (source === "config.toml" && base?.source !== "config.toml") {
        this.report([], r.warnings);
        return;
      }
      this.paused = { why: "error", input };
      this.report(r.errors, r.warnings);
      this.follow(base);
      return;
    }
    this.report([], r.warnings);
    // Behaviour 7: no answer, or no, holds both ways until the file (or its settings) change.
    if (
      this.paused?.why === "declined" &&
      this.paused.input === input &&
      how.approved === undefined
    ) {
      return;
    }
    /** @type {number | null} */
    let approved = how.approved ?? null;
    if (how.asked !== undefined && how.asked !== input) approved = null; // changed: ask again
    const wasPaused = this.paused;
    if (
      !wasPaused &&
      how.trigger !== "places" &&
      how.trigger !== "start" &&
      how.trigger !== "vimma" &&
      approved === null &&
      base &&
      this.lastInput === input
    ) {
      return; // D5: nothing changed on the file's side since the last run
    }
    // The file changed from outside Vimma: a table the loop guard paused goes on (open
    // question 2), its edit being the user's answer.
    let content = contentHash(r, fileText);
    if (
      (how.trigger === "file" || how.trigger === "config") &&
      this.held.size &&
      content !== this.heldContent
    ) {
      this.held.clear();
      this.putBacks.clear();
      this.report([], r.warnings);
    }

    // Behaviour 13: Places' outside changes go to the file first, so the plan below finds the
    // file, the base and Places in agreement on them.
    /** @type {Awaited<ReturnType<BookmarksFileImpl["writeOutside"]>> | undefined} */
    let outside;
    if (this.writeBack === "all" && this.writeFile && base && source) {
      const text = source === BOOKMARKS_FILE ? fileText : configText;
      outside = await this.writeOutside(source, base, how, input, burst, text ?? "");
      if (!outside) return;
      if (outside.written !== null) {
        if (source === BOOKMARKS_FILE) fileText = outside.written;
        else configText = outside.written;
        r = readAll();
        input = inputOf();
        content = contentHash(r, fileText);
      }
      if (!outside.putBack) base = outside.base;
    }
    const local = outside ? outside.merge.local : [];
    const keep = outside ? outside.merge.keep : [];

    const tables = r.tables;
    const PU = places();
    const ws = WorkspaceStore.definitions.workspaces.map((d) => ({
      name: d.name,
      folder: d.bookmarksFolder ?? null,
    }));
    /**
     * @param {{ tables: Base["tables"] } | null} from
     * @param {number | null} ok
     * @param {PlacesNode} [tree]  Places as already read; read now when absent
     */
    const plan = async (from, ok, tree) =>
      planMirror({
        tables,
        base: from,
        places: tree ?? /** @type {PlacesNode} */ (await PU.promiseBookmarksTree("")),
        workspaces: ws,
        bookmarklets,
        approved: ok,
        hold: this.held,
        keep,
        makeGuid: () => PU.history.makeGuid(),
      });
    // After a merge, the plan reads Places as the merge did. Reading it again would show a change
    // that landed since (Sync) as a divergence from the file and put it back, where Behaviour 13
    // writes it: the closing compare below finds it instead, and the next run merges it (#1365).
    let p = await plan(base, approved, outside && !outside.putBack ? outside.tree : undefined);
    // D7: a table taking over a folder writes the folder's bookmarks the file lacks to the file,
    // then reads it again; what the file cannot hold is still asked about.
    if (p.adopt.length && !how.adopted && source && this.writable()) {
      const adopted = await this.adopt(source, p.adopt);
      if (adopted) return this.run({ ...how, adopted });
    }
    if (p.ask) {
      this.paused = { why: "declined", input };
      this.follow(base);
      this.question(p.ask, p.removing, input);
      return;
    }
    // The folders this run mirrors are mirrored for the keys before Places changes: a key pressed
    // during the apply is refused there, or queued behind this run to go through the file.
    this.keys([...(base?.tables ?? []).map((t) => t.folder), ...p.links.map((l) => l.folder)]);
    let failed = false;
    try {
      await this.apply(p.ops);
    } catch (e) {
      console.warn("vimma: bookmarks.toml apply failed; trying again from Places as it is", e);
      failed = true;
    }
    /** @type {Base} */
    const next = {
      version: 1,
      source: /** @type {Base["source"]} */ (source ?? base?.source ?? BOOKMARKS_FILE),
      tables: p.base.tables,
      ...(local.length ? { local } : {}),
    };
    // D5: the closing compare, against what this run made (and Sync racing an apply: one more
    // try from the new state). What landed meanwhile is an outside change, asked about like any.
    const again = await plan(next, null);
    // Under "all", what landed during the apply is an outside change to write, never one to put
    // back (which would delete a bookmark just made): the next run merges it. After an apply that
    // failed part way the base stays what the merge saved, so what did land reads as agreement in
    // that run, not as removals from the file; a second failure in a row pauses, so a plan that
    // cannot be applied does not keep the queue busy. The run after a failed apply merges what
    // landed the same way: putting it back there would upload the revert to Sync (#1368).
    const merging = !!outside && !outside.putBack;
    const rerun = merging && (failed || again.ops.length > 0 || again.ask !== null);
    if (merging && failed && how.retried) {
      console.error("vimma: bookmarks.toml apply failed twice; paused");
      this.paused = { why: "failed", input: "" };
      this.follow(base);
      this.say(`${BOOKMARKS_FILE}: bookmarks could not be applied; paused until a change`);
      return;
    }
    if (!rerun && again.ask) {
      this.paused = { why: "declined", input };
      await this.saveBase(next);
      this.question(again.ask, again.removing, input);
      return;
    }
    if (!rerun && again.ops.length) {
      try {
        await this.apply(again.ops);
      } catch (e) {
        if (failed) {
          console.error("vimma: bookmarks.toml apply failed twice; paused", e);
          this.paused = { why: "failed", input: "" };
          this.follow(base);
          this.say(`${BOOKMARKS_FILE}: bookmarks could not be applied; paused until a change`);
          return;
        }
      }
    }
    const touched = new Set(rerun ? p.touched : [...p.touched, ...again.touched]);
    const putBack = rerun ? p.ops : [...p.ops, ...again.ops];
    if (!rerun) p = { ...again, removed: [...p.removed, ...again.removed], skipped: p.skipped };
    this.paused = null;
    /** @type {Base | null} */
    const saved = rerun && failed ? base : rerun ? next : { ...next, tables: again.base.tables };
    /** @type {string | null} */
    let holdSaid = null;
    if (outside && !outside.putBack) {
      holdSaid = this.guardItems(outside.merge.putBack, r.warnings, content);
    } else if (how.trigger === "places" && !outside) {
      holdSaid = this.guard(
        putBack,
        base,
        /** @type {Base} */ (saved),
        r.warnings,
        content,
        eventTables,
      );
    }
    await this.saveBase(source === null && !saved?.tables.length ? null : saved);
    // What a private window touched is now in the base's `local` list, or put back.
    // A guid an event touched during this run is left for the next one, which reads it again.
    for (const g of privateSeen) {
      if ((this.windowSeen.get(g) ?? 0) > seenBefore) continue;
      this.privateAdded.delete(g);
      this.privateChanged.delete(g);
      this.publicChanged.delete(g);
      this.windowSeen.delete(g);
    }
    for (const link of p.links) this.link(link.name, link.folder);
    const loaded = this.lastInput !== input;
    this.lastInput = input;
    this.notices(
      how,
      p,
      loaded,
      bookmarklets,
      burst,
      touched,
      holdSaid,
      outside,
      privateSeen.length > 0,
    );
    if (rerun) this.enqueue({ trigger: "places", retried: failed });
  }

  /**
   * Behaviour 13 (`write_back = "all"`): merges Places' outside changes with the file and the base
   * (core's mergeOutside) and writes them to the file in the edit queue (D11), computed again from
   * the file's text when it is written, once more if it changed meanwhile. A removal of many asks
   * first (D14): `y` writes it; `n` or no answer puts the removals back and writes the rest. A
   * merge or a write that fails
   * writes nothing and pauses until the file changes, so Places keeps the change: never lost.
   * Returns null when the run stops here (it asked, or paused); `putBack`: the run writes nothing
   * and puts Places back (the first run on a new Places database, D17).
   * @param {BookmarksSource} source
   * @param {Base} base
   * @param {RunHow} how
   * @param {string} input
   * @param {Map<string, Set<string>>} burst
   * @param {string} text  the bookmarks file's text as the run read it
   */
  async writeOutside(source, base, how, input, burst, text) {
    const tree = /** @type {PlacesNode} */ (await places().promiseBookmarksTree(""));
    /** @type {Omit<Parameters<typeof mergeOutside>[0], "text">} */
    const options = {
      source,
      base,
      places: tree,
      bookmarklets: this.bookmarklets,
      hold: this.held,
      local: new Set(
        [...(base.local ?? []), ...this.privateAdded].filter((g) => !this.publicChanged.has(g)),
      ),
      putBackGuids: new Set(this.privateChanged),
      keepRemovals: !!how.keepRemovals,
    };
    const first = mergeOutside({ ...options, text });
    if (!first.ok) {
      this.failOutside(first.error, input, base);
      return null;
    }
    const putBack = how.trigger === "start" && this.freshDatabase;
    if (putBack) return { merge: first, base, written: null, putBack: true, tree };
    const removing = first.removing.reduce((n, x) => n + x.count, 0);
    const many = tooManyRemoved(first.removing.map((x) => ({ removed: x.count, had: x.had })));
    if (many && !(how.outside !== undefined && removing <= how.outside)) {
      const who = whoChanged(
        burst,
        first.removing.map((x) => x.table),
      );
      const from = first.removing.map((x) => JSON.stringify(x.table)).join(", ");
      this.paused = { why: "declined", input };
      this.follow(base);
      this.askYesNo(
        `${who} removes ${plural(removing, "bookmark")} from ${from}: remove them from ${source}? y/N`,
        () => {
          this.paused = null;
          this.enqueue({ trigger: "places", outside: removing });
        },
        () => {
          this.paused = null;
          // Only the removals are put back: what the same batch added, renamed or moved is
          // still written, so declining (or not answering) never deletes it everywhere.
          this.say(
            `${source}: ${who}'s removal of ${plural(removing, "bookmark")} put back from the file; the rest of the change is written`,
          );
          this.enqueue({ trigger: "places", keepRemovals: true });
        },
      );
      return null;
    }
    /** @type {Base} */
    const merged = {
      version: 1,
      source,
      tables: first.base.tables,
      ...(first.local.length ? { local: first.local } : {}),
    };
    if (first.text === null) {
      return { merge: first, base: merged, written: null, putBack: false, tree };
    }
    let merge = first;
    const allowed = how.outside ?? (many ? 0 : removing);
    /** @param {string | null} now */
    const compute = (now) => {
      if (now === null) return { error: `${source} is missing; Firefox's change kept` };
      const m = now === text ? first : mergeOutside({ ...options, text: now });
      if (!m.ok) return { error: m.error };
      const n = m.removing.reduce((k, x) => k + x.count, 0);
      if (
        n > allowed &&
        tooManyRemoved(m.removing.map((x) => ({ removed: x.count, had: x.had })))
      ) {
        return { error: `${source} changed meanwhile; Firefox's change kept` };
      }
      merge = m;
      return { text: m.text };
    };
    const path = source === BOOKMARKS_FILE ? this.path : this.configPath();
    for (let attempt = 0; ; attempt++) {
      const w = this.writeFile
        ? await this.writeFile(path, compute)
        : { error: `${source} cannot be written now` };
      if ("error" in w) {
        // D11: a file changed while it was edited is edited again once from its new text.
        if ("changed" in w && w.changed && attempt === 0) continue;
        this.failOutside(w.error, input, base);
        return null;
      }
      if (w.text !== null && source === "config.toml") {
        this.configText = w.text;
        this.reloadConfig();
      }
      /** @type {Base} */
      const after = {
        version: 1,
        source,
        tables: merge.base.tables,
        ...(merge.local.length ? { local: merge.local } : {}),
      };
      // Saved at once, so the base and the file agree even if Firefox stops before the run ends.
      await this.saveBase(after);
      return { merge, base: after, written: w.text, putBack: false, tree };
    }
  }

  /**
   * Outside changes that cannot be written (the merge refused, the file could not be written):
   * nothing is put back, so Places keeps them; both ways pause until the file changes.
   * @param {string} error
   * @param {string} input
   * @param {Base} base
   */
  failOutside(error, input, base) {
    console.error(`vimma: Firefox's bookmark change not written: ${error}`);
    if (this.paused?.why !== "failed") {
      this.say(
        `${BOOKMARKS_FILE}: Firefox's change could not be written (${error}); kept in Firefox, paused until the file changes`,
      );
    }
    this.paused = { why: "failed", input };
    this.follow(base);
  }

  /** Whether Vimma's keys write the file now (`write_back = "all"` or "vimma", a writer). */
  writable() {
    return (this.writeBack === "all" || this.writeBack === "vimma") && !!this.writeFile;
  }

  /**
   * D7: writes what taken-over folders hold that their tables lack to the end of each table.
   * Returns what to say, or null when nothing was written.
   * @param {BookmarksSource} source
   * @param {{ table: string, items: { names: string[], url: string | null, from?: string }[] }[]}
   *   adopt
   */
  async adopt(source, adopt) {
    const w = await this.writeEdits(
      source,
      adopt.map((a) => ({ op: "append", table: a.table, items: a.items })),
    );
    if ("error" in w) {
      console.warn(`vimma: bookmarks not taken into ${source}: ${w.error}`);
      return null;
    }
    const said = w.results
      .map((r, i) => ({ n: r.written, table: /** @type {{ table: string }} */ (adopt[i]).table }))
      .filter((x) => x.n)
      .map((x) => `${plural(x.n, "bookmark")} of ${JSON.stringify(x.table)} written to ${source}`);
    // Behaviour 15: a second item of one name is written, and renamed in Places, as `name (2)`.
    const renamed = adopt
      .flatMap((a) => a.items)
      .filter((i) => i.from !== undefined)
      .map((i) => `${JSON.stringify(i.from)} as ${JSON.stringify(i.names.at(-1))}`);
    if (renamed.length) said.push(`a name a folder holds twice is written ${renamed.join(", ")}`);
    return said.length ? `${BOOKMARKS_FILE}: ${said.join(", ")}` : null;
  }

  /**
   * The put-back loop guard (open question 2, answer b): notes each bookmark a burst's run put
   * back; a table where one was put back three times in ten minutes pauses both ways, with a
   * notice and a line in the status bar, until the file changes.
   * @param {readonly MirrorOp[]} ops  what the run did
   * @param {Base | null} before  the base the run started from
   * @param {Base} after  the base it saved
   * @param {BookmarksFileError[]} warnings
   * @param {string} content  the bookmarks' hash now: the pause lasts until it changes
   * @param {ReadonlyMap<string, string>} eventTables  the table of each guid the burst named
   * @returns {string | null} what to say
   */
  guard(ops, before, after, warnings, content, eventTables) {
    /** @type {{ table: string, id: string }[]} */
    const items = [];
    for (const o of ops) {
      const guid = o.op === "reorder" ? o.parentGuid : o.guid;
      const at = locateInBase(after, guid) ?? locateInBase(before, guid);
      const table = at?.table ?? eventTables.get(guid);
      if (!table) continue;
      // A line of the file by its path; an item only Places had, by its guid (Sync keeps it).
      const id = at
        ? `${o.op === "reorder" ? "order" : at.kind}\0${at.path.join("\0")}`
        : `guid\0${guid}`;
      items.push({ table, id });
    }
    return this.guardItems(items, warnings, content);
  }

  /**
   * The loop guard's count of the bookmarks one run put back (open question 2): under
   * `write_back = "all"` those where the file won over Places' change, by guid (Sync keeps it).
   * @param {readonly { table: string, id: string }[]} items
   * @param {BookmarksFileError[]} warnings
   * @param {string} content  the bookmarks' hash now: the pause lasts until it changes
   * @returns {string | null} what to say
   */
  guardItems(items, warnings, content) {
    if (!items.length) return null;
    const tripped = notePutBacks(this.putBacks, items, Date.now()).filter((t) => !this.held.has(t));
    if (!tripped.length) return null;
    for (const t of tripped) this.held.add(t);
    this.heldContent = content;
    this.report([], warnings);
    return `${BOOKMARKS_FILE}: ${tripped.map((t) => JSON.stringify(t)).join(", ")} put back ${PUT_BACK_TIMES} times in ${
      PUT_BACK_WINDOW_MS / 60_000
    } minutes; paused both ways until the file changes`;
  }

  /**
   * Writes edits of the bookmarks file in turn, inside the edit queue (D11), through a temporary
   * file renamed over it; computed again once from the new text when the file changed meanwhile.
   * After an edit of config.toml's inline tables, config.toml is read again (outside the queue).
   * @param {BookmarksSource} source
   * @param {readonly BookmarkChange[]} changes
   * @returns {Promise<{ results: Extract<ReturnType<typeof editBookmarks>, { ok: true }>[],
   *   written: boolean, before: string | null, after: string | null } | { error: string }>}
   *   `before` and `after`: the text read and the text written (null: nothing written)
   */
  async writeEdits(source, changes) {
    if (!this.writeFile) return { error: NONE_REFUSAL };
    const path = source === BOOKMARKS_FILE ? this.path : this.configPath();
    /** @type {Extract<ReturnType<typeof editBookmarks>, { ok: true }>[]} */
    let results = [];
    /** @param {string | null} text */
    const compute = (text) => {
      results = [];
      if (text === null) return { error: `${source} is missing; nothing written` };
      let out = text;
      for (const c of changes) {
        const r = editBookmarks(out, source, c, { bookmarklets: this.bookmarklets });
        if (!r.ok) return { error: r.error };
        results.push(r);
        out = r.text;
      }
      return { text: out === text ? null : out };
    };
    /** @type {string | null} */
    let read = null;
    /** @param {string | null} text */
    const reading = (text) => {
      read = text;
      return compute(text);
    };
    for (let attempt = 0; ; attempt++) {
      const w = await this.writeFile(path, reading);
      if (!("error" in w)) {
        if (w.text !== null && source === "config.toml") {
          this.configText = w.text;
          this.reloadConfig();
        }
        return { results, written: w.text !== null, before: read, after: w.text };
      }
      // D11: a file changed while it was edited is edited again once from its new text.
      if (!w.changed || attempt > 0) return { error: w.error };
    }
  }

  /**
   * Puts back the text an edit replaced, while the file still holds what the edit wrote.
   * @param {BookmarksSource} source
   * @param {{ before: string | null, after: string | null }} w
   * @returns {Promise<boolean>} whether the file holds its old text again
   */
  async revert(source, w) {
    const { before, after } = w;
    if (!this.writeFile || before === null) return false;
    if (after === null) return true; // nothing was written
    let ok = false;
    const path = source === BOOKMARKS_FILE ? this.path : this.configPath();
    const r = await this.writeFile(path, (text) =>
      text === after ? { text: before } : { error: `${path} changed meanwhile; not put back` },
    );
    if ("error" in r) console.error(`vimma: ${r.error}`);
    else {
      ok = true;
      if (source === "config.toml") {
        this.configText = before;
        this.reloadConfig();
      }
    }
    return ok;
  }

  /**
   * One of Vimma's bookmark changes in a mirrored folder (Behaviour 10, D18), in the edit queue:
   * the file is edited first, the base follows (so every moved item keeps its guid), Places is
   * changed where the change leaves or enters the mirrored folders, and a run brings Places to
   * the file. Nothing reaches Places when the file is not written.
   * @param {FileChange} change
   * @returns {Promise<FileChangeResult>}
   */
  edit(change) {
    if (!this.active) return Promise.resolve({ error: MIRRORED_REFUSAL });
    return this.edits
      .run(() => this.editNow(change))
      .catch((e) => {
        console.error("vimma: bookmarks.toml not written", e);
        return { error: `${BOOKMARKS_FILE} not written: ${e?.message ?? e}` };
      });
  }

  /**
   * edit(), in the queue.
   * @param {FileChange} change
   * @returns {Promise<FileChangeResult>}
   */
  async editNow(change) {
    if (!this.ready || this.base === undefined) {
      return { error: `${BOOKMARKS_FILE} is still loading; try again` };
    }
    // Outside changes waiting for their burst are put back first, so the base is what Places
    // holds when the change is read against it.
    if (this.burstTimer !== null || this.burst.size) {
      if (this.burstTimer !== null) lazy.clearTimeout(this.burstTimer);
      this.burstTimer = null;
      await this.run({ trigger: "places" });
    }
    if (this.paused || !this.writable()) return { error: this.refusal() };
    const base = this.base;
    const { text: fileText, problem } = await this.readFile();
    const read = problem
      ? null
      : readBookmarks({ file: fileText, config: this.configText ?? null });
    if (!base || !read || read.errors.length || !read.from) {
      return { error: `${BOOKMARKS_FILE} cannot be read now; nothing written` };
    }
    const source = read.from;
    const PU = places();
    const B = PU.bookmarks;
    const at = (/** @type {string} */ g) => locateInBase(base, g);
    const notYet = `${BOOKMARKS_FILE} does not hold that yet; try again in a moment`;
    /** @param {string | undefined} t */
    const held = (t) =>
      t !== undefined && this.held.has(t)
        ? `${BOOKMARKS_FILE}: ${JSON.stringify(t)} is paused (put back ${PUT_BACK_TIMES} times); edit the file to go on`
        : null;
    /** @type {BookmarkChange[]} */
    let changes = [];
    /** @type {(results: Extract<ReturnType<typeof editBookmarks>, { ok: true }>[]) =>
     *   Parameters<typeof baseAfterEdit>[1]} */
    let baseEdit = () => ({});
    /** @type {(() => Promise<void>) | null} */
    let placesOp = null;
    /**
     * A move out of the file whose Places step never ran: writes the item back into the file
     * where it was (#1347), so it is never in neither the file nor the base.
     * @type {(() => Promise<boolean>) | null}
     */
    let restore = null;
    // Whether the Places step changed anything yet: a revert must never lose an item, so the
    // file and the base go back only while Places is as it was.
    let placesChanged = false;
    /** @template T @param {Promise<T>} write @returns {Promise<T>} */
    const step = async (write) => {
      const done = await write;
      placesChanged = true;
      return done;
    };
    let count = 0;

    switch (change.type) {
      case "add": {
        const loc = at(change.parent);
        if (!loc || loc.kind === "bookmark") return { error: notYet };
        const h = held(loc.table);
        if (h) return { error: h };
        changes = [
          {
            op: "add",
            table: loc.table,
            folders: [...loc.path, ...change.missing],
            title: change.title,
            url: change.url,
          },
        ];
        break;
      }
      case "move": {
        const src = at(change.guid);
        const dst = at(change.parent);
        if (src?.kind === "table" || dst?.kind === "bookmark") {
          return { error: "a workspace's mirrored folder is renamed with :wsrename" };
        }
        const h = held(src?.table) ?? held(dst?.table);
        if (h) return { error: h };
        const guid = change.guid;
        if (src && dst) {
          changes = [
            {
              op: "move",
              table: src.table,
              kind: src.kind,
              path: src.path,
              toTable: dst.table,
              toFolders: [...dst.path, ...change.missing],
              toTitle: change.title ?? /** @type {string} */ (src.path.at(-1)),
            },
          ];
          baseEdit = (res) => ({ moves: res[0]?.moves ?? [] });
        } else if (src) {
          // Out of the file into a folder it does not mirror.
          changes = [{ op: "remove", table: src.table, kind: src.kind, path: src.path }];
          baseEdit = () => ({ drop: [{ table: src.table, kind: src.kind, path: src.path }] });
          placesOp = async () => {
            const parentGuid = await change.outside();
            /** @type {{ guid: string, parentGuid: string, index: number, title?: string }} */
            const info = { guid, parentGuid, index: B.DEFAULT_INDEX };
            if (change.title !== null) info.title = change.title;
            await step(B.update(info));
          };
          restore = async () => {
            const tree = await PU.promiseBookmarksTree(guid);
            const node = tree ? treeNode(/** @type {PlacesNode} */ (tree)) : null;
            if (!node || !this.base) return false;
            node.title = /** @type {string} */ (src.path.at(-1));
            const back = await this.writeEdits(source, [
              { op: "addTree", table: src.table, folders: src.path.slice(0, -1), node },
            ]);
            if ("error" in back) return false;
            const entries = back.results[0]?.entries ?? [];
            await this.saveBase(baseAfterEdit(this.base, { add: [{ table: src.table, entries }] }));
            return true;
          };
        } else if (dst) {
          // Into the file from a folder it does not mirror: the item and everything in it.
          const tree = await PU.promiseBookmarksTree(guid);
          if (!tree) return { error: "bookmark: it is gone" };
          const node = treeNode(/** @type {PlacesNode} */ (tree));
          if (!node) return { error: "bookmark: a separator is not a bookmark" };
          if (change.title !== null) node.title = change.title;
          changes = [
            {
              op: "addTree",
              table: dst.table,
              folders: [...dst.path, ...change.missing],
              node,
            },
          ];
          baseEdit = (res) => ({ add: [{ table: dst.table, entries: res[0]?.entries ?? [] }] });
          placesOp = async () => {
            await step(B.update({ guid, parentGuid: change.parent, index: B.DEFAULT_INDEX }));
          };
        } else return { error: notYet };
        break;
      }
      case "remove": {
        const src = at(change.guid);
        if (!src) return { error: notYet };
        if (src.kind === "table") {
          return {
            error: `a workspace's mirrored folder goes with :wsdelete, or with its table in ${source}`,
          };
        }
        const h = held(src.table);
        if (h) return { error: h };
        changes = [{ op: "remove", table: src.table, kind: src.kind, path: src.path }];
        baseEdit = () => ({ drop: [{ table: src.table, kind: src.kind, path: src.path }] });
        placesOp = async () => {
          await step(B.remove(change.guid));
        };
        break;
      }
      case "renameTable": {
        const loc = at(change.folder);
        if (loc?.kind !== "table") return { error: notYet };
        const h = held(loc.table);
        if (h) return { error: h };
        if (loc.table === change.to) return { guid: change.folder, path: [], count: 0 };
        changes = [{ op: "renameTable", from: loc.table, to: change.to }];
        baseEdit = () => ({ renameTable: { from: loc.table, to: change.to } });
        break;
      }
      case "removeTable": {
        const loc = at(change.folder);
        if (loc?.kind !== "table") return { error: notYet };
        const h = held(loc.table);
        if (h) return { error: h };
        changes = [{ op: "removeTable", name: loc.table }];
        baseEdit = () => ({ removeTable: loc.table });
        placesOp = async () => {
          await step(B.remove(change.folder));
        };
        break;
      }
      case "moveTable": {
        const from = at(change.from);
        // Refused before anything is made: into() may make the workspace's folder in Places.
        const before =
          held(from?.table) ?? held(change.target ? at(change.target)?.table : undefined);
        if (before) return { error: before };
        if (from?.kind !== "table" && !(change.target && at(change.target)?.kind === "table")) {
          return { error: notYet };
        }
        const into = await change.into();
        const to = at(into);
        const tree = /** @type {PlacesNode | null} */ (await PU.promiseBookmarksTree(change.from));
        const kids = tree?.children ?? [];
        count = kids.length;
        if (from?.kind === "table" && to?.kind === "table") {
          changes = [{ op: "mergeTable", from: from.table, to: to.table }];
          baseEdit = (res) => ({ moves: res[0]?.moves ?? [], removeTable: from.table });
        } else if (from?.kind === "table") {
          changes = [{ op: "removeTable", name: from.table }];
          baseEdit = () => ({ removeTable: from.table });
        } else if (to?.kind === "table") {
          // One edit for every item, so the file is read and checked once (not once per item).
          /** @type {TreeNode[]} */
          const nodes = [];
          for (const k of kids) {
            const node = treeNode(k);
            if (node) nodes.push(node);
          }
          changes = [{ op: "addTrees", table: to.table, folders: [], nodes }];
          baseEdit = (res) => ({ add: [{ table: to.table, entries: res[0]?.entries ?? [] }] });
        } else return { error: notYet };
        const h = held(from?.table) ?? held(to?.table);
        if (h) return { error: h };
        placesOp = async () => {
          for (const k of kids) {
            await step(
              B.update({
                guid: /** @type {string} */ (k.guid),
                parentGuid: into,
                index: B.DEFAULT_INDEX,
              }),
            );
          }
          const left = (await PU.promiseBookmarksTree(change.from))?.children ?? [];
          if (!left.length) await step(B.remove(change.from));
        };
        break;
      }
    }

    const w = await this.writeEdits(source, changes);
    if ("error" in w) return w;
    const results = w.results;
    await this.saveBase(baseAfterEdit(base, baseEdit(results)));
    if (placesOp) {
      /** @type {unknown} */
      let failed = null;
      this.applying = true;
      try {
        await placesOp();
      } catch (e) {
        failed = e ?? "failed";
      } finally {
        this.applying = false;
        this.burst.clear();
      }
      if (failed) {
        // D18: a revert never loses an item. While Places is as it was, the file and the base go
        // back to what they held; once part of the change is in Places (a :wsdelete m that
        // moved some items), the edit stays and the run brings Places to the file, so an item
        // that did not move gets a copy from the file: at worst twice, never nowhere. A revert
        // the file refuses (changed meanwhile) keeps the edited base, which matches the file.
        console.error("vimma: bookmark change failed in Places", failed);
        const why = /** @type {Thrown} */ (failed)?.message ?? String(failed);
        if (!placesChanged && (await this.revert(source, w))) {
          await this.saveBase(base);
          await this.run({ trigger: "vimma" });
          return { error: `bookmark: not changed (${why}); ${BOOKMARKS_FILE} is as it was` };
        }
        // #1347: the file changed meanwhile, so the line could not go back by a revert. A move out
        // whose bookmark is still in the mirrored folder is written back into the file; failing
        // that, it moves to Other Bookmarks, where no run removes it.
        if (!placesChanged && restore) {
          const back = await restore().catch((e) => {
            console.error("vimma: bookmark not written back", e);
            return false;
          });
          if (!back && change.type === "move") {
            await B.update({
              guid: change.guid,
              parentGuid: PLACES_ROOTS.unfiled,
              index: B.DEFAULT_INDEX,
            }).catch((/** @type {unknown} */ e) =>
              console.error("vimma: bookmark not moved to Other Bookmarks", e),
            );
          }
          await this.run({ trigger: "vimma" });
          return {
            error: back
              ? `bookmark: not moved (${why}); ${BOOKMARKS_FILE} holds it again`
              : `bookmark: not moved (${why}); it is in Other Bookmarks`,
          };
        }
        await this.run({ trigger: "vimma" });
        return {
          error: `bookmark: only partly changed in Firefox (${why}); ${BOOKMARKS_FILE} has the change, and Firefox follows it`,
        };
      }
    }
    await this.run({ trigger: "vimma" });
    const last = results.at(-1);
    const path = last?.path ?? [];
    /** @type {string | null} */
    let guid = null;
    if (change.type === "move") guid = change.guid;
    else if (change.type === "add" && change.url !== null && last) {
      const table = /** @type {{ table: string }} */ (changes[0]).table;
      guid =
        this.base?.tables
          .find((t) => t.name === table)
          ?.entries.find((e) => e.kind === "bookmark" && e.path.join("\0") === path.join("\0"))
          ?.guid ?? null;
    }
    const renamed = results.find((r) => r.renamed)?.renamed;
    return { guid, path, count, ...(renamed ? { renamed } : {}) };
  }

  /**
   * What the run says (Behaviour 5, 6, 14), as one notice. A put-back is said only for a table
   * the run changed: a separator or a kept bookmarklet is no change to put back.
   * @param {RunHow} how
   * @param {ReturnType<typeof planMirror>} p
   * @param {boolean} loaded  the file or its settings changed since the last run
   * @param {string} bookmarklets
   * @param {Map<string, Set<string>>} burst  who changed each table before the run
   * @param {ReadonlySet<string>} touched  the tables the run changed
   * @param {string | null} [holdSaid]  what the loop guard says, after the rest
   * @param {Awaited<ReturnType<BookmarksFileImpl["writeOutside"]>>} [outside]  what the run wrote
   *   of Places' outside changes (`write_back = "all"`)
   * @param {boolean} [privateTouched]  a private window changed a mirrored folder (Behaviour 12)
   */
  notices(how, p, loaded, bookmarklets, burst, touched, holdSaid = null, outside, privateTouched) {
    /** @type {string[]} */
    const said = how.adopted ? [how.adopted] : [];
    /** @type {Map<string, number>} */
    const fromFile = new Map();
    for (const r of p.removed) {
      if (r.cause === "file" || r.cause === "adopt") {
        fromFile.set(r.table, (fromFile.get(r.table) ?? 0) + r.count);
      }
    }
    // Vimma's own edit says what it did itself.
    if (how.trigger === "vimma") fromFile.clear();
    for (const [table, n] of fromFile) {
      said.push(
        `${BOOKMARKS_FILE}: ${plural(n, "bookmark")} removed from ${JSON.stringify(table)}`,
      );
    }
    if (outside && !outside.putBack) said.push(...this.outsideNotices(outside, burst));
    if (privateTouched && this.writeBack === "all") {
      said.push(`${BOOKMARKS_FILE}: a change made from a private window is not written`);
    }
    if (how.trigger === "places" && (!outside || outside.putBack)) {
      for (const [table, who] of burst) {
        if (!touched.has(table)) continue;
        said.push(
          `${BOOKMARKS_FILE}: ${[...who].join(", ")} change to ${JSON.stringify(table)} put back (write_back = "${this.writeBack}")`,
        );
      }
    }
    if (loaded && p.skipped.length && how.trigger !== "vimma") {
      const [first] = p.skipped;
      const more = p.skipped.length > 1 ? ` (and ${p.skipped.length - 1} more)` : "";
      said.push(
        `${BOOKMARKS_FILE}:${first?.line}: bookmarklet not added (bookmarklets = "${bookmarklets}")${more}`,
      );
    }
    if (holdSaid) said.push(holdSaid);
    if (said.length) this.say(said.join("; "));
  }

  /**
   * What writing Places' outside changes says (Behaviour 13, 15): conflicts the file won,
   * removals written, names made unique, and items the file cannot hold, each once.
   * @param {NonNullable<Awaited<ReturnType<BookmarksFileImpl["writeOutside"]>>>} outside
   * @param {Map<string, Set<string>>} burst
   * @returns {string[]}
   */
  outsideNotices(outside, burst) {
    const m = outside.merge;
    /** @type {string[]} */
    const said = [];
    for (const c of m.conflicts) {
      const where = [JSON.stringify(c.table), ...c.path].join("/");
      said.push(
        `${BOOKMARKS_FILE} kept ${where}; ${whoChanged(burst, [c.table])}'s ${c.what} put back`,
      );
    }
    if (outside.written !== null) {
      for (const x of m.removing) {
        said.push(
          `${BOOKMARKS_FILE}: ${whoChanged(burst, [x.table])} removed ${plural(x.count, "bookmark")} from ${JSON.stringify(x.table)}`,
        );
      }
      for (const x of m.renamed) {
        said.push(
          `${BOOKMARKS_FILE}: ${JSON.stringify(x.from)} written as ${JSON.stringify(x.to)} in ${JSON.stringify(x.table)}`,
        );
      }
    }
    const local = new Set(m.local);
    // Named once each; an item that left `keep` is forgotten, so the set stays as small as it.
    const keep = new Set(m.keep);
    for (const g of this.keptSaid) if (!keep.has(g)) this.keptSaid.delete(g);
    const fresh = m.keep.filter((g) => !local.has(g) && !this.keptSaid.has(g));
    for (const g of fresh) this.keptSaid.add(g);
    if (fresh.length) {
      said.push(
        `${BOOKMARKS_FILE}: ${plural(fresh.length, "bookmark")} the file cannot hold ${
          fresh.length === 1 ? "stays" : "stay"
        } in Firefox only`,
      );
    }
    return said;
  }

  /**
   * Behaviour 7 and 18: asked outside the run (D11), in the most recent window, once its prompt
   * line and command line are free (never over a prompt the user is typing in); the 60 s start
   * when it shows. A `y` runs the plan again, approving `removing` removals and no more. `n`,
   * Esc, a closed prompt or no answer in time applies nothing and pauses until the file changes.
   * @param {string} text
   * @param {number} removing
   * @param {string} input
   */
  question(text, removing, input) {
    this.askYesNo(
      text,
      () => {
        this.paused = null;
        this.enqueue({ trigger: "file", approved: removing, asked: input });
      },
      () => this.say(`${BOOKMARKS_FILE} not applied; bookmarks paused until the file changes`),
      true,
    );
  }

  /**
   * A y/N question outside the run (D11), in the most recent window once it is free. `no` runs
   * on `n`, Esc, a closed prompt or no answer in time; a newer question, `:bookmarks forget` or
   * the mirror stopping cancel it, which is a `no` only when `cancelIsNo`.
   * @param {string} text
   * @param {() => void} yes
   * @param {() => void} no
   * @param {boolean} [cancelIsNo]
   */
  askYesNo(text, yes, no, cancelIsNo = false) {
    this.cancelAsk?.();
    let answered = false;
    /** @type {number | null} */
    let timer = null;
    /** @type {(() => void) | null} */
    let close = null;
    const end = () => {
      answered = true;
      if (timer !== null) lazy.clearTimeout(timer);
      this.cancelAsk = null;
    };
    const onNo = () => {
      if (answered) return;
      end();
      no();
    };
    const onYes = () => {
      if (answered) return;
      end();
      yes();
    };
    const stopWaiting = this.whenFree((win) => {
      if (answered) return;
      close = this.ask(win, text, onYes, onNo);
      if (!close) {
        onNo();
        return;
      }
      timer = lazy.setTimeout(
        () => {
          timer = null;
          stopWaiting();
          close?.();
          onNo();
        },
        Services.prefs.getIntPref(ASK_PREF, DEFAULT_ASK_MS),
      );
    });
    this.cancelAsk = () => {
      // A cancel that is no answer ends the question first, so closing its prompt says no "no".
      if (!cancelIsNo) end();
      stopWaiting();
      if (close) close();
      onNo();
    };
  }

  /**
   * Applies a plan's writes to Places, in order, with the default source so that Sync uploads
   * them (Research). Places' own events of these writes start no burst (D5).
   * @param {readonly MirrorOp[]} ops
   */
  async apply(ops) {
    if (!ops.length) return;
    const B = places().bookmarks;
    // Events during the apply are forgotten (its own, and any that race it); a change that landed
    // before it (Sync, after the merge read Places) keeps its name for the run that writes it
    // (Behaviour 14, #1368).
    const before = new Map([...this.burst].map(([t, who]) => [t, new Set(who)]));
    this.applying = true;
    try {
      // Runs of inserts go in as trees, one transaction per parent (insertTree appends in the
      // order given, as the plan expects); removals in one call.
      for (let i = 0; i < ops.length;) {
        const op = /** @type {MirrorOp} */ (ops[i]);
        if (op.op === "insert") {
          let j = i;
          while (j < ops.length && ops[j]?.op === "insert") j++;
          await this.insertTrees(
            /** @type {Extract<MirrorOp, { op: "insert" }>[]} */ (ops.slice(i, j)),
          );
          i = j;
        } else if (op.op === "remove") {
          let j = i;
          while (j < ops.length && ops[j]?.op === "remove") j++;
          // An array takes info objects; a bare guid is only read when it comes alone.
          await B.remove(
            ops.slice(i, j).map((o) => ({ guid: /** @type {{ guid: string }} */ (o).guid })),
          );
          i = j;
        } else if (op.op === "update") {
          /** @type {{ guid: string, title?: string, url?: string, parentGuid?: string, index?: number }} */
          const info = { guid: op.guid };
          if (op.title !== undefined) info.title = op.title;
          if (op.url !== undefined) info.url = op.url;
          if (op.parentGuid !== undefined) {
            info.parentGuid = op.parentGuid;
            info.index = B.DEFAULT_INDEX;
          }
          await B.update(info);
          i++;
        } else {
          await B.reorder(op.parentGuid, op.guids);
          i++;
        }
      }
    } finally {
      this.applying = false;
      this.burst = before;
    }
  }

  /**
   * Inserts consecutive insert operations: a new folder's own inserts go inside it, the rest
   * under their existing parents, each parent's in the order given.
   * @param {Extract<MirrorOp, { op: "insert" }>[]} inserts
   */
  async insertTrees(inserts) {
    const B = places().bookmarks;
    /** @typedef {{ guid: string, title: string, type?: number, url?: string, children?: Child[] }} Child */
    /** @type {Map<string, Child>} */
    const made = new Map();
    /** @type {Map<string, Child[]>} existing parent → its new children */
    const roots = new Map();
    for (const op of inserts) {
      /** @type {Child} */
      const node =
        op.kind === "folder"
          ? { guid: op.guid, title: op.title, type: B.TYPE_FOLDER, children: [] }
          : { guid: op.guid, title: op.title, url: op.url };
      if (op.kind === "folder") made.set(op.guid, node);
      const parent = made.get(op.parentGuid);
      if (parent) /** @type {Child[]} */ (parent.children).push(node);
      else {
        const list = roots.get(op.parentGuid) ?? [];
        list.push(node);
        roots.set(op.parentGuid, list);
      }
    }
    for (const [guid, children] of roots) await B.insertTree({ guid, children });
  }

  /**
   * A table's folder becomes its workspace's (bookmarks decision 11), so the panel finds it.
   * @param {string} name
   * @param {string} folder
   */
  link(name, folder) {
    const def = WorkspaceStore.definitions.workspaces.find((d) => d.name === name);
    if (!def || def.bookmarksFolder === folder) return;
    try {
      WorkspaceStore.setBookmarksFolder(def.id, folder);
    } catch (e) {
      const code = e !== null && typeof e === "object" && "code" in e ? e.code : undefined;
      if (code !== "read-only" && code !== "disabled") {
        console.error("vimma: bookmarks folder not linked", e);
      }
    }
  }
}

/**
 * A Places item as the file writes it: a bookmark, or a folder with its bookmarks and folders;
 * null for a separator.
 * @param {PlacesNode} n
 * @returns {TreeNode | null}
 */
function treeNode(n) {
  const B = places().bookmarks;
  if (n.typeCode === B.TYPE_BOOKMARK) {
    return { ...(n.guid ? { guid: n.guid } : {}), title: n.title ?? "", url: n.uri ?? "" };
  }
  if (n.typeCode !== B.TYPE_FOLDER) return null;
  /** @type {TreeNode[]} */
  const children = [];
  for (const c of n.children ?? []) {
    const t = treeNode(c);
    if (t) children.push(t);
  }
  return { ...(n.guid ? { guid: n.guid } : {}), title: n.title ?? "", children };
}

/** Whether Places made a new database at this start (D17): Firefox may have restored a backup. */
function placesDatabaseIsNew() {
  // DATABASE_STATUS_CREATE and DATABASE_STATUS_CORRUPT (nsINavHistoryService.idl).
  const status = places().history.databaseStatus;
  return status === 1 || status === 2;
}

/**
 * @typedef {{ showPlacesOrganizer: (...args: unknown[]) => unknown, vimmaTracked?: boolean }}
 *   LibraryCommands
 */

/** @type {WeakRef<Window> | null} the browser window that last opened or raised the Library */
let libraryFrom = null;

/**
 * Notes which browser window last opened or brought forward the Library: there is one Library
 * window, and PlacesCommandHook.showPlacesOrganizer only focuses it when it is open, so its
 * `opener` stays the window that first opened it (browser-places.js). Every way Firefox opens
 * the Library (its key, menus and the bookmarks button) goes through that function.
 */
function trackLibraryOpeners() {
  if (trackLibraryOpeners.done) return;
  trackLibraryOpeners.done = true;
  /** @param {Window} win */
  const hook = (win) => {
    const commands = /** @type {{ PlacesCommandHook?: LibraryCommands }} */ (
      /** @type {unknown} */ (win)
    ).PlacesCommandHook;
    if (!commands || commands.vimmaTracked) return;
    const show = commands.showPlacesOrganizer;
    commands.showPlacesOrganizer = function (/** @type {unknown[]} */ ...args) {
      libraryFrom = new WeakRef(win);
      return show.apply(this, args);
    };
    commands.vimmaTracked = true;
  };
  for (const win of Services.wm.getEnumerator("navigator:browser")) hook(win);
  Services.obs.addObserver(
    (win) => hook(/** @type {Window} */ (/** @type {unknown} */ (win))),
    "browser-delayed-startup-finished",
  );
}
trackLibraryOpeners.done = false;

/**
 * Whether a Places change came from a private window (Behaviour 12): the focused window, else the
 * most recent of any type, and up its openers to a browser window. The Library and the bookmark
 * dialogs are windows of their own, so the most recent browser window would name a private
 * window that is merely behind them; the Library counts as the browser window that last opened
 * or raised it. When no browser window is found this way, or a check throws, the change counts
 * as private when the most recent browser window is, so that it fails closed.
 */
function changeWindowIsPrivate() {
  try {
    let win = Services.focus.activeWindow ?? Services.wm.getMostRecentWindow(null);
    for (let hops = 0; win && hops < 8; hops++) {
      if (isPrivate(/** @type {BrowserWindow} */ (win))) return true;
      const type = win.document?.documentElement?.getAttribute("windowtype");
      if (type === "navigator:browser") return false;
      const from = type === "Places:Organizer" ? libraryFrom?.deref() : undefined;
      win = /** @type {Window | null} */ (from && !from.closed ? from : win.opener);
    }
    const recent = recentWindow();
    return !!recent && isPrivate(recent);
  } catch (e) {
    console.warn("vimma: the window of a bookmark change is unknown, so counted private", e);
    return true;
  }
}

/** @param {BrowserWindow} win */
function isPrivate(win) {
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  );
  return PrivateBrowsingUtils.isWindowPrivate(win);
}

/**
 * A y/N for a command the user typed: in its window's prompt line, ignoring keys for a moment
 * as it shows, since it shows only after the export is computed (seconds on a large profile),
 * when a key meant for the page may be on its way.
 * @param {BrowserWindow | null} win
 * @param {string} question
 * @param {() => void} yes
 * @param {() => void} no
 */
function confirmInWindow(win, question, yes, no) {
  return win ? VimmaHost.ask(win, question, yes, no, { settleMs: ASK_SETTLE_MS }) : null;
}

/**
 * The file in a new tab, read-only, as `:config` opens config.toml.
 * @param {BrowserWindow} win
 * @param {string} path
 */
function openInTab(win, path) {
  openUrl(win, `view-source:${PathUtils.toFileURI(path)}`, "tab");
}

/** Resolves once Places' browser start-up is done, its startup restore included (D17). */
function placesInitComplete() {
  const { PlacesBrowserStartup } = ChromeUtils.importESModule(
    "moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs",
  );
  if (PlacesBrowserStartup._placesBrowserInitComplete) return Promise.resolve();
  return new Promise((resolve) => {
    const topic = "places-browser-init-complete";
    const observer = () => {
      Services.obs.removeObserver(observer, topic);
      resolve(undefined);
    };
    Services.obs.addObserver(observer, topic);
  });
}

/** The most recently used normal window, which the notices and questions go to. */
function recentWindow() {
  return /** @type {BrowserWindow | null} */ (Services.wm.getMostRecentWindow("navigator:browser"));
}

/** @param {string} text */
function sayInRecentWindow(text) {
  const win = recentWindow();
  if (win) VimmaHost.say(win, text);
}

/**
 * @param {BrowserWindow | null} win  the window the question waited on
 * @param {string} question
 * @param {() => void} yes
 * @param {() => void} no
 */
function askInWindow(win, question, yes, no) {
  return win ? VimmaHost.ask(win, question, yes, no, { settleMs: ASK_SETTLE_MS }) : null;
}

/**
 * Runs `fn` with the most recent window once its prompt line and command line are closed and
 * no page field there has the keys: at once, or on the window's next state change that leaves
 * it free. If that window closes or loses focus meanwhile, the most recent one is taken again.
 * `fn` gets null when there is no window.
 * @param {(win: BrowserWindow | null) => void} fn
 * @returns {() => void}  stops waiting
 */
function whenRecentWindowFree(fn) {
  let done = false;
  let cleanup = () => {};
  const run = (/** @type {BrowserWindow | null} */ win) => {
    if (done) return;
    done = true;
    cleanup();
    fn(win);
  };
  const attempt = () => {
    cleanup();
    if (done) return;
    const win = recentWindow();
    if (!win || !VimmaHost.promptBusy(win)) {
      run(win);
      return;
    }
    const off = VimmaHost.onStateChange(win, () => {
      if (!VimmaHost.promptBusy(win)) run(win);
    });
    const moved = () => attempt();
    win.addEventListener("unload", moved);
    win.addEventListener("deactivate", moved);
    cleanup = () => {
      off();
      win.removeEventListener("unload", moved);
      win.removeEventListener("deactivate", moved);
      cleanup = () => {};
    };
  };
  attempt();
  return () => {
    done = true;
    cleanup();
  };
}

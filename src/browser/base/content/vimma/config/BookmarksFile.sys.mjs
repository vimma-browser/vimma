/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// bookmarks.toml, mirrored into Places (docs/specs/bookmarks-file.md, Delivery slice 1: the
// read-only mirror), behind `vimma.feature.bookmarksFile` until the feature is finished: while
// the pref is off nothing here reads a file, listens to Places or refuses a key. One per app,
// started and fed by ConfigHost: it hands over config.toml's text after each read (inline tables,
// D2) and calls `tick` on each of its polls. The file is read beside config.toml's path (D1),
// settled (D15), checked by core's bookmarks-file.mjs, and applied to each table's workspace
// folder in Places as one plan (D4-D6). A change made in Places to a mirrored folder is put back
// from the file a second after its burst (Behaviour 14). A file with an error, or a missing file
// after one existed, pauses both directions (D9) until it reads again or `:bookmarks forget`
// (Behaviour 19); a run that deletes many bookmarks, or takes over a folder that has bookmarks
// the file lacks, asks first, and a yes approves those removals and no more (D14, Behaviour 18).
// Vimma's own bookmark keys refuse in mirrored folders (host/bookmark-ops.mjs,
// setMirroredFolders). Nothing here writes bookmarks.toml.

import {
  BOOKMARKS_FILE,
  MAX_BOOKMARKS_FILE_BYTES,
  formatBase,
  formatBookmarksFileError,
  parseBase,
  planMirror,
  readBookmarks,
} from "../core/bookmarks-file.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import { MIRRORED_REFUSAL, setMirroredFolders } from "../host/bookmark-ops.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/**
 * @import { Base, BookmarksFileError, MirrorOp, PlacesNode } from "../core/bookmarks-file.mjs"
 * @import { BookmarkletsSetting } from "../core/bookmarks.mjs"
 */

const lazy = /** @type {Lazy<"clearTimeout" | "setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** The unfinished feature's switch (CONTRIBUTING.md, "Unfinished features"). */
export const FEATURE_PREF = "vimma.feature.bookmarksFile";
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

/** Places events that change a mirrored folder (PlacesEvent.webidl). */
const EVENTS = [
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-title-changed",
  "bookmark-url-changed",
];

/** @returns {PlacesUtilsApi} */
function places() {
  return ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;
}

/** IOUtils rejects with a DOMException named NotFoundError for a missing file. */
const notFound = (/** @type {unknown} */ e) => /** @type {Thrown} */ (e)?.name === "NotFoundError";

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
 *   source: number, isTagging?: boolean }} BookmarkEvent
 */

/**
 * What starts a run, and what a `y` approved: `approved` is the number of removals the
 * question showed, `asked` what the run read when it asked.
 * @typedef {{ trigger: "start" | "file" | "config" | "places", approved?: number,
 *   asked?: string }} RunHow
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
   * @param {{ configPath: () => string, basePath?: string, enabled?: () => boolean,
   *   initComplete?: () => Promise<void>, say?: (text: string) => void,
   *   ask?: (win: BrowserWindow | null, question: string, yes: () => void, no: () => void) =>
   *     (() => void) | null,
   *   whenFree?: (fn: (win: BrowserWindow | null) => void) => () => void,
   *   showErrors?: (errors: BookmarksFileError[]) => void,
   *   mirrored?: (guids: ReadonlySet<string>, refusal: string) => void }} options
   *   `configPath`: config.toml's path, not its symlink's target (D1); `enabled`: the feature
   *   pref; the rest default to the profile, Places and the most recent window, and are
   *   replaced by tests
   */
  constructor(options) {
    this.configPath = options.configPath;
    this.basePath = options.basePath ?? PathUtils.join(PathUtils.profileDir, BASE_FILE);
    this.enabled = options.enabled ?? (() => Services.prefs.getBoolPref(FEATURE_PREF, false));
    this.initComplete = options.initComplete ?? placesInitComplete;
    this.say = options.say ?? sayInRecentWindow;
    this.ask = options.ask ?? askInWindow;
    this.whenFree = options.whenFree ?? whenRecentWindowFree;
    this.showErrors = options.showErrors ?? (() => {});
    this.mirrored = options.mirrored ?? setMirroredFolders;
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
    /** Running: the feature is on and start() was called. */
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
    /** @type {Promise<void>} one run at a time */
    this.queue = Promise.resolve();
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
    this.onFeature = () => this.feature();
  }

  get path() {
    return PathUtils.join(PathUtils.parent(this.configPath()) ?? "/", BOOKMARKS_FILE);
  }

  /** Once, with ConfigHost's first window: runs while the feature pref is on. */
  start() {
    if (this.started) return;
    this.started = true;
    Services.prefs.addObserver(FEATURE_PREF, this.onFeature);
    this.feature();
  }

  /** The feature pref changed (or start): turns the mirror on or off. */
  feature() {
    if (!this.started) return;
    if (this.enabled()) this.activate();
    else this.deactivate();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.initComplete()
      .then(async () => {
        if (!this.active) return;
        this.placesReady = true;
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
    this.mirrored(new Set(), MIRRORED_REFUSAL);
    this.report([], []);
    this.signature = "";
    this.lastInput = "";
  }

  stop() {
    if (this.started) Services.prefs.removeObserver(FEATURE_PREF, this.onFeature);
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
    const run = this.queue.then(async () => {
      this.cancelAsk?.();
      this.burst.clear();
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
    this.queue = run.then(
      () => {},
      (e) => console.error("vimma: bookmarks base not dropped", e),
    );
    return run;
  }

  /** The words `:bookmarks` takes while the feature is on, for Tab. */
  words() {
    return this.active ? ["forget"] : [];
  }

  /** Settles once every run asked for so far has ended. */
  settledRuns() {
    return this.queue;
  }

  /**
   * config.toml was read (ConfigHost): its inline tables and the settings may have changed.
   * @param {string | null} text  null: there is no config.toml
   * @param {BookmarkletsSetting} [bookmarklets]  of the last config.toml that applied
   */
  configRead(text, bookmarklets = "none") {
    const first = this.configText === undefined;
    const changed = this.configText !== text || this.bookmarklets !== bookmarklets;
    this.configText = text;
    this.bookmarklets = bookmarklets;
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

  async stat() {
    try {
      const info = await IOUtils.stat(this.path);
      return `${info.lastModified}|${info.size}|${info.type}`;
    } catch (e) {
      if (notFound(e)) return "missing";
      throw e;
    }
  }

  /**
   * @param {RunHow} how
   * @returns {Promise<void>}
   */
  enqueue(how) {
    const run = this.queue.then(() => (this.active ? this.run(how) : undefined));
    this.queue = run.catch((e) => console.error("vimma: bookmarks.toml run failed", e));
    return this.queue;
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

  /** @param {Base | null} base */
  async saveBase(base) {
    this.base = base;
    if (!base) {
      await IOUtils.remove(this.basePath, { ignoreAbsent: true });
    } else {
      await IOUtils.writeUTF8(this.basePath, formatBase(base), {
        tmpPath: `${this.basePath}.tmp`,
      });
    }
    this.follow(base);
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
    const refusal =
      this.paused?.why === "missing"
        ? `${this.paused.file ?? BOOKMARKS_FILE} is missing, so these bookmarks are paused: restore it, or :bookmarks forget`
        : MIRRORED_REFUSAL;
    this.mirrored(new Set((base?.tables ?? []).map((t) => t.folder)), refusal);
    if (base?.tables.length) this.listen();
    else this.unlisten();
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
   * A change to a mirrored folder starts a burst, put back a second after its last event
   * (Behaviour 14). The mirror's own writes, and the startup restore's (D17), start none.
   * @param {BookmarkEvent[]} events
   */
  onEvents(events) {
    const S = places().bookmarks.SOURCES;
    let any = false;
    for (const e of events) {
      if (e.isTagging || e.source === S.RESTORE_ON_STARTUP) continue;
      const table =
        this.tableOf.get(e.guid) ??
        (e.parentGuid ? this.tableOf.get(e.parentGuid) : undefined) ??
        (e.oldParentGuid ? this.tableOf.get(e.oldParentGuid) : undefined);
      if (!table) continue;
      any = true;
      const who = this.burst.get(table) ?? new Set();
      who.add(sourceName(e.source));
      this.burst.set(table, who);
    }
    if (!any || this.applying || this.paused || !this.ready) {
      if (this.applying || this.paused) this.burst.clear();
      return;
    }
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
   * One run (D4, D5): reads the bookmarks file and Places, plans, asks when it must, applies,
   * and ends with one more compare, so that a change that landed during the apply is put back
   * then. Runs one at a time (enqueue).
   * @param {RunHow} how
   */
  async run(how) {
    if (!this.ready) return;
    // Who changed what since the last run (Behaviour 14), taken now: the apply's own events
    // clear it.
    const burst = new Map(this.burst);
    this.burst.clear();
    let base = await this.loadBase();
    const { text: fileText, problem } = await this.readFile();
    const configText = this.configText ?? null;
    const bookmarklets = this.bookmarklets;
    const r = problem
      ? {
          from: /** @type {const} */ ("bookmarks.toml"),
          tables: [],
          errors: [{ file: BOOKMARKS_FILE, line: 0, message: problem }],
          warnings: [],
        }
      : readBookmarks({ file: fileText, config: configText });
    const source = r.from;
    const input = JSON.stringify([
      source,
      fileText === null ? "" : sha256(fileText),
      source === "config.toml" && configText !== null ? sha256(configText) : "",
      bookmarklets,
    ]);

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
      approved === null &&
      base &&
      this.lastInput === input
    ) {
      return; // D5: nothing changed on the file's side since the last run
    }

    const tables = r.tables;
    const PU = places();
    const ws = WorkspaceStore.definitions.workspaces.map((d) => ({
      name: d.name,
      folder: d.bookmarksFolder ?? null,
    }));
    /** @param {{ tables: Base["tables"] } | null} from @param {number | null} ok */
    const plan = async (from, ok) =>
      planMirror({
        tables,
        base: from,
        places: /** @type {PlacesNode} */ (await PU.promiseBookmarksTree("")),
        workspaces: ws,
        bookmarklets,
        approved: ok,
        makeGuid: () => PU.history.makeGuid(),
      });
    let p = await plan(base, approved);
    if (p.ask) {
      this.paused = { why: "declined", input };
      this.follow(base);
      this.question(p.ask, p.removing, input);
      return;
    }
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
    };
    // D5: the closing compare, against what this run made (and Sync racing an apply: one more
    // try from the new state). What landed meanwhile is an outside change, asked about like any.
    const again = await plan(next, null);
    if (again.ask) {
      this.paused = { why: "declined", input };
      await this.saveBase(next);
      this.question(again.ask, again.removing, input);
      return;
    }
    if (again.ops.length) {
      try {
        await this.apply(again.ops);
      } catch (e) {
        if (failed) {
          console.error("vimma: bookmarks.toml apply failed twice; paused", e);
          this.paused = { why: "failed", input: "" };
          this.say(`${BOOKMARKS_FILE}: bookmarks could not be applied; paused until a change`);
          return;
        }
      }
    }
    const touched = new Set([...p.touched, ...again.touched]);
    p = { ...again, removed: [...p.removed, ...again.removed], skipped: p.skipped };
    this.paused = null;
    const saved = { ...next, tables: again.base.tables };
    await this.saveBase(source === null && !saved.tables.length ? null : saved);
    for (const link of p.links) this.link(link.name, link.folder);
    const loaded = this.lastInput !== input;
    this.lastInput = input;
    this.notices(how, p, loaded, bookmarklets, burst, touched);
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
   */
  notices(how, p, loaded, bookmarklets, burst, touched) {
    /** @type {string[]} */
    const said = [];
    /** @type {Map<string, number>} */
    const fromFile = new Map();
    for (const r of p.removed) {
      if (r.cause === "file" || r.cause === "adopt") {
        fromFile.set(r.table, (fromFile.get(r.table) ?? 0) + r.count);
      }
    }
    for (const [table, n] of fromFile) {
      said.push(
        `${BOOKMARKS_FILE}: ${plural(n, "bookmark")} removed from ${JSON.stringify(table)}`,
      );
    }
    if (how.trigger === "places") {
      for (const [table, who] of burst) {
        if (!touched.has(table)) continue;
        said.push(
          `${BOOKMARKS_FILE}: ${[...who].join(", ")} change to ${JSON.stringify(table)} put back`,
        );
      }
    }
    if (loaded && p.skipped.length) {
      const [first] = p.skipped;
      const more = p.skipped.length > 1 ? ` (and ${p.skipped.length - 1} more)` : "";
      said.push(
        `${BOOKMARKS_FILE}:${first?.line}: bookmarklet not added (bookmarklets = "${bookmarklets}")${more}`,
      );
    }
    if (said.length) this.say(said.join("; "));
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
    const no = () => {
      if (answered) return;
      end();
      this.say(`${BOOKMARKS_FILE} not applied; bookmarks paused until the file changes`);
    };
    const yes = () => {
      if (answered) return;
      end();
      this.paused = null;
      this.enqueue({ trigger: "file", approved: removing, asked: input });
    };
    const stopWaiting = this.whenFree((win) => {
      if (answered) return;
      close = this.ask(win, text, yes, no);
      if (!close) {
        no();
        return;
      }
      timer = lazy.setTimeout(
        () => {
          timer = null;
          this.cancelAsk?.();
        },
        Services.prefs.getIntPref(ASK_PREF, DEFAULT_ASK_MS),
      );
    });
    this.cancelAsk = () => {
      stopWaiting();
      if (close) close();
      no();
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
      this.burst.clear();
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

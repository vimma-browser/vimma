/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// bookmarks.toml, mirrored into Places (docs/specs/bookmarks-file.md, Delivery slice 1: the
// read-only mirror). One per app, started and fed by ConfigHost: it hands over config.toml's
// text after each read (inline tables, D2) and calls `tick` on each of its polls. The file is
// read beside config.toml's path (D1), settled (D15), checked by core's bookmarks-file.mjs, and
// applied to each table's workspace folder in Places as one plan (D4-D6). A change made in
// Places to a mirrored folder is put back from the file a second after its burst (Behaviour 14).
// A file with an error, or a missing file after one existed, pauses both directions (D9); a run
// that deletes many bookmarks, or takes over a folder that has bookmarks the file lacks, asks
// first (D14, Behaviour 18). Vimma's own bookmark keys refuse in mirrored folders
// (host/bookmark-ops.mjs, setMirroredFolders). Nothing here writes bookmarks.toml.

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
import { setMirroredFolders } from "../host/bookmark-ops.mjs";
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

/** Prefs for tests: the settle (D15), the burst (D15) and the question's time (Behaviour 7). */
const SETTLE_PREF = "vimma.bookmarks.settleMs";
const BURST_PREF = "vimma.bookmarks.burstMs";
const ASK_PREF = "vimma.bookmarks.askMs";
const DEFAULT_SETTLE_MS = 500;
const DEFAULT_BURST_MS = 1000;
const DEFAULT_ASK_MS = 60_000;
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

export class BookmarksFileImpl {
  /**
   * @param {{ configPath: () => string, basePath?: string,
   *   bookmarklets?: () => BookmarkletsSetting,
   *   databaseStatus?: () => number, initComplete?: () => Promise<void>,
   *   say?: (text: string) => void,
   *   ask?: (question: string, yes: () => void, no: () => void) => (() => void) | null,
   *   showErrors?: (errors: BookmarksFileError[]) => void,
   *   mirrored?: (guids: ReadonlySet<string>) => void }} options
   *   `configPath`: config.toml's path, not its symlink's target (D1); the rest default to the
   *   profile, Places and the most recent window, and are replaced by tests
   */
  constructor(options) {
    this.configPath = options.configPath;
    this.basePath = options.basePath ?? PathUtils.join(PathUtils.profileDir, BASE_FILE);
    this.bookmarklets = options.bookmarklets ?? (() => /** @type {BookmarkletsSetting} */ ("none"));
    this.databaseStatus = options.databaseStatus ?? (() => places().history.databaseStatus);
    this.initComplete = options.initComplete ?? placesInitComplete;
    this.say = options.say ?? sayInRecentWindow;
    this.ask = options.ask ?? askInRecentWindow;
    this.showErrors = options.showErrors ?? (() => {});
    this.mirrored = options.mirrored ?? setMirroredFolders;
    /** @type {string | null} config.toml's text as last read; null when it is missing */
    this.configText = null;
    /** @type {Base | null | undefined} undefined until read from disk */
    this.base = undefined;
    /** The first run waits for Places (D17). */
    this.ready = false;
    /** @type {string} bookmarks.toml's stat at the last read; "" forces one */
    this.signature = "";
    /** @type {string | null} a changed stat waiting to settle */
    this.settling = null;
    /** @type {{ why: "error" | "missing" | "declined" | "failed", input: string } | null} */
    this.paused = null;
    /** @type {string} what the last applied run read: the file's hash and the settings */
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
    /** @type {(() => void) | null} closes the open question */
    this.cancelAsk = null;
    /** @type {((events: unknown[]) => void) | null} */
    this.listener = null;
    /** @type {BookmarksFileError[]} */
    this.errors = [];
    /** @type {BookmarksFileError[]} */
    this.warnings = [];
    this.stopped = false;
  }

  get path() {
    return PathUtils.join(PathUtils.parent(this.configPath()) ?? "/", BOOKMARKS_FILE);
  }

  /** Starts after Places' browser start-up (D17); never blocks the window. */
  start() {
    this.stopped = false;
    this.initComplete()
      .then(() => {
        if (this.stopped) return;
        this.ready = true;
        const PU = places();
        const status = this.databaseStatus();
        const fresh =
          status === PU.history.DATABASE_STATUS_CREATE ||
          status === PU.history.DATABASE_STATUS_CORRUPT;
        return this.enqueue({ trigger: "start", fresh });
      })
      .catch((e) => console.error("vimma: bookmarks.toml not mirrored at start", e));
  }

  /**
   * Drops the base and turns the mirror off until a bookmarks file exists again; Places keeps
   * every bookmark it has (Behaviour 19, which `:bookmarks forget` gives the user in Delivery
   * slice 4; the tests use it now).
   * @returns {Promise<void>}
   */
  forget() {
    const run = this.queue.then(async () => {
      this.cancelAsk?.();
      this.paused = null;
      this.lastInput = "";
      this.burst.clear();
      this.report([], []);
      await this.saveBase(null);
    });
    this.queue = run.catch((e) => console.error("vimma: bookmarks base not dropped", e));
    return this.queue;
  }

  /** Settles once every run asked for so far has ended. */
  settledRuns() {
    return this.queue;
  }

  stop() {
    this.stopped = true;
    for (const t of [this.burstTimer, this.settleTimer]) if (t !== null) lazy.clearTimeout(t);
    this.burstTimer = this.settleTimer = null;
    this.cancelAsk?.();
    this.unlisten();
  }

  /**
   * config.toml was read (ConfigHost): its inline tables and the settings may have changed.
   * @param {string | null} text
   */
  configRead(text) {
    this.configText = text;
    if (this.ready) this.enqueue({ trigger: "config" });
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
      return `${info.lastModified}|${info.size}`;
    } catch (e) {
      if (notFound(e)) return "missing";
      throw e;
    }
  }

  /**
   * @param {{ trigger: "start" | "file" | "config" | "places", fresh?: boolean,
   *   confirmed?: boolean, asked?: string }} how
   * @returns {Promise<void>}
   */
  enqueue(how) {
    const run = this.queue.then(() => (this.stopped ? undefined : this.run(how)));
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
   * Keeps the keys' refusal (bookmark-ops) and the Places listener in step with the base.
   * @param {Base | null} base
   */
  follow(base) {
    this.tableOf = new Map();
    for (const t of base?.tables ?? []) {
      this.tableOf.set(t.folder, t.name);
      for (const e of t.entries) this.tableOf.set(e.guid, t.name);
    }
    this.mirrored(new Set((base?.tables ?? []).map((t) => t.folder)));
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
    if (!any || this.applying || this.paused) {
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
   * Reads bookmarks.toml; null when it does not exist. A file over the limit is not read
   * (Behaviour 4).
   * @returns {Promise<{ text: string | null, tooBig: boolean }>}
   */
  async readFile() {
    try {
      const info = await IOUtils.stat(this.path);
      if ((info.size ?? 0) > MAX_BOOKMARKS_FILE_BYTES) return { text: null, tooBig: true };
      return { text: await IOUtils.readUTF8(this.path), tooBig: false };
    } catch (e) {
      if (notFound(e)) return { text: null, tooBig: false };
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
   * One run (D4, D5): reads the bookmarks file and Places, plans, asks when it must, applies,
   * and ends with one more compare, so that a change that landed during the apply is put back
   * then. Runs one at a time (enqueue).
   * @param {{ trigger: "start" | "file" | "config" | "places", fresh?: boolean,
   *   confirmed?: boolean, asked?: string }} how
   */
  async run(how) {
    if (!this.ready) return;
    // Who changed what since the last run (Behaviour 14), taken now: the apply's own events
    // clear it.
    const burst = new Map(this.burst);
    this.burst.clear();
    const base = await this.loadBase();
    const { text: fileText, tooBig } = await this.readFile();
    const hash = fileText === null ? "" : sha256(fileText);
    const bookmarklets = this.bookmarklets();
    const r = tooBig
      ? {
          from: /** @type {const} */ ("bookmarks.toml"),
          tables: [],
          errors: [{ file: BOOKMARKS_FILE, line: 0, message: "larger than 4 MiB; not read" }],
          warnings: [],
        }
      : readBookmarks({ file: fileText, config: this.configText });
    const source = r.from;
    const input = JSON.stringify([
      source,
      hash,
      source === "config.toml" ? this.configText : "",
      bookmarklets,
    ]);

    // D9: a missing file after one existed is a pause, never "delete every bookmark".
    if (!tooBig && fileText === null && base?.source === BOOKMARKS_FILE) {
      if (this.paused?.why !== "missing") {
        this.say(`${BOOKMARKS_FILE} is missing; bookmarks paused`);
      }
      this.paused = { why: "missing", input };
      this.report([], r.warnings);
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
      return;
    }
    this.report([], r.warnings);
    // Behaviour 7: no answer, or no, holds both ways until the file (or its settings) change.
    if (this.paused?.why === "declined" && this.paused.input === input && !how.confirmed) return;
    if (how.asked !== undefined && how.asked !== input) {
      how = { ...how, confirmed: false }; // the file changed while it asked: ask again
    }
    if (
      !this.paused &&
      how.trigger !== "places" &&
      how.trigger !== "start" &&
      !how.confirmed &&
      base &&
      this.lastInput === input
    ) {
      return; // D5: nothing changed on the file's side since the last run
    }

    const tables = r.tables;
    const PU = places();
    const ws = WorkspaceStore.definitions.workspaces.map((d) => ({
      id: d.id,
      name: d.name,
      folder: d.bookmarksFolder ?? null,
    }));
    /** @param {{ tables: Base["tables"] } | null} from @param {boolean} confirmed */
    const plan = async (from, confirmed) =>
      planMirror({
        tables,
        base: from,
        places: /** @type {PlacesNode} */ (await PU.promiseBookmarksTree("")),
        workspaces: ws,
        bookmarklets,
        confirmed,
        fresh: !!how.fresh,
        makeGuid: () => PU.history.makeGuid(),
      });
    let p = await plan(base, !!how.confirmed);
    if (p.ask) {
      this.paused = { why: "declined", input };
      this.question(p.ask, input, how);
      return;
    }
    let failed = false;
    try {
      await this.apply(p.ops);
    } catch (e) {
      console.warn("vimma: bookmarks.toml apply failed; trying again from Places as it is", e);
      failed = true;
    }
    // D5: the closing compare, against what this run made (and Sync racing an apply: one more
    // try from the new state). What landed meanwhile is an outside change: put back unasked.
    const again = await plan(p.base, true);
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
      p = { ...again, removed: [...p.removed, ...again.removed] };
    } else if (failed) {
      p = again;
    }
    this.paused = null;
    /** @type {Base} */
    const next = {
      version: 1,
      source: /** @type {Base["source"]} */ (source ?? base?.source ?? BOOKMARKS_FILE),
      hash,
      tables: p.base.tables,
    };
    await this.saveBase(source === null && !next.tables.length ? null : next);
    for (const link of p.links) this.link(link.name, link.folder);
    const loaded = this.lastInput !== input;
    this.lastInput = input;
    this.notices(how, p, loaded, bookmarklets, burst);
  }

  /**
   * What the run says (Behaviour 5, 6, 14), as one notice.
   * @param {{ trigger: string }} how
   * @param {ReturnType<typeof planMirror>} p
   * @param {boolean} loaded  the file or its settings changed since the last run
   * @param {BookmarkletsSetting} bookmarklets
   * @param {Map<string, Set<string>>} burst  who changed each table before the run
   */
  notices(how, p, loaded, bookmarklets, burst) {
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
      said.push(`${BOOKMARKS_FILE}: ${plural(n, "bookmark")} removed from ${table}`);
    }
    if (how.trigger === "places") {
      for (const [table, who] of burst) {
        said.push(`${BOOKMARKS_FILE}: ${[...who].join(", ")} change to ${table} put back`);
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
   * Behaviour 7 and 18: asked outside the run (D11), in the most recent window; a `y` runs the
   * plan again, confirmed. `n`, Esc or no answer in time applies nothing and pauses until the
   * file changes.
   * @param {string} text
   * @param {string} input
   * @param {{ trigger: "start" | "file" | "config" | "places", fresh?: boolean }} how
   */
  question(text, input, how) {
    this.cancelAsk?.();
    let answered = false;
    /** @type {number | null} */
    let timer = null;
    const no = () => {
      if (answered) return;
      answered = true;
      if (timer !== null) lazy.clearTimeout(timer);
      this.cancelAsk = null;
      this.say(`${BOOKMARKS_FILE} not applied; bookmarks paused until the file changes`);
    };
    const yes = () => {
      if (answered) return;
      answered = true;
      if (timer !== null) lazy.clearTimeout(timer);
      this.cancelAsk = null;
      this.paused = null;
      this.enqueue({ ...how, trigger: "file", confirmed: true, asked: input });
    };
    const cancel = this.ask(text, yes, no);
    if (!cancel) {
      no();
      return;
    }
    this.cancelAsk = () => {
      cancel();
      no();
    };
    timer = lazy.setTimeout(
      () => {
        timer = null;
        this.cancelAsk?.();
      },
      Services.prefs.getIntPref(ASK_PREF, DEFAULT_ASK_MS),
    );
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
      // order given, as the plan expects); removals in one call. 5000 lines are then a few
      // writes, not 5000 (Tests: the 5000-bookmark budget).
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
 * @param {string} question
 * @param {() => void} yes
 * @param {() => void} no
 */
function askInRecentWindow(question, yes, no) {
  const win = recentWindow();
  return win ? VimmaHost.ask(win, question, yes, no) : null;
}

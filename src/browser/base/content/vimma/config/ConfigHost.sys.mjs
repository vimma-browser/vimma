/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// config.toml for every window (spec: docs/specs/m5-config-load.md). One per app. Reads
// `$XDG_CONFIG_HOME/vimma/config.toml` (default `~/.config/vimma/config.toml`) and nothing else
// in that folder, polls its mtime and size every 2 s (Firefox has no portable file
// watcher), and reads it at once on `:source`. vimma-core parses and validates (reloadConfig:
// a file is applied whole or not at all, else the last good config stays); this module does
// the I/O and hands each part to the module that uses it. `:source <path>` puts another file in
// force the same way, until config.toml changes or a plain `:source`. Writes: the first run and
// `:config` create a missing config.toml from the commented template, never touching an existing
// one; `:route add` appends one `[[routes]]` table (spec workspace-routing), checked to parse
// first; the built-in agent's setup, `:siteunbind --save` / `:sitebind --delete` and the setup's
// keys (setConfigKeys, docs/specs/setup-v2.md decision 5) edit their own lines (rewriteConfig). Every edit of config.toml and of bookmarks.toml, and every apply of
// bookmarks.toml to Places, runs in one queue (docs/specs/bookmarks-file.md D11).

import {
  addAgentProviderText,
  appendRouteText,
  formatConfigError,
  rawUpdatesCheck,
  reloadConfig,
  resolveSourcePath,
  setConfigKeysText,
} from "../core/config.mjs";
import { MAX_BOOKMARKS_FILE_BYTES, inlineBookmarkTables } from "../core/bookmarks-file.mjs";
import { serialQueue } from "../core/bookmarks-edit.mjs";
import { formatConfigTemplate } from "../core/defaults.mjs";
import { editSiteUnbindText } from "../core/site-edit.mjs";
import { updatesCheckAfterRead } from "../core/updates.mjs";
import { locateKeys } from "../core/toml.mjs";
import {
  CONFIG_EDIT_TOPIC,
  CONFIG_RELOAD_TOPIC,
  PDF_OUTLINE_PREF,
  VimmaHost,
} from "../host/VimmaHost.sys.mjs";
import { openUrl } from "../host/tab-ops.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { PrivateSwap } from "../host/private-swap.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { BookmarksToolbar } from "../ui/bookmarks-toolbar.mjs";
import { Toolbar } from "../ui/toolbar.mjs";
import { PanelNumbers } from "../ui/side-panel.mjs";
import { TabLine, TabLineConfig } from "../ui/tabline.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { VimmaUpdates } from "../updates/VimmaUpdates.sys.mjs";
import { WorkspaceRouter } from "../workspaces/WorkspaceRouter.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { BookmarksFileImpl } from "./BookmarksFile.sys.mjs";

/** @import { ActiveConfig, ConfigError, ResolvedConfig } from "../core/config.mjs" */

const lazy = /** @type {Lazy<"clearTimeout" | "setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** A full path overrides the XDG location (tests; `~/` is expanded). */
const PATH_PREF = "vimma.config.path";
const POLL_PREF = "vimma.config.pollMs";
/** Set once the first run has looked for config.toml: a file deleted later stays deleted. */
const FIRST_RUN_PREF = "vimma.config.firstRunDone";
/**
 * A created config.toml and its folder are the user's alone: the file can name intranet hosts
 * ([workspaces] home, [[routes]]), and the XDG base directory spec asks for 0700 folders.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_POLL_MS = 2000;

/** IOUtils rejects with a DOMException named NotFoundError for a missing file. */
const notFound = (/** @type {unknown} */ e) => /** @type {Thrown} */ (e)?.name === "NotFoundError";

const home = () => Services.dirsvc.get("Home", Ci.nsIFile).path;

/** The config file: the pref, else `$XDG_CONFIG_HOME/vimma/config.toml` (absolute only). */
function configPath() {
  const pref = Services.prefs.getStringPref(PATH_PREF, "");
  if (pref.startsWith("~/")) return PathUtils.join(home(), ...pref.slice(2).split("/"));
  if (pref) return pref;
  const xdg = Services.env.get("XDG_CONFIG_HOME");
  // The XDG spec: a relative value is invalid and ignored.
  const base = xdg.startsWith("/") ? xdg : PathUtils.join(home(), ".config");
  return PathUtils.join(base, "vimma", "config.toml");
}

/** @type {ActiveConfig | null} the config in force; null until the first read */
let active = null;
/** The config in force is the defaults standing in for a file with errors, never applied. */
let fallback = false;
/**
 * @type {{ check: boolean, held: boolean } | null} what the last read told VimmaUpdates: the
 * setting in effect, which an unreadable `check` keeps (#967); null before the first read
 */
let updates = null;
/** @type {ConfigError[]} the last read's errors; [] when it was applied */
let errors = [];
/** @type {ConfigError[]} what the last applied read left out (an unknown agent CLI, #742) */
let warnings = [];
/** The file `errors` are about: config.toml, or the file `:source <path>` named. */
let errorsPath = "";
/** @type {string | null} the file `:source <path>` put in force; null: config.toml */
let sourced = null;
/** What the file looked like at the last read; "" forces one. */
let signature = "";
/** @type {Promise<void> | null} */
let running = null;
/** Another read was asked for while one ran (`:source` during a poll). */
let again = false;
/** @type {number | null} */
let timer = null;
/** @type {Set<BrowserWindow>} */
const windows = new Set();
/**
 * `[ui] toolbar` of the last config applied; null before the first. The pref is written only
 * when it changes, so ctrl+b u lasts until a restart or an edit of that line, as a tmux `set`
 * lasts until .tmux.conf is sourced (docs/specs/toolbar-toggle.md decision 4).
 * @type {string | null}
 */
let appliedToolbar = null;
/** `[ui] pdf_outline` of the last config applied; null before the first. @type {string | null} */
let appliedPdfOutline = null;
/**
 * `[bookmarks] bookmarklets` of the last config.toml read that applied, for the bookmarks.toml
 * mirror. @type {import("../core/bookmarks.mjs").BookmarkletsSetting}
 */
let appliedBookmarklets = "none";
/**
 * `[bookmarks] write_back` of the last config.toml read that applied (bookmarks-file D12).
 * @type {import("../core/bookmarks-file.mjs").WriteBack}
 */
let appliedWriteBack = "all";
/**
 * The one queue of edits (docs/specs/bookmarks-file.md D11): config.toml's (rewriteConfig) and
 * bookmarks.toml's, and the bookmarks mirror's applies to Places. A task never waits for a task
 * it queues: an edit's re-read runs after the edit's task ends.
 */
const edits = serialQueue();
/** @type {ConfigError[]} bookmarks.toml's errors and warnings (docs/specs/bookmarks-file.md) */
let bookmarksErrors = [];

/**
 * bookmarks.toml beside config.toml (docs/specs/bookmarks-file.md): fed config.toml's text after
 * each read and polled with it; its errors join the status bar's.
 */
const bookmarksFile = new BookmarksFileImpl({
  configPath,
  queue: edits,
  writeFile: (path, compute) => writeFileNow(path, compute, MAX_BOOKMARKS_FILE_BYTES),
  reloadConfig: () => {
    ConfigHost.reload().catch((e) => console.error("vimma: config.toml not read", e));
  },
  showErrors: (list) => {
    bookmarksErrors = list.map((e) => ({
      ...(e.line ? { line: e.line } : {}),
      path: "",
      message: e.message,
      file: e.file,
    }));
    showErrors();
  },
});
/** `[ui] tabline` of the last config applied, null before the first (tab-line decision 5). */
let appliedTabline = /** @type {string | null} */ (null);

/**
 * @param {string} path
 * @returns {Promise<string>} "missing", or the file's mtime and size
 */
async function stat(path) {
  try {
    const info = await IOUtils.stat(path);
    return `${info.lastModified}|${info.size}`;
  } catch (e) {
    if (notFound(e)) return "missing";
    throw e;
  }
}

/** @param {BrowserWindow} win @param {ResolvedConfig} config */
function applyToWindow(win, config) {
  const view = PaneViews.get(win);
  if (!view) return;
  view.max = config.panes.max;
  view.maxSplits = config.panes.maxSplits;
  view.newTab = config.panes.newTab;
  view.mode = config.panes.layout;
  view.mainSize = config.panes.mainSize;
}

/**
 * @param {ActiveConfig} next
 * @param {string} text  the file it was read from, to locate `[search]`'s problems
 */
function apply(next, text) {
  const { config, keymap } = next;
  VimmaHost.configure({
    keymap,
    hintChars: config.hintChars,
    sites: config.sites,
    firefox: config.firefox,
    insertEditing: config.insertEditing,
    bookmarksRoot: config.bookmarks.root,
    bookmarklets: config.bookmarks.bookmarklets,
  });
  for (const win of windows) applyToWindow(win, config);
  ThemeHost.setConfig(config.theme);
  PrivateSwap.configure(config.private.placement);
  PanelNumbers.set(config.panel.numbers);
  VimmaActors.setScrollStep(config.scroll.step);
  WorkspaceRouter.setRoutes(config.routes);
  WorkspaceRouter.setDefaultWorkspace(config.routing.defaultWorkspace);
  McpHost.configure(config.mcp);
  McpHost.configureAgent(config.agent);
  if (config.ui.toolbar !== appliedToolbar) {
    appliedToolbar = config.ui.toolbar;
    Toolbar.setHidden(config.ui.toolbar === "hidden");
  }
  // docs/specs/tab-line.md decision 5: as `[ui] toolbar`, so `:tabline` lasts until the line changes.
  if (config.ui.tabline !== appliedTabline) {
    appliedTabline = config.ui.tabline;
    TabLine.setting = config.ui.tabline;
  }
  TabLineConfig.set({ width: config.ui.tablineWidth, statusTab: config.statusbar.tab });
  // docs/specs/pdf-mode.md decision 19: Vimma's outline beside a PDF, applied as `[ui] toolbar`
  // is, at startup and when the line changes.
  if (config.ui.pdfOutline !== appliedPdfOutline) {
    appliedPdfOutline = config.ui.pdfOutline;
    Services.prefs.setBoolPref(PDF_OUTLINE_PREF, config.ui.pdfOutline === "hidden");
  }
  // docs/specs/bookmarks-toolbar-hidden.md decisions 4 and 7, applied as `[ui] toolbar` is.
  BookmarksToolbar.configure(config.ui.bookmarksToolbar, (text) => {
    const [win] = windows;
    if (win) VimmaHost.say(win, text);
  });
  // docs/specs/search-engines.md: its problems arrive later and join the file's (showErrors).
  SearchHost.setConfig(config.search, locateKeys(text)).catch((e) =>
    console.error("vimma: [search] not applied", e),
  );
  // `[mcp] workspace` names the agent workspace the reconcile ensures (vimma-mcp decision 8).
  WorkspaceStore.setConfig(config.workspaces, { agent: config.mcp.workspace }).catch((e) =>
    console.error("vimma: [workspaces] not applied", e),
  );
}

/**
 * Sets the errors of the last read and hands them to the status bar, which names the file.
 * @param {string} path
 * @param {ConfigError[]} list  [] when the file was applied
 * @param {boolean} kept  a config was in force before (else: the defaults are)
 * @param {ConfigError[]} [left]  what an applied file left out
 */
function report(path, list, kept, left = []) {
  errors = list;
  warnings = left;
  errorsPath = path;
  if (warnings.length) {
    const lines = warnings.map((e) => formatConfigError(e, path));
    console.warn(`vimma: ${path} applied without:\n  ${lines.join("\n  ")}`);
  }
  if (errors.length) {
    // Logged once per change of the file (or :source): the signature holds until then.
    const lines = errors.map((e) => formatConfigError(e, path));
    console.error(
      `vimma: ${path} has ${errors.length} error(s); ${
        kept ? "keeping the previous config" : "using the defaults"
      }:\n  ${lines.join("\n  ")}`,
    );
  }
  showErrors();
}

/**
 * The status bar's errors: the last read's, or what it left out, then `[search]`'s, which only
 * the profile's engines reveal once the file is applied (search-engines decision 9).
 */
function showErrors() {
  VimmaHost.configure({
    configErrors: [...errors, ...warnings, ...SearchHost.errors, ...bookmarksErrors],
    configFile: PathUtils.filename(errorsPath || configPath()),
  });
}
SearchHost.onErrors = showErrors;

/**
 * Applies `text` (the contents of `path`) when it is valid, else reports its errors.
 * @param {string} path
 * @param {string} text
 * @param {ConfigError[]} [left]  more that an applied file leaves out
 * @returns {boolean} whether it was applied
 */
function use(path, text, left = []) {
  const previous = active;
  const r = reloadConfig(active, text, { mac: Services.appinfo.OS === "Darwin" });
  active = r.active;
  if (active !== previous) apply(active, text);
  // A file with errors still decides update checks when its `check` can be read, as a valid file
  // does, so a value only a newer build accepts never keeps the user from that release; an
  // unreadable `check` never turns checks on: it keeps the setting in effect (off when the config
  // in force has them off), or, when the defaults stand in, holds checks (`:update` aside)
  // (docs/specs/m6a-updater.md decision 31 and its note, #741, #967).
  updates = updatesCheckAfterRead({
    errors: r.errors.length,
    inForce: active.config.updates.check,
    raw: r.errors.length ? rawUpdatesCheck(text) : null,
    hadConfig: previous !== null && !fallback,
    previous: updates,
  });
  VimmaUpdates.configure(updates);
  fallback = previous === null ? r.errors.length > 0 : fallback && r.errors.length > 0;
  report(path, r.errors, previous !== null, [...r.warnings, ...(r.errors.length ? [] : left)]);
  return r.errors.length === 0;
}

/** @param {boolean} force  read even when the stat is unchanged (`:source`) */
async function check(force) {
  const path = configPath();
  const now = await stat(path);
  if (!force && now === signature) return;
  signature = now;
  sourced = null; // config.toml changed (or a plain :source): it is the file in force again
  let text = "";
  if (now !== "missing") {
    try {
      text = await IOUtils.readUTF8(path);
    } catch (e) {
      if (!notFound(e)) {
        // An unreadable config.toml may say `[updates] check = false`: hold checks off.
        updates = { check: false, held: true };
        VimmaUpdates.configure(updates);
        throw e;
      }
      signature = "missing"; // removed between stat and read: the defaults, silently
    }
  }
  const applied = use(path, text);
  // Bookmarklets as the last config.toml that applied says (bookmarks-file D12, D13): a file
  // with errors keeps the previous value, and `:source <file>` never reaches here.
  if (applied) {
    appliedBookmarklets = active?.config.bookmarks.bookmarklets ?? "none";
    appliedWriteBack = active?.config.bookmarks.writeBack ?? "all";
  }
  bookmarksFile.configRead(now === "missing" ? null : text, appliedBookmarklets, appliedWriteBack);
}

/**
 * `:source <path>`: that file replaces the config in force, all or nothing, as config.toml
 * does. Unlike config.toml, a missing file is an error: the user named it.
 * @param {string} path  absolute
 */
async function source(path) {
  let text;
  try {
    text = await IOUtils.readUTF8(path);
  } catch (e) {
    if (!notFound(e)) console.error(`vimma: cannot read ${path}`, e);
    report(path, [{ path: "", message: notFound(e) ? "no such file" : "cannot be read" }], true);
    return;
  }
  // docs/specs/bookmarks-file.md Behaviour 6: a config tried out with `:source` never changes
  // bookmarks, so its inline tables are left out, each with a warning.
  const ignored = inlineBookmarkTables(text).map((t) => ({
    line: t.line,
    path: `bookmarks.${t.name}`,
    message: "ignored: :source <file> does not change bookmarks",
  }));
  if (use(path, text, ignored)) sourced = path;
}

/**
 * One read at a time. A forced read asked for during a running one runs after it, so `:source`
 * always sees the file as it is when it was typed.
 * @param {boolean} [force]
 * @returns {Promise<void>}
 */
function poll(force = false) {
  if (running) {
    if (force) again = true;
    return running;
  }
  running = check(force)
    .catch((e) => console.error("vimma: config check failed", e))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        poll(true);
      }
    });
  return running;
}

/**
 * Runs `task` once no read is running, and holds polls off while it runs.
 * @param {() => Promise<void>} task
 */
async function exclusive(task) {
  while (running) await running;
  running = task()
    .catch((e) => console.error("vimma: config read failed", e))
    .finally(() => {
      running = null;
    });
  await running;
}

/**
 * `:source <path>`: the path as typed, expanded as core's resolveSourcePath says; a relative
 * one is next to config.toml.
 * @param {string} arg
 */
function sourcePath(arg) {
  return resolveSourcePath(arg, {
    home: home(),
    xdgConfigHome: Services.env.get("XDG_CONFIG_HOME"),
    configDir: PathUtils.parent(configPath()) ?? "/",
  });
}

/**
 * Creates `path` from the commented template, its folder too (0700, only when missing), with
 * mode 0600. Never overwrites: "create" fails on a file (or symlink) that is there.
 * @param {string} path
 * @returns {Promise<boolean>} whether this call created it
 */
async function createFromTemplate(path) {
  if (await IOUtils.exists(path)) return false;
  const parent = PathUtils.parent(path);
  if (parent && !(await IOUtils.exists(parent))) {
    await IOUtils.makeDirectory(parent, { createAncestors: true, permissions: DIR_MODE });
  }
  await IOUtils.writeUTF8(path, formatConfigTemplate(), { mode: "create" });
  await IOUtils.setPermissions(path, FILE_MODE, false);
  return true;
}

/** `path` with the home folder as `~`, for a notice. */
function tilde(/** @type {string} */ path) {
  const h = home();
  return path.startsWith(h + "/") ? `~${path.slice(h.length)}` : path;
}

/**
 * First run: creates a missing config.toml from the template (as `:config` would), with one
 * notice, and marks the profile done either way. An existing file, even empty, is left alone.
 * @param {BrowserWindow} win
 * @returns {Promise<"created" | "exists" | "failed">}
 */
async function firstRun(win) {
  const path = configPath();
  let created;
  try {
    created = await createFromTemplate(path);
  } catch (e) {
    if (!(await IOUtils.exists(path))) {
      console.warn(`vimma: cannot create ${path}`, e);
      return "failed"; // tried again at the next start
    }
    created = false; // appeared meanwhile: someone else's
  }
  Services.prefs.setBoolPref(FIRST_RUN_PREF, true);
  if (!created) return "exists";
  VimmaHost.say(win, `created ${tilde(path)}`);
  return "created";
}

/**
 * Why startup does not create config.toml, or null when it may: another file is in force
 * (`vimma.config.path`), the profile's first run is done, or a test harness runs the browser.
 * @returns {"path" | "done" | "automation" | null}
 */
function firstRunBlocked() {
  if (Services.prefs.getStringPref(PATH_PREF, "")) return "path";
  if (Services.prefs.getBoolPref(FIRST_RUN_PREF, false)) return "done";
  if (Cu.isInAutomation) return "automation";
  return null;
}

/**
 * `:config`: config.toml in a new tab (view-source, read-only), first created from the
 * commented template, folders too, when it does not exist. An existing file is never written.
 * @param {BrowserWindow} win
 */
async function edit(win) {
  const path = configPath();
  try {
    await createFromTemplate(path);
  } catch (e) {
    if (!(await IOUtils.exists(path))) {
      console.error(`vimma: cannot create ${path}`, e);
      VimmaHost.say(win, `:config: cannot create ${path}`);
      return;
    }
  }
  openUrl(win, `view-source:${PathUtils.toFileURI(path)}`, "tab");
}

/**
 * A one-shot timer set again at each tick, not an interval: a repeating timer leaves the timer
 * list while it fires, and the browser-test harness, which lists repeating timers once as a
 * run starts, then reports it as left behind by whichever test file runs first.
 */
function startTimer() {
  if (timer !== null) lazy.clearTimeout(timer);
  const ms = Math.max(50, Services.prefs.getIntPref(POLL_PREF, DEFAULT_POLL_MS));
  timer = lazy.setTimeout(() => {
    startTimer();
    poll();
    bookmarksFile.tick().catch((e) => console.error("vimma: bookmarks.toml check failed", e));
  }, ms);
}

/**
 * @param {unknown} _subject
 * @param {string} _topic
 * @param {string} pref
 */
function onPref(_subject, _topic, pref) {
  if (pref === POLL_PREF) startTimer();
  else ConfigHost.reload(); // another path: read it now
}

/**
 * @param {unknown} _subject
 * @param {string} _topic
 * @param {string | null} data  `:source`'s path as typed, "" or null without one
 */
const reloadObserver = (_subject, _topic, data) => {
  ConfigHost.reload(data ?? "");
};

/** @param {unknown} subject  the window `:config` was typed in */
const editObserver = (subject) => {
  edit(/** @type {BrowserWindow} */ (subject)).catch((e) =>
    console.error("vimma: :config failed", e),
  );
};

/** @param {BrowserWindow} win  the first window, for the first run's notice */
function start(win) {
  Services.prefs.addObserver(PATH_PREF, onPref);
  Services.prefs.addObserver(POLL_PREF, onPref);
  Services.obs.addObserver(reloadObserver, CONFIG_RELOAD_TOPIC);
  Services.obs.addObserver(editObserver, CONFIG_EDIT_TOPIC);
  startTimer();
  bookmarksFile.start();
  // Never blocks startup: the windows start on the built-in keymap and swap when read. The
  // first run's file, all comments, means the defaults: read after it either way.
  const created = firstRunBlocked() ? Promise.resolve() : firstRun(win);
  created
    .catch((e) => console.warn("vimma: first run config not created", e))
    .finally(() => poll(true));
}

function stop() {
  bookmarksFile.stop();
  if (timer !== null) lazy.clearTimeout(timer);
  timer = null;
  Services.prefs.removeObserver(PATH_PREF, onPref);
  Services.prefs.removeObserver(POLL_PREF, onPref);
  Services.obs.removeObserver(reloadObserver, CONFIG_RELOAD_TOPIC);
  Services.obs.removeObserver(editObserver, CONFIG_EDIT_TOPIC);
}

/**
 * An edit of config.toml: `compute` gets the file's text (null when it does not exist) and
 * returns the new text with whatever the caller wants back, `{ text: null }` to leave the file
 * alone, or `{ error }`. Written as writeFileNow writes, in the one edit queue (D11); then the
 * file is read, after the edit's task has ended, so the read never waits on the edit.
 * @template {{ text: string | null }} R
 * @param {(text: string | null) => R | { error: string }} compute
 * @returns {Promise<R | { error: string }>}
 */
async function rewriteConfig(compute) {
  // One edit at a time: two that read the same text would both pass writeFileNow's check, and
  // the second rename would drop the first edit after both said they were written.
  const r = await edits.run(() => writeFileNow(configPath(), compute));
  if (!("error" in r) && r.text !== null) await ConfigHost.reload();
  return r;
}

/**
 * One edit of `path` (config.toml, or bookmarks.toml beside it), run inside the edit queue: the
 * new text goes through a 0600 temporary file in the same folder, given the file's permissions
 * and renamed over the file, or over the file a symlink points to, so a dotfile link stays a link
 * and a crash never leaves half a file. A link to nothing is never replaced. Nothing is written
 * when the file changed while it was edited (`changed`: the caller may compute again from the new
 * text). A missing file is created, with its folder, only by a `compute` that takes null.
 * @template {{ text: string | null }} R
 * @param {string} path
 * @param {(text: string | null) => R | { error: string }} compute
 * @param {number} [maxBytes]  a larger file is not read (the bookmarks file's limit)
 * @returns {Promise<R | { error: string, changed?: boolean }>}
 */
async function writeFileNow(path, compute, maxBytes = Infinity) {
  /** @type {string | null} */
  let text = null;
  /** @type {Awaited<ReturnType<IOUtilsNamespace["stat"]>> | null} */
  let before = null;
  let target = path;
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    // isSymlink is lstat: a missing file throws, and is created from the template.
    let link = false;
    try {
      link = file.isSymlink();
    } catch (e) {
      if (/** @type {Thrown} */ (e)?.result !== Cr.NS_ERROR_FILE_NOT_FOUND) throw e;
    }
    if (link) {
      // A link to nothing: writing would replace the user's link with a plain file.
      if (!file.exists()) return { error: `${path} is a link to a missing file; nothing written` };
      target = file.target;
    }
    before = await IOUtils.stat(target);
    // Only a regular file is read and replaced (a FIFO would block, a folder is not ours).
    if (before.type !== "regular")
      return { error: `${path} is not a regular file; nothing written` };
    // The size as well: a file swapped since its caller read it is never read whole.
    if ((before.size ?? 0) > maxBytes) return { error: `${path} is too large; nothing written` };
    text = await IOUtils.readUTF8(target);
  } catch (e) {
    if (!notFound(e)) return { error: `cannot read ${path}` };
  }
  const r = compute(text);
  if ("error" in r || r.text === null) return r;
  const dir = PathUtils.parent(target) ?? "/";
  const tmp = PathUtils.join(
    dir,
    `.${PathUtils.filename(target)}.${Services.uuid.generateUUID().toString().slice(1, 9)}`,
  );
  try {
    if (!(await IOUtils.exists(dir))) {
      await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: DIR_MODE });
    }
    // Empty and with the file's permissions before the text goes in, so that a 0600 file is
    // never readable more widely, even for a moment.
    await IOUtils.writeUTF8(tmp, "", { mode: "create" });
    await IOUtils.setPermissions(tmp, before ? before.permissions : FILE_MODE, false);
    await IOUtils.writeUTF8(tmp, r.text, { mode: "overwrite" });
    // The file's text as well as its time: an edit within the time's resolution changes it.
    const now = await IOUtils.readUTF8(target).catch(() => null);
    const stat = await IOUtils.stat(target).catch(() => null);
    if (now !== text || (stat?.lastModified ?? null) !== (before?.lastModified ?? null)) {
      await IOUtils.remove(tmp);
      return { error: `${path} changed meanwhile; nothing written`, changed: true };
    }
    await IOUtils.move(tmp, target);
  } catch (e) {
    console.error(`vimma: cannot write ${path}`, e);
    await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
    return { error: `cannot write ${path}` };
  }
  return r;
}

/**
 * `:route add`'s append (ConfigHost.addRoute), run inside the edit queue.
 * @param {{ domain: string, workspace: string }} rule
 * @returns {Promise<string | null>} why not, or null once written
 */
async function appendRoute(rule) {
  const path = configPath();
  /** @type {string | null} */
  let text = null;
  try {
    text = await IOUtils.readUTF8(path);
  } catch (e) {
    if (!notFound(e)) return `cannot read ${path}`;
  }
  const r = appendRouteText(text, rule, { mac: Services.appinfo.OS === "Darwin" });
  if ("error" in r) return r.error;
  try {
    if ("create" in r) {
      const parent = PathUtils.parent(path);
      if (parent && !(await IOUtils.exists(parent))) {
        await IOUtils.makeDirectory(parent, { createAncestors: true, permissions: DIR_MODE });
      }
      await IOUtils.writeUTF8(path, r.create, { mode: "create" });
      await IOUtils.setPermissions(path, FILE_MODE, false);
    } else {
      await IOUtils.writeUTF8(path, r.append, { mode: "append" });
    }
  } catch (e) {
    console.error(`vimma: cannot write ${path}`, e);
    return `cannot write ${path}`;
  }
  return null;
}

export const ConfigHost = {
  /** The bookmarks.toml mirror (docs/specs/bookmarks-file.md), for tests and about:vimma. */
  bookmarksFile,

  /**
   * `:bookmarks forget` (docs/specs/bookmarks-file.md Behaviour 19), which vimma.js hands the
   * host through host-services. A function of its own, so it can be handed over alone.
   * @returns {Promise<string>} what to tell the user
   */
  bookmarksForget() {
    return bookmarksFile.forget();
  },

  /**
   * `:bookmarks export` and `export!` (docs/specs/bookmarks-file.md Behaviour 17), which vimma.js
   * hands the host through host-services.
   * @param {BrowserWindow | null} win  the window the command was typed in
   * @param {boolean} replace  `export!`
   * @returns {Promise<string>} what to tell the user
   */
  bookmarksExport(win, replace) {
    return bookmarksFile.exportFile(win, replace);
  },

  /** The words `:bookmarks` completes to while the feature is on: export, export! and forget. */
  bookmarksWords() {
    return bookmarksFile.words();
  },

  /**
   * The last read's errors, which kept the file from applying (`[search]`'s, found after it
   * applied, are not among them), and the file they are about: why the agent window has no model
   * (docs/specs/builtin-agent.md, Behaviour 6). A method, not a getter, so that vimma.js can hand
   * the host this function on its own (HostServices).
   * @returns {{ errors: readonly ConfigError[], file: string }}
   */
  refused() {
    return { errors, file: PathUtils.filename(errorsPath || configPath()) };
  },

  /**
   * Once per browser window (vimma.js), after VimmaHost and PaneViews: the config in force now,
   * and polling while any window is open.
   * @param {BrowserWindow} win
   */
  init(win) {
    if (windows.has(win)) return;
    const first = windows.size === 0;
    windows.add(win);
    if (active) applyToWindow(win, active.config);
    win.addEventListener(
      "unload",
      () => {
        windows.delete(win);
        if (!windows.size) stop();
      },
      { once: true },
    );
    if (first) start(win);
  },

  /**
   * Reads config.toml now, changed or not (`:source`, a new path), or with `arg` (`:source
   * <path>`) that file instead.
   * @param {string} [arg]  a path as typed
   * @returns {Promise<void>} settled once the read is applied or reported
   */
  async reload(arg = "") {
    const path = sourcePath(arg);
    if (path) {
      await exclusive(() => source(path));
      return;
    }
    await poll(true);
    // A read was running: ours was queued behind it.
    while (running) await running;
    await bookmarksFile.tick(true);
  },

  /**
   * `:route add`: appends a `domain` rule to config.toml (created from the template when
   * missing) and reads the file at once. Appending follows a symlinked file and never truncates
   * it. Refused, with nothing written, when the file would not parse with the rule. Run in the
   * one edit queue (setup-v2 decision 5), so that a rewrite that read the file before the append
   * neither drops the rule nor refuses as "changed meanwhile".
   * @param {{ domain: string, workspace: string }} rule
   * @returns {Promise<string | null>} why not, or null once written and read
   */
  async addRoute(rule) {
    const why = await edits.run(() => appendRoute(rule));
    if (why !== null) return why;
    // ConfigHost, not `this`: vimma.js hands the host this method on its own (HostServices).
    await ConfigHost.reload();
    return null;
  },

  /**
   * Keys set in config.toml by their lines alone (docs/specs/setup-v2.md decision 5): the
   * setup's one writer, run as `addAgentProvider` writes, then the file read. Nothing is written
   * when the file does not load now, would not load with the edits (parseConfig, before the
   * rename), changed meanwhile, or already says so.
   * @param {readonly import("../core/toml.mjs").TomlEdit[]} keys
   * @returns {Promise<string | null>} why not, or null once written (or already so) and read
   */
  async setConfigKeys(keys) {
    const r = await rewriteConfig((text) =>
      setConfigKeysText(text, keys, { mac: Services.appinfo.OS === "Darwin" }),
    );
    return "error" in r ? r.error : null;
  },

  /**
   * The built-in agent's setup
  /**
   * The built-in agent's setup (docs/specs/builtin-agent.md Behaviour 2-3): the provider picked
   * in the chat window goes into config.toml as `[[agent.providers]]`, by name, kind, endpoint,
   * model and vision only (its key stays in login storage), and with `makeDefault` becomes
   * `[agent] default`, so that it survives a restart; then the file is read. The file's other
   * lines stay as they are. Written through a 0600 temporary file renamed over the file a
   * symlinked config.toml points to, so a dotfile link stays a link; nothing is written when the
   * file does not parse, would not with the edit, or changed while it was edited.
   * @param {import("../core/config.mjs").AgentProviderConfig} provider
   * @param {{ makeDefault: boolean }} opts
   * @returns {Promise<{ name: string } | { error: string }>} the name it has in the file
   */
  async addAgentProvider(provider, { makeDefault }) {
    const r = await rewriteConfig((text) =>
      addAgentProviderText(text, provider, {
        makeDefault,
        mac: Services.appinfo.OS === "Darwin",
      }),
    );
    return "error" in r ? r : { name: r.name };
  },

  /**
   * `:siteunbind --save` and `:sitebind --delete` (docs/specs/site-unbind-command.md decision
   * 10): canonical keys added to, or removed from, `[sites."<table>"] unbind`, the file's other
   * lines kept, then the file read. Written as `addAgentProvider` writes; nothing is written
   * when the file has errors, would not load with the edit, changed meanwhile, or already says
   * so (a key it lists, or none of the keys to remove).
   * @param {string} table
   * @param {{ add?: string[], remove?: string[] }} change
   * @returns {Promise<{ added: string[], already: string[], removed: string[] } | { error: string }>}
   */
  async editSiteUnbind(table, change) {
    const r = await rewriteConfig((text) => {
      const edit = editSiteUnbindText(text, table, change, {
        mac: Services.appinfo.OS === "Darwin",
      });
      if ("error" in edit) return edit;
      return { ...edit, text: edit.text === text ? null : edit.text };
    });
    if ("error" in r) return r;
    return { added: r.added, already: r.already, removed: r.removed };
  },

  firstRun,

  /** Why startup leaves config.toml alone, or null when it creates a missing one. */
  get firstRunBlocked() {
    return firstRunBlocked();
  },

  /** The resolved config in force (core's ResolvedConfig), null before the first read. */
  get config() {
    return active?.config ?? null;
  },

  /** The last read's errors, [] when it was applied (the status bar shows the first). */
  get errors() {
    return errors;
  },

  /**
   * What the last read left out of a file it applied, such as a provider whose `cli` this build
   * does not know (#742); [] otherwise. The status bar shows them after the errors.
   */
  get warnings() {
    return warnings;
  },

  /** The file whose config is in force: config.toml, or the one `:source <path>` read. */
  get path() {
    return sourced ?? configPath();
  },

  /** config.toml, or the file `vimma.config.path` names; never a `:source <path>` one. */
  get configFile() {
    return configPath();
  },

  /** The file `errors` are about (about:vimma). */
  get errorsPath() {
    return errorsPath || configPath();
  },

  /** The keymap in force (core's Keymap), null before the first read (about:vimma). */
  get keymap() {
    return active?.keymap ?? null;
  },

  /**
   * The file as last read (about:vimma): "pending" before the first read, "missing" (the
   * defaults), else "read" (applied, or the previous config kept when `errors` is not empty).
   * @returns {"pending" | "missing" | "read"}
   */
  get file() {
    if (!active) return "pending";
    if (sourced) return "read";
    return signature === "missing" ? "missing" : "read";
  },
};

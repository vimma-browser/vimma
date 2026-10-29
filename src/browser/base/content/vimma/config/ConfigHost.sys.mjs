/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// config.toml for every window (spec: docs/specs/m5-config-load.md). One per app. Reads
// `$XDG_CONFIG_HOME/vimma/config.toml` (default `~/.config/vimma/config.toml`) and nothing else
// in that folder, polls its mtime and size every 2 s (plan §3: Firefox has no portable file
// watcher), and reads it at once on `:source`. vimma-core parses and validates (reloadConfig:
// a file is applied whole or not at all, else the last good config stays); this module does
// the I/O and hands each part to the module that uses it. `:source <path>` puts another file in
// force the same way, until config.toml changes or a plain `:source`. Writes: the first run and
// `:config` create a missing config.toml from the commented template, never touching an existing
// one; `:route add` appends one `[[routes]]` table (spec workspace-routing), checked to parse
// first.

import {
  addAgentProviderText,
  appendRouteText,
  formatConfigError,
  rawUpdatesCheck,
  reloadConfig,
  resolveSourcePath,
} from "../core/config.mjs";
import { formatConfigTemplate } from "../core/defaults.mjs";
import { updatesCheckAfterRead } from "../core/updates.mjs";
import { locateKeys } from "../core/toml.mjs";
import { CONFIG_EDIT_TOPIC, CONFIG_RELOAD_TOPIC, VimmaHost } from "../host/VimmaHost.sys.mjs";
import { openUrl } from "../host/tab-ops.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { PrivateSwap } from "../host/private-swap.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { BookmarksToolbar } from "../ui/bookmarks-toolbar.mjs";
import { Toolbar } from "../ui/toolbar.mjs";
import { VimmaUpdates } from "../updates/VimmaUpdates.sys.mjs";
import { WorkspaceRouter } from "../workspaces/WorkspaceRouter.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/** @import { ActiveConfig, ConfigError, ResolvedConfig } from "../core/config.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
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
const notFound = (/** @type {unknown} */ e) => /** @type {any} */ (e)?.name === "NotFoundError";

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
/** @type {ConfigError[]} the last read's errors; [] when it was applied */
let errors = [];
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
/** @type {unknown} */
let timer = null;
/** @type {Set<Window>} */
const windows = new Set();
/**
 * `[ui] toolbar` of the last config applied; null before the first. The pref is written only
 * when it changes, so ctrl+b u lasts until a restart or an edit of that line, as a tmux `set`
 * lasts until .tmux.conf is sourced (docs/specs/toolbar-toggle.md decision 4).
 * @type {string | null}
 */
let appliedToolbar = null;

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

/** @param {Window} win @param {ResolvedConfig} config */
function applyToWindow(win, config) {
  const view = PaneViews.get(win);
  if (!view) return;
  view.max = config.panes.max;
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
  });
  for (const win of windows) applyToWindow(win, config);
  ThemeHost.setConfig(config.theme);
  PrivateSwap.configure(config.private.placement);
  WorkspaceRouter.setRoutes(config.routes);
  McpHost.configure(config.mcp);
  McpHost.configureAgent(config.agent);
  if (config.ui.toolbar !== appliedToolbar) {
    appliedToolbar = config.ui.toolbar;
    Toolbar.setHidden(config.ui.toolbar === "hidden");
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
 */
function report(path, list, kept) {
  errors = list;
  errorsPath = path;
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
 * The status bar's errors: the last read's, then `[search]`'s, which only the profile's engines
 * reveal once the file is applied (search-engines decision 9).
 */
function showErrors() {
  VimmaHost.configure({
    configErrors: [...errors, ...SearchHost.errors],
    configFile: PathUtils.filename(errorsPath || configPath()),
  });
}
SearchHost.onErrors = showErrors;

/**
 * Applies `text` (the contents of `path`) when it is valid, else reports its errors.
 * @param {string} path
 * @param {string} text
 * @returns {boolean} whether it was applied
 */
function use(path, text) {
  const previous = active;
  const r = reloadConfig(active, text, { mac: Services.appinfo.OS === "Darwin" });
  active = r.active;
  if (active !== previous) apply(active, text);
  // A file with errors never turns update checks on (docs/specs/m6a-updater.md decision 31).
  VimmaUpdates.configure(
    updatesCheckAfterRead({
      errors: r.errors.length,
      inForce: active.config.updates.check,
      raw: r.errors.length ? rawUpdatesCheck(text) : null,
      hadConfig: previous !== null && !fallback,
    }),
  );
  fallback = previous === null ? r.errors.length > 0 : fallback && r.errors.length > 0;
  report(path, r.errors, previous !== null);
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
        VimmaUpdates.configure({ check: false, held: true });
        throw e;
      }
      signature = "missing"; // removed between stat and read: the defaults, silently
    }
  }
  use(path, text);
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
  if (use(path, text)) sourced = path;
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
 * @param {Window} win
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
 * @param {Window} win
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

function startTimer() {
  if (timer !== null) lazy.clearInterval(timer);
  const ms = Math.max(50, Services.prefs.getIntPref(POLL_PREF, DEFAULT_POLL_MS));
  timer = lazy.setInterval(() => poll(), ms);
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
  edit(/** @type {Window} */ (subject)).catch((e) => console.error("vimma: :config failed", e));
};

/** @param {Window} win  the first window, for the first run's notice */
function start(win) {
  Services.prefs.addObserver(PATH_PREF, onPref);
  Services.prefs.addObserver(POLL_PREF, onPref);
  Services.obs.addObserver(reloadObserver, CONFIG_RELOAD_TOPIC);
  Services.obs.addObserver(editObserver, CONFIG_EDIT_TOPIC);
  startTimer();
  // Never blocks startup: the windows start on the built-in keymap and swap when read. The
  // first run's file, all comments, means the defaults: read after it either way.
  const created = firstRunBlocked() ? Promise.resolve() : firstRun(win);
  created
    .catch((e) => console.warn("vimma: first run config not created", e))
    .finally(() => poll(true));
}

function stop() {
  if (timer !== null) lazy.clearInterval(timer);
  timer = null;
  Services.prefs.removeObserver(PATH_PREF, onPref);
  Services.prefs.removeObserver(POLL_PREF, onPref);
  Services.obs.removeObserver(reloadObserver, CONFIG_RELOAD_TOPIC);
  Services.obs.removeObserver(editObserver, CONFIG_EDIT_TOPIC);
}

export const ConfigHost = {
  /**
   * Once per browser window (vimma.js), after VimmaHost and PaneViews: the config in force now,
   * and polling while any window is open.
   * @param {Window} win
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
  },

  /**
   * `:route add`: appends a `domain` rule to config.toml (created from the template when
   * missing) and reads the file at once. Appending follows a symlinked file and never truncates
   * it. Refused, with nothing written, when the file would not parse with the rule.
   * @param {{ domain: string, workspace: string }} rule
   * @returns {Promise<string | null>} why not, or null once written and read
   */
  async addRoute(rule) {
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
    await this.reload();
    return null;
  },

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
    const path = configPath();
    /** @type {string | null} */
    let text = null;
    /** @type {any} */
    let before = null;
    let target = path;
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      if (file.isSymlink()) {
        // A link to nothing: writing would replace the user's link with a plain file.
        if (!file.exists())
          return { error: `${path} is a link to a missing file; nothing written` };
        target = file.target;
      }
      before = await IOUtils.stat(target);
      text = await IOUtils.readUTF8(target);
    } catch (e) {
      if (!notFound(e)) return { error: `cannot read ${path}` };
    }
    const r = addAgentProviderText(text, provider, {
      makeDefault,
      mac: Services.appinfo.OS === "Darwin",
    });
    if ("error" in r) return r;
    const dir = PathUtils.parent(target) ?? "/";
    const tmp = PathUtils.join(
      dir,
      `.config.toml.${Services.uuid.generateUUID().toString().slice(1, 9)}`,
    );
    try {
      if (!(await IOUtils.exists(dir))) {
        await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: DIR_MODE });
      }
      await IOUtils.writeUTF8(tmp, r.text, { mode: "create" });
      await IOUtils.setPermissions(tmp, before ? before.permissions : FILE_MODE, false);
      // The file's text as well as its time: an edit within the time's resolution changes it.
      const now = await IOUtils.readUTF8(target).catch(() => null);
      const stat = await IOUtils.stat(target).catch(() => null);
      if (now !== text || (stat?.lastModified ?? null) !== (before?.lastModified ?? null)) {
        await IOUtils.remove(tmp);
        return { error: `${path} changed meanwhile; nothing written` };
      }
      await IOUtils.move(tmp, target);
    } catch (e) {
      console.error(`vimma: cannot write ${path}`, e);
      await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
      return { error: `cannot write ${path}` };
    }
    await this.reload();
    return { name: r.name };
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

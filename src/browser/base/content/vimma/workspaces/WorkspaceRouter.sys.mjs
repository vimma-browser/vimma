/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Workspace routing (spec: docs/specs/workspace-routing.md): `[[routes]]` rules pick the
 * container a link from outside the browser opens in; what the user opens inside Vimma stays in
 * the active workspace (decision 9). One per app. The routing points, each only filling in a
 * container for a tab or window being created (never moving a tab, so nothing here can loop):
 * - `externalUserContextId` and `externalWhere`, from BrowserDOMWindow-sys-mjs.patch: links
 *   from other apps;
 * - `firstTab`, from Tabbrowser-sys-mjs.patch hunk 2 (through WorkspaceStore): the first tab of
 *   a cold start from a link or of a window opened for another app's link, with their apps.
 * `routeLinkIn`, from URILoadingHelper-sys-mjs.patch, routes nothing any more.
 * The programs that opened a link come from vimma-open as `-vimma-from <names>` on the remote
 * command line (a handler registered here) or, at a cold start, as `VIMMA_FROM`: up to eight
 * names, nearest first (docs/specs/app-routes.md). They are an untrusted hint: tokens only, ever
 * compared with a rule's `app` and nothing else.
 * Links from other apps and new windows never take the agent workspace's container, not even
 * by a rule (docs/specs/vimma-mcp.md, decision 42): such a rule is passed over, and an agent
 * CLI's rule drops every name of its links (app-routes, decision 5). `[routing]
 * default_workspace` takes the links from other apps that no rule matches (decision 16).
 */

import {
  defaultWorkspaceFor,
  isAppToken,
  matchRoute,
  parseAppList,
  shadowedBy,
} from "../core/routes.mjs";
import { formatRoutesCache, parseRoutesCache } from "../core/routes-file.mjs";
import { WorkspaceStore } from "./WorkspaceStore.sys.mjs";

/** @import { Route } from "../core/routes.mjs" */
/** @import { WorkspaceDefinition } from "../core/workspacedefs.mjs" */

const lazy = /** @type {Lazy<"PrivateBrowsingUtils" | "URILoadingHelper">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
});

/**
 * `ucid`, unless it is the agent workspace's container (or 0, no container): then null.
 * @param {number | null | undefined} ucid
 * @returns {number | null}
 */
function notAgent(ucid) {
  return !ucid || WorkspaceStore.isAgentContainer(ucid) ? null : ucid;
}

const FLAG = "vimma-from";
const ENV = "VIMMA_FROM";
const CONTRACT = "@vimma.org/routing/from-clh;1";
/** Before "x-default" (nsDefaultCommandLineHandler), which opens the URL. */
const CATEGORY_ENTRY = "k-vimma-from";
/** The rules in force at the last change, so a cold start routes before config.toml is read. */
const CACHE_PREF = "vimma.routes.cache";
/** `[routing] default_workspace` at the last change, for a cold start too. */
const DEFAULT_PREF = "vimma.routes.defaultWorkspace";

const cached = parseRoutesCache(Services.prefs.getStringPref(CACHE_PREF, "[]"));
/** @type {Route[]} */
let routes = cached.routes;
/**
 * The file the rules came from and each one's line, for about:vimma, `:route add`'s message and
 * ConfigHost's last good routes.toml rules at a cold start (docs/specs/routes-file.md Behaviours
 * 5 and 13). Before the first read: the cache's file, lines unknown.
 * @type {{ file: string, lines: readonly number[] }}
 */
let source = { file: cached.file, lines: [] };
/** @type {string | null} */
let defaultWorkspace = Services.prefs.getStringPref(DEFAULT_PREF, "") || null;
/** The programs of the command line being handled, until the current task ends. */
/** @type {string[]} */
let pendingApps = [];
/** `VIMMA_FROM`, read and cleared once per process, at init or the first window's first tab. */
let envRead = false;
/**
 * The cold start's programs, until the first window has routed its first tab or finished
 * starting; null when none were given.
 * @type {string[] | null}
 */
let startupApps = null;
/**
 * Until the first window has asked for its first tab or finished starting: that window is the
 * cold start's, whose URL list (an nsIArray) came from the command line.
 */
let coldStart = true;

/**
 * A tab an app rule placed: the link's names and host (app-routes, decision 14). The hint,
 * `:route move` and about:vimma match the tab with these names while it stays on that host, so
 * a `domain` rule below the app rule does not call it misplaced. Memory only, never shown with
 * a URL.
 * @typedef {{ names: readonly string[], host: string }} Placed
 */
/** @type {WeakMap<MozTabbrowserTab, Placed>} */
const placed = new WeakMap();
/**
 * The open an app rule just routed, until TabOpen adopts the tab openURI creates for it (in the
 * same task) or the task ends.
 * @type {(Placed & { ucid: number }) | null}
 */
let pendingPlace = null;
/**
 * The most recent link from another program, for about:vimma (decision 15): its names and what
 * it matched, never its URL. Memory only.
 * @typedef {{ names: readonly string[], rule: number | null, workspace: string | null,
 *   by: "rule" | "default" | "none" }} LastLink
 */
/** @type {LastLink | null} */
let lastLink = null;

/**
 * The host of `url`, or null (a URL with none, such as about:blank).
 * @param {string} url
 */
function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Holds `place` for the tab the routed open creates, until the current task ends.
 * @param {Placed & { ucid: number }} place
 */
function placeNext(place) {
  pendingPlace = place;
  Services.tm.dispatchToMainThread(() => {
    if (pendingPlace === place) pendingPlace = null;
  });
}

/**
 * Reads `VIMMA_FROM` once and clears it, whether or not anything uses it: it must never reach
 * the processes Vimma starts or a later window.
 */
function readStartupEnv() {
  if (envRead) return;
  envRead = true;
  const raw = Services.env.get(ENV);
  if (!raw) return;
  Services.env.set(ENV, "");
  const names = parseAppList(raw);
  startupApps = names.length ? names : null;
}

/**
 * The startup app is for the first window's first tab only: dropped once a window has started
 * (a private first window, or containers off, never asks for it).
 */
function armStartupDrop() {
  const done = () => {
    startupApps = null;
    coldStart = false;
    Services.obs.removeObserver(done, "browser-delayed-startup-finished");
  };
  Services.obs.addObserver(done, "browser-delayed-startup-finished");
}
let registered = false;

/** @param {Window | null | undefined} win */
function unroutable(win) {
  return !win || lazy.PrivateBrowsingUtils.isWindowPrivate(win) || win.toolbar?.visible === false;
}

/**
 * What a command line's `url` loads as (`example.com` → `http://example.com/`), or `url` itself.
 * @param {string} url
 */
function fixup(url) {
  try {
    return (
      Services.uriFixup.getFixupURIInfo(url, Ci.nsIURIFixup.FIXUP_FLAG_NONE).preferredURI?.spec ??
      url
    );
  } catch {
    return url;
  }
}

/** `-vimma-from <names>`: held for the command line being handled, then dropped. */
const handler = {
  handle(/** @type {nsICommandLine} */ cmdLine) {
    /** @type {string | null} */
    let raw;
    try {
      raw = cmdLine.handleFlagWithParam(FLAG, false);
    } catch {
      return; // the flag without a value: x-default reports it
    }
    if (raw === null) return;
    const names = parseAppList(raw);
    if (!names.length) return;
    pendingApps = names;
    // x-default opens the URL inside this same task (handURIToExistingBrowser → openURI).
    Services.tm.dispatchToMainThread(() => {
      if (pendingApps === names) pendingApps = [];
    });
  },
  helpInfo: `  --${FLAG} <names>  The programs that opened the link, nearest first (vimma-open), for [[routes]].\n`,
  QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler"]),
};

const factory = {
  createInstance(/** @type {nsIJSIID<unknown>} */ iid) {
    return handler.QueryInterface(iid);
  },
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
};

export const WorkspaceRouter = {
  /** Once per process (vimma.js): the `-vimma-from` command-line handler. */
  init() {
    readStartupEnv();
    if (registered) return;
    registered = true;
    armStartupDrop();
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    if (registrar.isContractIDRegistered(CONTRACT)) return;
    registrar.registerFactory(
      Components.ID(Services.uuid.generateUUID().toString()),
      "Vimma -vimma-from",
      CONTRACT,
      factory,
    );
    Services.catMan.addCategoryEntry("command-line-handler", CATEGORY_ENTRY, CONTRACT, false, true);
  },

  /** The rules in force (ConfigHost sets them from routes.toml or config.toml). */
  get routes() {
    return routes;
  },

  /** The file the rules in force came from, and each rule's line (0: not known). */
  get routesSource() {
    return source;
  },

  /**
   * @param {Route[]} next  core `routesInForce(...).routes`
   * @param {{ file: string, lines: readonly number[] }} [from]  where they are written
   */
  setRoutes(next, from = { file: "config.toml", lines: [] }) {
    routes = next;
    source = from;
    try {
      Services.prefs.setStringPref(CACHE_PREF, formatRoutesCache(next, from.file));
    } catch (e) {
      console.warn("vimma: routes not cached", e);
    }
  },

  /**
   * `[routing] default_workspace` (ConfigHost sets it from config.toml), or null.
   * @param {string | null} name
   */
  setDefaultWorkspace(name) {
    defaultWorkspace = name;
    try {
      Services.prefs.setStringPref(DEFAULT_PREF, name ?? "");
    } catch (e) {
      console.warn("vimma: the default workspace was not cached", e);
    }
  },

  /** `[routing] default_workspace`, or null. */
  get defaultWorkspace() {
    return defaultWorkspace;
  },

  /** The programs of the command line being handled, nearest first; empty when none. */
  get apps() {
    return pendingApps;
  },

  /**
   * The first rule for `url` opened by `apps` whose workspace exists, with that workspace.
   * `external`: a link from another program, which passes over rules naming the agent
   * workspace (app-routes, decision 5).
   * @param {string} url
   * @param {readonly string[]} [apps]
   * @param {{ external?: boolean }} [options]
   * @returns {{ route: Route, workspace: WorkspaceDefinition } | null}
   */
  match(url, apps = [], { external = false } = {}) {
    if (!routes.length || WorkspaceStore.disabled) return null;
    const defs = WorkspaceStore.definitions.workspaces;
    const route = matchRoute(
      routes,
      { url, apps },
      { workspaces: defs.map((d) => d.name), skip: external ? agentNames() : [] },
    );
    const workspace = route && defs.find((d) => d.name === route.workspace);
    return route && workspace && workspace.userContextId !== null ? { route, workspace } : null;
  },

  /**
   * The container for a link from another program: a rule's (never the agent workspace's),
   * else `[routing] default_workspace`'s, else null.
   * @param {string} url
   * @param {readonly string[]} apps
   * @returns {number | null}
   */
  externalContainer(url, apps) {
    if (WorkspaceStore.disabled) return null;
    const names = apps.filter((a) => isAppToken(a));
    const match = this.match(url, names, { external: true });
    const hit = notAgent(match?.workspace.userContextId);
    if (match && hit !== null) {
      lastLink = { names, rule: match.route.index, workspace: match.workspace.name, by: "rule" };
      const host = hostOf(url);
      if (match.route.app !== undefined && host) placeNext({ names, host, ucid: hit });
      return hit;
    }
    lastLink = { names, rule: null, workspace: null, by: "none" };
    if (defaultWorkspace === null) return null;
    const defs = WorkspaceStore.definitions.workspaces;
    const name = defaultWorkspaceFor(defaultWorkspace, {
      workspaces: defs.map((d) => d.name),
      skip: agentNames(),
    });
    const ucid = notAgent(defs.find((d) => d.name === name)?.userContextId);
    if (ucid !== null) lastLink = { names, rule: null, workspace: name, by: "default" };
    return ucid;
  },

  /**
   * WindowWorkspaces, on TabOpen: the tab openURI created for the link an app rule just
   * routed takes that link's names (decision 14).
   * @param {MozTabbrowserTab} tab
   */
  adoptTab(tab) {
    const place = pendingPlace;
    if (!place || tab?.userContextId !== place.ucid) return;
    pendingPlace = null;
    placed.set(tab, { names: place.names, host: place.host });
  },

  /**
   * WindowWorkspaces, on a tab's top-level location change: a tab that left the host its app
   * rule placed it on is matched by the rules alone from then on (its own navigation).
   * @param {MozTabbrowserTab} tab
   * @param {string} url
   */
  noteLocation(tab, url) {
    const rec = placed.get(tab);
    const host = rec && hostOf(url);
    if (rec && host && host !== rec.host) placed.delete(tab);
  },

  /**
   * The rule for `tab`'s page (or `url`, the location it is changing to): with the names of the
   * link an app rule placed it for while it stays on that host, else with none (decision 14).
   * For the hint, `:route move` and about:vimma. Matched as a link from another program, the
   * only open rules route (workspace-routing, decision 9), so a rule naming the agent workspace
   * is passed over: it routes nothing, and `:route move` would otherwise reopen the page, with
   * any token in its URL, in the agent's container (vimma-mcp, decision 42).
   * @param {MozTabbrowserTab} tab
   * @param {string} [url]
   */
  matchTab(tab, url = tab?.linkedBrowser?.currentURI?.spec ?? "") {
    const rec = placed.get(tab);
    const names = rec && hostOf(url) === rec.host ? rec.names : [];
    return this.match(url, names, { external: true });
  },

  /** The most recent link from another program: its names and what it matched, or null. */
  get lastLink() {
    return lastLink;
  },

  /**
   * For about:vimma (decision 15), per rule: the earlier rule that wins over it wherever it
   * applies (core `shadowedBy`), and whether it names the agent workspace, which links from
   * other programs pass over.
   * @returns {{ shadowedBy: number | null, agent: boolean }[]}
   */
  ruleMarks() {
    const agents = agentNames();
    const options = {
      workspaces: WorkspaceStore.definitions.workspaces.map((d) => d.name),
      skip: agents,
    };
    return routes.map((r, i) => ({
      shadowedBy: shadowedBy(routes, i, options)?.index ?? null,
      agent: agents.includes(r.workspace),
    }));
  },

  /**
   * `[routing] default_workspace` for about:vimma: its name and whether it applies.
   * @returns {{ name: string, state: "in force" | "no such workspace" | "agent" } | null}
   */
  defaultWorkspaceState() {
    if (defaultWorkspace === null) return null;
    const names = WorkspaceStore.definitions.workspaces.map((d) => d.name);
    if (!names.includes(defaultWorkspace)) {
      return { name: defaultWorkspace, state: "no such workspace" };
    }
    if (agentNames().includes(defaultWorkspace)) return { name: defaultWorkspace, state: "agent" };
    return { name: defaultWorkspace, state: "in force" };
  },

  /**
   * URILoadingHelper.openLinkIn, before it fills in a new window's container: what the user or
   * a page opens inside the browser (the URL bar, `:open`, bookmarks, a link) is never routed
   * (spec workspace-routing, decision 9), so `params.userContextId` is returned unchanged. The
   * patch keeps calling this until its hunk next changes (ADR-003's register line).
   * @param {Window | null} _win
   * @param {string} _url
   * @param {string} _where
   * @param {OpenLinkInParams} params
   * @returns {number | null | undefined} `params.userContextId`, for openLinkIn's own copy
   */
  routeLinkIn(_win, _url, _where, params) {
    return params.userContextId;
  },

  /**
   * BrowserDOMWindow, for a link from another app: the container a rule gives it, else
   * `[routing] default_workspace`'s, else Firefox's guess (`guess`: unless `browser.link.force_default_user_context_id_for_external_opens`),
   * else the window's workspace's; never the agent workspace's (vimma-mcp decision 42), so a
   * login link clicked in a mail app is never readable by an agent. Null where the workspace
   * default is null (a private window, containers off): addTab then does as upstream.
   * @param {nsIURI} uri
   * @param {BrowserWindow | null} win  the window it opens in
   * @param {boolean} guess  whether Firefox's guess from the open tabs is on
   * @returns {number | null}
   */
  externalUserContextId(uri, win, guess) {
    let ucid = null;
    try {
      if ((routes.length || defaultWorkspace !== null) && !unroutable(win)) {
        ucid = this.externalContainer(uri.spec, pendingApps);
      }
    } catch (e) {
      console.error("vimma: routing an external link failed", e);
    }
    try {
      if (ucid === null && guess) ucid = notAgent(lazy.URILoadingHelper.guessUserContextId(uri));
      return ucid ?? WorkspaceStore.nonAgentUserContextId(win);
    } catch (e) {
      // addTab still gets the link (as fromExternal), and its default skips the agent's too.
      console.error("vimma: choosing an external link's container failed", e);
      return null;
    }
  },

  /**
   * BrowserDOMWindow, for a link from another app once `aWhere` is resolved: "the current tab"
   * becomes a new tab when the selected tab is the agent workspace's (vimma-mcp decision 42).
   * @param {number} where  an nsIBrowserDOMWindow OPEN_* value
   * @param {BrowserWindow} win
   * @returns {number}
   */
  externalWhere(where, win) {
    const { OPEN_CURRENTWINDOW, OPEN_NEWTAB } = Ci.nsIBrowserDOMWindow;
    if (where !== OPEN_CURRENTWINDOW) return where;
    try {
      const ucid = win.gBrowser?.selectedTab?.userContextId;
      return ucid && notAgent(ucid) === null ? OPEN_NEWTAB : where;
    } catch (e) {
      console.error("vimma: checking the current tab for a link from another app failed", e);
      return OPEN_NEWTAB;
    }
  },

  /**
   * A new window's first tab (WorkspaceStore.firstTabUserContextId): for a cold start from a link
   * or a window opened for another program's link (`fromExternal`), the container that link
   * takes, as a link from another program does (`externalContainer`, `[routing]
   * default_workspace` included), opened by the cold start's programs (`VIMMA_FROM`, read once
   * and cleared); null for any other window: one opened inside Vimma (`ctrl+n` to a routed home
   * page, a URL opened in a new window) is never routed (spec workspace-routing, decision 9).
   * @param {BrowserWindow | null} win
   * @returns {number | null}
   */
  firstTab(win) {
    try {
      // A cold start's programs; else an external link opened as a window during its command line.
      const apps = this.takeStartupApps() ?? pendingApps;
      const first = coldStart;
      coldStart = false;
      if (!win || (!routes.length && defaultWorkspace === null) || unroutable(win)) return null;
      const url = singleUrl(win.arguments?.[0]);
      // At a cold start BrowserContentHandler passes the command line's URLs as an nsIArray in
      // arguments[0], without `fromExternal` (openBrowserWindow's list branch); its default
      // arguments (the home page) arrive as a string, also for a Smart Window, whose nsIArray
      // is the argument list itself.
      const external =
        fromExternal(win.arguments?.[1]) || (first && win.arguments?.[0] instanceof Ci.nsIArray);
      if (!url || !external) return null;
      WorkspaceStore.ensureLoaded();
      const ucid = this.externalContainer(fixup(url), apps);
      const place = pendingPlace;
      pendingPlace = null;
      // The first tab is made by #setupInitialBrowserAndTab, which fires no TabOpen: it is the
      // window's first tab once this window's setup task has ended (never whichever tab a
      // restore may have selected by then).
      if (place) {
        Services.tm.dispatchToMainThread(() => {
          const tab = win.closed ? null : win.gBrowser?.tabs?.[0];
          if (tab?.userContextId === place.ucid) {
            placed.set(tab, { names: place.names, host: place.host });
          }
        });
      }
      return ucid;
    } catch (e) {
      console.error("vimma: routing a new window failed", e);
      return null;
    }
  },

  /** vimma-open's programs at a cold start (`VIMMA_FROM`), once: null after the first call. */
  takeStartupApps() {
    readStartupEnv();
    const apps = startupApps;
    startupApps = null;
    return apps;
  },

  /** Tests: read and clear `VIMMA_FROM` again, as init does, for the next new window. */
  resetStartupAppForTesting() {
    envRead = false;
    startupApps = null;
    coldStart = true;
    readStartupEnv();
    armStartupDrop();
  },
};

/**
 * Whether `window.arguments[1]` marks a window BrowserContentHandler opened for one URL from a
 * command line (`fromExternal`, browser/components/BrowserContentHandler.sys.mjs
 * openBrowserWindow): a cold start's link or another program's link opened as a window.
 * @param {unknown} arg
 */
function fromExternal(arg) {
  try {
    return arg instanceof Ci.nsIPropertyBag2 && arg.getPropertyAsBool("fromExternal") === true;
  } catch {
    return false;
  }
}

/** The names of the workspaces that count as the agent's, passed over for outside links. */
function agentNames() {
  return WorkspaceStore.definitions.workspaces
    .filter((d) => WorkspaceStore.isAgentContainer(d.userContextId))
    .map((d) => d.name);
}

/**
 * `window.arguments[0]` when it is one URL: a string, an nsISupportsString or an nsIArray of one
 * (browser-init.js `uriToLoadPromise`). A `|`-separated list is several pages: not routed.
 * @param {unknown} arg
 * @returns {string | null}
 */
function singleUrl(arg) {
  /** @type {string | null} */
  let url = null;
  if (typeof arg === "string") url = arg;
  else if (arg instanceof Ci.nsISupportsString) url = arg.data;
  else if (arg instanceof Ci.nsIArray && arg.length === 1) {
    url = arg.queryElementAt(0, Ci.nsISupportsString).data;
  }
  return url && !url.includes("|") ? url : null;
}

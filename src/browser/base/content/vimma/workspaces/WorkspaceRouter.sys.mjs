/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Workspace routing (spec: docs/specs/workspace-routing.md): `[[routes]]` rules pick the
 * container a tab opens in. One per app. The routing points, each only filling in a container
 * for a tab or window being created (never moving a tab, so nothing here can loop):
 * - `routeLinkIn`, from URILoadingHelper-sys-mjs.patch: the URL bar, `:open`, bookmarks, and
 *   links a page opens in a new tab or window;
 * - `externalUserContextId` and `externalWhere`, from BrowserDOMWindow-sys-mjs.patch: links
 *   from other apps;
 * - `firstTab`, from Tabbrowser-sys-mjs.patch hunk 2 (through WorkspaceStore): a new window's
 *   first tab, with the app of a cold start.
 * The programs that opened a link come from vimma-open as `-vimma-from <names>` on the remote
 * command line (a handler registered here) or, at a cold start, as `VIMMA_FROM`: up to eight
 * names, nearest first (docs/specs/app-routes.md). They are an untrusted hint: tokens only, ever
 * compared with a rule's `app` and nothing else.
 * Links from other apps and new windows never take the agent workspace's container, not even
 * by a rule (docs/specs/vimma-mcp.md, decision 42): such a rule is passed over, and an agent
 * CLI's rule drops every name of its links (app-routes, decision 5). `[routing]
 * default_workspace` takes the links from other apps that no rule matches (decision 16).
 */

import { defaultWorkspaceFor, matchRoute, parseAppList } from "../core/routes.mjs";
import { WorkspaceStore } from "./WorkspaceStore.sys.mjs";

/** @import { Route } from "../core/routes.mjs" */
/** @import { WorkspaceDefinition } from "../core/workspacedefs.mjs" */

const lazy = /** @type {any} */ ({});
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

/** @type {Route[]} */
let routes = readCache();
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

/** @returns {Route[]} */
function readCache() {
  try {
    const cached = JSON.parse(Services.prefs.getStringPref(CACHE_PREF, "[]"));
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
}

/** @param {any} win */
function unroutable(win) {
  return !win || lazy.PrivateBrowsingUtils.isWindowPrivate(win) || win.toolbar?.visible === false;
}

/**
 * What the URL bar or `:open` would load for `url` (`example.com` → `http://example.com/`), or
 * `url` itself.
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

/**
 * A tab nothing has been loaded in yet: a new-tab page or blank, with no history.
 * @param {any} win
 * @param {any} tab
 */
function untouched(win, tab) {
  const browser = tab?.linkedBrowser;
  if (!browser || browser.canGoBack || tab.pinned) return false;
  const spec = browser.currentURI?.spec ?? "";
  return typeof win.isBlankPageURL === "function"
    ? win.isBlankPageURL(spec)
    : spec === "about:blank" || spec === "about:newtab";
}

/** `-vimma-from <names>`: held for the command line being handled, then dropped. */
const handler = {
  handle(/** @type {any} */ cmdLine) {
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
  createInstance(/** @type {unknown} */ iid) {
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

  /** The rules in force (ConfigHost sets them from config.toml). */
  get routes() {
    return routes;
  },

  /**
   * @param {Route[]} next  core `parseConfig(...).config.routes`
   */
  setRoutes(next) {
    routes = next;
    try {
      Services.prefs.setStringPref(CACHE_PREF, JSON.stringify(next));
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
   * The container a rule gives `url` (opened by `apps`), or null.
   * @param {string} url
   * @param {readonly string[]} [apps]
   * @returns {number | null}
   */
  userContextIdFor(url, apps = []) {
    return this.match(url, apps)?.workspace.userContextId ?? null;
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
    const hit = notAgent(this.match(url, apps, { external: true })?.workspace.userContextId);
    if (hit !== null || defaultWorkspace === null) return hit;
    const defs = WorkspaceStore.definitions.workspaces;
    const name = defaultWorkspaceFor(defaultWorkspace, {
      workspaces: defs.map((d) => d.name),
      skip: agentNames(),
    });
    return notAgent(defs.find((d) => d.name === name)?.userContextId);
  },

  /**
   * URILoadingHelper.openLinkIn, before it fills in a new window's container: sets
   * `params.userContextId` when a rule routes the load. Only a load the user or chrome started
   * (system principal, no container chosen): the URL bar, `:open`, bookmarks. Never one a page
   * triggered (a link click, middle- or ctrl-click, `target=_blank`, `window.open`): a page can
   * fake those with a synthetic click, and routing them would let a page in one workspace open
   * a URL of its choosing with another workspace's cookies (spec workspace-routing, decision
   * 3). Never a private or popup window. A `current` load routed elsewhere becomes a new tab
   * (openLinkIn's own rule); an untouched new tab it leaves behind is closed.
   * @param {any} win  the window the load starts from
   * @param {string} url  as given, maybe not yet fixed up (`example.com`)
   * @param {string} where
   * @param {any} params  openLinkIn's copy, changed in place
   * @param {any} target  the window it loads in, null for a new one
   * @returns {number | undefined} `params.userContextId` afterwards, for openLinkIn's own copy
   */
  routeLinkIn(win, url, where, params, target) {
    this._routeLinkIn(win, url, where, params, target);
    return params.userContextId;
  },

  /**
   * @param {any} win
   * @param {string} url
   * @param {string} where
   * @param {any} params
   * @param {any} target
   */
  _routeLinkIn(win, url, where, params, target) {
    try {
      if (!routes.length || params.private || unroutable(win)) return;
      if (target && unroutable(target)) return;
      if (!params.triggeringPrincipal?.isSystemPrincipal || params.userContextId != null) return;
      const ucid = this.userContextIdFor(fixup(url));
      if (ucid === null) return;
      if (where === "current" && target) {
        const browser = params.targetBrowser ?? target.gBrowser.selectedBrowser;
        if (browser.browsingContext?.originAttributes.userContextId === ucid) return;
        const tab = target.gBrowser.getTabForBrowser(browser);
        if (untouched(target, tab)) {
          target.setTimeout(() => {
            if (tab.isConnected && !tab.selected && untouched(target, tab)) {
              target.gBrowser.removeTab(tab);
            }
          }, 0);
        }
      }
      params.userContextId = ucid;
    } catch (e) {
      console.error("vimma: routing failed; the load goes on unrouted", e);
    }
  },

  /**
   * BrowserDOMWindow, for a link from another app: the container a rule gives it, else
   * `[routing] default_workspace`'s, else Firefox's guess (`guess`: unless `browser.link.force_default_user_context_id_for_external_opens`),
   * else the window's workspace's; never the agent workspace's (vimma-mcp decision 42), so a
   * login link clicked in a mail app is never readable by an agent. Null where the workspace
   * default is null (a private window, containers off): addTab then does as upstream.
   * @param {any} uri  nsIURI
   * @param {any} win  the window it opens in
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
   * @param {any} win
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
   * A new window's first tab (WorkspaceStore.firstTabUserContextId): the container a rule gives
   * the window's single URL argument, opened by the cold start's programs (`VIMMA_FROM`, read
   * once and cleared), or null. A window opened for another program's link (`fromExternal`)
   * routes as such a link does, `[routing] default_workspace` included; any other window by
   * rules alone, as what the user opens.
   * @param {any} win
   * @returns {number | null}
   */
  firstTab(win) {
    try {
      // A cold start's programs; else an external link opened as a window during its command line.
      const apps = this.takeStartupApps() ?? pendingApps;
      const first = coldStart;
      coldStart = false;
      if ((!routes.length && defaultWorkspace === null) || unroutable(win)) return null;
      const url = singleUrl(win.arguments?.[0]);
      if (!url) return null;
      WorkspaceStore.ensureLoaded();
      // At a cold start BrowserContentHandler passes the command line's URLs as an nsIArray,
      // without `fromExternal` (openBrowserWindow's list branch).
      const external =
        fromExternal(win.arguments?.[1]) || (first && win.arguments?.[0] instanceof Ci.nsIArray);
      if (external) return this.externalContainer(fixup(url), apps);
      return notAgent(this.userContextIdFor(fixup(url), apps));
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
 * @param {any} arg
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
 * @param {any} arg
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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:vimma (spec: docs/specs/m5-about-vimma.md): what Vimma is doing, for the user and for a
// bug report. Firefox's own about: pages are a C++ table (AboutRedirector.cpp); this one is
// registered at runtime as an nsIAboutModule factory, the way BrowserTestUtils.registerAboutPage
// does it, so it needs no upstream patch. The page is chrome://browser/content/vimma/about/
// about.html loaded under the about:vimma URL, in the parent process (no URI_*_IN_CHILD flag),
// with the system principal its chrome: channel carries; web content cannot link to it (no
// URI_SAFE_FOR_UNTRUSTED_CONTENT). `collect` gathers the data; the page only renders it.

import { bindingTable } from "../core/help.mjs";
import { compileKeymap } from "../core/keymap.mjs";
import { formatConfigError } from "../core/config.mjs";
import { leaves } from "../core/panes.mjs";
import { describeRoute } from "../core/routes.mjs";
import { redactReport } from "../core/report.mjs";
import { ConfigHost } from "../config/ConfigHost.sys.mjs";
import { ENABLED_PREF, VimmaControl } from "../ctl/VimmaControl.sys.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { ControlHost } from "../host/control-ops.mjs";
import { PrivateSwap } from "../host/private-swap.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { VimmaUpdates } from "../updates/VimmaUpdates.sys.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceRouter } from "../workspaces/WorkspaceRouter.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { KeyLog } from "./key-log.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export const ABOUT_URL = "about:vimma";
const PAGE_URL = "chrome://browser/content/vimma/about/about.html";
/** Generated at import by tools/version-files (patchManifest) and packaged by jar.mn. */
const PATCHES_URL = "chrome://browser/content/vimma/about/patches.json";
const CONTRACT = "@mozilla.org/network/protocol/about;1?what=vimma";

/**
 * @typedef {object} AboutData
 * @property {{ vimma: string, firefox: string, buildId: string, channel: string }} version
 * @property {{ patches: { path: string, hunks: number }[], hunks: number } | null} patches
 * @property {{ window: number, current: boolean, mode: string }[]} modes
 * @property {import("./key-log.mjs").KeyEvent[]} keys
 * @property {{ path: string, file: "pending" | "missing" | "read", schema: number | null,
 *   errors: string[] }} config
 * @property {{ name: string, group: string, bindings: string[], overridden: boolean }[]} bindings
 * @property {{ default: string | null, fromConfig: boolean, template: string | null,
 *   aliases: { alias: string, engine: string, unencrypted: boolean }[], errors: string[] }} search
 *   `[search]`; `template`: the alias whose template made the default engine
 *   (docs/specs/search-engines.md, decision 14)
 * @property {{ source: string, omarchy: boolean | null, polling: boolean, builtin: string,
 *   appearance: { value: string, from: "config" | "pref" | "default" }, path: string,
 *   state: string, mtime: number | null, lastError: string | null, warnings: string[],
 *   name: string | null }} theme
 *   name: the Omarchy theme's, or the built-in palette's when that is shown
 * @property {{ count: number, window: { name: string, active: boolean, tabs: number,
 *   panes: number }[] }} workspaces
 * @property {{ enabled: boolean, port: number | null, status: string }} control  `status`:
 *   full control's state with the minutes `:control on` left (docs/specs/vimma-mcp.md 29 D)
 * @property {{ enabled: boolean, from: "config" | "pref", workspace: string | null,
 *   adopted: boolean, tabs: number }} mcp  agents (docs/specs/vimma-mcp.md): the switch and the
 *   agent workspace, with its tab count; never its URLs or titles
 * @property {string} windowManager  Hyprland and the private placement (private-swap)
 * @property {{ on: { chord: string, id: string, label: string }[],
 *   off: { chord: string, id: string, command: string }[], unmatched: string[] }}
 *   firefoxKeys  Firefox's own shortcuts that are on and off (docs/specs/firefox-keys.md)
 * @property {RoutesData} routes
 * @property {Awaited<ReturnType<typeof VimmaUpdates.describe>>} updates  the last update check
 *   and how to update (docs/specs/m6a-updater.md)
 */

/**
 * The `[[routes]]` rules in force, and the one for the tab `:route` was typed in (by its uuid in
 * the page's `?tab=`): its host only, never its URL.
 * @typedef {object} RoutesData
 * @property {{ index: number, match: string, workspace: string, skipped: string | null }[]} rules
 * @property {{ host: string, workspace: string, rule: number | null, target: string | null }
 *   | null} tab
 */

/**
 * The agents section (docs/specs/vimma-mcp.md, decision 27): on or off and why, and the agent
 * workspace with its tab count.
 * @returns {AboutData["mcp"]}
 */
function mcpOf() {
  const agent = WorkspaceStore.agent;
  const ucid = agent?.userContextId ?? null;
  let tabs = 0;
  if (ucid !== null) {
    for (const w of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
      if (lazy.PrivateBrowsingUtils.isWindowPrivate(w)) continue;
      tabs += [...(w.gBrowser?.tabs ?? [])].filter((t) => t.userContextId === ucid).length;
    }
  }
  return {
    ...McpHost.state,
    workspace: agent?.name ?? null,
    adopted: !!agent && !WorkspaceStore.agentIsOurs(),
    tabs,
  };
}

/** An nsIAboutModule that is its own nsIFactory; XPCOM types are untyped here (types/). */
const aboutModule = /** @type {any} */ ({
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule", "nsIFactory"]),
  getURIFlags() {
    return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
  },
  getChromeURI() {
    return Services.io.newURI(PAGE_URL);
  },
  /** @param {unknown} uri @param {unknown} loadInfo */
  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(PAGE_URL),
      loadInfo,
    );
    channel.originalURI = uri;
    return channel;
  },
  /** @param {unknown} iid */
  createInstance(iid) {
    return aboutModule.QueryInterface(iid);
  },
});

let registered = false;

/** @param {string} url */
async function fetchJson(url) {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch {
    return null; // not packaged (an import without version-files): the page says so
  }
}

/**
 * The theme directory's sibling `theme.name` (omarchy-theme-set writes it), or null.
 * @param {string} dir
 */
async function omarchyThemeName(dir) {
  try {
    return (await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(dir) ?? dir, "theme.name")))
      .trim()
      .slice(0, 80);
  } catch {
    return null;
  }
}

/**
 * The rules, and the match for the tab with uuid `tabId` in `win` (spec workspace-routing).
 * @param {Window} win
 * @param {string | null} tabId
 * @returns {RoutesData}
 */
function routesOf(win, tabId) {
  const names = WorkspaceStore.definitions.workspaces.map((d) => d.name);
  const rules = WorkspaceRouter.routes.map((r) => ({
    index: r.index,
    match: describeRoute(r),
    workspace: r.workspace,
    skipped: names.includes(r.workspace) ? null : "no such workspace",
  }));
  const ww = WindowWorkspaces.get(win);
  const tab = tabId && ww?.model ? /** @type {any} */ (ww.tabOf(tabId)) : null;
  if (!tab) return { rules, tab: null };
  const uri = tab.linkedBrowser.currentURI;
  /** @type {string} */
  let host;
  try {
    host = uri.host;
  } catch {
    host = uri.scheme;
  }
  const hit = WorkspaceRouter.match(uri.spec, null);
  const inWs = WorkspaceStore.definitions.workspaces.find(
    (d) => d.userContextId === tab.userContextId,
  );
  return {
    rules,
    tab: {
      host,
      workspace: inWs?.name ?? "no workspace's container",
      rule: hit?.route.index ?? null,
      target: hit?.workspace.name ?? null,
    },
  };
}

/**
 * The workspaces of `win`: each one's name, tab count and pane count.
 * @param {Window} win
 */
function workspacesOf(win) {
  const model = WindowWorkspaces.get(win)?.model;
  if (!model) return [];
  const view = PaneViews.get(win);
  return model.workspaces.map((w) => {
    const active = w.id === model.active;
    const panes = active ? (view?.panes ?? null) : (view?.parked(w.id) ?? null);
    return {
      name: w.name,
      active,
      tabs: w.tabs.length,
      panes: panes ? leaves(panes).length : 1,
    };
  });
}

/**
 * The report's update line: on or off, the install type, the last result; no URL or path.
 * @param {AboutData["updates"]} u
 */
function updatesLine(u) {
  const when = u.checkedAt ? new Date(u.checkedAt).toISOString() : "never";
  const result = u.offer
    ? `offer ${u.offer.line}${u.offer.urgent ? " (security)" : ""}`
    : u.outcome;
  return (
    `${u.enabled ? "on" : `off (${u.from})`}, ${u.installType}, channel ${u.channel}, ` +
    `last check ${when}: ${result}${u.reason ? ` (${u.reason})` : ""}`
  );
}

export const AboutVimma = {
  /** Once per process (vimma.js): about:vimma resolves from then on. */
  register() {
    if (registered) return;
    registered = true;
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    if (registrar.isContractIDRegistered(CONTRACT)) return;
    registrar.registerFactory(
      Components.ID(Services.uuid.generateUUID().toString()),
      "about:vimma",
      CONTRACT,
      aboutModule,
    );
  },

  /**
   * Everything the page shows, read now. Never the control token, page URLs or titles.
   * @param {Window} win  the browser window the page is in (its workspaces are listed)
   * @param {{ tab?: string | null }} [options]  `tab`: the uuid `:route` passes (routing)
   * @returns {Promise<AboutData>}
   */
  async collect(win, { tab = null } = {}) {
    const app = lazy.AppConstants;
    const keymap = ConfigHost.keymap ?? compileKeymap();
    const configPath = ConfigHost.path;
    const theme = ThemeHost.status;
    // A normal window's page lists no private window (private-workspace decision 8b).
    const windows = /** @type {Window[]} */ (lazy.BrowserWindowTracker.orderedWindows).filter(
      (w) => w === win || !lazy.PrivateBrowsingUtils.isWindowPrivate(w),
    );
    return {
      version: {
        vimma: app.MOZ_APP_VERSION_DISPLAY,
        firefox: Services.appinfo.version,
        buildId: Services.appinfo.appBuildID,
        channel: app.MOZ_UPDATE_CHANNEL,
      },
      updates: await VimmaUpdates.describe(),
      patches: await fetchJson(PATCHES_URL),
      modes: windows.map((w, i) => ({
        window: i + 1,
        current: w === win,
        mode: VimmaHost.status(w).mode,
      })),
      keys: KeyLog.entries(),
      config: {
        path: configPath,
        file: ConfigHost.file,
        schema: ConfigHost.config?.schema ?? null,
        errors: ConfigHost.errors.map((e) => formatConfigError(e, ConfigHost.errorsPath)),
      },
      search: {
        ...SearchHost.status,
        errors: SearchHost.errors.map((e) => formatConfigError(e, ConfigHost.errorsPath)),
      },
      bindings: bindingTable(keymap).map((r) => ({
        name: r.name,
        group: r.group,
        bindings: r.bindings,
        overridden: r.overridden,
      })),
      theme: {
        ...theme,
        name:
          theme.source === "omarchy" && theme.state !== "missing"
            ? await omarchyThemeName(theme.path)
            : `${theme.builtin} (built in)`,
      },
      workspaces: {
        count: WorkspaceStore.definitions.workspaces.length,
        window: workspacesOf(win),
      },
      control: {
        enabled: Services.prefs.getBoolPref(ENABLED_PREF, false),
        port: VimmaControl.port,
        status: ControlHost.status(),
      },
      mcp: mcpOf(),
      routes: routesOf(win, tab),
      firefoxKeys: VimmaHost.firefoxKeys(win),
      windowManager: PrivateSwap.status,
    };
  },

  /**
   * The plain-text report `:bug` copies: everything but the binding table's defaults, with URLs
   * and paths under $HOME redacted.
   * @param {AboutData} data
   * @returns {string}
   */
  report(data) {
    const v = data.version;
    const lines = [
      "about:vimma report",
      `Vimma ${v.vimma} (Firefox ${v.firefox}, build ${v.buildId}, channel ${v.channel})`,
      `Updates: ${updatesLine(data.updates)}`,
      `Upstream patches: ${data.patches ? `${data.patches.patches.length} (${data.patches.hunks} hunks)` : "unknown"}`,
      ...(data.patches?.patches ?? []).map((p) => `  ${p.path} (${p.hunks})`),
      `Modes: ${data.modes.map((m) => `window ${m.window} ${m.mode}`).join(", ")}`,
      `Last keys: ${data.keys.map((k) => `${k.key}→${k.outcome}`).join(" ") || "none"}`,
      `Config: ${data.config.path} (${data.config.file}, schema ${data.config.schema ?? "-"})`,
      ...data.config.errors.map((e) => `  error: ${e}`),
      `Overrides: ${
        data.bindings
          .filter((b) => b.overridden)
          .map((b) => `${b.name}=${b.bindings.join("|") || "(unbound)"}`)
          .join(", ") || "none"
      }`,
      // Engine names only: a template's host can name the user's employer, and an engine Vimma
      // made from one is named after it.
      `Search: default ${
        data.search.template === null
          ? (data.search.default ?? "-")
          : `a config.toml template (@${data.search.template})`
      }` +
        `${data.search.fromConfig ? " (config.toml)" : ""}, ${data.search.aliases.length} aliases`,
      ...data.search.errors.map((e) => `  error: ${e}`),
      `Theme: ${data.theme.source}, ${data.theme.state}, ${data.theme.path}` +
        (data.theme.name ? `, ${data.theme.name}` : ""),
      ...(data.theme.lastError ? [`  error: ${data.theme.lastError}`] : []),
      ...data.theme.warnings.map((w) => `  warning: ${w}`),
      `Workspaces: ${data.workspaces.count}; this window: ${
        data.workspaces.window.map((w) => `${w.name} ${w.tabs}t/${w.panes}p`).join(", ") || "none"
      }`,
      // Only counts: a rule's domain can name the user's employer.
      `Routes: ${data.routes.rules.length}` +
        ` (${data.routes.rules.filter((r) => r.skipped).length} skipped)`,
      `Control socket: ${data.control.enabled ? `enabled, port ${data.control.port ?? "-"}` : "off"}`,
      `Agents (MCP): ${data.mcp.enabled ? "on" : "off"} (${data.mcp.from}), workspace ` +
        `${data.mcp.workspace ?? "none"}${data.mcp.adopted ? " (adopted)" : ""}, ${data.mcp.tabs}t`,
      `Window manager: ${data.windowManager}`,
      `Firefox shortcuts on: ${data.firefoxKeys.on.map((k) => k.chord).join(" ") || "none"}`,
    ];
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    return redactReport(`${lines.join("\n")}\n`, home);
  },
};

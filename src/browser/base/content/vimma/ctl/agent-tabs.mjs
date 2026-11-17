/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What an agent can reach (docs/specs/vimma-mcp.md, decision 7): the tabs of the agent workspace
// **and** of its container, in a normal window (private windows have no workspaces and are never
// enumerated), and of those only the ones its connection may see (docs/specs/builtin-agent.md
// B17). Also the check after the user's yes that the tab and URL are still the ones asked about
// (decision 19). Nothing here asks the user: agent-commands.mjs asks through AgentGate first and
// calls these before and after. It is its one importer (RESTRICTED in tools/layering/layers.ts).

import { isBuiltinConn } from "../core/agent.mjs";
import { agentTabTitle } from "../core/agent-keys.mjs";
import { workspaceOfTab } from "../core/workspaces.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { AgentError, denied } from "./agent-errors.mjs";

/** @import { ConnId } from "../core/agent.mjs" */

/** @typedef {"PrivateBrowsingUtils" | "SessionStore"} LazyName */
const lazy = /** @type {Lazy<LazyName>} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

/**
 * @typedef {BrowserWindow} Win
 * @typedef {MozTabbrowserTab} Tab
 * @typedef {{ id: string, name: string, userContextId: number }} AgentWorkspace
 */

/**
 * Which built-in conversation owns which agent tab (docs/specs/builtin-agent.md B17, Behaviour
 * 30), by the tab element: unloading a tab gives its browser a new id but keeps the element, and
 * a tab moved between workspaces is reopened as a new element, which belongs to none. In memory
 * only: after a restart no tab is owned.
 * @type {WeakMap<Tab, ConnId>}
 */
const owners = new WeakMap();
/** @type {Map<ConnId, Set<WeakRef<Tab>>>} each conversation's tabs, to let them go with it */
const ownedBy = new Map();

/** @param {Tab} tab @param {ConnId} conn */
export function own(tab, conn) {
  owners.set(tab, conn);
  let set = ownedBy.get(conn);
  if (!set) ownedBy.set(conn, (set = new Set()));
  set.add(new WeakRef(tab));
}

/**
 * The conversation `tab` belongs to, or null. A tab a page or the user opened from an owned tab
 * (its `openerTab`, set by tabbrowser's addTab), or from a tab opened so, belongs to that
 * conversation, even when the opener has closed since: the element and its owner stay known.
 * @param {Tab} tab
 * @returns {ConnId | null}
 */
export function ownerOf(tab) {
  /** @type {Set<Tab>} */
  const seen = new Set();
  for (let t = /** @type {Tab | null | undefined} */ (tab); t && !seen.has(t); t = t.openerTab) {
    seen.add(t);
    const conn = owners.get(t);
    if (conn !== undefined) {
      if (t !== tab) own(tab, conn);
      return conn;
    }
  }
  return null;
}

/**
 * Whether connection `conn` may see `tab`: a conversation only its own tabs, an MCP connection
 * only those no conversation owns (B17).
 * @param {Tab} tab @param {ConnId} conn
 */
const visibleTo = (tab, conn) => ownerOf(tab) === (isBuiltinConn(conn) ? conn : null);

/** The agent workspace, or a refusal when there is none (containers off). */
export function agentWorkspace() {
  const w = WorkspaceStore.agent;
  if (!w || w.userContextId === null || w.userContextId === undefined) {
    throw new AgentError("failed", "there is no agent workspace in Vimma (containers off?)");
  }
  return /** @type {AgentWorkspace} */ (/** @type {unknown} */ (w));
}

/** Normal browser windows: never a private one (decision 7). */
export function normalWindows() {
  /** @type {Win[]} */
  const out = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.closed || !win.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) continue;
    out.push(win);
  }
  return out;
}

/**
 * Whether `tab` belongs to the agent: its container is the agent workspace's, and its window's
 * model has it in that workspace, not adopted there as a foreign tab (decision 7); and it is
 * one connection `conn` may see (B17).
 * @param {Win} win @param {Tab} tab @param {AgentWorkspace} agent @param {ConnId} conn
 */
export function isAgentTab(win, tab, agent, conn) {
  if (tab.closing || tab.pinned || tab.userContextId !== agent.userContextId) return false;
  const ww = WindowWorkspaces.get(win);
  const model = ww?.model;
  if (!ww || !model || ww.isForeign(tab)) return false;
  if (workspaceOfTab(model, ww.idOf(tab))?.id !== agent.id) return false;
  return visibleTo(tab, conn);
}

/**
 * The agent's tabs, in window and strip order. With `name`, after the user's yes to the list, a
 * lazy one (restored, or unloaded under memory pressure) gets its browser, which gives it the
 * id agents name it by; its page loads only when it is read (spec B2). Without, nothing is
 * touched: a lazy tab has no id yet, so no agent can name it.
 * @param {AgentWorkspace} agent @param {ConnId} conn @param {boolean} [name]
 * @returns {{ win: Win, tab: Tab }[]}
 */
export function agentTabs(agent, conn, name = false) {
  return normalWindows().flatMap((win) =>
    win.gBrowser.tabs
      .filter((/** @type {Tab} */ t) => isAgentTab(win, t, agent, conn))
      .flatMap((/** @type {Tab} */ tab) => {
        if (name && !tab.linkedPanel) win.gBrowser.insertBrowser(tab);
        return [{ win, tab }];
      }),
  );
}

/** @param {Tab} tab */
export const tabId = (tab) => String(tab.linkedBrowser.browserId);
/**
 * The tab's URL. A tab not loaded yet (lazy, or restored and pending) shows about:blank in its
 * browser: its URL is in its session history, as SessionStore keeps it.
 * @param {Tab} tab
 */
export function tabUrl(tab) {
  const uri = String(tab.linkedBrowser.currentURI?.spec ?? "about:blank");
  if (uri !== "about:blank" || (tab.linkedPanel && !tab.hasAttribute("pending"))) return uri;
  try {
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    const entries = Array.isArray(state?.entries) ? state.entries : [];
    const entry = entries[(Number(state.index) || entries.length) - 1];
    if (typeof entry?.url === "string" && entry.url) return entry.url;
  } catch {
    // no session for it: what the browser says
  }
  return uri;
}

/**
 * The tab's title as the agent may see it (security.md M21, #1209): core's agentTabTitle, with
 * the URL the tab is at and the URL it is loading.
 * @param {Tab} tab
 */
export function tabTitle(tab) {
  const b = tab.linkedBrowser;
  return agentTabTitle(tab.label, tab.labelIsContentTitle, tabUrl(tab), b?.userTypedValue);
}

/**
 * The agent tab with id `id`, or invalid-args: a tab of any other workspace, container or
 * window is unknown to the agent (decision 7), and so is another conversation's tab, in the same
 * words, so that no connection learns which tabs the others have (B17). Nothing is asked.
 * @param {AgentWorkspace} agent @param {string} id @param {ConnId} conn
 */
export function findAgentTab(agent, id, conn) {
  const all = agentTabs(agent, conn);
  const index = all.findIndex(({ tab }) => tabId(tab) === id);
  const found = all[index];
  if (!found) {
    throw new AgentError("invalid-args", `tab ${id} is not a tab of the agent workspace`);
  }
  return { ...found, index: index + 1 };
}

/** @param {Tab} tab */
export function describeTab(tab) {
  return { tab: tabId(tab), title: String(tab.label ?? ""), url: tabUrl(tab) };
}

/**
 * The URL an agent may load: http or https, checked on what the URL parser made of the text too
 * (the validator checked the text).
 * @param {string} url
 */
export function agentUri(url) {
  /** @type {nsIURI} */
  let uri;
  try {
    uri = Services.io.newURI(url);
  } catch {
    throw new AgentError("invalid-args", "url is not a valid URL");
  }
  if (uri.scheme !== "http" && uri.scheme !== "https") {
    throw new AgentError("invalid-args", "url scheme must be http or https");
  }
  return uri;
}

/** A principal for loads an agent asks for: no authority, in the agent's container. */
export function agentPrincipal(/** @type {number} */ userContextId) {
  return Services.scriptSecurityManager.createNullPrincipal({ userContextId });
}

/**
 * The site of the page in `tab`, its registrable domain, or its host when it has none
 * (mcp-drive D18): what an allowance of `a` is for (docs/specs/mcp-consequence.md K5).
 * @param {Tab} tab
 */
export function siteOfTab(tab) {
  const uri = tab.linkedBrowser.currentURI;
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    try {
      return String(uri?.asciiHost ?? "");
    } catch {
      return "";
    }
  }
}

/**
 * After the yes: the tab must still be the agent's with the URL asked about (decision 19).
 * @param {AgentWorkspace} asked @param {string} id @param {string} url @param {ConnId} conn
 */
export function stillAsAsked(asked, id, url, conn) {
  const agent = WorkspaceStore.agent;
  if (!agent || agent.id !== asked.id || agent.userContextId !== asked.userContextId) {
    throw denied("changed");
  }
  let found;
  try {
    found = findAgentTab(asked, id, conn);
  } catch {
    throw denied("changed");
  }
  if (tabUrl(found.tab) !== url) throw denied("changed");
  return found;
}

/**
 * A deleted conversation's tabs go back to no one (B17).
 * @param {ConnId} conn
 */
export function forgetOwners(conn) {
  for (const ref of ownedBy.get(conn) ?? []) {
    const tab = ref.deref();
    if (tab && owners.get(tab) === conn) owners.delete(tab);
  }
  ownedBy.delete(conn);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An agent's read of a tab's script errors and failed requests (docs/specs/mcp-forms.md F22-F24;
// security.md M30, M31). Read-only by construction: nothing here evaluates code, starts the
// DevTools server, the Remote Agent or Marionette, or reads a page object's properties.
// - Script errors and the page's console.error and console.warn calls come from Firefox's own
//   caches, which keep them whether or not anyone asks: each frame's child reads its process's
//   nsIConsoleService and ConsoleAPIStorage by its document's inner window id, and the parent
//   reads its own nsIConsoleService by the same ids, for what Firefox logs in the parent.
// - Failed requests (HTTP status 400 and above, or a channel error) of the agent workspace's tabs
//   are logged by an http-on-stop-request observer, the last AGENT_CONSOLE.log per tab, in memory
//   while MCP is on; a tab's log goes when the tab closes, and every log goes when MCP turns off.
// agent-commands.mjs asked first and checks the tab again afterwards.

import {
  AGENT_CONSOLE,
  consoleLists,
  parseConsoleEntry,
  requestFailure,
  scriptErrorLevel,
  scriptErrorSource,
} from "../core/agent-act.mjs";
import { cutTo } from "../core/agent-keys.mjs";
import { wrapUntrusted } from "../core/agent.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { MCP_CHANGED_TOPIC, MCP_ENABLED_PREF, McpHost } from "../host/mcp-ops.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/** @import { ConsoleEntry, RequestEntry } from "../core/agent-act.mjs" */

/** How long the frames may take to answer: a hung page must not hold the read. */
const FRAME_TIMEOUT_MS = 5000;
/** The most entries taken from one frame's answer; the reply keeps far fewer. */
const FRAME_ENTRIES_MAX = 2000;

/** Each agent tab's failed requests, by its browser id, oldest first. @type {Map<number, RequestEntry[]>} */
const logs = new Map();

let initialised = false;

/** @param {number | null | undefined} userContextId */
function isAgentContainer(userContextId) {
  const agent = WorkspaceStore.agent?.userContextId;
  return typeof agent === "number" && agent > 0 && userContextId === agent;
}

/**
 * nsIContentPolicy's external types by number, as words (`fetch`, `image`, `document`). By name:
 * the interface's constants are not enumerable from a module.
 */
const TYPES = (() => {
  const words = [
    "OTHER",
    "SCRIPT",
    "IMAGE",
    "STYLESHEET",
    "OBJECT",
    "DOCUMENT",
    "SUBDOCUMENT",
    "PING",
    "XMLHTTPREQUEST",
    "OBJECT_SUBREQUEST",
    "DTD",
    "FONT",
    "MEDIA",
    "WEBSOCKET",
    "CSP_REPORT",
    "XSLT",
    "BEACON",
    "FETCH",
    "IMAGESET",
    "WEB_MANIFEST",
    "SAVEAS_DOWNLOAD",
    "SPECULATIVE",
    "UA_FONT",
    "PROXIED_WEBRTC_MEDIA",
    "WEB_IDENTITY",
    "WEB_TRANSPORT",
    "JSON",
  ];
  /** @type {Map<number, string>} */
  const names = new Map();
  for (const word of words) {
    const value = /** @type {any} */ (Ci.nsIContentPolicy)[`TYPE_${word}`];
    if (typeof value === "number") names.set(value, word.toLowerCase());
  }
  return names;
})();

/** @param {any} subject  an nsIHttpChannel, stopped */
function onStopRequest(subject) {
  if (!McpHost.state.enabled) return;
  /** @type {any} */
  let channel;
  try {
    channel = subject.QueryInterface(Ci.nsIHttpChannel);
  } catch {
    return;
  }
  const loadInfo = channel.loadInfo;
  if (!isAgentContainer(loadInfo?.originAttributes?.userContextId)) return;
  const browserId = loadInfo.browsingContext?.top?.browserId;
  if (!browserId) return;
  let status = 0;
  try {
    status = channel.responseStatus;
  } catch {
    // no response: the channel's status says why
  }
  const code = channel.status;
  const error = Components.isSuccessCode(code) ? null : ChromeUtils.getXPCOMErrorName(code);
  const failed = requestFailure(status, error);
  if (!failed) return;
  /** @type {any} */
  let uri = channel.URI;
  try {
    // Without a user name and password a URL may carry.
    uri = Services.io.createExposableURI(uri);
  } catch {
    // keep the channel's
  }
  const entry = {
    method: String(channel.requestMethod),
    url: cutTo(String(uri.spec), AGENT_CONSOLE.url),
    ...failed,
    type: TYPES.get(loadInfo.externalContentPolicyType) ?? "other",
    time: Date.now(),
  };
  let log = logs.get(browserId);
  if (!log) {
    log = [];
    logs.set(browserId, log);
  }
  log.push(entry);
  if (log.length > AGENT_CONSOLE.log) log.splice(0, log.length - AGENT_CONSOLE.log);
}

/** Drops the log of every tab that is gone or no longer in the agent workspace's container. */
function prune() {
  for (const id of logs.keys()) {
    const top = BrowsingContext.getCurrentTopByBrowserId(id);
    if (!top || !isAgentContainer(top.originAttributes?.userContextId)) logs.delete(id);
  }
}

/** @param {any} subject @param {string} topic */
function observe(subject, topic) {
  if (topic === "http-on-stop-request") onStopRequest(subject);
  else if (topic === "browsing-context-discarded") {
    // A tab that closes discards its top context; a process switch replaces it under the same
    // browser id, which then still has a current one.
    if (!subject?.parent && logs.has(subject?.browserId)) Promise.resolve().then(prune);
  } else if (!McpHost.state.enabled) logs.clear();
}

/**
 * The script errors of every frame of `browser`'s page: each frame's child answers for its own
 * document, and the parent's console service adds what Firefox logged there for those documents.
 * A frame that has no actor, fails or does not answer in time adds nothing.
 * @param {any} browser
 * @returns {Promise<ConsoleEntry[]>}
 */
async function pageErrors(browser) {
  const frames = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
  const ids = new Set(
    frames.map((/** @type {any} */ bc) => bc.currentWindowGlobal?.innerWindowId).filter(Boolean),
  );
  /** @type {ConsoleEntry[]} */
  const out = [];
  for (const raw of await VimmaActors.agentConsole(browser, FRAME_TIMEOUT_MS)) {
    for (const item of raw.slice(0, FRAME_ENTRIES_MAX)) {
      const entry = parseConsoleEntry(item);
      if (entry) out.push(entry);
    }
  }
  for (const m of Services.console.getMessageArray() ?? []) {
    if (!(m instanceof Ci.nsIScriptError) || !ids.has(m.innerWindowID)) continue;
    const level = scriptErrorLevel(m.flags);
    if (!level) continue;
    const entry = parseConsoleEntry({
      level,
      source: scriptErrorSource(m.category),
      message: cutTo(String(m.errorMessage), AGENT_CONSOLE.message),
      file: cutTo(String(m.sourceName), AGENT_CONSOLE.url),
      line: m.lineNumber,
      column: m.columnNumber,
      time: m.timeStamp,
    });
    if (entry) out.push(entry);
  }
  // A message both a child and the parent hold is listed once.
  const seen = new Set();
  return out.filter((e) => {
    const key = JSON.stringify(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `s` as well-formed Unicode: a lone surrogate becomes U+FFFD, so the reply is one line
 * vimma-ctl's strict parser accepts (security.md M7).
 * @param {string} s
 */
const wf = (s) => /** @type {string} */ (/** @type {any} */ (s).toWellFormed());

export const AgentConsole = {
  /** Once per app (vimma.js): the observers stay for the session. */
  init() {
    if (initialised) return;
    initialised = true;
    Services.obs.addObserver(observe, "http-on-stop-request");
    Services.obs.addObserver(observe, "browsing-context-discarded");
    Services.obs.addObserver(observe, MCP_CHANGED_TOPIC);
    Services.prefs.addObserver(MCP_ENABLED_PREF, observe);
  },

  /**
   * The errors and failed requests of the agent tab `browser` after `since` (F22, F24): Vimma's
   * clock at the read, each list wrapped in the untrusted-content delimiters, and how many
   * entries were left out.
   * @param {any} browser @param {number} since
   */
  async read(browser, since) {
    const time = Date.now();
    const errors = await pageErrors(browser);
    prune();
    const requests = logs.get(browser.browserId) ?? [];
    const lists = consoleLists(errors, requests, since, AGENT_CONSOLE.bytes);
    return {
      time,
      errors: wrapUntrusted(wf(lists.errors)),
      requests: wrapUntrusted(wf(lists.requests)),
      dropped: lists.dropped,
    };
  },

  /** Test-only: the failed requests logged for a tab. @param {number} browserId */
  _requestsForTests(browserId) {
    return [...(logs.get(browserId) ?? [])];
  },

  /** Test-only: the tabs that have a log. */
  _tabsForTests() {
    return [...logs.keys()];
  },
};

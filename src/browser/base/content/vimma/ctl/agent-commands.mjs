/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent role's commands (docs/specs/vimma-mcp.md, decision 4): list, read, open and close
// tabs of the agent workspace, run Vimma's own page keys in one, following its links by label
// (docs/specs/mcp-drive.md, `agent-keys`), show one to the user (`agent-show`), and list one's
// buttons, fields and links with labels (docs/specs/mcp-forms.md, `agent-elements`), click one
// by its label (`agent-activate`), fill fields by their labels (`agent-fill`), take a screenshot
// of one (`agent-screenshot`), and nothing else. What an agent can reach is decided here, in
// the browser, when each command runs (decision 7): a tab of the agent workspace **and** of its
// container, in a normal window (private windows have no workspaces and are never enumerated).
// Every command but hello and ping asks through AgentGate first (decision 12), and after the
// yes the tab and URL must still be the ones asked about, or nothing happens (decision 19).

import {
  ACT_RATE,
  AGENT_TOOLS,
  CallRate,
  ELEMENTS_RATE,
  KEYS_RATE,
  OpenRate,
  SCREENSHOT_RATE,
  SHOW_RATE,
  wrapUntrusted,
} from "../core/agent.mjs";
import { actDetail, fillDetail } from "../core/agent-act.mjs";
import { parseAgentKeys, shownKeys } from "../core/agent-keys.mjs";
import { fillFits, shownNotice } from "../core/agent-prompt.mjs";
import { MAX_LINE_LENGTH, MAX_READ_CHARS } from "../core/control.mjs";
import { ELEMENT_REPLY_CAPS } from "../core/agent-element.mjs";
import { workspaceOfTab } from "../core/workspaces.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { AgentUi } from "../host/agent-ui.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { AgentAct } from "./AgentAct.sys.mjs";
import { AgentDownloads } from "./AgentDownloads.sys.mjs";
import { AgentDrive } from "./AgentDrive.sys.mjs";
import { AgentGate } from "./AgentGate.sys.mjs";
import { AgentShot } from "./AgentShot.sys.mjs";

/** @import { ConnId } from "../core/agent.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long a read waits for a page (a lazy tab's first load) before it gives up. */
const LOAD_TIMEOUT_MS = 20000;
/** How long the extractor may take on a loaded page: a hostile page must not hold a read. */
const EXTRACT_TIMEOUT_MS = 30000;
/** Room in the 1 MiB reply line for everything but the text (protocol, decision 4). */
const REPLY_OVERHEAD = 64 * 1024;
const DEFAULT_MAX_READ = 200000;
/** Each connection's opens: at most OPEN_RATE a minute, asked or under a grant. */
const opens = new OpenRate();
/** Each connection's `agent-keys`: at most KEYS_RATE a minute, counted when asked (D15). */
const keyCalls = new CallRate(KEYS_RATE);
/** Each connection's `agent-show`: at most SHOW_RATE a minute, counted when asked (D7). */
const showCalls = new CallRate(SHOW_RATE);
/** Each connection's `agent-elements`: at most ELEMENTS_RATE a minute, counted when asked (F26). */
const elementCalls = new CallRate(ELEMENTS_RATE);
/**
 * Each connection's `agent-activate` and `agent-fill`: at most ACT_RATE a minute together,
 * counted when asked (F26).
 */
const actCalls = new CallRate(ACT_RATE);
/** Each connection's `agent-screenshot`: at most SCREENSHOT_RATE a minute, counted when asked (F21). */
const shotCalls = new CallRate(SCREENSHOT_RATE);
/** The longest URL and title an `agent-elements` reply carries, in code points. */
const ELEMENTS_URL_MAX = 8192;
const ELEMENTS_TITLE_MAX = 1024;
/** The longest an `agent-keys` call runs after the yes (mcp-drive D15). */
const KEYS_CALL_MS = 60000;

/** A refusal with a protocol error code (and, for `denied`, its reason). */
export class AgentError extends Error {
  /** @param {string} code @param {string} message @param {string} [reason] */
  constructor(code, message, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/** The denial texts, by reason (decision 4); the MCP layer words them for the model. */
const DENIED = /** @type {Record<string, string>} */ ({
  user: "the user denied this request in Vimma",
  timeout: "no answer in Vimma in time; treated as denied",
  busy: "too many agent requests are waiting in Vimma; try again later",
  muted: "this agent connection is muted in Vimma after repeated denials",
  changed: "the tab changed after the user was asked; nothing was done",
  cancelled: "the request was cancelled",
  "in-use": "the user is using this tab in Vimma; nothing was done",
});

/** @param {string} reason */
const denied = (reason) => new AgentError("denied", DENIED[reason] ?? reason, reason);

/**
 * @typedef {any} Win
 * @typedef {any} Tab
 * @typedef {{ id: string, name: string, userContextId: number }} AgentWorkspace
 * @typedef {{ agent?: { client: string, via?: string }, cancels?: Map<number, () => void> }} AgentConn
 */

/** The agent workspace, or a refusal when there is none (containers off). */
function agentWorkspace() {
  const w = WorkspaceStore.agent;
  if (!w || w.userContextId === null || w.userContextId === undefined) {
    throw new AgentError("failed", "there is no agent workspace in Vimma (containers off?)");
  }
  return /** @type {AgentWorkspace} */ (/** @type {unknown} */ (w));
}

/** Normal browser windows: never a private one (decision 7). */
function normalWindows() {
  /** @type {Win[]} */
  const out = [];
  for (const win of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
    if (win.closed || !win.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) continue;
    out.push(win);
  }
  return out;
}

/**
 * Whether `tab` belongs to the agent: its container is the agent workspace's, and its window's
 * model has it in that workspace, not adopted there as a foreign tab (decision 7).
 * @param {Win} win @param {Tab} tab @param {AgentWorkspace} agent
 */
function isAgentTab(win, tab, agent) {
  if (tab.closing || tab.pinned || tab.userContextId !== agent.userContextId) return false;
  const ww = WindowWorkspaces.get(win);
  const model = ww?.model;
  if (!ww || !model || ww.isForeign(tab)) return false;
  return workspaceOfTab(model, ww.idOf(tab))?.id === agent.id;
}

/**
 * The agent's tabs, in window and strip order. With `name`, after the user's yes to the list, a
 * lazy one (restored, or unloaded under memory pressure) gets its browser, which gives it the
 * id agents name it by; its page loads only when it is read (spec B2). Without, nothing is
 * touched: a lazy tab has no id yet, so no agent can name it.
 * @param {AgentWorkspace} agent @param {boolean} [name]
 * @returns {{ win: Win, tab: Tab }[]}
 */
function agentTabs(agent, name = false) {
  return normalWindows().flatMap((win) =>
    win.gBrowser.tabs
      .filter((/** @type {Tab} */ t) => isAgentTab(win, t, agent))
      .map((/** @type {Tab} */ tab) => {
        if (name && !tab.linkedPanel) win.gBrowser.insertBrowser(tab);
        return { win, tab };
      }),
  );
}

/** @param {Tab} tab */
const tabId = (tab) => String(tab.linkedBrowser.browserId);
/**
 * The tab's URL. A tab not loaded yet (lazy, or restored and pending) shows about:blank in its
 * browser: its URL is in its session history, as SessionStore keeps it.
 * @param {Tab} tab
 */
function tabUrl(tab) {
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
 * The agent tab with id `id`, or invalid-args: a tab of any other workspace, container or
 * window is unknown to the agent (decision 7), and nothing is asked.
 * @param {AgentWorkspace} agent @param {string} id
 */
function findAgentTab(agent, id) {
  const all = agentTabs(agent);
  const index = all.findIndex(({ tab }) => tabId(tab) === id);
  if (index === -1) {
    throw new AgentError("invalid-args", `tab ${id} is not a tab of the agent workspace`);
  }
  return { ...all[index], index: index + 1 };
}

/** @param {Tab} tab */
function describeTab(tab) {
  return { tab: tabId(tab), title: String(tab.label ?? ""), url: tabUrl(tab) };
}

/**
 * The URL an agent may load: http or https, checked on what the URL parser made of the text too
 * (the validator checked the text).
 * @param {string} url
 */
function agentUri(url) {
  /** @type {any} */
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
function agentPrincipal(/** @type {number} */ userContextId) {
  return /** @type {any} */ (Services.scriptSecurityManager).createNullPrincipal({ userContextId });
}

/**
 * Ask, and wait: resolves when allowed, throws `denied` otherwise. While the question waits,
 * `agent-cancel` with the request's id `rid` can withdraw it (decision 17: MCP's
 * notifications/cancelled); the connection's `state.cancels` keeps the way to, until answered.
 * With `until`, the question is withdrawn then (a step of a call that must end by then);
 * `always`: asked even under a grant, and never granted (mcp-drive D4).
 * @param {ConnId} conn @param {string} command @param {object} what
 * @param {AgentConn} state @param {number | undefined} rid @param {number} [until]
 * @param {boolean} [always]
 */
async function ask(conn, command, what, state, rid, until, always = false) {
  const tool = /** @type {Record<string, string>} */ (AGENT_TOOLS)[command];
  /** @type {any} */
  let timer = null;
  const onCancel = (/** @type {() => void} */ cancel) => {
    if (rid !== undefined) (state.cancels ??= new Map()).set(rid, cancel);
    if (until !== undefined) timer = lazy.setTimeout(cancel, Math.max(0, until - Date.now()));
  };
  try {
    const outcome = await AgentGate.request(conn, /** @type {string} */ (tool), what, {
      always,
      onCancel,
    });
    if (!outcome.allow) throw denied(outcome.reason);
    return outcome;
  } finally {
    if (rid !== undefined) state.cancels?.delete(rid);
    if (timer !== null) lazy.clearTimeout(timer);
  }
}

/**
 * After the yes: the tab must still be the agent's with the URL asked about (decision 19).
 * @param {AgentWorkspace} asked @param {string} id @param {string} url
 */
function stillAsAsked(asked, id, url) {
  const agent = WorkspaceStore.agent;
  if (!agent || agent.id !== asked.id || agent.userContextId !== asked.userContextId) {
    throw denied("changed");
  }
  let found;
  try {
    found = findAgentTab(asked, id);
  } catch {
    throw denied("changed");
  }
  if (tabUrl(found.tab) !== url) throw denied("changed");
  return found;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => lazy.setTimeout(resolve, ms));

/**
 * `promise`, or a `failed` refusal after `ms`.
 * @template T
 * @param {number} ms @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function within(ms, promise) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new AgentError("failed", "reading the page took too long");
    }),
  ]);
}

/**
 * A tab's page, loaded: a lazy tab (restored, or unloaded under memory pressure) gets its
 * browser and loads `url` in the background first (spec B2). Never selected, never shown.
 * @param {Win} win @param {Tab} tab @param {string} url @param {number} userContextId
 */
async function loadedPage(win, tab, url, userContextId) {
  const browser = tab.linkedBrowser;
  if (!tab.linkedPanel) win.gBrowser.insertBrowser(tab);
  if (tab.hasAttribute("pending") || !browser.browsingContext?.currentWindowGlobal) {
    browser.loadURI(agentUri(url), { triggeringPrincipal: agentPrincipal(userContextId) });
  }
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  for (;;) {
    const wg = browser.browsingContext?.currentWindowGlobal;
    const loading = browser.webProgress?.isLoadingDocument ?? true;
    if (wg && !loading && !tab.hasAttribute("pending") && !wg.isInitialDocument) return wg;
    if (Date.now() > deadline) throw new AgentError("failed", "the page did not load in time");
    await sleep(100);
  }
}

/**
 * Cut `text` to `max` code points.
 * @param {string} text @param {number} max
 */
function cut(text, max) {
  const chars = [...text];
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), truncated: true }
    : { text, truncated: false };
}

/**
 * `s` as well-formed Unicode: a lone surrogate (a page's title or text can hold one) becomes
 * U+FFFD, so the JSON line is one vimma-ctl's strict parser accepts (security.md M7).
 * @param {unknown} s
 */
const wf = (s) => /** @type {string} */ (/** @type {any} */ (String(s)).toWellFormed());

/** UTF-8 length of `value` as JSON. @param {unknown} value */
const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const COMMANDS = {
  /**
   * The connection's first command (decision 4): labels for the question. Neither is proof.
   * @param {ConnId} conn @param {AgentConn} state @param {any} args
   */
  "agent-hello"(conn, state, { client, via }) {
    state.agent = {
      client: client.name,
      ...(client.version ? { version: client.version } : {}),
      ...(via ? { via } : {}),
    };
    AgentGate.connect(conn, state.agent);
    const agent = WorkspaceStore.agent;
    return { workspace: agent?.name ?? WorkspaceStore.agentName ?? "agent", exists: !!agent };
  },

  "agent-ping"() {
    return {};
  },

  /**
   * Withdraw the question of this connection's request `id`, if it still waits (decision 17).
   * Another connection's requests are not in `state`, so out of reach.
   * @param {ConnId} _conn @param {AgentConn} state @param {{ id: number }} args
   */
  "agent-cancel"(_conn, state, { id }) {
    const cancel = state.cancels?.get(id);
    if (!cancel) return { cancelled: false };
    state.cancels?.delete(id);
    cancel();
    return { cancelled: true };
  },

  /** @param {ConnId} conn @param {AgentConn} state @param {any} _args @param {number} rid */
  async "agent-tabs"(conn, state, _args, rid) {
    const agent = agentWorkspace();
    await ask(conn, "agent-tabs", { count: agentTabs(agent).length }, state, rid);
    // The list as it is now, checked again (decision 7).
    const now = agentWorkspace();
    if (now.id !== agent.id) throw denied("changed");
    return {
      tabs: agentTabs(now, true).map(({ tab }) => ({
        id: tabId(tab),
        url: wf(tabUrl(tab)),
        title: wf(tab.label ?? ""),
        loading: tab.hasAttribute("busy") || tab.hasAttribute("pending") || !tab.linkedPanel,
      })),
    };
  },

  /** @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid */
  async "agent-read"(conn, state, { tab: id, format = "markdown", max_chars }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const what = { ...describeTab(asked.tab), index: asked.index };
    await ask(conn, "agent-read", what, state, rid);
    const { win, tab } = stillAsAsked(agent, id, what.url);
    const limit = Math.min(
      max_chars ?? Infinity,
      McpHost.config?.maxReadChars ?? DEFAULT_MAX_READ,
      MAX_READ_CHARS,
    );
    const wg = await loadedPage(win, tab, what.url, agent.userContextId);
    let extractor;
    try {
      extractor = wg.getActor("PageExtractor");
    } catch {
      throw new AgentError("failed", "Vimma cannot read this page (an error page or a viewer)");
    }
    const result = await within(
      EXTRACT_TIMEOUT_MS,
      extractor.getText({
        removeBoilerplate: true,
        useSimpleText: format === "text",
        sufficientLength: limit,
        sourceUrl: what.url,
      }),
    );
    if (!result || typeof result.text !== "string") {
      throw new AgentError("failed", "Vimma could not read text from this page");
    }
    let { text, truncated } = cut(wf(result.text), limit);
    const picked = await VimmaActors.selection(tab.linkedBrowser, limit);
    /** @type {string | null} */
    let selection = picked === null ? null : wf(picked);
    let language = null;
    try {
      const meta = await extractor.getPageMetadata();
      language = typeof meta?.language === "string" && meta.language ? wf(meta.language) : null;
    } catch {
      // metadata is a nicety; the text stands without it
    }
    const title = wf(tab.label ?? "");
    const background = !(tab.selected && /** @type {any} */ (Services.focus).activeWindow === win);
    // Last, once everything is collected (security.md M8): the page may have navigated or the
    // tab moved while it was read, and then nothing of it is sent.
    stillAsAsked(agent, id, what.url);
    // Page JS can set the selection, so it is as untrusted as the text.
    const reply = () => ({
      url: wf(what.url),
      title,
      text: wrapUntrusted(text),
      truncated,
      selection: selection === null ? null : wrapUntrusted(selection),
      language,
      background,
    });
    // The whole reply line must fit the protocol's 1 MiB (decision 4): cut the longer of the
    // text and the selection until it does.
    while (jsonBytes(reply()) > MAX_LINE_LENGTH - REPLY_OVERHEAD) {
      truncated = true;
      if (selection !== null && jsonBytes(selection) >= jsonBytes(text)) {
        const n = Math.floor([...selection].length * 0.9);
        selection = n > 0 ? cut(selection, n).text : null;
      } else if (text.length) {
        text = cut(text, Math.floor([...text].length * 0.9)).text;
      } else {
        throw new AgentError("failed", "the page's reply does not fit the protocol's line");
      }
    }
    return reply();
  },

  /** @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid */
  async "agent-open"(conn, state, { url, tab: id }, rid) {
    const agent = agentWorkspace();
    const uri = agentUri(url);
    const into = id === undefined ? null : findAgentTab(agent, id);
    const current = into ? describeTab(into.tab) : null;
    // The tab's own URL is `current`; `url` is what it would load.
    const what = {
      url: uri.spec,
      host: uri.host,
      ...(current ? { tab: current.tab, title: current.title, current: current.url } : {}),
    };
    await ask(conn, "agent-open", what, state, rid);
    if (!opens.take(conn, Date.now())) {
      throw new AgentError("denied", "too many opens from this agent in the last minute", "busy");
    }
    const principal = agentPrincipal(agent.userContextId);
    if (current) {
      const { tab } = stillAsAsked(agent, current.tab, current.url);
      // A download of this load is this connection's (decision 31): its grant covers it.
      AgentDownloads.openedBy(tab.linkedBrowser, conn, uri.spec);
      tab.linkedBrowser.loadURI(uri, { triggeringPrincipal: principal });
      return { tab: tabId(tab) };
    }
    const now = WorkspaceStore.agent;
    if (!now || now.id !== agent.id || now.userContextId !== agent.userContextId)
      throw denied("changed");
    // The most recently focused normal window, in the background (decision 10): the agent's
    // container explicitly, so no routing rule moves it, and no workspace switch.
    const win =
      lazy.BrowserWindowTracker.getTopWindow({ private: false, allowPopups: false }) ??
      normalWindows()[0];
    const ww = win && WindowWorkspaces.get(win);
    if (!ww?.model) throw new AgentError("failed", "no normal browser window to open in");
    const tab = ww.quietly(() =>
      win.gBrowser.addTab(uri.spec, {
        triggeringPrincipal: principal,
        userContextId: agent.userContextId,
        inBackground: true,
        skipAnimation: true,
      }),
    );
    AgentDownloads.openedBy(tab.linkedBrowser, conn, uri.spec);
    return { tab: tabId(tab) };
  },

  /**
   * Vimma's own page keys in an agent tab, in the background (mcp-drive D8-D17): parsed and
   * whitelisted in core before anything is asked, refused while the user is using the tab.
   * @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid
   */
  async "agent-keys"(conn, state, { tab: id, keys }, rid) {
    const agent = agentWorkspace();
    const parsed = parseAgentKeys(keys);
    if (!parsed.ok) throw new AgentError("invalid-args", parsed.error);
    const asked = findAgentTab(agent, id);
    const what = { ...describeTab(asked.tab), index: asked.index, keys: shownKeys(parsed.steps) };
    /**
     * A denial outside the gate goes into `:mcp log` too (D14, M23).
     * @param {any} outcome @param {unknown} [error]
     */
    const refuse = (outcome, error = denied(outcome)) => {
      AgentGate.note(conn, "vimma_keys", what, outcome);
      return error;
    };
    // Counted when asked, before anything else is learnt, so a refused call cannot be retried
    // in a loop, nor used to watch unasked whether the user is typing in a tab (D15).
    if (!keyCalls.take(conn, Date.now())) {
      const message = "too many vimma_keys calls from this agent in the last minute";
      throw refuse("busy", new AgentError("denied", message, "busy"));
    }
    if (VimmaHost.inUse(asked.tab.linkedBrowser)) throw refuse("in-use");
    const outcome = await ask(conn, "agent-keys", what, state, rid);
    let found;
    try {
      found = stillAsAsked(agent, id, what.url);
    } catch (e) {
      throw refuse("changed", e);
    }
    const { win, tab } = found;
    if (VimmaHost.inUse(tab.linkedBrowser)) throw refuse("in-use");
    const deadline = Date.now() + KEYS_CALL_MS;
    // A lazy tab (restored, or unloaded under memory pressure) loads first, in the background.
    if (!tab.linkedPanel || tab.hasAttribute("pending")) {
      await loadedPage(win, tab, what.url, agent.userContextId);
    }
    const principal = agentPrincipal(agent.userContextId);
    /** Each load is an open of this connection's: the open rate, its downloads (D12). */
    const countLoad = (/** @type {string} */ url) => {
      if (!opens.take(conn, Date.now())) return false;
      AgentDownloads.openedBy(tab.linkedBrowser, conn, url);
      return true;
    };
    const result = await AgentDrive.run(tab, parsed.steps, {
      conn,
      // D18: a follow to another site is a vimma_open of its URL, asked unless a vimma_open
      // grant is in force; the tab and the page it replaces are shown as for any open.
      askOpen: async (url, until) => {
        const uri = agentUri(url);
        const now = describeTab(tab);
        const open = { url: uri.spec, host: uri.host, tab: now.tab, title: now.title };
        try {
          await ask(conn, "agent-open", { ...open, current: now.url }, state, rid, until);
          return null;
        } catch (e) {
          return /** @type {AgentError} */ (e).reason ?? "user";
        }
      },
      // D14, M23: a follow goes into `:mcp log` with the URL it loaded, and under a grant its
      // notice names the host.
      followed: (url, keys) => {
        const uri = agentUri(url);
        AgentGate.note(
          conn,
          "vimma_keys",
          { title: what.title, keys: `${keys} → ${uri.spec}` },
          "followed",
        );
        if (outcome.grant) {
          AgentGate.announce(
            conn,
            "vimma_keys",
            { ...what, followed: uri.host },
            outcome.grant.until,
          );
        }
      },
      canLoad: () => opens.can(conn, Date.now()),
      stillAgent: () => {
        const now = WorkspaceStore.agent;
        return (
          !!now &&
          now.id === agent.id &&
          now.userContextId === agent.userContextId &&
          !win.closed &&
          isAgentTab(win, tab, agent)
        );
      },
      load: (url) => {
        const uri = agentUri(url);
        if (!countLoad(uri.spec)) return false;
        tab.linkedBrowser.loadURI(uri, { triggeringPrincipal: principal });
        return true;
      },
      countLoad,
      deadline,
    });
    // A call that stopped early says so in the log, after its yes or grant (M23).
    if (result.stopped) AgentGate.note(conn, "vimma_keys", what, "stopped", result.stopped);
    return result;
  },

  /**
   * The agent workspace brought to the front with one agent tab selected (mcp-drive D2-D7):
   * always asked, never under a grant, and applied only to the normal window that holds the
   * tab, through the ordinary workspace switch, so ctrl+^ returns. No window is raised or
   * focused.
   * @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid
   */
  async "agent-show"(conn, state, { tab: id }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Counted when asked, before the question, so a refused show cannot loop (D7).
    if (!showCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_show", what, "busy");
      const message = "too many vimma_show calls from this agent in the last minute";
      throw new AgentError("denied", message, "busy");
    }
    // AgentQueue asks vimma_show every time whatever is passed (ALWAYS_ASK); always is said here
    // too, so the gate's own options agree (D4).
    await ask(conn, "agent-show", what, state, rid, undefined, true);
    let found;
    try {
      found = stillAsAsked(agent, id, what.url);
    } catch (e) {
      AgentGate.note(conn, "vimma_show", what, "changed");
      throw e;
    }
    const { win, tab } = found;
    // normalWindows() never lists a private window, so this is a normal one (D5).
    const ww = WindowWorkspaces.get(win);
    const before = ww?.model?.active;
    const refused = ww ? ww.showTab(tab) : "no workspaces in that window";
    if (refused) {
      // After a yes the log holds `yes`; this row says the show did not happen (M23).
      AgentGate.note(conn, "vimma_show", what, "failed");
      throw new AgentError("failed", refused);
    }
    const label = { client: state.agent?.client, via: state.agent?.via };
    const answered = AgentUi.askingWindow();
    const where = {
      otherWindow: !!answered && answered !== win,
      // Already on the agent workspace: only the tab changed, and ctrl+^ goes elsewhere.
      switched: before !== ww?.model?.active,
    };
    AgentGate.notify(shownNotice({ tool: "vimma_show", label, what }, where));
    return { shown: true };
  },

  /**
   * The buttons, fields, links and other clickable elements on screen in an agent tab, with
   * labels (mcp-forms F2-F7): read-only, so it runs while the user uses the tab (F27); nothing
   * on the page is touched and the tab stays in the background (M25).
   * @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid
   */
  async "agent-elements"(conn, state, { tab: id }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Counted when asked, before the question, so a refused list cannot loop (F26).
    if (!elementCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_elements", what, "busy");
      const message = "too many vimma_elements calls from this agent in the last minute";
      throw new AgentError("denied", message, "busy");
    }
    await ask(conn, "agent-elements", what, state, rid);
    /** After the yes, and once the list is made, the tab must still be as asked (M8). */
    const still = () => {
      try {
        return stillAsAsked(agent, id, what.url);
      } catch (e) {
        AgentGate.note(conn, "vimma_elements", what, "changed");
        throw e;
      }
    };
    const { win, tab } = still();
    // A lazy tab (restored, or unloaded under memory pressure) loads first, in the background.
    if (!tab.linkedPanel || tab.hasAttribute("pending")) {
      await loadedPage(win, tab, what.url, agent.userContextId);
    }
    // Where the page is scrolled before the list is made: labels are drawn on a screenshot only
    // while it has not moved since (F20).
    const scroll = await VimmaActors.scrollPosition(tab.linkedBrowser);
    let listed;
    try {
      listed = await AgentAct.elements(tab);
    } catch (e) {
      // Fixed text: an error's message could carry the page's words past the untrusted header.
      console.error("vimma agent-elements:", e);
      listed = { refused: "Vimma could not list this page's elements" };
    }
    if ("refused" in listed) {
      AgentGate.note(conn, "vimma_elements", what, "failed");
      throw new AgentError("failed", listed.refused);
    }
    still();
    // Only once the tab is as asked: a list of a page that moved on leaves no labels (M25).
    AgentDrive.remember(conn, tab.linkedBrowser, listed.labels, "elements", scroll);
    // A page sets its URL and title: capped, so the reply stays within its 1 MiB line.
    return {
      url: wf(cut(what.url, ELEMENTS_URL_MAX).text),
      title: wf(cut(String(tab.label ?? ""), ELEMENTS_TITLE_MAX).text),
      elements: listed.elements,
      dropped: listed.dropped,
    };
  },

  /**
   * An image of an agent tab's viewport (mcp-forms F18-F21): read-only, so it runs while the user
   * uses the tab (F27); taken in the background, the tab never selected or shown (M25), and
   * refused while a sensitive field on screen has a value. With `labels`, the labels of the
   * connection's current `vimma_elements` list of the page are drawn on it, if it has not
   * scrolled since.
   * @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid
   */
  async "agent-screenshot"(conn, state, { tab: id, labels = false }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Counted when asked, before the question, so a refused screenshot cannot loop (F21).
    if (!shotCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_screenshot", what, "busy");
      const message = "too many vimma_screenshot calls from this agent in the last minute";
      throw new AgentError("denied", message, "busy");
    }
    await ask(conn, "agent-screenshot", what, state, rid);
    /** After the yes, and once the image is made, the tab must still be as asked (M8). */
    const still = () => {
      try {
        return stillAsAsked(agent, id, what.url);
      } catch (e) {
        AgentGate.note(conn, "vimma_screenshot", what, "changed");
        throw e;
      }
    };
    const { win, tab } = still();
    // A lazy tab (restored, or unloaded under memory pressure) loads first, in the background.
    if (!tab.linkedPanel || tab.hasAttribute("pending")) {
      await loadedPage(win, tab, what.url, agent.userContextId);
    }
    const browser = tab.linkedBrowser;
    /** @type {Map<string, any> | null} */
    let drawn = null;
    let stale = false;
    if (labels) {
      const list = AgentDrive.elementLabels(conn, browser);
      const now = list ? await VimmaActors.scrollPosition(browser) : null;
      const moved = !list?.scroll || !now || now.x !== list.scroll.x || now.y !== list.scroll.y;
      if (list && !moved) drawn = list.byLabel;
      else stale = true;
    }
    let shot;
    try {
      shot = await AgentShot.capture(win, tab, drawn);
    } catch (e) {
      // Fixed text: an error's message could carry the page's words past the untrusted header.
      console.error("vimma agent-screenshot:", e);
      shot = { refused: "Vimma could not take a screenshot of this page" };
    }
    if ("refused" in shot) {
      AgentGate.note(conn, "vimma_screenshot", what, "failed");
      throw new AgentError("failed", shot.refused);
    }
    // Last, once the image is made (M8): a page that moved on meanwhile is not sent.
    still();
    return {
      url: wf(cut(what.url, ELEMENTS_URL_MAX).text),
      title: wf(cut(String(tab.label ?? ""), ELEMENTS_TITLE_MAX).text),
      mimeType: shot.mimeType,
      data: shot.data,
      width: shot.width,
      height: shot.height,
      ...(labels ? { labels: shot.drawn } : {}),
      ...(stale ? { stale: true } : {}),
    };
  },

  /**
   * A click on one element of an agent tab, by its label from the connection's last
   * `vimma_elements` there (mcp-forms F8-F11, F15-F17; security.md M26, M28, M29): refused
   * before the question when it is not clickable, asked every time when it submits a form, and
   * run in the background with the child's `click()`. A tab the user is using is `in-use` (F27).
   * @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid
   */
  async "agent-activate"(conn, state, { tab: id, label }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const browser = asked.tab.linkedBrowser;
    const base = { ...describeTab(asked.tab), index: asked.index, label, detail: label };
    /**
     * A refusal outside the gate goes into `:mcp log` too (M23, M32).
     * @param {any} outcome @param {unknown} error @param {object} [what]
     */
    const refuse = (outcome, error, what = base) => {
      AgentGate.note(conn, "vimma_activate", what, outcome);
      return error;
    };
    // Counted when asked, before anything else is learnt, so a refused call cannot loop (F26).
    if (!actCalls.take(conn, Date.now())) {
      const message = "too many vimma_activate calls from this agent in the last minute";
      throw refuse("busy", new AgentError("denied", message, "busy"));
    }
    if (VimmaHost.inUse(browser)) throw refuse("in-use", denied("in-use"));
    const found = AgentDrive.element(conn, browser, label);
    if ("refused" in found) throw refuse("failed", new AgentError("failed", found.refused));
    let checked;
    try {
      checked = await AgentAct.clickable(browser, found.target, label);
    } catch (e) {
      // Fixed text: an error's message could carry the page's words past the untrusted header.
      console.error("vimma agent-activate:", e);
      checked = { refused: "Vimma could not check this element" };
    }
    if ("refused" in checked) {
      throw refuse("failed", new AgentError("failed", checked.refused));
    }
    // A click may load a page, which is an open (F11): a yes must not end in "too many loads".
    if (!opens.can(conn, Date.now())) {
      const message = "too many loads from this agent in the last minute";
      throw refuse("busy", new AgentError("denied", message, "busy"));
    }
    const element = checked.element;
    /** @type {{ method: string, action: string, host: string, fields: number } | undefined} */
    let submit;
    if (element.submit) {
      let host = "";
      try {
        host = /** @type {any} */ (Services.io.newURI(element.submit.action)).host;
      } catch {
        // no host to show in bold
      }
      submit = { ...element.submit, action: wf(element.submit.action), host: wf(host) };
    }
    const what = {
      ...base,
      kind: element.kind,
      text: wf(element.text ?? ""),
      detail: wf(actDetail(label, element)),
      ...(submit ? { submit } : {}),
    };
    // F15: a submission asks every time, also under a grant, and its yes makes no grant.
    await ask(conn, "agent-activate", what, state, rid, undefined, !!submit);
    let found2;
    try {
      found2 = stillAsAsked(agent, id, what.url);
    } catch (e) {
      throw refuse("changed", e, what);
    }
    const { win, tab } = found2;
    if (VimmaHost.inUse(tab.linkedBrowser)) throw refuse("in-use", denied("in-use"), what);
    const result = await AgentAct.activate(tab.linkedBrowser, found.target, {
      // The child clicks only if the element still submits there, and lets only that through.
      submit: element.submit
        ? { method: element.submit.method, action: element.submit.action }
        : null,
      href: element.href ?? null,
      inUse: () => VimmaHost.inUse(tab.linkedBrowser),
    });
    if ("refused" in result) {
      if (result.blocked) {
        const stopped = { ...what, detail: `${what.detail} · stopped a form to ${result.blocked}` };
        AgentGate.note(conn, "vimma_activate", stopped, "stopped", "unasked submission");
      }
      throw refuse("failed", new AgentError("failed", result.refused), what);
    }
    if (result.navigated) {
      // The page the labels named is gone, and the load was an open of this connection's.
      AgentDrive.drop(conn, tab.linkedBrowser);
      opens.take(conn, Date.now());
    }
    const now = WorkspaceStore.agent;
    if (!now || now.id !== agent.id || win.closed || !isAgentTab(win, tab, agent)) {
      // The tab left the agent workspace while the click's page loaded: nothing of it is said.
      AgentGate.note(conn, "vimma_activate", what, "stopped", "changed");
      throw new AgentError("failed", "the tab left the agent workspace after the click");
    }
    if (result.blocked) {
      // M23, M28: a submission Vimma stopped is a row of its own, naming where it would have gone.
      const stopped = { ...what, detail: `${what.detail} · stopped a form to ${result.blocked}` };
      AgentGate.note(conn, "vimma_activate", stopped, "stopped", "unasked submission");
    }
    if (result.stopped) AgentGate.note(conn, "vimma_activate", what, "stopped", result.stopped);
    return {
      url: wf(cut(tabUrl(tab), ELEMENTS_URL_MAX).text),
      title: wf(cut(String(tab.label ?? ""), ELEMENTS_TITLE_MAX).text),
      loading: result.loading,
      navigated: result.navigated,
      ...(result.dialog ? { dialog: result.dialog } : {}),
      ...(result.blocked ? { blocked: result.blocked } : {}),
      ...(result.stopped ? { stopped: result.stopped } : {}),
    };
  },

  /**
   * Fills fields of an agent tab, by their labels from the connection's last `vimma_elements`
   * there (mcp-forms F12-F14; security.md M27): every field is checked before the question and
   * any refused one refuses the call; a fill that submits asks every time (F15, M28); the fields
   * are set in the background, in order, each checked again in its child just before. A tab the
   * user is using is `in-use` (F27). Fills share the clicks' rate (F26).
   * @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid
   */
  async "agent-fill"(conn, state, { tab: id, fields, submit: submitArg }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const browser = asked.tab.linkedBrowser;
    const labels = fields.map((/** @type {any} */ f) => f.label).join(" ");
    const base = { ...describeTab(asked.tab), index: asked.index, detail: labels };
    /**
     * A refusal outside the gate goes into `:mcp log` too (M23, M32).
     * @param {any} outcome @param {unknown} error @param {object} [what] @param {string} [why]
     */
    const refuse = (outcome, error, what = base, why) => {
      AgentGate.note(conn, "vimma_fill", what, outcome, why);
      return error;
    };
    // Counted when asked, before anything else is learnt, so a refused call cannot loop (F26).
    if (!actCalls.take(conn, Date.now())) {
      const message =
        "too many vimma_activate and vimma_fill calls from this agent in the last minute";
      throw refuse("busy", new AgentError("denied", message, "busy"));
    }
    if (VimmaHost.inUse(browser)) throw refuse("in-use", denied("in-use"));
    /** @type {{ label: string, target: any, value: string | boolean, name: string,
     *   field: import("../core/agent-act.mjs").FillTarget }[]} */
    const steps = [];
    for (const { label, value } of fields) {
      const found = AgentDrive.element(conn, browser, label);
      if ("refused" in found) throw refuse("failed", new AgentError("failed", found.refused));
      let checked;
      try {
        checked = await AgentAct.fillable(browser, found.target, label, value);
      } catch (e) {
        // Fixed text: an error's message could carry the page's words past the untrusted header.
        console.error("vimma agent-fill:", e);
        checked = { refused: "Vimma could not check this field" };
      }
      if ("refused" in checked) throw refuse("failed", new AgentError("failed", checked.refused));
      steps.push({ label, target: found.target, value, name: checked.name, field: checked.field });
    }
    /** @type {{ by: "click" | "form", target: any, submit: { method: string,
     *   action: string, fields: number } } | null} */
    let submitting = null;
    if (typeof submitArg === "string") {
      const found = AgentDrive.element(conn, browser, submitArg);
      if ("refused" in found) throw refuse("failed", new AgentError("failed", found.refused));
      let checked;
      try {
        checked = await AgentAct.clickable(browser, found.target, submitArg);
      } catch (e) {
        console.error("vimma agent-fill:", e);
        checked = { refused: "Vimma could not check this element" };
      }
      if ("refused" in checked) throw refuse("failed", new AgentError("failed", checked.refused));
      if (!checked.element.submit) {
        const message = `label "${submitArg}" is not a submit button: submit takes a submit button's label, or true`;
        throw refuse("failed", new AgentError("failed", message));
      }
      // The question names the button's form: it must be the one whose fields are filled.
      const key = found.target.form?.key;
      if (!key || steps.some((s) => s.target.form?.key !== key)) {
        const message = `label "${submitArg}" submits another form: submit takes a submit button of the same form as the fields`;
        throw refuse("failed", new AgentError("failed", message));
      }
      submitting = { by: "click", target: found.target, submit: checked.element.submit };
    } else if (submitArg === true) {
      const first = steps[0];
      const key = first?.target.form?.key;
      if (!first || !key || steps.some((s) => s.target.form?.key !== key)) {
        const message = "submit: true sends one form: every field must be in one form";
        throw refuse("failed", new AgentError("failed", message));
      }
      const own = first.field.submit;
      if (!own) {
        const message =
          "that form cannot be sent from here (its default button is disabled, or it only closes a dialog)";
        throw refuse("failed", new AgentError("failed", message));
      }
      submitting = { by: "form", target: first.target, submit: own };
    }
    if (submitting && submitting.submit.action.length >= ELEMENT_REPLY_CAPS.action) {
      const message = "that form's destination is too long to show; nothing was asked";
      throw refuse("failed", new AgentError("failed", message));
    }
    // A fill may load a page (a change handler's, or the submit), which is an open (F11).
    if (!opens.can(conn, Date.now())) {
      const message = "too many loads from this agent in the last minute";
      throw refuse("busy", new AgentError("denied", message, "busy"));
    }
    /** @type {{ method: string, action: string, host: string, fields: number } | undefined} */
    let submit;
    if (submitting) {
      let host = "";
      try {
        host = /** @type {any} */ (Services.io.newURI(submitting.submit.action)).host;
      } catch {
        // no host to show in bold
      }
      submit = { ...submitting.submit, action: wf(submitting.submit.action), host: wf(host) };
    }
    const shownFields = steps.map((s) => ({
      label: s.label,
      name: wf(s.name),
      value: typeof s.value === "string" ? wf(s.value) : s.value,
    }));
    const what = {
      ...base,
      fields: shownFields,
      detail: wf(fillDetail(shownFields, submitting?.submit)),
      ...(submit ? { submit } : {}),
    };
    // F15: one yes sends what the question shows, so it must show every value whole.
    if (submit && !fillFits(what)) {
      const message =
        "a fill that submits must show every value whole in its question, and this one does not fit: fill first with vimma_fill, then submit with fewer or shorter values, or activate the submit button";
      throw refuse("failed", new AgentError("failed", message), what);
    }
    // F15: a submission asks every time, also under a grant, and its yes makes no grant.
    await ask(conn, "agent-fill", what, state, rid, undefined, !!submit);
    let found2;
    try {
      found2 = stillAsAsked(agent, id, what.url);
    } catch (e) {
      throw refuse("changed", e, what);
    }
    const { win, tab } = found2;
    if (VimmaHost.inUse(tab.linkedBrowser)) throw refuse("in-use", denied("in-use"), what);
    const result = await AgentAct.fill(
      tab.linkedBrowser,
      steps.map((s) => ({
        label: s.label,
        target: s.target,
        value: s.value,
        expect: { field: /** @type {string} */ (s.field.field), type: s.field.type ?? null },
      })),
      {
        submit: submitting
          ? {
              by: submitting.by,
              target: submitting.target,
              // Only that submission is let through, to the method and destination asked about.
              submit: { method: submitting.submit.method, action: submitting.submit.action },
            }
          : null,
        inUse: () => VimmaHost.inUse(tab.linkedBrowser),
        still: () => {
          try {
            stillAsAsked(agent, id, what.url);
            return true;
          } catch {
            return false;
          }
        },
      },
    );
    /** M23, M28: a submission Vimma stopped is a row of its own, naming where it would have gone. */
    const noteBlocked = (/** @type {string} */ host) =>
      AgentGate.note(
        conn,
        "vimma_fill",
        { ...what, detail: `${what.detail} · stopped a form to ${host}` },
        "stopped",
        "unasked submission",
      );
    if ("refused" in result) {
      if (result.blocked) noteBlocked(result.blocked);
      if (result.navigated) {
        // A page the fill's handlers loaded is an open of this connection's all the same (F11).
        AgentDrive.drop(conn, tab.linkedBrowser);
        opens.take(conn, Date.now());
      }
      if (result.changed) {
        throw refuse("stopped", new AgentError("failed", result.refused), what, "changed");
      }
      throw refuse("failed", new AgentError("failed", result.refused), what);
    }
    if (result.navigated) {
      // The page the labels named is gone, and the load was an open of this connection's.
      AgentDrive.drop(conn, tab.linkedBrowser);
      opens.take(conn, Date.now());
    }
    const now = WorkspaceStore.agent;
    if (!now || now.id !== agent.id || win.closed || !isAgentTab(win, tab, agent)) {
      // The tab left the agent workspace during the fill: nothing of it is said.
      AgentGate.note(conn, "vimma_fill", what, "stopped", "changed");
      throw new AgentError("failed", "the tab left the agent workspace during the fill");
    }
    if (result.blocked) noteBlocked(result.blocked);
    if (result.stopped) AgentGate.note(conn, "vimma_fill", what, "stopped", result.stopped);
    return {
      url: wf(cut(tabUrl(tab), ELEMENTS_URL_MAX).text),
      title: wf(cut(String(tab.label ?? ""), ELEMENTS_TITLE_MAX).text),
      filled: result.filled,
      ...(result.reset ? { reset: result.reset } : {}),
      loading: result.loading,
      navigated: result.navigated,
      ...(result.dialog ? { dialog: result.dialog } : {}),
      ...(result.blocked ? { blocked: result.blocked } : {}),
      ...(result.stopped ? { stopped: result.stopped } : {}),
    };
  },

  /** @param {ConnId} conn @param {AgentConn} state @param {any} args @param {number} rid */
  async "agent-close"(conn, state, { tab: id }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id);
    const what = { ...describeTab(asked.tab), index: asked.index };
    await ask(conn, "agent-close", what, state, rid);
    const { win, tab } = stillAsAsked(agent, id, what.url);
    win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false, skipPermitUnload: true });
    return { closed: true };
  },
};

/**
 * The connection closed: forget its opens.
 * @param {ConnId} conn
 */
export function forgetAgentConnection(conn) {
  opens.forget(conn);
  keyCalls.forget(conn);
  showCalls.forget(conn);
  elementCalls.forget(conn);
  actCalls.forget(conn);
  AgentDrive.forget(conn);
}

/**
 * Run an agent command, validated already. `state` is the connection's: `agent` once its
 * hello is in. Throws AgentError for every refusal.
 * @param {ConnId} conn
 * @param {AgentConn} state
 * @param {string} command
 * @param {any} args
 * @param {number} [rid]  the request's id, which `agent-cancel` names
 */
export function runAgentCommand(conn, state, command, args, rid) {
  if (command === "agent-hello") {
    if (state.agent) throw new AgentError("bad-request", "agent-hello was already sent");
  } else if (!state.agent) {
    throw new AgentError("bad-request", "agent-hello must be the connection's first command");
  }
  const run = /** @type {Record<string, (c: ConnId, s: AgentConn, a: any, r?: number) => any>} */ (
    COMMANDS
  )[command];
  if (!run) throw new AgentError("unknown-command", `unknown command ${command}`);
  return run(conn, state, args, rid);
}

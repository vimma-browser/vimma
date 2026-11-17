/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent role's commands (docs/specs/vimma-mcp.md, decision 4): list, read, open and close
// tabs of the agent workspace, run Vimma's own page keys in one, following its links by label
// (docs/specs/mcp-drive.md, `agent-keys`), show one to the user (`agent-show`), and list one's
// buttons, fields and links with labels (docs/specs/mcp-forms.md, `agent-elements`), click one
// by its label (`agent-activate`), fill fields by their labels (`agent-fill`), take a screenshot
// of one (`agent-screenshot`), read its script errors and failed requests (`agent-console`), and
// nothing else. What an agent can reach is decided in
// the browser, when each command runs (decision 7): a tab of the agent workspace **and** of its
// container, in a normal window (private windows have no workspaces and are never enumerated);
// agent-tabs.mjs holds that test. Every command but hello and ping asks through AgentGate first,
// here (decision 12), and after the yes the tab and URL must still be the ones asked about, or
// nothing happens (decision 19, agent-tabs.mjs's stillAsAsked, called by each handler here).

import {
  ACT_RATE,
  AGENT_TOOLS,
  CallRate,
  CONSOLE_RATE,
  ELEMENTS_RATE,
  KEYS_RATE,
  OpenRate,
  SCREENSHOT_RATE,
  SHOW_RATE,
  isBuiltinConn,
  mcpClientName,
  wrapUntrusted,
} from "../core/agent.mjs";
import { ListedSites, actDetail, fillDetail } from "../core/agent-act.mjs";
import {
  AGENT_PAGE_URL_MAX,
  agentUrl,
  markdownWithoutUserinfo,
  parseAgentKeys,
  shownKeys,
} from "../core/agent-keys.mjs";
import { fillFits, shownNotice } from "../core/agent-prompt.mjs";
import { ctlIsCurrent, ctlVersionNotice } from "../core/ctl-version.mjs";
import {
  AGENT_COMMANDS,
  MAX_LINE_LENGTH,
  MAX_READ_CHARS,
  parseAgentRequest,
} from "../core/control.mjs";
import { ELEMENT_REPLY_CAPS } from "../core/agent-element.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { AgentUi } from "../host/agent-ui.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { AgentAct } from "./AgentAct.sys.mjs";
import { AgentConsole } from "./AgentConsole.sys.mjs";
import { AgentDownloads } from "./AgentDownloads.sys.mjs";
import { AgentDrive } from "./AgentDrive.sys.mjs";
import { AgentGate } from "../host/AgentGate.sys.mjs";
import { AgentShot } from "./AgentShot.sys.mjs";
import { AgentError, denied } from "./agent-errors.mjs";
import {
  agentPrincipal,
  agentTabs,
  agentUri,
  agentWorkspace,
  describeTab,
  findAgentTab,
  forgetOwners,
  isAgentTab,
  normalWindows,
  // Renamed: fill's handler has a local `own` (a form's own submit), which would shadow it.
  own as ownTab,
  ownerOf,
  siteOfTab,
  stillAsAsked,
  tabId,
  tabTitle,
  tabUrl,
} from "./agent-tabs.mjs";
import {
  cut,
  fieldOf,
  firstActing,
  jsonBytes,
  linkOf,
  payStep,
  unmarked,
  wf,
} from "./agent-steps.mjs";
import { LOAD_TIMEOUT_MS, docOf, notLoading, raisePriority, within } from "./agent-waits.mjs";

export { AgentError };

/** @import { ConnId, LogOutcome } from "../core/agent.mjs" */
/** @import { AgentArgs, AgentCommand } from "../core/control.mjs" */
/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */
/** @import { AgentWorkspace, Tab, Win } from "./agent-tabs.mjs" */
import { allowanceKey, isConsequential, mayAllowHere } from "../core/agent-checkpoint.mjs";

/**
 * @typedef {"AppConstants" | "BrowserWindowTracker" | "clearTimeout" | "setTimeout"} LazyName
 */
const lazy = /** @type {Lazy<LazyName>} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

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
/** Each connection's `agent-console`: at most CONSOLE_RATE a minute, counted when asked (F26). */
const consoleCalls = new CallRate(CONSOLE_RATE);
/**
 * Each connection's last element list of each site (agent-speed S4): what its next list of the
 * site leaves out. A connection is one conversation, so a new one gets every list in full.
 */
const listedSites = new ListedSites();
/** The longest title an `agent-elements` reply carries, in code points. */
const ELEMENTS_TITLE_MAX = 1024;
/**
 * A page's URL as a reply gives it to the agent (security.md M7, #1209): without its user name
 * and password, cut at AGENT_PAGE_URL_MAX. The tab's own URL, compared in stillAsAsked, keeps them.
 * @param {string} url
 */
const pageUrl = (url) => wf(agentUrl(url, AGENT_PAGE_URL_MAX));
/**
 * A tab's title as a reply gives it to the agent (security.md M21, #1209): for a label Firefox
 * made of a URL, the tab's URL without its user name and password; cut at `max` code points.
 * @param {Tab} tab @param {number} [max]
 */
const pageTitle = (tab, max = Infinity) => wf(cut(tabTitle(tab), max).text);
/** The longest an `agent-keys` call runs after the yes (mcp-drive D15). */
const KEYS_CALL_MS = 60000;

/**
 * Whether the user is using the tab of `browser` (mcp-drive D13), or a screenshot of it is
 * being taken, which the agent's own steps must not change (mcp-forms F21).
 * @param {MozBrowser} browser
 */
const inUse = (browser) => VimmaHost.inUse(browser) || AgentShot.capturing(browser);

/**
 * The connections whose vimma-ctl is at least as new as Vimma (agent-hello's `ctl`): only they
 * get a rate refusal's `retryAfter`, which an older client's strict parser would reject.
 * @type {Set<ConnId>}
 */
const currentCtl = new Set();

/**
 * The `busy` denial of a used-up rate (issue #592): it names the limit and, to a current
 * vimma-ctl or a built-in conversation, says when the next call is allowed, so an agent does not wait for a question that
 * is not there.
 * @param {CallRate} rate @param {ConnId} conn @param {string} calls  e.g. "vimma_keys calls"
 */
function rateDenied(rate, conn, calls) {
  const { message, retryAfter } = rate.refusal(conn, Date.now(), calls);
  // A built-in conversation reads the result in this process, so it is always current.
  const wait = currentCtl.has(conn) || isBuiltinConn(conn) ? retryAfter : undefined;
  return new AgentError("denied", message, "busy", wait);
}

/**
 * @typedef {{ agent?: { client: string, via?: string }, cancels?: Map<number, () => void> }} AgentConn
 */

/**
 * Ask, and wait: resolves when allowed, throws `denied` otherwise. While the question waits,
 * `agent-cancel` with the request's id `rid` can withdraw it (decision 17: MCP's
 * notifications/cancelled); the connection's `state.cancels` keeps the way to, until answered.
 * With `until`, the question is withdrawn then (a step of a call that must end by then);
 * `always`: asked even under a grant, and never granted (mcp-drive D4); `covered`: a form the
 * grant runs all the same (docs/specs/mcp-consequence.md K1, K5).
 * @param {ConnId} conn @param {string} command @param {object} what
 * @param {AgentConn} state @param {number | undefined} rid @param {number} [until]
 * @param {boolean} [always] @param {true | string} [covered]
 */
async function ask(conn, command, what, state, rid, until, always = false, covered = undefined) {
  const tool = /** @type {Record<string, string>} */ (AGENT_TOOLS)[command];
  /** @type {number | null} */
  let timer = null;
  const onCancel = (/** @type {() => void} */ cancel) => {
    if (rid !== undefined) (state.cancels ??= new Map()).set(rid, cancel);
    if (until !== undefined) timer = lazy.setTimeout(cancel, Math.max(0, until - Date.now()));
  };
  try {
    const outcome = await AgentGate.request(conn, /** @type {string} */ (tool), what, {
      always,
      ...(covered === undefined ? {} : { covered }),
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
 * The element list of `tab`'s page as `agent-elements` makes it (mcp-forms F2-F7; security.md
 * M25, M31), for that command and for a step asked with `elements` (issue #584), so both are
 * one code path. `still` runs once the list is made and throws when the tab is no longer as
 * asked (M8); only after it do the labels become the connection's (M25), and the list the
 * connection's last of the page's site, which its next list of the site leaves out the lines of
 * (agent-speed S4), unless `full`. `filters` are the list's `query` and `kinds` (builtin-agent B2).
 * @param {ConnId} conn @param {Tab} tab @param {() => void} still
 * @param {ListOptions} [options]
 * @returns {Promise<{ elements: string, dropped: number, repeated?: string[] }
 *   | { refused: string }>}
 */
async function pageElements(conn, tab, still, { query, kinds, full = false } = {}) {
  // Where the page is scrolled before the list is made: labels are drawn on a screenshot only
  // while it has not moved since (F20).
  const scroll = await VimmaActors.scrollPosition(tab.linkedBrowser);
  let listed;
  try {
    listed = await AgentAct.elements(tab, {
      query,
      kinds,
      seen: (site) => (full ? undefined : listedSites.get(conn, site)),
    });
  } catch (e) {
    // Fixed text: an error's message could carry the page's words past the untrusted header.
    console.error("vimma agent-elements:", e);
    listed = { refused: "Vimma could not list this page's elements" };
  }
  if ("refused" in listed) return listed;
  still();
  AgentDrive.remember(conn, tab.linkedBrowser, listed.labels, "elements", scroll);
  if (listed.site) listedSites.set(conn, listed.site, listed.lines);
  return {
    elements: listed.elements,
    dropped: listed.dropped,
    ...(listed.repeated.length ? { repeated: listed.repeated } : {}),
  };
}

/**
 * An element list's options: its filters (builtin-agent B2) and whether to give every line
 * (agent-speed S4).
 * @typedef {{ query?: string, kinds?: string[], full?: boolean }} ListOptions
 */

/**
 * Takes a slot of the connection's `agent-elements` rate for a step asked with `elements`
 * (issue #584; mcp-forms F26): counted when asked, as a list of its own, so returning the list
 * with a step is no way past the rate. Refused as `busy` before anything else of the step.
 * @param {ConnId} conn @param {string} tool @param {object} what
 */
function takeListSlot(conn, tool, what) {
  if (elementCalls.take(conn, Date.now())) return;
  AgentGate.note(conn, tool, what, "busy");
  throw rateDenied(elementCalls, conn, "vimma_elements calls");
}

/**
 * A step's element list, asked with `elements` (issue #584): the page in `tab` after the step,
 * once `ready` says it is, listed as `agent-elements` lists it, with the tab's URL and title as
 * they were at the last check that it is still the agent's (M8); or, with that URL and title,
 * why there is no list, in STEP_UNLISTED's words: `loading`, `changed` (the page's URL changed
 * while it was listed), `error` (the load ended on Firefox's error page, named in `loadError`;
 * issue #643) or `failed`. A tab that left the agent workspace or closed meanwhile is a
 * `failed` refusal that says nothing of its page, noted in `:mcp log` (M23).
 * @param {ConnId} conn @param {string} tool @param {object} what  the step's, for the log
 * @param {AgentWorkspace} agent @param {Win} win @param {Tab} tab
 * @param {() => Promise<boolean>} ready @param {ListOptions} filters  the step's `query` and `kinds`
 * @returns {Promise<{ url: string, title: string }
 *   & ({ elements: string, dropped: number, repeated?: string[] }
 *     | { unlisted: string, loadError?: string })>}
 */
async function stepList(conn, tool, what, agent, win, tab, ready, filters) {
  /** The tab's page now, after checking that it is still an agent tab; or the refusal. */
  const page = () => {
    const now = WorkspaceStore.agent;
    const still =
      !!now &&
      now.id === agent.id &&
      now.userContextId === agent.userContextId &&
      !win.closed &&
      isAgentTab(win, tab, agent, conn);
    if (!still) {
      AgentGate.note(conn, tool, what, "stopped", "changed");
      throw new AgentError("failed", "the tab left the agent workspace before its page was listed");
    }
    return {
      url: pageUrl(tabUrl(tab)),
      title: pageTitle(tab, ELEMENTS_TITLE_MAX),
    };
  };
  if (!(await ready())) return { ...page(), unlisted: "loading" };
  const before = page();
  const loadError = AgentAct.loadError(tab.linkedBrowser);
  if (loadError) {
    AgentGate.note(conn, tool, what, "failed", "not loaded");
    return { ...before, unlisted: "error", loadError };
  }
  const url = tabUrl(tab);
  /** @type {{ url: string, title: string } | null} */
  let after = null;
  let moved = false;
  const listed = await pageElements(
    conn,
    tab,
    () => {
      after = page();
      if (tabUrl(tab) !== url) {
        moved = true;
        throw new Error("moved");
      }
    },
    filters,
  ).catch((e) => {
    if (moved) return null;
    throw e;
  });
  if (!listed) return { ...(after ?? before), unlisted: "changed" };
  if ("refused" in listed) {
    AgentGate.note(conn, tool, what, "failed", "unlisted");
    return { ...page(), unlisted: "failed" };
  }
  return { .../** @type {{ url: string, title: string }} */ (after ?? before), ...listed };
}

/**
 * The release of a raise of the agent tab an agent names by `id`, or null when it names none
 * that `conn` may see: a command that refuses it then runs as it would.
 * @param {ConnId} conn @param {unknown} id
 */
function raiseNamedTab(conn, id) {
  if (typeof id !== "string") return null;
  let found;
  try {
    found = agentTabs(agentWorkspace(), conn).find(({ tab }) => tabId(tab) === id);
  } catch {
    return null;
  }
  return found ? raisePriority(found.tab.linkedBrowser) : null;
}

/**
 * A tab's page, ready (AgentAct.ready: loaded, or past its DOMContentLoaded and quiet a moment;
 * issue #579): a lazy tab (restored, or unloaded under memory pressure) gets its browser and
 * loads `url` in the background first (spec B2). Never selected, never shown.
 * @param {Win} win @param {Tab} tab @param {string} url @param {number} userContextId
 */
async function loadedPage(win, tab, url, userContextId) {
  const browser = tab.linkedBrowser;
  if (!tab.linkedPanel) win.gBrowser.insertBrowser(tab);
  if (tab.hasAttribute("pending") || !browser.browsingContext?.currentWindowGlobal) {
    browser.loadURI(agentUri(url), { triggeringPrincipal: agentPrincipal(userContextId) });
  }
  const ready = await AgentAct.ready(
    browser,
    (wg) => !tab.hasAttribute("pending") && !wg.isInitialDocument,
    Date.now() + LOAD_TIMEOUT_MS,
  );
  const wg = browser.browsingContext?.currentWindowGlobal;
  if (!ready || !wg) throw new AgentError("failed", "the page did not load in time");
  return wg;
}

/** The clients (name and vimma-ctl version) told about once this session. */
const ctlNoticed = new Set();

const COMMANDS = {
  /**
   * The connection's first command (decision 4): labels for the question. Neither is proof.
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-hello"]} args
   */
  "agent-hello"(conn, state, { client, via, ctl, session }) {
    state.agent = {
      // No MCP client may pass as the built-in agent (docs/specs/builtin-agent.md Behaviour 31).
      client: mcpClientName(client.name),
      ...(client.version ? { version: client.version } : {}),
      ...(via ? { via } : {}),
    };
    AgentGate.connect(conn, state.agent, session);
    // An older vimma-ctl keeps its own tools, since every command is checked here all the same;
    // the user learns why an agent lacks newer ones (spec ship-vimma-ctl, decision 6).
    // Once per client name and version a session, so a client that reconnects, or opens
    // connection after connection, cannot keep the notice line for itself.
    const vimma = lazy.AppConstants.MOZ_APP_VERSION_DISPLAY;
    if (ctlIsCurrent(ctl, vimma)) currentCtl.add(conn);
    const notice = ctlVersionNotice(ctl, vimma);
    const key = `${client.name}\0${ctl ?? ""}`;
    if (notice && !ctlNoticed.has(key)) {
      ctlNoticed.add(key);
      AgentGate.notify(notice, { hold: true });
    }
    const agent = WorkspaceStore.agent;
    return { workspace: agent?.name ?? WorkspaceStore.agentName ?? "agent", exists: !!agent };
  },

  "agent-ping"() {
    return {};
  },

  /**
   * Withdraw the question of this connection's request `id`, if it still waits (decision 17).
   * Another connection's requests are not in `state`, so out of reach.
   * @param {ConnId} _conn @param {AgentConn} state @param {AgentArgs["agent-cancel"]} args
   */
  "agent-cancel"(_conn, state, { id }) {
    const cancel = state.cancels?.get(id);
    if (!cancel) return { cancelled: false };
    state.cancels?.delete(id);
    cancel();
    return { cancelled: true };
  },

  /**
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-tabs"]} _args
   * @param {number | undefined} rid
   */
  async "agent-tabs"(conn, state, _args, rid) {
    const agent = agentWorkspace();
    await ask(conn, "agent-tabs", { count: agentTabs(agent, conn).length }, state, rid);
    // The list as it is now, checked again (decision 7).
    const now = agentWorkspace();
    if (now.id !== agent.id) throw denied("changed");
    return {
      tabs: agentTabs(now, conn, true).map(({ tab }) => ({
        id: tabId(tab),
        url: pageUrl(tabUrl(tab)),
        title: pageTitle(tab),
        loading: tab.hasAttribute("busy") || tab.hasAttribute("pending") || !tab.linkedPanel,
      })),
    };
  },

  /**
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-read"]} args
   * @param {number | undefined} rid
   */
  async "agent-read"(conn, state, { tab: id, format = "markdown", max_chars }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index };
    await ask(conn, "agent-read", what, state, rid);
    const { win, tab } = stillAsAsked(agent, id, what.url, conn);
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
    // The page's process's answer (PageExtractorChild), checked as any.
    const read = fieldOf(result, "text");
    if (typeof read !== "string") {
      throw new AgentError("failed", "Vimma could not read text from this page");
    }
    // The extractor resolves each link against the page's URL, user name and password included.
    let { text, truncated } = cut(wf(markdownWithoutUserinfo(read)), limit);
    const picked = await VimmaActors.selection(tab.linkedBrowser, limit);
    /** @type {string | null} */
    let selection = picked === null ? null : wf(picked);
    let language = null;
    try {
      const meta = fieldOf(await extractor.getPageMetadata(), "language");
      language = typeof meta === "string" && meta ? wf(meta) : null;
    } catch {
      // metadata is a nicety; the text stands without it
    }
    const title = pageTitle(tab);
    const background = !(tab.selected && Services.focus.activeWindow === win);
    // Last, once everything is collected (security.md M8): the page may have navigated or the
    // tab moved while it was read, and then nothing of it is sent.
    stillAsAsked(agent, id, what.url, conn);
    // Page JS can set the selection, so it is as untrusted as the text.
    const reply = () => ({
      url: pageUrl(what.url),
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

  /**
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-open"]} args
   * @param {number | undefined} rid
   */
  async "agent-open"(conn, state, { url, tab: id, elements = false, query, kinds }, rid) {
    const agent = agentWorkspace();
    const uri = agentUri(url);
    const into = id === undefined ? null : findAgentTab(agent, id, conn);
    const current = into ? describeTab(into.tab) : null;
    // The tab's own URL is `current`; `url` is what it would load.
    const what = {
      url: uri.spec,
      host: uri.host,
      ...(current ? { tab: current.tab, title: current.title, current: current.url } : {}),
      ...(elements ? { elements: true } : {}),
    };
    // Checked before the question too, as clicks and fills are: without a grant every open
    // asks, and an open over the rate must not be asked. Only the take after it counts.
    if (!opens.can(conn, Date.now())) {
      throw rateDenied(opens, conn, "opens");
    }
    if (elements) takeListSlot(conn, "vimma_open", what);
    await ask(conn, "agent-open", what, state, rid);
    if (!opens.take(conn, Date.now())) {
      throw rateDenied(opens, conn, "opens");
    }
    const principal = agentPrincipal(agent.userContextId);
    /**
     * The open's result: with `elements`, once the page it loaded is ready, its list too.
     * @param {Win} win @param {Tab} tab @param {number} before  the top document it replaces
     */
    const opened = async (win, tab, before, from = "") => {
      if (!elements) return { tab: tabId(tab) };
      const browser = tab.linkedBrowser;
      const until = Date.now() + LOAD_TIMEOUT_MS;
      // A URL that differs from the page's only by its fragment stays in the same document.
      const unhashed = (/** @type {string} */ u) => u.replace(/#.*$/s, "");
      const sameDocument = uri.spec.includes("#") && unhashed(uri.spec) === unhashed(from);
      // A tab closed during the wait ends it at once: stepList then refuses it.
      /** @type {() => void} */
      let unlisten = () => {};
      const closed = new Promise((resolve) => {
        const onClose = () => resolve(false);
        tab.addEventListener("TabClose", onClose, { once: true });
        unlisten = () => tab.removeEventListener("TabClose", onClose);
      });
      const list = await stepList(
        conn,
        "vimma_open",
        what,
        agent,
        win,
        tab,
        () =>
          Promise.race([
            AgentAct.ready(
              browser,
              (wg) =>
                !wg.isInitialDocument &&
                (wg.innerWindowId !== before || (sameDocument && tabUrl(tab) === uri.spec)),
              until,
            ),
            /** @type {Promise<boolean>} */ (closed),
          ]),
        { query, kinds },
      ).finally(unlisten);
      return { tab: tabId(tab), ...list };
    };
    if (current) {
      const { win, tab } = stillAsAsked(agent, current.tab, current.url, conn);
      const before = docOf(tab.linkedBrowser);
      // A download of this load is this connection's (decision 31): its grant covers it.
      AgentDownloads.openedBy(tab.linkedBrowser, conn, uri.spec);
      tab.linkedBrowser.loadURI(uri, { triggeringPrincipal: principal });
      return opened(win, tab, before, current.url);
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
    if (!win || !ww?.model) throw new AgentError("failed", "no normal browser window to open in");
    const tab = ww.quietly(() =>
      win.gBrowser.addTab(uri.spec, {
        triggeringPrincipal: principal,
        userContextId: agent.userContextId,
        inBackground: true,
        skipAnimation: true,
      }),
    );
    // Not for a conversation deleted while the open ran: its tab would belong to no one alive.
    if (isBuiltinConn(conn) && AgentGate.isConnected(conn)) AgentTabOwners.give(tab, conn);
    AgentDownloads.openedBy(tab.linkedBrowser, conn, uri.spec);
    if (!elements) return opened(win, tab, 0);
    // The page it waits for loads at foreground priority, as on a tab the command names.
    const release = raisePriority(tab.linkedBrowser);
    return opened(win, tab, 0).finally(release);
  },

  /**
   * Vimma's own page keys in an agent tab, in the background (mcp-drive D8-D17): parsed and
   * whitelisted in core before anything is asked, refused while the user is using the tab.
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-keys"]} args
   * @param {number | undefined} rid
   */
  async "agent-keys"(conn, state, { tab: id, keys }, rid) {
    const agent = agentWorkspace();
    const parsed = parseAgentKeys(keys);
    if (!parsed.ok) throw new AgentError("invalid-args", parsed.error);
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index, keys: shownKeys(parsed.steps) };
    /**
     * A denial outside the gate goes into `:mcp log` too (D14, M23).
     * @param {LogOutcome & string} outcome @param {unknown} [error]
     */
    const refuse = (outcome, error = denied(outcome)) => {
      AgentGate.note(conn, "vimma_keys", what, outcome);
      return error;
    };
    // Counted when asked, before anything else is learnt, so a refused call cannot be retried
    // in a loop, nor used to watch unasked whether the user is typing in a tab (D15).
    if (!keyCalls.take(conn, Date.now())) {
      throw refuse("busy", rateDenied(keyCalls, conn, "vimma_keys calls"));
    }
    if (inUse(asked.tab.linkedBrowser)) throw refuse("in-use");
    // mcp-checkpoints C6: a key that acts (a follow, gu, gU, H, L) on a page where it may pay
    // asks as a payment. The first such step, on the page as it is now, is asked in the call's
    // own question, so one step never asks twice; later ones ask when they come (`askPay`).
    const first = firstActing(parsed.steps);
    const firstPay = first ? await payStep(asked.tab.linkedBrowser, conn, first.step) : null;
    // The link the question named: a list made while it waits may give its label to another.
    const firstLink =
      first?.step.action === "hint.follow"
        ? linkOf(asked.tab.linkedBrowser, conn, first.step)
        : null;
    const pageAsked = docOf(asked.tab.linkedBrowser);
    // A key step shows the call's keys, not only its own, so the yes covers nothing unseen.
    if (firstPay)
      Object.assign(what, { pay: firstPay.keys ? { ...firstPay, keys: what.keys } : firstPay });
    const outcome = await ask(conn, "agent-keys", what, state, rid, undefined, !!firstPay);
    let found;
    try {
      found = stillAsAsked(agent, id, what.url, conn);
    } catch (e) {
      throw refuse("changed", e);
    }
    const { win, tab } = found;
    if (inUse(tab.linkedBrowser)) throw refuse("in-use");
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
    const result = await AgentShot.acting(tab.linkedBrowser, () =>
      AgentDrive.run(tab, parsed.steps, {
        conn,
        // D18: a follow to another site is a vimma_open of its URL, asked unless the connection's
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
        // mcp-checkpoints C1, C6: a step that may pay asks under any grant, y or n only.
        askPay: async (step, index, found, until) => {
          const browser = tab.linkedBrowser;
          const already =
            firstPay &&
            first?.index === index &&
            docOf(browser) === pageAsked &&
            (step.action !== "hint.follow" || found?.target === firstLink?.target);
          if (already) return null;
          const pay = await payStep(browser, conn, step, found);
          if (!pay) return null;
          const at = { ...describeTab(tab), index: what.index, keys: step.keys, pay };
          try {
            await ask(conn, "agent-keys", at, state, rid, until, true);
            return null;
          } catch (e) {
            return /** @type {AgentError} */ (e).reason ?? "user";
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
            isAgentTab(win, tab, agent, conn)
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
      }),
    );
    // A call that stopped early says so in the log, after its yes or grant (M23).
    if (result.stopped) AgentGate.note(conn, "vimma_keys", what, "stopped", result.stopped);
    return result;
  },

  /**
   * The agent workspace brought to the front with one agent tab selected (mcp-drive D2-D7):
   * always asked, never under a grant, and applied only to the normal window that holds the
   * tab, through the ordinary workspace switch, so ctrl+^ returns. No window is raised or
   * focused.
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-show"]} args
   * @param {number | undefined} rid
   */
  async "agent-show"(conn, state, { tab: id }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Counted when asked, before the question, so a refused show cannot loop (D7).
    if (!showCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_show", what, "busy");
      throw rateDenied(showCalls, conn, "vimma_show calls");
    }
    // AgentQueue asks vimma_show every time whatever is passed (ALWAYS_ASK); always is said here
    // too, so the gate's own options agree (D4).
    await ask(conn, "agent-show", what, state, rid, undefined, true);
    let found;
    try {
      found = stillAsAsked(agent, id, what.url, conn);
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
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-elements"]} args
   * @param {number | undefined} rid
   */
  async "agent-elements"(conn, state, { tab: id, query, kinds, full = false }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Counted when asked, before the question, so a refused list cannot loop (F26).
    if (!elementCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_elements", what, "busy");
      throw rateDenied(elementCalls, conn, "vimma_elements calls");
    }
    await ask(conn, "agent-elements", what, state, rid);
    /** After the yes, and once the list is made, the tab must still be as asked (M8). */
    const still = () => {
      try {
        return stillAsAsked(agent, id, what.url, conn);
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
    // Only once the tab is as asked: a list of a page that moved on leaves no labels (M25).
    const listed = await pageElements(conn, tab, still, { query, kinds, full });
    if ("refused" in listed) {
      AgentGate.note(conn, "vimma_elements", what, "failed");
      throw new AgentError("failed", listed.refused);
    }
    // A page sets its URL and title: capped, so the reply stays within its 1 MiB line.
    return {
      url: pageUrl(what.url),
      title: pageTitle(tab, ELEMENTS_TITLE_MAX),
      ...listed,
    };
  },

  /**
   * An image of an agent tab's viewport (mcp-forms F18-F21): read-only, so it runs while the user
   * uses the tab (F27); taken in the background, the tab never selected or shown (M25), and
   * refused while a sensitive field on screen has a value. With `labels`, the labels of the
   * connection's current `vimma_elements` list of the page are drawn on it, if it has not
   * scrolled since.
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-screenshot"]} args
   * @param {number | undefined} rid
   */
  async "agent-screenshot"(conn, state, { tab: id, labels = false, full = false }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Only a web page is captured (F18): refused before anything is asked or counted, and
    // AgentShot checks the page's principal again around the drawing.
    if (!/^https?:/i.test(what.url)) {
      throw new AgentError("failed", "screenshots are taken only of http and https pages");
    }
    // Counted when asked, before the question, so a refused screenshot cannot loop (F21).
    if (!shotCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_screenshot", what, "busy");
      throw rateDenied(shotCalls, conn, "vimma_screenshot calls");
    }
    await ask(conn, "agent-screenshot", what, state, rid);
    /** After the yes, and once the image is made, the tab must still be as asked (M8). */
    const still = () => {
      try {
        return stillAsAsked(agent, id, what.url, conn);
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
    /** @type {Map<string, HintTarget> | null} */
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
      shot = await AgentShot.capture(win, tab, drawn, full);
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
      url: pageUrl(what.url),
      title: pageTitle(tab, ELEMENTS_TITLE_MAX),
      mimeType: shot.mimeType,
      data: shot.data,
      width: shot.width,
      height: shot.height,
      ...(labels ? { labels: shot.drawn } : {}),
      ...(stale ? { stale: true } : {}),
    };
  },

  /**
   * An agent tab's script errors, its page's console errors and warnings, and its failed requests
   * (mcp-forms F22-F24; security.md M30, M31): read-only, so it runs while the user uses the tab
   * (F27). Nothing runs in the page: the errors come from Firefox's own caches and the requests
   * from AgentConsole's log; the tab stays in the background (M25).
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-console"]} args
   * @param {number | undefined} rid
   */
  async "agent-console"(conn, state, { tab: id, since = 0 }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index };
    // Only a web page's (as F2): a privileged about: page, the start page or a local file moved
    // into the agent workspace is not the agent's to read. Refused before anything is asked.
    if (!/^https?:/i.test(what.url)) {
      throw new AgentError("failed", "console output is read only of http and https pages");
    }
    // Counted when asked, before the question, so a refused read cannot loop (F26).
    if (!consoleCalls.take(conn, Date.now())) {
      AgentGate.note(conn, "vimma_console", what, "busy");
      throw rateDenied(consoleCalls, conn, "vimma_console calls");
    }
    await ask(conn, "agent-console", what, state, rid);
    /** After the yes, and once the lists are made, the tab must still be as asked (M8). */
    const still = () => {
      try {
        return stillAsAsked(agent, id, what.url, conn);
      } catch (e) {
        AgentGate.note(conn, "vimma_console", what, "changed");
        throw e;
      }
    };
    const { tab } = still();
    let read;
    try {
      read = await AgentConsole.read(tab.linkedBrowser, since);
    } catch (e) {
      // Fixed text: an error's message could carry the page's words past the untrusted header.
      console.error("vimma agent-console:", e);
      AgentGate.note(conn, "vimma_console", what, "failed");
      throw new AgentError("failed", "Vimma could not read this page's errors");
    }
    still();
    return {
      url: pageUrl(what.url),
      title: pageTitle(tab, ELEMENTS_TITLE_MAX),
      ...read,
    };
  },

  /**
   * A click on one element of an agent tab, by its label from the connection's last
   * `vimma_elements` there (mcp-forms F8-F11, F15-F17; security.md M26, M28, M29): refused
   * before the question when it is not clickable, asked every time when it submits a form or may
   * pay (mcp-checkpoints C1, C6; M33), and run in the background with the child's `click()`. A
   * tab the user is using is `in-use` (F27).
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-activate"]} args
   * @param {number | undefined} rid
   */
  async "agent-activate"(conn, state, { tab: id, label, elements = false, query, kinds }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const browser = asked.tab.linkedBrowser;
    const base = {
      ...describeTab(asked.tab),
      index: asked.index,
      label,
      detail: label,
      ...(elements ? { elements: true } : {}),
    };
    /**
     * A refusal outside the gate goes into `:mcp log` too (M23, M32).
     * @param {LogOutcome} outcome @param {unknown} error @param {object} [what]
     */
    const refuse = (outcome, error, what = base) => {
      AgentGate.note(conn, "vimma_activate", what, outcome);
      return error;
    };
    // Counted when asked, before anything else is learnt, so a refused call cannot loop (F26).
    if (!actCalls.take(conn, Date.now())) {
      throw refuse("busy", rateDenied(actCalls, conn, "vimma_activate and vimma_fill calls"));
    }
    if (elements) takeListSlot(conn, "vimma_activate", base);
    if (inUse(browser)) throw refuse("in-use", denied("in-use"));
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
      throw refuse("busy", rateDenied(opens, conn, "loads"));
    }
    const element = checked.element;
    /** @type {{ method: string, action: string, host: string, fields: number } | undefined} */
    let submit;
    if (element.submit) {
      let host = "";
      try {
        host = Services.io.newURI(element.submit.action).host;
      } catch {
        // no host to show in bold
      }
      submit = { ...element.submit, action: wf(element.submit.action), host: wf(host) };
    }
    // mcp-checkpoints C6: a click that may pay; Behaviour 4: what a submission sends.
    const pay = await AgentAct.payment(browser, { target: found.target, text: element.text });
    const sent = submit ? await AgentAct.sent(found.target, "click") : null;
    // mcp-consequence K1-K5: under a grant a form that pays nothing and sends no text, personal
    // details, secret or file runs unasked; `a` on the question of one that may be allowed makes
    // its button on this site run so for the rest of the grant.
    /** @type {true | string | undefined} */
    let covered;
    /** @type {{ site: string, key: string } | null} */
    let here = null;
    if (submit && element.submit && !pay) {
      const step = { pay: false, sent };
      const site = siteOfTab(asked.tab);
      const key = mayAllowHere(step)
        ? allowanceKey({
            site,
            method: element.submit.method,
            action: element.submit.action,
            text: element.text ?? "",
          })
        : null;
      if (key) here = { site: wf(site), key };
      covered = isConsequential(step) ? (key ?? undefined) : true;
    }
    const granted = AgentGate.grants().some((g) => g.conn === conn);
    const what = {
      ...base,
      kind: element.kind,
      text: wf(element.text ?? ""),
      detail: wf(actDetail(label, element)),
      ...(submit ? { submit } : {}),
      // The marks of K2 decided whether it asks; the question and the log show what it sends.
      ...(sent ? { sent: unmarked(sent) } : {}),
      ...(pay ? { pay } : {}),
      ...(here && granted ? { here } : {}),
    };
    // F15, mcp-checkpoints C1: a submission or a payment asks every time, also under a grant,
    // and its yes neither makes nor ends a grant, but for a form the grant covers (above).
    await ask(conn, "agent-activate", what, state, rid, undefined, !!submit || !!pay, covered);
    let found2;
    try {
      found2 = stillAsAsked(agent, id, what.url, conn);
    } catch (e) {
      throw refuse("changed", e, what);
    }
    const { win, tab } = found2;
    if (inUse(tab.linkedBrowser)) throw refuse("in-use", denied("in-use"), what);
    const result = await AgentShot.acting(tab.linkedBrowser, () =>
      AgentAct.activate(tab.linkedBrowser, found.target, {
        // The child clicks only if the element still submits there, and lets only that through.
        submit: element.submit
          ? {
              method: element.submit.method,
              action: element.submit.action,
              // mcp-consequence K1, K5: what the child checks again just before the press.
              ...(covered === true ? { check: "harmless" } : {}),
              ...(typeof covered === "string" ? { check: "allowed" } : {}),
            }
          : null,
        href: element.href ?? null,
        inUse: () => inUse(tab.linkedBrowser),
      }),
    );
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
    if (!now || now.id !== agent.id || win.closed || !isAgentTab(win, tab, agent, conn)) {
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
    // The page the click left, once it is ready: a page still loading is not listed (#584).
    const list = elements
      ? await stepList(conn, "vimma_activate", what, agent, win, tab, async () => notLoading(tab), {
          query,
          kinds,
        })
      : null;
    return {
      url: pageUrl(tabUrl(tab)),
      title: pageTitle(tab, ELEMENTS_TITLE_MAX),
      ...list,
      loading: result.loading,
      navigated: result.navigated,
      ...(result.dialog ? { dialog: result.dialog } : {}),
      ...(result.blocked ? { blocked: result.blocked } : {}),
      ...(result.stopped ? { stopped: result.stopped } : {}),
      ...(result.changed ? { changed: result.changed } : {}),
    };
  },

  /**
   * Fills fields of an agent tab, by their labels from the connection's last `vimma_elements`
   * there (mcp-forms F12-F14; security.md M27): every field is checked before the question and
   * any refused one refuses the call; a fill that submits asks every time (F15, M28); the fields
   * are set in the background, in order, each checked again in its child just before. A tab the
   * user is using is `in-use` (F27). Fills share the clicks' rate (F26).
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-fill"]} args
   * @param {number | undefined} rid
   */
  async "agent-fill"(
    conn,
    state,
    { tab: id, fields, submit: submitArg, elements = false, query, kinds },
    rid,
  ) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const browser = asked.tab.linkedBrowser;
    const labels = fields.map((f) => f.label).join(" ");
    const base = {
      ...describeTab(asked.tab),
      index: asked.index,
      detail: labels,
      ...(elements ? { elements: true } : {}),
    };
    /**
     * A refusal outside the gate goes into `:mcp log` too (M23, M32).
     * @param {LogOutcome} outcome @param {unknown} error @param {object} [what] @param {string} [why]
     */
    const refuse = (outcome, error, what = base, why) => {
      AgentGate.note(conn, "vimma_fill", what, outcome, why);
      return error;
    };
    // Counted when asked, before anything else is learnt, so a refused call cannot loop (F26).
    if (!actCalls.take(conn, Date.now())) {
      throw refuse("busy", rateDenied(actCalls, conn, "vimma_activate and vimma_fill calls"));
    }
    if (elements) takeListSlot(conn, "vimma_fill", base);
    if (inUse(browser)) throw refuse("in-use", denied("in-use"));
    /** @type {{ label: string, target: HintTarget, value: string | boolean, name: string,
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
    /** @type {{ by: "click" | "form", target: HintTarget, submit: { method: string,
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
      throw refuse("busy", rateDenied(opens, conn, "loads"));
    }
    /** @type {{ method: string, action: string, host: string, fields: number } | undefined} */
    let submit;
    if (submitting) {
      let host = "";
      try {
        host = Services.io.newURI(submitting.submit.action).host;
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
    // mcp-checkpoints C6: a fill that submits through a control that may pay; Behaviour 4: what
    // else the form sends besides the fields this call fills.
    const pay = submitting
      ? await AgentAct.payment(browser, { target: submitting.target, by: submitting.by })
      : null;
    const sent = submitting
      ? await AgentAct.sent(
          submitting.target,
          submitting.by,
          steps.map((s) => s.target),
        )
      : null;
    const what = {
      ...base,
      fields: shownFields,
      detail: wf(fillDetail(shownFields, submitting?.submit)),
      ...(submit ? { submit } : {}),
      ...(sent ? { sent } : {}),
      ...(pay ? { pay } : {}),
    };
    // F15: one yes sends what the question shows, so it must show every value whole.
    if (submit && !fillFits(what)) {
      const message =
        "a fill that submits must show every value whole in its question, and this one does not fit: fill first with vimma_fill, then submit with fewer or shorter values, or activate the submit button";
      throw refuse("failed", new AgentError("failed", message), what);
    }
    // F15, mcp-checkpoints C1: a submission asks every time, also under a grant, and its yes
    // neither makes nor ends a grant.
    await ask(conn, "agent-fill", what, state, rid, undefined, !!submit);
    let found2;
    try {
      found2 = stillAsAsked(agent, id, what.url, conn);
    } catch (e) {
      throw refuse("changed", e, what);
    }
    const { win, tab } = found2;
    if (inUse(tab.linkedBrowser)) throw refuse("in-use", denied("in-use"), what);
    const result = await AgentShot.acting(tab.linkedBrowser, () =>
      AgentAct.fill(
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
          inUse: () => inUse(tab.linkedBrowser),
          still: () => {
            try {
              stillAsAsked(agent, id, what.url, conn);
              return true;
            } catch {
              return false;
            }
          },
        },
      ),
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
    if (!now || now.id !== agent.id || win.closed || !isAgentTab(win, tab, agent, conn)) {
      // The tab left the agent workspace during the fill: nothing of it is said.
      AgentGate.note(conn, "vimma_fill", what, "stopped", "changed");
      throw new AgentError("failed", "the tab left the agent workspace during the fill");
    }
    if (result.blocked) noteBlocked(result.blocked);
    if (result.stopped) AgentGate.note(conn, "vimma_fill", what, "stopped", result.stopped);
    // The page after the fill, once it is ready: a page still loading is not listed (#584).
    const list = elements
      ? await stepList(conn, "vimma_fill", what, agent, win, tab, async () => notLoading(tab), {
          query,
          kinds,
        })
      : null;
    return {
      url: pageUrl(tabUrl(tab)),
      title: pageTitle(tab, ELEMENTS_TITLE_MAX),
      ...list,
      filled: result.filled,
      ...(result.reset ? { reset: result.reset } : {}),
      loading: result.loading,
      navigated: result.navigated,
      ...(result.dialog ? { dialog: result.dialog } : {}),
      ...(result.blocked ? { blocked: result.blocked } : {}),
      ...(result.stopped ? { stopped: result.stopped } : {}),
    };
  },

  /**
   * @param {ConnId} conn @param {AgentConn} state @param {AgentArgs["agent-close"]} args
   * @param {number | undefined} rid
   */
  async "agent-close"(conn, state, { tab: id }, rid) {
    const agent = agentWorkspace();
    const asked = findAgentTab(agent, id, conn);
    const what = { ...describeTab(asked.tab), index: asked.index };
    await ask(conn, "agent-close", what, state, rid);
    const { win, tab } = stillAsAsked(agent, id, what.url, conn);
    win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false, skipPermitUnload: true });
    return { closed: true };
  },
};

/**
 * A built-in conversation's context was cleared (builtin-agent B22), or its loop left out a block
 * of older results (agent-speed S5): its next element list of any site comes in full, since the
 * model may no longer have the lines a compact list would leave out (agent-speed S4).
 * @param {ConnId} conn
 */
export function forgetListedSites(conn) {
  listedSites.forget(conn);
}

/**
 * The connection closed: forget its opens.
 * @param {ConnId} conn
 */
export function forgetAgentConnection(conn) {
  opens.forget(conn);
  keyCalls.forget(conn);
  showCalls.forget(conn);
  elementCalls.forget(conn);
  listedSites.forget(conn);
  actCalls.forget(conn);
  shotCalls.forget(conn);
  consoleCalls.forget(conn);
  currentCtl.delete(conn);
  AgentDrive.forget(conn);
}

/**
 * A built-in conversation's own hello (docs/specs/builtin-agent.md B4): the connection is
 * registered with the gate under the conversation's label, never renamed as an MCP client's is.
 * Only AgentChat calls it, with a `builtin:` id that no socket connection has.
 * @param {ConnId} conn @param {AgentConn} state
 * @param {{ client: string, via?: string }} label
 */
export function builtinHello(conn, state, label) {
  if (!isBuiltinConn(conn)) throw new AgentError("bad-request", "not a built-in connection");
  if (state.agent) throw new AgentError("bad-request", "agent-hello was already sent");
  state.agent = { ...label };
  AgentGate.connect(conn, state.agent);
}

/**
 * Tab ownership for the built-in agent (B17): giving a tab to a conversation (Behaviour 17),
 * and a deleted conversation's tabs going back to no one. It stays here, not in agent-tabs.mjs,
 * so that the tab model has one importer (tools/layering/layers.ts, RESTRICTED): the built-in
 * agent reaches ownership through these three calls only.
 */
export const AgentTabOwners = {
  /** @param {Tab} tab @param {ConnId} conn */
  give(tab, conn) {
    ownTab(tab, conn);
  },
  /** @param {Tab} tab @returns {ConnId | null} */
  ownerOf(tab) {
    return ownerOf(tab);
  },
  /** @param {ConnId} conn */
  forget(conn) {
    forgetOwners(conn);
  },
};

/**
 * Each command's result, as its handler gives it.
 * @typedef {{ [C in AgentCommand]: Awaited<ReturnType<(typeof COMMANDS)[C]>> }} AgentResults
 */

/**
 * The handlers by command, each with its own arguments (core AgentArgs) and result.
 * @typedef {{ [C in AgentCommand]: (conn: ConnId, state: AgentConn, args: AgentArgs[C],
 *   rid: number | undefined) => AgentResults[C] | Promise<AgentResults[C]> }} Handlers
 */

/**
 * Starts a parsed command's handler: the arguments are the ones its command takes.
 * @template {AgentCommand} C
 * @param {{ command: C, args: AgentArgs[C] }} request @param {ConnId} conn
 * @param {AgentConn} state @param {number | undefined} rid
 */
function start(request, conn, state, rid) {
  /** @type {Handlers} */
  const handlers = COMMANDS;
  return handlers[request.command](conn, state, request.args, rid);
}

/**
 * Run an agent command, validated already. Its arguments are parsed again (core
 * parseAgentRequest), so whatever reaches a handler has the shape it reads, and the result is
 * that command's handler's. `state` is the connection's: `agent` once its hello is in. Rejects
 * with AgentError for every refusal.
 * @overload
 * @param {ConnId} conn @param {AgentConn} state @param {C} command @param {unknown} args
 * @param {number} [rid]
 * @returns {Promise<AgentResults[C]>}
 * @template {AgentCommand} C
 */
/**
 * @overload
 * @param {ConnId} conn @param {AgentConn} state @param {string} command @param {unknown} args
 * @param {number} [rid]
 * @returns {Promise<object>}
 */
/**
 * @param {ConnId} conn
 * @param {AgentConn} state
 * @param {string} command
 * @param {unknown} args
 * @param {number} [rid]  the request's id, which `agent-cancel` names
 * @returns {Promise<object>}
 */
export async function runAgentCommand(conn, state, command, args, rid) {
  if (command === "agent-hello") {
    if (state.agent) throw new AgentError("bad-request", "agent-hello was already sent");
  } else if (!state.agent) {
    throw new AgentError("bad-request", "agent-hello must be the connection's first command");
  }
  if (!AGENT_COMMANDS.includes(command)) {
    throw new AgentError("unknown-command", `unknown command ${command}`);
  }
  const request = parseAgentRequest(command, args);
  if (!request) throw new AgentError("invalid-args", `${command}: invalid arguments`);
  // The tab the command names runs at foreground priority from the request until its reply,
  // the wait for the user's answer included (issue #605). The handler starts before this
  // function first awaits, as any other command: questions keep the order their requests came
  // in.
  const tab = "tab" in request.args ? request.args.tab : undefined;
  const release = request.command === "agent-hello" ? null : raiseNamedTab(conn, tab);
  try {
    return await start(request, conn, state, rid);
  } finally {
    release?.();
  }
}

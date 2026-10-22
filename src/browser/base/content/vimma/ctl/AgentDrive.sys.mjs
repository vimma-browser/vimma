/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `vimma_keys`'s steps, run on one agent tab (docs/specs/mcp-drive.md D8, D11, D13, D16;
// security.md M16, M17). Each step is a Vimma action on that tab's <browser>, never a key event:
// no page script sees a keydown, nothing is typed. The tab is never selected, shown or focused,
// and the window's workspace, mode, find bar and hint mode are never touched: scrolls go to the
// top frame without smooth scrolling (a background tab's refresh driver is throttled), finds go
// through the tab's own finder, and history moves within the tab's own session history. Core
// (agent-keys.mjs) parsed and whitelisted the steps; agent-commands.mjs asked first.
//
// `f` lists the tab's visible links with labels (D12, D16; security.md M21), collected under the
// tab's own key so the user's hint mode is left alone, and kept per tab and connection, bound to
// the document they were collected from, for AGENT_LINKS.ttlMs. `f<label>` follows one as a load
// of its href with the page's own principal, in the same tab: no click event fires, so no page
// handler runs (M18). A link to another site is asked as a `vimma_open` of its URL first (D18).
// `vimma_elements` (ctl/AgentAct.sys.mjs, docs/specs/mcp-forms.md F3) keeps its labels in the
// same store, each list replacing the other; `f<label>` follows only a link from either, and from
// an element list only while the link is still in the page (F4).

import { AGENT_LINKS, agentLinkList, labelAgentLinks } from "../core/agent-keys.mjs";
import { wrapUntrusted } from "../core/agent.mjs";
import { isCaseSensitive } from "../core/find.mjs";
import { urlRoot, urlUp } from "../core/pageurl.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";

/** @import { AgentStep } from "../core/agent-keys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long a step waits for the page it loaded (agent-commands' LOAD_TIMEOUT_MS). */
const LOAD_TIMEOUT_MS = 20000;
/** How long a find waits for the finder's answer. */
const FIND_TIMEOUT_MS = 5000;
/** nsITypeAheadFind's results. */
const FIND_NOTFOUND = 1;
const FIND_WRAPPED = 2;

/**
 * @typedef {any} Tab
 * @typedef {any} Browser
 * @typedef {{ keys: string, action: string, ok: boolean, note?: string }} StepResult
 * @typedef {{ query: string, found: boolean, wrapped: boolean }} FindResult
 * @typedef {{ url: string, title: string, loading: boolean, scroll: { y: number },
 *   steps: StepResult[], stopped?: "changed" | "in-use" | "timeout" | "denied",
 *   find?: FindResult, links?: string, dropped?: number }} KeysResult
 * @typedef {{ mark: { doc: number, url: string }, at: number, source: "links" | "elements",
 *   byLabel: Map<string, import("../actors/VimmaActors.sys.mjs").HintTarget> }} LinkSession
 *   one `f`'s or `vimma_elements`' labels: the page they were collected on, when, and by which
 *   (D12; mcp-forms F3)
 * @typedef {object} DriveContext
 * @property {unknown} conn  the agent connection: its labels are its own
 * @property {(url: string, until: number) => Promise<string | null>} askOpen  asks a cross-site
 *   follow of `url` as a `vimma_open` (D18), or runs it under a `vimma_open` grant, withdrawn
 *   at `until`; null when it may load, else the denial's reason
 * @property {(url: string, keys: string) => void} followed  a follow loaded `url`: into
 *   `:mcp log`, and a grant's notice names its host (D14, M23)
 * @property {() => boolean} canLoad  whether the open rate has a slot left, without taking it
 * @property {() => boolean} stillAgent  the tab is still an agent tab (M2), checked before
 *   each step
 * @property {(url: string) => boolean} load  loads `url` in the tab as the agent's (its
 *   principal, its downloads, a slot of the open rate); false when the rate is used up
 * @property {(url: string) => boolean} countLoad  a history load of `url`: a slot of the open
 *   rate, its downloads the agent's; false when the rate is used up
 * @property {number} deadline  ms since the epoch: the call stops here (D15)
 */

/** The most the link list may take of the 1 MiB reply line (protocol decision 4). */
const LINKS_BYTES = 768 * 1024;

/** What a step says when a cross-site follow was not allowed, by the denial's reason. */
const NOT_ALLOWED = /** @type {Record<string, string>} */ ({
  user: "the user did not allow loading",
  timeout: "no answer in Vimma to loading",
  muted: "this agent is muted in Vimma; it did not load",
  busy: "too many agent requests wait in Vimma; it did not load",
  cancelled: "the question was withdrawn; it did not load",
});

/**
 * A page links are listed and followed on: a web page (D12). A tab moved into the agent
 * workspace may show a file, about: or the start page, whose principals may load anything.
 * @param {any} principal nsIPrincipal
 */
const onTheWeb = (principal) =>
  !!principal?.isContentPrincipal && (principal.schemeIs("http") || principal.schemeIs("https"));

/** Each connection's labels, per agent tab (D12). @type {Map<unknown, WeakMap<object, LinkSession>>} */
const sessions = new Map();

/**
 * A URI's site, its registrable domain (eTLD+1, D18); its host when it has none (an IP address,
 * localhost).
 * @param {any} uri nsIURI
 */
function siteOf(uri) {
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    return String(uri?.asciiHost ?? "");
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => lazy.setTimeout(resolve, ms));

/** What a label of something other than a link names, in a refused follow (mcp-forms F3). */
const KIND_NAMES = /** @type {Record<string, string>} */ ({
  button: "a button",
  field: "a field",
  checkbox: "a checkbox",
  radio: "a radio button",
  select: "a select",
  click: "a clickable element",
  link: "a link without an address",
});

/** How long one query to the page's child may take: a hung content process must not hold a call. */
const ACTOR_TIMEOUT_MS = 5000;

/**
 * `promise`, or `fallback` after ACTOR_TIMEOUT_MS or once `deadline` passed, whichever is first.
 * @template T
 * @param {Promise<T>} promise @param {T} fallback @param {number} deadline
 * @returns {Promise<T>}
 */
function bounded(promise, fallback, deadline) {
  const ms = Math.max(0, Math.min(ACTOR_TIMEOUT_MS, deadline - Date.now()));
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

/** @param {unknown} s  well-formed, so the reply is one line vimma-ctl's parser takes */
const wf = (s) => /** @type {string} */ (/** @type {any} */ (String(s ?? "")).toWellFormed());

const SCROLLS = /** @type {Record<string, import("../actors/VimmaActors.sys.mjs").ScrollKind>} */ ({
  "scroll.down": "down",
  "scroll.up": "up",
  "scroll.left": "left",
  "scroll.right": "right",
  "scroll.half_down": "half_down",
  "scroll.half_up": "half_up",
  "scroll.top": "top",
  "scroll.bottom": "bottom",
});

/**
 * What the page is now, to see when a load it started is through: its document, and its URL
 * (a same-document navigation keeps the document).
 * @param {Browser} browser
 */
function pageMark(browser) {
  return {
    doc: browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0,
    url: String(browser.currentURI?.spec ?? ""),
  };
}

/**
 * Waits until the page left `mark` and finished loading, or until `until`.
 * @param {Browser} browser @param {{ doc: number, url: string }} mark @param {number} until
 * @returns {Promise<boolean>} whether it loaded in time
 */
async function loaded(browser, mark, until) {
  for (;;) {
    const now = pageMark(browser);
    const moved = now.doc !== mark.doc || now.url !== mark.url;
    if (moved && !browser.webProgress?.isLoadingDocument) return true;
    if (Date.now() > until) return false;
    await sleep(50);
  }
}

/**
 * One find on the tab's own finder, never the window's find bar (D11): resolves with
 * nsITypeAheadFind's result, or null if the finder did not answer.
 * @param {Browser} browser @param {string} query @param {boolean} again @param {boolean} backward
 * @returns {Promise<number | null>}
 */
function findOnce(browser, query, again, backward) {
  const finder = browser.finder;
  return new Promise((resolve) => {
    let done = false;
    const listener = {
      onFindResult(/** @type {any} */ data) {
        if (done || String(data?.searchString ?? "") !== query) return;
        finish(Number(data.result));
      },
      onMatchesCountResult() {},
      onHighlightFinished() {},
      onCurrentSelection() {},
      // The agent's find never moves focus into the page (M16).
      shouldFocusContent: () => false,
    };
    /** @param {number | null} result */
    const finish = (result) => {
      done = true;
      finder.removeResultListener(listener);
      resolve(result);
    };
    finder.addResultListener(listener);
    finder.caseSensitive = isCaseSensitive(query);
    // The page's child may give back a focus this step's match takes (VimmaChild, #442).
    VimmaActors.findStep(browser);
    if (again) finder.findAgain(query, backward, false, false);
    else finder.fastFind(query, false, false);
    lazy.setTimeout(() => !done && finish(null), FIND_TIMEOUT_MS);
  });
}

export const AgentDrive = {
  /** Test-only: called after each step with the number of steps done. */
  _onStep: /** @type {((n: number) => void | Promise<void>) | null} */ (null),
  /** Test-only: how long labels live, in place of AGENT_LINKS.ttlMs. */
  _linkTtlMs: /** @type {number | null} */ (null),

  /**
   * The connection closed: its labels go.
   * @param {unknown} conn
   */
  forget(conn) {
    sessions.delete(conn);
  },

  /**
   * A connection's labels for the page now in `browser`, in place of its last `f`'s or list's
   * (D12; mcp-forms F3).
   * @param {unknown} conn @param {Browser} browser
   * @param {Map<string, import("../actors/VimmaActors.sys.mjs").HintTarget>} byLabel
   * @param {"links" | "elements"} source
   */
  remember(conn, browser, byLabel, source) {
    let labels = sessions.get(conn);
    if (!labels) sessions.set(conn, (labels = new WeakMap()));
    labels.set(browser, { mark: pageMark(browser), at: Date.now(), source, byLabel });
  },

  /**
   * Runs `steps` on `tab`, in order, in the background.
   * @param {Tab} tab @param {AgentStep[]} steps @param {DriveContext} ctx
   * @returns {Promise<KeysResult>}
   */
  async run(
    tab,
    steps,
    { conn, askOpen, followed, canLoad, stillAgent, load, countLoad, deadline },
  ) {
    const browser = tab.linkedBrowser;
    /** @type {StepResult[]} */
    const done = [];
    /** @type {KeysResult["stopped"]} */
    let stopped;
    /** @type {{ query: string, backward: boolean } | null} the call's last search */
    let last = null;
    /** @type {FindResult | undefined} */
    let find;
    /** @type {{ text: string, dropped: number } | undefined} the call's link list */
    let links;
    let labels = sessions.get(conn);
    if (!labels) sessions.set(conn, (labels = new WeakMap()));
    const ttl = this._linkTtlMs ?? AGENT_LINKS.ttlMs;
    /** Whether `session` still names the links of the page in the tab (D12). */
    const current = (/** @type {LinkSession | undefined} */ session) => {
      if (!session || Date.now() - session.at >= ttl) return false;
      const now = pageMark(browser);
      return now.doc === session.mark.doc && now.url === session.mark.url;
    };

    /** Why the call must stop now, or null. @returns {KeysResult["stopped"] | null} */
    const halt = () =>
      Date.now() > deadline
        ? "timeout"
        : !stillAgent()
          ? "changed"
          : VimmaHost.inUse(browser)
            ? "in-use"
            : null;

    for (const step of steps) {
      const why = halt();
      if (why) {
        stopped = why;
        break;
      }
      /** @type {StepResult} */
      const result = { keys: step.keys, action: step.action, ok: true };
      const count = step.count ?? 1;
      try {
        const id = step.action;
        if (id in SCROLLS) {
          const kind = /** @type {any} */ (SCROLLS)[id];
          const moved = await bounded(
            VimmaActors.scroll(browser, kind, count, { instant: true, top: true }),
            false,
            deadline,
          );
          if (!moved) Object.assign(result, { ok: false, note: "nothing on the page scrolls" });
        } else if (id === "history.back" || id === "history.forward") {
          const history = browser.browsingContext?.sessionHistory;
          const delta = id === "history.back" ? -count : count;
          const index = history ? history.index : 0;
          const target = history ? Math.min(Math.max(index + delta, 0), history.count - 1) : index;
          if (!history || target === index) {
            const where = delta < 0 ? "back to" : "forward to";
            Object.assign(result, { ok: false, note: `no page to go ${where} in this tab` });
          } else if (!/^https?:/i.test(String(history.getEntryAtIndex(target)?.URI?.spec ?? ""))) {
            // An entry the user reached in this tab before it was the agent's (about:, file:).
            Object.assign(result, { ok: false, note: "that history entry is not a web page" });
          } else if (!countLoad(String(history.getEntryAtIndex(target).URI.spec))) {
            Object.assign(result, {
              ok: false,
              note: "too many loads from this agent in the last minute",
            });
            done.push(result);
            stopped = "denied";
            break;
          } else {
            const mark = pageMark(browser);
            browser.gotoIndex(target);
            if (!(await loaded(browser, mark, Math.min(deadline, Date.now() + LOAD_TIMEOUT_MS)))) {
              result.note = "the page is still loading";
            }
          }
        } else if (id === "page.url_up" || id === "page.url_root") {
          const here = String(browser.currentURI?.spec ?? "");
          const url = id === "page.url_up" ? urlUp(here, count) : urlRoot(here);
          if (!url || !/^https?:/i.test(url)) {
            Object.assign(result, { ok: false, note: "already at the top of the site" });
          } else {
            const mark = pageMark(browser);
            if (!load(url)) {
              Object.assign(result, {
                ok: false,
                note: "too many loads from this agent in the last minute",
              });
              done.push(result);
              stopped = "denied";
              break;
            }
            if (!(await loaded(browser, mark, Math.min(deadline, Date.now() + LOAD_TIMEOUT_MS)))) {
              result.note = "the page is still loading";
            }
          }
        } else if (id === "hint.follow" && !onTheWeb(browser.contentPrincipal)) {
          Object.assign(result, {
            ok: false,
            note: "links are listed and followed only on http and https pages",
          });
        } else if (id === "hint.follow" && step.label === undefined) {
          // `f`: the visible links, labelled (D12), as the call's link list (D16).
          const targets = await bounded(
            VimmaActors.collectHints(browser, "hint.follow", { agent: true }),
            [],
            deadline,
          );
          const { links: labelled, dropped } = labelAgentLinks(targets);
          // The reply is one line: links past its room are left out, and their labels too.
          const list = agentLinkList(labelled, LINKS_BYTES);
          const listed = labelled.slice(0, labelled.length - list.omitted);
          this.remember(conn, browser, new Map(listed.map((l) => [l.label, l.target])), "links");
          links = { text: wrapUntrusted(wf(list.text)), dropped: dropped + list.omitted };
          if (!labelled.length) result.note = "no links on screen";
        } else if (id === "hint.follow") {
          // `f<label>`: a load of the link's href, never a click (D12, D18; M18).
          const label = /** @type {string} */ (step.label);
          const session = labels.get(browser);
          const target = current(session) ? session?.byLabel.get(label) : undefined;
          const url = target ? URL.parse(target.href ?? "") : null;
          if (!current(session) || (target && target.bc.currentWindowGlobal !== target.wg)) {
            Object.assign(result, { ok: false, note: "stale labels: send f again" });
          } else if (!target) {
            Object.assign(result, { ok: false, note: `no link has the label "${label}"` });
          } else if (target.kind !== "link") {
            // mcp-forms F3: a label of a button never becomes a load.
            const what = KIND_NAMES[target.info?.kind ?? "click"] ?? "a clickable element";
            const note = `label "${label}" is ${what}, not a link: f follows links only`;
            Object.assign(result, { ok: false, note });
          } else if (
            session?.source === "elements" &&
            !(await bounded(VimmaActors.agentElementAlive(target), false, deadline))
          ) {
            // mcp-forms F4: the page replaced the link since it was listed.
            Object.assign(result, {
              ok: false,
              note: "that element is gone: call vimma_elements again",
            });
          } else if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
            Object.assign(result, { ok: false, note: "only http and https links are followed" });
          } else {
            const wg = target.wg;
            const principal = wg.documentPrincipal;
            let linkable = true;
            try {
              Services.scriptSecurityManager.checkLoadURIWithPrincipal(
                principal,
                url.URI,
                Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL,
              );
            } catch {
              linkable = false;
            }
            const elsewhere = linkable && siteOf(url.URI) !== siteOf(browser.currentURI);
            /** @type {string | null} */
            let refused = null;
            if (!linkable || !onTheWeb(principal)) {
              Object.assign(result, { ok: false, note: "the page may not link there" });
            } else if (!canLoad()) {
              // Before any question: a yes must not end in "too many loads".
              Object.assign(result, {
                ok: false,
                note: "too many loads from this agent in the last minute",
              });
              done.push(result);
              stopped = "denied";
              break;
            } else if (elsewhere && (refused = await askOpen(url.href, deadline)) !== null) {
              // D18: another site is a vimma_open of its URL; a no stops the call.
              const why = NOT_ALLOWED[refused] ?? `Vimma did not load (${refused})`;
              Object.assign(result, { ok: false, note: `${why} ${wf(url.hostname)}` });
              done.push(result);
              // Withdrawn because the call's 60 s ran out: the call timed out (D15).
              stopped = refused === "cancelled" && Date.now() >= deadline ? "timeout" : "denied";
              break;
            } else if (elsewhere && halt()) {
              // The question took a while: the call may have run out, or the tab moved on.
              Object.assign(result, { ok: false, note: "the call stopped while it was asked" });
              done.push(result);
              stopped = /** @type {any} */ (halt());
              break;
            } else if (!current(session) || target.bc.currentWindowGlobal !== wg) {
              Object.assign(result, { ok: false, note: "stale labels: send f again" });
            } else if (!countLoad(url.href)) {
              Object.assign(result, {
                ok: false,
                note: "too many loads from this agent in the last minute",
              });
              done.push(result);
              stopped = "denied";
              break;
            } else {
              const mark = pageMark(browser);
              labels.delete(browser);
              VimmaActors.loadLink(browser, target, url.URI);
              const until = Math.min(deadline, Date.now() + LOAD_TIMEOUT_MS);
              if (!(await loaded(browser, mark, until))) result.note = "the page is still loading";
              followed(url.href, step.keys);
            }
          }
        } else {
          // find.forward, find.backward, find.next, find.previous (D11).
          const fresh = id === "find.forward" || id === "find.backward";
          if (fresh)
            last = { query: /** @type {string} */ (step.query), backward: id === "find.backward" };
          if (!last) {
            Object.assign(result, { ok: false, note: "no search to repeat in this call" });
          } else if (VimmaHost.isFocusedPage(browser)) {
            // The finder focuses a text field its match is in when the page has the user's focus
            // (nsTypeAheadFind), and the page's focus handlers would run (M16): a find runs only
            // in a tab the user's focus is not in.
            Object.assign(result, {
              ok: false,
              note: "the user's focus is in this tab; a find runs only in the background",
            });
          } else {
            const backward = id === "find.previous" ? !last.backward : last.backward;
            let outcome = null;
            for (let i = 0; i < count; i++) {
              if (i > 0 && halt()) break;
              outcome = await findOnce(browser, last.query, !fresh || i > 0 || backward, backward);
              if (outcome === null || outcome === FIND_NOTFOUND) break;
            }
            const found = outcome !== null && outcome !== FIND_NOTFOUND;
            find = { query: wf(last.query), found, wrapped: outcome === FIND_WRAPPED };
            if (!found) {
              Object.assign(result, {
                ok: false,
                note: outcome === null ? "the page did not answer the find" : "not found",
              });
            }
          }
        }
      } catch (e) {
        // Fixed text: an error's message could carry the page's words past the untrusted header.
        console.error("vimma agent-keys:", step.action, e);
        Object.assign(result, { ok: false, note: "Vimma could not run this step" });
      }
      done.push(result);
      await this._onStep?.(done.length);
    }

    // The tab left the agent workspace on the last step: nothing of it is said (M2).
    if (!stillAgent()) {
      return {
        url: "",
        title: "",
        loading: false,
        scroll: { y: 0 },
        steps: done,
        stopped: "changed",
      };
    }
    /** @type {KeysResult} */
    const out = {
      url: wf(browser.currentURI?.spec ?? ""),
      title: wf(tab.label ?? ""),
      loading: !!browser.webProgress?.isLoadingDocument || tab.hasAttribute("busy"),
      scroll: {
        y:
          Math.round(
            (await bounded(VimmaActors.scrollFraction(browser), 0, Date.now() + ACTOR_TIMEOUT_MS)) *
              1000,
          ) / 1000,
      },
      steps: done,
    };
    if (stopped) out.stopped = stopped;
    if (find) out.find = find;
    if (links) Object.assign(out, { links: links.text, dropped: links.dropped });
    return out;
  },
};

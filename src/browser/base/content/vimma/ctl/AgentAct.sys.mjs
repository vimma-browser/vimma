/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Agents acting on a page of the agent workspace (docs/specs/mcp-forms.md). `elements` lists an
// agent tab's buttons, fields, links and other clickable elements on screen with hint labels
// (F2-F7; security.md M25, M31): collected under the tab's own key in each frame's child, which
// keeps the agent's elements apart from the user's hint mode (F4), described there with
// sensitive fields' values left out (F6), labelled and written out by core (agent-act.mjs),
// inside the untrusted-content delimiters. Nothing on the page is touched: no element is
// focused, clicked or changed, and the tab is never selected or shown. agent-commands.mjs asked
// first, and puts the labels into AgentDrive's store, where `f<label>` follows only links (F3).
//
// `activate` clicks one of those elements (F8-F11, F16; security.md M26, M28, M29): the frame's
// child checks it is still what the user was asked about and calls its `click()`, never an event
// through the widget or nsIDOMWindowUtils, so the page gets no user activation. Before the
// click the tab is marked in the parent, so that a form submission there afterwards, from any
// frame and however started, without the user's own activation and other than the one the
// question allowed, is cancelled at its request; the result names the hosts of those, whether a
// page loaded, and a dialog the page opened, which no agent answers.

import {
  AGENT_ELEMENTS,
  actRefusal,
  agentElementList,
  labelAgentElements,
} from "../core/agent-act.mjs";
import { ELEMENT_REPLY_CAPS } from "../core/agent-element.mjs";
import { cutTo, shown } from "../core/agent-keys.mjs";
import { wrapUntrusted } from "../core/agent.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";

/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long the page's frames may take to answer: a hung content process must not hold a call. */
const COLLECT_TIMEOUT_MS = 5000;
/** How long a click's call waits for a page it started (mcp-drive D13, mcp-forms F11). */
const LOAD_TIMEOUT_MS = 20000;
/** How long after a click a page that has started no load is taken to have none to start. */
const SETTLE_MS = 1000;
/** A dialog's text in the result, in code points (F11). */
const DIALOG_TEXT_MAX = 200;
/** The page dialogs a result names, by the prompt service's type (F11). */
const DIALOGS = /** @type {Record<string, string>} */ ({
  alert: "alert",
  alertCheck: "alert",
  confirm: "confirm",
  confirmCheck: "confirm",
  confirmEx: "confirm",
  prompt: "prompt",
});

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => lazy.setTimeout(resolve, ms));

/**
 * `promise`, or `fallback` after `ms`.
 * @template T
 * @param {Promise<T>} promise @param {T} fallback @param {number} ms
 * @returns {Promise<T>}
 */
const bounded = (promise, fallback, ms) => Promise.race([promise, sleep(ms).then(() => fallback)]);

/**
 * A URI's site, its registrable domain (eTLD+1, mcp-drive D18); its host when it has none.
 * @param {any} uri nsIURI
 */
function uriSite(uri) {
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    return String(uri?.asciiHost ?? "");
  }
}

/**
 * Where a link a click would follow goes, against the tab's page (F10): another site, or not a
 * web page at all. `javascript:` runs in the page and loads nothing, so it counts as neither.
 * @param {any} browser XULBrowserElement @param {string | undefined} href
 */
function linkWhere(browser, href) {
  if (href === undefined) return { crossSite: false, otherScheme: false };
  /** @type {any} */
  let uri;
  try {
    uri = Services.io.newURI(href);
  } catch {
    return { crossSite: false, otherScheme: true };
  }
  if (uri.schemeIs("javascript")) return { crossSite: false, otherScheme: false };
  if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
    return { crossSite: false, otherScheme: true };
  }
  return { crossSite: uriSite(uri) !== uriSite(browser.currentURI), otherScheme: false };
}

/**
 * Each tab's running click, so that two calls on one tab never share its mark: the next waits
 * for the last to settle (F16).
 * @type {WeakMap<object, Promise<unknown>>}
 */
const running = new WeakMap();

/** @param {any} browser  the top document's id */
const docOf = (browser) => browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;

/** @param {unknown} s  well-formed, so the reply is one line vimma-ctl's parser takes */
const wf = (s) => /** @type {string} */ (/** @type {any} */ (String(s ?? "")).toWellFormed());

/**
 * A web page (mcp-drive D12): a tab moved into the agent workspace may show a file, about: or
 * the start page, which is not the agent's to act on.
 * @param {any} principal nsIPrincipal
 */
const onTheWeb = (principal) =>
  !!principal?.isContentPrincipal && (principal.schemeIs("http") || principal.schemeIs("https"));

/**
 * A document's site, from its principal (mcp-drive D18): a srcdoc or about:blank frame inherits
 * its parent's, which its URI does not say. Empty when it has none.
 * @param {any} principal nsIPrincipal
 */
function siteOf(principal) {
  try {
    return String(principal?.baseDomain || principal?.host || "");
  } catch {
    return "";
  }
}

/** @param {any} principal nsIPrincipal  its host, or "" */
function hostOf(principal) {
  try {
    return String(principal?.asciiHost ?? "");
  } catch {
    return "";
  }
}

export const AgentAct = {
  /** Test-only: SETTLE_MS's place, so a test of many clicks stays quick. */
  _settleMs: /** @type {number | null} */ (null),

  /**
   * The element a label names, as it is now, if an agent may click it (F4, F9, F10; security.md
   * M29): what the question shows, or why it is refused. Nothing on the page changes.
   * @param {any} browser XULBrowserElement @param {HintTarget} target @param {string} label
   * @returns {Promise<{ element: import("../core/agent-act.mjs").ActTarget } | { refused: string }>}
   */
  async clickable(browser, target, label) {
    if (!onTheWeb(target.wg?.documentPrincipal) || !onTheWeb(browser.contentPrincipal)) {
      return { refused: "elements are clicked only on http and https pages" };
    }
    const element = await bounded(VimmaActors.agentInspect(target), null, COLLECT_TIMEOUT_MS);
    if (!element) return { refused: "the page did not answer in time" };
    const refused = actRefusal(label, element, linkWhere(browser, element.href));
    if (refused) return { refused };
    // A destination cut to the child's cap could not be shown, nor matched at its request.
    if (element.submit && element.submit.action.length >= ELEMENT_REPLY_CAPS.action) {
      return { refused: "that form's destination is too long to show; nothing was asked" };
    }
    // Page strings for the question, as the list shows them (security.md M31).
    const text = cutTo(
      shown(element.text ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      AGENT_ELEMENTS.text,
    );
    return { element: { ...element, text } };
  },

  /**
   * Clicks `target`'s element in the background (F8, F11, F16; security.md M26, M28), once
   * `clickable` said it may be and the user allowed it, then waits for a page the click started
   * (up to 20 s), a dialog it opened, or the user starting to use the tab.
   * @param {any} browser XULBrowserElement @param {HintTarget} target
   * @param {{ submit: { method: string, action: string } | null, href: string | null,
   *   inUse: () => boolean }} asked  `submit`: the submission the question named
   * @returns {Promise<{ refused: string, blocked?: string } | { navigated: boolean,
   *   loading: boolean, dialog?: { type: string, text: string }, blocked?: string,
   *   stopped?: "in-use" }>}
   */
  activate(browser, target, asked) {
    const last = running.get(browser) ?? Promise.resolve();
    const run = last.then(() => this.activateNow(browser, target, asked));
    running.set(
      browser,
      run.catch(() => {}),
    );
    return run;
  },

  /**
   * `activate`, once no other click runs on the tab.
   * @param {any} browser XULBrowserElement @param {HintTarget} target
   * @param {{ submit: { method: string, action: string } | null, href: string | null,
   *   inUse: () => boolean }} asked
   * @returns {Promise<{ refused: string, blocked?: string } | { navigated: boolean,
   *   loading: boolean, dialog?: { type: string, text: string }, blocked?: string,
   *   stopped?: "in-use" }>}
   */
  async activateNow(browser, target, { submit, href, inUse }) {
    const before = { doc: docOf(browser), url: String(browser.currentURI?.spec ?? "") };
    const marked = await bounded(VimmaActors.agentMark(browser, submit), false, COLLECT_TIMEOUT_MS);
    if (!marked) return { refused: "the page did not answer in time" };
    /** @type {{ type: string, text: string } | null} */
    let dialog = null;
    const top = browser.browsingContext;
    const observer = (/** @type {any} */ subject) => {
      try {
        const args = subject?.Dialog?.args ?? subject?.args;
        if (dialog || args?.owningBrowsingContext?.top !== top) return;
        const type = DIALOGS[String(args.promptType)];
        if (!type) return;
        const text = wf(cutTo(shown(String(args.text ?? "")), DIALOG_TEXT_MAX));
        dialog = { type, text: wrapUntrusted(text) };
      } catch {
        // not a dialog of this tab
      }
    };
    Services.obs.addObserver(observer, "common-dialog-loaded");
    try {
      // The child clicks nothing once this call has stopped waiting for its answer.
      const until = Date.now() + COLLECT_TIMEOUT_MS - 1000;
      const reply = await bounded(
        VimmaActors.agentActivate(target, { submit, href, until }),
        "gone",
        COLLECT_TIMEOUT_MS,
      );
      if (reply === "gone") return { refused: "that element is gone: call vimma_elements again" };
      if (reply === "changed") {
        return { refused: "the element changed since it was asked about; nothing was clicked" };
      }
      const start = Date.now();
      const settle = this._settleMs ?? SETTLE_MS;
      let started = false;
      /** @type {"in-use" | undefined} */
      let stopped;
      for (;;) {
        await sleep(50);
        if (dialog) break;
        if (inUse()) {
          stopped = "in-use";
          break;
        }
        const loading = !!browser.webProgress?.isLoadingDocument;
        const moved =
          docOf(browser) !== before.doc || String(browser.currentURI?.spec ?? "") !== before.url;
        if (loading || moved) started = true;
        if (started && !loading) break;
        if (!started && Date.now() - start >= settle) break;
        if (Date.now() - start >= LOAD_TIMEOUT_MS) break;
      }
      const outcome = await bounded(
        VimmaActors.agentClickOutcome(target),
        "clicked",
        COLLECT_TIMEOUT_MS,
      );
      const blocked = VimmaActors.agentSettle(browser);
      if (outcome === "skipped") {
        // The page's handlers of the mouse events ran: what they tried to submit is still said.
        return {
          refused: "the element changed as it was clicked; nothing was clicked",
          ...(blocked.length ? { blocked: blocked[0] } : {}),
        };
      }
      return {
        navigated: docOf(browser) !== before.doc,
        loading: !!browser.webProgress?.isLoadingDocument,
        ...(dialog ? { dialog } : {}),
        ...(blocked.length ? { blocked: blocked[0] } : {}),
        ...(stopped ? { stopped } : {}),
      };
    } finally {
      // On every path: no allowance outlives its call.
      VimmaActors.agentSettle(browser);
      Services.obs.removeObserver(observer, "common-dialog-loaded");
    }
  },

  /**
   * The elements on screen in `tab`, labelled, as the reply's `elements` and `dropped`, with the
   * labels for AgentDrive.remember once the caller has checked the tab again; or why nothing is
   * listed.
   * @param {any} tab
   * @returns {Promise<{ elements: string, dropped: number, labels: Map<string, HintTarget> }
   *   | { refused: string }>}
   */
  async elements(tab) {
    const browser = tab.linkedBrowser;
    if (!onTheWeb(browser.contentPrincipal)) {
      return { refused: "elements are listed only on http and https pages" };
    }
    const late = new Promise((resolve) => lazy.setTimeout(resolve, COLLECT_TIMEOUT_MS, null));
    const collected = await Promise.race([
      VimmaActors.collectHints(browser, "hint.follow", { agent: true, elements: true }),
      late,
    ]);
    if (!collected) return { refused: "the page did not answer in time" };
    const targets = /** @type {HintTarget[]} */ (collected).filter((t) => t.info);
    const top = browser.browsingContext?.currentWindowGlobal;
    const site = siteOf(top?.documentPrincipal);
    // An element in a frame of another site says so (F5): its text is that site's.
    const items = targets.map((hint) => {
      const principal = hint.wg?.documentPrincipal;
      const frame = hint.wg !== top && siteOf(principal) !== site ? hostOf(principal) : "";
      return {
        rect: hint.rect,
        href: hint.href,
        info: /** @type {NonNullable<HintTarget["info"]>} */ (hint.info),
        form: hint.form,
        ...(frame ? { frame } : {}),
        hint,
      };
    });
    const { elements, dropped } = labelAgentElements(items);
    const list = agentElementList(elements, AGENT_ELEMENTS.bytes);
    // The reply is one line: elements past its room are left out, and their labels too.
    const listed = elements.slice(0, elements.length - list.omitted);
    return {
      elements: wrapUntrusted(wf(list.text)),
      dropped: dropped + list.omitted,
      labels: new Map(listed.map((l) => [l.label, l.target.hint])),
    };
  },
};

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
// page loaded, and a dialog the page opened, which no agent answers. When no page loaded, the
// child compares the page with its state just before the click and the result names, in fixed
// words, what changed in place (#510), so an agent never reads an in-place update as a failure.
//
// `fill` sets fields of that list (F12-F14; security.md M27) as form autofill does: the field's
// child checks that it is still what the question showed and not sensitive, just before each
// set, and sets it with `setUserInput`, a select's own end of a user's choice, or a checkbox's
// `click()`, never focusing it. The tab is marked first, as for a click, and a submission the
// question allowed (a submit button's click, or the form's default submission) runs last.
//
// `payment` and `sent` say what a step's checkpoint shows (docs/specs/mcp-checkpoints.md;
// security.md M28, M33): whether it may pay, by a card field in any frame of the tab or the
// pressed control's words, with the total the page states, and what a submission sends.

import {
  AGENT_ELEMENTS,
  actRefusal,
  agentElementList,
  fillRefusal,
  labelAgentElements,
} from "../core/agent-act.mjs";
import { isPayStep, pageText, statedTotal } from "../core/agent-checkpoint.mjs";
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

/** A URI's host, or "" for one without a host. @param {any} uri nsIURI */
function uriHost(uri) {
  try {
    return String(uri?.host ?? "");
  } catch {
    return "";
  }
}

/**
 * The host of a frame of another site than the tab's page, or "" when the frame is of the same
 * site or either has no host (about:blank and about:srcdoc frames take their parent's origin).
 * @param {any} frameUri nsIURI @param {any} tabUri nsIURI
 */
function otherSiteHost(frameUri, tabUri) {
  const host = uriHost(frameUri);
  if (!host || !uriHost(tabUri)) return "";
  try {
    return uriSite(frameUri) === uriSite(tabUri) ? "" : host;
  } catch {
    return "";
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

/**
 * @typedef {{ refused: string, filled: number, changed?: boolean, navigated?: boolean,
 *   blocked?: string }
 *   | { filled: number, reset?: string[], navigated: boolean, loading: boolean,
 *   dialog?: { type: string, text: string }, blocked?: string, stopped?: "in-use" }} FillResult
 */

/** @param {any} browser  its top document and URL now */
const pageOf = (browser) => ({ doc: docOf(browser), url: String(browser.currentURI?.spec ?? "") });

/**
 * Watches for a tab-modal dialog the page of `browser` opens (F11): the first one's type and
 * text, inside the untrusted-content delimiters.
 * @param {any} browser XULBrowserElement
 */
function watchDialogs(browser) {
  const top = browser.browsingContext;
  const seen = {
    /** @type {{ type: string, text: string } | null} */
    dialog: null,
    stop: () => Services.obs.removeObserver(observer, "common-dialog-loaded"),
  };
  const observer = (/** @type {any} */ subject) => {
    try {
      const args = subject?.Dialog?.args ?? subject?.args;
      if (seen.dialog || args?.owningBrowsingContext?.top !== top) return;
      const type = DIALOGS[String(args.promptType)];
      if (!type) return;
      const text = wf(cutTo(shown(String(args.text ?? "")), DIALOG_TEXT_MAX));
      seen.dialog = { type, text: wrapUntrusted(text) };
    } catch {
      // not a dialog of this tab
    }
  };
  Services.obs.addObserver(observer, "common-dialog-loaded");
  return seen;
}

/**
 * The page after an agent's step: whether a new document loaded and is still loading, the
 * dialog it opened, the first submission Vimma stopped, and why the wait stopped early.
 * @param {any} browser XULBrowserElement @param {{ doc: number }} before
 * @param {{ type: string, text: string } | null} dialog @param {string[]} blocked
 * @param {"in-use" | undefined} stopped
 */
function afterStep(browser, before, dialog, blocked, stopped) {
  return {
    navigated: docOf(browser) !== before.doc,
    loading: !!browser.webProgress?.isLoadingDocument,
    ...(dialog ? { dialog } : {}),
    ...(blocked.length ? { blocked: blocked[0] } : {}),
    ...(stopped ? { stopped } : {}),
  };
}

export const AgentAct = {
  /** Test-only: SETTLE_MS's place, so a test of many clicks stays quick. */
  _settleMs: /** @type {number | null} */ (null),

  /**
   * Whether a step may pay (docs/specs/mcp-checkpoints.md C5, C6; security.md M33), and what its
   * question shows when it may (C7): the tab's page shows a payment card field in any frame, or
   * the control the step presses has a pay phrase in its text, accessible name, title or value.
   * Nothing on the page changes.
   * @param {any} browser XULBrowserElement
   * @param {{ target?: HintTarget | null, by?: "click" | "form", text?: string,
   *   keys?: string }} step  `target`: the element of the agent's `vimma_elements` it presses
   *   (`form`: through its form's default button); `text`: what the control says, as the parent
   *   knows it (a link of `f`'s list); `keys`: a key step's keys, shown when there is no text
   * @returns {Promise<{ text: string, site: string, top?: string, total?: string,
   *   keys?: string } | null>}  `site`: the host of the control's frame; `top`: the tab's host,
   *   when that frame is of another site
   */
  async payment(browser, { target = null, by = "click", text = "", keys = "" }) {
    const [cards, info] = await Promise.all([
      VimmaActors.agentCards(browser, COLLECT_TIMEOUT_MS),
      target
        ? bounded(VimmaActors.agentPayInfo(target, by), null, COLLECT_TIMEOUT_MS)
        : bounded(
            VimmaActors.agentPageTotal(browser).then((total) => ({
              texts: [],
              ...(total ? { total } : {}),
            })),
            null,
            COLLECT_TIMEOUT_MS,
          ),
    ]);
    // A control whose words did not come back is judged by what the parent knows of it.
    const texts = [text, ...(info?.texts ?? [])];
    if (!isPayStep({ cards, texts })) return null;
    const shownText = pageText(texts.find((t) => pageText(t)) ?? "");
    const total = statedTotal(info?.total);
    const tabHost = uriHost(browser.currentURI);
    // A control in a frame of another site, such as a payment provider's hosted frame, pays that
    // site: the question names it, then the tab's (mcp-checkpoints Behaviour 3).
    const frameHost = target ? otherSiteHost(target.wg?.documentURI, browser.currentURI) : "";
    return {
      text: wf(cutTo(shownText, AGENT_ELEMENTS.text)),
      site: wf(frameHost || tabHost),
      ...(frameHost ? { top: wf(tabHost) } : {}),
      ...(total ? { total: wf(total) } : {}),
      ...(!shownText && keys ? { keys } : {}),
    };
  },

  /**
   * What a submission by the control `target` presses sends, for its question (docs/specs/
   * mcp-checkpoints.md Behaviour 4), or null when the page did not say in time; `skip`: the
   * fields the same call fills, which its question shows with their new values.
   * @param {HintTarget} target @param {"click" | "form"} by @param {HintTarget[]} [skip]
   * @returns {Promise<import("../core/agent-checkpoint.mjs").SentFields | null>}
   */
  async sent(target, by, skip = []) {
    const ids = skip.filter((t) => t.bc === target.bc && t.gen === target.gen).map((t) => t.id);
    const sent = await bounded(VimmaActors.agentSent(target, by, ids), null, COLLECT_TIMEOUT_MS);
    if (!sent) return null;
    return {
      ...sent,
      fields: sent.fields.map((f) => ({
        ...f,
        name: wf(f.name),
        ...(f.value !== undefined ? { value: wf(f.value) } : {}),
      })),
    };
  },

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
   * (up to 20 s), a dialog it opened, or the user starting to use the tab; when none came, what
   * changed in place (`changed`).
   * @param {any} browser XULBrowserElement @param {HintTarget} target
   * @param {{ submit: { method: string, action: string } | null, href: string | null,
   *   inUse: () => boolean }} asked  `submit`: the submission the question named
   * @returns {Promise<{ refused: string, blocked?: string } | { navigated: boolean,
   *   loading: boolean, dialog?: { type: string, text: string }, blocked?: string,
   *   stopped?: "in-use", changed?: string[] }>}
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
   *   stopped?: "in-use", changed?: string[] }>}
   */
  async activateNow(browser, target, { submit, href, inUse }) {
    const before = pageOf(browser);
    const marked = await bounded(VimmaActors.agentMark(browser, submit), false, COLLECT_TIMEOUT_MS);
    if (!marked) return { refused: "the page did not answer in time" };
    const dialogs = watchDialogs(browser);
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
      const stopped = await this.waitForPage(browser, before, dialogs, inUse, target);
      const outcome =
        stopped === "skipped"
          ? "skipped"
          : await bounded(VimmaActors.agentClickOutcome(target), "clicked", COLLECT_TIMEOUT_MS);
      const blocked = VimmaActors.agentSettle(browser);
      if (stopped === "skipped" || outcome === "skipped") {
        // The page's handlers of the mouse events ran: what they tried to submit is still said.
        return {
          refused: "the element changed as it was clicked; nothing was clicked",
          ...(blocked.length ? { blocked: blocked[0] } : {}),
        };
      }
      const changed = stopped ? null : await this.changesAfter(browser, before, dialogs, target);
      // A submission the page tried by itself during that wait was stopped too: it is said.
      blocked.push(...VimmaActors.agentSettle(browser));
      const after = afterStep(browser, before, dialogs.dialog, blocked, stopped);
      return after.navigated || after.loading || !changed ? after : { ...after, changed };
    } finally {
      // On every path: no allowance outlives its call.
      VimmaActors.agentSettle(browser);
      dialogs.stop();
    }
  },

  /**
   * Waits after an agent's step for a page it started (up to 20 s), a dialog it opened, or the
   * user starting to use the tab (F11, F27); a step that has started no load within a second is
   * taken to have none. That second counts from when the step ran in the page's process: the
   * child clicks or submits after its reply, and a busy process runs it later. Counted from the
   * reply, the call could end before the click, and with it the one submission the question
   * allowed (security.md M28), which would then be cancelled as the page's own. A step the child
   * skipped ends the wait at once (`skipped`): the page changed the element as it was pressed,
   * and the allowance must close before the page can put it back and submit by itself.
   * @param {any} browser XULBrowserElement @param {{ doc: number, url: string }} before
   * @param {{ dialog: { type: string, text: string } | null }} dialogs
   * @param {() => boolean} inUse
   * @param {HintTarget | null} [step]  the element the child clicks or submits after its reply;
   *   null when the step had run before its reply
   * @returns {Promise<"in-use" | "skipped" | undefined>}
   */
  async waitForPage(browser, before, dialogs, inUse, step = null) {
    const start = Date.now();
    const settle = this._settleMs ?? SETTLE_MS;
    let started = false;
    /** When the step ran in the page's process. */
    let ran = step ? 0 : start;
    for (;;) {
      await sleep(50);
      if (dialogs.dialog) return undefined;
      if (inUse()) return "in-use";
      const loading = !!browser.webProgress?.isLoadingDocument;
      const now = pageOf(browser);
      if (loading || now.doc !== before.doc || now.url !== before.url) started = true;
      if (started && !loading) return undefined;
      if (!ran && step) {
        // A process that does not answer has its step taken as run, as a hung page's would be.
        const outcome = await bounded(VimmaActors.agentClickOutcome(step), "clicked", 1000);
        if (outcome === "skipped") return "skipped";
        if (outcome !== "pending" || Date.now() - start >= COLLECT_TIMEOUT_MS) ran = Date.now();
      }
      if (!started && ran && Date.now() - ran >= settle) return undefined;
      if (Date.now() - start >= LOAD_TIMEOUT_MS) return undefined;
    }
  },

  /**
   * After a click that started no load (#510): which parts of the page changed in place, asked
   * of the clicked element's frame until something has, for up to another second after the
   * settle, so the result never says "nothing changed" of a page that updated itself a moment
   * late. Null when a page or a dialog of the browser came instead, or the frame cannot say;
   * the allowance is closed by then, so the extra wait opens nothing.
   * @param {any} browser XULBrowserElement @param {{ doc: number, url: string }} before
   * @param {{ dialog: { type: string, text: string } | null }} dialogs
   * @param {HintTarget} target
   * @returns {Promise<string[] | null>}
   */
  async changesAfter(browser, before, dialogs, target) {
    const end = Date.now() + (this._settleMs ?? SETTLE_MS);
    for (;;) {
      // A URL the page's script changed (history.pushState) loads nothing: its changes count.
      const moved = docOf(browser) !== before.doc;
      if (dialogs.dialog || moved || browser.webProgress?.isLoadingDocument) return null;
      const changed = await bounded(VimmaActors.agentChanges(target), null, 1000);
      if (!changed || changed.length || Date.now() >= end) return changed;
      await sleep(150);
    }
  },

  /**
   * The field a label names, as it is now, if an agent may fill it with `value` (F4, F6, F13;
   * security.md M27): what the question shows (its name and how it is set), or why it is
   * refused. Nothing on the page changes.
   * @param {any} browser XULBrowserElement @param {HintTarget} target @param {string} label
   * @param {string | boolean} value
   * @returns {Promise<{ field: import("../core/agent-act.mjs").FillTarget, name: string }
   *   | { refused: string }>}
   */
  async fillable(browser, target, label, value) {
    if (!onTheWeb(target.wg?.documentPrincipal) || !onTheWeb(browser.contentPrincipal)) {
      return { refused: "fields are filled only on http and https pages" };
    }
    const field = await bounded(
      VimmaActors.agentInspectFill(target, value),
      null,
      COLLECT_TIMEOUT_MS,
    );
    if (!field) return { refused: "the page did not answer in time" };
    const refused = fillRefusal(label, field, value);
    if (refused) return { refused };
    // The field's name for the question, as the list shows page text (security.md M31).
    const name = cutTo(
      shown(field.caption || field.name || "")
        .replace(/\s+/g, " ")
        .trim(),
      AGENT_ELEMENTS.text,
    );
    return { field, name };
  },

  /**
   * Fills fields in the background, in order (F12, F13, F16; security.md M27, M28), once
   * `fillable` said each may be and the user allowed it, then submits their form when the
   * question said so: through `submit.target`'s submit button (`click`) or the form's default
   * submission (`form`). Before each field the tab must still be the agent's (`still`) and not
   * in use; a field that changed since the question stops the call. Then waits as after a click.
   * @param {any} browser XULBrowserElement
   * @param {{ label: string, target: HintTarget, value: string | boolean,
   *   expect: { field: string, type: string | null } }[]} steps
   * @param {{ submit: { by: "click" | "form", target: HintTarget,
   *   submit: { method: string, action: string } } | null, inUse: () => boolean,
   *   still: () => boolean }} asked
   * @returns {Promise<FillResult>}
   */
  fill(browser, steps, asked) {
    const last = running.get(browser) ?? Promise.resolve();
    const run = last.then(() => this.fillNow(browser, steps, asked));
    running.set(
      browser,
      run.catch(() => {}),
    );
    return run;
  },

  /**
   * `fill`, once no other step runs on the tab.
   * @param {any} browser XULBrowserElement
   * @param {{ label: string, target: HintTarget, value: string | boolean,
   *   expect: { field: string, type: string | null } }[]} steps
   * @param {{ submit: { by: "click" | "form", target: HintTarget,
   *   submit: { method: string, action: string } } | null, inUse: () => boolean,
   *   still: () => boolean }} asked
   * @returns {Promise<FillResult>}
   */
  async fillNow(browser, steps, { submit, inUse, still }) {
    const before = pageOf(browser);
    // No submission is allowed while the fields are set: only the last step's (F15, F16).
    const marked = await bounded(VimmaActors.agentMark(browser, null), false, COLLECT_TIMEOUT_MS);
    if (!marked) return { refused: "the page did not answer in time", filled: 0 };
    const dialogs = watchDialogs(browser);
    let filled = 0;
    /** @type {string[]} */
    const reset = [];
    /**
     * The call stops at `label`: what happened, and how far it got.
     * @param {string} why @param {string} [label]
     */
    const stop = (why, label) => {
      const blocked = VimmaActors.agentSettle(browser);
      const n = `${filled} of ${steps.length} field${steps.length === 1 ? " was" : "s were"}`;
      return {
        refused: `${label ? `field "${label}" ` : ""}${why}; ${n} filled, nothing more was done`,
        filled,
        changed: true,
        navigated: docOf(browser) !== before.doc,
        ...(blocked.length ? { blocked: blocked[0] } : {}),
      };
    };
    try {
      /** @type {"in-use" | undefined} */
      let stopped;
      /** @type {HintTarget | null} the submit the child runs after its reply */
      let sent = null;
      for (const step of steps) {
        if (dialogs.dialog) break;
        if (inUse()) {
          stopped = "in-use";
          break;
        }
        if (!still()) return stop("the tab changed since the user was asked");
        // The child sets nothing once this call has stopped waiting for its answer.
        const until = Date.now() + COLLECT_TIMEOUT_MS - 1000;
        const reply = await bounded(
          VimmaActors.agentFill(step.target, { value: step.value, expect: step.expect, until }),
          "gone",
          COLLECT_TIMEOUT_MS,
        );
        if (reply === "gone") return stop("is gone", step.label);
        if (reply === "changed") return stop("changed since the user was asked", step.label);
        let outcome = "pending";
        const start = Date.now();
        while (outcome === "pending" && !dialogs.dialog) {
          if (Date.now() - start >= COLLECT_TIMEOUT_MS) break;
          await sleep(10);
          outcome = await bounded(VimmaActors.agentFillOutcome(step.target), "pending", 1000);
        }
        if (outcome === "skipped") return stop("changed since the user was asked", step.label);
        if (outcome === "gone") return stop("is gone: its page went away", step.label);
        if (outcome === "pending" && !dialogs.dialog) {
          return stop("did not answer in time", step.label);
        }
        // A dialog the page opened while the field was set: its value is in, its events ran.
        filled++;
        if (outcome === "reset") reset.push(step.label);
      }
      if (submit && filled === steps.length && !dialogs.dialog && !stopped) {
        // The question showed the values the form would send: the page's own are not those.
        if (reset.length) return stop("was put back by the page; the form was not sent", reset[0]);
        if (inUse()) stopped = "in-use";
        else if (!still()) return stop("the tab changed before the form was sent");
        else if (!VimmaActors.agentAllow(browser, submit.submit)) {
          return stop("the page changed before the form was sent");
        } else {
          const until = Date.now() + COLLECT_TIMEOUT_MS - 1000;
          const reply = await bounded(
            submit.by === "click"
              ? VimmaActors.agentActivate(submit.target, {
                  submit: submit.submit,
                  href: null,
                  until,
                })
              : VimmaActors.agentSubmit(submit.target, { submit: submit.submit, until }),
            "gone",
            COLLECT_TIMEOUT_MS,
          );
          if (reply !== "ok")
            return stop("the form changed since the user was asked; it was not sent");
          sent = submit.target;
        }
      }
      const waited = await this.waitForPage(browser, before, dialogs, inUse, sent);
      // Asked again as a click's outcome is: a busy page can answer the wait's poll too late.
      const skipped =
        waited === "skipped" ||
        (sent !== null &&
          (await bounded(VimmaActors.agentClickOutcome(sent), "clicked", COLLECT_TIMEOUT_MS)) ===
            "skipped");
      if (skipped) {
        return stop("the form changed since the user was asked; it was not sent");
      }
      stopped = waited ?? stopped;
      const blocked = VimmaActors.agentSettle(browser);
      return {
        filled,
        ...(reset.length ? { reset } : {}),
        ...afterStep(browser, before, dialogs.dialog, blocked, stopped),
      };
    } finally {
      VimmaActors.agentSettle(browser);
      dialogs.stop();
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

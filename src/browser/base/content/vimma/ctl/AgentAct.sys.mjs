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

import { AGENT_ELEMENTS, agentElementList, labelAgentElements } from "../core/agent-act.mjs";
import { wrapUntrusted } from "../core/agent.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";

/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long the page's frames may take to answer: a hung content process must not hold a call. */
const COLLECT_TIMEOUT_MS = 5000;

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

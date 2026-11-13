/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Normal-mode page keys on the focused page (spec: docs/specs/m1-actor-insert-scroll.md,
// "Follow-up: normal-mode extras"): yy, p / P, gi, gu / gU, gf. runners.mjs spreads these into
// CONTENT_RUNNERS, so each acts on the focused <browser>: in a split, the focused pane's.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { classifyClipboard, urlRoot, urlUp } from "../core/pageurl.mjs";
import { openUrl } from "./tab-ops.mjs";
import { PdfOps } from "./pdf-ops.mjs";

/** @import { Action } from "../core/dispatcher.mjs" */

/** `gu` / `gU` with nothing above the page. */
export const AT_TOP = "already at the top";
/** `gi` on a page without a visible text field. */
export const NO_FIELD = "no text field on this page";
/** `p` / `P` with nothing to open. */
export const EMPTY_CLIPBOARD = "the clipboard is empty";

/**
 * The system clipboard's plain text, "" without any. Read in the parent: the page never sees it.
 * @param {Window} win
 * @returns {string}
 */
export function readClipboard(win) {
  try {
    const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    trans.init(/** @type {any} */ (win).docShell.QueryInterface(Ci.nsILoadContext));
    trans.addDataFlavor("text/plain");
    Services.clipboard.getData(trans, Services.clipboard.kGlobalClipboard);
    /** @type {{ value?: any }} */
    const data = {};
    trans.getTransferData("text/plain", data);
    return data.value?.QueryInterface(Ci.nsISupportsString).data ?? "";
  } catch {
    return ""; // nothing on the clipboard, or no text flavour
  }
}

/**
 * Loads `url` in `browser` as a link on its page would (the page's principal triggers it).
 * @param {any} browser
 * @param {string} url
 */
function load(browser, url) {
  browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: browser.contentPrincipal });
}

/**
 * The runners, given how the host enters explicit insert in a tab and shows a notice in its
 * window.
 * @param {(browser: any) => void} enterInsert
 * @param {(browser: any, text: string) => void} notify
 * @returns {Record<string, (browser: any, action: Action) => void>}
 */
export function pageRunners(enterInsert, notify) {
  /** `p` / `P`: the clipboard as a URL or a search, through `:open`'s path; never a script. */
  const openClipboard = (/** @type {any} */ b, /** @type {"current" | "tab"} */ where) => {
    const win = b.ownerDocument.defaultView;
    const what = classifyClipboard(readClipboard(win));
    if (what.kind === "empty") return notify(b, EMPTY_CLIPBOARD);
    if (what.kind === "refused") return notify(b, `blocked: ${what.reason} from the clipboard`);
    // "?" makes URIFixup search the words with the default engine, never guess a host.
    const text = what.kind === "search" ? `? ${what.text}` : what.text;
    if (!openUrl(win, text, where)) notify(b, "blocked: javascript: URL from the clipboard");
    return undefined;
  };
  /** `gu` / `gU`. */
  const goTo = (/** @type {any} */ b, /** @type {string | null} */ url) => {
    if (url) load(b, url);
    else notify(b, AT_TOP);
  };
  return {
    "page.yank_url": (b) => {
      const url = b.currentURI?.spec;
      if (!url) return;
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(url);
      notify(b, `yanked ${url}`);
    },
    "page.open_clipboard": (b) => openClipboard(b, "current"),
    "page.open_clipboard_new_tab": (b) => openClipboard(b, "tab"),
    // Insert only once a field has focus: with none, the page stays in normal (unlike `i`).
    "page.focus_input": async (b, a) => {
      if (await VimmaActors.focusNthInput(b, a.count)) enterInsert(b);
      else notify(b, NO_FIELD);
    },
    "page.url_up": (b, a) => goTo(b, urlUp(b.currentURI?.spec ?? "", a.count)),
    "page.url_root": (b) => goTo(b, urlRoot(b.currentURI?.spec ?? "")),
    // Firefox's ctrl+u, on this pane's page.
    "page.view_source": (b) => b.ownerDocument.defaultView.BrowserCommands.viewSource(b),
  };
}

/**
 * Moves `browser` `delta` entries through its session history, clamped to the first and last
 * entry (`5H` on the third page lands on the first). One step goes through goBack/goForward,
 * which skip entries the user never interacted with, like the toolbar buttons; in the PDF viewer
 * a step to another jump inside the PDF goes there directly (PdfOps.jumpIndex).
 * @param {any} browser
 * @param {number} delta  negative goes back
 */
export function goHistory(browser, delta) {
  const jump = PdfOps.jumpIndex(browser, delta);
  if (jump !== null) return browser.gotoIndex(jump);
  if (delta === -1) return browser.goBack();
  if (delta === 1) return browser.goForward();
  const history = browser.browsingContext?.sessionHistory;
  if (!history) return undefined;
  const index = Math.min(Math.max(history.index + delta, 0), history.count - 1);
  if (index !== history.index) browser.gotoIndex(index);
  return undefined;
}

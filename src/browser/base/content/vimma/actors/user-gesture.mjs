/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The user's own hint as their gesture in the page (docs/specs/m1-hints.md; issue #1303). The
// key the user typed went to chrome, never to the page, so a click() alone gives the page no
// transient user activation: a target=_blank link and window.open hit the pop-up blocker,
// requestFullscreen and a select's showPicker() are refused. This is the only place Vimma gives
// a page user activation, and only VimmaChild's handler of the parent's Vimma:ActivateHint calls
// it, which the parent sends for a label typed in chrome. An agent's click (docs/specs/mcp-forms.md
// F8; docs/security/12-agents-mcp.md M26) never comes here; browser_vimma_security_invariants.js
// holds both.

/**
 * Runs `fn` as the user's input in `win`: nsIDOMWindowUtils.setHandlingUserInput(true) calls
 * Document::NotifyUserGestureActivation on the window's document (which activates its ancestors
 * and same-origin descendants, as a real click does) and marks the call as handling user input
 * (UserActivation::StartHandlingUserInput) until destruct() (dom/base/nsDOMWindowUtils.cpp,
 * Firefox 160). It is what Firefox gives a WebExtension's user action
 * (ExtensionCommon.withHandlingUserInput).
 * `fn` must be synchronous: the user-input state ends when it returns, so the rest of an async
 * function would run without it, and a promise left pending would hand the gesture's timing to
 * whatever settles it. A thenable result throws, after the state has ended.
 * @template T
 * @param {Window} win the target's own window (its frame's, not the top one)
 * @param {() => T} fn
 * @returns {T}
 */
export function asUserGesture(win, fn) {
  const input = win.windowUtils.setHandlingUserInput(true);
  /** @type {T} */
  let result;
  try {
    result = fn();
  } finally {
    input.destruct();
  }
  if (typeof (/** @type {{ then?: unknown }} */ (result)?.then) === "function") {
    throw new TypeError("asUserGesture: fn must be synchronous");
  }
  return result;
}

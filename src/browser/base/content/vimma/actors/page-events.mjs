/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Events an agent's click sends as the page's own script would (docs/specs/mcp-forms.md F8;
// docs/security/12-agents-mcp.md M26; issue #1321). An event built with the page's constructor
// starts untrusted, but EventDispatcher::DispatchDOMEvent stamps a not yet dispatched event
// with nsContentUtils::LegacyIsCallerChromeOrNativeCode() (dom/events/EventDispatcher.cpp,
// Firefox 160), so one that this system-principal actor dispatches reaches the page trusted, and
// Gecko then runs a real press's link handling on it: a `mouseover` sets the window's link
// preview and a `mousedown` focuses the link (Element::GetEventTargetParentForLinks and
// PostHandleEventForLinks, dom/base/Element.cpp), and the page's `mousedown` and `mouseup`
// listeners run as "handling user input" (UserActivation::IsUserInteractionEvent). Called through
// waived Xrays, the page's own `dispatchEvent` runs in the page's realm, so the subject principal
// is the page's and the caller is not chrome: the page sees the events untrusted and Gecko does
// none of that, as for an event the page dispatches itself.

/**
 * Dispatches `events` at `el`, in order, as the page's script would: untrusted. The call goes
 * through the page's `EventTarget.prototype.dispatchEvent`, which the page could replace; it
 * then runs only the page's own code on the page's own objects, as its listeners already do,
 * and a page that breaks it loses only its own mouse events (the click still follows).
 * @param {Element} el @param {Event[]} events
 * @returns {boolean} whether they were dispatched
 */
export function dispatchAsPage(el, events) {
  const win = el.ownerDocument.defaultView;
  // A system principal's realm is chrome, and its events trusted.
  if (!win || !el.nodePrincipal || el.nodePrincipal.isSystemPrincipal) return false;
  try {
    const page = /** @type {{ EventTarget: typeof EventTarget }} */ (
      /** @type {unknown} */ (Cu.waiveXrays(win))
    );
    const dispatch = page.EventTarget.prototype.dispatchEvent;
    for (const event of events) Reflect.apply(dispatch, Cu.waiveXrays(el), [Cu.waiveXrays(event)]);
    return true;
  } catch {
    return false; // the page replaced dispatchEvent with something that throws
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ctrl+j and ctrl+m as Enter (docs/specs/key-handling-batch.md § 2), and ctrl+n and ctrl+p as
// ArrowDown and ArrowUp in a page's suggestion list (docs/specs/page-suggestions.md), in the
// parent process: a real key press in a browser window, at its focused element, a chrome field
// (edit-keys) or a page's field through its <browser> (VimmaActors), as a keyboard's key goes. A
// KeyboardEvent made by script is untrusted, so a form would not submit, the editor would add no
// line and Firefox's form autocomplete would not move; a TextInputProcessor's keys are trusted,
// as Vimma's control socket uses for its send-keys. Not in the content process: a keypress there
// needs its edit commands from the parent, which BrowserParent::RecvRequestNativeKeyBindings
// gives only under automation.

/** The keys pressed this way, with their DOM key codes. */
const KEY_CODES = Object.freeze({ Enter: 13, ArrowUp: 38, ArrowDown: 40 });

/**
 * Presses and releases `key` in `win`, once the key being dispatched now is done: a
 * TextInputProcessor cannot begin a transaction on a widget mid-dispatch
 * (TextEventDispatcher::BeginInputTransactionInternal). The processor keeps its own modifier
 * state, so the key goes without the ctrl still held on the keyboard: ctrl+Enter is another
 * key (the address bar adds www. and .com), and ctrl+ArrowDown moves a field's caret instead of
 * a page's suggestion list (docs/specs/page-suggestions.md decision 2).
 * @param {Window} win  a browser window
 * @param {keyof typeof KEY_CODES} key
 * @param {() => boolean} stillFocused  checked then: the field may have lost focus meanwhile
 */
export function pressKeyLater(win, key, stillFocused) {
  Services.tm.dispatchToMainThread(() => {
    if (win.closed || !stillFocused()) return;
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    // False while an IME composes: the key is the IME's then, so none is sent.
    if (!tip.beginInputTransaction(win, () => true)) return;
    const event = new /** @type {any} */ (win).KeyboardEvent("", {
      key,
      code: key,
      keyCode: KEY_CODES[key],
    });
    tip.keydown(event);
    tip.keyup(event);
  });
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/page-suggestions.md. In insert mode, while the focused field's suggestion
// list is open, ctrl+n presses a trusted ArrowDown and ctrl+p a trusted ArrowUp in it: an ARIA
// combobox, the same in a cross-origin frame, and Firefox's own datalist popup. The page goes
// first: a page that takes ctrl+n keeps it. With no list open (a plain field, a combobox left
// aria-expanded with its list hidden), the chord's [keys] binding runs: ctrl+p prints, and ctrl+n,
// which has none since new_window moved to ctrl+b shift+c, only reaches the page and opens no
// window. Normal mode presses no arrow key.
//
// On macOS ctrl+n and ctrl+p are also Cocoa's moveDown: and moveUp: in every text field
// (widget/cocoa/NativeKeyBindings.mm; a synthesized key gets them too, GetEditCommandsForTests).
// With a list open the field's own key gives way to the arrow key, and the caret stays; with
// none open the field keeps its key, so the caret moves and ctrl+p does not print (issue #1034).

"use strict";

/* global focusContent, recordPageKeys, pageKeys, contextOf -- from head.js */
/* global PrintUtils, BrowserWindowTracker -- browser.js, in the test's window */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const COMBO = ROOT + "file_vimma_suggest_combobox.html";
const DATALIST = ROOT + "file_vimma_suggest_datalist.html";

/**
 * Print calls, with Firefox's print window replaced by a counter, so no print dialog opens.
 * @param {(calls: () => number) => Promise<void>} fn
 */
async function withPrintRecorder(fn) {
  const original = PrintUtils.startPrintWindow;
  let calls = 0;
  PrintUtils.startPrintWindow = () => {
    calls++;
  };
  try {
    await fn(() => calls);
  } finally {
    PrintUtils.startPrintWindow = original;
  }
}

/**
 * The page's keydown log, `id:key:isTrusted`.
 * @param {XULBrowserElement | BrowsingContext} target
 * @returns {Promise<string[]>}
 */
function pageLog(target) {
  return SpecialPowers.spawn(target, [], () => [...content.wrappedJSObject.log]);
}

/** @param {string[]} log */
const arrows = (log) => log.filter((e) => /:Arrow(Down|Up):/.test(e));

/**
 * Focuses `id` in `target` and waits for insert mode.
 * @param {XULBrowserElement} browser
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 */
async function focusField(browser, target, id) {
  await SpecialPowers.spawn(target, [id], (i) =>
    /** @type {HTMLElement} */ (content.document.getElementById(i)).focus(),
  );
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
}

/**
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 * @param {string} want
 * @param {string} msg
 */
function waitForValue(target, id, want, msg) {
  return TestUtils.waitForCondition(
    async () =>
      (await SpecialPowers.spawn(
        target,
        [id],
        (i) => /** @type {HTMLInputElement} */ (content.document.getElementById(i)).value,
      )) === want,
    msg,
  );
}

/** @param {string} key */
const ctrl = (key) => EventUtils.synthesizeKey(key, { ctrlKey: true });

/** Cocoa's text-field keys apply: ctrl+n is moveDown: and ctrl+p is moveUp:. */
const MAC = Services.appinfo.OS === "Darwin";

/** A main-thread turn: what a key already dispatched set off in this process has run. */
const turn = () =>
  /** @type {Promise<void>} */ (new Promise((r) => Services.tm.dispatchToMainThread(r)));

/**
 * Gives field `id` the text `text` with the caret at `at`.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 * @param {string} text
 * @param {number} at
 */
function setField(target, id, text, at) {
  return SpecialPowers.spawn(target, [id, text, at], (i, t, a) => {
    const el = /** @type {HTMLInputElement} */ (content.document.getElementById(i));
    el.value = t;
    el.setSelectionRange(a, a);
  });
}

/**
 * The selection of field `id`, as `start-end`.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 * @returns {Promise<string>}
 */
function caretOf(target, id) {
  return SpecialPowers.spawn(target, [id], (i) => {
    const el = /** @type {HTMLInputElement} */ (content.document.getElementById(i));
    return `${el.selectionStart}-${el.selectionEnd}`;
  });
}

/**
 * ctrl+p in the focused field `id`, whose list is not open: it prints, the chord's [keys]
 * binding. On macOS the field keeps the key instead: Cocoa's moveUp:, which in a one-line field
 * puts the caret at the start, and nothing prints.
 * @param {XULBrowserElement} browser
 * @param {string} id
 * @param {() => number} prints
 * @param {string} msg
 */
async function ctrlPWithNoList(browser, id, prints, msg) {
  if (!MAC) {
    ctrl("p");
    await TestUtils.waitForCondition(() => prints() === 1, msg);
    return;
  }
  await setField(browser, id, "abc", 3);
  ctrl("p");
  await TestUtils.waitForCondition(
    async () => (await caretOf(browser, id)) === "0-0",
    "macOS: ctrl+p is the field's moveUp:",
  );
  // The page's reply reaches the parent before this answer from the same process, so a print
  // would have started by the next main-thread turn.
  await pageLog(browser);
  await turn();
  Assert.equal(prints(), 0, "macOS: and nothing prints");
}

/**
 * Runs fn and counts the windows opened while it runs (decision 7: ctrl+n opens none).
 * @param {() => Promise<void>} fn
 * @returns {Promise<number>}
 */
async function windowsOpenedBy(fn) {
  let opened = 0;
  /** @type {nsIObserver} */
  const observer = { observe: (_s, topic) => topic === "domwindowopened" && opened++ };
  Services.ww.registerNotification(observer);
  try {
    await fn();
  } finally {
    Services.ww.unregisterNotification(observer);
  }
  return opened;
}

/**
 * Presses ctrl+n in a field with no list open: the page gets it, and no window opens.
 * @param {XULBrowserElement} browser
 * @param {string} id  the focused field, as the page logs it
 */
async function ctrlNOpensNoWindow(browser, id) {
  const opened = await windowsOpenedBy(async () => {
    ctrl("n");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes(`${id}:ctrl+n:true`),
      "the page received ctrl+n",
    );
    // The page's reply reaches the parent before this answer from the same process, so a
    // fallback would have run by the next main-thread turn.
    await pageLog(browser);
    await turn();
  });
  Assert.equal(opened, 0, "ctrl+n with no list open opens no window");
  Assert.equal(BrowserWindowTracker.orderedWindows.length, 1, "one window");
}

add_task(async function ctrl_n_and_ctrl_p_move_an_aria_combobox() {
  await withPrintRecorder(async (prints) => {
    await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
      await focusContent(browser);
      await focusField(browser, browser, "combo");
      EventUtils.sendString("a");
      await TestUtils.waitForCondition(
        () =>
          SpecialPowers.spawn(
            browser,
            [],
            () =>
              /** @type {HTMLElement} */ (content.document.getElementById("combo")).getAttribute(
                "aria-expanded",
              ) === "true",
          ),
        "the list opens on input",
      );
      ctrl("n");
      await waitForValue(browser, "combo", "alpha", "ctrl+n highlights the first suggestion");
      ctrl("n");
      await waitForValue(browser, "combo", "apple", "ctrl+n again, the second");
      ctrl("p");
      await waitForValue(browser, "combo", "alpha", "ctrl+p, back to the first");
      Assert.deepEqual(
        arrows(await pageLog(browser)),
        ["combo:ArrowDown:true", "combo:ArrowDown:true", "combo:ArrowUp:true"],
        "the page got trusted ArrowDown, ArrowDown, ArrowUp without ctrl",
      );
      Assert.ok((await pageLog(browser)).includes("combo:ctrl+n:true"), "and ctrl+n first");
      Assert.equal(prints(), 0, "ctrl+p in an open list does not print");
      Assert.equal(VimmaHost._browserMode(browser), "insert", "still in insert mode");
    });
  });
});

// A list that only moves its highlight, as most list widgets do, leaves the field's text and
// caret to the user. On macOS the field's own ctrl+p and ctrl+n (Cocoa's moveUp: and moveDown:)
// would first put the caret at the start or the end: with a list open the field does not get them.
add_task(async function the_caret_stays_where_it_was_in_an_open_list() {
  await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
    await focusContent(browser);
    await focusField(browser, browser, "keeps");
    await setField(browser, "keeps", "abc", 1);
    ctrl("p");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes("keeps:ArrowUp:true"),
      "ctrl+p presses ArrowUp",
    );
    Assert.equal(await caretOf(browser, "keeps"), "1-1", "and the caret stays");
    ctrl("n");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes("keeps:ArrowDown:true"),
      "ctrl+n presses ArrowDown",
    );
    Assert.equal(await caretOf(browser, "keeps"), "1-1", "and the caret stays");
  });
});

// The same in a contenteditable, whose editor listens above the page (EditorEventListener, on
// the window's parent target): Cocoa's moveDown: and moveUp: there move the caret a line.
add_task(async function the_caret_stays_where_it_was_in_an_open_contenteditable_list() {
  await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
    await focusContent(browser);
    await focusField(browser, browser, "rich");
    /** The caret, as the text of its line and its offset there. */
    const caret = () =>
      SpecialPowers.spawn(browser, [], () => {
        const sel = /** @type {Selection} */ (content.getSelection());
        return `${sel.anchorNode?.textContent?.trim()}:${sel.anchorOffset}:${sel.isCollapsed}`;
      });
    // In the middle line, so that a line up and a line down both show.
    const start = await SpecialPowers.spawn(browser, [], () => {
      const rich = /** @type {HTMLElement} */ (content.document.getElementById("rich"));
      const two = [...rich.childNodes].find((n) => n.textContent?.trim() === "two");
      const text = /** @type {string} */ (two?.textContent);
      /** @type {Selection} */ (content.getSelection()).collapse(
        /** @type {Node} */ (two),
        text.indexOf("two") + 1,
      );
      const sel = /** @type {Selection} */ (content.getSelection());
      return `${sel.anchorNode?.textContent?.trim()}:${sel.anchorOffset}:${sel.isCollapsed}`;
    });
    Assert.ok(start.startsWith("two:"), `the caret is in the middle line (${start})`);
    ctrl("n");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes("rich:ArrowDown:true"),
      "ctrl+n presses ArrowDown",
    );
    Assert.equal(await caret(), start, "and the caret stays");
    ctrl("p");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes("rich:ArrowUp:true"),
      "ctrl+p presses ArrowUp",
    );
    Assert.equal(await caret(), start, "and the caret stays");
  });
});

add_task(async function a_combobox_in_a_cross_origin_frame() {
  await BrowserTestUtils.withNewTab(ROOT + "file_vimma_suggest_datalist.html", async (browser) => {
    const src = COMBO.replace("https://example.com", "https://example.org");
    await SpecialPowers.spawn(browser, [src], async (s) => {
      const frame = content.document.createElement("iframe");
      frame.src = s;
      const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
      content.document.body.append(frame);
      await loaded;
    });
    const frameBC = contextOf(browser).children[0];
    await focusContent(browser);
    await focusField(browser, frameBC, "combo");
    EventUtils.sendString("a");
    await waitForValue(frameBC, "combo", "a", "typed in the frame");
    ctrl("n");
    await waitForValue(frameBC, "combo", "alpha", "ctrl+n moves the frame's list");
    ctrl("n");
    await waitForValue(frameBC, "combo", "apple", "and again");
    ctrl("p");
    await waitForValue(frameBC, "combo", "alpha", "ctrl+p moves it back");
    Assert.deepEqual(
      arrows(await pageLog(frameBC)),
      ["combo:ArrowDown:true", "combo:ArrowDown:true", "combo:ArrowUp:true"],
      "the frame got the trusted arrow keys",
    );
  });
});

// docs/security/13-page-modes.md K6: the arrow key Vimma presses is the page's. With an insert-mode
// binding on
// <Down> (here: new tab), the key still reaches the page and runs no binding.
add_task(async function a_pressed_arrow_key_runs_no_vimma_binding() {
  const { compileKeymap } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/core/keymap.mjs",
  );
  const mac = { mac: Services.appinfo.OS === "Darwin" };
  VimmaHost.configure({
    keymap: compileKeymap({ modal: { insert: { "<Down>": "tab.new" } } }, mac),
  });
  try {
    await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
      const tabs = gBrowser.tabs.length;
      await focusContent(browser);
      await focusField(browser, browser, "combo");
      EventUtils.sendString("a");
      await waitForValue(browser, "combo", "a", "typed");
      ctrl("n");
      await waitForValue(browser, "combo", "alpha", "ctrl+n's ArrowDown reaches the page");
      Assert.equal(gBrowser.tabs.length, tabs, "and runs no <Down> binding");
    });
  } finally {
    VimmaHost.configure({ keymap: compileKeymap({}, mac) });
  }
});

add_task(async function a_page_that_takes_ctrl_n_keeps_it() {
  await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
    await focusContent(browser);
    await focusField(browser, browser, "takes");
    ctrl("n");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes("takes:ctrl+n:true"),
      "the page had ctrl+n",
    );
    EventUtils.sendString("x");
    await waitForValue(browser, "takes", "x", "the next key types");
    await turn();
    Assert.deepEqual(arrows(await pageLog(browser)), [], "no ArrowDown after the page took ctrl+n");
    Assert.equal(BrowserWindowTracker.orderedWindows.length, 1, "and no window opened");
  });
});

// docs/security/13-page-modes.md K6: a busy page's late reply must not press an arrow key in the
// tab focused since, nor run the fallback there.
add_task(async function a_late_reply_presses_no_arrow_key_in_another_tab() {
  const tabB = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    COMBO.replace("https://example.com", "https://example.org"),
  );
  await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      /** @type {HTMLElement} */ (content.document.getElementById("plain")).addEventListener(
        "keydown",
        (e) => {
          if (!e.ctrlKey || e.key !== "n") return;
          const end = Date.now() + 1500;
          while (Date.now() < end) {
            // Holds the reply back, as a busy page does.
          }
          content.wrappedJSObject.log.push("busy-done");
        },
      );
    });
    await focusContent(browser);
    await focusField(browser, browser, "plain");
    ctrl("n");
    await BrowserTestUtils.switchTab(gBrowser, tabB);
    const b = tabB.linkedBrowser;
    await focusContent(b);
    await focusField(b, b, "combo");
    EventUtils.sendString("a");
    await waitForValue(b, "combo", "a", "tab B's list is open");
    await TestUtils.waitForCondition(
      async () => (await pageLog(browser)).includes("busy-done"),
      "tab A handled its ctrl+n",
    );
    // A's reply reaches the parent before this answer from A's process; a query and a press in
    // B would come before this answer from B.
    await pageLog(browser);
    await turn();
    await pageLog(b);
    await turn();
    Assert.deepEqual(arrows(await pageLog(b)), [], "tab B got no arrow key");
    Assert.equal(BrowserWindowTracker.orderedWindows.length, 1, "and no window opened");
  });
  BrowserTestUtils.removeTab(tabB);
});

add_task(async function a_hidden_list_left_aria_expanded_is_not_open() {
  await withPrintRecorder(async (prints) => {
    await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
      await focusContent(browser);
      await focusField(browser, browser, "stale");
      await ctrlPWithNoList(browser, "stale", prints, "ctrl+p prints: the list is hidden");
      Assert.deepEqual(arrows(await pageLog(browser)), [], "no ArrowUp");
    });
  });
});

add_task(async function with_no_list_open_the_keys_binding_runs() {
  await withPrintRecorder(async (prints) => {
    await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
      await focusContent(browser);
      await focusField(browser, browser, "plain");
      await ctrlPWithNoList(browser, "plain", prints, "ctrl+p runs print_page");
      await focusField(browser, browser, "plain");
      await setField(browser, "plain", "abc", 0);
      await ctrlNOpensNoWindow(browser, "plain");
      Assert.deepEqual(arrows(await pageLog(browser)), [], "and no arrow key");
      // Cocoa's moveDown: puts a one-line field's caret at the end; elsewhere ctrl+n is no
      // text-field key.
      Assert.equal(
        await caretOf(browser, "plain"),
        MAC ? "3-3" : "0-0",
        MAC ? "macOS: ctrl+n is the field's moveDown:" : "ctrl+n moves no caret",
      );
    });
  });
});

add_task(async function ctrl_n_and_ctrl_p_move_firefoxs_datalist_popup() {
  await BrowserTestUtils.withNewTab(DATALIST, async (browser) => {
    await focusContent(browser);
    await focusField(browser, browser, "dl");
    // A XUL autocomplete popup, which getElementById types as an HTML element.
    const popup = /** @type {AutoCompletePopupElement} */ (
      /** @type {Element} */ (document.getElementById("PopupAutoComplete"))
    );
    const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    await shown;
    ctrl("n");
    await TestUtils.waitForCondition(() => popup.selectedIndex === 0, "ctrl+n selects row 0");
    ctrl("n");
    await TestUtils.waitForCondition(() => popup.selectedIndex === 1, "ctrl+n again, row 1");
    ctrl("p");
    await TestUtils.waitForCondition(() => popup.selectedIndex === 0, "ctrl+p, row 0");
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    EventUtils.synthesizeKey("KEY_Enter");
    await hidden;
    await waitForValue(browser, "dl", "banana", "Enter fills the field");
    // With the popup closed ctrl+n opens neither the popup nor a window.
    await SpecialPowers.spawn(browser, [], () => {
      /** @type {HTMLInputElement} */ (content.document.getElementById("dl")).value = "";
    });
    await focusField(browser, browser, "dl");
    await ctrlNOpensNoWindow(browser, "dl");
    Assert.ok(!popup.popupOpen, "ctrl+n did not open the popup");
  });
});

// Chrome fields keep their keys (decision 6 of the spec's Behaviour, item 6): in the address bar
// ctrl+p prints as before, and ctrl+n opens no window (decision 7).
add_task(async function the_address_bar_keeps_ctrl_n_and_ctrl_p() {
  await withPrintRecorder(async (prints) => {
    await BrowserTestUtils.withNewTab(COMBO, async () => {
      gURLBar.focus();
      if (MAC) {
        // The address bar's own ctrl+p on macOS: with its results open, the row above
        // (UrlbarChildController, handleKeyNavigation); with them closed, Cocoa's moveUp:.
        gURLBar.view.close();
        const input = gURLBar.inputField;
        input.setSelectionRange(input.value.length, input.value.length);
        Assert.greater(input.value.length, 0, "the address bar shows the page's address");
        ctrl("p");
        await TestUtils.waitForCondition(
          () => input.selectionStart === 0 && input.selectionEnd === 0,
          "macOS: ctrl+p is the address bar's moveUp:",
        );
        await turn();
        Assert.equal(prints(), 0, "macOS: and nothing prints");
      } else {
        ctrl("p");
        await TestUtils.waitForCondition(
          () => prints() === 1,
          "ctrl+p prints from the address bar",
        );
      }
      gURLBar.focus();
      const opened = await windowsOpenedBy(async () => {
        ctrl("n");
        await turn();
      });
      Assert.equal(opened, 0, "ctrl+n in the address bar opens no window");
    });
  });
});

add_task(async function normal_mode_presses_no_arrow_key() {
  await withPrintRecorder(async (prints) => {
    await BrowserTestUtils.withNewTab(COMBO, async (browser) => {
      await recordPageKeys(browser);
      await focusContent(browser);
      await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "n");
      ctrl("p");
      await TestUtils.waitForCondition(() => prints() === 1, "ctrl+p prints in normal mode");
      const keys = await pageKeys(browser);
      Assert.ok(!keys.some((k) => k.includes("Arrow")), "no arrow key in normal mode");
    });
  });
});

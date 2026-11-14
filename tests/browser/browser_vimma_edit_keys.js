/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/key-handling-batch.md § 2. In text fields ctrl+w deletes the word before the
// caret, ctrl+u everything before it on the line, ctrl+h one character, with the editor's own
// commands so ctrl+z undoes them: in a page's input, textarea, contenteditable and frame, in the
// URL bar and on the `:` line. ctrl+j and ctrl+m are a trusted Enter there: a new line, a form's
// submit, the URL bar's load, the `:` line's run. A page that takes the key keeps it;
// [modal] insert_editing = false turns them off (Firefox's own ctrl+w stays off; ctrl+m mutes).
// Normal mode keeps ctrl+u and ctrl+w.

"use strict";

/* global focusContent, recordPageKeys, waitForPageKey, contextOf -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const MAC = AppConstants.platform === "macosx";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_insert_scroll.html";

/**
 * Sets a text field's value with the caret at its end, focused, in insert mode.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 * @param {string} text
 */
function fill(target, id, text) {
  return SpecialPowers.spawn(target, [id, text], (i, t) => {
    const el = /** @type {HTMLElement} */ (content.document.getElementById(i));
    el.focus();
    if ("value" in el && el.localName !== "div") {
      const field = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
      field.value = t;
      field.setSelectionRange(t.length, t.length);
    } else {
      el.textContent = t;
      const sel = /** @type {Selection} */ (content.getSelection());
      sel.collapse(el.firstChild, t.length);
    }
  });
}

/**
 * A field's text; a contenteditable's trailing space, which its editor keeps as a no-break
 * space, as a space.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 */
function fieldText(target, id) {
  return SpecialPowers.spawn(target, [id], (i) => {
    const el = /** @type {HTMLElement} */ (content.document.getElementById(i));
    return "value" in el && el.localName !== "div"
      ? /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el).value
      : /** @type {string} */ (el.textContent).replace(/\u00a0/g, " ");
  });
}

/**
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 * @param {string} want
 * @param {string} msg
 */
function waitForValue(target, id, want, msg) {
  return TestUtils.waitForCondition(async () => (await fieldText(target, id)) === want, msg);
}

/** ctrl+z, undo, as Firefox binds it. */
const undo = () => EventUtils.synthesizeKey("z", { accelKey: true });

/** @param {(browser: MozTabBrowser) => Promise<void>} fn */
async function withPage(fn) {
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
    await fn(browser);
  });
}

for (const id of ["text", "area", "ce"]) {
  add_task(async function ctrl_w_u_h_edit_and_undo_in_a_page_field() {
    await withPage(async (browser) => {
      await fill(browser, id, "foo bar baz");
      await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
      EventUtils.synthesizeKey("w", { ctrlKey: true });
      await waitForValue(browser, id, "foo bar ", `#${id}: ctrl+w deletes the last word`);
      undo();
      await waitForValue(browser, id, "foo bar baz", `#${id}: ctrl+z brings it back`);
      EventUtils.synthesizeKey("u", { ctrlKey: true });
      await waitForValue(browser, id, "", `#${id}: ctrl+u deletes to the line's start`);
      undo();
      await waitForValue(browser, id, "foo bar baz", `#${id}: ctrl+z undoes ctrl+u`);
      EventUtils.synthesizeKey("h", { ctrlKey: true });
      await waitForValue(browser, id, "foo bar ba", `#${id}: ctrl+h deletes a character`);
      Assert.equal(VimmaHost._browserMode(browser), "insert", "still in insert mode");
      Assert.ok(gBrowser.selectedBrowser === browser, "and the tab is still open");
    });
  });
}

add_task(async function ctrl_w_in_a_cross_origin_frame() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    await SpecialPowers.spawn(frame, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.getElementById("framed"));
    });
    await fill(frame, "framed", "one two");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    await waitForValue(frame, "framed", "one ", "ctrl+w deletes the word in the frame's input");
  });
});

add_task(async function a_page_that_takes_ctrl_w_keeps_it() {
  await withPage(async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      /** @type {HTMLElement} */ (content.document.getElementById("text")).addEventListener(
        "keydown",
        (e) => {
          if (e.ctrlKey) e.preventDefault();
        },
      );
    });
    await fill(browser, "text", "foo bar");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    EventUtils.synthesizeKey("x");
    await waitForValue(browser, "text", "foo barx", "the page's ctrl+w deleted nothing");
  });
});

add_task(async function normal_mode_keeps_ctrl_u_and_does_not_edit() {
  await withPage(async (browser) => {
    await fill(browser, "text", "foo bar");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "Esc");
    await SpecialPowers.spawn(browser, [], () => content.scrollTo(0, 3000));
    EventUtils.synthesizeKey("u", { ctrlKey: true });
    await TestUtils.waitForCondition(
      async () => (await SpecialPowers.spawn(browser, [], () => content.scrollY)) < 3000,
      "ctrl+u scrolls up half a page in normal mode",
    );
    Assert.equal(await fieldText(browser, "text"), "foo bar", "and edits nothing");
  });
});

add_task(async function the_url_bar() {
  await withPage(async () => {
    gURLBar.focus();
    gURLBar.value = "foo bar";
    gURLBar.inputField.setSelectionRange(7, 7);
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    Assert.equal(gURLBar.value, "foo ", "ctrl+w deletes the word in the URL bar");
    undo();
    Assert.equal(gURLBar.value, "foo bar", "ctrl+z undoes it");
    EventUtils.synthesizeKey("h", { ctrlKey: true });
    Assert.equal(gURLBar.value, "foo ba", "ctrl+h is a backspace");
    EventUtils.synthesizeKey("u", { ctrlKey: true });
    Assert.equal(gURLBar.value, "", "ctrl+u clears to the start");
    gURLBar.handleRevert();
    EventUtils.synthesizeKey("KEY_Escape");
  });
});

add_task(async function the_command_line() {
  await withPage(async () => {
    EventUtils.synthesizeKey(":");
    // waitForCondition resolves with the field once it is there.
    const input = /** @type {HTMLInputElement} */ (
      await TestUtils.waitForCondition(
        () => document.getElementById("vimma-cmdline-input"),
        "the : line opens",
      )
    );
    await TestUtils.waitForCondition(() => document.activeElement === input, "and has focus");
    EventUtils.sendString("open foo bar");
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    Assert.equal(input.value, "open foo ", "ctrl+w deletes a word on the : line");
    undo();
    Assert.equal(input.value, "open foo bar", "ctrl+z undoes it");
    EventUtils.synthesizeKey("h", { ctrlKey: true });
    Assert.equal(input.value, "open foo ba", "ctrl+h");
    EventUtils.synthesizeKey("u", { ctrlKey: true });
    Assert.equal(input.value, "", "ctrl+u");
    EventUtils.synthesizeKey("KEY_Escape");
  });
});

add_task(async function insert_editing_false_turns_them_off() {
  VimmaHost.configure({ insertEditing: false });
  registerCleanupFunction(() => VimmaHost.configure({ insertEditing: true }));
  await withPage(async (browser) => {
    await fill(browser, "text", "foo bar");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    Assert.ok(await waitForPageKey(browser, ["w"]), "the page got ctrl+w");
    EventUtils.synthesizeKey("x");
    await waitForValue(browser, "text", "foo barx", "ctrl+w deleted nothing");
    Assert.ok(gBrowser.selectedBrowser === browser, "and Firefox's close tab stayed off");

    gURLBar.focus();
    gURLBar.value = "foo bar";
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    Assert.equal(gURLBar.value, "foo bar", "nor in the URL bar");
    gURLBar.handleRevert();
  });
  VimmaHost.configure({ insertEditing: true });
});

// ctrl+j and ctrl+m are Enter, as in Vim (i_CTRL-J, i_CTRL-M; c_CTRL-J on the command line).
const ENTER_PAGE = ROOT + "file_vimma_enter_keys.html";

/** @param {XULBrowserElement} browser */
const pageLog = (browser) =>
  SpecialPowers.spawn(browser, [], () => [...content.wrappedJSObject.log]);

/**
 * @param {XULBrowserElement} browser
 * @param {string} entry
 * @param {string} msg
 */
const waitForLog = (browser, entry, msg) =>
  TestUtils.waitForCondition(async () => (await pageLog(browser)).includes(entry), msg);

/** @param {(browser: MozTabBrowser) => Promise<void>} fn */
async function withEnterPage(fn) {
  await BrowserTestUtils.withNewTab(ENTER_PAGE, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
    await fn(browser);
  });
}

for (const key of ["j", "m"]) {
  add_task(async function ctrl_j_m_submit_a_single_line_inputs_form_with_a_trusted_enter() {
    await withEnterPage(async (browser) => {
      await fill(browser, "text", "query");
      await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
      EventUtils.synthesizeKey(key, { ctrlKey: true });
      await waitForLog(browser, "submit:true", `ctrl+${key} submits the form, as Enter does`);
      Assert.ok(
        (await pageLog(browser)).includes("Enter:true:false"),
        "the page saw a trusted Enter without ctrl",
      );
      Assert.equal(await fieldText(browser, "text"), "query", "and typed nothing");
    });
  });

  for (const id of ["area", "ce"]) {
    add_task(async function ctrl_j_m_begin_a_new_line_in_a_multi_line_field() {
      await withEnterPage(async (browser) => {
        await fill(browser, id, "one");
        await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
        EventUtils.synthesizeKey(key, { ctrlKey: true });
        await waitForLog(browser, "Enter:true:false", `#${id}: ctrl+${key} is a trusted Enter`);
        EventUtils.sendString("two");
        await TestUtils.waitForCondition(async () => {
          const lines = await SpecialPowers.spawn(browser, [id], (i) => {
            const el = /** @type {HTMLElement} */ (content.document.getElementById(i));
            return el.localName === "textarea"
              ? /** @type {HTMLTextAreaElement} */ (el).value.split("\n")
              : el.innerText.split("\n");
          });
          return lines[0] === "one" && lines.at(-1) === "two" && lines.length >= 2;
        }, `#${id}: ctrl+${key} begins a new line`);
        Assert.equal(VimmaHost._browserMode(browser), "insert", "still in insert mode");
      });
    });
  }
}

// docs/security.md K5: a busy page's late reply must not press Enter in the tab focused since.
add_task(async function a_late_reply_presses_no_enter_in_another_tab() {
  const other = ENTER_PAGE.replace("https://example.com", "https://example.org");
  const tabB = await BrowserTestUtils.openNewForegroundTab(gBrowser, other);
  await withEnterPage(async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      /** @type {HTMLElement} */ (content.document.getElementById("area")).addEventListener(
        "keydown",
        (e) => {
          if (!e.ctrlKey || e.key !== "j") return;
          const end = Date.now() + 1500;
          while (Date.now() < end) {
            // Holds the reply back, as a busy page does.
          }
          content.wrappedJSObject.log.push("busy-done");
        },
      );
    });
    await fill(browser, "area", "one");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    EventUtils.synthesizeKey("j", { ctrlKey: true });
    await BrowserTestUtils.switchTab(gBrowser, tabB);
    await focusContent(tabB.linkedBrowser);
    await fill(tabB.linkedBrowser, "text", "b");
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(tabB.linkedBrowser) === "insert",
      "tab B in insert",
    );
    await waitForLog(browser, "busy-done", "tab A handled its ctrl+j");
    // The reply goes to the parent before this answer from A's process, and a pressed Enter
    // would reach B before this answer from B.
    await pageLog(browser);
    await new Promise((r) => Services.tm.dispatchToMainThread(() => r(undefined)));
    const log = await pageLog(tabB.linkedBrowser);
    Assert.ok(!log.some((e) => e.startsWith("Enter")), "tab B got no Enter");
    Assert.ok(!log.includes("submit:true"), "and its form was not sent");
    Assert.equal(await fieldText(browser, "area"), "one", "nor did tab A get a line");
  });
  BrowserTestUtils.removeTab(tabB);
});

add_task(async function a_page_that_takes_ctrl_j_keeps_it() {
  await withEnterPage(async (browser) => {
    await fill(browser, "term", "ls");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    EventUtils.synthesizeKey("j", { ctrlKey: true });
    await waitForLog(browser, "term:ctrl+j", "the page handled ctrl+j");
    EventUtils.synthesizeKey("x");
    await waitForValue(browser, "term", "lsx", "the next key still types");
    Assert.ok(
      !(await pageLog(browser)).some((e) => e.startsWith("Enter")),
      "and Vimma sent no Enter",
    );
  });
});

add_task(async function ctrl_j_in_the_url_bar_navigates() {
  await withEnterPage(async (browser) => {
    const url = ENTER_PAGE + "?from-url-bar";
    gURLBar.focus();
    gURLBar.value = url;
    const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
    EventUtils.synthesizeKey("j", { ctrlKey: true });
    await loaded;
    Assert.equal(browser.currentURI.spec, url, "ctrl+j loads the address, as Enter does");
  });
});

add_task(async function ctrl_m_on_the_command_line_runs_the_command() {
  await withEnterPage(async (browser) => {
    EventUtils.synthesizeKey(":");
    // waitForCondition resolves with the field once it is there.
    const input = /** @type {HTMLInputElement} */ (
      await TestUtils.waitForCondition(
        () => document.getElementById("vimma-cmdline-input"),
        "the : line opens",
      )
    );
    await TestUtils.waitForCondition(() => document.activeElement === input, "and has focus");
    const url = ENTER_PAGE + "?from-cmdline";
    EventUtils.sendString(`open ${url}`);
    const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
    EventUtils.synthesizeKey("m", { ctrlKey: true });
    await loaded;
    Assert.equal(browser.currentURI.spec, url, "ctrl+m runs :open, as Enter does");
  });
});

add_task(async function insert_editing_false_keeps_ctrl_m_as_mute_in_a_field() {
  const { compileKeymap } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/core/keymap.mjs",
  );
  const restore = () =>
    VimmaHost.configure({
      insertEditing: true,
      keymap: compileKeymap({}, { mac: MAC }),
    });
  VimmaHost.configure({
    insertEditing: false,
    keymap: compileKeymap({ modal: { insert_editing: false } }, { mac: MAC }),
  });
  registerCleanupFunction(restore);
  await withEnterPage(async (browser) => {
    await fill(browser, "area", "one");
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "i");
    const tab = /** @type {MozTabbrowserTab} */ (gBrowser.getTabForBrowser(browser));
    EventUtils.synthesizeKey("m", { ctrlKey: true });
    Assert.ok(await waitForPageKey(browser, ["m"]), "the page got ctrl+m");
    await TestUtils.waitForCondition(() => tab.muted, "ctrl+m mutes the tab, after the page");
    EventUtils.synthesizeKey("x");
    await waitForValue(browser, "area", "onex", "no new line");
    Assert.ok(
      !(await pageLog(browser)).some((e) => e.startsWith("Enter")),
      "and no Enter reached the page",
    );
    tab.toggleMuteAudio();
  });
  restore();
});

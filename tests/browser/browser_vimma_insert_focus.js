/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/insert-focus.md

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey, contextOf, windowGlobalOf -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_insert_focus.html";
const LOGIN = ROOT + "file_vimma_insert_autofocus.html";
const TRAP = ROOT + "file_vimma_insert_trap.html";
const TAB_FRAME = ROOT + "file_vimma_insert_tab_frame.html";

/** Vimma's j step, in CSS pixels. */
const STEP = 60;

/**
 * Opens `url` in a new tab with content focus and records the page's keydowns, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 * @param {string} [url]
 * @param {"normal" | "insert"} [mode] the mode the page opens in
 */
async function withPage(fn, url = PAGE, mode = "normal") {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await waitForMode(browser, mode);
    await fn(browser);
  });
}

/**
 * @param {XULBrowserElement} browser
 * @param {"normal" | "insert"} mode
 */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === mode,
    `the tab is in ${mode} mode`,
  );
}

/** @param {XULBrowserElement | BrowsingContext} target */
function activeId(target) {
  return SpecialPowers.spawn(target, [], () => content.document.activeElement?.id ?? "");
}

/**
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 */
function waitForActive(target, id) {
  return TestUtils.waitForCondition(async () => (await activeId(target)) === id, `#${id} focused`);
}

/**
 * Focuses `#id` from the page's own script, with no user input.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 */
function pageFocuses(target, id) {
  return SpecialPowers.spawn(target, [id], (i) =>
    /** @type {HTMLElement} */ (content.document.getElementById(i)).focus(),
  );
}

/** @param {XULBrowserElement} browser */
function pageScrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/**
 * Leaves insert with Esc and waits for normal mode. The page's blur can still be on its way.
 * @param {XULBrowserElement} browser
 */
async function leaveInsert(browser) {
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode(browser, "normal");
}

// Behaviour 1: a page that moves focus off the field after `i` or `gi` does not end insert.
add_task(async function after_i_the_page_moving_focus_off_the_field_keeps_insert() {
  await withPage(async (browser) => {
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "first");
    // The page's script answers "go" by focusing its result list, a file finder's pattern.
    EventUtils.sendString("go");
    await waitForActive(browser, "results");
    EventUtils.synthesizeKey("t");
    EventUtils.synthesizeKey("j");
    Assert.ok(await waitForPageKey(browser, ["j"]), "the page received j");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "the tab is still in insert");
    Assert.deepEqual(await pageKeys(browser), ["g", "o", "t", "j"], "the page got every key");
    Assert.equal(gBrowser.tabs.length, tabs, "t opened no tab");
    Assert.equal(await pageScrollY(browser), 0, "j did not scroll");

    await leaveInsert(browser);
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await pageScrollY(browser)) === STEP,
      "j scrolls",
    );
  });
});

add_task(async function after_i_the_page_blurring_the_field_keeps_insert() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "first");
    await SpecialPowers.spawn(browser, [], () =>
      /** @type {HTMLElement} */ (content.document.activeElement).blur(),
    );
    EventUtils.synthesizeKey("j");
    Assert.ok(await waitForPageKey(browser, ["j"]), "j reached the page");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "the tab is still in insert");
  });
});

add_task(async function after_i_on_a_page_with_no_field_a_page_focus_keeps_insert() {
  await withPage(async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      for (const el of content.document.querySelectorAll("input, [contenteditable], iframe")) {
        el.remove();
      }
    });
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await pageFocuses(browser, "button");
    EventUtils.synthesizeKey("j");
    Assert.ok(await waitForPageKey(browser, ["j"]), "j reached the page");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "the tab is still in insert");
  });
});

add_task(async function after_gi_the_page_moving_focus_off_the_field_keeps_insert() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("2");
    EventUtils.synthesizeKey("g");
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "second");
    await pageFocuses(browser, "results");
    EventUtils.synthesizeKey("j");
    Assert.ok(await waitForPageKey(browser, ["j"]), "j reached the page");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "the tab is still in insert");
  });
});

// Behaviour 3: `i` goes back to the field the user was last in.
add_task(async function i_focuses_the_field_last_used() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "second");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "second");
  });
});

add_task(async function i_focuses_the_editor_last_used() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "editor");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "editor");
  });
});

add_task(async function i_focuses_the_field_last_used_in_a_cross_origin_frame() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    await pageFocuses(frame, "framed");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await TestUtils.waitForCondition(
      () => Services.focus.focusedContentBrowsingContext === frame,
      "the frame has focus",
    );
    await waitForActive(frame, "framed");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(
          frame,
          [],
          () => /** @type {HTMLInputElement} */ (content.document.activeElement).value === "j",
        ),
      "j is typed into the frame's field",
    );
  });
});

add_task(async function i_falls_back_to_the_first_field_when_the_last_frame_navigated() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    await pageFocuses(frame, "framed");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    const before = windowGlobalOf(frame).innerWindowId;
    // The page loads a new document into its frame; the field the user typed in is gone.
    await SpecialPowers.spawn(browser, [], () => {
      const el = /** @type {HTMLIFrameElement} */ (content.document.getElementById("frame"));
      el.src = el.src + "?again";
    });
    await TestUtils.waitForCondition(
      () => frame.currentWindowGlobal && frame.currentWindowGlobal.innerWindowId !== before,
      "the frame has a new document",
    );
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "first");
  });
});

add_task(async function i_falls_back_to_the_first_field_when_the_last_is_gone() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "second");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    await SpecialPowers.spawn(browser, [], () =>
      /** @type {HTMLElement} */ (content.document.getElementById("second")).remove(),
    );
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "first");
  });
});

// Behaviour 4: insert entered by focusing a field follows the focus.
add_task(async function an_autofocused_login_form_opens_in_insert_and_enter_keeps_it() {
  await withPage(
    async (browser) => {
      await waitForActive(browser, "user");
      EventUtils.synthesizeKey("KEY_Enter");
      await waitForActive(browser, "pass");
      EventUtils.synthesizeKey("j");
      await TestUtils.waitForCondition(
        () =>
          SpecialPowers.spawn(
            browser,
            [],
            () => /** @type {HTMLInputElement} */ (content.document.activeElement).value === "j",
          ),
        "j is typed into the password field",
      );
      Assert.equal(VimmaHost._browserMode(browser), "insert", "the tab is in insert");
    },
    LOGIN,
    "insert",
  );
});

add_task(async function a_page_moving_focus_from_a_field_to_a_button_leaves_insert() {
  await withPage(
    async (browser) => {
      await pageFocuses(browser, "submit");
      await waitForMode(browser, "normal");
    },
    LOGIN,
    "insert",
  );
});

// Behaviour 2: explicit insert belongs to the page it was entered on.
add_task(async function explicit_insert_ends_with_the_page() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    await waitForActive(browser, "first");
    const loaded = BrowserTestUtils.browserLoaded(browser, false, LOGIN);
    BrowserTestUtils.startLoadingURIString(browser, LOGIN);
    await loaded;
    await pageFocuses(browser, "submit");
    await waitForMode(browser, "normal");
  });
});

/**
 * Counts the focusin events `#id` gets from now on, in the page.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
function countFocusins(browser, id) {
  return SpecialPowers.spawn(browser, [id], (i) => {
    const win = content.wrappedJSObject;
    win.vimmaFocusins = 0;
    /** @type {HTMLElement} */ (content.document.getElementById(i)).addEventListener(
      "focusin",
      () => win.vimmaFocusins++,
    );
  });
}

/**
 * Resolves once `#id` has had a focusin since countFocusins and has focus, and the parent has
 * handled the page's focus report for it: a report is sent in the focusin, and a task answers
 * after the messages the page process sent before it.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
async function waitForPageRefocus(browser, id) {
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        browser,
        [id],
        (i) =>
          content.wrappedJSObject.vimmaFocusins > 0 && content.document.activeElement?.id === i,
      ),
    `the page focused #${id} again`,
  );
  await SpecialPowers.spawn(browser, [], () => {});
}

/**
 * The value of the field `#id`.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} id
 */
function fieldValue(target, id) {
  return SpecialPowers.spawn(
    target,
    [id],
    (i) => /** @type {HTMLInputElement} */ (content.document.getElementById(i)).value,
  );
}

// Behaviour 6: after Esc, the page focusing a field from its own script does not enter insert.
add_task(async function after_esc_a_page_refocusing_its_field_stays_in_normal() {
  await withPage(
    async (browser) => {
      await waitForActive(browser, "name");
      await countFocusins(browser, "name");
      await leaveInsert(browser);
      // The dialog's script puts the focus back into its field after the blur.
      await waitForPageRefocus(browser, "name");
      Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab stays in normal");

      EventUtils.synthesizeKey("j");
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.equal(await fieldValue(browser, "name"), "", "j is not typed into the field");
      Assert.ok(!(await pageKeys(browser)).includes("j"), "j is Vimma's");

      // The second Esc is normal mode's: the page has it first, and the dialog closes.
      EventUtils.synthesizeKey("KEY_Escape");
      await TestUtils.waitForCondition(
        () =>
          SpecialPowers.spawn(
            browser,
            [],
            () =>
              !(/** @type {HTMLDialogElement} */ (content.document.getElementById("dialog")).open),
          ),
        "the page's Esc closes its dialog",
      );
      Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is in normal");
    },
    TRAP,
    "insert",
  );
});

add_task(async function after_esc_on_a_trapping_page_i_click_and_tab_enter_insert() {
  await withPage(
    async (browser) => {
      await waitForActive(browser, "name");
      await countFocusins(browser, "name");
      await leaveInsert(browser);
      await waitForPageRefocus(browser, "name");

      EventUtils.synthesizeKey("i");
      await waitForMode(browser, "insert");
      EventUtils.synthesizeKey("a");
      await TestUtils.waitForCondition(
        async () => (await fieldValue(browser, "name")) === "a",
        "after i, a is typed",
      );

      await countFocusins(browser, "name");
      await leaveInsert(browser);
      await waitForPageRefocus(browser, "name");
      // A click on the field the page focused: it already has focus, so only the click tells.
      await BrowserTestUtils.synthesizeMouseAtCenter("#name", {}, browser);
      await waitForMode(browser, "insert");
      EventUtils.synthesizeKey("b");
      await TestUtils.waitForCondition(
        async () => (await fieldValue(browser, "name")) === "ab",
        "after a click, b is typed",
      );

      await countFocusins(browser, "name");
      await leaveInsert(browser);
      await waitForPageRefocus(browser, "name");
      EventUtils.synthesizeKey("KEY_Tab");
      await waitForActive(browser, "email");
      await waitForMode(browser, "insert");
      EventUtils.synthesizeKey("c");
      await TestUtils.waitForCondition(
        async () => (await fieldValue(browser, "email")) === "c",
        "after Tab, c is typed",
      );
    },
    TRAP,
    "insert",
  );
});

add_task(async function a_page_focusing_a_field_after_a_click_enters_insert() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "first");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    // A click on the page, then its script focuses a field: the user acted after the Esc.
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      /** @type {HTMLElement} */ (doc.getElementById("button")).addEventListener("click", () => {
        content.setTimeout(
          () => /** @type {HTMLElement} */ (doc.getElementById("second")).focus(),
          0,
        );
      });
    });
    await BrowserTestUtils.synthesizeMouseAtCenter("#button", {}, browser);
    await waitForActive(browser, "second");
    await waitForMode(browser, "insert");
  });
});

add_task(async function a_page_focusing_a_field_after_a_click_on_no_control_enters_insert() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "first");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    // A click on something that takes no focus (a toolbar item that prevents its mousedown),
    // then the page focuses a field a task later: the click is the user's.
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const item = doc.createElement("div");
      item.id = "item";
      item.textContent = "item";
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        content.setTimeout(
          () => /** @type {HTMLElement} */ (doc.getElementById("second")).focus(),
          0,
        );
      });
      doc.body.prepend(item);
    });
    await BrowserTestUtils.synthesizeMouseAtCenter("#item", {}, browser);
    await waitForActive(browser, "second");
    await waitForMode(browser, "insert");
  });
});

// Behaviour 7: a focus report the frame sent before Esc reached it does not undo the Esc.
add_task(async function esc_right_after_tab_into_a_cross_origin_frame_stays_in_normal() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    await pageFocuses(browser, "first");
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("KEY_Tab");
    // Esc before the frame's process has reported the focus Tab gave it.
    /** @type {string[]} */
    const seen = [];
    const original = VimmaHost.onModeChange;
    VimmaHost.onModeChange = (b, mode) => {
      if (b === browser) seen.push(mode);
      original.call(VimmaHost, b, mode);
    };
    try {
      EventUtils.synthesizeKey("KEY_Escape");
      EventUtils.synthesizeKey("j");
      await TestUtils.waitForCondition(
        () => Services.focus.focusedContentBrowsingContext === frame,
        "Tab has moved focus into the frame",
      );
      // Every report either document sent before these round trips has been handled.
      await SpecialPowers.spawn(frame, [], () => {});
      await SpecialPowers.spawn(browser, [], () => {});
      await SpecialPowers.spawn(frame, [], () => {});
      Assert.deepEqual(seen, ["normal"], "after Esc the tab never went back to insert");
      Assert.equal(await fieldValue(frame, "framed"), "", "j is not typed into the frame");
      Assert.equal(await fieldValue(browser, "first"), "", "nor into the page");
    } finally {
      VimmaHost.onModeChange = original;
    }
  }, TAB_FRAME);
});

// After Esc, Tab into a cross-origin frame's field enters insert: its process handles no input,
// but the parent passed the page a key.
add_task(async function after_esc_tab_into_a_cross_origin_frame_enters_insert() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    await pageFocuses(browser, "first");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    await pageFocuses(browser, "first");
    await SpecialPowers.spawn(browser, [], () => {});
    Assert.equal(VimmaHost._browserMode(browser), "normal", "a scripted focus stays in normal");
    EventUtils.synthesizeKey("KEY_Tab");
    await waitForActive(frame, "framed");
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await fieldValue(frame, "framed")) === "j",
      "j is typed into the frame",
    );
  }, TAB_FRAME);
});

/**
 * Whether `#id` has focus and draws its keyboard focus ring.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
function focusVisible(browser, id) {
  return SpecialPowers.spawn(browser, [id], (i) => {
    const el = /** @type {HTMLElement} */ (content.document.getElementById(i));
    return content.document.activeElement === el && el.matches(":focus-visible");
  });
}

// Esc in normal mode clears the page's focus, so the ring Tab drew goes away (m1-core-logic,
// § Esc).
add_task(async function esc_in_normal_mode_blurs_what_tab_focused() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "editor");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    EventUtils.synthesizeKey("KEY_Tab");
    await waitForActive(browser, "button");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "a focused button stays in normal");
    Assert.ok(await focusVisible(browser, "button"), "Tab draws the button's focus ring");

    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          return doc.activeElement === doc.body && !doc.querySelector(":focus-visible");
        }),
      "Esc leaves nothing focused in the page",
    );
    Assert.ok((await pageKeys(browser)).includes("Escape"), "the page still had the Esc");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is in normal");
  });
});

/**
 * Keeps the page's process busy for half a second from its next task, so that the keys pressed next
 * and Esc's blur all wait there: the process then handles input first (#850).
 * @param {XULBrowserElement} browser
 */
function busyPage(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.setTimeout(() => {
      const end = Date.now() + 500;
      while (Date.now() < end) {
        // busy
      }
    }, 0);
  });
}

// Tab right after Esc: the page's process can handle the Tab before Esc's blur, which must
// then leave the focus Tab gave (#850).
add_task(async function tab_right_after_esc_on_a_busy_page_keeps_its_focus() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "editor");
    await waitForMode(browser, "insert");
    await busyPage(browser);
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Tab");
    // Queued after the blur, so it runs after it.
    await SpecialPowers.spawn(browser, [], () => {});
    Assert.equal(await activeId(browser), "button", "Tab's focus stays");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is in normal");
  });
});

// Tab right before Esc: the page handled it before the blur was asked for, so the blur takes
// the focus Tab gave.
add_task(async function tab_right_before_esc_on_a_busy_page_is_blurred() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "first");
    await waitForMode(browser, "insert");
    // Where the Tab found focus: the content process usually runs input first, but not always.
    await SpecialPowers.spawn(browser, [], () => {
      const win = content.wrappedJSObject;
      content.addEventListener("keydown", (e) => {
        if (e.key === "Tab") win.vimmaTabFrom = content.document.activeElement?.id ?? "";
      });
    });
    await busyPage(browser);
    EventUtils.synthesizeKey("KEY_Tab");
    EventUtils.synthesizeKey("KEY_Escape");
    await SpecialPowers.spawn(browser, [], () => {});
    const from = await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.vimmaTabFrom);
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is in normal");
    if (from !== "first") {
      // The blur ran first, so Tab started from nothing: this run tells nothing.
      info(`the blur ran before the Tab (Tab from "${from}")`);
      return;
    }
    Assert.equal(await activeId(browser), "", "nothing is focused in the page");
  });
});

// A key right after Esc that the page gets but that moves no focus: the late blur still
// takes the field's.
add_task(async function a_key_right_after_esc_on_a_busy_page_still_blurs() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "editor");
    await waitForMode(browser, "insert");
    await busyPage(browser);
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Shift");
    await SpecialPowers.spawn(browser, [], () => {});
    Assert.ok((await pageKeys(browser)).includes("Shift"), "the page got the key");
    Assert.equal(await activeId(browser), "", "nothing is focused in the page");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is in normal");
  });
});

// A page that takes Esc itself (preventDefault, as a menu that closes on Esc) keeps its focus.
add_task(async function esc_the_page_takes_keeps_its_focus() {
  await withPage(async (browser) => {
    await pageFocuses(browser, "editor");
    await waitForMode(browser, "insert");
    await leaveInsert(browser);
    await SpecialPowers.spawn(browser, [], () => {
      content.document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") e.preventDefault();
      });
    });
    EventUtils.synthesizeKey("KEY_Tab");
    await waitForActive(browser, "button");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      async () => (await pageKeys(browser)).includes("Escape"),
      "the page had the Esc",
    );
    // Every message the parent sent after the page's reply has reached the page.
    await SpecialPowers.spawn(browser, [], () => {});
    await SpecialPowers.spawn(browser, [], () => {});
    Assert.equal(await activeId(browser), "button", "the button keeps focus");
  });
});

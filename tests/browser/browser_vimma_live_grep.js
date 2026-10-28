/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/live-grep.md. ctrl+b f g searches the text of the workspace's tabs as you
// type, lists each match with its tab and line, best next to the prompt at the bottom, beside a
// preview; Enter selects the tab, selects the match and scrolls it to the middle; ]q and [q step
// the results afterwards.

"use strict";

/* global focusContent -- from head.js */
/* global docShell -- in SpecialPowers.spawn's content task scope */
/* global VimmaHost, PaneViews, leaves, PAGE -- from head_vimma_grep.js */
/* global OTHER_SITE, OTHER_WS, def, ww, dialog, isOpen, rows -- from head_vimma_grep.js */
/* global textOf, texts, selectedRow, countText, flagsText -- from head_vimma_grep.js */
/* global noticeText, scopeTitle, closedTitle, closeTitled -- from head_vimma_grep.js */
/* global closeWindowTitled, ctrlS, until, openFixture, reset -- from head_vimma_grep.js */
/* global openGrep, type, clearQuery, resultsSettle -- from head_vimma_grep.js */
/* global setupSecondWorkspace -- from head_vimma_grep.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_grep.js", this);

add_task(setupSecondWorkspace);

add_task(async function lists_matches_in_tab_order_best_at_the_prompt_and_cycles_scope() {
  await reset();
  ww().switchTo({ id: def(OTHER_WS).id });
  await openFixture({ title: "Delta", t: "delta needle" });
  ww().switchTo({ id: def("main").id });
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  await openFixture({ title: "Bravo", t: "bravo needle|bravo second needle" });
  await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);

  await openGrep();
  Assert.equal(VimmaHost.status(window).mode, "help", "a modal picker owns the keys");
  const prompt = dialog().querySelector(".vimma-grep-prompt");
  const results = dialog().querySelector(".vimma-grep-results");
  type("needle");
  await resultsSettle(4);
  Assert.deepEqual(
    texts(),
    ["alpha needle", "bravo needle", "bravo second needle", "charlie needle"],
    "the workspace's matches, in tab order, best first",
  );
  Assert.equal(selectedRow(), rows()[0], "the best result is selected");
  Assert.ok(selectedRow().classList.contains("vimma-grep-selected"), "and marked");
  Assert.equal(selectedRow().querySelector("mark")?.textContent, "needle", "match highlighted");
  Assert.ok(
    rows()[0].getBoundingClientRect().top > rows()[3].getBoundingClientRect().top,
    "the best result is at the bottom of the list",
  );
  Assert.ok(
    prompt.getBoundingClientRect().top >= results.getBoundingClientRect().bottom - 1,
    "the prompt is below the results",
  );
  Assert.ok(rows()[0].querySelector(".vimma-grep-tab").textContent.includes("Alpha"), "its tab");
  Assert.equal(rows()[2].querySelector(".vimma-grep-line").textContent, ":2:", "its line");
  Assert.equal(countText(), "4 / 4", "the count");
  Assert.equal(dialog().querySelector(".vimma-grep-query").textContent, "needle", "the query");

  Assert.equal(scopeTitle(), "Scope: this workspace · ctrl+s", "the scope box names the scope");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(5);
  Assert.equal(texts().at(-1), "delta needle", "window scope adds the other workspace, after");
  Assert.equal(scopeTitle(), "Scope: this window · ctrl+s", "the scope box names the scope");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(5);
  Assert.equal(scopeTitle(), "Scope: all windows · ctrl+s", "all windows: this one alone here");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await until(() => scopeTitle() === "Scope: all windows + closed · ctrl+s", "and closed");
  await until(() => !dialog().hasAttribute("busy"), "settled");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(4);
  Assert.equal(scopeTitle(), "Scope: this workspace · ctrl+s", "back to the workspace");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(isOpen(), "the first Esc goes to browse mode");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!isOpen(), "the second closes");
});

add_task(async function enter_selects_the_tab_and_the_match_in_the_middle_in_normal_mode() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const b = await openFixture({ title: "Bravo", t: "bravo needle|bravo second needle", pad: 200 });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(3);
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("p", { ctrlKey: true });
  Assert.equal(textOf(selectedRow()), "bravo second needle", "up moves away from the best");
  EventUtils.synthesizeKey("n", { ctrlKey: true });
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter closes the picker");
  await until(() => gBrowser.selectedTab === b, "and selects the tab");
  const where = await SpecialPowers.spawn(b.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() === "needle",
      "the match is selected",
    );
    const sel = content.getSelection();
    const middle = () => {
      const { top } = sel.getRangeAt(0).getBoundingClientRect();
      return top > content.innerHeight / 3 && top < (content.innerHeight * 2) / 3;
    };
    // Smooth scrolling takes a few frames to get there.
    await ContentTaskUtils.waitForCondition(middle, "scrolled to the middle").catch(() => {});
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const controller = docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsISelectionDisplay)
      .QueryInterface(Ci.nsISelectionController);
    return {
      line: sel.anchorNode.textContent,
      attention: controller.getDisplaySelection() === Ci.nsISelectionController.SELECTION_ATTENTION,
      top: r.top,
      height: content.innerHeight,
    };
  });
  Assert.equal(where.line, "bravo second needle", "in the chosen line");
  Assert.ok(where.attention, "shown as find shows its match");
  Assert.greater(where.top, where.height / 3, "in the middle third of the view");
  Assert.less(where.top, (where.height * 2) / 3, "in the middle third of the view");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  Assert.equal(document.activeElement, b.linkedBrowser, "the page has focus");

  EventUtils.synthesizeKey("v");
  await until(() => VimmaHost.status(window).mode === "visual", "v enters copy mode");
  const kept = await SpecialPowers.spawn(b.linkedBrowser, [], () =>
    content.getSelection().toString(),
  );
  Assert.equal(kept, "needle", "with the match selected");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "back to normal");
});

add_task(async function the_grep_list_steps_with_bracket_q_and_grep_resumes() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const b = await openFixture({ title: "Bravo", t: "bravo needle|bravo second needle" });
  const c = await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(4);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the first result");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  await focusContent(a.linkedBrowser);

  type("]q");
  await until(() => gBrowser.selectedTab === b, "]q goes to the next result, in Bravo");
  Assert.equal(noticeText(), "grep 2/4", "the notice says where in the list");
  await focusContent(b.linkedBrowser);
  type("]q");
  await until(() => noticeText() === "grep 3/4", "the next one, in the same tab");
  const second = await SpecialPowers.spawn(b.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().anchorNode?.textContent === "bravo second needle",
      "the second line's match",
    );
    return content.getSelection().toString();
  });
  Assert.equal(second, "needle", "the match is selected");
  type("]q");
  await until(() => gBrowser.selectedTab === c, "then Charlie");
  await focusContent(c.linkedBrowser);
  type("]q");
  await until(() => gBrowser.selectedTab === a, "]q wraps to the first");
  await focusContent(a.linkedBrowser);
  type("[q");
  await until(() => gBrowser.selectedTab === c, "[q wraps back to the last");

  const closed = b.linkedPanel;
  BrowserTestUtils.removeTab(b);
  Assert.ok(
    VimmaHost._grep(window).list.rows.every((r) => r.tabId !== closed),
    "a closed tab's lines leave the grep list",
  );
  await focusContent(c.linkedBrowser);
  type("[q");
  await until(() => gBrowser.selectedTab === a, "a closed tab's results are skipped");

  await focusContent(a.linkedBrowser);
  type(":grep");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => isOpen(), ":grep alone reopens live grep");
  Assert.equal(dialog().querySelector(".vimma-grep-query").textContent, "needle", "last query");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  type(":grep charlie");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => isOpen(), ":grep text opens with that query");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["charlie needle"], "and searches it");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_cross_site_frame_and_shadow_roots_are_searched() {
  await reset();
  const tab = await openFixture({ title: "Framed", t: "top", frame: 1, shadow: 1 });
  await openGrep();
  type("needle in");
  await resultsSettle(3);
  Assert.deepEqual(
    texts(),
    ["needle in open shadow", "needle in closed shadow", "needle in frame"],
    "open and closed shadow roots, then the frame",
  );
  const frameRow = rows()[2];
  Assert.equal(
    frameRow.querySelector(".vimma-grep-frame")?.textContent,
    "↳ example.org",
    "a frame from another site names its host",
  );
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const frame = tab.linkedBrowser.browsingContext.children[0];
  const inFrame = await SpecialPowers.spawn(frame, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() === "needle in",
      "the frame's match is selected",
    );
    return content.document.hasFocus();
  });
  Assert.ok(inFrame, "and the frame has focus");

  await focusContent(tab.linkedBrowser);
  await openGrep();
  type("closed shadow");
  await resultsSettle(1);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped into the closed shadow root");
  const inShadow = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().rangeCount > 0,
      "a selection",
    );
    const range = content.getSelection().getRangeAt(0);
    return range.startContainer.textContent.slice(range.startOffset, range.endOffset);
  });
  Assert.equal(inShadow, "closed shadow", "the match in the closed shadow root is selected");
});

add_task(async function smart_case_regular_expressions_and_the_literal_fallback() {
  await reset();
  await openFixture({ title: "Case", t: "Needle upper|needle lower|neeedle long|in c++(x) code" });
  await openGrep();
  type("needle");
  await resultsSettle(2);
  Assert.deepEqual(texts(), ["Needle upper", "needle lower"], "lower case ignores case");
  clearQuery();
  type("Needle");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["Needle upper"], "a capital matches case");
  clearQuery();
  type("nee+dle");
  await resultsSettle(3);
  Assert.ok(!flagsText().includes("literal"), "a regular expression");
  clearQuery();
  type("c++(");
  await resultsSettle(1);
  Assert.ok(flagsText().includes("literal"), "an invalid one is literal, and says so");
  Assert.deepEqual(texts(), ["in c++(x) code"], "and finds the literal text");
  Assert.equal(rows()[0].querySelector("mark")?.textContent, "c++(", "the literal is marked");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_lazy_tab_is_listed_not_loaded_and_enter_selects_it() {
  await reset();
  const here = await openFixture({ title: "Loaded", t: "loaded needle" });
  const lazy = gBrowser.addTrustedTab(`${PAGE}?t=needle`, {
    createLazyBrowser: true,
    lazyTabTitle: "Lazy one",
    userContextId: here.userContextId,
  });
  await until(() => !lazy.linkedPanel, "a lazy tab");
  Assert.equal(gBrowser.selectedTab, here, "sanity: the loaded tab is selected");
  await openGrep();
  type("needle");
  await resultsSettle(2);
  const last = rows().at(-1);
  Assert.ok(textOf(last).includes("not loaded"), "listed as not loaded, at the far end");
  Assert.ok(last.querySelector(".vimma-grep-tab").textContent.includes("Lazy one"), "by title");
  Assert.ok(!lazy.linkedPanel, "the search did not load it");
  EventUtils.synthesizeKey("KEY_Escape");
  type("gg");
  Assert.equal(selectedRow()?.id, rows().at(-1).id, "gg goes to the top");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab === lazy, "Enter selects it");
});

add_task(async function a_changed_page_takes_the_remaining_match_or_says_it_is_gone() {
  await reset();
  const tab = await openFixture({ title: "Changing", t: "first needle|second needle" });
  await openGrep();
  type("needle");
  await resultsSettle(2);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("p").remove();
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const line = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() === "needle",
      "a match is selected",
    );
    return content.getSelection().anchorNode.textContent;
  });
  Assert.equal(line, "second needle", "the remaining match");

  await openGrep();
  type("second");
  await resultsSettle(1);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("p").textContent = "gone";
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === "match no longer on the page", "the notice says so");
});

add_task(async function enter_on_a_tab_in_a_split_focuses_its_pane() {
  await reset();
  const a = await openFixture({ title: "Left", t: "left text" });
  const b = await openFixture({ title: "Right", t: "right needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  const view = PaneViews.get(window);
  Assert.ok(view.split("vertical", { tab: b }).ok, "split a | b");
  view.focus("left");
  await until(() => gBrowser.selectedTab === a, "the left pane has focus");
  await openGrep();
  type("right needle");
  await resultsSettle(1);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab === b, "the right tab is selected");
  const focused = leaves(view.panes).find((l) => l.pane === view.panes.focus)?.tab;
  Assert.equal(focused, b.linkedPanel, "and its pane has focus");
  view.close();
});

add_task(async function the_preview_shows_the_lines_around_and_hides_when_narrow() {
  await reset();
  const lines = Array.from({ length: 30 }, (_, i) => (i === 14 ? "the needle line" : `line ${i}`));
  await openFixture({ title: "Preview", t: lines.join("|") });
  await openGrep();
  type("needle");
  await resultsSettle(1);
  const preview = dialog().querySelector(".vimma-grep-preview");
  Assert.equal(preview.getAttribute("role"), "region", "the preview is a region");
  Assert.equal(preview.getAttribute("aria-label"), "Grep Preview", "named Grep Preview");
  await until(
    () => preview.querySelector(".vimma-grep-preview-match")?.textContent === "the needle line",
    "the matched line is highlighted",
  );
  const shown = [...preview.querySelectorAll(".vimma-grep-preview-line")].map((l) => l.textContent);
  Assert.equal(shown.length, 21, "ten lines before and after");
  Assert.equal(shown[0], "line 4", "starting ten lines above");
  Assert.equal(
    preview.querySelector(".vimma-grep-preview-match mark")?.textContent,
    "needle",
    "with the match marked",
  );
  Assert.ok(BrowserTestUtils.isVisible(preview), "shown in a wide window");

  dialog().style.width = "800px";
  await until(() => !BrowserTestUtils.isVisible(preview), "hidden below 900 pixels");
  EventUtils.synthesizeKey("u", { ctrlKey: true });
  await until(
    () => dialog().querySelector(".vimma-grep-query").textContent === "",
    "ctrl+u clears",
  );
  dialog().style.width = "";
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_jump_that_ends_after_grep_reopens_keeps_the_new_search_frames() {
  await reset();
  await openFixture({ title: "Other", t: "second line" });
  await openFixture({ title: "Jump", t: "first needle" });
  await openGrep();
  const session = VimmaHost._grep(window);
  const { ask, preview: show } = session;
  /** @type {(() => void)[]} */
  const held = [];
  let jumped = false;
  // The jump's frame answers only after grep is open again on the other tab's results, and
  // that search's preview waits for the jump to end: the order a slow content process gives.
  session.ask = (/** @type {any[]} */ ...args) => {
    const reply = ask.apply(session, args);
    if (args[2] !== "Vimma:GrepJump") return reply;
    return new Promise((resolve) => held.push(() => resolve(reply.finally(() => (jumped = true)))));
  };
  type("needle");
  await resultsSettle(1);
  session.preview = async (/** @type {any} */ row) => {
    await TestUtils.waitForCondition(() => jumped, "the jump ends", 10, 500);
    await new Promise((r) => setTimeout(r, 0));
    return show.call(session, row);
  };
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => held.length > 0, "the jump is asked");
  session.ask = ask;
  await openGrep();
  type("second");
  await resultsSettle(1);
  for (const release of held) release();
  const preview = dialog().querySelector(".vimma-grep-preview");
  await until(
    () => preview.querySelector(".vimma-grep-preview-match")?.textContent === "second line",
    "the reopened grep's match is previewed",
  );
  session.preview = show;
  EventUtils.synthesizeKey("KEY_Escape");
});

// #419: on a slow machine a step's jump ended after grep was open again, and the step's GrepEnd
// then stopped that search's query in the frame, which listed nothing.
add_task(async function a_step_that_ends_after_grep_reopens_leaves_the_new_search_alone() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const c = await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the first result");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  await focusContent(a.linkedBrowser);

  const session = VimmaHost._grep(window);
  const { ask } = session;
  /** @type {(() => void)[]} */
  const held = [];
  let jumped = false;
  /** @type {Promise<unknown>[]} */
  const endedWhileOpen = [];
  // Charlie's frame answers the step's jump only once grep is open again: the order a slow
  // content process gives.
  session.ask = (/** @type {any[]} */ ...args) => {
    const reply = ask.apply(session, args);
    if (args[2] === "Vimma:GrepEnd" && session.isOpen) endedWhileOpen.push(reply);
    if (args[2] !== "Vimma:GrepJump") return reply;
    return new Promise((resolve) => held.push(() => resolve(reply.finally(() => (jumped = true)))));
  };
  try {
    type("]q");
    await until(() => held.length > 0, "the step asks Charlie's frame to select its match");
    await focusContent(c.linkedBrowser);
    type(":grep charlie");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => isOpen(), ":grep text opens with that query");
    await resultsSettle(1);
    for (const release of held) release();
    await until(() => jumped, "the step's jump ends");
    // What the step sends after its jump has been sent, and answered, by the next task.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all(endedWhileOpen);
    Assert.equal(endedWhileOpen.length, 0, "no frame is told to end while a search is open");
    const frames = await SpecialPowers.spawn(c.linkedBrowser, [], () => {
      const { GrepMatcher } = ChromeUtils.importESModule(
        "chrome://browser/content/vimma/actors/grep-matcher.mjs",
      );
      return GrepMatcher.frames.length;
    });
    Assert.equal(frames, 1, "the open search's text stays in Charlie's process");
    Assert.deepEqual(texts(), ["charlie needle"], "and its row stays listed");
  } finally {
    session.ask = ask;
  }
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
});

// #419: a step's jump waits for its tab switch (TabSwitchDone, at most 1 second), 300 to 400 ms
// on the macOS runner; grep opened meanwhile must keep its frame and the keyboard. Holding
// TabSwitchDone makes the jump wait the full second.
add_task(async function a_step_whose_tab_switch_ends_after_grep_reopens_stops_there() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const c = await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the first result");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  await focusContent(a.linkedBrowser);

  const session = VimmaHost._grep(window);
  const { ask, jump } = session;
  /** @type {string[]} */
  const sentWhileOpen = [];
  let jumped = false;
  session.ask = (/** @type {any[]} */ ...args) => {
    const name = args[2];
    if (session.isOpen && /^Vimma:Grep(Jump|End)$/.test(name)) sentWhileOpen.push(name);
    return ask.apply(session, args);
  };
  session.jump = async (/** @type {any[]} */ ...args) => {
    try {
      return await jump.apply(session, args);
    } finally {
      jumped = true;
    }
  };
  const hold = (/** @type {Event} */ e) => e.stopPropagation();
  window.addEventListener("TabSwitchDone", hold, true);
  try {
    type("]q");
    await until(() => gBrowser.selectedTab === c, "]q selects Charlie");
    await focusContent(c.linkedBrowser);
    type(":grep charlie");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => isOpen(), ":grep text opens with that query");
    await resultsSettle(1);
    await until(() => jumped, "the step's jump stops waiting for the tab switch");
    await new Promise((r) => setTimeout(r, 0));
    Assert.deepEqual(sentWhileOpen, [], "it asks the frame nothing while the search is open");
    Assert.ok(dialog().contains(document.activeElement), "and the keyboard stays in grep");
    const frames = await SpecialPowers.spawn(c.linkedBrowser, [], () => {
      const { GrepMatcher } = ChromeUtils.importESModule(
        "chrome://browser/content/vimma/actors/grep-matcher.mjs",
      );
      return GrepMatcher.frames.length;
    });
    Assert.equal(frames, 1, "the open search's text stays in Charlie's process");
  } finally {
    window.removeEventListener("TabSwitchDone", hold, true);
    session.ask = ask;
    session.jump = jump;
  }
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
});

add_task(async function replies_to_an_older_query_never_replace_newer_results() {
  await reset();
  await openFixture({ title: "Gen", t: "older match|newer match" });
  await openGrep();
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  /** @type {(() => void)[]} */
  const held = [];
  // The first query's frames answer only after the second query's.
  session.ask = (/** @type {any[]} */ ...args) => {
    const reply = ask.apply(session, args);
    if (args[1]?.query !== "older") return reply;
    return new Promise((resolve) => held.push(() => resolve(reply)));
  };
  type("older");
  await until(() => held.length > 0, "the first query is asked");
  clearQuery();
  type("newer");
  await resultsSettle(1);
  for (const release of held) release();
  await new Promise((r) => setTimeout(r, 300));
  Assert.deepEqual(texts(), ["newer match"], "the older query's late replies are dropped");
  session.ask = ask;
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_long_tab_title_is_cut_to_300_characters() {
  await reset();
  const title = `${"t".repeat(400)} end`;
  await openFixture({ title, t: "longtitleneedle" });
  await openGrep();
  type("longtitleneedle");
  await resultsSettle(1);
  const row = VimmaHost._grep(window).state.rows[0];
  Assert.equal(row.title, title.slice(0, 300), "the row holds the first 300 characters");
  Assert.ok(
    rows()[0].getAttribute("aria-label").length < 400,
    "and the option's name is bounded by it",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function results_name_their_tab_and_the_count_is_announced() {
  await reset();
  await openFixture({ title: "Spoken", t: "retry budget is 3" });
  await openGrep();
  const status = dialog().querySelector("[role=status]");
  Assert.equal(status?.getAttribute("aria-live"), "polite", "a polite live region");
  type("zzzz");
  await until(() => status.textContent === "no matches", "no matches is announced");
  clearQuery();
  type("retry");
  await resultsSettle(1);
  await until(() => status.textContent === "1 match in 1 tab", "the count is announced");
  Assert.equal(
    rows()[0].getAttribute("aria-label"),
    "retry budget is 3, Spoken, example.com, main",
    "the option names the line, its tab, its host and its workspace",
  );
  const list = dialog().querySelector("[role=listbox]");
  Assert.equal(list.getAttribute("aria-activedescendant"), rows()[0].id, "the active option");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function page_text_with_markup_stays_text() {
  await reset();
  const line = 'needle <img src=x onerror="alert(1)"> <b>bold</b>';
  await openFixture({ title: "<i>Markup</i>", t: line });
  await openGrep();
  type("needle");
  await resultsSettle(1);
  Assert.equal(textOf(rows()[0]), line, "the line shows as text");
  Assert.ok(rows()[0].querySelector(".vimma-grep-tab").textContent.includes("<i>Markup</i>"));
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "no page markup in the picker");
  await until(
    () => !!dialog().querySelector(".vimma-grep-preview-match"),
    "the preview shows the line",
  );
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "nor in the preview");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  // Closed rows, their preview and the preview's title are text too (L3).
  const markup = '<img src=x onerror="alert(1)"><i>gone</i> markneedle';
  await closeTitled(markup);
  await closeWindowTitled(`<b>win</b> ${markup}`);
  await openGrep();
  type("markneedle");
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await resultsSettle(2);
  Assert.equal(closedTitle(rows()[0]), markup, "a closed title shows as text");
  const body = dialog().querySelector(".vimma-grep-preview-body");
  await until(() => body.textContent.includes(markup), "the closed tab's preview");
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "no markup from a closed tab");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  await until(() => body.textContent.includes("Recently closed window"), "the window's preview");
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "nor from a closed window");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function closing_tells_every_searched_frame_to_drop_its_text() {
  await reset();
  await openFixture({ title: "Ends", t: "needle top", frame: 1 });
  await openGrep();
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  const asked = new Set();
  const ended = new Set();
  session.ask = (/** @type {any[]} */ ...args) => {
    const [bc, , name = "Vimma:Grep"] = args;
    if (name === "Vimma:Grep") asked.add(bc.id);
    if (name === "Vimma:GrepEnd") ended.add(bc.id);
    return ask.apply(session, args);
  };
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  session.ask = ask;
  Assert.greaterOrEqual(asked.size, 2, "the page and its frame were searched");
  Assert.ok(
    [...asked].every((id) => ended.has(id)),
    "each searched frame was told to drop its text",
  );
  Assert.equal(session.state, null, "the parent keeps no rows");
});

add_task(async function white_space_the_markup_wraps_matches_one_space() {
  await reset();
  const tab = await openFixture({ title: "Wrapped", t: "wrapped\n      across   lines needle" });
  await openGrep();
  type("wrapped across lines");
  await resultsSettle(1);
  Assert.equal(textOf(rows()[0]), "wrapped across lines needle", "shown as layout shows it");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const selected = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().rangeCount > 0 && !content.getSelection().isCollapsed,
      "a selection",
    );
    const range = content.getSelection().getRangeAt(0);
    return range.startContainer.textContent.slice(range.startOffset, range.endOffset);
  });
  Assert.equal(selected, "wrapped\n      across   lines", "the selection covers the source text");
});

add_task(async function a_reply_held_past_close_still_gets_grep_end() {
  await reset();
  await openFixture({ title: "Slow", t: "needle slow" });
  await openGrep();
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  /** @type {(() => void)[]} */
  const held = [];
  const asked = new Set();
  const ended = new Set();
  session.ask = (/** @type {any[]} */ ...args) => {
    const [bc, , name = "Vimma:Grep"] = args;
    if (name === "Vimma:GrepEnd") ended.add(bc.id);
    const reply = ask.apply(session, args);
    if (name !== "Vimma:Grep") return reply;
    asked.add(bc.id);
    // Every frame answers only after the picker has closed.
    return new Promise((resolve) => held.push(() => resolve(reply)));
  };
  type("needle");
  await until(() => held.length >= 2, "the frames were asked");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed before any answer");
  for (const release of held) release();
  await new Promise((r) => setTimeout(r, 300));
  session.ask = ask;
  Assert.ok(
    [...asked].every((id) => ended.has(id)),
    "a frame that had not answered is told to drop its text too",
  );
});

add_task(async function frames_past_the_cap_are_not_searched() {
  await reset();
  const tab = await openFixture({ title: "Many frames", t: "top", frames: 150 });
  await until(
    () =>
      tab.linkedBrowser.browsingContext.children.length === 150 &&
      tab.linkedBrowser.browsingContext.children.every((c) => c.currentWindowGlobal),
    "150 frames",
  );
  await openGrep();
  type("needle frame");
  await until(() => rows().length > 0 && !dialog().hasAttribute("busy"), "results");
  Assert.equal(rows().length, 99, "the page and 99 frames: 100 frames a tab");
  Assert.ok(flagsText().includes("cut"), "the prompt says the search was cut");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_jump_never_reaches_a_document_the_frame_navigated_to() {
  await reset();
  const tab = await openFixture({ title: "Moving", t: "needle top", frame: 1 });
  await openGrep();
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the top frame's match");
  const frame = tab.linkedBrowser.browsingContext.children[0];
  const before = frame.currentWindowGlobal;
  const next = `${OTHER_SITE}?t=${encodeURIComponent("needle in frame")}&v=2`;
  await SpecialPowers.spawn(tab.linkedBrowser, [next], (url) => {
    content.document.querySelector("iframe").src = url;
  });
  await until(
    () => frame.currentWindowGlobal && frame.currentWindowGlobal !== before,
    "the frame navigated",
  );
  await until(() => !frame.currentWindowGlobal.isInitialDocument, "and loaded");
  await focusContent(tab.linkedBrowser);
  type("]q");
  await until(() => noticeText() === "match no longer on the page", "the jump is refused");
  const selected = await SpecialPowers.spawn(frame, [], () => content.getSelection().toString());
  Assert.equal(selected, "", "nothing is selected in the new document");
});

add_task(async function an_over_long_query_says_so_and_is_not_sent() {
  await reset();
  await openFixture({ title: "Long query", t: "needle" });
  await focusContent(gBrowser.selectedBrowser);
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  let sent = 0;
  session.ask = (/** @type {any[]} */ ...args) => {
    if ((args[2] ?? "Vimma:Grep") === "Vimma:Grep") sent++;
    return ask.apply(session, args);
  };
  session.open("x".repeat(1001));
  await until(() => flagsText().includes("too long"), "the prompt says the query is too long");
  await new Promise((r) => setTimeout(r, 300));
  Assert.ok(!flagsText().includes("timed out"), "not a time-out");
  Assert.equal(sent, 0, "no frame was asked");
  session.ask = ask;
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

/** The Vimma actor of `tab`'s top frame, after it dropped any earlier search. */
async function freshActor(tab) {
  const actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("Vimma");
  await actor.sendQuery("Vimma:GrepEnd", {});
  return actor;
}

/** A reply, or "no answer" after `ms`. */
function within(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("no answer"), ms))]);
}

add_task(async function a_frame_answers_timed_out_within_its_budget() {
  await reset();
  const tab = await openFixture({ title: "Budget", t: "needle here", long: 40 });
  const actor = await freshActor(tab);
  const t0 = performance.now();
  const reply = await within(actor.sendQuery("Vimma:Grep", { query: "(a+)+b", gen: 1 }), 5000);
  const ms = performance.now() - t0;
  Assert.equal(reply?.timedOut, true, "the frame itself says it timed out");
  Assert.less(ms, 1500, "within its 1-second budget, with no other query sent");
  await actor.sendQuery("Vimma:GrepEnd", {});
});

add_task(async function a_frame_drops_an_older_query() {
  await reset();
  const tab = await openFixture({ title: "Older", t: "needle here" });
  const actor = await freshActor(tab);
  const newer = await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 10 });
  Assert.equal(newer?.count, 1, "generation 10 is answered");
  const older = await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 5 });
  Assert.equal(older, null, "generation 5, older than one it has seen, is dropped");
  await actor.sendQuery("Vimma:GrepEnd", {});
});

add_task(async function grep_end_resets_the_frames_generation() {
  await reset();
  const tab = await openFixture({ title: "Reset", t: "needle here" });
  const actor = await freshActor(tab);
  Assert.equal((await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 10 }))?.count, 1);
  await actor.sendQuery("Vimma:GrepEnd", {});
  const next = await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 1 });
  Assert.equal(next?.count, 1, "after GrepEnd a new session's first generation is answered");
  await actor.sendQuery("Vimma:GrepEnd", {});
});

add_task(async function one_worker_a_process_and_none_for_a_blank_frame() {
  await reset();
  const tab = await openFixture({ title: "Workers", t: "top", frames: 3, blank: 1 });
  await until(
    () =>
      tab.linkedBrowser.browsingContext.children.length === 4 &&
      tab.linkedBrowser.browsingContext.children.every((c) => c.currentWindowGlobal),
    "4 frames",
  );
  await openGrep();
  type("needle frame");
  await resultsSettle(3);
  const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { GrepMatcher } = ChromeUtils.importESModule(
      "chrome://browser/content/vimma/actors/grep-matcher.mjs",
    );
    return { workers: GrepMatcher.workers, texts: GrepMatcher.frames.length };
  });
  Assert.equal(seen.workers, 1, "the page's frames share one worker in their process");
  Assert.equal(seen.texts, 4, "it holds the text of the page and its 3 frames, not the blank one");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  const after = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const { GrepMatcher } = ChromeUtils.importESModule(
      "chrome://browser/content/vimma/actors/grep-matcher.mjs",
    );
    await ContentTaskUtils.waitForCondition(() => GrepMatcher.workers === 0, "worker ended");
    return GrepMatcher.frames.length;
  });
  Assert.equal(after, 0, "closing the picker ends the worker and its texts");
});

// Last: before the fix, this pattern froze the page's process for good.
add_task(async function a_catastrophic_pattern_never_freezes_the_page() {
  await reset();
  const tab = await openFixture({ title: "Backtrack", t: "needle here", long: 40 });
  await openGrep();
  type("(a+)+b");
  await until(() => flagsText().includes("timed out"), "the search gives up in time");
  const answered = await Promise.race([
    SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title),
    new Promise((r) => setTimeout(() => r(null), 3000)),
  ]);
  Assert.equal(answered, "Backtrack", "the page's process still answers");
  clearQuery();
  type("needle");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["needle here"], "and the next query finds its match");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

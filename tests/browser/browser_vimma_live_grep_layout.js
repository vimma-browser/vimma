/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/live-grep.md decisions 5 and 6, a long line in a narrow list: each row and
// the preview keep the match in view, with some of the line before it (#1274). The rest of
// live grep is in browser_vimma_live_grep.js; the helpers are in head_vimma_grep.js.

"use strict";

/* global dialog, rows, textOf, until, openFixture, reset, openGrep, type -- from head_vimma_grep.js */
/* global resultsSettle, shownDialog -- from head_vimma_grep.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_grep.js", this);

add_task(async function long_lines_keep_the_match_in_view_in_rows_and_the_preview() {
  await reset();
  const lines = Array.from(
    { length: 6 },
    (_, i) =>
      `Paragraph ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed needle${i} ` +
      "do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam",
  );
  await openFixture({ title: "Long lines", t: lines.join("|") });
  await openGrep();
  registerCleanupFunction(() => {
    const d = dialog();
    if (d) d.style.width = "";
  });
  // A window about 1160 pixels wide, the narrowest that shows the preview: the dialog takes
  // 80 % of it, and the preview needs 900 pixels inside its padding.
  shownDialog().style.width = "930px";
  type("needle");
  await resultsSettle(6);
  const preview = /** @type {HTMLElement} */ (shownDialog().querySelector(".vimma-grep-preview"));
  Assert.ok(BrowserTestUtils.isVisible(preview), "the preview is shown at this width");
  /**
   * Whether `mark` lies wholly inside `box`, with at least three characters of `box` before it.
   * @param {Element} box
   * @param {Element | null} mark
   */
  const inView = (box, mark) => {
    if (!mark?.textContent) return false;
    const b = box.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    const ch = m.width / mark.textContent.length;
    return m.width > 0 && m.left >= b.left + 3 * ch && m.right <= b.right + 0.5;
  };
  await until(
    () =>
      rows().every((row) =>
        inView(
          /** @type {Element} */ (row.querySelector(".vimma-grep-where")),
          row.querySelector("mark"),
        ),
      ),
    "every row shows its match, with some of the line before it",
  );
  for (const [i, row] of rows().entries()) {
    Assert.equal(row.querySelector("mark")?.textContent, "needle", `row ${i} marks its match`);
    Assert.ok(textOf(row).includes(`needle${i}`), `row ${i} shows its own line`);
  }
  const body = /** @type {Element} */ (preview.querySelector(".vimma-grep-preview-body"));
  await until(
    () => inView(body, preview.querySelector(".vimma-grep-preview-match mark")),
    "the preview shows the match, with some of the line before it",
  );
  const rowsInView = () =>
    rows().every((row) =>
      inView(
        /** @type {Element} */ (row.querySelector(".vimma-grep-where")),
        row.querySelector("mark"),
      ),
    );
  // Wider, then narrow again: the lines are fitted again to the new width each time.
  const narrow = rows().map(textOf);
  shownDialog().style.width = "1400px";
  await until(
    () => rows().every((row, i) => textOf(row).length > (narrow[i]?.length ?? 0)) && rowsInView(),
    "a wider list shows more of each line",
  );
  shownDialog().style.width = "930px";
  await until(
    () => rows().every((row, i) => textOf(row) === narrow[i]) && rowsInView(),
    "narrow again, each row is fitted again around its match",
  );
  await until(
    () => inView(body, preview.querySelector(".vimma-grep-preview-match mark")),
    "and so is the preview",
  );
  shownDialog().style.width = "";
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

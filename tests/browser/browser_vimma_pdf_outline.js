/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md (delivery PR 4, decision 10), docs/security.md section 20 (V7,
// V8, V11): the outline panel on Tab and its `index` mode.
// file_vimma_outline_kinds.pdf has one outline entry of each kind: a named destination (page 2),
// a named action (LastPage), an https link, a javascript: link pdf.js refuses (no target), a
// title that looks like markup (page 3), an attachment, a Print action (not a navigation, so
// it follows nothing), and a collapsed entry with a child.

/* global add_setup -- the browser-chrome harness (browser-test.js) */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PdfOps } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/pdf-ops.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PDF = ROOT + "file_vimma_outline.pdf";
const KINDS = ROOT + "file_vimma_outline_kinds.pdf";
const NO_OUTLINE = ROOT + "file_vimma_test.pdf";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    // Most tasks here are about Tab opening the outline: they start with it closed, as
    // `[ui] pdf_outline = "hidden"` keeps it (decision 19). The tasks at the end show it.
    set: [
      ["general.smoothScroll", false],
      ["vimma.ui.pdf_outline.hidden", true],
    ],
  });
});

const panel = () => document.getElementById("vimma-outline");
const shown = () => !!panel() && !panel().hidden;
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const mode = () => VimmaHost._mode(VimmaHost._state(window));
/** @param {string} id */
const run = (id) => VimmaHost._run(VimmaHost._state(window), { kind: "action", action: { id } });
/** The titles of the rows shown, and the selected one. */
const rows = () =>
  [...(panel()?.querySelectorAll("[role=treeitem]") ?? [])].map(
    (li) => li.querySelector(".vimma-panel-title").textContent,
  );
const selected = () =>
  panel()?.querySelector("[role=treeitem][aria-selected=true] .vimma-panel-title")?.textContent;

/** @param {string} id */
const segment = (id) =>
  document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
    ?.textContent ?? "";

function loadPdf(browser, url) {
  const rendered = BrowserTestUtils.waitForContentEvent(
    browser,
    "textlayerrendered",
    false,
    null,
    true,
  );
  BrowserTestUtils.startLoadingURIString(browser, url);
  return rendered;
}

/** @param {XULBrowserElement} browser */
async function focusNormal(browser) {
  await SimpleTest.promiseFocus(browser);
  browser.focus();
  await TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === "normal",
    "the PDF viewer is in normal mode",
  );
}

/**
 * @param {(browser: XULBrowserElement, tab: any) => Promise<void>} fn
 * @param {string} [url]
 */
async function withPdf(fn, url = PDF) {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, url);
    await TestUtils.waitForCondition(() => segment("page").startsWith("page"), "the page");
    await focusNormal(browser);
    await fn(browser, tab);
  } finally {
    await closeOutline();
    BrowserTestUtils.removeTab(tab);
  }
}

async function closeOutline() {
  if (!shown()) return;
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !shown(), "the outline closes");
}

/** @param {XULBrowserElement} browser */
const page = (browser) =>
  SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.PDFViewerApplication.page);

/**
 * Until pdf.js shows page `want` and the parent has heard so: the outline opens on the page the
 * parent holds (PdfOps.state), which the viewer reports up to 100 ms after it moves (V5).
 * @param {XULBrowserElement} browser @param {number} want @param {string} what
 */
async function untilPage(browser, want, what) {
  await TestUtils.waitForCondition(
    async () => (await page(browser)) === want && PdfOps.state(browser)?.page === want,
    what,
  );
}

/** @param {string} keys */
const type = (keys) => EventUtils.sendString(keys);

async function openOutline() {
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(shown, "Tab opens the outline");
  Assert.equal(mode(), "index", "in index mode");
}

/** @param {string} want @param {string} what */
async function untilSelected(want, what) {
  await TestUtils.waitForCondition(() => selected() === want, `${what}: got ${selected()}`);
}

add_task(async function index_mode() {
  await withPdf(async (browser) => {
    type("5G");
    await untilPage(browser, 5, "5G");
    // The panel selects the entry for the page the status bar shows.
    await TestUtils.waitForCondition(() => segment("page") === "page 3 (5/6)", "the bar follows");
    // Another panel in the slot gives way.
    run("bookmarks.toggle");
    await TestUtils.waitForCondition(
      () => !document.getElementById("vimma-bookmarks")?.hidden,
      "the bookmarks panel is open",
    );
    browser.focus();
    await TestUtils.waitForCondition(() => mode() === "panel", "panel mode");
    run("pdf.outline");
    await TestUtils.waitForCondition(shown, "the outline opens");
    Assert.ok(document.getElementById("vimma-bookmarks").hidden, "the bookmarks panel closed");
    Assert.equal(panel().parentNode.id, "browser", "in the side panel's slot");
    Assert.equal(panel().parentNode.firstElementChild, panel(), "on the left");
    Assert.equal(selected(), "Section 1.2", "the entry for page 5 is selected");
    Assert.deepEqual(rows(), ["Preface", "Chapter 1", "Section 1.1", "Section 1.2", "Chapter 2"]);

    type("j");
    await untilSelected("Chapter 2", "j");
    type("kk");
    await untilSelected("Section 1.1", "kk");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    await untilSelected("Section 1.2", "down");
    EventUtils.synthesizeKey("KEY_ArrowUp");
    await untilSelected("Section 1.1", "up");
    type("h");
    await untilSelected("Chapter 1", "h on a leaf goes to its parent");
    type("h");
    await TestUtils.waitForCondition(() => rows().length === 3, "h collapses");
    type("l");
    await TestUtils.waitForCondition(() => rows().length === 5, "l expands");
    type("zc");
    await TestUtils.waitForCondition(() => rows().length === 3, "zc collapses");
    type("zo");
    await TestUtils.waitForCondition(() => rows().length === 5, "zo expands");
    type("zC");
    await TestUtils.waitForCondition(() => rows().length === 3, "zC collapses the subtree");
    type("zO");
    await TestUtils.waitForCondition(() => rows().length === 5, "zO expands the subtree");
    type("H");
    await TestUtils.waitForCondition(() => rows().length === 3, "H collapses all");
    type("L");
    await TestUtils.waitForCondition(() => rows().length === 5, "L expands all");
    type("zM");
    await TestUtils.waitForCondition(() => rows().length === 3, "zM collapses all");
    type("zR");
    await TestUtils.waitForCondition(() => rows().length === 5, "zR expands all");
    type("G");
    await untilSelected("Chapter 2", "G");
    type("gg");
    await untilSelected("Preface", "gg");
    EventUtils.synthesizeKey("d", { ctrlKey: true });
    await TestUtils.waitForCondition(() => selected() !== "Preface", "ctrl+d moves down");
    EventUtils.synthesizeKey("u", { ctrlKey: true });
    await untilSelected("Preface", "ctrl+u moves back up");

    // Enter goes to the entry and closes; ctrl+o comes back.
    type("jj");
    await untilSelected("Section 1.1", "jj");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilPage(browser, 4, "Enter goes to Section 1.1's page");
    await TestUtils.waitForCondition(() => !shown(), "and closes the outline");
    await TestUtils.waitForCondition(() => mode() === "normal", "back in normal mode");

    // space follows too.
    await openOutline();
    type("gg ");
    await untilPage(browser, 1, "space follows");
    await openOutline();
    type("G");
    await untilSelected("Chapter 2", "G");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilPage(browser, 6, "Enter follows");
  });
});

add_task(async function closing_keys_do_not_move() {
  await withPdf(async (browser) => {
    // No jumps in this document's history: nothing but the outline could move the page.
    type("2J");
    await untilPage(browser, 3, "2J");
    // Tab, Esc, ctrl+[, ctrl+c and q close without moving.
    for (const [key, opts] of [
      ["KEY_Tab", {}],
      ["KEY_Escape", {}],
      ["[", { ctrlKey: true }],
      ["q", {}],
    ]) {
      await openOutline();
      type("gg");
      await untilSelected("Preface", "gg");
      EventUtils.synthesizeKey(key, opts);
      await TestUtils.waitForCondition(() => !shown(), `${key} closes the outline`);
      Assert.equal(await page(browser), 3, `${key} does not move`);
    }
  });
});

add_task(async function the_filter() {
  await withPdf(async (browser) => {
    await openOutline();
    type("/");
    const filter = document.getElementById("vimma-outline-filter");
    await TestUtils.waitForCondition(() => document.activeElement === filter, "the filter");
    type("sec");
    await TestUtils.waitForCondition(() => rows().length === 2, "sec matches two");
    Assert.deepEqual(rows(), ["Section 1.1", "Section 1.2"], "best first");
    const path = panel().querySelector("[role=treeitem] .vimma-panel-host")?.textContent;
    Assert.equal(path, "Chapter 1", "each with the titles above it");
    Assert.equal(panel().querySelector("[role=treeitem] mark")?.textContent, "Sec", "marked");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    await untilSelected("Section 1.2", "down in the filter");
    EventUtils.synthesizeKey("KEY_ArrowUp");
    await untilSelected("Section 1.1", "up in the filter");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    await untilSelected("Section 1.2", "down again");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => rows().length === 5, "Esc returns to the outline");
    Assert.ok(shown(), "still open");
    type("/chap");
    await TestUtils.waitForCondition(() => rows().length === 2, "chap matches two");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilPage(browser, 3, "Enter goes to the first match");
    await TestUtils.waitForCondition(() => !shown(), "and closes");
  });
});

add_task(async function each_kind_of_entry() {
  await withPdf(async (browser) => {
    await openOutline();
    Assert.deepEqual(rows(), [
      "Named intro",
      "Last page action",
      "Example link",
      "Script link",
      "<img src=x onerror=alert(1)>",
      "Notes attachment",
      "Print action",
      "Deep",
    ]);
    // Only pdf.js's navigation actions are followed.
    Assert.equal(PdfOps.outline(browser).entries[6].kind, "none", "Print follows nothing");
    // outline_titles_with_html_stay_text
    Assert.equal(panel().querySelector("img"), null, "a title that looks like markup is text");
    // A named destination resolves to its page.
    type("gg");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilPage(browser, 2, "a named destination");
    await openOutline();
    type("ggj");
    await untilSelected("Last page action", "j");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilPage(browser, 4, "a named action");
    await openOutline();
    type("ggjjjj");
    await untilSelected("<img src=x onerror=alert(1)>", "jjjj");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilPage(browser, 3, "the markup-looking entry's page");
    // An attachment is pdf.js's to open.
    await openOutline();
    type("ggjjjjj");
    await untilSelected("Notes attachment", "jjjjj");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => noticeText() === "the PDF viewer does not open attachments",
      "an attachment entry says it is not opened",
    );
    // A collapsed entry starts collapsed.
    await openOutline();
    Assert.ok(!rows().includes("Deeper"), "a negative count starts collapsed");
    // an_outline_url_opens_only_under_section_4: the javascript: entry has no target.
    type("ggjjj");
    await untilSelected("Script link", "jjj");
    const url = browser.currentURI.spec;
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => !shown(), "it closes");
    // A round trip to the viewer: anything the key started there has happened.
    await SpecialPowers.spawn(browser, [], () => {});
    Assert.equal(browser.currentURI.spec, url, "a javascript: link does not run or navigate");
    // The https entry opens in the tab, as a link does.
    await openOutline();
    type("ggjj");
    await untilSelected("Example link", "jj");
    const loaded = BrowserTestUtils.browserLoaded(browser, false, (u) =>
      u.startsWith("https://example.org/outline"),
    );
    EventUtils.synthesizeKey("KEY_Enter");
    await loaded;
  }, KINDS);
});

add_task(async function a_pdf_without_an_outline_says_so() {
  await withPdf(async () => {
    EventUtils.synthesizeKey("KEY_Tab");
    await TestUtils.waitForCondition(
      () => noticeText() === "no outline in this PDF",
      "a PDF without an outline says so",
    );
    Assert.ok(!shown(), "and opens no panel");
    Assert.equal(mode(), "normal", "still in normal mode");
  }, NO_OUTLINE);
});

add_task(async function switching_tabs_closes_the_outline() {
  await withPdf(async (_browser, tab) => {
    await openOutline();
    const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
    gBrowser.selectedTab = other;
    await TestUtils.waitForCondition(() => !shown(), "another tab closes it");
    gBrowser.selectedTab = tab;
    BrowserTestUtils.removeTab(other);
  });
});

/**
 * Records the outline messages the parent gets.
 * @param {(seen: unknown[]) => Promise<void>} fn
 */
async function recordingOutline(fn) {
  /** @type {unknown[]} */
  const seen = [];
  const orig = PdfOps.onOutline;
  PdfOps.onOutline = (actor, data) => {
    seen.push(data);
    return orig.call(PdfOps, actor, data);
  };
  try {
    await fn(seen);
  } finally {
    PdfOps.onOutline = orig;
  }
}

add_task(async function the_outline_is_read_only_on_the_users_key() {
  await withPdf(async (browser) => {
    await recordingOutline(async (seen) => {
      type("3J");
      await untilPage(browser, 4, "3J");
      Assert.equal(seen.length, 0, "no outline message before Tab");
      Assert.equal(PdfOps.outline(browser), null, "and none kept");
      await openOutline();
      Assert.equal(seen.length, 1, "one after Tab");
      await closeOutline();
      await openOutline();
      Assert.equal(seen.length, 1, "a second Tab opens the outline already read");
      await closeOutline();
      // An outline the parent did not ask for is dropped (V8).
      const wg = browser.browsingContext.currentWindowGlobal;
      const before = PdfOps.outline(browser);
      wg.getActor("Vimma").sendAsyncMessage("Vimma:PdfOp", { op: "outline", n: 0 });
      await TestUtils.waitForCondition(() => seen.length === 2, "the child answers");
      Assert.equal(PdfOps.outline(browser), before, "and the parent keeps what it had");
      // the_parent_sends_only_operations_and_numbers: Enter names the entry by its index.
      const sent = [];
      const actor = wg.getActor("Vimma");
      const orig = actor.sendAsyncMessage;
      actor.sendAsyncMessage = function (name, data) {
        if (name === "Vimma:PdfOp") sent.push(data);
        return orig.call(this, name, data);
      };
      try {
        await openOutline();
        type("gg");
        EventUtils.synthesizeKey("KEY_Enter");
        await untilPage(browser, 1, "Enter on Preface");
      } finally {
        actor.sendAsyncMessage = orig;
      }
      Assert.deepEqual(sent, [{ op: "follow", n: 0 }], "an operation and an index");
    });
    // pdf_marks_and_outlines_are_not_written: the outline goes with its document (V11), and
    // the panel closes when the tab loads another.
    await openOutline();
    await loadPdf(browser, NO_OUTLINE);
    await TestUtils.waitForCondition(() => !shown(), "another document closes the outline");
    await TestUtils.waitForCondition(() => PdfOps.state(browser)?.pages === 1, "another PDF");
    Assert.equal(PdfOps.outline(browser), null, "the outline went with its document");
  });
});

// V11: pdf.js can open another PDF in the same viewer, with no navigation; an outline read
// from the first goes even when the second has as many pages.
add_task(async function another_pdf_in_the_same_viewer_drops_the_outline() {
  await withPdf(async (browser) => {
    await openOutline();
    Assert.ok(PdfOps.outline(browser), "the outline is read");
    const loaded = BrowserTestUtils.waitForContentEvent(
      browser,
      "textlayerrendered",
      false,
      null,
      true,
    );
    // The same bytes again: a new document with the same page count.
    await SpecialPowers.spawn(browser, [], async () => {
      const app = content.wrappedJSObject.PDFViewerApplication;
      const data = await app.pdfDocument.getData();
      app.open(Cu.cloneInto({ data }, content));
    });
    await loaded;
    await TestUtils.waitForCondition(() => !shown(), "the open outline closes");
    Assert.equal(PdfOps.outline(browser), null, "the outline went with the first document");
  });
});

// V11: an outline read still under way when pdf.js opens another PDF is not taken for it.
add_task(async function a_read_under_way_does_not_outlive_its_document() {
  await withPdf(async (browser) => {
    await recordingOutline(async (seen) => {
      // The first document answers only once the second one is open.
      await SpecialPowers.spawn(browser, [], () => {
        const w = content.wrappedJSObject;
        const doc = w.PDFViewerApplication.pdfDocument;
        // The old document is gone by then: an outline of its own shape stands in for it.
        const old = Cu.cloneInto([{ title: "Old", dest: [0], items: [] }], content);
        doc.getOutline = Cu.exportFunction(
          () =>
            new w.Promise(
              Cu.exportFunction((resolve) => {
                w.vimmaAnswerOutline = Cu.exportFunction(() => resolve(old), content);
              }, content),
            ),
          content,
        );
      });
      EventUtils.synthesizeKey("KEY_Tab");
      await SpecialPowers.spawn(browser, [], () => {});
      const loaded = BrowserTestUtils.waitForContentEvent(
        browser,
        "textlayerrendered",
        false,
        null,
        true,
      );
      await SpecialPowers.spawn(browser, [], async () => {
        const app = content.wrappedJSObject.PDFViewerApplication;
        const data = await app.pdfDocument.getData();
        app.open(Cu.cloneInto({ data }, content));
      });
      await loaded;
      // The new document's state has reached the parent before the old answer.
      await TestUtils.waitForCondition(() => PdfOps.state(browser)?.doc === 1, "the new PDF");
      await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.vimmaAnswerOutline());
      await new Promise((r) => setTimeout(r, 300));
      Assert.equal(seen.length, 0, "the old document's outline is not sent");
      Assert.equal(PdfOps.outline(browser), null, "nor kept");
      Assert.ok(!shown(), "nor shown");
    });
  });
});

add_task(async function a_hostile_outline_gets_only_primitives_through() {
  await withPdf(async (browser) => {
    await recordingOutline(async (seen) => {
      // A thenable that is not a promise is never called back.
      await SpecialPowers.spawn(browser, [], () => {
        const w = content.wrappedJSObject;
        w.PDFViewerApplication.pdfDocument.getOutline = Cu.exportFunction(
          () => Cu.cloneInto({ then: (r) => r([]) }, content, { cloneFunctions: true }),
          content,
        );
      });
      EventUtils.synthesizeKey("KEY_Tab");
      // A round trip on the same window global: a reply to Tab would have come before it.
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.equal(seen.length, 0, "no outline from a thenable");
      Assert.ok(!shown(), "and no panel");
      await SpecialPowers.spawn(browser, [], () => {
        const w = content.wrappedJSObject;
        const fn = (/** @type {Function} */ f) => Cu.exportFunction(f, content);
        const obj = (/** @type {object} */ o) => Cu.cloneInto(o, content, { cloneFunctions: true });
        const item = new w.Object();
        // A title that is an object, a count behind a getter.
        item.title = obj({ toString: () => "evil" });
        Object.defineProperty(item, "count", { get: fn(() => -1), enumerable: true });
        item.dest = obj([0]);
        item.items = new w.Array();
        const long = new w.Object();
        long.title = "x".repeat(100000);
        long.dest = obj([1]);
        long.items = new w.Array();
        const list = new w.Array();
        list.push(item, long);
        w.PDFViewerApplication.pdfDocument.getOutline = fn(() => w.Promise.resolve(list));
      });
      await openOutline();
      Assert.equal(seen.length, 1, "one message");
      const msg = /** @type {any} */ (seen[0]);
      for (const entry of msg.entries) {
        for (const v of Object.values(entry)) {
          Assert.ok(["number", "string", "boolean"].includes(typeof v), "a primitive");
        }
      }
      Assert.equal(msg.entries[0].title, "", "an object title is not taken");
      Assert.equal(msg.entries[0].collapsed, false, "a count behind a getter is not taken");
      Assert.equal(msg.entries[1].title.length, 512, "a huge title is cut in the child");
      Assert.equal(msg.entries[1].page, 2, "a page index");
    });
  });
});

add_task(async function a_late_outline_opens_nothing() {
  await withPdf(async (browser) => {
    await recordingOutline(async (seen) => {
      // The viewer answers late, after the user has pressed another key.
      await SpecialPowers.spawn(browser, [], () => {
        const w = content.wrappedJSObject;
        const doc = w.PDFViewerApplication.pdfDocument;
        const real = doc.getOutline.bind(doc);
        doc.getOutline = Cu.exportFunction(
          () =>
            new w.Promise(
              Cu.exportFunction((resolve) => {
                content.setTimeout(() => real().then(resolve), 500);
              }, content),
            ),
          content,
        );
      });
      EventUtils.synthesizeKey("KEY_Tab");
      type("J");
      await TestUtils.waitForCondition(() => seen.length === 1, "the late reply");
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.ok(!shown(), "a reply after another key opens no panel");
      Assert.equal(mode(), "normal", "the keys stay normal mode's");
    });
  });
});

// Decision 19: with `[ui] pdf_outline = "shown"` (the default), a PDF with an outline opens with
// Vimma's outline beside it, the keys still the document's; Tab gives it the keys, following an
// entry gives them back with the outline still shown, and closing it hides it for that document.
const PAGEMODE = ROOT + "file_vimma_outline_pagemode.pdf";

/** @param {boolean} hidden */
const outlinePref = (hidden) =>
  SpecialPowers.pushPrefEnv({ set: [["vimma.ui.pdf_outline.hidden", hidden]] });

/** @param {any} tab */
async function awayAndBack(tab) {
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = other;
  await TestUtils.waitForCondition(() => !shown(), "another tab hides the outline");
  gBrowser.selectedTab = tab;
  BrowserTestUtils.removeTab(other);
  await focusNormal(tab.linkedBrowser);
}

add_task(async function the_outline_is_shown_when_a_pdf_with_one_opens() {
  await outlinePref(false);
  await recordingOutline(async (seen) => {
    await withPdf(async (browser, tab) => {
      await TestUtils.waitForCondition(shown, "the outline is shown when the PDF opens");
      Assert.equal(seen.length, 1, "read once, as the document loaded");
      Assert.equal(mode(), "normal", "the keys stay the document's");
      Assert.equal(Services.focus.focusedElement, browser, "focus stays on the document");
      Assert.equal(selected(), "Preface", "the entry for page 1 is selected");
      type("2J");
      await untilPage(browser, 3, "J pages the PDF beside the outline");
      await untilSelected("Chapter 1", "the selection follows the page");

      // Tab gives it the keys; following an entry gives them back and leaves it shown.
      await openOutline();
      type("G");
      await untilSelected("Chapter 2", "G");
      EventUtils.synthesizeKey("KEY_Enter");
      await untilPage(browser, 6, "Enter follows");
      await TestUtils.waitForCondition(() => mode() === "normal", "back to the document");
      Assert.ok(shown(), "the outline stays shown");

      // Another tab and back: still shown.
      await awayAndBack(tab);
      await TestUtils.waitForCondition(shown, "coming back shows it again");

      // Closing it (Esc) hides it for this document, also after another tab.
      await openOutline();
      EventUtils.synthesizeKey("KEY_Escape");
      await TestUtils.waitForCondition(() => !shown(), "Esc hides it");
      Assert.equal(mode(), "normal", "in normal mode");
      await awayAndBack(tab);
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.ok(!shown(), "hidden stays hidden for this document");
      Assert.equal(seen.length, 1, "and nothing is read again");

      // Tab opens it with the keys, and Tab closes it, as with [ui] pdf_outline = "hidden".
      await openOutline();
      EventUtils.synthesizeKey("KEY_Tab");
      await TestUtils.waitForCondition(() => !shown(), "Tab closes it");
    }, PAGEMODE);
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function pdf_outline_hidden_keeps_it_closed() {
  await outlinePref(true);
  await recordingOutline(async (seen) => {
    await withPdf(async (browser) => {
      type("J");
      await untilPage(browser, 2, "J");
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.ok(!shown(), "no outline when a PDF opens");
      Assert.equal(seen.length, 0, "and none is read");
      await openOutline();
    });
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_pdf_without_an_outline_opens_none() {
  await outlinePref(false);
  const notice = VimmaHost._state(window).notice;
  const said = [];
  const show = notice.show;
  notice.show = function (text, ...rest) {
    said.push(text);
    return show.call(this, text, ...rest);
  };
  try {
    await withPdf(async (browser) => {
      type("G");
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.ok(!shown(), "no panel");
      Assert.deepEqual(said, [], "and no notice: the user asked for nothing");
      Assert.equal(mode(), "normal", "normal mode");
    }, NO_OUTLINE);
  } finally {
    notice.show = show;
  }
  await SpecialPowers.popPrefEnv();
});

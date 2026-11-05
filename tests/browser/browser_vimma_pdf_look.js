/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md decisions 18 and 20, docs/security.md section 20 (V12): pdf.js's
// own sidebar never shows, and the viewer's toolbar, menus and page gutter take Vimma's
// theme tokens, in the built-in palette dark and light and in an Omarchy theme.
// file_vimma_outline_pagemode.pdf is file_vimma_outline.pdf with `/PageMode /UseOutlines` in its
// catalog, which makes pdf.js open its sidebar on the outline by itself. In Firefox pdf.js finds
// with the browser's find bar (firefox-surfaces-theme themes it), so it has no find bar of its own.

/* global add_setup -- the browser-chrome harness (browser-test.js) */

"use strict";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGEMODE = ROOT + "file_vimma_outline_pagemode.pdf";
const APPEARANCE_PREF = "vimma.theme.appearance";
const themeDir = PathUtils.join(PathUtils.tempDir, `vimma-pdf-look-${Date.now()}`);

/** A base-only Omarchy 4 colors.toml, as browser_vimma_firefox_surfaces_theme.js uses. */
const BASE_ONLY = `accent = "#26bbd9"
cursor = "#fadad1"
foreground = "#fadad1"
background = "#1c1e26"
selection_foreground = "#1c1e26"
selection_background = "#26bbd9"
color0 = "#1c1e26"
color1 = "#e95678"
color2 = "#29d398"
color3 = "#fab795"
color4 = "#26bbd9"
color5 = "#ee64ac"
color6 = "#59e3e3"
color7 = "#fadad1"
color8 = "#6c6f93"
color9 = "#ec6a88"
color10 = "#3fdaa4"
color11 = "#fbc3a7"
color12 = "#3fc4de"
color13 = "#f075b5"
color14 = "#6be4e6"
color15 = "#fadad1"
`;

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.pollMs", 100],
      // The outline panel narrows the page; this file is about pdf.js's own surfaces.
      ["vimma.ui.pdf_outline.hidden", true],
    ],
  });
  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await IOUtils.remove(themeDir, { recursive: true, ignoreAbsent: true });
  });
});

const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** @param {() => boolean | Promise<boolean>} fn @param {string} what */
const until = (fn, what) => TestUtils.waitForCondition(fn, what, 50, 100);

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

/** @param {(browser: XULBrowserElement) => Promise<void>} fn @param {string} [url] */
async function withPdf(fn, url = PAGEMODE) {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, url);
    await fn(browser);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * What the viewer shows: computed colours of its surfaces, and the sidebar's state.
 * @param {XULBrowserElement} browser
 */
function viewer(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    const app = content.wrappedJSObject.PDFViewerApplication;
    const cs = (/** @type {string} */ sel) => {
      const el = doc.querySelector(sel);
      return el ? content.getComputedStyle(el) : null;
    };
    return {
      sidebarOpen: !!app.viewsManager?.isOpen,
      outerOpen: doc.getElementById("outerContainer").classList.contains("viewsManagerOpen"),
      toggleDisplay: cs("#viewsManagerToggleButton")?.display,
      sidebarDisplay: cs("#viewsManager")?.display,
      viewerInset: cs("#viewerContainer")?.insetInlineStart,
      toolbar: cs("#toolbarContainer")?.backgroundColor,
      toolbarText: cs("#numPages")?.color,
      // The pages lie on the body's background (viewer.css): #viewerContainer is transparent.
      gutter: cs("body")?.backgroundColor ?? "",
      menu: cs("#secondaryToolbar")?.backgroundColor,
      field: cs("#pageNumber")?.backgroundColor,
      fieldText: cs("#pageNumber")?.color,
      zoom: cs("#scaleSelect")?.backgroundColor,
      zoomBorder: cs("#scaleSelectContainer")?.borderTopColor,
      scheme: cs(":root")?.colorScheme,
    };
  });
}

add_task(async function pdfjs_sidebar_stays_closed() {
  await withPdf(async (browser) => {
    // pdf.js opens it on its own once the document is set up (setInitialView); give it the time.
    await SpecialPowers.spawn(browser, [], async () => {
      const app = content.wrappedJSObject.PDFViewerApplication;
      await ContentTaskUtils.waitForCondition(() => app.pdfViewer.pagesCount > 0, "pages");
      await new Promise((r) => content.requestAnimationFrame(() => content.setTimeout(r, 300)));
    });
    const v = await viewer(browser);
    Assert.ok(!v.sidebarOpen, "pdf.js's sidebar does not open for a PDF that asks for it");
    Assert.ok(!v.outerOpen, "and the viewer is not laid out for it");
    Assert.equal(v.toggleDisplay, "none", "its toggle button is not shown");
    Assert.equal(v.sidebarDisplay, "none", "nor the sidebar itself");
  });
  // A link with #pagemode=bookmarks opens it in pdf.js: it still does not show, and the pages
  // keep the whole width.
  await withPdf(async (browser) => {
    const v = await viewer(browser);
    Assert.equal(v.sidebarDisplay, "none", "#pagemode=bookmarks shows no sidebar");
    // pdf.js may open it before the viewer has its sheets: the pages then slide back (pdf.js's
    // own transition), so this waits for where they end.
    await until(
      async () => (await viewer(browser)).viewerInset === "0px",
      "and the pages keep their place",
    );
  }, PAGEMODE + "#pagemode=bookmarks");
});

/**
 * The viewer's surfaces against the window's tokens.
 * @param {string} label
 * @param {XULBrowserElement} browser
 */
async function assertViewerFollowsTheTheme(label, browser) {
  const bg = rgb(token("--vimma-bg"));
  const bgDark = rgb(token("--vimma-bg-dark"));
  const fg = rgb(token("--vimma-fg"));
  let v;
  await until(async () => {
    v = await viewer(browser);
    return v.toolbar === bgDark && v.gutter === bg;
  }, `${label}: the viewer takes the theme`).catch(() => {});
  v ??= await viewer(browser);
  Assert.equal(v.toolbar, bgDark, `${label}: the toolbar is --vimma-bg-dark`);
  Assert.equal(v.toolbarText, fg, `${label}: its text is --vimma-fg`);
  Assert.equal(v.gutter, bg, `${label}: the gutter around the pages is --vimma-bg`);
  Assert.equal(v.menu, bgDark, `${label}: the tools menu is --vimma-bg-dark`);
  Assert.equal(v.field, bg, `${label}: a field is --vimma-bg`);
  Assert.equal(v.fieldText, fg, `${label}: with --vimma-fg text`);
  Assert.equal(v.zoom, bgDark, `${label}: the zoom drop-down is on the toolbar's colour`);
  Assert.equal(v.zoomBorder, rgb(token("--vimma-muted")), `${label}: framed in --vimma-muted`);
  Assert.equal(v.scheme, token("--vimma-color-scheme"), `${label}: in the theme's colour scheme`);
}

add_task(async function the_viewer_follows_the_theme() {
  await withPdf(async (browser) => {
    for (const appearance of ["dark", "light"]) {
      Services.prefs.setStringPref(APPEARANCE_PREF, appearance);
      await until(() => token("--vimma-color-scheme") === appearance, `palette ${appearance}`);
      await assertViewerFollowsTheTheme(`vimma ${appearance}`, browser);
    }
    Services.prefs.clearUserPref(APPEARANCE_PREF);

    await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), BASE_ONLY);
    await SpecialPowers.pushPrefEnv({
      set: [
        ["vimma.theme.source", "omarchy"],
        ["vimma.theme.omarchyPath", themeDir],
      ],
    });
    await until(() => token("--vimma-bg") === "#1c1e26", "the base-only Omarchy theme applies");
    await assertViewerFollowsTheTheme("Omarchy, base colours only", browser);
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function high_contrast_keeps_pdfjs_colours() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  await withPdf(async (browser) => {
    const v = await viewer(browser);
    Assert.notEqual(v.toolbar, rgb(token("--vimma-bg-dark")), "pdf.js keeps its high contrast");
    Assert.equal(v.toggleDisplay, "none", "and the sidebar's toggle stays hidden");
  });
  await SpecialPowers.popPrefEnv();
});

// V12: the parent gives the token sheet only to the top viewer's current actor.
add_task(async function the_theme_reaches_only_the_viewer() {
  const ask = (/** @type {XULBrowserElement} */ browser) =>
    SpecialPowers.spawn(browser, [], () =>
      content.windowGlobalChild.getActor("Vimma").sendQuery("Vimma:PdfTheme"),
    );
  await withPdf(async (browser) => {
    const css = await ask(browser);
    Assert.equal(typeof css, "string", "the viewer gets the token sheet");
    Assert.ok(css.includes("--vimma-bg"), "with the tokens");
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + "file_vimma_plain.html");
  Assert.equal(await ask(tab.linkedBrowser), null, "a web page gets nothing");
  BrowserTestUtils.removeTab(tab);
});

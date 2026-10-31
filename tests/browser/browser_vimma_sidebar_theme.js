/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-sidebar-theme.md

"use strict";

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const POLL_MS = 100;
/** The built-in vimma palette's dark_background, dark and light (browser_vimma_theme.js). */
const VIMMA_DARK_BG = "#050c0d";
const VIMMA_LIGHT_BG = "#e7ecea";

/**
 * A colors.toml in Omarchy 4's format (the theme test's fixture, trimmed to what the tokens
 * read). Each theme varies its surfaces, text and accent, so a stale colour is told apart.
 * @param {{ bg: string, darkBg: string, fg: string, accent: string, muted: string,
 *   selection?: string, mode?: string | null }} p  mode null: no mode key, light.mode decides
 */
function colorsToml({ bg, darkBg, fg, accent, muted, selection = "#292e42", mode = "dark" }) {
  return `${mode === null ? "" : `mode = "${mode}"\n`}
accent = "${accent}"
selection = "${selection}"
muted = "${muted}"

background = "${bg}"
dark_background = "${darkBg}"
darker_background = "#0e0e14"
lighter_background = "#24283b"

foreground = "${fg}"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"

red = "#f7768e"
yellow = "#e0af68"
orange = "#ff9e64"
green = "#9ece6a"
cyan = "#7dcfff"
blue = "#7aa2f7"
magenta = "#bb9af7"
brown = "#db4b4b"

bright_red = "#ff7a93"
bright_yellow = "#ff9e64"
bright_green = "#b9f27c"
bright_cyan = "#7dcfff"
bright_blue = "#7da6ff"
bright_magenta = "#bb9af7"
`;
}

const DARK_ONE = {
  bg: "#1a1b26",
  darkBg: "#16161e",
  fg: "#a9b1d6",
  accent: "#7aa2f7",
  muted: "#414868",
};
const DARK_TWO = {
  bg: "#2a1a2a",
  darkBg: "#301030",
  fg: "#e0c0e0",
  accent: "#ff79c6",
  muted: "#6a4a6a",
};
/** Catppuccin Latte: light surfaces, dark text, no mode key. */
const LIGHT = {
  bg: "#eff1f5",
  darkBg: "#e6e9ef",
  fg: "#4c4f69",
  accent: "#1e66f5",
  muted: "#9ca0b0",
  selection: "#ccd0da",
  mode: null,
};

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * A colour custom property as `el` sees it (inherited through shadow roots), resolved to the
 * rgb() form getComputedStyle reports.
 * @param {Element} el
 * @param {string} name  e.g. "--focus-outline-color"
 */
function colourVar(el, name) {
  const win = /** @type {Window} */ (el.ownerDocument.defaultView);
  const value = win.getComputedStyle(el).getPropertyValue(name).trim();
  const probe = el.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  probe.style.color = value;
  el.ownerDocument.documentElement.append(probe);
  const out = win.getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/** The colour that shows behind `el`: its own background or the first opaque ancestor's. */
function backdrop(/** @type {Element} */ el) {
  /** @type {Element | null} */
  let node = el;
  while (node) {
    const bg = node.ownerDocument.defaultView.getComputedStyle(node).backgroundColor;
    if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    node = node.parentElement ?? node.ownerDocument.defaultView.frameElement;
  }
  return "none";
}

async function ln(target, link) {
  const command = await Subprocess.pathSearch("ln");
  const proc = await Subprocess.call({ command, arguments: ["-sfn", target, link] });
  const { exitCode } = await proc.wait();
  Assert.equal(exitCode, 0, `ln -sfn ${target} ${link}`);
}

/** A bookmark the bookmarks cases rename in place (setup). */
let RENAME_GUID = "";

const root = PathUtils.join(PathUtils.tempDir, `vimma-sidebar-theme-${Date.now()}`);
const dir = (/** @type {string} */ name) => PathUtils.join(root, "themes", name);
const currentTheme = PathUtils.join(root, "current", "theme");

/** Waits until the window's tokens are the theme whose dark_background is `hex`. */
function waitForTheme(/** @type {string} */ hex, /** @type {string} */ msg) {
  return TestUtils.waitForCondition(() => token("--vimma-bg-dark") === hex, msg, 50, 100);
}

/** The first element under `root` (shadow roots included) matching `selector`. */
function deepQuery(/** @type {Document | ShadowRoot} */ root, /** @type {string} */ selector) {
  /** @type {Element | null} */
  const found = root.querySelector(selector);
  if (found) return found;
  for (const el of root.querySelectorAll("*")) {
    const inner = el.shadowRoot && deepQuery(el.shadowRoot, selector);
    if (inner) return inner;
  }
  return null;
}

/**
 * The colour a focused element's ring is painted in: `outline: auto` (the UA's ring on a
 * focused <input>) is drawn by the non-native theme in the element's accent-color, any other
 * style in outline-color.
 * @param {Element} el
 */
function ringColour(el) {
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  if (style.outlineStyle === "none") return "no ring";
  return style.outlineStyle === "auto" ? style.accentColor : style.outlineColor;
}

/**
 * The launcher's button for the open panel, or undefined. Since Firefox 158 the launcher is a
 * tab list: the open panel's button is aria-selected (sidebar-main.mjs), not aria-pressed.
 */
function pressedLauncherButton() {
  return [...document.querySelector("sidebar-main").shadowRoot.querySelectorAll("moz-button")].find(
    (b) => b.shadowRoot?.querySelector('button[aria-selected="true"]'),
  );
}

/**
 * Shows the launcher strip, whose theme the test checks. Up to Firefox 159 opening a panel showed
 * it. Since Firefox 160 the default horizontal-tabs mode ("hide-on-close") leaves the launcher to
 * the user (SidebarState's userLauncherVisible, which the toolbar button sets), and a panel
 * opens without it.
 */
function showLauncher() {
  const state = SidebarController._state;
  if ("userLauncherVisible" in state) state.userLauncherVisible = true;
}

/** Opens a Firefox sidebar panel and waits for its document to finish loading. */
async function showSidebar(/** @type {string} */ command) {
  showLauncher();
  await SidebarController.show(command);
  const browser = SidebarController.browser;
  const url = SidebarController.sidebars.get(command).url;
  await TestUtils.waitForCondition(
    () =>
      browser.contentDocument?.location.href === url &&
      browser.contentDocument.readyState === "complete" &&
      pressedLauncherButton()?.getAttribute("view") === command,
    `${command} loads`,
  );
  return browser.contentDocument;
}

/**
 * Firefox's own sidebar, open on `command`, paints the current Vimma theme: the launcher strip,
 * the panel box and its browser, the panel document's text, colour scheme and focus ring.
 * @param {string} label  which theme, for the messages
 * @param {Document} doc  the open sidebar document
 */
function assertSidebarFollowsTheTheme(label, doc) {
  const surface = rgb(token("--vimma-bg-dark"));
  const text = rgb(token("--vimma-fg"));
  const focus = rgb(token("--vimma-focus"));
  const border = rgb(token("--vimma-muted"));
  const scheme = token("--vimma-color-scheme");
  Assert.ok(
    /^#[0-9a-f]{6}$/.test(token("--vimma-focus")),
    `${label}: the theme has a focus colour`,
  );
  const $ = (/** @type {string} */ id) => /** @type {Element} */ (document.getElementById(id));
  const style = (/** @type {Element} */ el) => el.ownerDocument.defaultView.getComputedStyle(el);

  const launcher = $("sidebar-container");
  Assert.ok(BrowserTestUtils.isVisible(launcher), `${label}: the launcher strip shows`);
  Assert.equal(
    style(launcher).backgroundColor,
    surface,
    `${label}: the launcher is on --vimma-bg-dark`,
  );
  Assert.equal(style(launcher).color, text, `${label}: the launcher's text is --vimma-fg`);
  Assert.equal(style(launcher).colorScheme, scheme, `${label}: the launcher's colour scheme`);

  const button = /** @type {Element} */ (
    document.querySelector("sidebar-main").shadowRoot.querySelector("moz-button[view]")
  );
  Assert.equal(style(button).color, text, `${label}: a launcher button's text is --vimma-fg`);
  Assert.equal(
    colourVar(button, "--button-icon-fill"),
    text,
    `${label}: a launcher button's icon is --vimma-fg`,
  );

  const box = $("sidebar-box");
  Assert.equal(backdrop(box), surface, `${label}: the panel box is on --vimma-bg-dark`);
  Assert.equal(
    style(box).borderInlineEndColor,
    border,
    `${label}: the panel's edge is --vimma-muted`,
  );
  Assert.equal(style(box).colorScheme, scheme, `${label}: the panel box's colour scheme`);

  const browser = SidebarController.browser;
  Assert.equal(backdrop(browser), surface, `${label}: the panel browser is on --vimma-bg-dark`);
  Assert.equal(style(browser).color, text, `${label}: the panel browser's text is --vimma-fg`);
  Assert.equal(
    colourVar(launcher, "--focus-outline-color"),
    focus,
    `${label}: the window's focus ring (launcher, splitter) is --vimma-focus`,
  );

  // The open panel's launcher button (aria-selected, which moz-button moves to its inner
  // <button>): Firefox paints it in the system accent (AccentColor at 30%, a dark blue); Vimma's
  // selected row is --vimma-selection.
  const pressed = pressedLauncherButton();
  Assert.ok(pressed, `${label}: the open panel's launcher button is pressed`);
  const pressedFace = /** @type {Element} */ (
    pressed.shadowRoot.querySelector(".button-background")
  );
  Assert.equal(
    style(pressedFace).backgroundColor,
    rgb(token("--vimma-selection")),
    `${label}: the pressed launcher button is on --vimma-selection, not the system accent`,
  );
  Assert.equal(
    style(pressedFace).color,
    rgb(token("--vimma-fg-bright")),
    `${label}: the pressed launcher button's icon is --vimma-fg-bright`,
  );
  // Nova rings a non-ghost button in --color-accent-primary, resolved on the window's root.
  Assert.equal(
    style(pressedFace).borderTopColor,
    "rgba(0, 0, 0, 0)",
    `${label}: the pressed launcher button has no system-accent border`,
  );

  const page = doc.documentElement;
  // The places sidebars (bookmarks) are XUL documents: no <body>, the root is the surface.
  const body = doc.body ?? page;
  Assert.equal(style(body).color, text, `${label}: ${doc.location.href} body text is --vimma-fg`);
  Assert.equal(
    backdrop(body),
    surface,
    `${label}: ${doc.location.href} body is on --vimma-bg-dark`,
  );
  Assert.equal(style(page).colorScheme, scheme, `${label}: ${doc.location.href} colour scheme`);
  Assert.equal(
    colourVar(page, "--sidebar-background-color"),
    surface,
    `${label}: ${doc.location.href} --sidebar-background-color is --vimma-bg-dark`,
  );
  Assert.equal(
    colourVar(page, "--focus-outline-color"),
    focus,
    `${label}: ${doc.location.href} focus ring is --vimma-focus, not the system blue`,
  );

  // The search box, focused: Firefox draws it on Field (grey #2b2a33 or white) with a ring in
  // the system accent (#0060df).
  const search = /** @type {HTMLElement} */ (deepQuery(doc, "moz-input-search"));
  Assert.ok(search, `${label}: ${doc.location.href} has a search box`);
  search.focus();
  const field = /** @type {HTMLInputElement} */ (search.shadowRoot.querySelector("input"));
  Assert.ok(field.matches(":focus"), `${label}: the search field has focus`);
  Assert.equal(
    ringColour(field),
    focus,
    `${label}: ${doc.location.href} the focused search field's ring is --vimma-focus`,
  );
  Assert.equal(
    style(field).backgroundColor,
    rgb(token("--vimma-bg")),
    `${label}: ${doc.location.href} the search field is on --vimma-bg`,
  );
  Assert.equal(style(field).color, text, `${label}: the search field's text is --vimma-fg`);
  Assert.equal(
    style(field).borderTopColor,
    border,
    `${label}: ${doc.location.href} the search field's border is --vimma-muted`,
  );

  // The list's scrollbar: without a colour, the toolkit draws a white track on any theme. A XUL
  // tree (bookmarks) draws its own <scrollbar> element from its shadow root, which the UA sheet
  // resets to initial values (scrollbars.css): that element's colour is the one painted.
  const tree = doc.getElementById("bookmarks-view");
  const scroller = /** @type {Element} */ (
    tree
      ? tree.shadowRoot.querySelector("scrollbar")
      : deepQuery(doc, ".sidebar-panel-scrollable-content")
  );
  Assert.ok(scroller, `${label}: ${doc.location.href} has a scrolling list`);
  Assert.equal(
    style(scroller).scrollbarColor,
    `${border} ${surface}`,
    `${label}: ${doc.location.href} the list's scrollbar is --vimma-muted on --vimma-bg-dark`,
  );
  if (tree) assertRenameFieldFollowsTheTheme(label, /** @type {any} */ (tree));
}

/**
 * Renames a bookmark in place in the bookmarks tree and checks what its field paints: an
 * <input class="tree-input"> in the tree's shadow root, which no document sheet reaches and
 * which the UA fills with Field (grey #2b2a33 or white), its selected text in Highlight.
 * @param {string} label  which theme, for the messages
 * @param {any} tree  the bookmarks sidebar's places tree
 */
function assertRenameFieldFollowsTheTheme(label, tree) {
  const style = (/** @type {Element} */ el, /** @type {string} */ pseudo = "") =>
    el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  const t = (/** @type {string} */ name) => rgb(token(name));
  // Firefox's bookmarks sidebar tree is not editable by default (editBookmark.js's folder tree
  // is): opt in for the test, the field and its styles are the same.
  tree.setAttribute("editable", "true");
  tree.selectItems([RENAME_GUID], true);
  const row = tree.view.treeIndexForNode(tree.selectedNode);
  Assert.greater(row, -1, `${label}: the bookmark to rename shows`);
  Assert.ok(tree.startEditing(row, tree.columns.getFirstColumn()), `${label}: rename in place`);
  const field = /** @type {HTMLInputElement} */ (tree.shadowRoot.querySelector(".tree-input"));
  Assert.ok(!field.hidden && field.matches(":focus"), `${label}: the rename field has focus`);
  Assert.equal(style(field).backgroundColor, t("--vimma-bg"), `${label}: rename field surface`);
  Assert.equal(style(field).color, t("--vimma-fg"), `${label}: rename field text`);
  Assert.equal(ringColour(field), t("--vimma-focus"), `${label}: rename field ring`);
  Assert.equal(
    style(field, "::selection").backgroundColor,
    t("--vimma-selection"),
    `${label}: the rename field's selected text is on --vimma-selection, not Highlight`,
  );
  Assert.equal(
    style(field, "::selection").color,
    t("--vimma-fg-bright"),
    `${label}: the rename field's selected text is --vimma-fg-bright`,
  );
  tree.stopEditing(false);
  tree.removeAttribute("editable");
}

add_task(async function setup() {
  for (const [name, colours] of [
    ["one", DARK_ONE],
    ["two", DARK_TWO],
    ["light", LIGHT],
  ]) {
    await IOUtils.makeDirectory(dir(name), { createAncestors: true });
    await IOUtils.writeUTF8(PathUtils.join(dir(name), "colors.toml"), colorsToml(colours));
  }
  await IOUtils.writeUTF8(PathUtils.join(dir("light"), "light.mode"), "");
  await IOUtils.makeDirectory(PathUtils.join(root, "current"), { createAncestors: true });
  await ln(dir("one"), currentTheme);
  RENAME_GUID = (
    await PlacesUtils.bookmarks.insert({
      parentGuid: PlacesUtils.bookmarks.unfiledGuid,
      url: "https://example.com/rename-me",
      title: "Rename me",
    })
  ).guid;

  // browser.toml pins vimma.theme.source=builtin for every other test; this one opts in.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.pollMs", POLL_MS],
      ["vimma.theme.omarchyPath", currentTheme],
      ["vimma.theme.source", "omarchy"],
      ["ui.systemUsesDarkTheme", 1],
    ],
  });
  registerCleanupFunction(async () => {
    SidebarController.hide();
    if ("userLauncherVisible" in SidebarController._state) {
      SidebarController._state.userLauncherVisible = false;
    }
    await SpecialPowers.popPrefEnv();
    await PlacesUtils.bookmarks.remove(RENAME_GUID);
    await IOUtils.remove(root, { recursive: true });
  });
  await waitForTheme(DARK_ONE.darkBg, "theme one is current");
});

add_task(async function the_history_sidebar_follows_a_dark_theme() {
  const doc = await showSidebar("viewHistorySidebar");
  assertSidebarFollowsTheTheme("dark", doc);
});

add_task(async function an_open_sidebar_follows_a_theme_switch() {
  const doc = SidebarController.browser.contentDocument;
  await ln(dir("two"), currentTheme);
  await waitForTheme(DARK_TWO.darkBg, "omarchy-theme-set's swap: theme two");
  Assert.equal(SidebarController.browser.contentDocument, doc, "the same sidebar document");
  assertSidebarFollowsTheTheme("switched", doc);
});

add_task(async function the_bookmarks_sidebar_follows_the_switched_theme() {
  const doc = await showSidebar("viewBookmarksSidebar");
  assertSidebarFollowsTheTheme("bookmarks", doc);
});

add_task(async function the_sidebar_follows_a_light_theme() {
  await ln(dir("light"), currentTheme);
  await waitForTheme(LIGHT.darkBg, "the light theme");
  Assert.equal(token("--vimma-color-scheme"), "light", "light.mode makes the tokens light");
  const doc = await showSidebar("viewHistorySidebar");
  assertSidebarFollowsTheTheme("light", doc);
});

add_task(async function the_bookmarks_sidebar_follows_a_light_theme() {
  const doc = await showSidebar("viewBookmarksSidebar");
  assertSidebarFollowsTheTheme("light bookmarks", doc);
});

// The built-in vimma palette carries its light variant under prefers-color-scheme: an open
// sidebar document must switch with the desktop, as the window does.
add_task(async function the_builtin_palette_follows_the_desktop_scheme_live() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.source", "builtin"]] });
  await waitForTheme(VIMMA_DARK_BG, "the built-in vimma palette, dark");
  const doc = await showSidebar("viewHistorySidebar");
  assertSidebarFollowsTheTheme("vimma dark", doc);

  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 0]] });
  await waitForTheme(VIMMA_LIGHT_BG, "a light desktop: vimma light, without a reload");
  await TestUtils.waitForCondition(
    () => doc.defaultView.getComputedStyle(doc.body).color === rgb(token("--vimma-fg")),
    "the open sidebar document turns light too",
  );
  assertSidebarFollowsTheTheme("vimma light", doc);

  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

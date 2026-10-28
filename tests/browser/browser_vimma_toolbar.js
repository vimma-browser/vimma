/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/toolbar-toggle.md. ctrl+b u hides Firefox's navigation toolbar in every
// window; focusing the address bar shows a minimal bar (the URL field only) over the page, which
// keeps its size; Enter and Esc hide it again; a permission prompt and the identity panel show
// the URL field with the site's identity, an add-on popup the full toolbar; permission prompts
// answer y and n; the bar, the field, its suggestions and the prompts follow the theme; the
// status bar says `not secure` and `private`; `[ui] toolbar` sets it from config.toml; the
// account panel has no mobile-app row.

"use strict";

/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
requestLongerTimeout(4);

/* global focusContent -- from head.js */
/* global PopupNotifications, SitePermissions, gCustomizeMode, gNavToolbox, CustomizableUI, PanelMultiView,
   PanelUI -- browser window globals (browser.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { DEFAULT_HINT_CHARS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/hints.mjs",
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs",
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs",
);
UrlbarTestUtils.init(this);

const PREF = "vimma.ui.toolbar.hidden";
const HIDDEN = "vimma-toolbar-hidden";
const REVEALED = "vimma-toolbar-revealed";
const MINIMAL = "vimma-toolbar-minimal";
const PROMPT = "vimma-toolbar-prompt";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = DIR + "file_vimma_plain.html";
/** A bookmarked page that is not the one open (Firefox leaves the current page out). */
const OTHER = PLAIN + "?other";
const HTTP_PLAIN = PLAIN.replace("https://", "http://");
const VISIBLE = { visibilityProperty: true };

const dir = PathUtils.join(PathUtils.tempDir, `vimma-toolbar-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** ctrl+b, then `key`, in `win`. */
function prefix(key, win = window, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

const $ = (id, win = window) => win.document.getElementById(id);
const shows = (el) => !!el?.checkVisibility(VISIBLE);
const root = (win = window) => win.document.documentElement;
const barCollapsed = (win = window) => !shows($("nav-bar", win));
const minimal = (win = window) => root(win).hasAttribute(MINIMAL);
/** The URL field with the site's identity and the prompts' icons, still no buttons. */
const promptSize = (win = window) => minimal(win) && root(win).hasAttribute(PROMPT);
const revealedFull = (win = window) =>
  root(win).hasAttribute(REVEALED) && !root(win).hasAttribute(MINIMAL);
const noticeText = (win = window) => $("vimma-notice-live", win)?.textContent ?? "";
const toolbarOf = (win = window) => VimmaHost._state(win).toolbar;
const segText = (id, win = window) =>
  $("vimma-statusbar", win)?.querySelector(`[data-segment="${id}"]`)?.textContent ?? null;

/** Hidden in every window, from the pref. */
async function hide() {
  Services.prefs.setBoolPref(PREF, true);
  await until(() => barCollapsed(), "the toolbar is hidden");
}

async function show() {
  Services.prefs.setBoolPref(PREF, false);
  await until(() => !barCollapsed(), "the toolbar is shown");
}

/** An example.com page, selected, focused, in normal mode. */
async function openPage(url = PLAIN) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

/** Leaves the URL bar: Esc until the page has focus, as a user would. */
async function escapeUrlbar() {
  for (let i = 0; i < 4 && gURLBar.focused; i++) {
    EventUtils.synthesizeKey("KEY_Escape");
    await new Promise((r) => requestAnimationFrame(r));
  }
  await until(() => !gURLBar.focused, "Esc leaves the URL bar");
}

/** Everything in the bar but the URL field itself: buttons, and the chrome around the field. */
const NOT_IN_MINIMAL = [
  "back-button",
  "stop-reload-button",
  "unified-extensions-button",
  "PanelUI-button",
  "PersonalToolbar",
  "identity-box",
  "trust-icon-container",
  "page-action-buttons",
];

/** The minimal bar is up: only the URL field, no button and no identity chrome around it. */
function assertMinimal(what) {
  Assert.ok(gURLBar.focused, `${what}: the URL bar has focus`);
  Assert.ok(shows(gURLBar.inputField), `${what}: the URL field is visible`);
  Assert.ok(minimal() && !promptSize(), `${what}: the bar is minimal`);
  Assert.ok(shows($("urlbar-container")), `${what}: the URL field shows`);
  for (const id of NOT_IN_MINIMAL) {
    Assert.ok(!shows($(id)), `${what}: #${id} does not show`);
  }
  for (const sel of [".searchmode-switcher", ".urlbar-go-button"]) {
    Assert.ok(!shows(gURLBar.querySelector(sel)), `${what}: ${sel} does not show`);
  }
  for (const el of $("nav-bar").querySelectorAll(".titlebar-buttonbox-container")) {
    Assert.ok(!shows(el), `${what}: the window controls do not show`);
  }
}

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.toolbars.bookmarks.visibility", "always"],
      ["browser.urlbar.suggest.searches", false],
      // The status bar's `not secure` needs a page that stays on http:.
      ["dom.security.https_first", false],
      ["dom.security.https_first_schemeless", false],
      ["browser.urlbar.suggest.history", true],
      ["browser.urlbar.suggest.bookmark", true],
      ["browser.urlbar.suggest.quicksuggest.sponsored", false],
      ["browser.urlbar.suggest.quicksuggest.nonsponsored", false],
    ],
  });
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(PREF);
    const view = PaneViews.get(window);
    while (view?.panes) view.close();
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await PlacesUtils.history.clear();
    await PlacesUtils.bookmarks.eraseEverything();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  });
  Assert.equal(
    Services.prefs.getDefaultBranch("").getBoolPref(PREF, true),
    false,
    `${PREF} defaults to false: the toolbar is shown`,
  );
  Assert.ok(!barCollapsed(), "the toolbar shows by default");
});

// 1, 13: every window; the notice, spoken; the notification bars stay; no accessible.
add_task(async function ctrl_b_u_hides_the_toolbar_in_every_window() {
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(window);
  const tab = await openPage();

  prefix("u");
  await until(() => barCollapsed() && barCollapsed(win2), "hidden in both windows");
  Assert.ok(Services.prefs.getBoolPref(PREF), "the pref says hidden");
  for (const w of [window, win2]) {
    Assert.ok(root(w).hasAttribute(HIDDEN), "the root says hidden");
    Assert.ok(!shows($("PersonalToolbar", w)), "the bookmarks toolbar hides too");
    Assert.ok(!shows(w.gURLBar), "the URL bar is not visible");
  }
  await until(() => noticeText() === "toolbar hidden", "the polite region says toolbar hidden");
  Assert.ok(
    $("notifications-toolbar").checkVisibility(VISIBLE),
    "#notifications-toolbar is not hidden",
  );
  const acc = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);
  Assert.equal(
    acc.getAccessibleFor(gURLBar.inputField),
    null,
    "the hidden URL bar has no accessible",
  );

  await focusContent(tab.linkedBrowser);
  prefix("u");
  await until(() => !barCollapsed() && !barCollapsed(win2), "shown again in both windows");
  await until(() => noticeText() === "toolbar shown", "the notice says toolbar shown");
  Assert.ok(shows($("PersonalToolbar")), "the bookmarks toolbar is back");

  await BrowserTestUtils.closeWindow(win2);
  gBrowser.removeTab(tab);
});

// 2: every way to the URL bar shows the minimal bar, over the page, without moving the field.
add_task(async function focusing_the_url_bar_shows_the_minimal_bar() {
  const tab = await openPage();
  const container = $("urlbar-container").getBoundingClientRect();
  await hide();
  const browser = tab.linkedBrowser;
  const height = browser.getBoundingClientRect().height;
  // Hiding the bar gives the page its rows once; then nothing else may resize it.
  await TestUtils.waitForCondition(
    async () =>
      (await SpecialPowers.spawn(browser, [], () => content.innerHeight)) === Math.round(height),
    "the page has the toolbar's rows",
  );
  const inner = await SpecialPowers.spawn(browser, [], async () => {
    // The resize event of that change comes at a later refresh: let it pass first.
    for (let i = 0; i < 3; i++) await new Promise((r) => content.requestAnimationFrame(r));
    content.wrappedJSObject.vimmaResized = 0;
    content.addEventListener("resize", () => content.wrappedJSObject.vimmaResized++);
    return content.innerHeight;
  });

  /** @type {Array<[string, () => void]>} */
  const ways = [
    ["I", () => EventUtils.synthesizeKey("I", { shiftKey: true })],
    ["ctrl+l", () => EventUtils.synthesizeKey("l", { ctrlKey: true })],
    ["F6", () => EventUtils.synthesizeKey("KEY_F6")],
  ];
  for (const [what, press] of ways) {
    await focusContent(browser);
    Assert.ok(barCollapsed(), `${what}: hidden before`);
    press();
    await until(() => gURLBar.focused, `${what} focuses the URL bar`);
    assertMinimal(what);
    const now = $("urlbar-container").getBoundingClientRect();
    for (const k of ["x", "y", "width", "height"]) {
      Assert.equal(now[k], container[k], `${what}: the URL field's ${k} is as with the toolbar`);
    }
    Assert.equal(
      browser.getBoundingClientRect().height,
      height,
      `${what}: the page keeps its height`,
    );
    await escapeUrlbar();
    await until(() => barCollapsed(), `${what}: leaving the URL bar hides it`);
  }
  const after = await SpecialPowers.spawn(browser, [], () => [
    content.innerHeight,
    content.wrappedJSObject.vimmaResized,
  ]);
  Assert.deepEqual(after, [inner, 0], "the page saw no resize");

  for (const [what, keys] of [
    ["t", () => EventUtils.synthesizeKey("t")],
    ["ctrl+b c", () => prefix("c")],
  ]) {
    await focusContent(browser);
    const opened = BrowserTestUtils.waitForNewTab(gBrowser);
    keys();
    const fresh = await opened;
    await until(() => gURLBar.focused, `${what}: the new tab's URL bar has focus`);
    assertMinimal(what);
    gBrowser.removeTab(fresh);
    await until(() => !gURLBar.focused || gBrowser.selectedTab === tab, "back to the page");
  }

  await focusContent(browser);
  prefix("v");
  await until(() => !!PaneViews.get(window)?.panes && gURLBar.focused, "ctrl+b v: a pane");
  assertMinimal("ctrl+b v");
  PaneViews.get(window).close();
  await until(() => !PaneViews.get(window)?.panes, "the split is closed");

  // Typing, and Firefox's suggestions below the field, where they open with the toolbar shown.
  await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.unfiledGuid,
    url: OTHER,
    title: "Vimma plain page",
  });
  await PlacesTestUtils.addVisits({ uri: OTHER, title: "Vimma plain page" });
  // Earlier test files leave their pages in history; one visited more often lists above the
  // bookmark, so the row to pick is found by its URL, not by its place in the list.
  const EARLIER = PLAIN + "?earlier";
  for (let i = 0; i < 3; i++) {
    await PlacesTestUtils.addVisits({ uri: EARLIER, title: "Vimma plain page" });
  }
  await Cc["@mozilla.org/places/frecency-recalculator;1"]
    .getService(Ci.nsIObserver)
    .wrappedJSObject.recalculateAnyOutdatedFrecencies();
  const typeAndMeasure = async () => {
    await focusContent(browser);
    EventUtils.synthesizeKey("I", { shiftKey: true });
    await until(() => gURLBar.focused, "I again");
    EventUtils.sendString("vimma plain");
    await until(() => gURLBar.value === "vimma plain", "the typed text is in the field");
    await until(
      () => gURLBar.view.isOpen && gURLBar.querySelectorAll(".urlbarView-row").length > 1,
      "the bookmark is a suggestion",
    );
    const view = gURLBar.querySelector(".urlbarView");
    Assert.ok(view.matches(":popover-open"), "the view is an open popover");
    return view.getBoundingClientRect().top;
  };
  await show();
  const shownTop = await typeAndMeasure();
  await escapeUrlbar();
  await hide();
  const hiddenTop = await typeAndMeasure();
  Assert.equal(hiddenTop, shownTop, "the suggestions open where they do with the toolbar shown");
  Assert.greater(hiddenTop, gURLBar.inputField.getBoundingClientRect().top, "below the field");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, OTHER);
  await UrlbarTestUtils.promiseSearchComplete(window);
  for (let i = 0; i < 10 && gURLBar.view.selectedResult?.payload.url !== OTHER; i++) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
  }
  Assert.equal(gURLBar.view.selectedResult?.payload.url, OTHER, "the bookmark's row is selected");
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  await until(() => barCollapsed(), "Enter on a row loads it and hides the bar");

  await show();
  gBrowser.removeTab(tab);
});

// 3, 4: Enter loads and hides; Esc reverts first, then leaves.
add_task(async function enter_and_esc_hide_the_minimal_bar() {
  const tab = await openPage();
  await hide();
  const browser = tab.linkedBrowser;

  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused, "I");
  EventUtils.sendString(HTTP_PLAIN.replace("http://", "https://") + "?typed");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, (u) => u.endsWith("?typed"));
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  await until(() => !gURLBar.focused && barCollapsed(), "Enter loads, and the bar hides");
  await until(() => document.activeElement === browser, "focus is in the page");

  await focusContent(browser);
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused, "I");
  EventUtils.sendString("something else");
  for (let i = 0; i < 3 && gURLBar.value === "something else"; i++) {
    EventUtils.synthesizeKey("KEY_Escape");
    await new Promise((r) => requestAnimationFrame(r));
  }
  Assert.notEqual(gURLBar.value, "something else", "Esc reverts the typed text");
  Assert.ok(gURLBar.focused && minimal(), "and the minimal bar stays, focused");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === browser, "the next Esc focuses the page");
  await until(() => barCollapsed(), "and the bar hides");

  await show();
  gBrowser.removeTab(tab);
});

// 5: a permission prompt shows the URL field with the site's identity and hangs from its own
// icon.
add_task(async function a_permission_prompt_hangs_from_its_icon() {
  const tab = await openPage();
  await hide();
  let removed = false;
  const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.geolocation.getCurrentPosition(
      () => {},
      () => {},
    );
  });
  await shown;
  const notification = PopupNotifications.getNotification("geolocation");
  Assert.ok(notification, "the geolocation prompt is up");
  const origRemove = notification.remove.bind(notification);
  notification.remove = () => {
    removed = true;
    origRemove();
  };
  Assert.ok(promptSize(), "the bar shows the URL field with the site's identity, not in full");
  for (const id of ["back-button", "unified-extensions-button", "PanelUI-button"]) {
    Assert.ok(!shows($(id)), `no #${id}`);
  }
  const anchor = PopupNotifications.panel.anchorNode;
  Assert.equal(anchor?.id, "geo-notification-icon", "the prompt anchors to its own icon");
  Assert.ok(shows(anchor), "which is visible");
  // The site's identity: Firefox's lock (the trust icon) or its identity icon, whichever this
  // page shows.
  Assert.ok(
    [$("identity-icon"), $("trust-icon-container")].some(shows),
    "next to the site's identity",
  );
  await new Promise((r) => setTimeout(r, 700));
  Assert.equal(PopupNotifications.panel.state, "open", "the bar stays while the prompt is open");
  Assert.ok(!notification.dismissed && !removed, "the reveal dismissed nothing");

  const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
  PopupNotifications.panel.firstElementChild.secondaryButton.click();
  await hidden;
  await until(() => barCollapsed(), "after Block the bar hides");
  gBrowser.removeTab(tab);
  await show();
});

// 5a: a permission prompt from the keyboard (decision 11a): y and n once it is armed, a key
// typed on through it starts the delay again, a field's keys never answer it, Tab moves focus
// onto its buttons, where Enter is the focused button's.
add_task(async function permission_prompts_answer_y_and_n() {
  const DELAY = 400;
  await SpecialPowers.pushPrefEnv({ set: [["security.notification_enable_delay", DELAY]] });
  const tab = await openPage();
  await hide();
  const browser = tab.linkedBrowser;
  const panel = PopupNotifications.panel;
  const principal = () => browser.contentPrincipal;
  const geo = () => SitePermissions.getForPrincipal(principal(), "geo", browser).state;
  const forget = () => SitePermissions.removeFromPrincipal(principal(), "geo", browser);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Asks for the location; resolves with the prompt once it shows. */
  const ask = async () => {
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    await SpecialPowers.spawn(browser, [], () => {
      content.navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
      );
    });
    await shown;
    return /** @type {any} */ (panel.firstElementChild);
  };
  const hintOf = (n) => n.querySelector(".vimma-prompt-keys");
  const closed = () => BrowserTestUtils.waitForEvent(panel, "popuphidden");

  let n = await ask();
  Assert.ok(!shows(hintOf(n)), "no keys hint before the prompt is armed");
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 4);
  Assert.equal(panel.state, "open", "y before the prompt is armed answers nothing");
  await until(() => shows(hintOf(n)), "the keys hint shows once armed");
  Assert.ok(hintOf(n).textContent.startsWith("y allow · n block"), hintOf(n).textContent);
  EventUtils.synthesizeKey("j");
  Assert.ok(!shows(hintOf(n)), "a key typed on through the prompt disarms it again");
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 4);
  Assert.equal(panel.state, "open", "and y right after it answers nothing");
  Assert.equal(geo(), SitePermissions.UNKNOWN, "nothing decided yet");
  await until(() => shows(hintOf(n)), "armed again");
  let hidden = closed();
  EventUtils.synthesizeKey("n");
  await hidden;
  Assert.equal(geo(), SitePermissions.BLOCK, "n blocks");
  forget();

  // A page field has focus: what is typed there is the field's.
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    input.id = "vimma-prompt-field";
    content.document.body.append(input);
    input.focus();
  });
  n = await ask();
  await until(() => shows(hintOf(n)), "armed");
  EventUtils.synthesizeKey("y");
  EventUtils.synthesizeKey("n");
  await wait(DELAY / 2);
  Assert.equal(panel.state, "open", "y and n typed in a field answer nothing");
  const typed = await SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("vimma-prompt-field").value,
  );
  Assert.equal(typed, "yn", "they went into the field");
  Assert.equal(geo(), SitePermissions.UNKNOWN, "nothing decided");

  // Tab from the page: focus on the prompt's first button, with a visible ring; Enter there.
  await SpecialPowers.spawn(browser, [], () => content.document.activeElement.blur());
  await focusContent(browser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey("KEY_Tab");
  const focused = () => {
    let el = Services.focus.focusedElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  await until(() => n.contains(focused()?.getRootNode().host ?? focused()), "Tab: in the prompt");
  const inner = focused();
  Assert.equal(
    inner.getRootNode().host,
    n.secondaryButton,
    "on its first button, the secondary one (Block)",
  );
  Assert.ok(inner.matches(":focus-visible"), "with a visible focus ring");
  hidden = closed();
  EventUtils.synthesizeKey("KEY_Enter");
  await hidden;
  Assert.equal(geo(), SitePermissions.BLOCK, "Enter runs the focused button");
  forget();

  // Esc, from the page, is Firefox's: the prompt's Esc action, its secondary button.
  n = await ask();
  await until(() => shows(hintOf(n)), "armed");
  hidden = closed();
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  Assert.equal(geo(), SitePermissions.BLOCK, "Esc blocks, as in Firefox");
  forget();

  n = await ask();
  await until(() => shows(hintOf(n)), "armed");
  hidden = closed();
  EventUtils.synthesizeKey("y");
  await hidden;
  Assert.equal(geo(), SitePermissions.ALLOW, "y allows");
  forget();

  await SpecialPowers.popPrefEnv();
  gBrowser.removeTab(tab);
  await show();
});

// Issue #485: a Vimma surface that takes typing keeps y and n while a prompt shows: live grep's
// query and a search being typed.
add_task(async function prompt_keys_leave_live_grep_and_find_their_keys() {
  const DELAY = 100;
  await SpecialPowers.pushPrefEnv({ set: [["security.notification_enable_delay", DELAY]] });
  const tab = await openPage();
  await hide();
  const browser = tab.linkedBrowser;
  const panel = PopupNotifications.panel;
  const principal = () => browser.contentPrincipal;
  const geo = () => SitePermissions.getForPrincipal(principal(), "geo", browser).state;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  await SpecialPowers.spawn(browser, [], () => {
    content.navigator.geolocation.getCurrentPosition(
      () => {},
      () => {},
    );
  });
  await shown;
  const n = /** @type {any} */ (panel.firstElementChild);
  await until(() => shows(n.querySelector(".vimma-prompt-keys")), "the prompt is armed");

  const grep = () => $("vimma-grep");
  prefix("f");
  EventUtils.synthesizeKey("g");
  await until(() => !!grep()?.open, "ctrl+b f g opens live grep");
  EventUtils.synthesizeKey("y");
  EventUtils.synthesizeKey("n");
  await wait(DELAY * 2);
  Assert.equal(panel.state, "open", "y and n typed into live grep answer nothing");
  Assert.equal(geo(), SitePermissions.UNKNOWN, "nothing decided");
  Assert.equal(
    grep().querySelector(".vimma-grep-query")?.textContent,
    "yn",
    "they went into the grep query",
  );
  // The first Esc leaves the query for browse mode, the second closes.
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !grep()?.open, "Esc Esc closes live grep");

  await focusContent(browser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey("/");
  await until(() => VimmaHost.status(window).mode === "command", "/ starts a search");
  EventUtils.synthesizeKey("y");
  EventUtils.synthesizeKey("n");
  await wait(DELAY * 2);
  Assert.equal(panel.state, "open", "y and n typed into a search answer nothing");
  Assert.equal(geo(), SitePermissions.UNKNOWN, "still nothing decided");
  Assert.equal(gBrowser.getCachedFindBar()?._findField.value, "yn", "they went into the search");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "Esc ends the search");
  await until(() => shows(n.querySelector(".vimma-prompt-keys")), "armed again");

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("y");
  await hidden;
  Assert.equal(geo(), SitePermissions.ALLOW, "with both closed, y answers the prompt again");
  SitePermissions.removeFromPrincipal(principal(), "geo", browser);

  await SpecialPowers.popPrefEnv();
  gBrowser.removeTab(tab);
  await show();
});

// Issue #495: hint, copy and element mode type y and n for themselves (a label from any
// `[modal] hint_chars`, the yank): a prompt the page raises in one of them never takes them.
// After Esc leaves the mode, y answers the prompt as usual.
add_task(async function prompt_keys_leave_hint_copy_and_element_mode_their_keys() {
  const DELAY = 100;
  await SpecialPowers.pushPrefEnv({ set: [["security.notification_enable_delay", DELAY]] });
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const panel = PopupNotifications.panel;
  const principal = () => browser.contentPrincipal;
  const geo = () => SitePermissions.getForPrincipal(principal(), "geo", browser).state;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mode = () => VimmaHost.status(window).mode;
  // Links and text blocks at the top of the page, for the labels and the caret.
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const box = doc.createElement("div");
    box.id = "vimma-prompt-modes";
    for (let i = 0; i < 4; i++) {
      const p = doc.createElement("p");
      const a = doc.createElement("a");
      a.href = `#link${i}`;
      a.textContent = `link ${i}`;
      p.append(`Paragraph ${i} with `, a, " in it.");
      box.append(p);
    }
    doc.body.prepend(box);
    content.scrollTo(0, 0);
  });
  /** Asks for the location; resolves with the prompt once it is armed. */
  const ask = async () => {
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    await SpecialPowers.spawn(browser, [], () => {
      content.navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
      );
    });
    await shown;
    const n = /** @type {any} */ (panel.firstElementChild);
    await until(() => shows(n.querySelector(".vimma-prompt-keys")), "the prompt is armed");
    return n;
  };
  /** In `what`, an armed prompt: y leaves it undecided, its keys line says Esc first. */
  const yKept = async (n, what) => {
    Assert.ok(
      n.querySelector(".vimma-prompt-keys").textContent.startsWith("Esc, then y allow"),
      `${what}: the keys line says to leave the mode first`,
    );
    EventUtils.synthesizeKey("y");
    await wait(DELAY * 3);
    Assert.equal(panel.state, "open", `${what}: y answers nothing`);
    Assert.equal(geo(), SitePermissions.UNKNOWN, `${what}: nothing decided`);
  };
  /** Back in normal mode, y answers the prompt as usual. */
  const yAnswers = async (n, what) => {
    await until(() => mode() === "normal", `${what}: back in normal mode`);
    await until(() => shows(n.querySelector(".vimma-prompt-keys")), "armed again");
    Assert.ok(n.querySelector(".vimma-prompt-keys").textContent.startsWith("y allow"));
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeKey("y");
    await hidden;
    Assert.equal(geo(), SitePermissions.ALLOW, `${what}: then y allows`);
    SitePermissions.removeFromPrincipal(principal(), "geo", browser);
  };

  // Hint mode with an alphabet of y and n: every label starts with one of them.
  VimmaHost.configure({ hintChars: "yn" });
  registerCleanupFunction(() => VimmaHost.configure({ hintChars: DEFAULT_HINT_CHARS }));
  EventUtils.synthesizeKey("f");
  await until(() => mode() === "hint", "f starts link hints");
  let n = await ask();
  await yKept(n, "hint mode");
  Assert.equal(mode(), "hint", "the y went to the labels: still in hint mode");
  EventUtils.synthesizeKey("KEY_Escape");
  await yAnswers(n, "hint mode");
  VimmaHost.configure({ hintChars: DEFAULT_HINT_CHARS });

  // Copy mode: y is the yank.
  EventUtils.synthesizeKey("v");
  await until(() => mode() === "visual", "v starts copy mode");
  n = await ask();
  await yKept(n, "copy mode");
  if (mode() === "visual") EventUtils.synthesizeKey("KEY_Escape");
  await yAnswers(n, "copy mode");

  // Element mode: y is the yank too.
  EventUtils.synthesizeKey("F");
  await until(() => VimmaHost._hints(window)?.hints.length, "F labels the blocks");
  for (const c of VimmaHost._hints(window).hints[0].label) EventUtils.synthesizeKey(c);
  await until(() => mode() === "element", "a label focuses its block");
  n = await ask();
  await yKept(n, "element mode");
  if (mode() === "element") EventUtils.synthesizeKey("KEY_Escape");
  await yAnswers(n, "element mode");

  await SpecialPowers.popPrefEnv();
  gBrowser.removeTab(tab);
});

// 5b: the keys follow Firefox's own delay for the prompt (notification.timeShown), which it
// restarts when the panel is repositioned or resized and when the window is activated. A key
// armed earlier would click a button Firefox still refuses, and be lost.
add_task(async function prompt_keys_arm_on_firefoxs_own_delay() {
  const DELAY = 400;
  await SpecialPowers.pushPrefEnv({ set: [["security.notification_enable_delay", DELAY]] });
  const tab = await openPage();
  await hide();
  const browser = tab.linkedBrowser;
  const panel = PopupNotifications.panel;
  const principal = () => browser.contentPrincipal;
  const geo = () => SitePermissions.getForPrincipal(principal(), "geo", browser).state;
  const forget = () => SitePermissions.removeFromPrincipal(principal(), "geo", browser);
  const ask = async () => {
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    await SpecialPowers.spawn(browser, [], () => {
      content.navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
      );
    });
    await shown;
    return /** @type {any} */ (panel.firstElementChild);
  };
  /** Resolves with the time the keys line shows, taken as it shows. */
  const hintShows = (n) =>
    new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const hint = n.querySelector(".vimma-prompt-keys");
        if (!shows(hint)) return;
        observer.disconnect();
        resolve(ChromeUtils.now());
      });
      observer.observe(n, { attributes: true, childList: true, subtree: true });
    });
  const frames = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  // Showing the line must not restart Firefox's delay (a resize of the panel does).
  let n = await ask();
  let at = await hintShows(n);
  await frames();
  Assert.greaterOrEqual(
    at - n.notification.timeShown,
    DELAY,
    "the keys line shows once Firefox's delay has run, and showing it does not restart it",
  );
  EventUtils.synthesizeKey("y");
  await until(() => panel.state === "closed", "y as the keys show answers");
  Assert.equal(geo(), SitePermissions.ALLOW, "y allows");
  forget();

  // The window is activated while the prompt waits: Firefox's delay starts over, so do the keys.
  n = await ask();
  await new Promise((r) => setTimeout(r, DELAY / 2));
  window.dispatchEvent(new Event("activate"));
  at = await hintShows(n);
  Assert.greaterOrEqual(
    at - n.notification.timeShown,
    DELAY,
    "after an activation the keys line waits for Firefox's restarted delay",
  );
  EventUtils.synthesizeKey("n");
  await until(() => panel.state === "closed", "n as the keys show answers");
  Assert.equal(geo(), SitePermissions.BLOCK, "n blocks");
  forget();

  await SpecialPowers.popPrefEnv();
  gBrowser.removeTab(tab);
  await show();
});

// 5c: the add-on install prompt ("Add <name>?") takes the same keys. Firefox opens it with focus
// on the panel itself (ExtensionsUI's `autofocus`), not on the page, and still guards it with
// its delay.
add_task(async function the_addon_install_prompt_answers_y_and_n() {
  const DELAY = 400;
  await SpecialPowers.pushPrefEnv({ set: [["security.notification_enable_delay", DELAY]] });
  const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const panel = PopupNotifications.panel;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hintOf = (n) => n.querySelector(".vimma-prompt-keys");
  /** Shows the prompt; resolves with it and the answer to come. */
  const ask = async () => {
    const strings = ExtensionsUI._buildStrings({
      addon: { name: "Vimma Test Add-on" },
      permissions: { permissions: ["tabs"], origins: [] },
    });
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    const answer = ExtensionsUI.showPermissionsPrompt(browser, strings, null);
    await shown;
    const n = /** @type {any} */ (panel.firstElementChild);
    Assert.equal(n.id, "addon-webext-permissions-notification", "the add-on install prompt");
    return { n, answer };
  };

  let { n, answer } = await ask();
  let settled = false;
  answer.then(() => (settled = true));
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 4);
  Assert.equal(panel.state, "open", "y before the prompt is armed answers nothing");
  Assert.ok(!settled, "and installs nothing");
  await until(() => shows(hintOf(n)), "the keys hint shows once armed");
  Assert.ok(hintOf(n).textContent.startsWith("y add · n cancel"), hintOf(n).textContent);
  EventUtils.synthesizeKey("n");
  Assert.equal(await answer, false, "n cancels the install");

  ({ n, answer } = await ask());
  await until(() => shows(hintOf(n)), "armed");
  EventUtils.synthesizeKey("y");
  Assert.equal(await answer, true, "y adds it");
  await until(() => panel.state === "closed", "the prompt is gone");

  // Issue #495: this prompt takes focus from the page, so link labels still on screen are no
  // longer the focused page's mode; a y meant for them still never answers it.
  await SpecialPowers.spawn(browser, [], () => {
    for (let i = 0; i < 4; i++) {
      const a = content.document.createElement("a");
      a.href = `#link${i}`;
      a.textContent = `link ${i} `;
      content.document.body.prepend(a);
    }
    content.scrollTo(0, 0);
  });
  EventUtils.synthesizeKey("f");
  await until(() => VimmaHost.status(window).mode === "hint", "f starts link hints");
  ({ n, answer } = await ask());
  settled = false;
  answer.then(() => (settled = true));
  await until(() => shows(hintOf(n)), "armed over the labels");
  Assert.ok(VimmaHost._hints(window), "the labels are still up");
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 2);
  Assert.ok(!settled, "a y typed while the labels show installs nothing");
  Assert.equal(VimmaHost._hints(window), null, "and the labels are gone");
  await until(() => shows(hintOf(n)), "armed again");
  EventUtils.synthesizeKey("y");
  Assert.equal(await answer, true, "then y adds it");
  await until(() => panel.state === "closed", "the prompt is gone");

  await SpecialPowers.popPrefEnv();
  gBrowser.removeTab(tab);
});

// 6: the site's identity panel (Firefox's trust panel, or the identity panel where that is
// off) opens with a click on the site's identity in the prompt bar, hangs from it and keeps the
// prompt bar up while open. The minimal bar has no identity to click; the full toolbar has.
add_task(async function the_identity_panel_shows_the_site_identity() {
  const tab = await openPage();
  await hide();
  const shownPrompt = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.geolocation.getCurrentPosition(
      () => {},
      () => {},
    );
  });
  await shownPrompt;
  Assert.ok(promptSize(), "a prompt shows the prompt bar");
  const button = [$("trust-icon-container"), $("identity-icon-box")].find(shows);
  Assert.ok(button, "the site's identity button shows in it");
  const shown = BrowserTestUtils.waitForEvent(
    document,
    "popupshown",
    false,
    (e) => e.target.anchorNode?.closest?.("#urlbar") && e.target !== PopupNotifications.panel,
  );
  // A click with the mouse: the press closes the prompt before the click lands, and the bar
  // must stay under the pointer meanwhile (reason h).
  EventUtils.synthesizeMouseAtCenter(button, {});
  const popup = (await shown).target;
  Assert.ok(button.contains(popup.anchorNode) || popup.anchorNode === button, "anchored to it");
  Assert.ok(promptSize(), "the prompt bar shows while the panel is open, not in full");
  Assert.ok(!shows($("back-button")), "no buttons");
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(popup.state, "open", "the panel stays open");
  Assert.ok(!barCollapsed(), "and so does the bar");
  PanelMultiView.hidePopup(popup);
  await until(() => popup.state === "closed", "the panel closes");
  // Firefox shows the prompt again, which still waits for an answer.
  await until(() => PopupNotifications.panel.state === "open", "the prompt is back");
  Assert.ok(promptSize(), "with the prompt bar");
  const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
  PopupNotifications.panel.firstElementChild.secondaryButton.click();
  await hidden;
  await until(() => barCollapsed(), "answered: the bar hides");
  SitePermissions.removeFromPrincipal(tab.linkedBrowser.contentPrincipal, "geo", tab.linkedBrowser);
  gBrowser.removeTab(tab);
  await show();
});

// 7: add-on popups show the full toolbar and hang from their button.
add_task(async function an_add_on_popup_shows_the_full_toolbar() {
  const ext = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      name: "Toolbar popup",
      browser_specific_settings: { gecko: { id: "toolbar-popup@vimma.test" } },
      browser_action: { default_popup: "popup.html", default_area: "navbar" },
      // MV2's name for `_execute_action`.
      commands: { _execute_browser_action: { suggested_key: { default: "Alt+Shift+U" } } },
    },
    files: {
      "popup.html": `<!doctype html><meta charset=utf-8><p>popup<script src=popup.js></script>`,
      "popup.js": `browser.test.sendMessage("popup-ready");`,
    },
  });
  await ext.startup();
  const widgetId = "toolbar-popup_vimma_test-browser-action";
  const tab = await openPage();
  await hide();

  /** Opens the popup with `open`, checks its anchor and the full bar, closes it with Esc. */
  async function check(what, open, anchorId) {
    await focusContent(tab.linkedBrowser);
    await open();
    await ext.awaitMessage("popup-ready");
    const panel = document.getElementById("customizationui-widget-panel");
    await until(() => panel?.state === "open", `${what}: the popup is open`);
    Assert.ok(revealedFull(), `${what}: the full toolbar shows`);
    Assert.ok(shows($("back-button")), `${what}: with its buttons`);
    const anchor = panel.anchorNode?.closest(`#${anchorId}`) ?? panel.anchorNode;
    Assert.equal(anchor?.id, anchorId, `${what}: anchored to #${anchorId}`);
    Assert.ok(shows(panel.anchorNode), `${what}: the anchor is visible`);
    await new Promise((r) => setTimeout(r, 700));
    Assert.equal(panel.state, "open", `${what}: the bar stays while it is open`);
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => panel.state === "closed", `${what}: Esc closes it`);
    await until(() => barCollapsed(), `${what}: the bar hides again`);
  }

  const ID = "toolbar-popup@vimma.test";
  const pick = async () => {
    prefix("e");
    await until(() => $("vimma-addon-picker")?.open, "the add-on picker");
    const picker = $("vimma-addon-picker");
    EventUtils.synthesizeKey("/");
    EventUtils.sendString("toolbar popup");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(
      () => picker.querySelector("[role=option][aria-selected=true]")?.dataset.id === ID,
      "the add-on is selected",
    );
    EventUtils.synthesizeKey("KEY_Enter");
  };
  // The add-on's own shortcut: Firefox's key runs it (ExtensionShortcuts → triggerAction), a
  // path Vimma takes no part in (decision 7d).
  await check(
    "pinned, its own shortcut",
    () => EventUtils.synthesizeKey("U", { altKey: true, shiftKey: true }),
    widgetId,
  );

  await check("pinned, ctrl+b e", () => pick(), widgetId);
  CustomizableUI.addWidgetToArea(widgetId, CustomizableUI.AREA_ADDONS);
  await check("in the extensions menu", () => pick(), "unified-extensions-button");

  await ext.unload();
  gBrowser.removeTab(tab);
  await show();
});

// 8: hiding with focus in the URL bar moves focus to the page first.
add_task(async function hiding_with_focus_in_the_url_bar_moves_focus_to_the_page() {
  const tab = await openPage();
  gURLBar.focus();
  await until(() => gURLBar.focused, "the URL bar has focus");
  prefix("u");
  await until(() => barCollapsed(), "ctrl+b u hides");
  Assert.equal(document.activeElement, tab.linkedBrowser, "focus moved to the page");
  Assert.ok(!gURLBar.focused, "not left in a collapsed field");
  await show();
  gBrowser.removeTab(tab);
});

// 9: the safety net: a URL bar that cannot be revealed brings the toolbar back.
add_task(async function a_failed_reveal_shows_the_toolbar() {
  const tab = await openPage();
  await hide();
  const t = toolbarOf();
  const reveal = t.reveal;
  t.reveal = () => {};
  try {
    EventUtils.synthesizeKey("I", { shiftKey: true });
    await until(() => gURLBar.focused, "the URL bar is focused anyway");
    Assert.ok(!Services.prefs.getBoolPref(PREF), "the pref is back to shown");
    Assert.ok(!barCollapsed(), "the toolbar shows");
    await until(
      () => noticeText().startsWith("toolbar shown: the address bar could not be revealed"),
      "the notice says why",
    );
  } finally {
    t.reveal = reveal;
  }
  await escapeUrlbar();
  gBrowser.removeTab(tab);
});

// 10: popups keep their URL bar; customize mode and fullscreen are Firefox's.
add_task(async function exclusions() {
  const tab = await openPage();
  await hide();

  const popupOpened = BrowserTestUtils.waitForNewWindow();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.open(content.location.href, "_blank", "popup,width=400,height=300");
  });
  const popup = await popupOpened;
  Assert.ok(popup.document.documentElement.hasAttribute("popup-window"), "a popup window");
  Assert.ok(!barCollapsed(popup), "it keeps its read-only URL bar");
  await BrowserTestUtils.closeWindow(popup);

  const ready = BrowserTestUtils.waitForEvent(gNavToolbox, "customizationready");
  gCustomizeMode.enter();
  await ready;
  Assert.ok(!barCollapsed(), "customize mode shows the toolbar");
  const done = BrowserTestUtils.waitForEvent(gNavToolbox, "aftercustomization");
  gCustomizeMode.exit();
  await done;
  await until(() => barCollapsed(), "hidden again after customize mode");

  const full = BrowserTestUtils.waitForEvent(window, "fullscreen");
  window.fullScreen = true;
  await full;
  await until(() => root().hasAttribute("inFullscreen"), "F11 fullscreen");
  Assert.ok(
    $("nav-bar").checkVisibility(VISIBLE),
    "in F11 fullscreen Firefox's own toolbox owns the bar",
  );
  const back = BrowserTestUtils.waitForEvent(window, "fullscreen");
  window.fullScreen = false;
  await back;
  await until(() => !root().hasAttribute("inFullscreen") && barCollapsed(), "and back");

  gBrowser.removeTab(tab);
  await show();
});

// 11: the status bar carries the security and private-browsing cues while hidden.
add_task(async function the_status_bar_says_not_secure_and_private() {
  const tab = await openPage(HTTP_PLAIN);
  Assert.equal(segText("security"), null, "shown: no security segment");
  await hide();
  Assert.equal(tab.linkedBrowser.currentURI.scheme, "http", "the page stayed on http:");
  await until(
    () => segText("security") === "not secure",
    `an http: page is not secure (identity box: ${$("identity-box").className}; bar: ${$("vimma-statusbar").textContent}; root hidden: ${root().hasAttribute(HIDDEN)})`,
  );
  await until(() => segText("url")?.startsWith("http://"), "and its URL keeps http://");
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PLAIN);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PLAIN);
  await until(() => segText("security") === null, "an https: page says nothing");
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:blank");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:blank");
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(segText("security"), null, "nor a blank page");

  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await until(
    () => ($("vimma-statusbar", priv)?.textContent ?? "").includes("private"),
    "a private window says private",
  );
  await show();
  await BrowserTestUtils.closeWindow(priv);
  gBrowser.removeTab(tab);
});

// docs/security.md C3: with the toolbar hidden the status bar is the only origin
// indicator. It keeps the registrable domain in view, is never replaced by a title, names an
// opener-controlled about:blank, shows what the page uses, and reads the security state from
// the browser, not from the hidden address bar.
/**
 * The host as the status bar shows it: the URL up to its path, without a cut's ellipses.
 * @param {string | null} url
 */
function hostShown(url) {
  if (!url) return null;
  return (
    url
      .replace(/^https?:\/\//, "")
      .split(/[/…]/)
      .find(Boolean) ?? null
  );
}

add_task(async function the_status_bar_keeps_the_registrable_domain() {
  const deep =
    "https://sub1.test1.example.com/browser/browser/base/zen-components/tests/browser/file_vimma_plain.html?a-very-long-query-that-pushes-the-host-out";
  const tab = await openPage(deep);
  await hide();
  const bar = $("vimma-statusbar");
  try {
    for (const width of ["40ch", "60ch", "90ch"]) {
      bar.style.width = width;
      await until(() => !!hostShown(segText("url")), `${width}: the host shows`);
      const host = hostShown(segText("url"));
      Assert.ok(
        host === "example.com" || host.endsWith(".example.com"),
        `${width}: it ends with the base domain (${segText("url")})`,
      );
    }
    // A page that titles itself with an address does not take the URL's place.
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.document.title = "accounts.google.com/signin";
    });
    bar.style.width = "60ch";
    await until(
      () => hostShown(segText("url"))?.endsWith(".example.com"),
      "the URL stays next to such a title",
    );
  } finally {
    bar.style.removeProperty("width");
  }
  gBrowser.removeTab(tab);
  await show();
});

add_task(async function an_about_blank_a_page_wrote_says_so() {
  const tab = await openPage();
  await hide();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:blank");
  // The page itself opens and writes the tab, as a phishing page would.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const script = content.document.createElement("script");
    // DOM calls keep the address about:blank (document.write would give the tab the opener's
    // address, which the bar then shows as it is).
    script.textContent = `
      const w = window.open();
      w.document.title = "accounts.google.com/signin";
      w.document.body.innerHTML = "<form><input type=password></form>";`;
    content.document.body.append(script);
  });
  const blank = await opened;
  await until(() => gBrowser.selectedTab === blank, "the new tab is selected");
  await until(
    () => segText("url") === "about:blank from example.com",
    `the status bar says about:blank and who wrote it (${segText("url")})`,
  );
  gBrowser.removeTab(blank);
  gBrowser.removeTab(tab);
  await show();
});

// C3: a blob: page keeps its origin, whatever its path says.
add_task(async function a_blob_page_shows_its_origin() {
  const tab = await openPage(
    PLAIN.replace("https://example.com", "https://sub1.test1.example.com"),
  );
  await hide();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, (url) => url.startsWith("blob:"), true);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const script = content.document.createElement("script");
    script.textContent = `
      const page = "<title>Sign in</title><form><input type=password></form>";
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      window.open(url);`;
    content.document.body.append(script);
  });
  const blob = await opened;
  gBrowser.selectedTab = blob;
  await until(() => gBrowser.currentURI.spec.startsWith("blob:"), "the blob: page is selected");
  const bar = $("vimma-statusbar");
  try {
    for (const width of ["40ch", "50ch", "80ch", "120ch"]) {
      bar.style.width = width;
      await until(() => segText("url")?.length > 0, `${width}: an address shows`);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const url = segText("url");
      Assert.ok(
        /(^|[/.…])example\.com(…|\/|$)/.test(url),
        `${width}: the origin's domain ends the host (${url})`,
      );
    }
  } finally {
    bar.style.removeProperty("width");
  }
  gBrowser.removeTab(blob);
  gBrowser.removeTab(tab);
  await show();
});

// C3: the label names who wrote the blank page, even after that page navigates away.
add_task(async function an_about_blank_names_its_writer_after_the_opener_leaves() {
  const tab = await openPage();
  await hide();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:blank");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const script = content.document.createElement("script");
    script.textContent = `
      const w = window.open();
      w.document.title = "Your bank";
      location.href = "https://example.org/";`;
    content.document.body.append(script);
  });
  const blank = await opened;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "https://example.org/");
  gBrowser.selectedTab = blank;
  await until(
    () => segText("url") === "about:blank from example.com",
    `it names the writer, not where the opener went (${segText("url")})`,
  );
  gBrowser.removeTab(blank);
  gBrowser.removeTab(tab);
  await show();
});

add_task(async function the_status_bar_shows_camera_and_mic_in_use() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.fake", true],
      ["media.getusermedia.window.focus_source.enabled", false],
    ],
  });
  const tab = await openPage();
  // Allowed, as after a "remember" answer, so no prompt comes between.
  const principal = tab.linkedBrowser.contentPrincipal;
  for (const type of ["camera", "microphone"]) {
    Services.perms.addFromPrincipal(principal, type, Services.perms.ALLOW_ACTION);
  }
  registerCleanupFunction(() => {
    for (const type of ["camera", "microphone"])
      Services.perms.removeFromPrincipal(principal, type);
  });
  await hide();
  Assert.equal(segText("sharing"), null, "nothing in use yet");
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    content.wrappedJSObject.vimmaStream = await content.navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
  });
  await until(
    () => segText("sharing") === "using camera, mic",
    `the status bar says camera and mic (${segText("sharing")})`,
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    for (const t of content.wrappedJSObject.vimmaStream.getTracks()) t.stop();
  });
  await until(() => segText("sharing") === null, "stopped: gone");
  gBrowser.removeTab(tab);
  await show();
  await SpecialPowers.popPrefEnv();
});

add_task(async function not_secure_comes_from_the_browser_state() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.mixed_content.block_active_content", false],
      ["security.mixed_content.upgrade_display_content", false],
    ],
  });
  await hide();
  // A certificate error page.
  const bad = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://expired.example.com/",
    false,
  );
  await BrowserTestUtils.waitForErrorPage(bad.linkedBrowser);
  await until(() => segText("security") === "not secure", "a certificate error page");
  gBrowser.removeTab(bad);
  // Mixed active content.
  const mixed = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  // The test page loads a script over http: mixed active content, allowed above.
  await SpecialPowers.spawn(
    mixed.linkedBrowser,
    [HTTP_PLAIN.replace(/[^/]*$/, "file_vimma_mixed.js")],
    (src) => {
      const script = content.document.createElement("script");
      script.src = src;
      content.document.head.append(script);
    },
  );
  await until(() => mixed.linkedBrowser.contentTitle === "mixed loaded", "the http script ran");
  await until(() => segText("security") === "not secure", "mixed active content");
  gBrowser.removeTab(mixed);
  // An unsent edit in the hidden address bar changes nothing.
  const tab = await openPage(HTTP_PLAIN);
  await until(() => segText("security") === "not secure", "an http: page");
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused, "I");
  EventUtils.sendString("something typed");
  gBrowser.selectedBrowser.focus();
  await until(() => !gURLBar.focused, "focus back in the page, the edit unsent");
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(segText("security"), "not secure", "still not secure");
  gBrowser.removeTab(tab);
  // http on the loopback address is a secure context, which Firefox's address bar does not
  // call not secure (gIdentityHandler._getIsSecureContext).
  const loopback = await openPage(
    getRootDirectory(gTestPath).replace("chrome://mochitests/content", "http://127.0.0.1:8888") +
      "file_vimma_plain.html",
  );
  await until(() => segText("url")?.includes("127.0.0.1"), "the loopback page is shown");
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(segText("security"), null, "http on 127.0.0.1: not called not secure");
  gBrowser.removeTab(loopback);
  await show();
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_failed_reveal_for_a_prompt_shows_the_toolbar() {
  const tab = await openPage();
  await hide();
  const t = toolbarOf();
  const reveal = t.reveal;
  t.reveal = () => {};
  try {
    const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
      );
    });
    await shown;
    Assert.ok(!Services.prefs.getBoolPref(PREF), "the toolbar is back");
    Assert.equal(
      PopupNotifications.panel.anchorNode?.id,
      "geo-notification-icon",
      "the prompt hangs from its icon, never unanchored",
    );
    Assert.ok(shows(PopupNotifications.panel.anchorNode), "which is visible");
    await until(() => noticeText().startsWith("toolbar shown:"), "the notice says why");
    const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
    PopupNotifications.panel.firstElementChild.secondaryButton.click();
    await hidden;
  } finally {
    t.reveal = reveal;
  }
  gBrowser.removeTab(tab);
  await show();
});

// 12: [ui] toolbar from config.toml; a toggle lasts until that line changes.
add_task(async function config_sets_the_toolbar() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", configFile],
      ["vimma.config.pollMs", 100],
    ],
  });
  let n = 0;
  const write = (text) =>
    IOUtils.writeUTF8(configFile, `schema = 2\n${text}\n${"#".repeat(++n)}\n`);

  await show();
  await write(`[ui]\ntoolbar = "hidden"`);
  await until(() => ConfigHost.config?.ui.toolbar === "hidden", "the poll reads the file");
  await until(() => Services.prefs.getBoolPref(PREF, false), "and hides the toolbar");
  await until(() => barCollapsed(), "hidden");

  const tab = await openPage();
  prefix("u");
  await until(() => !barCollapsed(), "ctrl+b u shows it");
  await write(`[ui]\ntoolbar = "hidden"\n# another line`);
  await new Promise((r) => setTimeout(r, 600));
  Assert.ok(!Services.prefs.getBoolPref(PREF), "an edit elsewhere keeps the toggle");
  await write(`[ui]\ntoolbar = "shown"`);
  await new Promise((r) => setTimeout(r, 600));
  Assert.ok(!Services.prefs.getBoolPref(PREF), "shown, as it was");
  await write(`[ui]\ntoolbar = "hidden"`);
  await until(() => Services.prefs.getBoolPref(PREF, false), "changing the line applies it");

  await IOUtils.remove(configFile);
  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
  await until(() => !Services.prefs.getBoolPref(PREF, false), "no config: shown");
  gBrowser.removeTab(tab);
});

// 14: the pointer at the window's top edge reveals nothing: the bar shows for the address, a
// prompt or a popup, and `ctrl+b u` brings the whole toolbar back.
add_task(async function the_top_edge_reveals_nothing() {
  const tab = await openPage();
  await hide();
  Assert.equal($("vimma-toolbar-edge"), null, "no hover strip at the top edge");
  EventUtils.synthesizeMouse(document.documentElement, 20, 0, { type: "mousemove" });
  EventUtils.synthesizeMouse(document.documentElement, 20, 1, { type: "mousemove" });
  await new Promise((r) => setTimeout(r, 400));
  Assert.ok(barCollapsed(), "the pointer at the top edge leaves the bar hidden");
  Assert.ok(!root().hasAttribute(REVEALED), "nothing is revealed");
  gBrowser.removeTab(tab);
  await show();
});

// 15: revealing never moves buttons into or out of the overflow menu.
add_task(async function revealing_keeps_the_overflow_menu() {
  const tab = await openPage();
  const added = [
    "home-button",
    "library-button",
    "sidebar-button",
    "print-button",
    "save-page-button",
    "new-window-button",
    "fullscreen-button",
    "zoom-controls",
    "edit-controls",
    "email-link-button",
    "find-button",
    "open-file-button",
    "developer-button",
    "preferences-button",
    "history-panelmenu",
    "characterencoding-button",
  ];
  for (const id of added) CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR);
  const width = window.outerWidth;
  window.resizeTo(560, window.outerHeight);
  await until(() => $("nav-bar").hasAttribute("overflowing"), "the nav bar overflows");
  const overflowed = () =>
    [...document.querySelectorAll("[overflowedItem]")]
      .map((c) => c.id)
      .sort()
      .join(",");
  await new Promise((r) => setTimeout(r, 300));
  const before = overflowed();

  Assert.ok(before.length, "some buttons are in the overflow menu");

  await hide();
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(overflowed(), before, "hidden, after a resize: the same overflowed items");
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused && minimal(), "minimal");
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(overflowed(), before, "minimal: the same overflowed items");
  toolbarOf().hold("test", "full");
  await until(() => revealedFull(), "full");
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(overflowed(), before, "full: the same overflowed items");
  toolbarOf().release("test");
  await escapeUrlbar();

  await show();
  CustomizableUI.reset();
  window.resizeTo(width, window.outerHeight);
  gBrowser.removeTab(tab);
});

// 16: a minimal and a full reason together show full; the full one ending leaves minimal.
add_task(async function mixed_sizes() {
  const tab = await openPage();
  await hide();
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused && minimal(), "minimal");
  const panel = $("downloadsPanel") ?? null;
  const t = toolbarOf();
  t.hold("downloads-test", "full");
  await until(() => revealedFull(), "a full reason as well: full");
  t.release("downloads-test");
  await until(() => minimal(), "it ended: back to minimal, not hidden");
  Assert.ok(!barCollapsed(), "still shown");
  Assert.ok(panel === null || panel.state === "closed", "no panel left open");
  await escapeUrlbar();
  await until(() => barCollapsed(), "hidden");
  gBrowser.removeTab(tab);
  await show();
});

// 17: the account panel has no "Get Vimma for Android or iOS" row, shown or hidden.
add_task(async function the_account_panel_has_no_mobile_promo() {
  const node = (id) => PanelMultiView.getViewNode(document, id);
  for (const hidden of [false, true]) {
    Services.prefs.setBoolPref(PREF, hidden);
    const what = hidden ? "toolbar hidden" : "toolbar shown";
    const view = node("PanelUI-fxa");
    const shown = BrowserTestUtils.waitForEvent(view, "ViewShown");
    PanelUI.showSubView("PanelUI-fxa", $("PanelUI-menu-button"));
    await shown;
    // What browser-sync.js unhides for a signed-in user, mobile row included.
    const unhidden = [
      "PanelUI-signedin-panel",
      "PanelUI-fxa-menu-sync-status-button",
      "PanelUI-fxa-menu-get-firefox-mobile",
    ].map(node);
    const was = unhidden.map((el) => el.hidden);
    for (const el of unhidden) el.hidden = false;
    Assert.ok(
      !node("PanelUI-fxa-menu-get-firefox-mobile").checkVisibility(),
      `${what}: no mobile-app row`,
    );
    Assert.ok(
      node("PanelUI-fxa-menu-sync-status-button").checkVisibility(),
      `${what}: the Sync row stays`,
    );
    unhidden.forEach((el, i) => (el.hidden = was[i]));
    const panel = view.closest("panel");
    const closed = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await closed;
  }
  await show();
});

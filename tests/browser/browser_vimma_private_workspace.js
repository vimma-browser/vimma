/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/private-workspace.md. The private workspace is Firefox's private window,
// presented as one more workspace: ctrl+b shift+p / ctrl+shift+p / :private go there (and back),
// it is never a cycle or alternate target of a normal window, the pickers list it as a last row
// with a count only, a tab may move in (y/N) but never out, vimma-ctl withholds its URLs and
// titles, nothing about it reaches the normal profile, and closing it discards its data.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces, WINDOW_KEY } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { validateMessage, PRIVATE_WORKSPACE_ID } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);
const { getTabLabel, setTabLabel } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/tab-labels.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);
const { SessionSaver } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
);
const { SessionFile } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionFile.sys.mjs",
);
const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const FORM = `${ROOT}file_vimma_private_form.html`;
const SLOW = `${ROOT}file_vimma_slow.sjs`;
const PAGE = "https://example.com/?normal";
const PICKER_ID = "vimma-workspace-picker";
const GOTO_ID = "vimma-picker";
const PANEL_ID = "vimma-panel";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const MARK = "vimmaprivate";

/** @type {string[]} */
const created = [];
/** @param {string} name */
function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return w;
}
const main = () => WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
const ww = (win = window) => WindowWorkspaces.get(win);

registerCleanupFunction(async () => {
  for (const w of privateWindows()) await BrowserTestUtils.closeWindow(w);
  await SimpleTest.promiseFocus(window);
  ww().switchTo({ id: main().id });
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** Every open private window, pop-ups included: all of them hold the private jar. */
function privateWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(
    (w) => !w.closed && PrivateBrowsingUtils.isWindowPrivate(w),
  );
}

/** The on-disk vimma-workspaces.json, or "" before the store first saved it. */
async function definitionsFile() {
  const path = PathUtils.join(PathUtils.profileDir, "vimma-workspaces.json");
  return (await IOUtils.exists(path)) ? IOUtils.readUTF8(path) : "";
}

/** The private page's address, its tab label and the text typed into its form. */
const LEAK = `${MARK}-leak`;
const LABEL = `${MARK}-label`;
const SECRET = "vimma-secret";

/**
 * What must never name the private workspace or a private page (decision 8a). The fixture's
 * cookie and field are called vimmaprivate in the normal window's control page too, so the
 * check is for what only the private page has.
 * @param {string} text
 * @param {string} what
 * @param {{ vimma?: boolean }} [options]  Vimma's own data: no workspace called "private"
 */
function namesNothingPrivate(text, what, { vimma = false } = {}) {
  const words = [LEAK, LABEL, SECRET, PRIVATE_WORKSPACE_ID, ...(vimma ? ['"private"'] : [])];
  for (const word of words) Assert.ok(!text.includes(word), `${what} does not contain ${word}`);
}

/** ctrl+b, then `key` with `mods`, in `win`. */
function prefix(key, mods = {}, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

/** @param {Window} win */
const isActive = (win) => Services.focus.activeWindow === win;

/** Presses ctrl+b shift+p in the normal window and returns the private window it opened. */
async function openPrivate() {
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => isActive(priv), "the private window has focus");
  return priv;
}

/** @param {Window} win @param {string} id statusSegments id */
function segText(win, id) {
  return (
    win.document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

/** @param {Window} win */
const noticeText = (win) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";
/** @param {Window} win */
const promptOpen = (win) => win.document.getElementById(PROMPT_ID)?.hidden === false;
/** @param {Window} win  the prompt's question */
const promptText = (win) =>
  (
    win.document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ??
    ""
  ).trim();

/**
 * Focuses `win`'s selected page (focusContent is this window's only).
 * @param {Window} win
 */
async function focusPage(win) {
  if (win === window) {
    await focusContent(gBrowser.selectedBrowser);
    return;
  }
  const browser = win.gBrowser.selectedBrowser;
  await SimpleTest.promiseFocus(browser);
  await until(() => win.document.activeElement === browser, "the page has focus");
  await TestUtils.waitForCondition(() =>
    SpecialPowers.spawn(browser, [], () => content.document.hasFocus()),
  );
}

/** `:line` Enter in `win`, from its selected page. */
async function runCommand(line, win = window) {
  await SimpleTest.promiseFocus(win);
  await focusPage(win);
  EventUtils.synthesizeKey(":", { shiftKey: true }, win);
  EventUtils.sendString(line, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/** Answers the open y/N prompt in `win`. */
async function answer(win, key) {
  await until(() => promptOpen(win), "the y/N prompt is open");
  EventUtils.synthesizeKey(key, {}, win);
}

/** The rows of the picker `id` in `win`: [title, right cell]. */
function pickerRows(win, id) {
  return [...(win.document.getElementById(id)?.querySelectorAll(".vimma-picker-row") ?? [])].map(
    (r) => [
      r.querySelector(".vimma-picker-title").textContent,
      r.querySelector(".vimma-picker-host").textContent,
    ],
  );
}

/**
 * Types `value` into the fixture's field and submits its form.
 * @param {XULBrowserElement} browser
 * @param {string} value
 */
function submitForm(browser, value) {
  return SpecialPowers.spawn(browser, [value], async (text) => {
    const field = content.document.getElementById("field");
    field.focus();
    field.setUserInput(text);
    content.document.getElementById("submit").click();
  });
}

/** The URL the fixture's form submits `value` to. */
const submittedUrl = (value) => `${FORM}?vimmaprivatefield=${value}`;

add_task(async function prefix_shift_p_opens_one_private_window_and_toggles_back() {
  Assert.equal(privateWindows().length, 0, "no private window yet");
  // Before the first ctrl+b shift+p: going to private and back must write nothing anywhere.
  const normalValue = SessionStore.getCustomWindowValue(window, WINDOW_KEY);
  const definitions = JSON.stringify(WorkspaceStore.definitions);
  const priv = await openPrivate();
  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(priv), "it is a private window");
  Assert.equal(privateWindows().length, 1, "exactly one");

  prefix("P", { shiftKey: true }, priv);
  await until(() => isActive(window), "again in private goes back to the normal window");

  // ctrl+shift+p is Vimma's now: it goes to the one private workspace, no second window.
  EventUtils.synthesizeKey("P", { ctrlKey: true, shiftKey: true });
  await until(() => isActive(priv), "ctrl+shift+p goes to the private workspace");
  Assert.equal(privateWindows().length, 1, "Firefox's New Private Window key did not run");
  EventUtils.synthesizeKey("P", { ctrlKey: true, shiftKey: true }, priv);
  await until(() => isActive(window), "ctrl+shift+p in private goes back");
  Assert.equal(privateWindows().length, 1, "still one private window");

  await runCommand("private");
  await until(() => isActive(priv), ":private goes there too");
  await BrowserTestUtils.openNewForegroundTab(priv.gBrowser, `${FORM}?first`);
  await runCommand("priv", priv);
  await until(() => isActive(window), ":priv in private goes back");

  Assert.equal(
    SessionStore.getCustomWindowValue(window, WINDOW_KEY),
    normalValue,
    "the normal window's vimma-workspaces value is unchanged by the toggles",
  );
  Assert.equal(
    JSON.stringify(WorkspaceStore.definitions),
    definitions,
    "the workspace definitions are unchanged",
  );
});

add_task(async function cycling_never_enters_private_and_leaves_to_the_ends() {
  const [priv] = privateWindows();
  const A = workspace("pw-a");
  const B = workspace("pw-b");
  // The agent workspace sorts last and is never cycled (docs/specs/vimma-mcp.md decision 9).
  const all = () => ww().model.workspaces.map((w) => w.id);
  Assert.equal(all().at(-1), WorkspaceStore.agent?.id, "the agent workspace is the last one");
  const order = () => all().filter((id) => id !== WorkspaceStore.agent?.id);
  const first = () => order()[0];
  const last = () => order().at(-1);
  Assert.equal(last(), B.id, "B is the last cycled workspace");

  await SimpleTest.promiseFocus(window);
  ww().switchTo({ id: B.id });
  prefix(")", { shiftKey: true });
  await until(() => ww().model.active === first(), "ctrl+b ) from the last wraps to the first");
  Assert.ok(isActive(window), "and the normal window keeps focus, not private");
  ww().switchTo({ id: first() });
  prefix("(", { shiftKey: true });
  await until(() => ww().model.active === last(), "ctrl+b ( from the first wraps to the last");
  Assert.ok(isActive(window), "still the normal window");

  // In private, ) and ( leave to the first and the last normal workspace.
  ww().switchTo({ id: A.id });
  await SimpleTest.promiseFocus(priv);
  prefix(")", { shiftKey: true }, priv);
  await until(() => isActive(window), "ctrl+b ) in private leaves it");
  Assert.equal(ww().model.active, first(), "for the first workspace");
  await SimpleTest.promiseFocus(priv);
  prefix("(", { shiftKey: true }, priv);
  await until(() => isActive(window), "ctrl+b ( in private leaves it");
  Assert.equal(ww().model.active, last(), "for the last workspace");

  // ctrl+^ from private returns to the workspace left, in the window left.
  ww().switchTo({ id: A.id });
  prefix("P", { shiftKey: true });
  await until(() => isActive(priv), "to private from A");
  ww().switchTo({ id: B.id }); // the normal window moved on meanwhile (a script, a link)
  prefix("^", { shiftKey: true, code: "Digit6" }, priv);
  await until(() => isActive(window), "ctrl+b ^ in private goes back");
  Assert.equal(ww().model.active, A.id, "to A, the workspace left");

  // In the normal window ctrl+^ is the last normal workspace, never private.
  await focusContent(gBrowser.selectedBrowser); // the switch to A has settled
  prefix("^", { shiftKey: true, code: "Digit6" });
  await until(() => ww().model.active === B.id, "ctrl+b ^ toggles between normal workspaces");
  Assert.ok(isActive(window), "and never enters private");
  ww().switchTo({ id: main().id });
});

add_task(async function the_status_bar_and_side_panel_show_private() {
  const [priv] = privateWindows();
  await SimpleTest.promiseFocus(priv);
  await until(() => segText(priv, "workspace") === "◆ private", "the bar says ◆ private");
  const tab = await BrowserTestUtils.openNewForegroundTab(priv.gBrowser, `${FORM}?panel`);
  prefix("b", {}, priv);
  const panel = priv.document.getElementById(PANEL_ID);
  await until(() => panel && !panel.hidden, "ctrl+b b opens the side panel in private");
  Assert.equal(
    panel.querySelector(".vimma-panel-name").textContent,
    "private",
    "under a private head",
  );
  Assert.ok(
    panel.querySelector(`.vimma-panel-row[data-tab-id="${tab.linkedPanel}"]`),
    "listing the private window's tabs",
  );
  // Every profile has the agent workspace (docs/specs/vimma-mcp.md decision 8), last in the
  // model; the cycle skips it (decision 9), so the head never names it.
  const agent = WorkspaceStore.agent;
  Assert.equal(ww().model.workspaces.at(-1).id, agent.id, "the agent workspace sorts last");
  const cycled = ww().model.workspaces.filter((w) => w.id !== agent.id);
  Assert.equal(
    panel.querySelector(".vimma-panel-neighbours").textContent,
    `ctrl+b ( ${cycled.at(-1).name} · ctrl+b ) ${cycled[0].name}`,
    "its neighbours are the last and the first normal workspace, past the agent workspace",
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  await until(() => panel.hidden, "Esc closes it");
});

add_task(async function a_normal_side_panel_names_the_cycles_targets_past_agent() {
  await SimpleTest.promiseFocus(window);
  const agent = WorkspaceStore.agent;
  const cycled = ww().model.workspaces.filter((w) => w.id !== agent.id);
  Assert.greater(cycled.length, 1, "two normal workspaces and the agent workspace");
  ww().switchTo({ id: cycled.at(-1).id });
  await until(() => ww().model.active === cycled.at(-1).id, "on the last normal workspace");
  await focusContent(gBrowser.selectedBrowser);
  prefix("b");
  const panel = document.getElementById(PANEL_ID);
  await until(() => panel && !panel.hidden, "ctrl+b b opens the side panel");
  Assert.equal(
    panel.querySelector(".vimma-panel-neighbours").textContent,
    `ctrl+b ( ${cycled.at(-2).name} · ctrl+b ) ${cycled[0].name}`,
    "ctrl+b ) wraps to the first workspace, past the agent workspace",
  );
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => panel.hidden, "Esc closes it");
  ww().switchTo({ id: main().id });
});

add_task(async function a_normal_window_never_shows_a_private_title_or_url() {
  const [priv] = privateWindows();
  const tabs = () => priv.gBrowser.tabs.length;
  await SimpleTest.promiseFocus(window);
  prefix("w");
  await until(() => pickerRows(window, PICKER_ID).length, "the workspace picker is open");
  const rows = pickerRows(window, PICKER_ID);
  Assert.deepEqual(
    rows.at(-1),
    ["◆ private", `${tabs()} tabs`],
    "its last row is the private workspace with a count",
  );
  EventUtils.synthesizeKey("KEY_Escape");

  prefix("g");
  await until(() => window.document.getElementById(GOTO_ID)?.open, "the goto picker is open");
  const goto = window.document.getElementById(GOTO_ID).textContent;
  Assert.ok(!goto.includes("vimma private page"), "the goto picker shows no private title");
  Assert.ok(!goto.includes("file_vimma_private_form"), "nor a private URL");
  EventUtils.synthesizeKey("KEY_Escape");

  prefix("b");
  const panel = document.getElementById(PANEL_ID);
  await until(() => panel && !panel.hidden, "the side panel is open");
  Assert.ok(!panel.textContent.includes("vimma private page"), "the side panel neither");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => panel.hidden, "closed");

  // Enter on the private row goes there.
  prefix("w");
  await until(() => pickerRows(window, PICKER_ID).length, "the workspace picker is open");
  for (let i = 0; i < pickerRows(window, PICKER_ID).length; i++) EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => isActive(priv), "Enter on the private row goes to the private workspace");
});

// docs/specs/tab-search.md decision 5: tab search lists other windows and recently closed tabs,
// but never across the private line, in either direction.
add_task(async function tab_search_keeps_private_and_normal_apart_both_ways() {
  const [priv] = privateWindows();
  const titled = async (gB, url, title) => {
    const tab = BrowserTestUtils.addTab(gB, url);
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    await SpecialPowers.spawn(tab.linkedBrowser, [title], (t) => {
      content.document.title = t;
    });
    await until(() => tab.label === title, `titled ${title}`);
    // Session history comes from the tab's own process, a background one here: without its
    // last update, SessionStore keeps no closed tab for it (issue #605, seen on macOS).
    await TabStateFlusher.flush(tab.linkedBrowser);
    return tab;
  };
  // A private tab closed in the private window; a normal tab open and one closed.
  BrowserTestUtils.removeTab(await titled(priv.gBrowser, `${FORM}?closed`, `${MARK}-closed`));
  const normal = await titled(gBrowser, `${PAGE}-ts-open`, "tsnormal-open");
  BrowserTestUtils.removeTab(await titled(gBrowser, `${PAGE}-ts-closed`, "tsnormal-closed"));

  const listed = (win) => {
    const dialog = win.document.getElementById(GOTO_ID);
    const names = [...dialog.querySelectorAll("[role=option]")].map((o) =>
      o.getAttribute("aria-label"),
    );
    return `${dialog.textContent}\n${names.join("\n")}`;
  };

  await SimpleTest.promiseFocus(window);
  await focusPage(window);
  prefix("g");
  await until(() => window.document.getElementById(GOTO_ID)?.open, "tab search in normal");
  const fromNormal = listed(window);
  Assert.stringContains(fromNormal, "tsnormal-open", "sanity: it lists this window's tabs");
  Assert.stringContains(fromNormal, "tsnormal-closed", "and normal closed tabs");
  Assert.ok(!fromNormal.includes(MARK), "no private tab, open or closed");
  Assert.ok(!fromNormal.includes("vimma private page"), "no private title");
  EventUtils.synthesizeKey("KEY_Escape");

  await SimpleTest.promiseFocus(priv);
  await focusPage(priv);
  prefix("g", {}, priv);
  await until(() => priv.document.getElementById(GOTO_ID)?.open, "tab search in private");
  const fromPrivate = listed(priv);
  Assert.stringContains(fromPrivate, `${MARK}-closed`, "the private window lists its closed tab");
  Assert.ok(!fromPrivate.includes("tsnormal"), "and no normal tab, open or closed");
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  BrowserTestUtils.removeTab(normal);
});

add_task(async function a_tab_moves_in_after_y_and_never_out() {
  const [priv] = privateWindows();
  await runCommand("wsmove 1", priv);
  await until(
    () => noticeText(priv) === "a private tab cannot leave the private workspace",
    ":wsmove in private is refused",
  );
  prefix("w", {}, priv);
  await until(() => pickerRows(priv, PICKER_ID).length, "the picker opens in private");
  Assert.deepEqual(pickerRows(priv, PICKER_ID).at(-1)[0], "◆ private", "with the private row");
  EventUtils.synthesizeKey("k", {}, priv); // a normal row
  EventUtils.synthesizeKey("m", {}, priv);
  await until(
    () => noticeText(priv) === "a private tab cannot leave the private workspace",
    "m on a normal row from private is refused",
  );

  await SimpleTest.promiseFocus(window);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}&move`);
  const before = priv.gBrowser.tabs.length;
  prefix("w");
  await until(() => pickerRows(window, PICKER_ID).length, "the workspace picker is open");
  for (let i = 0; i < pickerRows(window, PICKER_ID).length; i++) EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("m");
  await answer(window, "y");
  await until(() => priv.gBrowser.tabs.length === before + 1, "the tab reopens in private");
  await until(
    () => priv.gBrowser.selectedBrowser.currentURI.spec === `${PAGE}&move`,
    "with its URL, selected",
  );
  await until(() => !tab.isConnected, "and leaves the normal window");
});

add_task(async function a_tab_moved_in_with_no_private_window_open_opens_one() {
  // The window OpenBrowserWindow returns still shows about:blank: the move waits for its
  // browser document instead of reaching for a gBrowser that is not there yet.
  for (const w of privateWindows()) await BrowserTestUtils.closeWindow(w);
  await SimpleTest.promiseFocus(window);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}&movefresh`);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("w");
  await until(() => pickerRows(window, PICKER_ID).length, "the workspace picker is open");
  for (let i = 0; i < pickerRows(window, PICKER_ID).length; i++) EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("m");
  await answer(window, "y");
  const priv = await opened;
  await until(
    () => priv.gBrowser.selectedBrowser.currentURI.spec === `${PAGE}&movefresh`,
    "the new private window shows the moved tab",
  );
  Assert.equal(priv.gBrowser.tabs.length, 1, "in place of its start page");
  await until(() => !tab.isConnected, "and the tab leaves the normal window");
});

add_task(async function vimma_ctl_state_withholds_private_urls_and_titles() {
  const [priv] = privateWindows();
  await SimpleTest.promiseFocus(priv);
  const result = VimmaControl._commands.state();
  Assert.equal(result.private, true, "private: true");
  Assert.equal(result.workspace, "private", "workspace: private");
  Assert.ok(result.tabs.length, "the tabs are listed");
  for (const tab of result.tabs) {
    Assert.strictEqual(tab.url, null, "no url");
    Assert.strictEqual(tab.title, null, "no title");
    Assert.equal(typeof tab.id, "string", "ids are kept");
  }
  const v = validateMessage(
    { type: "response", id: 1, ok: true, result },
    { kind: "response", command: "state" },
  );
  Assert.ok(v.valid, `the state follows the protocol: ${v.errors.join("; ")}`);
  await SimpleTest.promiseFocus(window);
  const normal = VimmaControl._commands.state();
  Assert.ok(!("private" in normal) || normal.private === false, "a normal window is not private");
  Assert.ok(
    normal.tabs.every((t) => typeof t.url === "string"),
    "and keeps its urls",
  );
});

// A private tab's url and title are withheld, so `loading` is what tells a script (the e2e
// screenshot of the private start page) that the page has finished loading.
add_task(async function vimma_ctl_state_says_whether_a_private_tab_is_loading() {
  const [priv] = privateWindows();
  await SimpleTest.promiseFocus(priv);
  const tab = BrowserTestUtils.addTab(priv.gBrowser, SLOW);
  priv.gBrowser.selectedTab = tab;
  await until(
    () => tab.hasAttribute("busy") && tab.linkedBrowser.currentURI.spec === SLOW,
    "the slow page is loading",
  );
  const id = String(tab.linkedBrowser.browserId);
  const entry = () => VimmaControl._commands.state().tabs.find((t) => t.id === id);
  Assert.strictEqual(entry().loading, true, "loading: true while the page loads");
  Assert.strictEqual(entry().url, null, "and still no url");
  tab.linkedBrowser.stop();
  await until(() => !tab.hasAttribute("busy"), "the load stopped");
  Assert.strictEqual(entry().loading, false, "loading: false once it stopped");
  const result = VimmaControl._commands.state();
  const v = validateMessage(
    { type: "response", id: 1, ok: true, result },
    { kind: "response", command: "state" },
  );
  Assert.ok(v.valid, `the state follows the protocol: ${v.errors.join("; ")}`);
  BrowserTestUtils.removeTab(tab);
  await SimpleTest.promiseFocus(window);
});

// The flake of #567: vimma-ctl state reports a new private window before the window has even
// started to load its start page (gBrowserInit's delayed startup does that). Its first tab is
// then the initial about:blank, not busy, so `loading` must say it is still to load.
add_task(async function a_new_private_window_is_loading_until_its_start_page_has_loaded() {
  const args = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  args.data = window.BROWSER_NEW_TAB_URL;
  const win = window.OpenBrowserWindow({ private: true, args });
  await BrowserTestUtils.waitForEvent(win, "load");
  Assert.ok(!win.gBrowserInit.delayedStartupFinished, "the start page has not started to load");
  const early = VimmaControl._commands.state();
  Assert.equal(early.private, true, "state reports the new private window");
  Assert.strictEqual(early.tabs[0].loading, true, "loading: true before its first load starts");
  const browser = win.gBrowser.selectedBrowser;
  await until(
    () =>
      browser.currentURI.spec === window.BROWSER_NEW_TAB_URL &&
      !win.gBrowser.selectedTab.hasAttribute("busy") &&
      !browser.webProgress.isLoadingDocument,
    "the start page has loaded",
  );
  Assert.strictEqual(
    VimmaControl._commands.state().tabs[0].loading,
    false,
    "loading: false once the start page has loaded",
  );
  await BrowserTestUtils.closeWindow(win);
  await SimpleTest.promiseFocus(window);
});

add_task(async function nothing_private_reaches_the_normal_profile() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.always_ask_before_handling_new_types", false],
      ["browser.download.useDownloadDir", true],
      ["browser.download.folderList", 2],
      ["browser.download.dir", PathUtils.tempDir],
      ["browser.download.alwaysOpenPanel", false],
    ],
  });
  const [priv] = privateWindows();
  const publicDownloads = (await (await Downloads.getList(Downloads.PUBLIC)).getAll()).length;
  const CONTROL = "vimma-control";

  await SimpleTest.promiseFocus(priv);
  const leakUrl = `${FORM}?${LEAK}`;
  const tab = await BrowserTestUtils.openNewForegroundTab(priv.gBrowser, leakUrl);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], async () => {
    Assert.ok(content.document.cookie.includes("vimmaprivate=1"), "the page set its cookie");
    Assert.equal(content.localStorage.getItem("vimmaprivate"), "1", "and its storage");
  });
  // A form typed into and submitted.
  const submitted = BrowserTestUtils.browserLoaded(browser, false, (url) =>
    url.includes("vimmaprivatefield"),
  );
  await submitForm(browser, SECRET);
  await submitted;
  // A download.
  const privateList = await Downloads.getList(Downloads.PRIVATE);
  const added = new Promise((resolve) => {
    const view = {
      onDownloadAdded(d) {
        privateList.removeView(view);
        resolve(d);
      },
    };
    privateList.addView(view);
  });
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("download").click());
  const download = await added;
  await download.whenSucceeded().catch(() => {});
  // A tab label.
  setTabLabel(tab, LABEL);
  Assert.equal(getTabLabel(tab), LABEL, "the label is set");

  // The control, after the private steps: the same steps in the normal window do reach history
  // and form history. Once they have, writes the private steps made before them would have
  // landed too, so the negatives below can fail.
  await SimpleTest.promiseFocus(window);
  const control = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${FORM}?control`);
  const sent = BrowserTestUtils.browserLoaded(control.linkedBrowser, false, (url) =>
    url.includes("vimmaprivatefield"),
  );
  await submitForm(control.linkedBrowser, CONTROL);
  await sent;
  await TestUtils.waitForCondition(
    () => PlacesUtils.history.hasVisits(submittedUrl(CONTROL)),
    "the normal submission is in history",
  );
  await TestUtils.waitForCondition(
    async () => (await FormHistory.count({ fieldname: "vimmaprivatefield", value: CONTROL })) > 0,
    "the normal form is in form history",
  );

  Assert.ok(!(await PlacesUtils.history.hasVisits(leakUrl)), "the private page is not in history");
  Assert.ok(
    !(await PlacesUtils.history.hasVisits(submittedUrl(SECRET))),
    "nor the private form's submission",
  );
  Assert.equal(
    await FormHistory.count({ fieldname: "vimmaprivatefield", value: SECRET }),
    0,
    "no form history entry for the private form",
  );
  Assert.equal(
    (await (await Downloads.getList(Downloads.PUBLIC)).getAll()).length,
    publicDownloads,
    "the public downloads list is unchanged",
  );
  await SessionSaver.run();
  const saved = await IOUtils.readJSON(SessionFile.Paths.recovery, { decompress: true });
  const normalWindows = [...Services.wm.getEnumerator("navigator:browser")].filter(
    (w) => !w.closed && !PrivateBrowsingUtils.isWindowPrivate(w),
  );
  Assert.equal(
    saved.windows.length,
    normalWindows.length,
    "the session file written by SessionSaver holds the normal windows only",
  );
  namesNothingPrivate(JSON.stringify(saved), "the session file");
  namesNothingPrivate(
    SessionStore.getCustomWindowValue(window, WINDOW_KEY),
    "the normal window's vimma-workspaces value",
    { vimma: true },
  );
  namesNothingPrivate(JSON.stringify(WorkspaceStore.definitions), "the workspace definitions", {
    vimma: true,
  });
  namesNothingPrivate(await definitionsFile(), "vimma-workspaces.json", { vimma: true });
  await IOUtils.remove(download.target.path, { ignoreAbsent: true });

  await FormHistory.update({ op: "remove", fieldname: "vimmaprivatefield" });
  await PlacesUtils.history.remove([`${FORM}?control`, submittedUrl(CONTROL)]);
  // The control page signed in to example.com in the normal workspace: later files count that
  // host's cookies (browser_vimma_workspace_ops.js), so nothing of it may stay.
  await SpecialPowers.spawn(control.linkedBrowser, [], () =>
    content.localStorage.removeItem("vimmaprivate"),
  );
  Services.cookies.remove("example.com", MARK, "/", {
    userContextId: control.userContextId,
  });
  Assert.equal(
    Services.cookies
      .getCookiesFromHost("example.com", { userContextId: control.userContextId })
      .filter((c) => c.name === MARK).length,
    0,
    "the control's cookie is removed",
  );
  BrowserTestUtils.removeTab(control);
  await SpecialPowers.popPrefEnv();
});

add_task(async function about_vimma_and_its_key_log_leave_private_windows_out() {
  const { AboutVimma } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
  );
  const { KeyLog } = ChromeUtils.importESModule("chrome://browser/content/vimma/about/key-log.mjs");
  const { VimmaHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
  );
  const [priv] = privateWindows();
  await SimpleTest.promiseFocus(priv);
  const keys = JSON.stringify(KeyLog.entries());
  const chords = VimmaHost._lastChords.length;
  prefix("?", { shiftKey: true }, priv); // the bindings overlay: a help-mode key
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  Assert.equal(JSON.stringify(KeyLog.entries()), keys, "keys in private are not logged");
  Assert.equal(VimmaHost._lastChords.length, chords, "nor recorded");
  await SimpleTest.promiseFocus(window);
  const data = await AboutVimma.collect(window);
  Assert.equal(
    data.modes.length,
    [...Services.wm.getEnumerator("navigator:browser")].filter(
      (w) => !w.closed && !PrivateBrowsingUtils.isWindowPrivate(w),
    ).length,
    "about:vimma in a normal window lists the normal windows' modes only",
  );
});

add_task(async function closing_discards_the_private_data() {
  const [priv] = privateWindows();
  // A private pop-up (an OAuth sign-in, say) holds the private jar too: closing the private
  // workspace closes it, or the data would survive.
  await SpecialPowers.pushPrefEnv({ set: [["dom.disable_open_during_load", false]] });
  const opened = BrowserTestUtils.waitForNewWindow();
  await SpecialPowers.spawn(priv.gBrowser.selectedBrowser, [PAGE], (url) => {
    content.open(url, "vimma-popup", "popup,width=320,height=240");
  });
  const popup = await opened;
  await SpecialPowers.popPrefEnv();
  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(popup), "the pop-up is private");
  Assert.ok(!popup.toolbar.visible, "and a pop-up");
  const popupClosed = BrowserTestUtils.domWindowClosed(popup);
  Assert.equal(
    Services.cookies.getCookiesFromHost("example.com", { privateBrowsingId: 1 }).length > 0,
    true,
    "the private cookie is there",
  );
  const exited = TestUtils.topicObserved("last-pb-context-exited");
  const closed = BrowserTestUtils.domWindowClosed(priv);
  await SimpleTest.promiseFocus(priv);
  prefix("D", { shiftKey: true }, priv);
  await until(() => promptOpen(priv), "ctrl+b shift+d asks first");
  Assert.ok(
    /^Close the private workspace \(\d+ tabs?\)\? Its history, cookies and site data are discarded\. y\/N$/.test(
      promptText(priv),
    ),
    `it asks to close the private workspace and says what is discarded: ${promptText(priv)}`,
  );
  const tabs = privateWindows().reduce((n, w) => n + w.gBrowser.tabs.length, 0);
  Assert.ok(
    promptText(priv).startsWith(`Close the private workspace (${tabs} tabs)?`),
    "the count includes the pop-up's tab",
  );
  EventUtils.synthesizeKey("y", {}, priv);
  await closed;
  await popupClosed;
  await exited;
  Assert.equal(privateWindows().length, 0, "every private window is closed");
  Assert.equal(
    Services.cookies.getCookiesFromHost("example.com", { privateBrowsingId: 1 }).length,
    0,
    "the private cookie is gone",
  );
  // And its storage: a new private window sees none of it.
  const again = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const fresh = await BrowserTestUtils.openNewForegroundTab(again.gBrowser, PAGE);
  Assert.equal(
    await SpecialPowers.spawn(fresh.linkedBrowser, [], () =>
      content.localStorage.getItem("vimmaprivate"),
    ),
    null,
    "the private localStorage is gone",
  );
  await BrowserTestUtils.closeWindow(again);
  await SimpleTest.promiseFocus(window);
  await runCommand("private close");
  await until(
    () => noticeText(window) === "no private workspace is open",
    ":private close with none open says so",
  );
});

add_task(async function permanent_private_browsing_and_the_policy_refuse() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.privatebrowsing.autostart", true]] });
  const PERMANENT = "every window is private (permanent private browsing)";
  await SimpleTest.promiseFocus(window);
  prefix("P", { shiftKey: true });
  await until(() => noticeText(window) === PERMANENT, "permanent private browsing says so");
  Assert.equal(privateWindows().length, 0, "and opened nothing");
  await runCommand("private close");
  await until(() => noticeText(window) === PERMANENT, ":private close is refused too");

  // Every window is private in that mode: none is "the private workspace" (decision 3), so a
  // private window behaves as before this feature, and closing never closes them all.
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${FORM}?permanent`);
  await SimpleTest.promiseFocus(win);
  Assert.notEqual(segText(win, "workspace"), "◆ private", "no ◆ private in the status bar");
  prefix("D", { shiftKey: true }, win);
  await until(
    () => noticeText(win) === "no workspaces in this window",
    "ctrl+b shift+d says what it said before, and closes nothing",
  );
  Assert.ok(!promptOpen(win), "it asks nothing");
  prefix(")", { shiftKey: true }, win);
  await until(
    () => noticeText(win) === "no workspaces in this window",
    "ctrl+b ) says what it said before",
  );
  await runCommand("wsmove 1", win);
  await until(
    () => noticeText(win) === "no workspaces in this window",
    ":wsmove says what it said before",
  );
  Assert.ok(!win.closed, "the window is still open");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();

  const { EnterprisePolicyTesting } = ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs",
  );
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: { DisablePrivateBrowsing: true },
  });
  try {
    prefix("P", { shiftKey: true });
    await until(
      () => noticeText(window) === "private browsing is turned off by policy",
      "the policy says so",
    );
    Assert.equal(privateWindows().length, 0, "and opened nothing");
  } finally {
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
    Services.prefs.unlockPref("browser.privatebrowsing.autostart");
    Services.prefs.clearUserPref("browser.privatebrowsing.autostart");
  }
});

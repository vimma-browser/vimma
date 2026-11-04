/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-dialogs.md. Firefox's dialogs over a tab or over the window ("Leave
// page?", a page's alert, confirm and prompt) are answered as Vimma's other browser questions
// are: `y` runs the main button, `n` the button Esc runs (the safe choice: "Stay on page"), with
// the permission prompt's guards (armed after security.notification_enable_delay with no key in
// between, never from the dialog's own text fields). A line inside the dialog names the keys
// once they count; a dialog with a text field names Enter and Esc instead.

"use strict";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const LEAVE = ROOT + "file_vimma_leave_page.html";
const PAGE = "https://example.com/";
const DELAY = 400;
const LINE_CLASS = "vimma-prompt-keys";

/** The next commonDialog's window, once Firefox has built it (CommonDialog.onLoad). */
const nextDialog = () => TestUtils.topicObserved("common-dialog-loaded").then(([w]) => w);

/** @param {Window} w  a commonDialog window */
const line = (w) => w.document.querySelector(`.${LINE_CLASS}`);
/** The line says `text` and shows: armed, and visible. */
const lineShows = (w, text) =>
  line(w)?.textContent === text &&
  line(w).hasAttribute("armed") &&
  w.getComputedStyle(line(w)).visibility === "visible";
/** The line is there, keeping its place, but hidden while the keys wait. */
const lineWaits = (w) =>
  !!line(w) &&
  !line(w).hasAttribute("armed") &&
  w.getComputedStyle(line(w)).visibility === "hidden";

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {Window} w */
const gone = (w) => until(() => w.closed || !w.document?.documentElement, "the dialog closed");

/** @param {string} key @param {Window} w */
const press = (key, w) => EventUtils.synthesizeKey(key, {}, w);

/**
 * Closes `tab` as the user would, asking its page first. Firefox asks in a nested event loop
 * (browser-custom-element.mjs, permitUnload), so the close runs on its own turn.
 */
const closeTab = (tab) => setTimeout(() => gBrowser.removeTab(tab), 0);

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.require_user_interaction_for_beforeunload", false],
      // The test profile turns the delay off; the keys' wait is under test.
      ["security.notification_enable_delay", DELAY],
    ],
  });
});

add_task(async function leave_page_n_stays_y_leaves() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LEAVE);
  let shown = nextDialog();
  closeTab(tab);
  let w = await shown;
  Assert.ok(lineWaits(w), "the keys line waits, hidden, while the dialog is not armed");
  await until(() => lineShows(w, "y leave page · n stay on page"), "the line names the keys");

  press("n", w);
  await gone(w);
  await wait(100);
  Assert.ok(tab.isConnected && !tab.closing, "n stays on the page");

  shown = nextDialog();
  closeTab(tab);
  w = await shown;
  press("y", w);
  await wait(50);
  Assert.ok(!w.closed && tab.isConnected, "y before the dialog is armed does not leave");
  // A key typed on through the dialog starts the wait again.
  await wait(DELAY - 150);
  press("j", w);
  await wait(250);
  press("y", w);
  await wait(50);
  Assert.ok(!w.closed && tab.isConnected, "a key typed on through it restarts the wait");
  await until(() => lineShows(w, "y leave page · n stay on page"), "armed again");
  const closed = BrowserTestUtils.waitForEvent(tab, "TabClose");
  press("y", w);
  await closed;
  Assert.ok(true, "y leaves the page");
});

/** A page's confirm(), alert() or prompt() over the selected tab; resolves with its result. */
async function pageDialog(kind) {
  const browser = gBrowser.selectedBrowser;
  const shown = nextDialog();
  const result = SpecialPowers.spawn(browser, [kind], (k) =>
    k === "prompt" ? content.prompt("Name?", "") : content[k](`${k}?`),
  );
  return { w: await shown, result };
}

add_task(async function confirm_and_alert() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);

  let { w, result } = await pageDialog("confirm");
  await until(() => lineShows(w, "y ok · n cancel"), "confirm names y and n");
  press("y", w);
  Assert.equal(await result, true, "y accepts a confirm");

  ({ w, result } = await pageDialog("confirm"));
  await until(() => lineShows(w, "y ok · n cancel"), "armed");
  press("n", w);
  Assert.equal(await result, false, "n cancels a confirm");

  ({ w, result } = await pageDialog("alert"));
  await until(() => lineShows(w, "y ok"), "an alert names only y");
  press("y", w);
  await result;
  Assert.ok(true, "y closes an alert");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function prompt_field_types() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const { w, result } = await pageDialog("prompt");
  await until(() => lineShows(w, "Enter ok · Esc cancel"), "a prompt names Enter and Esc");
  press("y", w);
  press("n", w);
  await wait(50);
  Assert.ok(!w.closed, "y and n type into the field");
  EventUtils.synthesizeKey("KEY_Enter", {}, w);
  Assert.equal(await result, "yn", "the letters went into the field");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function window_dialog() {
  // Firefox's own questions over the window (gDialogBox), such as the caret browsing one.
  for (const [key, expected] of [
    ["n", false],
    ["y", true],
  ]) {
    const shown = nextDialog();
    let answer;
    // Services.prompt.confirm spins a nested event loop until the dialog closes.
    setTimeout(() => (answer = Services.prompt.confirm(window, "Vimma", "Turn it on?")), 0);
    const w = await shown;
    await until(() => lineShows(w, "y ok · n cancel"), "a window dialog names the keys");
    press(key, w);
    await until(() => answer !== undefined, "the dialog answered");
    Assert.equal(answer, expected, `${key} answers the window's dialog`);
  }
});

// The external protocol questions (permissionDialog.xhtml, "Allow this site to open the link
// with ...?", and appChooser.xhtml, the application list) open in the tab's SubDialog as the
// page's dialogs do, and take the same keys: `y` opens the link, `n` cancels.
const SCHEME = "vimmatest";
const HANDLED = "https://example.org/";
const PERMISSION_DIALOG = "chrome://mozapps/content/handling/permissionDialog.xhtml";
const APP_CHOOSER = "chrome://mozapps/content/handling/appChooser.xhtml";

/** A web handler for SCHEME, as a user who picked one has; removed when the test ends. */
function storeHandler({ alwaysAsk }) {
  const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(Ci.nsIHandlerService);
  const info = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
    .getService(Ci.nsIExternalProtocolService)
    .getProtocolHandlerInfo(SCHEME);
  const web = Cc["@mozilla.org/uriloader/web-handler-app;1"].createInstance(Ci.nsIWebHandlerApp);
  web.name = "Vimma test handler";
  web.uriTemplate = HANDLED + "?url=%s";
  info.possibleApplicationHandlers.appendElement(web);
  info.preferredApplicationHandler = web;
  info.preferredAction = Ci.nsIHandlerInfo.useHelperApp;
  info.alwaysAskBeforeHandling = alwaysAsk;
  handlers.store(info);
  registerCleanupFunction(() => handlers.remove(info));
}

/** The next SubDialog of the window that loads `url`, once SubDialog has shown it. */
async function nextSubDialog(url) {
  const e = await BrowserTestUtils.waitForEvent(
    document.documentElement,
    "dialogopen",
    true,
    (ev) => ev.detail.dialog?._openedURL === url,
  );
  return e.detail.dialog._frame.contentWindow;
}

/** The page follows a SCHEME link, as a click on one does. */
function followLink(browser) {
  return SpecialPowers.spawn(browser, [SCHEME], (s) => {
    const a = content.document.createElement("a");
    a.href = `${s}://x`;
    content.document.body.append(a);
    a.click();
  });
}

/** @param {Window} w */
const acceptEnabled = (w) => !w.document.querySelector("dialog").getButton("accept").disabled;

add_task(async function protocol_permission_n_cancels_y_opens() {
  storeHandler({ alwaysAsk: false });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  let shown = nextSubDialog(PERMISSION_DIALOG);
  await followLink(browser);
  let w = await shown;
  Assert.ok(lineWaits(w), "the keys line waits while the question is not armed");
  await until(() => lineShows(w, "y open link · n cancel"), "the line names the keys");
  // The "always allow" checkbox is no text field: the keys answer from it.
  w.document.getElementById("remember").focus();
  press("n", w);
  await gone(w);
  await wait(100);
  Assert.equal(browser.currentURI.spec, PAGE, "n leaves the link unopened");

  shown = nextSubDialog(PERMISSION_DIALOG);
  await followLink(browser);
  w = await shown;
  press("y", w);
  await wait(50);
  Assert.ok(!w.closed && w.document.documentElement, "y before the question is armed waits");
  await until(() => lineShows(w, "y open link · n cancel") && acceptEnabled(w), "armed");
  const opened = BrowserTestUtils.browserLoaded(browser, false, (url) => url.startsWith(HANDLED));
  press("y", w);
  await opened;
  Assert.ok(true, "y opens the link with the handler");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function protocol_app_chooser() {
  storeHandler({ alwaysAsk: true });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  // A site already allowed to open the scheme goes straight to the application list. The
  // page's own principal: a workspace's tab carries its container in it.
  const principal = browser.contentPrincipal;
  const key = `open-protocol-handler^${SCHEME}`;
  Services.perms.addFromPrincipal(principal, key, Services.perms.ALLOW_ACTION);
  registerCleanupFunction(() => Services.perms.removeFromPrincipal(principal, key));

  let shown = nextSubDialog(APP_CHOOSER);
  await followLink(browser);
  let w = await shown;
  await until(() => lineShows(w, "y open link · n cancel"), "the list names the keys");
  press("n", w);
  await gone(w);
  await wait(100);
  Assert.equal(browser.currentURI.spec, PAGE, "n leaves the link unopened");

  shown = nextSubDialog(APP_CHOOSER);
  await followLink(browser);
  w = await shown;
  await until(() => lineShows(w, "y open link · n cancel") && acceptEnabled(w), "armed");
  const opened = BrowserTestUtils.browserLoaded(browser, false, (url) => url.startsWith(HANDLED));
  press("y", w);
  await opened;
  Assert.ok(true, "y opens the link with the chosen application");
  BrowserTestUtils.removeTab(tab);
});

// The download question (unknownContentType.xhtml, "What should Firefox do with this file?") is a
// window of its own, opened over the browser window, and takes the same keys: `y` presses OK
// (open or save, as picked), `n` cancels the download.
const DOWNLOAD_DIALOG = "chrome://mozapps/content/downloads/unknownContentType.xhtml";

/**
 * A download launcher that only records what the question asks of it, so that no file is saved
 * and no application started (the shape uriloader/exthandler's tests mock).
 */
function mockLauncher() {
  const mime = Cc["@mozilla.org/mime;1"]
    .getService(Ci.nsIMIMEService)
    .getFromTypeAndExtension("text/x-vimma-test", null);
  mime.alwaysAskBeforeHandling = true;
  mime.preferredAction = Ci.nsIHandlerInfo.saveToDisk;
  mime.appendExtension("vimmatest");
  registerCleanupFunction(() => {
    const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(
      Ci.nsIHandlerService,
    );
    if (handlers.exists(mime)) handlers.remove(mime);
  });
  const calls = [];
  const launcher = {
    MIMEInfo: mime,
    source: Services.io.newURI("https://example.com/report.vimmatest"),
    suggestedFileName: "report.vimmatest",
    targetFileIsExecutable: false,
    contentLength: 42,
    targetFile: null,
    timeDownloadStarted: Date.now() * 1000,
    cancel: () => calls.push("cancel"),
    promptForSaveDestination: () => calls.push("save"),
    setDownloadToLaunch: () => calls.push("open"),
    launchLocalFile: () => calls.push("open"),
    setWebProgressListener() {},
    saveDestinationAvailable() {},
    QueryInterface: ChromeUtils.generateQI(["nsICancelable", "nsIHelperAppLauncher"]),
  };
  return { launcher, calls };
}

/** Shows the download question for `launcher` over this window; resolves with its window. */
async function downloadDialog(launcher) {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    (w) => w.document.documentURI === DOWNLOAD_DIALOG,
  );
  Cc["@mozilla.org/helperapplauncherdialog;1"]
    .createInstance(Ci.nsIHelperAppLauncherDialog)
    .show(launcher, window, null);
  const w = await opened;
  await SimpleTest.promiseFocus(w);
  return w;
}

add_task(async function download_n_cancels_y_saves() {
  let { launcher, calls } = mockLauncher();
  let w = await downloadDialog(launcher);
  Assert.ok(lineWaits(w), "the keys line waits while the question is not armed");
  await until(() => lineShows(w, "y ok · n cancel"), "the line names the keys");
  let closed = BrowserTestUtils.windowClosed(w);
  press("n", w);
  await closed;
  Assert.deepEqual(calls, ["cancel"], "n cancels the download");

  ({ launcher, calls } = mockLauncher());
  w = await downloadDialog(launcher);
  press("y", w);
  await wait(50);
  Assert.ok(!w.closed && calls.length === 0, "y before the question is armed waits");
  await until(() => lineShows(w, "y ok · n cancel") && acceptEnabled(w), "armed");
  w.document.getElementById("mode").selectedItem = w.document.getElementById("save");
  closed = BrowserTestUtils.windowClosed(w);
  press("y", w);
  await closed;
  await until(() => calls.includes("save"), "the save runs on its own timer");
  Assert.ok(!calls.includes("cancel"), "y saves the file");
});

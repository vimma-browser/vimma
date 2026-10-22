/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/update-notices.md. The check at startup when one is due, the one-time message
// per new version, and the once-per-session question for a security update, against the local
// update host of browser_vimma_update_check.js (file_vimma_update_manifest.sjs) with a test key
// honoured only in automation (vimma.update.testKeys).

"use strict";

/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
// Several tasks wait out the question's quiet time (2.5 s each): the file runs near the
// default 45 s even on a fast machine.
requestLongerTimeout(2);

const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { UpdateUi } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/update-ui.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { base64Encode, signatureComment, signedBytes, spkiKeyId } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/updates.mjs",
);
const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");

const HOST = `${getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
)}file_vimma_update_manifest.sjs`;
const PLAIN = `${getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
)}file_vimma_plain.html`;
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
const TARGET = `${Services.appinfo.OS}_${UpdateUtils.ABI}`;
const CHANNEL = UpdateUtils.UpdateChannel;
const LAST = "vimma.update.last";
const ANNOUNCED = "vimma.update.announced";
const HOUR = 3_600_000;
/** Firefox's arming delay for security dialogs, shortened so the test is quick. */
const ARM_MS = 600;

const dir = PathUtils.join(PathUtils.tempDir, `vimma-update-notices-${Date.now()}`);
let key;
let serial = Number(
  new Date(Date.now() + 6 * 3600 * 1000).toISOString().replace(/\D/g, "").slice(0, 14),
);

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** Lets timers run for `ms`: what a "nothing happens" check waits for. */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: base64Encode(der), id: await spkiKeyId(crypto.subtle, der) };
}

/** A signed manifest offering `version`, urgent or not. */
async function manifest({ version = "9.9.9", urgent = false } = {}) {
  const attrs = {
    type: "minor",
    appVersion: "999.0",
    buildID: "20991231000000",
    displayVersion: version,
    detailsURL: `https://github.com/vimma-browser/vimma/releases/tag/v${version}`,
    vimmaUrgency: urgent ? "security" : "normal",
    ...(urgent ? { vimmaAdvisories: "MFSA 2030-1" } : {}),
  };
  const body =
    '<?xml version="1.0"?>\n' +
    `<updates vimmaChannel="${CHANNEL}" vimmaTarget="${TARGET}" vimmaSerial="${++serial}">\n` +
    `  <update ${Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ")}>\n  </update>\n</updates>\n`;
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, key.pair.privateKey, signedBytes(body)));
  return body + signatureComment([{ key: key.id, sig: base64Encode(sig) }]);
}

async function serve(text) {
  const r = await fetch(`${HOST}?set`, { method: "POST", body: text });
  Assert.equal(r.status, 200, "the test host took the manifest");
}

async function requests() {
  return (await fetch(`${HOST}?log`)).json();
}

/** The saved result of an earlier session, as VimmaUpdates writes it. */
function saved({ okAt = null, checkedAt = okAt, outcome = "current", offer = null } = {}) {
  return JSON.stringify({
    checkedAt,
    okAt,
    outcome,
    reason: null,
    offer,
    serial: null,
    key: null,
    refusals: 0,
  });
}

const notice = () => document.getElementById("vimma-notice");
const noticeShown = () => !!notice()?.matches(":popover-open");
const line = (win = window) => win.document.getElementById("vimma-update-prompt");
const lineShown = (win = window) => !!line(win) && !line(win).hidden;
const lineText = () => line()?.querySelector(".vimma-agent-prompt-text")?.textContent ?? "";
const armed = () => !!line()?.querySelector(".vimma-agent-prompt-hint:not([hidden])");

/** A fresh session: no question asked yet, nothing announced, no saved result. */
function freshSession() {
  UpdateUi._reset();
  VimmaUpdates._reset();
  Services.prefs.clearUserPref(ANNOUNCED);
  notice()?.hidePopover?.();
}

add_task(async function setup() {
  key = await makeKey();
  await IOUtils.makeDirectory(dir);
  await fetch(`${HOST}?reset`);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.update.url", `${HOST}?target=%BUILD_TARGET%&channel=%CHANNEL%`],
      ["vimma.update.testKeys", JSON.stringify([{ id: key.id, slot: "primary", spki: key.spki }])],
      ["vimma.update.installType", "tarball"],
      ["vimma.update.enabled", true],
      ["security.dialog_enable_delay", ARM_MS],
    ],
  });
  freshSession();
  registerCleanupFunction(async () => {
    freshSession();
    Services.prefs.clearUserPref("vimma.update.serial");
    Services.prefs.clearUserPref(LAST);
    await IOUtils.remove(dir, { recursive: true });
  });
});

add_task(async function startup_checks_when_due_and_not_when_fresh() {
  await serve(await manifest({ version: "9.9.8" }));
  // Hide the message this offer brings: this task is about the requests.
  Services.prefs.setStringPref(ANNOUNCED, "9.9.8");
  const now = Date.now();
  const cases = [
    ["checked an hour ago", saved({ okAt: now - HOUR }), 0],
    ["never checked", null, 1],
    ["checked 13 hours ago", saved({ okAt: now - 13 * HOUR }), 1],
    [
      "the last attempt failed and the last success is old",
      saved({ okAt: now - 13 * HOUR, checkedAt: now - 20 * 60_000, outcome: "unreachable" }),
      1,
    ],
    [
      "an attempt failed a minute ago",
      saved({ okAt: now - 13 * HOUR, checkedAt: now - 60_000, outcome: "unreachable" }),
      0,
    ],
    // Saved by a version before `okAt`: its last good check is its checkedAt.
    [
      "an old saved result, checked an hour ago",
      JSON.stringify({ checkedAt: now - HOUR, outcome: "current", refusals: 0 }),
      0,
    ],
  ];
  for (const [what, value, expected] of cases) {
    await fetch(`${HOST}?reset`);
    await serve(await manifest({ version: "9.9.8" }));
    if (value === null) Services.prefs.clearUserPref(LAST);
    else Services.prefs.setStringPref(LAST, value);
    VimmaUpdates._load();
    await VimmaUpdates._startupCheck();
    Assert.equal((await requests()).length, expected, what);
    if (expected) {
      // A check that worked is remembered as the last good one.
      Assert.ok(VimmaUpdates.status().okAt >= now, `${what}: the check counts as good`);
    }
  }
  freshSession();
});

add_task(async function a_new_version_is_announced_once() {
  freshSession();
  await BrowserTestUtils.withNewTab(PLAIN, async () => {
    await serve(await manifest());
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await until(noticeShown, "the message shows");
    Assert.equal(notice().textContent, "Vimma 9.9.9 is available · :update shows the command");
    Assert.equal(Services.prefs.getStringPref(ANNOUNCED, ""), "9.9.9", "remembered");
    Assert.ok(!lineShown(), "an ordinary release asks nothing");
    // It takes no focus: keys still reach the page and the bindings.
    Assert.equal(document.activeElement, gBrowser.selectedBrowser, "focus stays on the page");
    // It stays a few seconds, longer than an ordinary notice, and then goes.
    await pause(2500);
    Assert.ok(noticeShown(), "still shown after 2.5 s");
    await until(() => !noticeShown(), "gone after a few seconds");

    // The same version again, in this session or after a restart: no message.
    await serve(await manifest());
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    VimmaUpdates._load();
    UpdateUi._reset();
    await pause(500);
    Assert.ok(!noticeShown(), "not announced again");

    // A newer version: the message again.
    await serve(await manifest({ version: "9.9.10" }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await until(noticeShown, "the newer version is announced");
    Assert.equal(notice().textContent, "Vimma 9.9.10 is available · :update shows the command");
  });
  freshSession();
});

add_task(async function a_security_update_asks_once_per_session() {
  freshSession();
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    browser.focus();
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await until(noticeShown, "the message shows");
    Assert.equal(
      notice().textContent,
      "Vimma 9.9.9 fixes security issues · :update shows the command",
    );
    await until(lineShown, "the question shows once no key came for a moment");
    Assert.equal(lineText(), "Vimma 9.9.9 fixes security issues. Show the update command? (y/N)");
    Assert.equal(line().getAttribute("role"), "alertdialog");
    Assert.ok(!noticeShown(), "the question replaces the message, which said the same");
    // Drawn as the command line is: just above the status bar, over the page's foot.
    const panel = line().querySelector(".vimma-cmdline-panel").getBoundingClientRect();
    const bar = document.getElementById("vimma-statusbar").getBoundingClientRect();
    Assert.greater(panel.height, 0, "the line has a height");
    Assert.lessOrEqual(Math.abs(panel.bottom - bar.top), 1, "it sits on the status bar");
    Assert.equal(document.activeElement, browser, "the question takes no focus");

    // Keys within the arming delay are ignored, and start the delay again.
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("y");
    Assert.ok(lineShown(), "a y before the delay does not answer");
    Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
    Assert.ok(!armed(), "not armed yet");

    // n dismisses it for the session.
    await until(armed, "armed after the delay");
    EventUtils.synthesizeKey("n");
    await until(() => !lineShown(), "n closes the question");
    Assert.equal(gBrowser.tabs.length, tabs, "n opens nothing");
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await pause(2500);
    Assert.ok(!lineShown(), "not asked again in this session");
  });
  freshSession();
});

add_task(async function y_shows_the_update_steps_and_esc_dismisses() {
  freshSession();
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    browser.focus();
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await until(lineShown, "the question shows");
    await until(armed, "armed");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:vimma#updates", true);
    EventUtils.synthesizeKey("y");
    const tab = await opened;
    Assert.ok(!lineShown(), "answered");
    const steps = tab.linkedBrowser;
    await until(() => steps.contentDocument?.documentElement?.dataset.ready === "true", "drawn");
    Assert.ok(
      steps.contentDocument.getElementById("updates").textContent.includes("Vimma 9.9.9"),
      "the update steps",
    );
    BrowserTestUtils.removeTab(tab);
  });

  // A new session: Esc says no as n does.
  UpdateUi._reset();
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    browser.focus();
    UpdateUi._sync();
    await until(lineShown, "asked again in a new session");
    await until(armed, "armed");
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !lineShown(), "Esc closes it");
    Assert.equal(gBrowser.tabs.length, tabs, "Esc opens nothing");
  });
  freshSession();
});

add_task(async function the_question_waits_while_the_user_types() {
  freshSession();
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      const input = content.document.createElement("input");
      content.document.body.append(input);
      input.focus();
    });
    await until(() => VimmaHostMode() === "insert", "insert mode in the page's field");
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await pause(2500);
    Assert.ok(!lineShown(), "no question while in insert mode");
    EventUtils.sendString("abc");
    const typed = await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.querySelector("input").value,
    );
    Assert.equal(typed, "abc", "the keys went to the field");
    await SpecialPowers.spawn(browser, [], () => content.document.activeElement.blur());
    await until(() => VimmaHostMode() === "normal", "normal mode");
    await until(lineShown, "asked once the user left insert mode");
    // Focus going into a field closes it again: what is typed there is the field's.
    await SpecialPowers.spawn(browser, [], () => content.document.querySelector("input").focus());
    await until(() => !lineShown(), "back to waiting in insert mode");
  });
  freshSession();
});

/** An urgent offer in a fresh session, the question shown in this window; resolves at its show. */
async function askNow(browser) {
  freshSession();
  Services.prefs.setStringPref(ANNOUNCED, "9.9.9");
  browser.focus();
  await serve(await manifest({ urgent: true }));
  Assert.equal((await VimmaUpdates.check()).outcome, "offer");
  await until(lineShown, "the question shows");
  return Date.now();
}

add_task(async function early_and_held_keys_never_answer() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    const shown = await askNow(browser);
    // A key shortly before the delay ends starts it again.
    await pause(Math.max(0, shown + ARM_MS - 250 - Date.now()));
    EventUtils.synthesizeKey("j");
    await pause(Math.max(0, shown + ARM_MS + 150 - Date.now()));
    Assert.ok(!armed(), "an early key started the delay again");
    Assert.ok(lineShown(), "and did not answer");
    await until(armed, "armed after a quiet delay");
    // A key held down from before never answers.
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("y", { repeat: true });
    Assert.ok(lineShown(), "a repeated y does not answer");
    Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
    EventUtils.synthesizeKey("n");
    await until(() => !lineShown(), "n closes it");
  });
  freshSession();
});

add_task(async function another_window_in_front_arms_it_again() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    await askNow(browser);
    await until(armed, "armed");
    const other = await BrowserTestUtils.openNewBrowserWindow();
    await SimpleTest.promiseFocus(other);
    await BrowserTestUtils.closeWindow(other);
    await SimpleTest.promiseFocus(window);
    Assert.ok(!armed(), "coming back to the window arms the line again");
    await until(armed, "armed after the delay");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !lineShown(), "closed");
  });
  freshSession();
});

add_task(async function the_question_waits_for_an_open_overlay() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    freshSession();
    Services.prefs.setStringPref(ANNOUNCED, "9.9.9");
    browser.focus();
    EventUtils.synthesizeKey(":", { shiftKey: true });
    await until(() => VimmaHostMode() === "command", "the command line is open");
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await pause(2500);
    Assert.ok(!lineShown(), "no question over the command line");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => VimmaHostMode() === "normal", "the command line closed");
    await until(lineShown, "asked once it closed");
  });
  freshSession();
});

// Issue #495: copy mode's y is the yank (hint and element mode type letters too); the question
// waits until Esc leaves the mode.
add_task(async function the_question_waits_for_copy_mode() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    freshSession();
    Services.prefs.setStringPref(ANNOUNCED, "9.9.9");
    await SpecialPowers.spawn(browser, [], () => {
      const p = content.document.createElement("p");
      p.textContent = "Text for the caret.";
      content.document.body.prepend(p);
    });
    browser.focus();
    EventUtils.synthesizeKey("v");
    await until(() => VimmaHostMode() === "visual", "copy mode");
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await pause(2500);
    Assert.ok(!lineShown(), "no question over copy mode");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => VimmaHostMode() === "normal", "copy mode ended");
    await until(lineShown, "asked once it ended");
  });
  freshSession();
});

add_task(async function closing_the_window_hands_the_question_on() {
  freshSession();
  // A page in the window left behind, so it is in normal mode when it comes back to the front.
  await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  Services.prefs.setStringPref(ANNOUNCED, "9.9.9");
  const other = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await SimpleTest.promiseFocus(other);
    // A page in front, in normal mode: the new window's empty tab has the address bar focused.
    const tab = await BrowserTestUtils.openNewForegroundTab(other.gBrowser, PLAIN);
    tab.linkedBrowser.focus();
    await serve(await manifest({ urgent: true }));
    Assert.equal((await VimmaUpdates.check()).outcome, "offer");
    await until(() => lineShown(other), "asked in the window in front");
  } finally {
    await BrowserTestUtils.closeWindow(other);
  }
  await SimpleTest.promiseFocus(window);
  gBrowser.selectedBrowser.focus();
  await until(() => VimmaHostMode() === "normal", "normal mode in the window left");
  await until(lineShown, "asked again in the window left");
  EventUtils.synthesizeKey("KEY_Escape");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
  freshSession();
});

add_task(async function a_pref_of_the_wrong_type_breaks_nothing() {
  freshSession();
  // An offer not announced yet, so the next look reads the pref.
  await serve(await manifest({ version: "9.9.11" }));
  Assert.equal((await VimmaUpdates.check()).outcome, "offer");
  // An about:config edit can give the pref another type; getStringPref then throws.
  Services.prefs.setIntPref(ANNOUNCED, 3);
  try {
    UpdateUi._sync();
    Assert.ok(true, "a look with a mistyped pref does not throw");
    // A new window registers with the notices during its setup; its keys must still work.
    const other = await BrowserTestUtils.openNewBrowserWindow();
    try {
      await SimpleTest.promiseFocus(other);
      const { VimmaHost } = ChromeUtils.importESModule(
        "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
      );
      Assert.ok(VimmaHost.status(other), "the new window was set up");
    } finally {
      await BrowserTestUtils.closeWindow(other);
    }
  } finally {
    Services.prefs.clearUserPref(ANNOUNCED);
  }
  await SimpleTest.promiseFocus(window);
  freshSession();
});

add_task(async function no_question_in_a_private_window() {
  freshSession();
  Services.prefs.setStringPref(ANNOUNCED, "9.9.9");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await SimpleTest.promiseFocus(priv);
  await serve(await manifest({ urgent: true }));
  Assert.equal((await VimmaUpdates.check()).outcome, "offer");
  await pause(2500);
  Assert.ok(!lineShown(priv), "no question in the private window");
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  freshSession();
});

add_task(async function nothing_at_all_with_checks_off() {
  freshSession();
  await fetch(`${HOST}?reset`);
  await serve(await manifest({ urgent: true }));
  const file = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(file, "schema = 2\n[updates]\ncheck = false\n");
  await ConfigHost.reload(file);
  await until(() => !VimmaUpdates.status().enabled, "[updates] check = false applied");
  // An urgent offer saved by an earlier session, and a check long overdue.
  Services.prefs.setStringPref(
    LAST,
    saved({
      okAt: Date.now() - 48 * HOUR,
      outcome: "offer",
      offer: {
        appVersion: "999.0",
        buildId: "20991231000000",
        displayVersion: "9.9.9",
        detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v9.9.9",
        urgent: true,
        advisories: [],
        assets: {},
      },
    }),
  );
  VimmaUpdates._load();
  await VimmaUpdates._startupCheck();
  UpdateUi._sync();
  await pause(2500);
  Assert.deepEqual(await requests(), [], "no request at startup");
  Assert.ok(!noticeShown(), "no message");
  Assert.ok(!lineShown(), "no question");
  Assert.equal(Services.prefs.getStringPref(ANNOUNCED, ""), "", "nothing announced");
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
  freshSession();
});

/** The host's mode in this window. */
function VimmaHostMode() {
  const { VimmaHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
  );
  return VimmaHost.status(window).mode;
}

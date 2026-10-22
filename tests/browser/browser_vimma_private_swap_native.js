/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/private-swap-macos.md. On macOS the private workspace takes the normal
// window's place without a window manager: Vimma opens or moves the private window to the
// normal window's frame, shows it and hides the normal window with nsIBaseWindow.visibility.
// Headless, so the backend is forced by a test hook (headless otherwise selects none), and a
// spy records each visibility write, since the getter always returns true.

"use strict";

const { PrivateSwap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/private-swap.mjs",
);
const { NativeSwap, SWAP_FAILED } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/native-swap.mjs",
);
const { AboutVimma } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);

const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const PICKER_ID = "vimma-workspace-picker";
/** The normal window's frame before any switch. */
const FRAME = { x: 40, y: 60, width: 900, height: 700 };

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 25, 200);
}

/** Every open private window. */
function privateWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(
    (w) => !w.closed && PrivateBrowsingUtils.isWindowPrivate(w),
  );
}

/** ctrl+b, then `key` with `mods`, in `win`. */
function prefix(key, mods = {}, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

/** @param {Window} win */
const frameOf = (win) => ({
  x: win.screenX,
  y: win.screenY,
  width: win.outerWidth,
  height: win.outerHeight,
});

/** @param {Window} win */
const hidden = (win) => NativeSwap._windowForTests(win).hidden;

/** @param {Window} win @param {{ x: number, y: number, width: number, height: number }} f */
async function place(win, f) {
  win.moveTo(f.x, f.y);
  win.resizeTo(f.width, f.height);
  await until(
    () => JSON.stringify(frameOf(win)) === JSON.stringify(f),
    `the window is at ${JSON.stringify(f)}`,
  );
}

/** Every visibility write since the reset, as [window, visible]. */
/** @type {{ win: Window, visible: boolean }[]} */
let log = [];

/** @param {Window} win */
const writes = (win) => log.filter((e) => e.win === win).map((e) => e.visible);

async function start({ configured = true } = {}) {
  await teardown();
  log = [];
  NativeSwap._resetForTests({ force: true, log, configured });
  await place(window, FRAME);
}

/** Closes every private window and every extra window, and selects no backend again. */
async function teardown() {
  NativeSwap._resetForTests({ force: true, log: [] });
  for (const w of privateWindows()) await BrowserTestUtils.closeWindow(w);
  NativeSwap._resetForTests();
  await SimpleTest.promiseFocus(window);
}

/** The workspace the test starts in: leaving private by ctrl+b ) can show another one. */
const startWorkspace = WindowWorkspaces.get(window)?.model?.active;

registerCleanupFunction(async () => {
  await teardown();
  if (startWorkspace) WindowWorkspaces.get(window)?.switchTo({ id: startWorkspace });
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

/**
 * Counts focus() calls on `win` while Vimma has it hidden: a hidden window's focus() does
 * nothing on macOS (Research), so the swap must never rely on one.
 * @param {Window} win
 */
function spyHiddenFocus(win) {
  const real = win.focus;
  const spy = { calls: 0, restore: () => (win.focus = real) };
  win.focus = function () {
    if (hidden(win)) spy.calls++;
    return real.call(this);
  };
  return spy;
}

/** ctrl+b shift+p from `from`; the private window, once it is shown in `from`'s place. */
async function enter(from = window) {
  await SimpleTest.promiseFocus(from);
  const opened = privateWindows().length ? null : BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true }, from);
  const priv = opened ? await opened : privateWindows()[0];
  await until(() => hidden(from) && !hidden(priv), "private is shown in the normal window's place");
  return priv;
}

add_task(async function entering_shows_private_at_the_frame_and_every_way_back_swaps_again() {
  await start();
  const spy = spyHiddenFocus(window);
  const before = Object.keys(SessionStore.getWindowState(window).windows[0]).sort();
  const priv = await enter();
  Assert.equal(privateWindows().length, 1, "one private window");
  Assert.deepEqual(frameOf(priv), FRAME, "private has the normal window's position and size");
  Assert.equal(priv.windowState, priv.STATE_NORMAL, "and its size mode");
  Assert.deepEqual(writes(priv), [true], "private was shown");
  Assert.deepEqual(writes(window), [false], "the normal window was hidden");
  Assert.ok(
    log.findIndex((e) => e.win === priv) < log.findIndex((e) => e.win === window),
    "shown before the other is hidden, so nothing behind them shows through",
  );
  Assert.equal(Services.focus.activeWindow, priv, "the private window is active");
  Assert.equal(PrivateSwap._pair, null, "Hyprland's backend has no pair");
  Assert.equal(NativeSwap._pair?.parked, "normal");

  // about:vimma (decision 11): no frame, title or window identifier.
  const data = await AboutVimma.collect(window);
  Assert.equal(data.windowManager, "none needed (macOS), private placement: swap");

  // Back by each route, after moving and resizing the private window each time.
  const routes = [
    ["the toggle", () => prefix("P", { shiftKey: true }, priv)],
    ["ctrl+^", () => prefix("^", { shiftKey: true, code: "Digit6" }, priv)],
    ["ctrl+b )", () => prefix(")", { shiftKey: true }, priv)],
    [
      "the picker",
      async () => {
        prefix("w", {}, priv);
        const rows = () =>
          priv.document.getElementById(PICKER_ID)?.querySelectorAll(".vimma-picker-row");
        await until(() => rows()?.length > 1, "the picker opens in private");
        EventUtils.synthesizeKey("k", {}, priv);
        EventUtils.synthesizeKey("KEY_Enter", {}, priv);
      },
    ],
  ];
  let i = 0;
  for (const [name, press] of routes) {
    const moved = { x: 100 + 10 * i, y: 90 + 10 * i, width: 800 - 20 * i, height: 600 - 20 * i };
    i++;
    await place(priv, moved);
    await SimpleTest.promiseFocus(priv);
    log.length = 0;
    await press();
    await until(() => hidden(priv) && !hidden(window), `${name}: normal is back in place`);
    Assert.deepEqual(frameOf(window), moved, `${name}: at the private window's new frame`);
    Assert.deepEqual(
      log.map((e) => [e.win === window ? "normal" : "private", e.visible]),
      [
        ["normal", true],
        ["private", false],
      ],
      `${name}: normal shown, then private hidden`,
    );
    Assert.equal(Services.focus.activeWindow, window, `${name}: the normal window is active`);
    const again = await enter();
    Assert.equal(again, priv, `${name}: going there again shows the same private window`);
    Assert.deepEqual(frameOf(priv), moved, `${name}: private takes the frame back`);
  }
  Assert.equal(spy.calls, 0, "no focus() on a hidden window");
  spy.restore();
  const after = Object.keys(SessionStore.getWindowState(window).windows[0]).sort();
  Assert.deepEqual(after, before, "SessionStore saves no new field for the normal window");
});

add_task(async function a_zoomed_window_hands_its_zoom_on() {
  await start();
  window.maximize();
  await until(() => window.windowState === window.STATE_MAXIMIZED, "the normal window is zoomed");
  const priv = await enter();
  await until(() => priv.windowState === priv.STATE_MAXIMIZED, "private is zoomed too");
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => hidden(priv) && !hidden(window), "back");
  Assert.equal(window.windowState, window.STATE_MAXIMIZED, "the normal window is zoomed again");
  window.restore();
  await until(() => window.windowState === window.STATE_NORMAL, "un-zoomed");
});

add_task(async function closing_the_private_window_any_way_brings_normal_back_first() {
  for (const how of ["ctrl+shift+w", "close()", "ctrl+b shift+d"]) {
    await start();
    const priv = await enter();
    const slot = { x: 70, y: 80, width: 850, height: 650 };
    await place(priv, slot);
    let shownAtUnload = null;
    // Added after Vimma's own unload listener, so it runs after it, while the window unloads.
    const unloaded = new Promise((resolve) =>
      priv.addEventListener("unload", () => resolve((shownAtUnload = !hidden(window))), {
        once: true,
      }),
    );
    if (how === "close()") priv.close();
    else if (how === "ctrl+shift+w") {
      await SimpleTest.promiseFocus(priv);
      // close_window, on every platform (defaults.mjs).
      EventUtils.synthesizeKey("W", { ctrlKey: true, shiftKey: true }, priv);
    } else {
      await SimpleTest.promiseFocus(priv);
      prefix("D", { shiftKey: true }, priv);
      await until(() => priv.document.getElementById(PROMPT_ID)?.hidden === false, "y/N");
      EventUtils.synthesizeKey("y", {}, priv);
    }
    await unloaded;
    Assert.strictEqual(shownAtUnload, true, `${how}: normal was shown before private unloaded`);
    Assert.ok(!hidden(window), `${how}: the normal window is shown`);
    Assert.deepEqual(frameOf(window), slot, `${how}: at the private window's frame`);
    Assert.equal(NativeSwap._pair, null, `${how}: the pair is forgotten`);
  }
});

add_task(async function a_link_from_another_app_brings_the_hidden_window_back() {
  await start();
  const priv = await enter();
  const tabs = gBrowser.tabs.length;
  // As BrowserContentHandler hands an external URL to the most recent normal window.
  window.browserDOMWindow.openURI(
    Services.io.newURI("https://example.com/?external"),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    Services.scriptSecurityManager.getSystemPrincipal(),
  );
  Assert.equal(gBrowser.tabs.length, tabs + 1, "the tab opened in the normal window");
  Assert.ok(!hidden(window), "the normal window is shown in place at once");
  Assert.ok(hidden(priv), "and private is hidden");
  Assert.deepEqual(frameOf(window), FRAME);
  Assert.equal(NativeSwap._pair?.parked, "private", "private waits, one key away");
  gBrowser.removeTab(gBrowser.tabs.at(-1));
});

add_task(async function the_hidden_window_activated_swaps_back() {
  await start();
  const priv = await enter();
  // As when the user picks it in the Window menu or the Dock menu.
  window.dispatchEvent(new window.Event("activate"));
  Assert.ok(!hidden(window), "the normal window is shown");
  Assert.ok(hidden(priv), "private is hidden");
  Assert.equal(NativeSwap._pair?.parked, "private");
});

add_task(async function entering_from_a_second_normal_window_shows_the_first_again() {
  await start();
  const second = await BrowserTestUtils.openNewBrowserWindow();
  const priv = await enter();
  const other = { x: 300, y: 200, width: 700, height: 500 };
  await place(second, other);
  log.length = 0;
  await enter(second);
  const who = (/** @type {Window} */ w) =>
    w === window ? "first" : w === second ? "second" : "private";
  Assert.deepEqual(
    log.map((e) => [who(e.win), e.visible]),
    [
      ["first", true],
      ["private", false],
      ["private", true],
      ["second", false],
    ],
    "the first comes back, then private takes the second one's place",
  );
  Assert.ok(!hidden(window), "the first normal window is shown");
  Assert.deepEqual(frameOf(priv), other, "private is at the second window's frame");
  await BrowserTestUtils.closeWindow(second);
  Assert.ok(!hidden(priv), "closing the hidden window leaves private shown");
});

add_task(async function a_failed_swap_shows_both_windows_and_says_so_once() {
  await start();
  const priv = await enter();
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => hidden(priv), "private is hidden");
  priv.moveTo = () => {
    throw new Error("a broken window");
  };
  // console.warn from a module goes to the console API storage, not nsIConsoleService.
  const lines = [];
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
  const onLog = (m) => lines.push((m.arguments ?? []).map(String).join(" "));
  storage.addLogEventListener(onLog, Services.scriptSecurityManager.getSystemPrincipal());
  await SimpleTest.promiseFocus(window);
  prefix("P", { shiftKey: true });
  await until(() => !hidden(priv), "private is shown again");
  Assert.ok(!hidden(window), "the normal window is never left hidden");
  Assert.equal(NativeSwap._pair, null, "the pair is forgotten");
  await until(
    () => priv.document.getElementById(NOTICE_ID)?.textContent.includes(SWAP_FAILED),
    "the notice says so",
  );
  // Window placement until the next config reload: no more visibility writes.
  delete priv.moveTo;
  const count = log.length;
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back as a window");
  await SimpleTest.promiseFocus(window);
  prefix("P", { shiftKey: true });
  await until(() => Services.focus.activeWindow === priv, "and there as a window");
  Assert.equal(log.length, count, "no further swap");
  Assert.equal(
    (await AboutVimma.collect(window)).windowManager,
    "none needed (macOS), private placement: window (swap failed)",
  );
  storage.removeLogEventListener(onLog);
  Assert.equal(
    lines.filter((l) => l.includes(`vimma: ${SWAP_FAILED}`)).length,
    1,
    "the console says it once",
  );
});

add_task(async function placement_window_hides_nothing() {
  await start();
  PrivateSwap.configure("window");
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => Services.focus.activeWindow === priv, "private is focused as a window");
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back as a window");
  Assert.deepEqual(log, [], "no visibility write at all");
  Assert.equal(
    (await AboutVimma.collect(window)).windowManager,
    "none needed (macOS), private placement: window (config)",
  );
  PrivateSwap.configure("swap");
});

add_task(async function nothing_is_written_to_the_profile() {
  await start();
  const names = () => {
    const out = [];
    for (const f of Services.dirsvc.get("ProfD", Ci.nsIFile).directoryEntries) {
      out.push(f.leafName);
    }
    return out.sort();
  };
  const before = names();
  const priv = await enter();
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => hidden(priv), "back");
  Assert.deepEqual(names(), before, "the profile directory has no new file");
});

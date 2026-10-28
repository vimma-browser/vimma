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

/**
 * The fields SessionStore keeps for the normal window. `zIndex` is SessionStore's own z-order,
 * added whenever it collects every window's state (a periodic save, SessionStore.sys.mjs), so it
 * comes and goes with timing and is not compared.
 */
const stateKeys = () =>
  Object.keys(SessionStore.getWindowState(window).windows[0])
    .filter((k) => k !== "zIndex")
    .sort();

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
/**
 * The frame the test starts at, and the persisted frame attributes it overwrites: the tests that
 * run after it lay out the bar at the window's own width (browser_vimma_statusbar.js).
 */
const startFrame = frameOf(window);
const FRAME_ATTRS = ["screenX", "screenY", "width", "height"];
const startAttrs = FRAME_ATTRS.map((a) => document.documentElement.getAttribute(a));

registerCleanupFunction(async () => {
  await teardown();
  if (startWorkspace) WindowWorkspaces.get(window)?.switchTo({ id: startWorkspace });
  if (window.windowState !== window.STATE_NORMAL) window.restore();
  await place(window, startFrame);
  FRAME_ATTRS.forEach((a, i) => {
    const v = startAttrs[i];
    if (v === null) document.documentElement.removeAttribute(a);
    else document.documentElement.setAttribute(a, v);
  });
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
  const before = stateKeys();
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
  const after = stateKeys();
  Assert.deepEqual(after, before, "SessionStore saves no new field for the normal window");
});

add_task(async function a_zoomed_window_hands_its_zoom_and_its_restored_frame_on() {
  await start();
  // What AppWindow persists for the un-zoomed frame: position, and the inner size.
  const root = document.documentElement;
  root.setAttribute("screenX", `${FRAME.x}`);
  root.setAttribute("screenY", `${FRAME.y}`);
  root.setAttribute("width", `${FRAME.width - (window.outerWidth - window.innerWidth)}`);
  root.setAttribute("height", `${FRAME.height - (window.outerHeight - window.innerHeight)}`);
  window.maximize();
  await until(() => window.windowState === window.STATE_MAXIMIZED, "the normal window is zoomed");
  Assert.notDeepEqual(frameOf(window), FRAME, "zoomed, the frame differs from the restored one");
  const priv = await enter();
  await until(() => priv.windowState === priv.STATE_MAXIMIZED, "private is zoomed too");
  priv.restore();
  await until(() => priv.windowState === priv.STATE_NORMAL, "private un-zoomed");
  await until(
    () => JSON.stringify(frameOf(priv)) === JSON.stringify(FRAME),
    "un-zoomed, private goes to the normal window's restored frame",
  );
  priv.maximize();
  await until(() => priv.windowState === priv.STATE_MAXIMIZED, "private zoomed again");
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
  // Past JSONFile's 1.5 s save delay: a write an earlier test scheduled (the workspace store
  // and its .bak) lands before the listing, not during the swap.
  await new Promise((r) => setTimeout(r, 2000));
  const before = names();
  const priv = await enter();
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => hidden(priv), "back");
  // And past it again: a write the swap itself scheduled would land by now.
  await new Promise((r) => setTimeout(r, 2000));
  Assert.deepEqual(names(), before, "the profile directory has no new file");
});

/** From the private window back to the normal one, by the toggle. */
async function leave(priv) {
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => hidden(priv) && !hidden(window), "back to the normal window");
}

/** Two turns of the event loop: past every swap's frame check. */
async function turns() {
  for (let i = 0; i < 2; i++) await new Promise((r) => Services.tm.dispatchToMainThread(r));
}

/** @param {Window} win */
const notice = (win) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";

add_task(async function placement_window_from_a_reload_shows_a_hidden_private_window() {
  await start();
  const priv = await enter();
  await leave(priv);
  // A config reload to "window" while the private window is hidden.
  PrivateSwap.configure("window");
  Assert.ok(!hidden(priv), "the hidden private window is shown again");
  Assert.equal(NativeSwap._pair, null, "and the pair is forgotten");
  Assert.ok(!hidden(window), "the normal window stays shown");
  // Shown, the private window is raised: it must not come to the front by itself.
  await turns();
  Assert.equal(Services.focus.activeWindow, window, "the normal window stays in front");
  prefix("P", { shiftKey: true });
  await until(() => Services.focus.activeWindow === priv, "the private workspace is there");
  Assert.equal(privateWindows().length, 1, "the same private window, no new one");
  PrivateSwap.configure("swap");
});

add_task(async function a_pop_up_never_swaps_or_hides() {
  await start();
  const priv = await enter();
  await leave(priv);
  // A normal pop-up, as a page's window.open(…, "popup") makes one: a browser window without
  // its toolbar.
  const opened = BrowserTestUtils.waitForNewWindow();
  const url = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  url.data = "about:blank";
  Services.ww.openWindow(
    window,
    "chrome://browser/content/browser.xhtml",
    "_blank",
    "chrome,dialog=no,toolbar=no,width=320,height=240",
    url,
  );
  const popup = await opened;
  Assert.ok(!popup.toolbar.visible, "a pop-up");
  Assert.equal(
    PrivateSwap.openFeatures(popup),
    null,
    "a new private window takes no pop-up's place",
  );
  Assert.notEqual(PrivateSwap.openFeatures(window), null, "but a normal window's");
  log.length = 0;
  await SimpleTest.promiseFocus(popup);
  prefix("P", { shiftKey: true }, popup);
  await until(() => !hidden(priv), "the private workspace is shown, as a window");
  Assert.deepEqual(writes(popup), [], "the pop-up is never hidden");
  Assert.ok(!hidden(window), "nor is the normal window");
  Assert.equal(NativeSwap._pair, null, "no pair with a pop-up");
  await BrowserTestUtils.closeWindow(popup);
});

add_task(async function the_slot_is_the_last_swaps_frame() {
  await start();
  const second = await BrowserTestUtils.openNewBrowserWindow();
  const priv = await enter();
  const other = { x: 300, y: 200, width: 700, height: 500 };
  await place(second, other);
  await enter(second);
  await turns();
  // The next swap breaks half way: the hidden window comes back at the slot's frame.
  const real = second.resizeTo;
  second.resizeTo = function () {
    second.resizeTo = real;
    throw new Error("a broken window");
  };
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => !hidden(second), "the second window is shown");
  Assert.deepEqual(frameOf(second), other, "at the private window's frame, the slot's");
  await BrowserTestUtils.closeWindow(second);
});

add_task(async function a_frame_that_does_not_apply_fails_the_swap() {
  await start();
  const priv = await enter();
  await leave(priv);
  await place(window, { x: 150, y: 110, width: 760, height: 560 });
  // The private window ignores the size it is given: decision 9's check catches it.
  priv.resizeTo = () => {};
  await SimpleTest.promiseFocus(window);
  prefix("P", { shiftKey: true });
  await until(() => !hidden(window) && !hidden(priv), "both windows are shown");
  await until(() => notice(priv).includes(SWAP_FAILED), "the notice says so");
  Assert.equal(NativeSwap._pair, null, "the pair is forgotten");
  delete priv.resizeTo;
});

add_task(async function a_fullscreen_window_is_never_hidden() {
  await start();
  window.fullScreen = true;
  await until(() => window.windowState === window.STATE_FULLSCREEN, "the normal window is full");
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => priv.fullScreen, "private gets a full screen of its own");
  await turns();
  Assert.deepEqual(log, [], "nothing is hidden or shown");
  Assert.equal(NativeSwap._pair, null, "no pair");
  Assert.ok(!notice(priv).includes(SWAP_FAILED), "not a failure");
  Assert.equal(NativeSwap.status, "none needed (macOS), private placement: swap", "swap stays on");
  priv.fullScreen = false;
  await BrowserTestUtils.closeWindow(priv);
  window.fullScreen = false;
  await until(() => window.windowState !== window.STATE_FULLSCREEN, "the normal window leaves");
});

add_task(async function going_back_before_a_new_window_starts_up_hides_nothing() {
  await start();
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  // Back before the new window's delayed startup: its enter must not hide anything later.
  PrivateSwap.show(window);
  const priv = await opened;
  await until(() => priv.gBrowserInit?.delayedStartupFinished, "the window started up");
  await turns();
  Assert.deepEqual(writes(window), [], "the normal window is never hidden");
  Assert.equal(NativeSwap._pair, null, "no pair");
});

add_task(async function activations_and_new_tabs_during_a_swap_are_its_own() {
  await start();
  // As if macOS activated, or a tab opened in, a window in the middle of the swap that hid it.
  log.push = function (/** @type {{ win: Window, visible: boolean }} */ e) {
    const n = Array.prototype.push.call(this, e);
    if (!e.visible) {
      e.win.dispatchEvent(new e.win.Event("activate"));
      e.win.dispatchEvent(new e.win.Event("TabOpen", { bubbles: true }));
    }
    return n;
  };
  const priv = await enter();
  await turns();
  Assert.ok(hidden(window), "entering: the normal window stays hidden");
  await leave(priv);
  await turns();
  Assert.ok(hidden(priv), "leaving: the private window stays hidden");
  delete log.push;
});

add_task(async function nothing_swaps_while_vimma_quits() {
  let quitting = false;
  await start();
  NativeSwap._resetForTests({ force: true, log, shuttingDown: () => quitting });
  const priv = await enter();
  quitting = true;
  const count = log.length;
  const unloaded = new Promise((r) => priv.addEventListener("unload", r, { once: true }));
  priv.close();
  await unloaded;
  Assert.equal(log.length, count, "no visibility write at shutdown");
  quitting = false;
});

add_task(async function before_the_config_is_read_nothing_is_hidden() {
  await start({ configured: false });
  Assert.equal(
    (await AboutVimma.collect(window)).windowManager,
    "none needed (macOS), private placement: window (config not read yet)",
  );
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => Services.focus.activeWindow === priv, "shown as a window");
  await turns();
  Assert.deepEqual(log, [], "no visibility write");
});

add_task(async function every_public_member_is_routed_by_the_backend_switch() {
  // PrivateSwap inherits Hyprland's test hooks; a public member it does not route would reach
  // macOS through the prototype unnoticed.
  const hypr = Object.getPrototypeOf(PrivateSwap);
  const unrouted = Object.keys(Object.getOwnPropertyDescriptors(hypr)).filter(
    (k) => !k.startsWith("_") && !Object.hasOwn(PrivateSwap, k),
  );
  Assert.deepEqual(unrouted, [], "every public member of HyprSwap is routed");
});

add_task(async function a_reload_while_a_new_window_starts_up_hides_nothing() {
  await start();
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  // config.toml set to "window" before the new private window's delayed startup.
  PrivateSwap.configure("window");
  const priv = await opened;
  await until(() => priv.gBrowserInit?.delayedStartupFinished, "the window started up");
  await turns();
  Assert.deepEqual(writes(window), [], "the normal window is never hidden");
  Assert.equal(NativeSwap._pair, null, "no pair");
  PrivateSwap.configure("swap");
});

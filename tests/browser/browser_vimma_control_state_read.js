/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The control socket's `state` is a read (docs/security/01-control-socket.md S9): it changes
// no mode, a resize mode with no panes left included. Resize mode ends where the panes go
// (browser_vimma_pane_swap_resize.js), never on a read.

"use strict";

/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl, ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(ENABLED_PREF);
  await VimmaControl.settled();
});

add_task(async function state_leaves_a_stale_resize_mode_as_it_found_it() {
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  await VimmaControl.settled();
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  Assert.equal((await c.handshake({ protocol: 1 }))?.type, "welcome", "a full connection");
  Assert.ok(!PaneViews.get(window)?.panes, "one pane");

  const state = /** @type {{ resize: boolean }} */ (VimmaHost._state(window));
  // What a missed reset would leave: the flag on with no panes to resize.
  state.resize = true;
  try {
    const first = await c.call("state");
    Assert.ok(first?.ok, "state answers");
    Assert.notEqual(first.result.mode, "resize", "no resize mode is reported without panes");
    Assert.strictEqual(state.resize, true, "state left the resize flag as it found it");
    const second = await c.call("state");
    Assert.deepEqual(second.result, first.result, "a second read says the same");
    Assert.strictEqual(state.resize, true, "and still left the flag alone");
  } finally {
    state.resize = false;
    c.close();
  }
});

// docs/specs/tab-sleep.md, behaviour 15 and decision 18: a sleeping tab is listed asleep, read
// without loading it.
add_task(async function state_lists_asleep_true_for_a_sleeping_tab_and_does_not_load_it() {
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  await VimmaControl.settled();
  const url = "https://example.com/?asleep";
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await TestUtils.waitForCondition(() => !tab.hasAttribute("busy"), "the tab is done loading");
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  try {
    Assert.equal((await c.handshake({ protocol: 1 }))?.type, "welcome", "a full connection");
    /** @returns {Promise<{ url: string | null, asleep?: boolean }[]>} */
    const tabs = async () => (await c.call("state")).result.tabs;
    const awake = (await tabs()).find((t) => t.url === url);
    Assert.ok(awake, "the tab is listed");
    Assert.ok(!("asleep" in /** @type {object} */ (awake)), "an awake tab has no asleep field");

    await gBrowser.prepareDiscardBrowser(tab);
    Assert.ok(gBrowser.discardBrowser(tab, false), "Firefox discards the tab");
    const listed = await tabs();
    const sleeping = listed.find((t) => t.url === url);
    Assert.strictEqual(sleeping?.asleep, true, "the sleeping tab is listed asleep: true");
    Assert.ok(
      listed.filter((t) => t !== sleeping).every((t) => !("asleep" in t)),
      "no other tab is",
    );
    Assert.ok(!tab.linkedPanel, "reading state left the tab asleep");
  } finally {
    c.close();
    gBrowser.removeTab(tab);
  }
});

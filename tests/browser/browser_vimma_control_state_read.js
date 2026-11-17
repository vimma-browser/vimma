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

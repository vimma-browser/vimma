/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/wake-lock.md

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const { WakeLock: VimmaWakeLock } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/WakeLock.sys.mjs",
);

/**
 * A stand-in for nsIEnvironment, so the cases below never touch the real process environment.
 *
 * @param {Record<string, string | undefined>} vars
 */
function fakeEnv(vars = {}) {
  return {
    vars,
    /** @param {string} name */
    get(name) {
      return this.vars[name] ?? "";
    },
    /**
     * @param {string} name
     * @param {string} value
     */
    set(name, value) {
      this.vars[name] = value;
    },
  };
}

add_task(async function test_startup_asks_for_the_wayland_idle_inhibitor_on_linux() {
  if (AppConstants.platform !== "linux") {
    Assert.ok(true, "only Linux reads MOZ_WAKE_LOCK_TYPE");
    return;
  }
  Assert.equal(
    Services.env.get("MOZ_WAKE_LOCK_TYPE"),
    "WaylandIdleInhibit",
    "the window's startup set the wake lock type before any video played",
  );
});

add_task(async function test_linux_without_a_choice_gets_the_wayland_idle_inhibitor() {
  const env = fakeEnv();
  VimmaWakeLock.init({ platform: "linux", env });
  Assert.equal(env.vars.MOZ_WAKE_LOCK_TYPE, "WaylandIdleInhibit");
});

add_task(async function test_a_users_own_choice_wins() {
  const env = fakeEnv({ MOZ_WAKE_LOCK_TYPE: "FreeDesktopPortal" });
  VimmaWakeLock.init({ platform: "linux", env });
  Assert.equal(env.vars.MOZ_WAKE_LOCK_TYPE, "FreeDesktopPortal");
});

add_task(async function test_other_platforms_are_left_alone() {
  for (const platform of ["macosx", "win"]) {
    const env = fakeEnv();
    VimmaWakeLock.init({ platform, env });
    Assert.equal(env.vars.MOZ_WAKE_LOCK_TYPE, undefined, platform);
  }
});

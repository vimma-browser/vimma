/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// #855: Firefox's GNOME shell service takes MOZ_APP_LAUNCHER as the browser's own command when it
// first starts. Pointed at the vimma-open next to the binary, Settings' Make Default sets the
// package's desktop entry (whose Exec is that path) and counts it as the default; without it,
// Make Default writes a userapp- entry for the binary that skips vimma-open.

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const { AppLauncher } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/AppLauncher.sys.mjs",
);

const DIR = "/usr/lib/vimma";
const OWN = "/usr/lib/vimma/vimma-open";

/**
 * A stand-in for nsIEnvironment that keeps every value set, in order.
 *
 * @param {Record<string, string>} vars
 */
function fakeEnv(vars = {}) {
  return {
    vars,
    /** @type {string[]} */
    log: [],
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
      this.log.push(`${name}=${value}`);
    },
  };
}

/**
 * Runs init with a fake environment and records what the shell service would have read.
 *
 * @param {{ vars?: Record<string, string>, platform?: string, exists?: boolean, marker?: string, running?: boolean }} options
 */
function run({ vars = {}, platform = "linux", exists = true, marker = "", running = false } = {}) {
  const env = fakeEnv({ ...vars });
  /** @type {string[]} */
  const seen = [];
  const started = AppLauncher.init({
    platform,
    env,
    exeDir: DIR,
    exists: (/** @type {string} */ path) => exists && path === OWN,
    marker,
    running: () => running,
    startShellService: () => seen.push(env.get("MOZ_APP_LAUNCHER")),
  });
  return { env, seen, started };
}

add_task(async function test_the_shell_service_starts_with_the_launcher_next_to_the_binary() {
  const { env, seen, started } = run({ marker: "vimma-package=deb\n" });
  Assert.deepEqual(seen, [OWN], "the shell service read vimma-open's path when it started");
  Assert.equal(
    env.get("MOZ_APP_LAUNCHER"),
    "",
    "then emptied, so no program Vimma starts inherits it",
  );
  Assert.ok(started);
});

add_task(async function test_a_value_equal_to_its_own_launcher_is_read_once_and_emptied() {
  const { env, seen } = run({ vars: { MOZ_APP_LAUNCHER: OWN } });
  Assert.deepEqual(seen, [OWN]);
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), "");
});

add_task(async function test_an_inherited_value_never_picks_another_program() {
  const { env, seen } = run({ vars: { MOZ_APP_LAUNCHER: "/home/u/.local/bin/not-vimma" } });
  Assert.deepEqual(seen, [OWN], "the package's own launcher, whatever the caller exported");
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), "");
});

add_task(async function test_an_inherited_appdir_never_keeps_another_program() {
  // APPDIR comes from the caller; only the package's own marker makes an install an AppImage.
  const { env, seen } = run({
    vars: { MOZ_APP_LAUNCHER: "/home/u/.local/bin/not-vimma", APPDIR: "/usr", APPIMAGE: "/x" },
  });
  Assert.deepEqual(seen, [OWN]);
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), "");
});

add_task(async function test_an_appimage_keeps_apprun_s_value() {
  const appimage = "/home/u/Apps/Vimma-1.0.0-x86_64.AppImage";
  const { env, seen, started } = run({
    vars: { MOZ_APP_LAUNCHER: appimage },
    marker: "vimma-package=appimage\n",
  });
  Assert.deepEqual(seen, [], "left to the shell service's own start");
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), appimage);
  Assert.deepEqual(env.log, []);
  Assert.ok(!started);
});

add_task(async function test_a_shell_service_already_running_is_reported_and_the_value_emptied() {
  const { env, seen, started } = run({
    vars: { MOZ_APP_LAUNCHER: "/home/u/.local/bin/not-vimma" },
    running: true,
  });
  Assert.deepEqual(seen, [], "too late to name the launcher: nothing pretends otherwise");
  Assert.ok(!started);
  Assert.deepEqual(env.log, ["MOZ_APP_LAUNCHER="], "still emptied for the programs Vimma starts");
});

add_task(async function test_without_vimma_open_nothing_changes() {
  // The tarball and a build from source have no vimma-open next to the binary.
  const { env, seen } = run({ exists: false });
  Assert.deepEqual(seen, []);
  Assert.deepEqual(env.log, []);
  const user = run({ exists: false, vars: { MOZ_APP_LAUNCHER: "/opt/x/launch" } });
  Assert.deepEqual(user.env.log, [], "a launcher a tarball user exported stays theirs");
});

add_task(async function test_other_platforms_are_left_alone() {
  for (const platform of ["macosx", "win"]) {
    const { env, seen } = run({ platform });
    Assert.deepEqual(seen, [], platform);
    Assert.deepEqual(env.log, [], platform);
  }
});

add_task(async function test_startup_named_the_launcher_before_anything_else_started_the_service() {
  if (AppConstants.platform !== "linux") {
    Assert.ok(true, "only Linux reads MOZ_APP_LAUNCHER");
    return;
  }
  const own = PathUtils.join(
    PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path),
    "vimma-open",
  );
  if (await IOUtils.exists(own)) {
    Assert.ok(AppLauncher.init(), "the window's startup came first and named vimma-open");
    Assert.equal(Services.env.get("MOZ_APP_LAUNCHER"), "", "read at startup, then emptied");
  } else {
    Assert.ok(!AppLauncher.init(), "a build without vimma-open names no launcher");
    Assert.notEqual(Services.env.get("MOZ_APP_LAUNCHER"), own);
  }
});

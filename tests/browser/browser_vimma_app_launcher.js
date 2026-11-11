/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// #855: Firefox's GNOME shell service takes MOZ_APP_LAUNCHER as the browser's own command when it
// first starts. Pointed at the vimma-open next to the binary, Settings' Make Default sets the
// package's desktop entry (whose Exec is that path) and counts it as the default; without it,
// Make Default writes a userapp- entry for the binary that skips vimma-open.

"use strict";

/* global Cm -- the component manager, a global of the browser-chrome harness */

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
 * @param {{ vars?: Record<string, string>, platform?: string, exists?: boolean, exeDir?: string, appDir?: string }} options
 */
function run({ vars = {}, platform = "linux", exists = true, exeDir = DIR, appDir = "" } = {}) {
  const env = fakeEnv({ ...vars });
  /** @type {string[]} */
  const seen = [];
  AppLauncher.init({
    platform,
    env,
    exeDir,
    exists: (/** @type {string} */ path) => exists && path === `${exeDir}/vimma-open`,
    appDir,
    startShellService: () => seen.push(env.get("MOZ_APP_LAUNCHER")),
  });
  return { env, seen };
}

add_task(async function test_the_shell_service_starts_with_the_launcher_next_to_the_binary() {
  const { env, seen } = run();
  Assert.deepEqual(seen, [OWN], "the shell service read vimma-open's path when it started");
  Assert.equal(
    env.get("MOZ_APP_LAUNCHER"),
    "",
    "then cleared, so no program Vimma starts inherits it",
  );
});

add_task(async function test_a_value_from_the_launcher_is_read_once_and_cleared() {
  const { env, seen } = run({ vars: { MOZ_APP_LAUNCHER: OWN } });
  Assert.deepEqual(seen, [OWN]);
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), "");
});

add_task(async function test_an_inherited_value_never_picks_another_program() {
  const { env, seen } = run({ vars: { MOZ_APP_LAUNCHER: "/home/u/.local/bin/not-vimma" } });
  Assert.deepEqual(seen, [OWN], "the package's own launcher, whatever the caller exported");
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), "");
});

add_task(async function test_an_appimage_keeps_apprun_s_value() {
  const appimage = "/home/u/Apps/Vimma-1.0.0-x86_64.AppImage";
  const { env, seen } = run({
    vars: { MOZ_APP_LAUNCHER: appimage },
    exeDir: "/tmp/.mount_VimmaX/usr/lib/vimma",
    appDir: "/tmp/.mount_VimmaX",
  });
  Assert.deepEqual(seen, [], "left to the shell service's own start");
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), appimage);
  Assert.deepEqual(env.log, []);
});

add_task(async function test_another_appimage_s_appdir_changes_nothing_for_a_package() {
  // Another AppImage app's APPDIR reaches the programs it starts, a packaged Vimma among them.
  const { env, seen } = run({ appDir: "/tmp/.mount_OtherApp" });
  Assert.deepEqual(seen, [OWN]);
  Assert.equal(env.get("MOZ_APP_LAUNCHER"), "");
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

add_task(async function test_startup_leaves_no_launcher_for_the_programs_vimma_starts() {
  if (AppConstants.platform !== "linux") {
    Assert.ok(true, "only Linux reads MOZ_APP_LAUNCHER");
    return;
  }
  const own = PathUtils.join(
    PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path),
    "vimma-open",
  );
  if (await IOUtils.exists(own)) {
    Assert.equal(Services.env.get("MOZ_APP_LAUNCHER"), "", "read at startup, then cleared");
  } else {
    Assert.notEqual(Services.env.get("MOZ_APP_LAUNCHER"), own, "a build without vimma-open");
  }
  const services = Cm.QueryInterface(Ci.nsIServiceManager);
  Assert.ok(
    services.isServiceInstantiatedByContractID(
      "@mozilla.org/browser/shell-service;1",
      Ci.nsISupports,
    ),
    "the shell service has started",
  );
});

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
  const exeDir = PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path);
  Assert.ok(exeDir, "the binary sits in a folder");
  const own = PathUtils.join(exeDir, "vimma-open");
  if (await IOUtils.exists(own)) {
    Assert.ok(AppLauncher.init(), "the window's startup came first and named vimma-open");
    Assert.equal(Services.env.get("MOZ_APP_LAUNCHER"), "", "read at startup, then emptied");
  } else {
    Assert.ok(!AppLauncher.init(), "a build without vimma-open names no launcher");
    Assert.notEqual(Services.env.get("MOZ_APP_LAUNCHER"), own);
  }
});

// On Omarchy, GIO's http handler is Omarchy's router (hyprland-mimeapps.list), which opens the
// browser mimeapps.list names; the native check compares the router's command with Vimma's and
// says "not default" even after `xdg-settings set default-web-browser vimma-vimma.desktop`.

add_task(async function test_the_shell_service_s_own_command_is_recorded() {
  const exePath = "/usr/lib/vimma/vimma";
  const probe = (/** @type {Parameters<typeof AppLauncher.probe>[0]} */ deps) =>
    AppLauncher.probe({
      platform: "linux",
      exeDir: DIR,
      exePath,
      exists: (/** @type {string} */ path) => path === OWN,
      marker: "",
      running: () => false,
      startShellService: () => {},
      ...deps,
    });
  Assert.equal(probe({ env: fakeEnv() }).appPath, OWN, "vimma-open, once named");
  Assert.equal(
    probe({ env: fakeEnv({ MOZ_APP_LAUNCHER: "/x/other" }) }).appPath,
    OWN,
    "an inherited value is replaced before the service reads it",
  );
  Assert.equal(
    probe({ env: fakeEnv(), exists: () => false }).appPath,
    exePath,
    "without vimma-open, the binary, as the shell service takes it",
  );
  const appimage = "/home/u/Apps/Vimma.AppImage";
  Assert.equal(
    probe({ env: fakeEnv({ MOZ_APP_LAUNCHER: appimage }), marker: "vimma-package=appimage\n" })
      .appPath,
    appimage,
  );
  Assert.equal(
    probe({ env: fakeEnv({ MOZ_APP_LAUNCHER: "vimma" }), exists: () => false }).appPath,
    "",
    "a relative value is looked up in PATH by the shell service: unknown here, so no match",
  );
  Assert.equal(
    probe({ env: fakeEnv({ MOZ_APP_LAUNCHER: "/x/late" }), running: () => true }).appPath,
    "/x/late",
    "a service started first took the value it found",
  );
  Assert.equal(probe({ env: fakeEnv(), platform: "macosx" }).appPath, "");
});

const ROUTER_LIST =
  "[Default Applications]\nx-scheme-handler/http=omarchy-browser.desktop\nx-scheme-handler/https=omarchy-browser.desktop\n";
/** @param {string} id */
const browserList = (id) =>
  `[Default Applications]\nx-scheme-handler/http=${id}\nx-scheme-handler/https=${id}\n`;

const ENTRIES = {
  "/usr/share/applications/vimma-vimma.desktop": `[Desktop Entry]\nExec=${OWN} %u\n`,
  "/usr/share/applications/firefox.desktop": "[Desktop Entry]\nExec=/usr/lib/firefox/firefox %u\n",
};

/**
 * @param {{ files?: Record<string, string>, router?: string, vars?: Record<string, string>, appPath?: string }} options
 */
function throughRouter({
  files = {
    "/home/u/.config/hyprland-mimeapps.list": ROUTER_LIST,
    "/home/u/.config/mimeapps.list": browserList("vimma-vimma.desktop"),
  },
  router = "omarchy-browser.desktop",
  vars = { HOME: "/home/u", XDG_CURRENT_DESKTOP: "Hyprland" },
  appPath = OWN,
} = {}) {
  /** @type {string[]} */
  const read = [];
  /** @type {Record<string, string>} */
  const all = { ...ENTRIES, ...files };
  const result = AppLauncher.isDefaultThroughRouter({
    env: fakeEnv(vars),
    appPath,
    readFile: (/** @type {string} */ path) => {
      read.push(path);
      return all[path] ?? null;
    },
    defaultFor: () => router,
    resolves: (/** @type {string} */ program) =>
      [OWN, "/usr/lib/firefox/firefox", "/usr/lib/vimma/vimma"].includes(program),
  });
  return { result, read };
}

add_task(async function test_omarchy_s_router_to_vimma_counts_as_default() {
  Assert.ok(throughRouter().result, "mimeapps.list names Vimma behind Omarchy's router");
  Assert.ok(
    !throughRouter({
      files: {
        "/home/u/.config/hyprland-mimeapps.list": ROUTER_LIST,
        "/home/u/.config/mimeapps.list": browserList("firefox.desktop"),
      },
    }).result,
    "the router opens another browser",
  );
  Assert.ok(!throughRouter({ appPath: "/usr/lib/vimma/vimma" }).result, "another command");
  Assert.ok(
    throughRouter({
      vars: {
        HOME: "/nowhere",
        XDG_CONFIG_HOME: "/home/u/.config",
        XDG_CURRENT_DESKTOP: "Hyprland",
      },
    }).result,
    "XDG_CONFIG_HOME is where the lists are",
  );
  Assert.ok(
    throughRouter({
      files: {
        "/home/u/.config/hyprland-mimeapps.list": ROUTER_LIST,
        "/home/u/.config/mimeapps.list": browserList("vimma-vimma.desktop"),
        "/home/u/.local/share/applications/vimma-vimma.desktop":
          "[Desktop Entry]\nExec=/usr/lib/vimma/vimma %u\n",
      },
    }).result === false,
    "the user's own copy of the entry comes first, as it does for Omarchy and GIO",
  );
  Assert.ok(
    throughRouter({
      files: {
        "/home/u/.config/hyprland-mimeapps.list": ROUTER_LIST,
        "/home/u/.config/mimeapps.list": browserList("vimma-vimma.desktop"),
        "/home/u/.local/share/applications/vimma-vimma.desktop": "",
      },
    }).result === false,
    "an empty copy there hides the system's, as it does for Omarchy's launcher",
  );
  Assert.ok(
    throughRouter({
      vars: {
        HOME: "/home/u",
        XDG_CURRENT_DESKTOP: "Hyprland",
        XDG_DATA_HOME: "/nowhere",
        XDG_DATA_DIRS: "/elsewhere",
      },
    }).result === false,
    "XDG_DATA_DIRS is where the entries are",
  );
});

add_task(async function test_without_omarchy_s_router_nothing_is_read() {
  const { result, read } = throughRouter({ router: "firefox.desktop" });
  Assert.ok(!result);
  Assert.deepEqual(read, [], "a desktop without the router pays nothing for the check");
});

add_task(async function test_the_wrapped_check_keeps_firefox_s_answer_and_side_effects() {
  /** @type {unknown[][]} */
  const calls = [];
  let native = false;
  let routed = true;
  const target = {
    isDefaultBrowser(/** @type {unknown[]} */ ...args) {
      calls.push(args);
      return native;
    },
    async isDefaultBrowserAsync(/** @type {unknown[]} */ ...args) {
      calls.push(args);
      return native;
    },
  };
  AppLauncher.wrapIsDefault(target, () => routed);
  Assert.ok(target.isDefaultBrowser(true, false), "routed through Omarchy to Vimma");
  Assert.ok(await target.isDefaultBrowserAsync(true, false));
  Assert.deepEqual(
    calls,
    [
      [true, false],
      [true, false],
    ],
    "Firefox's own check still runs",
  );
  routed = false;
  Assert.ok(!target.isDefaultBrowser(false, true));
  Assert.ok(!(await target.isDefaultBrowserAsync(false, true)));
  native = true;
  let asked = false;
  AppLauncher.wrapIsDefault(target, () => {
    asked = true;
    throw new Error("unreadable");
  });
  Assert.ok(target.isDefaultBrowser(false, true));
  Assert.ok(!asked, "a native yes needs no second look");
  native = false;
  Assert.ok(!target.isDefaultBrowser(false, true), "an error in the check is a no");
});

add_task(async function test_firefox_s_shell_service_check_is_wrapped_on_linux() {
  const { ShellService } = ChromeUtils.importESModule(
    "moz-src:///browser/components/shell/ShellService.sys.mjs",
  );
  const linux = AppConstants.platform === "linux";
  Assert.equal(ShellService.isDefaultBrowser.name === "vimmaIsDefaultBrowser", linux);
  Assert.equal(ShellService.isDefaultBrowserAsync.name === "vimmaIsDefaultBrowserAsync", linux);
});

add_task(async function test_an_empty_entry_on_disk_hides_the_copies_after_it() {
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-router");
  try {
    const config = PathUtils.join(root, "config");
    const userApps = PathUtils.join(root, "data", "applications");
    const systemApps = PathUtils.join(root, "sys", "applications");
    await IOUtils.writeUTF8(PathUtils.join(config, "hyprland-mimeapps.list"), ROUTER_LIST, {
      mode: "create",
    });
    await IOUtils.writeUTF8(
      PathUtils.join(config, "mimeapps.list"),
      browserList("vimma-vimma.desktop"),
    );
    await IOUtils.writeUTF8(
      PathUtils.join(systemApps, "vimma-vimma.desktop"),
      `[Desktop Entry]\nExec=${OWN} %u\n`,
    );
    const check = () =>
      AppLauncher.isDefaultThroughRouter({
        env: fakeEnv({
          HOME: root,
          XDG_CONFIG_HOME: config,
          XDG_CONFIG_DIRS: PathUtils.join(root, "none"),
          XDG_DATA_HOME: PathUtils.join(root, "data"),
          XDG_DATA_DIRS: PathUtils.join(root, "sys"),
          XDG_CURRENT_DESKTOP: "Hyprland",
        }),
        appPath: OWN,
        defaultFor: () => "omarchy-browser.desktop",
        resolves: (/** @type {string} */ program) => program === OWN,
      });
    Assert.ok(check(), "the system's entry, read from disk");
    await IOUtils.writeUTF8(PathUtils.join(userApps, "vimma-vimma.desktop"), "");
    Assert.ok(!check(), "an empty user copy comes first, so Omarchy finds no Exec");
  } finally {
    await IOUtils.remove(root, { recursive: true });
  }
});

// When something starts the shell service before Vimma's first window (a dedicated profile made
// at startup, `vimma -setDefaultBrowser`), the service has already taken the binary as its command:
// Make Default would write a userapp- entry for it, and the package's entry, the one that runs
// vimma-open, would never count as the default.

add_task(async function test_a_late_shell_service_is_told_vimma_open_s_path() {
  const probe = (/** @type {boolean} */ late) =>
    AppLauncher.probe({
      platform: "linux",
      env: fakeEnv(),
      exeDir: DIR,
      exePath: "/usr/lib/vimma/vimma",
      exists: (/** @type {string} */ path) => path === OWN,
      marker: "",
      running: () => late,
      startShellService: () => {},
    });
  Assert.equal(probe(true).own, OWN, "late: Vimma still knows the package's own command");
  Assert.equal(probe(false).own, "", "on time: the shell service took vimma-open itself");
});

/**
 * A stand-in for nsIGIOService whose only installed entry runs `installed`.
 *
 * @param {string} installed
 */
function fakeGio(installed) {
  /** @type {string[]} */
  const calls = [];
  const app = {
    id: "vimma-vimma.desktop",
    setAsDefaultForURIScheme: (/** @type {string} */ s) => calls.push(`scheme ${s}`),
    setAsDefaultForMimeType: (/** @type {string} */ t) => calls.push(`type ${t}`),
    setAsDefaultForFileExtensions: (/** @type {string} */ e) => calls.push(`ext ${e}`),
  };
  return {
    calls,
    isRunningUnderFlatpak: false,
    findAppFromCommand(/** @type {string} */ command) {
      calls.push(`find ${command}`);
      if (command !== installed) {
        throw new Error("NS_ERROR_NOT_AVAILABLE");
      }
      return app;
    },
  };
}

/**
 * @param {{ installed?: string, allowed?: boolean }} options
 */
async function setDefaultLate({ installed = OWN, allowed = true } = {}) {
  /** @type {unknown[][]} */
  const original = [];
  /** @type {Record<string, unknown>} */
  const prefs = {};
  const target = {
    _attemptedSetDefaultThisSession: false,
    async setDefaultBrowser(/** @type {unknown[]} */ ...args) {
      original.push(args);
    },
  };
  const gio = fakeGio(installed);
  AppLauncher.wrapSetDefault(target, OWN, {
    gio: () => /** @type {nsIGIOService} */ (/** @type {unknown} */ (gio)),
    allowed: () => allowed,
    setPref: (/** @type {string} */ name, /** @type {unknown} */ value) => {
      prefs[name] = value;
    },
  });
  await target.setDefaultBrowser(false);
  return { target, original, prefs, calls: gio.calls };
}

add_task(async function test_make_default_sets_the_package_entry_after_a_late_start() {
  const { target, original, prefs, calls } = await setDefaultLate();
  Assert.deepEqual(
    calls,
    [
      `find ${OWN}`,
      "scheme http",
      "scheme https",
      "scheme chrome",
      "type text/html",
      "ext htm html shtml",
      "type application/xhtml+xml",
      "ext xhtml xht",
    ],
    "the installed entry that runs vimma-open, for what Firefox's own Make Default sets",
  );
  Assert.deepEqual(original, [], "Firefox's userapp- entry for the binary is never written");
  Assert.ok(target._attemptedSetDefaultThisSession);
  Assert.deepEqual(
    prefs,
    { "browser.shell.checkDefaultBrowser": true, "browser.shell.defaultBrowserCheckCount": 0 },
    "the prefs Firefox's Make Default sets",
  );
});

add_task(async function test_without_the_package_entry_make_default_keeps_firefox_s_way() {
  const { original, calls } = await setDefaultLate({ installed: "/elsewhere/vimma-open" });
  Assert.deepEqual(calls, [`find ${OWN}`], "no entry runs vimma-open: nothing set by Vimma");
  Assert.deepEqual(original, [[false]], "Firefox's own Make Default runs instead");
});

add_task(async function test_a_policy_against_make_default_is_left_to_firefox() {
  const { original, calls } = await setDefaultLate({ allowed: false });
  Assert.deepEqual(calls, [], "GIO is not asked");
  Assert.deepEqual(original, [[false]], "Firefox's method refuses it as it always does");
});

add_task(async function test_a_late_start_counts_the_package_entry_as_the_default() {
  const handlers = (/** @type {Record<string, string>} */ commands) =>
    AppLauncher.handlersRunOwn({
      own: OWN,
      commandFor: (/** @type {string} */ scheme) => commands[scheme] ?? "",
      which: (/** @type {string} */ program) => (program === OWN ? OWN : ""),
    });
  Assert.ok(handlers({ http: `${OWN} %u`, https: `${OWN} %u` }), "GIO names the package entry");
  Assert.ok(!handlers({ http: `${OWN} %u`, https: "/usr/lib/vimma/vimma %u" }), "only one scheme");
  Assert.ok(
    !AppLauncher.handlersRunOwn({
      own: "",
      commandFor: () => `${OWN} %u`,
      which: (/** @type {string} */ program) => program,
    }),
    "on time, Firefox's own check is the whole answer",
  );
});

add_task(async function test_make_default_is_wrapped_only_after_a_late_start() {
  const { ShellService } = ChromeUtils.importESModule(
    "moz-src:///browser/components/shell/ShellService.sys.mjs",
  );
  Assert.equal(
    ShellService.setDefaultBrowser.name === "vimmaSetDefaultBrowser",
    !!AppLauncher.lateOwn,
    "Firefox's own Make Default when the shell service took vimma-open itself",
  );
});

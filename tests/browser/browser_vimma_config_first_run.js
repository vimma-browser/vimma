/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// First run: a missing config.toml is created from the commented template, once, and an
// existing one (even empty) is never touched. XDG_CONFIG_HOME points at a temporary folder, so
// nothing here reaches the real ~/.config.

"use strict";

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { bindingTable, compileKeymap, formatConfigTemplate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const DONE_PREF = "vimma.config.firstRunDone";
const NOTICE_ID = "vimma-notice";

function noticeText() {
  const n = document.getElementById(NOTICE_ID);
  return n?.matches(":popover-open") ? n.textContent : null;
}

/** A temporary XDG_CONFIG_HOME, in force (with the XDG location) until `restore`. */
async function tempXdg() {
  const xdg = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-first-run");
  // Also when an assertion fails before restore() (#207).
  registerCleanupFunction(() => IOUtils.remove(xdg, { recursive: true, ignoreAbsent: true }));
  const before = Services.env.exists("XDG_CONFIG_HOME")
    ? Services.env.get("XDG_CONFIG_HOME")
    : null;
  Services.env.set("XDG_CONFIG_HOME", xdg);
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", ""]] });
  Services.prefs.clearUserPref(DONE_PREF);
  const dir = PathUtils.join(xdg, "vimma");
  return {
    xdg,
    dir,
    file: PathUtils.join(dir, "config.toml"),
    async restore() {
      Services.prefs.clearUserPref(DONE_PREF);
      await SpecialPowers.popPrefEnv();
      if (before === null) Services.env.set("XDG_CONFIG_HOME", "");
      else Services.env.set("XDG_CONFIG_HOME", before);
      await ConfigHost.reload();
      await IOUtils.remove(xdg, { recursive: true });
    },
  };
}

add_task(async function startup_never_writes_under_test_or_to_another_path() {
  Assert.ok(Cu.isInAutomation, "under test");
  Assert.equal(
    ConfigHost.firstRunBlocked,
    "path",
    "browser.toml's vimma.config.path: the file is elsewhere, startup leaves it",
  );
  const t = await tempXdg();
  Assert.equal(ConfigHost.firstRunBlocked, "automation", "the XDG file: still not under test");
  Services.prefs.setBoolPref(DONE_PREF, true);
  Assert.equal(ConfigHost.firstRunBlocked, "done", "and never after the first run");
  Assert.ok(!(await IOUtils.exists(t.dir)), "nothing written");
  await t.restore();
});

add_task(async function a_missing_file_is_created_from_the_template_once() {
  const t = await tempXdg();
  // ~/.config/vimma/ may already hold Vimma's keys/ and the vimma/ profile root.
  await IOUtils.makeDirectory(PathUtils.join(t.dir, "keys"), { createAncestors: true });
  await IOUtils.writeUTF8(PathUtils.join(t.dir, "keys", "k"), "key");
  await IOUtils.makeDirectory(PathUtils.join(t.dir, "vimma"));
  await IOUtils.setPermissions(t.dir, 0o755, false);

  Assert.equal(await ConfigHost.firstRun(window), "created", "missing: created");
  Assert.equal(await IOUtils.readUTF8(t.file), formatConfigTemplate(), "the :config template");
  Assert.equal((await IOUtils.stat(t.file)).permissions, 0o600, "mode 0600");
  Assert.equal((await IOUtils.stat(t.dir)).permissions, 0o755, "an existing folder keeps its mode");
  Assert.deepEqual(
    (await IOUtils.getChildren(t.dir)).map((p) => PathUtils.filename(p)).sort(),
    ["config.toml", "keys", "vimma"],
    "keys/ and vimma/ left alone",
  );
  Assert.equal(await IOUtils.readUTF8(PathUtils.join(t.dir, "keys", "k")), "key", "keys intact");
  Assert.equal(noticeText(), "created " + t.file, "one quiet notice naming the file");
  Assert.ok(Services.prefs.getBoolPref(DONE_PREF, false), "done for this profile");

  await ConfigHost.reload();
  Assert.equal(ConfigHost.path, t.file, "the created file is the one in force");
  Assert.equal(ConfigHost.file, "read", "and was read");
  Assert.deepEqual(ConfigHost.errors, [], "a valid config");
  Assert.deepEqual(
    bindingTable(ConfigHost.keymap),
    // The platform's defaults: macOS has its own (docs/specs/macos-build.md decision 29).
    bindingTable(compileKeymap({}, { mac: Services.appinfo.OS === "Darwin" })),
    "that changes no binding",
  );
  await t.restore();
});

add_task(async function a_missing_folder_is_created_private() {
  const t = await tempXdg();
  Assert.equal(await ConfigHost.firstRun(window), "created", "created, folder too");
  Assert.equal((await IOUtils.stat(t.dir)).permissions, 0o700, "folder mode 0700");
  Assert.equal((await IOUtils.stat(t.file)).permissions, 0o600, "file mode 0600");
  await t.restore();
});

add_task(async function an_existing_file_is_never_touched() {
  for (const text of ['[keys]\nnew_tab = ["prefix+t"]\n', ""]) {
    const t = await tempXdg();
    await IOUtils.makeDirectory(t.dir);
    await IOUtils.writeUTF8(t.file, text);
    await IOUtils.setPermissions(t.file, 0o644, false);
    const { lastModified } = await IOUtils.stat(t.file);
    Assert.equal(await ConfigHost.firstRun(window), "exists", `${text ? "with content" : "empty"}`);
    Assert.equal(await IOUtils.readUTF8(t.file), text, "not rewritten");
    const after = await IOUtils.stat(t.file);
    Assert.equal(after.lastModified, lastModified, "not even touched");
    Assert.equal(after.permissions, 0o644, "its mode kept");
    Assert.ok(Services.prefs.getBoolPref(DONE_PREF, false), "done: no later run creates one");
    await t.restore();
  }
});

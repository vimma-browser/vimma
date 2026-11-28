/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m5-config-load.md, "Reads". How the poll sees config.toml change on disk:
// a file that cannot be read is said in the status bar and read again, a change that keeps the
// time and size (a Nix store link, `cp -p`) is seen, a file gone for one poll (an editor's save)
// keeps the config in force, and a link to nothing is named as one.

"use strict";

/* global focusContent -- from head.js */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { fileSignature } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/BookmarksFile.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";
const A = `[keys]\nnew_tab = "prefix+m"\n`;
const B = `[keys]\nnew_tab = "prefix+y"\n`;

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);

/** @param {string} id */
function segText(id) {
  return (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

function noticeText() {
  const n = document.getElementById(NOTICE_ID);
  return n?.matches(":popover-open") ? n.textContent : null;
}

const newTab = () => ConfigHost.config?.keys.new_tab;

/**
 * Runs python3 with `code` and `args` (`sys.argv[1:]`): nsIFile makes no links and no FIFOs, and
 * a link repointed in one step is what a dotfile manager does.
 * @param {string} code
 * @param {string[]} args
 */
async function python(code, ...args) {
  const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  const py = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  py.initWithPath("/usr/bin/python3");
  proc.init(py);
  const argv = ["-c", code, ...args];
  // nsIProcess notifies "process-failed" for a non-zero exit.
  const topic = await new Promise((resolve) =>
    proc.runAsync(argv, argv.length, { observe: (_s, t) => resolve(t) }),
  );
  Assert.equal(topic, "process-finished", `python3 ${args.join(" ")}`);
}

/** `link` pointing at `target`, replaced in one rename when it is there, as home-manager does. */
const pointLink = (/** @type {string} */ target, /** @type {string} */ link) =>
  python(
    "import os,sys; t=sys.argv[2]+'.new'; os.symlink(sys.argv[1], t); os.replace(t, sys.argv[2])",
    target,
    link,
  );

/** A FIFO at `path`, which blocks whoever opens it for reading. */
const mkfifo = (/** @type {string} */ path) =>
  python("import os,sys; os.mkfifo(sys.argv[1], 0o600)", path);

/**
 * A throwaway folder whose config.toml is in force for `task`, with the timer's poll held off:
 * the task polls by hand (ConfigHost.poll), so that "one poll" means one.
 * @param {(paths: { dir: string, config: string }) => Promise<void>} task
 */
async function withConfig(task) {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-config-changes");
  const paths = { dir, config: PathUtils.join(dir, "config.toml") };
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", paths.config],
      ["vimma.config.pollMs", 600000],
    ],
  });
  try {
    await ConfigHost.reload();
    await task(paths);
  } finally {
    await IOUtils.setPermissions(paths.config, 0o600).catch(() => {});
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
  }
}

/**
 * `:line` Enter in an example.com tab in normal mode.
 * @param {string} line
 */
async function command(line) {
  await focusContent(gBrowser.selectedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

add_task(async function setup() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
});

add_task(async function a_file_that_is_not_utf8_is_said_and_the_config_in_force_stays() {
  await withConfig(async ({ config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    // Latin-1 "ä" in a comment, as an editor set to another encoding saves it.
    await IOUtils.write(config, new Uint8Array([...new TextEncoder().encode(B), 0x23, 0xe4, 0x0a]));
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "the config in force stays");
    await until(
      () => segText("error") === "config.toml: not UTF-8 text; not read",
      "the status bar says why the file was not read",
    );

    // Read again at the next poll without any change, and nothing new is said.
    const errors = ConfigHost.errors;
    await ConfigHost.poll();
    Assert.equal(ConfigHost.errors, errors, "the same error, not reported again");

    await IOUtils.writeUTF8(config, B);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+y", "the fixed file applies");
    await until(() => segText("error") === null, "and the error is gone");
  });
});

add_task(async function an_unreadable_file_is_said_and_read_once_it_can_be() {
  // root reads a file whatever its mode.
  if (Services.env.get("USER") === "root") return;
  await withConfig(async ({ config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    // chmod changes neither the time nor the size.
    await IOUtils.setPermissions(config, 0o000);
    await ConfigHost.poll();
    await until(
      () => segText("error") === "config.toml: cannot be read (no permission); not read",
      "the status bar says the file cannot be read",
    );
    Assert.equal(newTab(), "prefix+m", "the config in force stays");

    await IOUtils.setPermissions(config, 0o600);
    await ConfigHost.poll();
    await until(() => segText("error") === null, "readable again: the error is gone");
    Assert.equal(newTab(), "prefix+m", "and the file applies");
  });
});

add_task(async function a_link_repointed_at_a_file_of_the_same_size_and_time_is_read() {
  await withConfig(async ({ dir, config }) => {
    // The Nix store gives every file the time 1: a `home-manager switch` repoints the link at a
    // file of the same time and, here, the same size.
    const one = PathUtils.join(dir, "store-1-config.toml");
    const two = PathUtils.join(dir, "store-2-config.toml");
    await IOUtils.writeUTF8(one, A);
    await IOUtils.writeUTF8(two, B);
    await IOUtils.setModificationTime(one, 1000);
    await IOUtils.setModificationTime(two, 1000);
    await pointLink(one, config);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the link's file applies");

    await pointLink(two, config);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+y", "the poll reads the new file");
  });
});

add_task(async function a_rewrite_that_keeps_the_time_and_size_is_read() {
  await withConfig(async ({ dir, config }) => {
    await IOUtils.writeUTF8(config, A);
    await IOUtils.setModificationTime(config, 1000);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    // An editor's save, as `cp -p` or `rsync -t` would leave it: written beside the file,
    // renamed over it, the time kept.
    const tmp = PathUtils.join(dir, ".config.toml.swp");
    await IOUtils.writeUTF8(tmp, B);
    await IOUtils.setModificationTime(tmp, 1000);
    await IOUtils.move(tmp, config);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+y", "the poll reads the new text");
  });
});

add_task(async function a_file_gone_for_one_poll_keeps_the_config_in_force() {
  await withConfig(async ({ config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    await IOUtils.remove(config);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "one poll without the file changes nothing");
    Assert.equal(ConfigHost.file, "read", "and it is not called missing yet");

    await IOUtils.writeUTF8(config, B);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+y", "the file made again applies");
    Assert.equal(noticeText(), null, "with no word of a missing file");
  });
});

add_task(async function a_file_gone_for_two_polls_gives_the_defaults_and_says_so_once() {
  await withConfig(async ({ config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    await IOUtils.remove(config);
    await ConfigHost.poll();
    await ConfigHost.poll();
    Assert.equal(newTab(), undefined, "the defaults apply");
    Assert.equal(ConfigHost.file, "missing", "the file is missing");
    await until(
      () => noticeText() === "config.toml missing; using the defaults",
      "the defaults are said",
    );
    document.getElementById(NOTICE_ID)?.hidePopover();
    await ConfigHost.poll();
    Assert.equal(noticeText(), null, "once");

    await IOUtils.writeUTF8(config, B);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+y", "a new file applies at the next poll");
  });
});

add_task(async function a_link_to_nothing_is_said_and_the_config_in_force_stays() {
  await withConfig(async ({ dir, config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    await IOUtils.remove(config);
    await pointLink(PathUtils.join(dir, "nowhere.toml"), config);
    await ConfigHost.poll();
    await until(
      () => segText("error") === "config.toml: a link to a missing file; not read",
      "the status bar names the link",
    );
    Assert.equal(newTab(), "prefix+m", "the config in force stays");

    // :config neither creates the link's file nor says it cannot create config.toml.
    const tabs = gBrowser.tabs.length;
    await command("config");
    await until(
      () => noticeText()?.startsWith(":config: config.toml is a link to "),
      ":config names the link",
    );
    const said = found(noticeText());
    Assert.ok(said.endsWith("nowhere.toml, which does not exist"), said);
    Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
    Assert.ok(!(await IOUtils.exists(PathUtils.join(dir, "nowhere.toml"))), "nothing created");
  });
});

add_task(async function a_file_over_1_mib_is_not_read() {
  await withConfig(async ({ config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    await IOUtils.writeUTF8(config, `${B}${"# padding\n".repeat(110000)}`);
    await ConfigHost.poll();
    await until(
      () => segText("error") === "config.toml: larger than 1 MiB; not read",
      "the status bar says the file is too large",
    );
    Assert.equal(newTab(), "prefix+m", "the config in force stays");
  });
});

add_task(async function a_fifo_is_not_read_and_the_poll_goes_on() {
  await withConfig(async ({ config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    await IOUtils.remove(config);
    await mkfifo(config);
    await ConfigHost.poll();
    await until(
      () => segText("error") === "config.toml: not a regular file; not read",
      "the status bar says the FIFO is not read",
    );
    Assert.equal(newTab(), "prefix+m", "the config in force stays");
    // A poll that opened the FIFO would never end, nor would any later one.
    await ConfigHost.poll();
    await IOUtils.remove(config);
    await IOUtils.writeUTF8(config, B);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+y", "a file in its place applies");
  });
});

add_task(async function an_unreadable_file_neither_undoes_source_nor_holds_routes_toml() {
  if (Services.env.get("USER") === "root") return;
  await withConfig(async ({ dir, config }) => {
    const { WorkspaceRouter } = ChromeUtils.importESModule(
      "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
    );
    await IOUtils.writeUTF8(config, A);
    await IOUtils.setPermissions(config, 0o000);
    await ConfigHost.poll();
    await until(() => segText("error")?.includes("cannot be read"), "the file cannot be read");

    // routes.toml beside it still applies while config.toml cannot be read.
    const routes = PathUtils.join(dir, "routes.toml");
    await IOUtils.writeUTF8(routes, `[[routes]]\ndomain = "example.org"\nworkspace = "work"\n`);
    await ConfigHost.poll();
    Assert.deepEqual(
      WorkspaceRouter.routes.map((r) => r.domain?.host),
      ["example.org"],
      "routes.toml's rule is in force",
    );
    Assert.equal(
      ConfigHost.errors[0]?.message,
      "cannot be read (no permission); not read",
      "and config.toml is still said to be unreadable",
    );

    // :source <file> stays in force while config.toml, unchanged, still cannot be read.
    const work = PathUtils.join(dir, "work.toml");
    await IOUtils.writeUTF8(work, B);
    await ConfigHost.reload(work);
    Assert.equal(ConfigHost.path, work, "the sourced file is in force");
    await ConfigHost.poll();
    await ConfigHost.poll();
    Assert.equal(ConfigHost.path, work, "and stays so across polls");
    Assert.equal(newTab(), "prefix+y", "with its keys");
  });
});

add_task(async function a_folder_without_search_permission_is_said_and_read_once_it_can_be() {
  if (Services.env.get("USER") === "root") return;
  await withConfig(async ({ dir, config }) => {
    await IOUtils.writeUTF8(config, A);
    await ConfigHost.poll();
    Assert.equal(newTab(), "prefix+m", "sanity: the file applies");

    await IOUtils.setPermissions(dir, 0o600);
    try {
      await ConfigHost.poll();
      await until(
        () => ConfigHost.errors[0]?.message === "cannot be read (no permission); not read",
        "config.toml is said to be unreadable (routes.toml beside it too: it cannot be told apart)",
      );
      Assert.equal(newTab(), "prefix+m", "the config in force stays");
    } finally {
      await IOUtils.setPermissions(dir, 0o700);
    }
    await ConfigHost.poll();
    await until(
      () => !ConfigHost.errors.length && !ConfigHost.routesProblems.length,
      "searchable again: the errors are gone",
    );
    Assert.equal(newTab(), "prefix+m", "and the file applies");
  });
});

// routes.toml and bookmarks.toml are polled through the same signature.
add_task(async function the_signature_sees_text_and_link_changes_that_keep_time_and_size() {
  await withConfig(async ({ dir }) => {
    const file = PathUtils.join(dir, "bookmarks.toml");
    const other = PathUtils.join(dir, "other.toml");
    await IOUtils.writeUTF8(file, A);
    await IOUtils.writeUTF8(other, A);
    await IOUtils.setModificationTime(file, 1000);
    await IOUtils.setModificationTime(other, 1000);
    const before = await fileSignature(file, 1024);
    Assert.equal(await fileSignature(file, 1024), before, "unchanged: the same signature");

    await IOUtils.writeUTF8(file, B);
    await IOUtils.setModificationTime(file, 1000);
    Assert.notEqual(await fileSignature(file, 1024), before, "new text, same time and size");

    const link = PathUtils.join(dir, "link.toml");
    await pointLink(file, link);
    const linked = await fileSignature(link, 1024);
    await IOUtils.writeUTF8(file, A);
    await IOUtils.setModificationTime(file, 1000);
    await pointLink(other, link);
    Assert.notEqual(await fileSignature(link, 1024), linked, "a link repointed at the same text");
    Assert.equal(await fileSignature(PathUtils.join(dir, "none"), 1024), "missing", "missing");
  });
});

/**
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

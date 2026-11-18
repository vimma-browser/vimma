/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarks-file.md, Delivery slice 1 (the read-only mirror): bookmarks.toml
// beside config.toml is mirrored into each table's workspace folder in Places, live, keeping
// guids; a change made in Places is put back; a broken or missing file pauses; a large deletion
// and a takeover ask first; Vimma's keys refuse in mirrored folders.

"use strict";

/* global focusContent -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { BookmarksFileImpl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/BookmarksFile.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { isMirrored, mirroredRefusal } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/bookmark-ops.mjs",
);
const { runBookmarkEffect } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/bookmark-actions.mjs",
);

const PAGE = "https://example.com/";
const { toolbarGuid, menuGuid, unfiledGuid } = PlacesUtils.bookmarks;
const dir = PathUtils.join(PathUtils.tempDir, `vimma-bookmarks-file-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");
const bookmarksFile = PathUtils.join(dir, "bookmarks.toml");
const mirror = ConfigHost.bookmarksFile;

/**
 * A node of PlacesUtils.promiseBookmarksTree: the fields read here.
 * @typedef {{ guid: string, typeCode?: number, title?: string, uri?: string,
 *   children?: Node[] }} Node
 */

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

let writes = 0;
/**
 * Writes bookmarks.toml (or `path`); each write gets a size of its own (a trailing comment), so
 * the poll sees a change even within one millisecond.
 * @param {string} text
 * @param {string} [path]
 */
async function writeFile(text, path = bookmarksFile) {
  writes++;
  await IOUtils.writeUTF8(path, `${text}\n${"#".repeat(writes)}\n`);
}

/** The top-level toolbar folder titled `name`, or null. */
async function topFolder(/** @type {string} */ name) {
  const bar = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(toolbarGuid));
  return (bar.children ?? []).find((c) => c.typeCode === 2 && c.title === name) ?? null;
}

/**
 * A folder's contents as titles and URLs, folders as `{ "name/": [...] }`, separators as `---`.
 * @param {Node | null | undefined} node
 * @returns {unknown[]}
 */
function contents(node) {
  return (node?.children ?? []).map((c) =>
    c.typeCode === 3
      ? "---"
      : c.typeCode === 2
        ? { [`${c.title}/`]: contents(c) }
        : `${c.title} ${c.uri}`,
  );
}

/** @param {string} name */
async function folderContents(name) {
  const f = await topFolder(name);
  return f ? contents(await PlacesUtils.promiseBookmarksTree(f.guid)) : null;
}

/**
 * Waits until folder `name` holds `expected`.
 * @param {string} name
 * @param {unknown[]} expected
 * @param {string} msg
 */
async function untilFolder(name, expected, msg) {
  const want = JSON.stringify(expected);
  let last = "";
  await until(async () => {
    last = JSON.stringify(await folderContents(name));
    return last === want;
  }, msg).catch((e) => {
    Assert.equal(last, want, msg);
    throw e;
  });
  Assert.ok(true, msg);
}

const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const promptEl = () => document.getElementById("vimma-rename");
const promptOpen = () => !!promptEl() && !(/** @type {HTMLElement} */ (promptEl()).hidden);
const promptText = () =>
  promptEl()?.querySelector(".vimma-cmdline-prompt")?.textContent?.trim() ?? "";
/** The status bar's error segment. */
const errorSegment = () =>
  document.getElementById("vimma-statusbar")?.querySelector('[data-segment="error"]')
    ?.textContent ?? "";

/**
 * Answers the mirror's question with `key`, after the moment it ignores keys for (a key typed as
 * it appears is not an answer).
 * @param {string} key
 */
async function answer(key) {
  await new Promise((r) => setTimeout(r, 1200));
  EventUtils.synthesizeKey(key);
}

/** Removes every bookmark these tests made and drops the mirror's base. */
async function reset() {
  // Forgotten first, so that removing the file is no missing-file pause.
  await mirror.forget();
  await IOUtils.remove(bookmarksFile, { ignoreAbsent: true });
  await IOUtils.writeUTF8(configFile, "schema = 2\n");
  await ConfigHost.reload();
  await mirror.forget();
  for (const parent of [toolbarGuid, menuGuid, unfiledGuid]) {
    const tree = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(parent));
    for (const c of tree.children ?? []) await PlacesUtils.bookmarks.remove(c.guid);
  }
  await mirror.settledRuns();
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
}

/** Runs `:line` in the selected tab. */
async function runCommand(/** @type {string} */ line) {
  await focusContent(gBrowser.selectedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

// The 5000-bookmark budget test loads and edits a large file.
requestLongerTimeout(2);

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", configFile],
      ["vimma.config.pollMs", 100],
      ["vimma.bookmarks.settleMs", 50],
      ["vimma.bookmarks.burstMs", 200],
      ["vimma.feature.bookmarksFile", true],
    ],
  });
  registerCleanupFunction(async () => {
    while (gBrowser.tabs.length > 1) {
      gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
    await reset();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await reset();
});

add_task(async function a_file_is_mirrored_into_the_workspace_folder_in_order() {
  await writeFile(
    [
      "[bookmarks.work]",
      '"docs/Vimma guide" = "https://vimma.dev/docs"',
      '"2024" = "https://example.com/2024"',
      '"docs/Firefox source" = "https://searchfox.org/"',
      '"archive/" = ""',
      "",
      '[bookmarks."my shop"]',
      '"Cart" = "https://shop.example/cart"',
    ].join("\n"),
  );
  await untilFolder(
    "work",
    [
      { "docs/": ["Vimma guide https://vimma.dev/docs", "Firefox source https://searchfox.org/"] },
      "2024 https://example.com/2024",
      { "archive/": [] },
    ],
    "the table is the folder, in file order",
  );
  await untilFolder("my shop", ["Cart https://shop.example/cart"], "each table its own folder");
  await reset();
});

add_task(
  async function bookmarks_toml_is_read_beside_the_config_path_pref_and_beside_a_symlinked_config_toml() {
    // A stow-style folder: config.toml is a link into another folder; bookmarks.toml is read
    // beside the link (D1), not beside its target.
    const real = PathUtils.join(dir, "dotfiles");
    const links = PathUtils.join(dir, "links");
    await IOUtils.makeDirectory(real, { createAncestors: true });
    await IOUtils.makeDirectory(links, { createAncestors: true });
    await IOUtils.writeUTF8(PathUtils.join(real, "config.toml"), "schema = 2\n");
    const command = await Subprocess.pathSearch("ln");
    const proc = await Subprocess.call({
      command,
      arguments: [
        "-sfn",
        PathUtils.join(real, "config.toml"),
        PathUtils.join(links, "config.toml"),
      ],
    });
    Assert.equal((await proc.wait()).exitCode, 0, "linked config.toml");
    await writeFile(
      '[bookmarks.target]\n"wrong" = "https://example.com/target"',
      PathUtils.join(real, "bookmarks.toml"),
    );
    await writeFile(
      '[bookmarks.linked]\n"right" = "https://example.com/linked"',
      PathUtils.join(links, "bookmarks.toml"),
    );
    await SpecialPowers.pushPrefEnv({
      set: [["vimma.config.path", PathUtils.join(links, "config.toml")]],
    });
    await untilFolder("linked", ["right https://example.com/linked"], "read beside the link");
    Assert.equal(await topFolder("target"), null, "not beside the link's target");
    await SpecialPowers.popPrefEnv();
    await mirror.forget();
    await reset();
  },
);

add_task(async function inline_tables_mirror_and_bookmarks_toml_wins_with_a_warning() {
  await IOUtils.writeUTF8(
    configFile,
    'schema = 2\n[bookmarks]\nroot = "workspace"\n[bookmarks.inline]\n"a" = "https://example.com/a"\n',
  );
  await ConfigHost.reload();
  Assert.deepEqual(ConfigHost.errors, [], "config.toml with an inline table applies");
  await untilFolder("inline", ["a https://example.com/a"], "an inline table is mirrored");
  await writeFile('[bookmarks.inline]\n"b" = "https://example.com/b"');
  await untilFolder("inline", ["b https://example.com/b"], "bookmarks.toml is the file now");
  await until(
    () => errorSegment().includes("bookmarks.inline ignored: bookmarks.toml is the bookmarks file"),
    "the inline table is ignored with a warning at its line",
  );
  Assert.stringContains(errorSegment(), "config.toml:4:", "the warning names its line");
  await reset();
});

add_task(async function source_reads_bookmarks_toml_and_source_file_ignores_its_bookmark_tables() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.pollMs", 600000]] });
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"');
  await ConfigHost.reload(); // :source reads it now, not at the next poll
  await untilFolder("work", ["a https://example.com/a"], ":source reads bookmarks.toml");
  const other = PathUtils.join(dir, "try.toml");
  await IOUtils.writeUTF8(
    other,
    'schema = 2\n[bookmarks.work]\n"z" = "https://example.com/z"\n[bookmarks.tried]\n"t" = "https://example.com/t"\n',
  );
  await ConfigHost.reload(other);
  Assert.ok(
    ConfigHost.warnings.some((w) => w.message.includes(":source <file> does not change bookmarks")),
    "its tables are ignored with a warning",
  );
  await mirror.settledRuns();
  Assert.deepEqual(await folderContents("work"), ["a https://example.com/a"], "work unchanged");
  Assert.equal(await topFolder("tried"), null, "no folder from the sourced file");
  await SpecialPowers.popPrefEnv();
  await reset();
});

add_task(async function an_edit_of_the_file_applies_live_and_keeps_guids() {
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"');
  await untilFolder("work", ["a https://example.com/a", "b https://example.com/b"], "loaded");
  const before = await PlacesUtils.promiseBookmarksTree(
    /** @type {Node} */ (await topFolder("work")).guid,
  );
  const [a, b] = /** @type {Node[]} */ (before?.children ?? []);
  await PlacesUtils.keywords.insert({ keyword: "bkw", url: "https://example.com/b" });
  // A new URL for a, and b moved into a folder and renamed.
  await writeFile(
    '[bookmarks.work]\n"a" = "https://example.com/a2"\n"docs/b2" = "https://example.com/b"',
  );
  await untilFolder(
    "work",
    ["a https://example.com/a2", { "docs/": ["b2 https://example.com/b"] }],
    "the edit applies within the poll",
  );
  Assert.equal((await PlacesUtils.bookmarks.fetch(a.guid))?.url?.href, "https://example.com/a2");
  Assert.equal((await PlacesUtils.bookmarks.fetch(b.guid))?.title, "b2", "b kept its guid");
  Assert.equal(
    (await PlacesUtils.keywords.fetch("bkw"))?.url.href,
    "https://example.com/b",
    "and its keyword",
  );
  await PlacesUtils.keywords.remove("bkw");
  await reset();
});

add_task(async function a_url_without_its_trailing_slash_is_not_put_back_or_rewritten() {
  await writeFile('[bookmarks.work]\n"S" = "https://searchfox.org"');
  await untilFolder("work", ["S https://searchfox.org/"], "stored as Places keeps it");
  const stat = await IOUtils.stat(bookmarksFile);
  /** @type {string[]} */
  const seen = [];
  const listener = (/** @type {{ type: string }[]} */ events) => {
    for (const e of events) seen.push(e.type);
  };
  PlacesUtils.observers.addListener(["bookmark-url-changed", "bookmark-added"], listener);
  await ConfigHost.reload();
  await mirror.settledRuns();
  PlacesUtils.observers.removeListener(["bookmark-url-changed", "bookmark-added"], listener);
  Assert.deepEqual(seen, [], "no write to Places");
  Assert.equal((await IOUtils.stat(bookmarksFile)).lastModified, stat.lastModified, "nor the file");
  await reset();
});

add_task(async function the_mirror_writes_nothing_back_after_its_own_apply() {
  /** @type {string[]} */
  const seen = [];
  const types = ["bookmark-added", "bookmark-removed", "bookmark-moved", "bookmark-title-changed"];
  const listener = (/** @type {{ type: string }[]} */ events) => {
    for (const e of events) seen.push(e.type);
  };
  PlacesUtils.observers.addListener(types, listener);
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"\n"b/" = ""');
  await untilFolder("work", ["a https://example.com/a", { "b/": [] }], "applied");
  await mirror.settledRuns();
  const stat = await IOUtils.stat(bookmarksFile);
  const count = seen.length;
  // Longer than a burst and two polls: anything the apply's own events started would show.
  await new Promise((r) => setTimeout(r, 800));
  await mirror.settledRuns();
  PlacesUtils.observers.removeListener(types, listener);
  Assert.equal(seen.length, count, "no second apply");
  Assert.ok(count >= 3, "one apply: the folder, a and b");
  Assert.equal(
    (await IOUtils.stat(bookmarksFile)).lastModified,
    stat.lastModified,
    "no file write",
  );
  await reset();
});

add_task(async function a_broken_file_pauses_both_ways_and_names_the_line() {
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "data:text/html,x"');
  await until(
    () => errorSegment().includes("bookmarks.toml:3: data: URLs are never added to bookmarks"),
    "the status bar names the file and the line",
  );
  // Paused both ways: a Library change stays.
  const folder = /** @type {Node} */ (await topFolder("work"));
  await PlacesUtils.bookmarks.insert({
    parentGuid: folder.guid,
    url: "https://example.com/lib",
    title: "lib",
  });
  await new Promise((r) => setTimeout(r, 500));
  await mirror.settledRuns();
  Assert.deepEqual(
    await folderContents("work"),
    ["a https://example.com/a", "lib https://example.com/lib"],
    "nothing applied or put back while the file is broken",
  );
  // Fixed: one run merges, and the file wins.
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"\n"c" = "https://example.com/c"');
  await untilFolder("work", ["a https://example.com/a", "c https://example.com/c"], "resumed");
  await until(() => !errorSegment().includes("bookmarks.toml"), "the error is gone");
  await reset();
});

add_task(async function a_missing_file_pauses_and_forget_turns_the_mirror_off() {
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  await IOUtils.remove(bookmarksFile);
  await until(
    () => noticeText().includes("bookmarks.toml is missing; bookmarks paused"),
    "a missing file pauses, with a notice",
  );
  Assert.deepEqual(await folderContents("work"), ["a https://example.com/a"], "nothing deleted");
  const folder = /** @type {Node} */ (await topFolder("work"));
  Assert.ok(await isMirrored(folder.guid), "the folder's keys still refuse");
  await until(
    () =>
      mirroredRefusal() ===
      "bookmarks.toml is missing, so these bookmarks are paused: restore it, or :bookmarks forget",
    "and say why and the way out",
  );
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?forget`);
  await runCommand("bookmarks forget");
  await until(() => noticeText().includes("bookmarks.toml forgotten"), ":bookmarks forget says so");
  Assert.ok(!(await isMirrored(folder.guid)), "the mirror is off");
  Assert.deepEqual(await folderContents("work"), ["a https://example.com/a"], "Places keeps it");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

add_task(async function a_missing_config_toml_holding_the_inline_tables_pauses() {
  await IOUtils.writeUTF8(
    configFile,
    'schema = 2\n[bookmarks.inline]\n"a" = "https://example.com/a"\n',
  );
  await ConfigHost.reload();
  await untilFolder("inline", ["a https://example.com/a"], "loaded");
  await IOUtils.remove(configFile);
  await until(
    () => noticeText().includes("config.toml is missing; bookmarks paused"),
    "a missing config.toml pauses, with a notice",
  );
  await mirror.settledRuns();
  Assert.deepEqual(await folderContents("inline"), ["a https://example.com/a"], "nothing deleted");
  await reset();
});

add_task(async function with_the_feature_pref_off_nothing_is_read_or_refused() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.feature.bookmarksFile", false]] });
  await writeFile('[bookmarks.off]\n"a" = "https://example.com/a"');
  await new Promise((r) => setTimeout(r, 800));
  await mirror.settledRuns();
  Assert.equal(await topFolder("off"), null, "bookmarks.toml is not read");
  Assert.deepEqual(mirror.words(), [], ":bookmarks completes to nothing");
  await SpecialPowers.popPrefEnv();
  await untilFolder("off", ["a https://example.com/a"], "turned on, it is read");
  await reset();
});

/** A table of `n` bookmarks `b0…`. */
const lines = (/** @type {number} */ n) =>
  Array.from({ length: n }, (_, i) => `"b${i}" = "https://example.com/${i}"`).join("\n");

add_task(async function a_large_deletion_asks_and_n_applies_nothing() {
  await writeFile(`[bookmarks.work]\n${lines(25)}`);
  await until(async () => (await folderContents("work"))?.length === 25, "25 loaded");
  await writeFile("[bookmarks.work]\n");
  await until(
    () =>
      promptOpen() &&
      promptText() === 'bookmarks.toml removes 25 bookmarks from "work": delete them? y/N',
    "asked in the window",
  );
  await answer("n");
  await until(() => noticeText().includes("not applied; bookmarks paused"), "n pauses, said");
  await mirror.settledRuns();
  Assert.equal((await folderContents("work"))?.length, 25, "nothing deleted");
  // Asked again after the file changes; y applies it.
  await writeFile("[bookmarks.work]\n# emptied on purpose");
  await until(() => promptOpen(), "asked again for the new file");
  await answer("y");
  await untilFolder("work", [], "y deletes them");
  await until(() => noticeText().includes('25 bookmarks removed from "work"'), "said how many");
  await reset();
});

add_task(
  async function an_unanswered_question_applies_nothing_after_its_time_and_blocks_no_config_edit() {
    await SpecialPowers.pushPrefEnv({ set: [["vimma.bookmarks.askMs", 1000]] });
    await writeFile(`[bookmarks.work]\n${lines(22)}`);
    await until(async () => (await folderContents("work"))?.length === 22, "loaded");
    await writeFile("[bookmarks.work]\n");
    await until(() => promptOpen(), "asked");
    // The question waits outside every queue: config.toml still reads and applies.
    await IOUtils.writeUTF8(configFile, 'schema = 2\n[bookmarks]\nroot = "toolbar"\n');
    await ConfigHost.reload();
    Assert.equal(ConfigHost.config?.bookmarks.root, "toolbar", "config.toml applied meanwhile");
    await until(() => !promptOpen(), "the question closes unanswered");
    await until(() => noticeText().includes("not applied"), "said");
    Assert.equal((await folderContents("work"))?.length, 22, "nothing deleted");
    await SpecialPowers.popPrefEnv();
    await reset();
  },
);

add_task(async function a_small_deletion_from_the_file_says_how_many() {
  await writeFile(`[bookmarks.work]\n${lines(10)}`);
  await until(async () => (await folderContents("work"))?.length === 10, "loaded");
  await writeFile(`[bookmarks.work]\n${lines(7)}`);
  await until(async () => (await folderContents("work"))?.length === 7, "applied without asking");
  await until(
    () => noticeText().includes('bookmarks.toml: 3 bookmarks removed from "work"'),
    "said how many",
  );
  await reset();
});

add_task(async function a_table_over_a_folder_with_bookmarks_asks_before_deleting_them() {
  const folder = await PlacesUtils.bookmarks.insert({
    parentGuid: toolbarGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "work",
  });
  for (const t of ["keep", "mine"]) {
    await PlacesUtils.bookmarks.insert({
      parentGuid: folder.guid,
      url: `https://example.com/${t}`,
      title: t,
    });
  }
  await writeFile('[bookmarks.work]\n"keep" = "https://example.com/keep"');
  await until(
    () =>
      promptOpen() &&
      promptText() ===
        'bookmarks.toml takes over "work": delete its 1 bookmark the file lacks? y/N',
    "asked before deleting even one",
  );
  await answer("KEY_Escape");
  await until(() => !promptOpen(), "Esc says no");
  Assert.deepEqual(
    await folderContents("work"),
    ["keep https://example.com/keep", "mine https://example.com/mine"],
    "nothing deleted",
  );
  await writeFile('[bookmarks.work]\n"keep" = "https://example.com/keep"\n# yes now');
  await until(() => promptOpen(), "asked again");
  await answer("y");
  await untilFolder("work", ["keep https://example.com/keep"], "taken over");
  Assert.equal((await topFolder("work"))?.guid, folder.guid, "the same folder, adopted");
  await reset();
});

add_task(async function write_back_none_refuses_vimma_keys_and_puts_library_changes_back() {
  const ww = WindowWorkspaces.get(window);
  const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === ww?.model?.active);
  Assert.ok(def, "the window shows a workspace");
  const name = /** @type {{ name: string }} */ (def).name;
  await writeFile(`[bookmarks.${JSON.stringify(name)}]\n"a" = "https://example.com/a"`);
  await untilFolder(name, ["a https://example.com/a"], "the workspace's folder is mirrored");

  // The Library: an add and a rename, put back a burst later, with a notice.
  const folder = /** @type {Node} */ (await topFolder(name));
  await PlacesUtils.bookmarks.insert({
    parentGuid: folder.guid,
    url: "https://example.com/x",
    title: "x",
  });
  const [a] = /** @type {Node[]} */ (
    (await PlacesUtils.promiseBookmarksTree(folder.guid))?.children ?? []
  );
  await PlacesUtils.bookmarks.update({ guid: a.guid, title: "renamed" });
  await untilFolder(name, ["a https://example.com/a"], "put back from the file");
  await until(
    () =>
      noticeText().includes(`bookmarks.toml: Firefox change to ${JSON.stringify(name)} put back`),
    "said once for the burst",
  );

  // Vimma's keys refuse in the mirrored folder.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?quickadd`);
  await runCommand("bookmark docs/page");
  await until(
    () =>
      noticeText().includes("bookmarks.toml is read-only: edit the file to change these bookmarks"),
    ":bookmark refuses",
  );
  Assert.deepEqual(await folderContents(name), ["a https://example.com/a"], "nothing added");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

add_task(async function a_renamed_moved_or_deleted_workspace_folder_is_put_back() {
  // The window's workspace: its folder is linked to it, so it is trusted wherever it goes.
  const ww = WindowWorkspaces.get(window);
  const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === ww?.model?.active);
  const name = /** @type {{ name: string }} */ (def).name;
  await writeFile(`[bookmarks.${JSON.stringify(name)}]\n"a" = "https://example.com/a"`);
  await untilFolder(name, ["a https://example.com/a"], "loaded");
  const guid = /** @type {Node} */ (await topFolder(name)).guid;
  await PlacesUtils.bookmarks.update({ guid, title: "job" });
  await until(async () => (await topFolder(name))?.guid === guid, "renamed back");
  await PlacesUtils.bookmarks.update({ guid, parentGuid: menuGuid, index: 0 });
  await until(async () => (await topFolder(name))?.guid === guid, "moved back to the toolbar");
  await PlacesUtils.bookmarks.remove(guid);
  await untilFolder(name, ["a https://example.com/a"], "deleted: made again from the file");
  await reset();
});

add_task(async function a_library_change_during_an_apply_is_handled_by_the_closing_compare() {
  // A mirror of its own whose apply lets a Library change land in the middle of it.
  const own = PathUtils.join(dir, "race");
  await IOUtils.makeDirectory(own);
  const base = PathUtils.join(own, "base.json");
  const race = new BookmarksFileImpl({
    configPath: () => PathUtils.join(own, "config.toml"),
    basePath: base,
    enabled: () => true,
    initComplete: () => Promise.resolve(),
    say: () => {},
    mirrored: () => {},
  });
  await writeFile(
    '[bookmarks.race]\n"a" = "https://example.com/a"',
    PathUtils.join(own, "bookmarks.toml"),
  );
  const apply = race.apply.bind(race);
  let once = true;
  race.apply = async (/** @type {Parameters<typeof apply>[0]} */ ops) => {
    await apply(ops);
    if (once) {
      once = false;
      const f = /** @type {Node} */ (await topFolder("race"));
      await PlacesUtils.bookmarks.insert({
        parentGuid: f.guid,
        url: "https://example.com/l",
        title: "l",
      });
    }
  };
  race.start();
  race.configRead(null);
  await until(() => race.ready, "started");
  await race.settledRuns();
  Assert.deepEqual(
    await folderContents("race"),
    ["a https://example.com/a"],
    "the Library's add during the apply is put back by the same run",
  );
  race.stop();
  await IOUtils.remove(base, { ignoreAbsent: true });
  await reset();
});

add_task(
  async function the_first_run_waits_for_places_browser_init_and_config_toml_and_asks_before_adopting() {
    const own = PathUtils.join(dir, "boot");
    await IOUtils.makeDirectory(own);
    const base = PathUtils.join(own, "base.json");
    // A restored backup brought an old bookmark into the folder.
    const folder = await PlacesUtils.bookmarks.insert({
      parentGuid: toolbarGuid,
      type: PlacesUtils.bookmarks.TYPE_FOLDER,
      title: "boot",
    });
    await PlacesUtils.bookmarks.insert({
      parentGuid: folder.guid,
      url: "https://example.com/old",
      title: "old",
    });
    await writeFile(
      '[bookmarks.boot]\n"new" = "https://example.com/new"',
      PathUtils.join(own, "bookmarks.toml"),
    );
    /** @type {() => void} */
    let done = () => {};
    /** @type {string[]} */
    const asked = [];
    const boot = new BookmarksFileImpl({
      configPath: () => PathUtils.join(own, "config.toml"),
      basePath: base,
      enabled: () => true,
      initComplete: () => new Promise((r) => (done = () => r(undefined))),
      say: () => {},
      ask: (/** @type {BrowserWindow | null} */ _win, /** @type {string} */ q) => {
        asked.push(q);
        return null;
      },
      mirrored: () => {},
    });
    boot.start();
    await new Promise((r) => setTimeout(r, 300));
    Assert.ok(!boot.ready, "waits for places-browser-init-complete");
    Assert.deepEqual(await folderContents("boot"), ["old https://example.com/old"], "untouched");
    done();
    await new Promise((r) => setTimeout(r, 300));
    Assert.ok(!boot.ready, "and for config.toml's first read, which may hold inline tables");
    boot.configRead(null);
    await until(() => boot.ready, "started");
    await boot.settledRuns();
    // A folder the base never held, even one a restored backup brought, is never emptied
    // without a question.
    Assert.deepEqual(
      asked,
      ['bookmarks.toml takes over "boot": delete its 1 bookmark the file lacks? y/N'],
      "asked before deleting the restored bookmark",
    );
    Assert.deepEqual(await folderContents("boot"), ["old https://example.com/old"], "untouched");
    boot.stop();
    await IOUtils.remove(base, { ignoreAbsent: true });
    await reset();
  },
);

add_task(async function separators_keep_their_place_through_a_reorder() {
  await writeFile(
    '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n"c" = "https://example.com/c"',
  );
  await untilFolder(
    "work",
    ["a https://example.com/a", "b https://example.com/b", "c https://example.com/c"],
    "loaded",
  );
  const folder = /** @type {Node} */ (await topFolder("work"));
  await PlacesUtils.bookmarks.insert({
    parentGuid: folder.guid,
    type: PlacesUtils.bookmarks.TYPE_SEPARATOR,
    index: 1,
  });
  await mirror.settledRuns();
  await new Promise((r) => setTimeout(r, 500));
  await mirror.settledRuns();
  await writeFile(
    '[bookmarks.work]\n"c" = "https://example.com/c"\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"',
  );
  await untilFolder(
    "work",
    ["c https://example.com/c", "a https://example.com/a", "---", "b https://example.com/b"],
    "the separator stays after a",
  );
  await reset();
});

add_task(async function javascript_lines_wait_for_bookmarklets_and_data_lines_never_reach_places() {
  // A config.toml with an error does not apply, so its `bookmarklets = "user"` allows nothing.
  await IOUtils.writeUTF8(
    configFile,
    'schema = 2\n[bookmarks]\nbookmarklets = "user"\n[keys]\nnew_tab = "nosuchkey+"\n',
  );
  await ConfigHost.reload();
  Assert.ok(ConfigHost.errors.length > 0, "that config.toml has an error");
  await writeFile(
    '[bookmarks.work]\n"run" = "javascript:void(1)"\n"page" = "https://example.com/"',
  );
  await untilFolder("work", ["page https://example.com/"], "the bookmarklet is not added");
  await until(
    () => noticeText().includes('bookmarks.toml:2: bookmarklet not added (bookmarklets = "none")'),
    "said once, with its line",
  );
  await IOUtils.writeUTF8(configFile, 'schema = 2\n[bookmarks]\nbookmarklets = "user"\n');
  await ConfigHost.reload();
  await untilFolder(
    "work",
    ["run javascript:void(1)", "page https://example.com/"],
    "added once bookmarklets are allowed",
  );
  await writeFile('[bookmarks.work]\n"d" = "data:text/html,<b>x</b>"');
  await until(() => errorSegment().includes("data: URLs are never added"), "data: is an error");
  Assert.deepEqual(
    await folderContents("work"),
    ["run javascript:void(1)", "page https://example.com/"],
    "and nothing applies",
  );
  await reset();
});

add_task(async function bookmarks_outside_mirrored_folders_are_untouched() {
  const outside = [
    await PlacesUtils.bookmarks.insert({
      parentGuid: menuGuid,
      url: "https://example.com/m",
      title: "m",
    }),
    await PlacesUtils.bookmarks.insert({
      parentGuid: unfiledGuid,
      url: "https://example.com/o",
      title: "o",
    }),
    await PlacesUtils.bookmarks.insert({
      parentGuid: toolbarGuid,
      url: "https://example.com/t",
      title: "t",
    }),
  ];
  const home = await PlacesUtils.bookmarks.insert({
    parentGuid: toolbarGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "home",
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: home.guid,
    url: "https://example.com/h",
    title: "h",
  });
  PlacesUtils.tagging.tagURI(Services.io.newURI("https://example.com/m"), ["tagged"]);
  await writeFile('[bookmarks.work]\n"a" = "https://example.com/a"');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  await writeFile("[bookmarks.work]\n");
  await untilFolder("work", [], "emptied");
  for (const b of outside) {
    Assert.ok(await PlacesUtils.bookmarks.fetch(b.guid), `${b.title} is still there`);
  }
  Assert.deepEqual(
    await folderContents("home"),
    ["h https://example.com/h"],
    "a folder without a table",
  );
  Assert.deepEqual(
    PlacesUtils.tagging.getTagsForURI(Services.io.newURI("https://example.com/m")),
    ["tagged"],
    "tags",
  );
  PlacesUtils.tagging.untagURI(Services.io.newURI("https://example.com/m"), ["tagged"]);
  await reset();
});

add_task(async function bookmarks_5000_load_and_a_one_line_edit_apply_within_budget() {
  const t0 = Date.now();
  await writeFile(`[bookmarks.big]\n${lines(5000)}`);
  const long = (/** @type {() => Promise<boolean>} */ cond, /** @type {string} */ msg) =>
    TestUtils.waitForCondition(cond, msg, 100, 600);
  await long(async () => (await folderContents("big"))?.length === 5000, "5000 loaded");
  const load = Date.now() - t0;
  const t1 = Date.now();
  await writeFile(`[bookmarks.big]\n${lines(5000).replace('"b0" =', '"first" =')}`);
  await long(
    async () => (await folderContents("big"))?.[0] === "first https://example.com/0",
    "one line",
  );
  const edit = Date.now() - t1;
  info(`5000 bookmarks: load ${Math.round(load)} ms, one-line edit ${Math.round(edit)} ms`);
  // Budgets with headroom over the times measured on a CI runner, so a slow runner passes and a
  // run per bookmark (seconds per edit) fails.
  Assert.less(load, 60000, "the load fits its budget");
  Assert.less(edit, 10000, "a one-line edit fits its budget");
  await mirror.forget();
  await reset();
});

/** ctrl+b, then `key`. */
function prefix(/** @type {string} */ key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key);
}

const workspaceNamed = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);

/** `:wsnew name`, switched to. */
async function newWorkspace(/** @type {string} */ name) {
  await runCommand(`wsnew ${name}`);
  await until(
    () => WindowWorkspaces.get(window)?.model?.active === workspaceNamed(name)?.id,
    `created and switched to ${name}`,
  );
}

add_task(async function the_panel_and_the_move_rename_prompt_refuse_in_a_mirrored_folder() {
  await writeFile('[bookmarks.work]\n"docs/a" = "https://example.com/?mirrored"');
  await untilFolder("work", [{ "docs/": ["a https://example.com/?mirrored"] }], "loaded");
  const folder = /** @type {Node} */ (await topFolder("work"));
  const tree = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(folder.guid));
  const docs = /** @type {Node} */ (tree.children?.[0]);
  const a = /** @type {Node} */ (docs.children?.[0]);
  /** @type {string[]} */
  const said = [];
  let prompts = 0;
  const ctx = {
    win: window,
    say: (/** @type {string} */ t) => said.push(t),
    panel: {
      tree: { guid: folder.guid, kind: "folder", title: "work", children: [] },
      isOpen: true,
    },
    prompt: {
      prompt: () => ++prompts > 0,
      ask: () => ++prompts > 0,
    },
  };
  for (const effect of [
    { type: "add", folder: docs.guid },
    { type: "add_folder", folder: folder.guid },
    { type: "rename", guid: a.guid, title: "a" },
    { type: "move", guid: a.guid, from: docs.guid },
    { type: "delete", guid: a.guid, kind: "bookmark", title: "a", count: 0 },
  ]) {
    runBookmarkEffect(
      /** @type {Parameters<typeof runBookmarkEffect>[0]} */ (/** @type {unknown} */ (ctx)),
      /** @type {Parameters<typeof runBookmarkEffect>[1]} */ (effect),
    );
  }
  await until(() => said.length === 5, "a, A, r, m and d each refused");
  Assert.ok(
    said.every((t) => t === "bookmarks.toml is read-only: edit the file to change these bookmarks"),
    "with the read-only refusal",
  );
  Assert.equal(prompts, 0, "and no prompt opened");

  // The move/rename prompt of a page already bookmarked there.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?mirrored`);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  prefix("a");
  await until(
    () => noticeText().includes("already bookmarked:") && noticeText().includes("read-only"),
    "already bookmarked, and read-only",
  );
  Assert.ok(!promptOpen(), "no move/rename prompt");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

add_task(async function wsrename_keeps_the_table_folder_and_wsdelete_keeps_a_mirrored_folder() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?ws`);
  await newWorkspace("filed");
  await writeFile('[bookmarks.filed]\n"a" = "https://example.com/a"');
  await untilFolder("filed", ["a https://example.com/a"], "the workspace's folder is mirrored");
  const guid = /** @type {Node} */ (await topFolder("filed")).guid;
  await runCommand("wsrename kept");
  await until(() => !!workspaceNamed("kept"), "renamed");
  await new Promise((r) => setTimeout(r, 500));
  await mirror.settledRuns();
  Assert.equal(
    (await PlacesUtils.bookmarks.fetch(guid))?.title,
    "filed",
    "the folder keeps the table's name",
  );
  await runCommand("wsdelete kept");
  await until(() => promptOpen(), "asked to close it");
  EventUtils.synthesizeKey("y");
  await until(
    () => noticeText().includes("bookmarks.toml keeps its bookmarks"),
    "closed without the bookmarks question",
  );
  Assert.deepEqual(await folderContents("filed"), ["a https://example.com/a"], "the folder stays");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

add_task(async function wsdelete_offers_no_move_into_a_mirrored_folder() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?wsm`);
  await newWorkspace("leaving");
  const leaving = /** @type {{ id: string }} */ (workspaceNamed("leaving"));
  const first = WorkspaceStore.definitions.workspaces.find((d) => d.id !== leaving.id);
  const firstName = /** @type {{ name: string }} */ (first).name;
  await writeFile(`[bookmarks.${JSON.stringify(firstName)}]\n"a" = "https://example.com/a"`);
  await untilFolder(firstName, ["a https://example.com/a"], "the other workspace is mirrored");
  const own = await PlacesUtils.bookmarks.insert({
    parentGuid: toolbarGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "leaving",
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: own.guid,
    url: "https://example.com/l",
    title: "l",
  });
  await runCommand("wsdelete leaving");
  await until(() => promptOpen(), "asked to close it");
  EventUtils.synthesizeKey("y");
  await until(
    () => promptOpen() && promptText().includes("k keep the folder"),
    "asked about its bookmarks",
  );
  Assert.ok(!promptText().includes("m move"), "no move into the mirrored folder");
  EventUtils.synthesizeKey("KEY_Escape");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

add_task(async function the_question_waits_for_the_command_line_and_ignores_an_early_key() {
  await writeFile(`[bookmarks.work]\n${lines(25)}`);
  await until(async () => (await folderContents("work"))?.length === 25, "25 loaded");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?busy`);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await until(() => VimmaHost.promptBusy(window), "the command line is open");
  await writeFile("[bookmarks.work]\n");
  await new Promise((r) => setTimeout(r, 1000));
  Assert.ok(!promptOpen(), "the question does not replace the command line");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(
    () => promptOpen() && promptText().startsWith("bookmarks.toml removes 25 bookmarks"),
    "asked once the command line closed",
  );
  EventUtils.synthesizeKey("y");
  Assert.ok(promptOpen(), "a key as it appears is not an answer");
  await new Promise((r) => setTimeout(r, 500));
  // Another question takes the line: this one is no, and applies nothing.
  VimmaHost.ask(
    window,
    "something else? y/N",
    () => {},
    () => {},
  );
  await until(() => noticeText().includes("not applied"), "replaced, it counts as no");
  EventUtils.synthesizeKey("KEY_Escape");
  await mirror.settledRuns();
  Assert.equal((await folderContents("work"))?.length, 25, "nothing deleted");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

add_task(async function bookmarks_forget_lasts_across_a_restart_until_the_file_changes() {
  const own = PathUtils.join(dir, "restart");
  await IOUtils.makeDirectory(own);
  const base = PathUtils.join(own, "base.json");
  const file = PathUtils.join(own, "bookmarks.toml");
  /** @type {string[]} */
  const asked = [];
  const make = () =>
    new BookmarksFileImpl({
      configPath: () => PathUtils.join(own, "config.toml"),
      basePath: base,
      enabled: () => true,
      initComplete: () => Promise.resolve(),
      say: () => {},
      ask: (/** @type {BrowserWindow | null} */ _win, /** @type {string} */ q) => {
        asked.push(q);
        return null;
      },
      mirrored: () => {},
    });
  await writeFile('[bookmarks.again]\n"a" = "https://example.com/a"', file);
  const first = make();
  first.start();
  first.configRead(null);
  await until(() => first.ready, "started");
  await first.settledRuns();
  await untilFolder("again", ["a https://example.com/a"], "mirrored");
  await first.forget();
  first.stop();
  // A Library change and a restart: still forgotten, nothing put back.
  const folder = /** @type {Node} */ (await topFolder("again"));
  await PlacesUtils.bookmarks.insert({
    parentGuid: folder.guid,
    url: "https://example.com/l",
    title: "l",
  });
  const second = make();
  second.start();
  second.configRead(null);
  await until(() => second.ready, "restarted");
  await second.tick(true);
  await second.settledRuns();
  Assert.deepEqual(
    await folderContents("again"),
    ["a https://example.com/a", "l https://example.com/l"],
    "forgotten across the restart: nothing put back",
  );
  Assert.deepEqual(asked, [], "and nothing asked");
  // The file's content changes: the mirror starts again, as a first load.
  await writeFile(
    '[bookmarks.again]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"',
    file,
  );
  await second.tick(true);
  await second.settledRuns();
  Assert.deepEqual(
    asked,
    ['bookmarks.toml takes over "again": delete its 1 bookmark the file lacks? y/N'],
    "back on, it takes the folder over and asks",
  );
  second.stop();
  await IOUtils.remove(own, { recursive: true, ignoreAbsent: true });
  await reset();
});

add_task(async function the_question_waits_while_a_page_field_has_focus() {
  await writeFile(`[bookmarks.work]\n${lines(25)}`);
  await until(async () => (await folderContents("work"))?.length === 25, "25 loaded");
  const fieldPage =
    getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
    "file_vimma_insert_scroll.html";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, fieldPage);
  await focusContent(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    /** @type {HTMLInputElement} */ (content.document.getElementById("text")).focus();
  });
  await until(() => VimmaHost.status(window).mode === "insert", "typing in the page");
  await writeFile("[bookmarks.work]\n");
  await new Promise((r) => setTimeout(r, 1500));
  Assert.ok(!promptOpen(), "the question does not take the keys from a page field");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => promptOpen(), "asked once the field is left");
  await answer("n");
  await until(() => noticeText().includes("not applied"), "n applies nothing");
  BrowserTestUtils.removeTab(tab);
  await reset();
});

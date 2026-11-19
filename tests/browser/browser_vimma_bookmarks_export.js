/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarks-file.md, Behaviour 17 and Delivery slice 4: `:bookmarks export`
// writes Places' workspace folders as a new bookmarks.toml (0600) and opens it; it never replaces
// an existing file without `!`, which asks and keeps the old file as bookmarks.toml.bak; a
// private window exports nothing; Tab completes `export`, `export!` and `forget` while the
// feature is on.

"use strict";

/* global focusContent -- from head.js */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
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

const { toolbarGuid, menuGuid, unfiledGuid } = PlacesUtils.bookmarks;
const dir = PathUtils.join(PathUtils.tempDir, `vimma-bookmarks-export-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");
const bookmarksFile = PathUtils.join(dir, "bookmarks.toml");
const backupFile = PathUtils.join(dir, "bookmarks.toml.bak");
const mirror = ConfigHost.bookmarksFile;
const SECOND = "export two";

/**
 * A node of PlacesUtils.promiseBookmarksTree: the fields read here.
 * @typedef {{ guid: string, typeCode?: number, title?: string, uri?: string,
 *   children?: Node[] }} Node
 */

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/** The notice shown now: a hidden one keeps its last text, which an earlier task may have left. */
const noticeText = () => {
  const el = document.getElementById("vimma-notice");
  return el?.matches(":popover-open") ? (el.textContent ?? "") : "";
};
const promptEl = () => document.getElementById("vimma-rename");
const promptOpen = () => !!promptEl() && !(/** @type {HTMLElement} */ (promptEl()).hidden);
const promptText = () =>
  promptEl()?.querySelector(".vimma-cmdline-prompt")?.textContent?.trim() ?? "";
const cmdInput = () =>
  /** @type {HTMLInputElement} */ (document.querySelector("#vimma-cmdline input"));
const options = () => [...document.querySelectorAll("#vimma-cmdline [role=option]")];

/** The window's workspaces. */
const liveWorkspaces = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));

/** The name of the workspace this window shows. */
function activeName() {
  const def = WorkspaceStore.definitions.workspaces.find(
    (d) => d.id === liveWorkspaces().model.active,
  );
  return /** @type {{ name: string }} */ (def).name;
}

/** Opens the command line and types `line` without running it. */
async function typeCommand(/** @type {string} */ line) {
  await focusContent(gBrowser.selectedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
}

/** Runs `:line` in the selected tab. */
async function runCommand(/** @type {string} */ line) {
  await typeCommand(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** Waits until the mirror has made the top-level toolbar folder `name`. */
async function untilTopFolder(/** @type {string} */ name) {
  await until(async () => {
    const bar = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(toolbarGuid));
    return (bar.children ?? []).some((c) => c.typeCode === 2 && c.title === name);
  }, `the mirror made ${name}`);
  await mirror.settledRuns();
}

/** Removes every bookmark these tests made, the files, and drops the mirror's base. */
async function reset() {
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  await mirror.forget();
  await IOUtils.remove(bookmarksFile, { ignoreAbsent: true });
  await IOUtils.remove(backupFile, { ignoreAbsent: true });
  await IOUtils.writeUTF8(configFile, "schema = 2\n");
  await ConfigHost.reload();
  await mirror.forget();
  for (const parent of [toolbarGuid, menuGuid, unfiledGuid]) {
    const tree = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(parent));
    for (const c of tree.children ?? []) await PlacesUtils.bookmarks.remove(c.guid);
  }
  await mirror.settledRuns();
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
}

/**
 * Two workspaces' folders at the toolbar's top (linked by name, bookmarks decision 11), a loose
 * toolbar bookmark and one in the Menu, which an export leaves out.
 */
async function twoWorkspaces() {
  const name = activeName();
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [
      {
        title: name,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [
          { title: "Calendar", url: "https://calendar.example.com" },
          {
            title: "docs",
            type: PlacesUtils.bookmarks.TYPE_FOLDER,
            children: [
              { title: "Vimma guide", url: "https://vimma.dev/docs" },
              { type: PlacesUtils.bookmarks.TYPE_SEPARATOR },
              { title: "Firefox source", url: "https://searchfox.org/" },
            ],
          },
          { title: "", url: "https://untitled.example/" },
        ],
      },
      {
        title: SECOND,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [
          { title: "Cart", url: "https://shop.example/cart" },
          { title: "tool", url: "javascript:void(document.title)" },
        ],
      },
      { title: "loose", url: "https://loose.example/" },
    ],
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: menuGuid,
    url: "https://menu.example/",
    title: "menu",
  });
  return name;
}

add_task(async function setup() {
  await liveWorkspaces().ready;
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
  const second = WorkspaceStore.newWorkspace(SECOND);
  registerCleanupFunction(async () => {
    await reset();
    await WorkspaceStore.deleteWorkspace(second.id, { confirmed: true });
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await reset();
});

add_task(async function export_writes_one_table_per_workspace_and_opens_it() {
  const name = await twoWorkspaces();
  const tabs = gBrowser.tabs.length;
  await runCommand("bookmarks export");
  await until(() => noticeText().startsWith("bookmarks.toml written"), "export says so");
  Assert.equal(
    noticeText(),
    `bookmarks.toml written: 6 bookmarks in ${JSON.stringify(name)}, ${JSON.stringify(
      SECOND,
    )}; left out: 2 outside workspace folders; 1 renamed in Firefox to match`,
    "what was written, left out and renamed",
  );
  const text = await IOUtils.readUTF8(bookmarksFile);
  const header = (/** @type {string} */ n) =>
    /^[A-Za-z0-9_-]+$/.test(n) ? `[bookmarks.${n}]` : `[bookmarks.${JSON.stringify(n)}]`;
  Assert.stringContains(
    text,
    [
      header(name),
      '"Calendar" = "https://calendar.example.com/"',
      '"docs/Vimma guide" = "https://vimma.dev/docs"',
      '"docs/Firefox source" = "https://searchfox.org/"',
      '"https:\\\\/\\\\/untitled.example\\\\/" = "https://untitled.example/"',
      "",
      header(SECOND),
      '"Cart" = "https://shop.example/cart"',
      '"tool" = "javascript:void(document.title)"',
      "",
    ].join("\n"),
    "one table per workspace, in Places order, a bookmarklet included",
  );
  Assert.ok(!text.includes("loose") && !text.includes("menu"), "nothing outside them");
  Assert.equal((await IOUtils.stat(bookmarksFile)).permissions, 0o600, "created 0600");
  await until(() => gBrowser.tabs.length === tabs + 1, "opened in a tab");
  const shown = `view-source:${PathUtils.toFileURI(bookmarksFile)}`;
  await until(
    () => gBrowser.selectedBrowser.currentURI.spec === shown,
    "read-only, as :config opens config.toml",
  );
  // The mirror then reads the file: nothing changes in Places but the written name, and nothing
  // is asked (the folders hold exactly what the file does).
  await mirror.settledRuns();
  await new Promise((r) => setTimeout(r, 400));
  await mirror.settledRuns();
  Assert.ok(!promptOpen(), "no question");
  const untitled = await PlacesUtils.bookmarks.fetch({ url: "https://untitled.example/" });
  Assert.equal(untitled?.title, "https://untitled.example/", "Places got the written name");
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), text, "the mirror wrote nothing more");
  Assert.ok(
    !!(await PlacesUtils.bookmarks.fetch({ url: "javascript:void(document.title)" })),
    "the bookmarklet stays in Places, though bookmarklets are off",
  );
  await reset();
});

add_task(async function a_data_bookmark_is_left_out_and_never_deleted() {
  const name = activeName();
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [
      {
        title: name,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [
          { title: "page", url: "data:text/html,<b>x</b>" },
          { title: "a", url: "https://a.example/" },
        ],
      },
    ],
  });
  await runCommand("bookmarks export");
  await until(() => noticeText().startsWith("bookmarks.toml written"), "export says so");
  Assert.stringContains(noticeText(), "1 data: URL", "the data: bookmark is counted");
  Assert.ok(!(await IOUtils.readUTF8(bookmarksFile)).includes("data:"), "and not written");
  // The mirror's first run then asks before it deletes what the file lacks (Behaviour 18).
  await until(() => promptOpen(), "the takeover asks");
  Assert.stringContains(promptText(), "delete its 1 bookmark the file lacks? y/N", "about it");
  await new Promise((r) => setTimeout(r, 1200));
  EventUtils.synthesizeKey("n");
  await mirror.settledRuns();
  Assert.ok(
    !!(await PlacesUtils.bookmarks.fetch({ url: "data:text/html,<b>x</b>" })),
    "n keeps it in Places",
  );
  await reset();
});

add_task(async function export_refuses_an_existing_file_and_export_bang_replaces_it_after_yes() {
  const name = await twoWorkspaces();
  const old = '[bookmarks.old]\n"x" = "https://x.example/"\n';
  await IOUtils.writeUTF8(bookmarksFile, old);
  await IOUtils.setPermissions(bookmarksFile, 0o640);
  await untilTopFolder("old");

  await runCommand("bookmarks export");
  await until(() => noticeText().includes("exists"), "refused");
  Assert.equal(
    noticeText(),
    'bookmarks.toml exists (1 bookmark in "old"); :bookmarks export! replaces it',
    "says what ! replaces",
  );
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), old, "untouched without !");

  await runCommand("bookmarks export!");
  await until(() => promptOpen(), "export! asks");
  Assert.equal(
    promptText(),
    'replace bookmarks.toml (1 bookmark in "old") with 7 bookmarks from Firefox, keeping the old file as bookmarks.toml.bak? y/N',
    "the question says what it replaces",
  );
  EventUtils.synthesizeKey("n");
  await until(() => noticeText().includes("kept"), "n keeps it");
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), old, "untouched after n");
  Assert.ok(!(await IOUtils.exists(backupFile)), "and no backup");

  await runCommand("bookmarks export!");
  await until(() => promptOpen(), "asked again");
  EventUtils.synthesizeKey("y");
  await until(() => noticeText().startsWith("bookmarks.toml written"), "replaced after y");
  Assert.stringContains(
    noticeText(),
    "the old file is bookmarks.toml.bak",
    "the notice says where the old file is",
  );
  const text = await IOUtils.readUTF8(bookmarksFile);
  Assert.stringContains(text, '"Calendar" = "https://calendar.example.com/"', "the export");
  // The mirrored table has no workspace, yet its folder is exported: a table left out would
  // make the mirror delete its bookmarks.
  Assert.stringContains(text, '[bookmarks.old]\n"x" = "https://x.example/"\n', "old stays");
  Assert.equal(await IOUtils.readUTF8(backupFile), old, "and kept in the backup");
  Assert.equal((await IOUtils.stat(backupFile)).permissions, 0o600, "the backup is 0600");
  Assert.equal((await IOUtils.stat(bookmarksFile)).permissions, 0o640, "its mode kept");
  Assert.ok(name, "exported the start workspace");
  await reset();
});

add_task(async function a_file_changed_while_export_bang_asks_is_not_replaced() {
  await twoWorkspaces();
  const old = '[bookmarks.old]\n"x" = "https://x.example/"\n';
  await IOUtils.writeUTF8(bookmarksFile, old);
  await untilTopFolder("old");
  await runCommand("bookmarks export!");
  await until(() => promptOpen(), "export! asks");
  const edited = `${old}"y" = "https://y.example/"\n`;
  await IOUtils.writeUTF8(bookmarksFile, edited);
  EventUtils.synthesizeKey("y");
  await until(() => noticeText().includes("changed meanwhile"), "refused after y");
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), edited, "the edit is kept");
  await reset();
});

add_task(async function a_private_window_does_not_export() {
  await twoWorkspaces();
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  Assert.equal(
    await ConfigHost.bookmarksExport(priv, false),
    "bookmarks.toml is not written from a private window",
    "export refuses there",
  );
  Assert.ok(!(await IOUtils.exists(bookmarksFile)), "no file");
  await BrowserTestUtils.closeWindow(priv);
  await reset();
});

add_task(async function tab_completes_export_and_forget_while_the_feature_is_on() {
  await typeCommand("bookmarks ");
  await until(() => options().length >= 3, "the words are listed");
  Assert.deepEqual(
    options().map((o) => /** @type {HTMLElement} */ (o).dataset.value),
    ["bookmarks export", "bookmarks export!", "bookmarks forget"],
    "export, export! and forget",
  );
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(cmdInput().value, "bookmarks export", "Tab completes the first");
  EventUtils.synthesizeKey("KEY_Escape");

  await SpecialPowers.pushPrefEnv({ set: [["vimma.feature.bookmarksFile", false]] });
  await typeCommand("bookmarks ");
  Assert.equal(options().length, 0, "nothing while the feature is off");
  EventUtils.synthesizeKey("KEY_Escape");
  await runCommand("bookmarks export");
  await until(() => noticeText().includes("takes no argument"), "and export is no command");
  Assert.ok(!(await IOUtils.exists(bookmarksFile)), "no file");
  await SpecialPowers.popPrefEnv();
  await reset();
});

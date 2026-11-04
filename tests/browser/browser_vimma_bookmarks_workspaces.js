/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarks.md, decisions 11 and 12. Each
// workspace owns a folder in the Bookmarks Toolbar, linked by its Places guid: the bookmarks
// panel shows the current workspace's folder, ctrl+b a and :bookmark file there (`@name/` in
// another's), a rename renames the folder, and deleting a workspace asks what becomes of it.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore, WorkspaceStoreImpl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ContextualIdentityService: CIS } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const { toolbarGuid, menuGuid } = PlacesUtils.bookmarks;
const startIds = new Set(CIS.getPublicIdentities().map((i) => i.userContextId));
/** @type {string[]} */
const files = [];

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const ww = () => WindowWorkspaces.get(window);
const active = () => ww().model.active;

const panel = () => document.getElementById("vimma-bookmarks");
const isOpen = () => !!panel() && !panel().hidden && BrowserTestUtils.isVisible(panel());
const rows = () => [...(panel()?.querySelectorAll("[role=treeitem]") ?? [])];
const title = (row) => row?.querySelector(".vimma-panel-title")?.textContent ?? "";
const titles = () => rows().map(title);
const selected = () => panel()?.querySelector("[role=treeitem][aria-selected=true]") ?? null;
const header = () => panel()?.querySelector(".vimma-panel-name")?.textContent ?? "";
const emptyState = () => panel()?.querySelector(".vimma-bookmarks-empty") ?? null;
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const promptEl = () => document.getElementById("vimma-rename");
const promptInput = () => document.getElementById("vimma-rename-input");
const promptOpen = () => !!promptEl() && !promptEl().hidden;
const promptText = () => promptEl().querySelector(".vimma-cmdline-prompt").textContent.trim();

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

async function focusPage() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
}

async function runCommand(line) {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** :wsnew `name`, shown, its start page loaded. */
async function create(name) {
  await runCommand(`wsnew ${name}`);
  await until(() => def(name) && active() === def(name).id, `created and switched to ${name}`);
  const browser = gBrowser.selectedBrowser;
  await until(
    () => browser.currentURI.spec === START && browser.contentDocument?.readyState === "complete",
    "the start page has loaded",
  );
  return def(name);
}

async function switchTo(name) {
  ww().switchTo({ id: def(name).id });
  await until(() => active() === def(name).id, `switched to ${name}`);
}

/** Loads `${PAGE}?<query>` titled `query` in the selected tab. */
async function loadPage(query) {
  const browser = gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, `${PAGE}?${query}`);
  await BrowserTestUtils.browserLoaded(browser, false, `${PAGE}?${query}`);
  await SpecialPowers.spawn(browser, [query], (t) => {
    content.document.title = t;
  });
  await until(() => browser.contentTitle === query, "the page has its title");
}

async function openPanel() {
  await focusPage();
  prefix("B", { shiftKey: true });
  await until(isOpen, "ctrl+b shift+b opens the bookmarks panel");
}

async function closePanel() {
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  while (isOpen()) {
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !isOpen(), "Esc");
  }
}

async function highlight(name) {
  await until(() => titles().includes(name), `${name} is listed`);
  const target = titles().indexOf(name);
  const now = rows().indexOf(selected());
  const key = target > now ? "j" : "k";
  for (let i = 0; i < Math.abs(target - now); i++) EventUtils.synthesizeKey(key);
  await until(() => title(selected()) === name, `${name} is highlighted`);
}

/** The toolbar's top folder titled `name`. */
async function toolbarFolder(name) {
  const tree = await PlacesUtils.promiseBookmarksTree(toolbarGuid);
  return (tree.children ?? []).find((c) => c.title === name && c.children) ?? null;
}

/** The folder titles from the toolbar down to `url`'s bookmark, or null. */
async function placeOf(url) {
  const bm = await PlacesUtils.bookmarks.fetch({ url }, null, { includePath: true });
  return bm ? bm.path.map((p) => p.title) : null;
}

registerCleanupFunction(async () => {
  VimmaHost.configure({ bookmarksRoot: "workspace" });
  await closePanel();
  ww().switchTo({ id: def("main").id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  WorkspaceStore.setBookmarksFolder(def("main").id, null);
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.history.clear();
  const bookmarks = VimmaHost._state(window).bookmarks;
  bookmarks.expanded = [];
  bookmarks.lastGuid = null;
  for (const f of files) await IOUtils.remove(f, { ignoreAbsent: true });
  for (const i of CIS.getPublicIdentities()) {
    if (!startIds.has(i.userContextId)) CIS.remove(i.userContextId);
  }
});

add_task(async function setup() {
  await WindowWorkspaces.get(window).ready;
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [
      {
        title: "main",
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [{ title: "Main page", url: `${PAGE}?mainpage` }],
      },
      {
        title: "work",
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [
          {
            title: "docs",
            type: PlacesUtils.bookmarks.TYPE_FOLDER,
            children: [{ title: "MDN", url: `${PAGE}?mdn` }],
          },
          { title: "Jira", url: `${PAGE}?jira` },
        ],
      },
      { title: "Loose", url: `${PAGE}?loose` },
    ],
  });
  await PlacesUtils.bookmarks.insert({ parentGuid: menuGuid, title: "Menu", url: `${PAGE}?menu` });
  Assert.equal(def("main").id, active(), "the window shows main");
});

add_task(async function each_workspace_sees_only_its_own_folder_and_switching_rerenders() {
  await openPanel();
  await until(() => titles().length === 1, "main's folder is listed");
  Assert.deepEqual(titles(), ["Main page"], "main sees its own folder's contents only");
  Assert.equal(header(), "main", "the header shows the workspace's name");
  const mainFolder = await toolbarFolder("main");
  Assert.ok(
    rows().every((r) => ![mainFolder.guid, toolbarGuid].includes(r.dataset.guid)),
    "no row for the workspace folder or the toolbar",
  );
  Assert.ok(
    rows().every((r) => r.getAttribute("aria-level") === "1"),
    "its contents at the top, aria-level 1",
  );
  Assert.equal(def("main").bookmarksFolder, mainFolder.guid, "the folder found by name is linked");
  await closePanel();

  const work = await create("work");
  await openPanel();
  await until(() => header() === "work", "work's panel");
  Assert.deepEqual(titles(), ["docs", "Jira"], "work sees its folder, adopted by name");
  Assert.ok(!titles().includes("Loose") && !titles().includes("Main page"), "nothing else");

  // Switching workspaces with the panel open re-renders it for the new one.
  ww().switchTo({ id: def("main").id });
  await until(() => header() === "main" && titles().join() === "Main page", "re-rendered: main");
  ww().switchTo({ id: work.id });
  await until(() => header() === "work" && titles().join() === "docs,Jira", "and back: work");
  await closePanel();
});

add_task(async function quick_add_files_in_the_workspace_folder_made_on_the_first_add() {
  const shop = await create("shop");
  Assert.equal(await toolbarFolder("shop"), null, "no folder for a new workspace yet");
  await openPanel();
  await until(emptyState, "an empty workspace says so");
  const text = emptyState().textContent;
  Assert.stringContains(text, "workspace shop's folder in the Bookmarks Toolbar", "what it shows");
  Assert.stringContains(text, 'root = "toolbar"', "how to see the rest");
  Assert.stringContains(text, 'root = "all"', "or everything");
  Assert.equal(rows().length, 0, "no rows");
  await closePanel();

  await loadPage("cart");
  await runCommand("bookmark deals/Cart");
  await until(async () => !!(await placeOf(`${PAGE}?cart`)), ":bookmark path adds at once");
  Assert.deepEqual(
    await placeOf(`${PAGE}?cart`),
    ["toolbar", "shop", "deals"],
    "lands in toolbar/shop/deals, the folder made",
  );
  const folder = await toolbarFolder("shop");
  await until(() => def("shop").bookmarksFolder === folder.guid, "and linked by guid");
  Assert.equal(def("shop").id, shop.id, "the same workspace");

  // ctrl+b a with Tab completion, in work.
  await switchTo("work");
  await loadPage("tabbed");
  await focusPage();
  prefix("a");
  await until(promptOpen, "ctrl+b a asks");
  Assert.stringContains(promptText(), "@work", "the prompt names the workspace");
  EventUtils.sendString("do");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(promptInput().value, "docs/tabbed", "Tab completes work's folder");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(async () => !!(await placeOf(`${PAGE}?tabbed`)), "added");
  Assert.deepEqual(await placeOf(`${PAGE}?tabbed`), ["toolbar", "work", "docs"], "work/docs");

  // @name/ files in another workspace's folder.
  await loadPage("elsewhere");
  await runCommand("bookmark @shop/Elsewhere");
  await until(async () => !!(await placeOf(`${PAGE}?elsewhere`)), "added to shop");
  Assert.deepEqual(await placeOf(`${PAGE}?elsewhere`), ["toolbar", "shop"], "in shop's folder");
});

add_task(async function m_moves_a_bookmark_to_another_workspace() {
  await switchTo("work");
  await openPanel();
  await highlight("Jira");
  EventUtils.synthesizeKey("m");
  await until(promptOpen, "m asks");
  EventUtils.synthesizeKey("a", { accelKey: true });
  EventUtils.sendString("@sh");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(promptInput().value, "@shop/", "Tab completes the workspace");
  EventUtils.sendString("de");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(promptInput().value, "@shop/deals/", "then its folders");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    async () => (await placeOf(`${PAGE}?jira`))?.join("/") === "toolbar/shop/deals",
    "Jira moved to shop/deals",
  );
  await until(() => !titles().includes("Jira"), "and left work's panel");
  await closePanel();
});

add_task(async function a_rename_renames_the_folder_and_keeps_the_link() {
  await switchTo("shop");
  const guid = def("shop").bookmarksFolder;
  await runCommand("wsrename market");
  await until(() => def("market"), "renamed");
  await until(async () => (await toolbarFolder("market"))?.guid === guid, "its folder too");
  Assert.equal(def("market").bookmarksFolder, guid, "the same folder, linked");
  // Renamed in the Library, the folder stays linked by its guid.
  await PlacesUtils.bookmarks.update({ guid, title: "Shopping" });
  await openPanel();
  await until(() => header() === "market" && titles().includes("deals"), "still market's");
  await closePanel();
  await PlacesUtils.bookmarks.update({ guid, title: "market" });
});

/** :wsdelete `name` answered y, then the bookmarks question answered `key`. */
async function deleteWith(name, key) {
  await switchTo("main");
  await runCommand(`wsdelete ${name}`);
  await until(promptOpen, "y/N");
  EventUtils.synthesizeKey("y");
  await until(() => promptOpen() && /K\/m\/d/.test(promptText()), "asks about its bookmarks");
  const question = promptText();
  EventUtils.synthesizeKey(key);
  await until(() => !promptOpen(), `${key} answers`);
  return question;
}

/** A runtime workspace `name` with one bookmark, its folder made. */
async function withBookmark(name) {
  await create(name);
  await loadPage(name);
  await runCommand(`bookmark ${name} page`);
  await until(async () => !!(await placeOf(`${PAGE}?${name}`)), `${name} has a bookmark`);
  await until(() => !!def(name).bookmarksFolder, "linked");
  return def(name).bookmarksFolder;
}

add_task(async function deleting_a_workspace_asks_what_becomes_of_its_bookmarks() {
  // Esc: nothing closed, nothing changed.
  const escGuid = await withBookmark("esc");
  const question = await deleteWith("esc", "KEY_Escape");
  Assert.equal(
    question,
    'The 1 bookmark of "esc": k keep the folder (default), m move it to "main", d delete it? K/m/d',
    "names the count and the choices, keep first",
  );
  Assert.ok(def("esc"), "Esc closes nothing");
  Assert.ok(await PlacesUtils.bookmarks.fetch(escGuid), "and keeps the folder");

  // k (and Enter): the workspace goes, its folder stays, unlinked.
  await deleteWith("esc", "KEY_Enter");
  await until(() => !def("esc"), "Enter keeps the folder and closes the workspace");
  Assert.ok(await PlacesUtils.bookmarks.fetch(escGuid), "the folder stays in the toolbar");
  Assert.deepEqual(await placeOf(`${PAGE}?esc`), ["toolbar", "esc"], "with its bookmark");

  // m: the contents go to main's folder, the empty folder goes.
  const moveGuid = await withBookmark("mover");
  await deleteWith("mover", "m");
  await until(() => !def("mover"), "m closes the workspace");
  await until(
    async () => (await placeOf(`${PAGE}?mover`))?.join("/") === "toolbar/main",
    "its bookmark moved to main",
  );
  // The move lands before the emptied folder's removal: the notice comes once both are done.
  await until(() => noticeText().includes('moved its 1 bookmark to "main"'), "and says so");
  Assert.equal(await PlacesUtils.bookmarks.fetch(moveGuid), null, "its folder is gone");

  // d: the folder and its bookmarks are deleted, as asked.
  const delGuid = await withBookmark("deleter");
  await deleteWith("deleter", "d");
  await until(() => !def("deleter"), "d closes the workspace");
  await until(async () => !(await PlacesUtils.bookmarks.fetch(delGuid)), "and deletes the folder");
  Assert.equal(await placeOf(`${PAGE}?deleter`), null, "with its bookmark");
  Assert.stringContains(noticeText(), "deleted its 1 bookmark", "and says so");
});

add_task(async function a_workspace_with_an_empty_or_no_folder_asks_nothing_more() {
  await create("bare");
  await switchTo("main");
  await runCommand("wsdelete bare");
  await until(promptOpen, "y/N");
  EventUtils.synthesizeKey("y");
  await until(() => !def("bare"), "closed after the one question");
  Assert.ok(!promptOpen(), "no bookmarks question");
});

add_task(async function root_all_and_toolbar_show_the_other_trees() {
  await switchTo("main");
  VimmaHost.configure({ bookmarksRoot: "all" });
  await openPanel();
  await until(() => titles()[0] === "toolbar", "all: the Menu's tree");
  Assert.ok(titles().includes("Menu"), "with the menu's bookmark");
  Assert.equal(header(), "Bookmarks", "the header says Bookmarks");
  VimmaHost.configure({ bookmarksRoot: "toolbar" });
  await until(() => titles().includes("Loose"), "toolbar: loose bookmarks show");
  Assert.ok(titles().includes("main") && titles().includes("work"), "and workspace folders");
  VimmaHost.configure({ bookmarksRoot: "workspace" });
  await until(() => header() === "main" && !titles().includes("Loose"), "back to main's folder");
  await closePanel();
});

add_task(async function the_link_survives_a_restart() {
  const path = PathUtils.join(PathUtils.profileDir, "vimma-workspaces-bookmarks-test.json");
  files.push(path, `${path}.bak`, `${path}.tmp`);
  const first = new WorkspaceStoreImpl({ path });
  await first.init();
  const id = first.definitions.workspaces[0].id;
  const folder = await toolbarFolder("work");
  first.setBookmarksFolder(id, folder.guid);
  await first.finalize();
  const second = new WorkspaceStoreImpl({ path });
  await second.init();
  Assert.equal(
    second.definitions.workspaces[0].bookmarksFolder,
    folder.guid,
    "the folder's guid is read back after a restart",
  );
  await second.finalize();
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, decision 3 (since changed, #1221): a tab or window an
// extension opens with no `cookieStoreId` and no opener tab is in no container, as in Firefox, so
// a sign-in page it opens shares the cookies its background reads; what you open still takes the
// workspace's container. Security: docs/security/03-workspace-deletion-and-containers.md, W8.

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const SIGNIN = `${ROOT}file_vimma_extension_signin.sjs?signin`;
const WHOAMI = `${ROOT}file_vimma_extension_signin.sjs?whoami`;
const PAGE = `${ROOT}file_vimma_extension_signin.sjs`;

const main = () =>
  /** @type {ContainedWorkspace} */ (
    WorkspaceStore.definitions.workspaces.find(
      (/** @type {WorkspaceDefinition} */ w) => w.name === "main",
    )
  );
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));

/** @type {string[]} */
const created = [];
/** @param {string} name */
function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return /** @type {ContainedWorkspace} */ (w);
}

const cookiesIn = (/** @type {number} */ userContextId) =>
  Services.cookies
    .getCookiesWithOriginAttributes(JSON.stringify({ userContextId }), "example.com")
    .map((c) => `${c.name}=${c.value}`);

const closeOthers = () => {
  while (gBrowser.tabs.length > 1)
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
};

registerCleanupFunction(async () => {
  ww().switchTo({ name: "main" });
  WorkspaceStore.setActive(window, main().id);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  closeOthers();
  Services.cookies.removeAll();
});

/**
 * An extension that opens tabs and windows as a password manager's sign-in does, and reads the
 * site's cookies from its background with `fetch`, as its API calls do.
 */
async function signInExtension() {
  const ext = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["cookies", "https://example.com/*"],
      background: { scripts: ["background.js"] },
      browser_specific_settings: { gecko: { id: "signin@vimma.test" } },
    },
    files: {
      "page.html": "<!doctype html><meta charset=utf-8><title>extension page</title>",
      // Each answer is a string: a tab's cookieStoreId, the active tab's id, a page's text, a URL.
      "background.js": `browser.test.onMessage.addListener(async (kind, arg) => {
        let answer = "";
        if (kind === "tab") answer = (await browser.tabs.create(arg)).cookieStoreId;
        else if (kind === "window") answer = String((await browser.windows.create(arg)).id);
        else if (kind === "active") {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          answer = String(tab.id);
        } else if (kind === "whoami") {
          const res = await fetch(arg, { credentials: "include", cache: "no-store" });
          answer = await res.text();
        } else if (kind === "url") answer = browser.runtime.getURL(arg);
        browser.test.sendMessage("done", answer);
      });`,
    },
  });
  await ext.startup();
  /** @param {string} kind @param {unknown} [arg] @returns {Promise<string>} */
  const ask = (kind, arg) => {
    ext.sendMessage(kind, arg);
    return ext.awaitMessage("done");
  };
  return { ext, ask };
}

add_task(async function an_extensions_sign_in_tab_shares_the_cookies_its_background_reads() {
  const work = workspace("ext-signin");
  WorkspaceStore.setActive(window, work.id);
  const { ext, ask } = await signInExtension();

  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, SIGNIN, true);
  const store = await ask("tab", { url: SIGNIN });
  const tab = await loaded;
  Assert.equal(store, "firefox-default", "tabs.create reports the default cookie store");
  Assert.equal(tab.userContextId, 0, "the sign-in tab is in no container, as in Firefox");
  Assert.equal(
    await ask("whoami", WHOAMI),
    "session=signed-in",
    "the extension's background sees the session the sign-in page set",
  );
  Assert.deepEqual(cookiesIn(work.userContextId), [], "the workspace's cookies are untouched");

  Assert.ok(ww().isForeign(tab), "the tab is adopted by the active workspace, marked foreign");
  Assert.ok(!tab.hidden, "and shown there");

  BrowserTestUtils.removeTab(tab);
  await ext.unload();
  Services.cookies.removeAll();
});

add_task(async function what_you_open_still_takes_the_workspaces_container() {
  const work = workspace("ext-yours");
  WorkspaceStore.setActive(window, work.id);
  const { ext, ask } = await signInExtension();
  const extTab = BrowserTestUtils.waitForNewTab(gBrowser, PAGE, true);
  await ask("tab", { url: PAGE });
  BrowserTestUtils.removeTab(await extTab);

  // ctrl+t is Vimma's new_tab on every platform.
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, null, false, true);
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const ctrlT = await opened;
  Assert.equal(ctrlT.userContextId, work.userContextId, "ctrl+t after it: the workspace's");

  const yours = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?yours`);
  Assert.equal(yours.userContextId, work.userContextId, "a page you open: the workspace's");

  BrowserTestUtils.removeTab(yours);
  BrowserTestUtils.removeTab(ctrlT);
  await ext.unload();
});

add_task(async function an_extensions_explicit_container_and_opener_are_kept() {
  const work = workspace("ext-explicit");
  const other = workspace("ext-other");
  WorkspaceStore.setActive(window, work.id);
  const { ext, ask } = await signInExtension();

  // An explicit cookieStoreId: the extension's choice, in or out of a workspace.
  let loaded = BrowserTestUtils.waitForNewTab(gBrowser, `${PAGE}?explicit`, true);
  await ask("tab", {
    url: `${PAGE}?explicit`,
    cookieStoreId: `firefox-container-${other.userContextId}`,
    active: false,
  });
  const explicit = await loaded;
  Assert.equal(explicit.userContextId, other.userContextId, "an explicit container stays");

  // An opener tab: its container, as upstream (Tabbrowser #createTab).
  const opener = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?opener`);
  Assert.equal(opener.userContextId, work.userContextId, "sanity: the opener is the workspace's");
  const openerTabId = Number(await ask("active"));
  loaded = BrowserTestUtils.waitForNewTab(gBrowser, `${PAGE}?child`, true);
  await ask("tab", { url: `${PAGE}?child`, openerTabId });
  const child = await loaded;
  Assert.equal(child.userContextId, work.userContextId, "a tab with an opener takes its opener's");

  for (const t of [child, opener, explicit]) BrowserTestUtils.removeTab(t);
  await ext.unload();
});

add_task(async function an_extensions_own_pages_and_windows_are_in_no_container() {
  const work = workspace("ext-pages");
  WorkspaceStore.setActive(window, work.id);
  const { ext, ask } = await signInExtension();

  const pageUrl = await ask("url", "page.html");
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, pageUrl, true);
  await ask("tab", { url: "page.html" });
  const page = await loaded;
  Assert.equal(page.userContextId, 0, "an extension page is in no container");
  BrowserTestUtils.removeTab(page);

  const opened = BrowserTestUtils.waitForNewWindow({ url: SIGNIN });
  await ask("window", { url: SIGNIN });
  const win = await opened;
  Assert.equal(
    win.gBrowser.selectedTab.userContextId,
    0,
    "a normal window an extension opens starts in no container",
  );
  Assert.equal(
    await ask("whoami", WHOAMI),
    "session=signed-in",
    "and its sign-in reaches the extension's background",
  );
  await BrowserTestUtils.closeWindow(win);
  await ext.unload();
  Services.cookies.removeAll();
});

add_task(async function an_extensions_tab_never_lands_in_the_agent_workspaces_container() {
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  Assert.ok(agent?.userContextId, "sanity: the agent workspace has a container");
  Assert.equal(ww().switchTo({ name: agent.name }), null, "show the agent workspace");
  const { ext, ask } = await signInExtension();

  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, SIGNIN, true);
  await ask("tab", { url: SIGNIN });
  const tab = await loaded;
  Assert.notEqual(tab.userContextId, agent.userContextId, "not in the agent's container");
  Assert.equal(tab.userContextId, 0, "in no container");
  Assert.deepEqual(cookiesIn(agent.userContextId), [], "so agents never see its session");

  BrowserTestUtils.removeTab(tab);
  await ext.unload();
  ww().switchTo({ name: "main" });
  closeOthers();
  Services.cookies.removeAll();
});

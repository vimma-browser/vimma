/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 1 (m3-workspace-store): the definitions file and
// the container lifecycle (create, adopt, check, confirmed delete).

"use strict";

const { WorkspaceStoreImpl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { ContextualIdentityService: CIS } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
);

let fileNo = 0;
/** @type {string[]} */
const files = [];
/** @type {Set<number>} */
const startIds = new Set(
  CIS.getPublicIdentities().map((/** @type {ContextualIdentity} */ i) => i.userContextId),
);
const firefoxDefaults = JSON.stringify(
  CIS.getPublicIdentities().filter((/** @type {ContextualIdentity} */ i) => i.l10nId),
);

/** A fresh definitions path in the profile, removed at the end with its backup. */
function freshPath() {
  const path = PathUtils.join(PathUtils.profileDir, `vimma-workspaces-test-${++fileNo}.json`);
  files.push(path, `${path}.bak`, `${path}.tmp`);
  return path;
}

registerCleanupFunction(async () => {
  for (const f of files) await IOUtils.remove(f, { ignoreAbsent: true });
  for (const i of CIS.getPublicIdentities()) {
    if (!startIds.has(i.userContextId)) CIS.remove(i.userContextId);
  }
  Assert.equal(
    JSON.stringify(
      CIS.getPublicIdentities().filter((/** @type {ContextualIdentity} */ i) => i.l10nId),
    ),
    firefoxDefaults,
    "Firefox's default containers are untouched",
  );
});

const publicCount = () => CIS.getPublicIdentities().length;
const identity = (/** @type {number} */ id) => CIS.getPublicIdentityFromId(id);

/** @param {string} path @param {object} [options] */
async function started(path, options = {}) {
  const store = new WorkspaceStoreImpl({ path, ...options });
  await store.init();
  return store;
}

const cookieCount = (/** @type {number} */ userContextId) =>
  Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId }), "example.com")
    .length;

function setCookie(/** @type {number} */ userContextId) {
  Services.cookies.add(
    "example.com",
    "/",
    "session",
    "shop",
    true,
    false,
    false,
    Date.now() + 86400000,
    { userContextId },
    Ci.nsICookie.SAMESITE_NONE,
    Ci.nsICookie.SCHEME_HTTPS,
  );
}

add_task(async function first_run_creates_main_the_file_and_the_container() {
  const path = freshPath();
  const before = publicCount();
  const store = await started(path);
  const [main, ...rest] = store.definitions.workspaces;
  Assert.equal(rest.length, 0, "one workspace");
  Assert.equal(main.name, "main", "named main");
  Assert.equal(main.source, "runtime", "a runtime workspace");
  Assert.ok(/^ws-[0-9a-f-]{36}$/.test(main.id), `a ws-<uuid> id: ${main.id}`);
  Assert.equal(store.definitions.lastActive, main.id, "and the active one");
  Assert.equal(publicCount(), before + 1, "exactly one new container");
  const c = identity(main.userContextId);
  Assert.deepEqual([c.name, c.color, c.icon], ["main", "gray", "circle"], "named and styled");
  Assert.ok(!startIds.has(main.userContextId), "never one of the existing containers");
  await store.finalize();
  const onDisk = await IOUtils.readJSON(path);
  Assert.deepEqual(onDisk, store.definitions, "the file holds the definitions");
  Assert.equal(onDisk.schema, 1, "schema 1");
});

add_task(async function save_and_load_round_trip() {
  const path = freshPath();
  const first = await started(path);
  const shop = first.addWorkspace({ name: "shop", color: "pink", icon: "cart" });
  first.setActive(null, shop.id);
  const defs = structuredClone(first.definitions);
  Assert.equal(identity(shop.userContextId).name, "shop", "a container for shop");
  await first.finalize();
  const before = publicCount();
  const second = await started(path);
  Assert.deepEqual(second.definitions, defs, "the same definitions after a restart");
  Assert.equal(publicCount(), before, "no new container on the second start");
  Assert.equal(second.defaultUserContextId(null), shop.userContextId, "lastActive's container");
  await second.finalize();
});

add_task(async function a_newer_file_is_never_overwritten() {
  const path = freshPath();
  const text = JSON.stringify({ schema: 2, lastActive: null, workspaces: [], future: true });
  await IOUtils.writeUTF8(path, text);
  const before = publicCount();
  const store = await started(path);
  Assert.ok(store.readOnly, "read-only workspaces");
  Assert.throws(
    () => store.addWorkspace({ name: "x", color: "gray", icon: "circle" }),
    /read-only/,
    "no new workspace",
  );
  await store.finalize();
  Assert.equal(await IOUtils.readUTF8(path), text, "the newer file is byte-for-byte unchanged");
  Assert.equal(publicCount(), before, "and no container was made");
});

add_task(async function reconcile_adopts_and_never_deletes_silently() {
  const path = freshPath();
  const adopted = CIS.create("adopted", "circle", "gray");
  const reused = CIS.create("someone else's", "fence", "red");
  const def = (
    /** @type {string} */ id,
    /** @type {string} */ name,
    /** @type {number | null} */ ucid,
  ) => ({
    id,
    name,
    userContextId: ucid,
    color: "gray",
    icon: "circle",
    source: "runtime",
  });
  await IOUtils.writeJSON(path, {
    schema: 1,
    lastActive: "ws-a",
    workspaces: [
      def("ws-a", "adopted", adopted.userContextId),
      def("ws-b", "reused", reused.userContextId),
      def("ws-c", "gone", 4000),
    ],
  });
  const before = publicCount();
  const store = await started(path, {
    config: [{ name: "work", color: "blue", icon: "briefcase", autofill: true }],
  });
  const byName = Object.fromEntries(
    store.definitions.workspaces.map((/** @type {WorkspaceDefinition} */ w) => [w.name, w]),
  );
  Assert.deepEqual(
    store.definitions.workspaces.map((/** @type {WorkspaceDefinition} */ w) => [w.name, w.source]),
    [
      ["work", "config"],
      ["adopted", "runtime"],
      ["reused", "runtime"],
      ["gone", "runtime"],
    ],
    "config first, then the file's runtime workspaces",
  );
  Assert.equal(byName.adopted.userContextId, adopted.userContextId, "adopted by its stored id");
  Assert.notEqual(byName.reused.userContextId, reused.userContextId, "a reused id is not ours");
  Assert.equal(identity(reused.userContextId).name, "someone else's", "and is left alone");
  Assert.notEqual(byName.gone.userContextId, 4000, "a missing container is replaced");
  Assert.equal(publicCount(), before + 3, "three new containers (work, reused, gone), none gone");
  Assert.equal(identity(byName.work.userContextId).icon, "briefcase", "config looks");
  Assert.deepEqual(store.lostContainers, ["reused", "gone"], "lost containers are reported");
  await store.finalize();
});

add_task(async function a_confirmed_delete_removes_the_container_and_its_cookies() {
  const path = freshPath();
  const store = await started(path, {
    config: [{ name: "work", color: "blue", icon: "briefcase", autofill: true }],
  });
  const shop = store.addWorkspace({ name: "shop", color: "pink", icon: "cart" });
  const work = store.definitions.workspaces[0];
  setCookie(shop.userContextId);
  setCookie(work.userContextId);
  Assert.equal(cookieCount(shop.userContextId), 1, "shop has a cookie");

  await Assert.rejects(store.deleteWorkspace(shop.id), /confirm/, "not without confirmation");
  Assert.ok(identity(shop.userContextId), "the container stays");
  Assert.equal(cookieCount(shop.userContextId), 1, "and its cookie");
  await Assert.rejects(
    store.deleteWorkspace(work.id, { confirmed: true }),
    /config\.toml/,
    "a config workspace keeps its container",
  );

  const cleared = TestUtils.topicObserved(
    "clear-origin-attributes-data",
    (_s, data) => JSON.parse(/** @type {string} */ (data)).userContextId === shop.userContextId,
  );
  await store.deleteWorkspace(shop.id, { confirmed: true });
  await cleared;
  await TestUtils.waitForCondition(() => cookieCount(shop.userContextId) === 0, "cookie cleared");
  Assert.ok(!identity(shop.userContextId), "the container is gone");
  Assert.equal(cookieCount(work.userContextId), 1, "work's cookie stays");
  Assert.ok(identity(work.userContextId), "and work's container");
  Assert.deepEqual(
    store.definitions.workspaces.map((/** @type {WorkspaceDefinition} */ w) => w.name),
    ["work"],
    "shop is no longer defined",
  );
  await store.finalize();
  Assert.deepEqual(
    (await IOUtils.readJSON(path)).workspaces.map((/** @type {WorkspaceDefinition} */ w) => w.name),
    ["work"],
    "nor in the file",
  );
  Services.cookies.removeCookiesWithOriginAttributes(
    JSON.stringify({ userContextId: work.userContextId }),
    "example.com",
  );
});

// Flipping privacy.userContext.enabled itself makes Firefox wipe every container (CIS observe),
// which would take the other tests' containers with it; the store reads it through `enabled`.
add_task(async function containers_off_disables_workspaces() {
  Assert.ok(Services.prefs.getBoolPref("privacy.userContext.enabled"), "containers on by default");
  const path = freshPath();
  const before = publicCount();
  const store = await started(path, { enabled: () => false });
  Assert.ok(store.disabled, "disabled");
  Assert.equal(store.defaultUserContextId(window), null, "upstream behaviour for new tabs");
  Assert.equal(publicCount(), before, "no container");
  Assert.ok(!(await IOUtils.exists(path)), "no file");
  await store.finalize();
});

add_task(async function private_windows_get_no_default_container() {
  const path = freshPath();
  const store = await started(path);
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  Assert.equal(store.defaultUserContextId(win), null, "private window");
  await BrowserTestUtils.closeWindow(win);
  const main = store.definitions.workspaces[0];
  Assert.equal(store.defaultUserContextId(window), main.userContextId, "a normal window");
  await store.finalize();
});

// docs/security.md: the y/N answer stands only for the workspace the question described. A
// config reload in between can turn a config workspace (close = its tabs) into a runtime one
// (close = delete its site data), and a rename can put another workspace under the same id.
add_task(async function a_stale_answer_closes_nothing() {
  const path = freshPath();
  const store = await started(path, {
    config: [{ name: "work", color: "blue", icon: "briefcase", autofill: true }],
  });
  const shop = store.addWorkspace({ name: "shop", color: "pink", icon: "cart" });
  const work = store.definitions.workspaces.find(
    (/** @type {WorkspaceDefinition} */ w) => w.name === "work",
  );
  setCookie(shop.userContextId);
  setCookie(work.userContextId);
  const asked = (/** @type {any} */ w) => ({
    source: w.source,
    name: w.name,
    userContextId: w.userContextId,
  });

  const askedShop = asked(shop);
  store.renameWorkspace(shop.id, "shop2");
  await Assert.rejects(
    store.closeWorkspace(shop.id, { confirmed: true, asked: askedShop }),
    /changed since you were asked/,
    "a rename after the question refuses",
  );
  Assert.ok(identity(shop.userContextId), "shop's container stays");
  Assert.equal(cookieCount(shop.userContextId), 1, "and its cookie");

  const askedWork = asked(work);
  Assert.equal(askedWork.source, "config", "sanity: asked about a config workspace");
  await store.setConfig([]);
  Assert.equal(
    store.definitions.workspaces.find((/** @type {WorkspaceDefinition} */ w) => w.id === work.id)
      ?.source,
    "runtime",
    "the reload made work a runtime workspace, whose close would delete its data",
  );
  await Assert.rejects(
    store.closeWorkspace(work.id, { confirmed: true, asked: askedWork }),
    /changed since you were asked/,
    "a config reload after the question refuses",
  );
  Assert.ok(identity(work.userContextId), "work's container stays");
  Assert.equal(cookieCount(work.userContextId), 1, "and its cookie");

  for (const ucid of [shop.userContextId, work.userContextId]) {
    Services.cookies.removeCookiesWithOriginAttributes(
      JSON.stringify({ userContextId: ucid }),
      "example.com",
    );
  }
  await store.finalize();
});

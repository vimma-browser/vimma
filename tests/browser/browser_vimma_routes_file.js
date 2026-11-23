/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/routes-file.md. routes.toml beside config.toml holds the `[[routes]]` rules
// when it exists: config.toml's are then ignored with a warning, a broken file keeps the last
// good rules, a deleted one gives config.toml's back, an edit applies on the poll and on
// `:source`. `:route add` writes there, creating the file and moving config.toml's rules into it
// on the first use, both files or neither.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WorkspaceRouter } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);

const PAGE = "https://example.org/";
const NOTICE_ID = "vimma-notice";
const RULE = (/** @type {string} */ domain, /** @type {string} */ ws) =>
  `[[routes]]\ndomain = "${domain}"\nworkspace = "${ws}"\n`;

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 200);
/** @param {Window} [win] */
const noticeText = (win = window) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";
/** The domains of the rules in force, in order. */
const domains = () => WorkspaceRouter.routes.map((r) => r.domain?.host ?? r.url ?? r.app);
/** @param {string} path */
const exists = (path) => IOUtils.exists(path);

/**
 * A throwaway config folder in force for `task`, with config.toml (and routes.toml when given),
 * removed afterwards.
 * @param {{ config?: string | null, routes?: string | null }} files
 * @param {(paths: { dir: string, config: string, routes: string }) => Promise<void>} task
 */
async function withConfig({ config = "schema = 2\n", routes = null }, task) {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-routes-file");
  const paths = {
    dir,
    config: PathUtils.join(dir, "config.toml"),
    routes: PathUtils.join(dir, "routes.toml"),
  };
  if (config !== null) await IOUtils.writeUTF8(paths.config, config);
  if (routes !== null) await IOUtils.writeUTF8(paths.routes, routes);
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", paths.config]] });
  try {
    await ConfigHost.reload();
    await task(paths);
  } finally {
    ConfigHost._beforeRoutesRenameForTests = null;
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.setPermissions(dir, 0o700).catch(() => {});
    await IOUtils.remove(dir, { recursive: true });
  }
}

/**
 * A symbolic link at `link` to `target`. nsIFile has no symlink call: python3 makes the link,
 * as a user's dotfile manager would.
 * @param {string} target
 * @param {string} link
 */
async function symlink(target, link) {
  await new Promise((resolve) => {
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    const py = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    py.initWithPath("/usr/bin/python3");
    proc.init(py);
    const args = ["-c", "import os,sys; os.symlink(sys.argv[1], sys.argv[2])", target, link];
    proc.runAsync(args, args.length, { observe: resolve });
  });
}

/**
 * `:line` Enter in `win`'s selected page, in normal mode.
 * @param {string} line
 * @param {BrowserWindow} [win]
 */
async function runCommand(line, win = window) {
  const browser = win.gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  // focusContent checks this test's own window; another window's page is focused alone.
  if (win === window) await focusContent(browser);
  else await SimpleTest.promiseFocus(browser);
  const el = win.document.getElementById(NOTICE_ID);
  if (el) el.textContent = "";
  EventUtils.synthesizeKey(":", { shiftKey: true }, win);
  EventUtils.sendString(line, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/** @type {string} */
let workspace;

add_task(async function setup() {
  WorkspaceStore.addWorkspace({ name: "rf-work", color: "blue", icon: "briefcase" });
  workspace = "rf-work";
  registerCleanupFunction(async () => {
    WorkspaceRouter.setRoutes([]);
    for (const w of WorkspaceStore.definitions.workspaces.filter((d) => d.name === "rf-work")) {
      await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
    }
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
  });
});

add_task(async function routes_toml_rules_apply_and_config_toml_rules_are_ignored_with_a_warning() {
  const config = `schema = 2\n\n${RULE("a.example", "w")}`;
  await withConfig({ config, routes: RULE("b.example", "w") }, async () => {
    Assert.deepEqual(domains(), ["b.example"], "routes.toml's rule is in force, alone");
    Assert.deepEqual(
      ConfigHost.routesProblems.map((e) => [e.line, e.message]),
      [[3, "routes ignored: routes.toml is the routes file"]],
      "config.toml's rules draw one warning at their first line",
    );
    Assert.deepEqual(ConfigHost.errors, [], "and the rest of config.toml applies");
    Assert.equal(WorkspaceRouter.routesSource.file, "routes.toml", "the rules' file is named");
  });
});

add_task(async function routes_toml_is_found_beside_a_symlinked_config_toml() {
  const elsewhere = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-dotfiles");
  const real = PathUtils.join(elsewhere, "config.toml");
  await IOUtils.writeUTF8(real, "schema = 2\n");
  // A routes.toml beside the link's target is not the one: the link's folder is.
  await IOUtils.writeUTF8(PathUtils.join(elsewhere, "routes.toml"), RULE("target.example", "w"));
  try {
    await withConfig({ config: null, routes: RULE("link.example", "w") }, async (paths) => {
      await symlink(real, paths.config);
      await ConfigHost.reload();
      Assert.deepEqual(domains(), ["link.example"], "routes.toml beside the link is read");
    });
  } finally {
    await IOUtils.remove(elsewhere, { recursive: true });
  }
});

add_task(async function a_broken_routes_toml_keeps_the_last_good_routes_and_config_toml_applies() {
  await withConfig({ routes: RULE("b.example", "w") }, async (paths) => {
    Assert.deepEqual(domains(), ["b.example"], "sanity: the good rules");
    await IOUtils.writeUTF8(paths.routes, `${RULE("c.example", "w")}domain = 3\n`);
    await IOUtils.writeUTF8(paths.config, 'schema = 2\n[panel]\nnumbers = "relative"\n');
    await ConfigHost.reload();
    Assert.deepEqual(domains(), ["b.example"], "the last good rules stay in force");
    const [error] = ConfigHost.routesProblems;
    Assert.equal(error?.file, "routes.toml", "the error names routes.toml");
    Assert.equal(error?.line, 4, "at its line");
    Assert.equal(ConfigHost.config?.panel.numbers, "relative", "config.toml's change applies");
    const bar = /** @type {HTMLElement} */ (document.getElementById("vimma-statusbar"));
    await until(
      () => bar.textContent?.includes("routes.toml:4"),
      "the status bar shows routes.toml:<line>",
    );
  });
});

add_task(async function a_routes_toml_never_read_well_applies_no_rule() {
  await withConfig(
    { config: `schema = 2\n${RULE("a.example", "w")}`, routes: "[[routes]\n" },
    async () => {
      Assert.deepEqual(domains(), [], "no rule, and never config.toml's in its place");
    },
  );
});

add_task(async function deleting_routes_toml_brings_back_config_toml_rules() {
  const config = `schema = 2\n${RULE("a.example", "w")}`;
  await withConfig({ config, routes: RULE("b.example", "w") }, async (paths) => {
    Assert.deepEqual(domains(), ["b.example"], "sanity: routes.toml's rules");
    await IOUtils.remove(paths.routes);
    await ConfigHost.reload();
    Assert.deepEqual(domains(), ["a.example"], "config.toml's rules are back");
    Assert.deepEqual(ConfigHost.routesProblems, [], "with no warning");
    Assert.equal(WorkspaceRouter.routesSource.file, "config.toml", "named as config.toml's");
  });
});

add_task(async function an_edit_of_routes_toml_applies_on_the_poll_and_on_source() {
  await withConfig({ config: `schema = 2\n${RULE("a.example", "w")}` }, async (paths) => {
    await SpecialPowers.pushPrefEnv({ set: [["vimma.config.pollMs", 100]] });
    try {
      await IOUtils.writeUTF8(paths.routes, RULE("polled.example", "w"));
      await until(() => domains().join() === "polled.example", "a new routes.toml applies");
      await IOUtils.writeUTF8(paths.routes, RULE("polled.example", "w") + RULE("two.example", "w"));
      await until(() => domains().length === 2, "an edit applies on the poll");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    await IOUtils.writeUTF8(paths.routes, RULE("sourced.example", "w"));
    await ConfigHost.reload();
    Assert.deepEqual(domains(), ["sourced.example"], ":source reads it at once");
  });
});

add_task(async function source_file_keeps_routes_toml() {
  await withConfig({ routes: RULE("b.example", "w") }, async (paths) => {
    const other = PathUtils.join(paths.dir, "other.toml");
    await IOUtils.writeUTF8(other, `schema = 2\n${RULE("other.example", "w")}`);
    await ConfigHost.reload(other);
    Assert.equal(ConfigHost.path, other, "the sourced file is in force");
    Assert.deepEqual(domains(), ["b.example"], "routes.toml still gives the rules");
    Assert.deepEqual(
      ConfigHost.routesProblems.map((e) => e.message),
      ["routes ignored: routes.toml is the routes file"],
      "the sourced file's rules draw the warning",
    );
    await IOUtils.remove(paths.routes);
    await ConfigHost.reload(other);
    Assert.deepEqual(domains(), ["other.example"], "without routes.toml, its rules apply");
  });
});

add_task(async function route_add_creates_routes_toml_and_names_it() {
  await withConfig({}, async (paths) => {
    await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await runCommand(`route add ${workspace}`);
    await until(
      () => noticeText() === `added: example.org → "${workspace}" (routes.toml)`,
      "the notice names routes.toml",
    );
    Assert.equal(await IOUtils.readUTF8(paths.routes), RULE("example.org", workspace));
    Assert.equal((await IOUtils.stat(paths.routes)).permissions, 0o600, "0600");
    Assert.equal(await IOUtils.readUTF8(paths.config), "schema = 2\n", "config.toml untouched");
    Assert.deepEqual(domains(), ["example.org"], "the rule is in force at once");

    await IOUtils.writeUTF8(paths.routes, `${RULE("example.net", workspace)}`);
    await ConfigHost.reload();
    await runCommand(`route add ${workspace}`);
    await until(() => domains().length === 2, "a second rule is appended");
    Assert.equal(
      await IOUtils.readUTF8(paths.routes),
      `${RULE("example.net", workspace)}\n${RULE("example.org", workspace)}`,
      "after a blank line",
    );
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  });
});

add_task(async function route_add_refuses_a_broken_routes_toml() {
  await withConfig({ routes: "[[routes]\n" }, async (paths) => {
    const r = await ConfigHost.addRoute({ domain: "example.org", workspace });
    Assert.deepEqual(r, { error: "routes.toml does not parse now; fix it first" });
    Assert.equal(await IOUtils.readUTF8(paths.routes), "[[routes]\n", "nothing written");
  });
});

add_task(async function route_add_moves_config_toml_rules_and_comments_them_out() {
  const config = [
    "schema = 2",
    "",
    "[routing]",
    'default_workspace = "main"',
    "",
    "# sign-ins",
    RULE("a.example", "main"),
    RULE("b.example", "main"),
  ].join("\n");
  await withConfig({ config }, async (paths) => {
    await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await runCommand(`route add ${workspace}`);
    await until(
      () =>
        noticeText() ===
        `added: example.org → "${workspace}" (routes.toml; 2 rules and default_workspace moved from config.toml)`,
      "the notice says what moved",
    );
    Assert.equal(
      await IOUtils.readUTF8(paths.routes),
      [
        "[routing]",
        'default_workspace = "main"',
        "",
        "# sign-ins",
        RULE("a.example", "main"),
        RULE("b.example", "main"),
        RULE("example.org", workspace),
      ].join("\n"),
      "routes.toml has the default, the rules with their comment, then the new one",
    );
    Assert.equal(
      await IOUtils.readUTF8(paths.config),
      [
        "schema = 2",
        "",
        "# Moved to routes.toml by :route add; routes.toml is the routes file now.",
        "# [routing]",
        '# default_workspace = "main"',
        "",
        "# # sign-ins",
        "# [[routes]]",
        '# domain = "a.example"',
        '# workspace = "main"',
        "",
        "# [[routes]]",
        '# domain = "b.example"',
        '# workspace = "main"',
        "",
      ].join("\n"),
      "config.toml keeps every other line, the moved ones commented out",
    );
    Assert.equal((await IOUtils.stat(paths.routes)).permissions, 0o600, "routes.toml is 0600");
    Assert.deepEqual(domains(), ["a.example", "b.example", "example.org"], "all in force");
    Assert.equal(WorkspaceRouter.defaultWorkspace, "main", "and the default");
    Assert.deepEqual(ConfigHost.routesProblems, [], "nothing ignored is left");
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  });
});

add_task(async function route_add_writes_neither_file_when_config_toml_cannot_be_written() {
  const store = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-store");
  const real = PathUtils.join(store, "config.toml");
  const config = `schema = 2\n${RULE("a.example", "main")}`;
  await IOUtils.writeUTF8(real, config);
  // A generated, read-only store, as a Nix or Home Manager link points into.
  await IOUtils.setPermissions(store, 0o500);
  try {
    await withConfig({ config: null }, async (paths) => {
      await symlink(real, paths.config);
      await ConfigHost.reload();
      const r = await ConfigHost.addRoute({ domain: "example.org", workspace });
      Assert.deepEqual(r, {
        error: `cannot write config.toml; nothing written (the guide's "Routes in a file" moves them by hand)`,
      });
      Assert.ok(!(await exists(paths.routes)), "no routes.toml");
      Assert.equal(await IOUtils.readUTF8(real), config, "config.toml as it was");
      const left = (await IOUtils.getChildren(paths.dir)).map((p) => PathUtils.filename(p));
      Assert.deepEqual(left, ["config.toml"], "no temporary file left behind");
    });
  } finally {
    await IOUtils.setPermissions(store, 0o700);
    await IOUtils.remove(store, { recursive: true });
  }
});

add_task(async function route_add_never_replaces_a_routes_toml_made_meanwhile() {
  for (const config of ["schema = 2\n", `schema = 2\n${RULE("a.example", "main")}`]) {
    await withConfig({ config }, async (paths) => {
      const mine = RULE("mine.example", "main");
      ConfigHost._beforeRoutesRenameForTests = async () => {
        await IOUtils.writeUTF8(paths.routes, mine);
      };
      const r = await ConfigHost.addRoute({ domain: "example.org", workspace });
      Assert.deepEqual(r, { error: "routes.toml appeared meanwhile; nothing written" });
      Assert.equal(await IOUtils.readUTF8(paths.routes), mine, "the user's routes.toml stays");
      Assert.equal(await IOUtils.readUTF8(paths.config), config, "config.toml as it was");
    });
  }
});

add_task(async function route_add_in_a_private_window_writes_nothing() {
  await withConfig({}, async (paths) => {
    const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await SimpleTest.promiseFocus(win);
      BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, PAGE);
      await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser);
      await runCommand(`route add ${workspace}`, win);
      await until(
        () => noticeText(win) === "no workspaces in this window",
        "a private window has no workspaces to route to",
      );
      Assert.ok(!(await exists(paths.routes)), "no routes.toml");
      Assert.equal(await IOUtils.readUTF8(paths.config), "schema = 2\n", "config.toml as it was");
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }
  });
});

add_task(async function about_vimma_shows_each_rules_file_and_line() {
  await withConfig({ routes: `# mine\n\n${RULE("b.example", workspace)}` }, async (paths) => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:vimma#routes");
    const doc = () => /** @type {Document} */ (tab.linkedBrowser.contentDocument);
    await until(() => doc()?.documentElement?.dataset.ready === "true", "about:vimma rendered");
    const cell = () => doc().querySelector("#routes tbody tr td")?.textContent;
    Assert.equal(cell(), "1 · routes.toml:3", "the rule's number, file and line");
    BrowserTestUtils.removeTab(tab);

    await IOUtils.writeUTF8(paths.routes, "");
    await ConfigHost.reload();
    const empty = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:vimma#routes");
    const emptyDoc = /** @type {Document} */ (empty.linkedBrowser.contentDocument);
    await until(() => emptyDoc.documentElement?.dataset.ready === "true", "rendered again");
    Assert.ok(
      emptyDoc.getElementById("routes")?.textContent?.includes("No [[routes]] in routes.toml."),
      "with no rules it names the routes file",
    );
    BrowserTestUtils.removeTab(empty);
  });
});

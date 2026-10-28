/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Cross-cutting rules of docs/security.md that no feature's own test file covers. Each task is
// linked from that page by name (tools/security/check-doc-links.mjs keeps the links honest).

"use strict";

/* global focusContent -- from head.js */
/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);

const PAGE = "https://example.org/";
const HOSTILE_TITLE = '<img src=x onerror="document.title=1"><b>bold</b>';

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** What the window looks like, for "nothing changed". */
function snapshot() {
  return JSON.stringify({
    tabs: gBrowser.tabs.map((t) => [t.linkedBrowser.currentURI.spec, t.pinned, t.hidden]),
    selected: gBrowser.tabs.indexOf(gBrowser.selectedTab),
    mode: VimmaHost.status(window).mode,
    workspace: VimmaHost.status(window).workspace?.name ?? null,
  });
}

add_task(async function control_state_is_read_only() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?state`);
  await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?other`);
  await BrowserTestUtils.switchTab(gBrowser, tab);
  await focusContent(tab.linkedBrowser);
  const before = snapshot();
  const first = VimmaControl._commands.state();
  const second = VimmaControl._commands.state();
  Assert.equal(snapshot(), before, "state changes no tab, selection, mode or workspace");
  Assert.deepEqual(second, first, "and asking twice gives the same answer");
  Assert.ok(
    first.tabs.some((/** @type {any} */ t) => t.selected && t.url === `${PAGE}?state`),
    "sanity: it reports the window",
  );
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

add_task(async function control_state_never_inserts_a_lazy_tab() {
  // A restored or unloaded tab has no browser yet; reading its webProgress would make one.
  const lazy = gBrowser.addTab(`${PAGE}?lazy`, {
    createLazyBrowser: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  Assert.ok(!lazy.linkedPanel, "sanity: the tab is lazy");
  const entry = VimmaControl._commands
    .state()
    .tabs.find((/** @type {any} */ t) => t.id === String(lazy.linkedBrowser.browserId));
  Assert.ok(!lazy.linkedPanel, "state leaves the lazy tab without a browser");
  Assert.strictEqual(entry?.loading, false, "and reports it as not loading");
  BrowserTestUtils.removeTab(lazy);
});

add_task(async function page_titles_with_html_stay_text() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?title`);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [HOSTILE_TITLE], (t) => {
    content.document.title = t;
  });
  await until(() => browser.contentTitle === HOSTILE_TITLE, "the page set its title");

  const bar = document.getElementById("vimma-statusbar");
  const title = () => bar.querySelector('[data-segment="title"]');
  await until(() => !!title()?.textContent.includes("<img"), "the status bar shows the title");
  Assert.equal(bar.querySelector("img, b"), null, "the status bar parsed no markup");

  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("ls");
  EventUtils.synthesizeKey("KEY_Enter");
  const picker = () => document.getElementById("vimma-picker");
  await until(() => !!picker()?.open, ":ls opens the tab picker");
  const rowTitles = [...picker().querySelectorAll(".vimma-picker-title")].map((e) => e.textContent);
  Assert.ok(rowTitles.includes(HOSTILE_TITLE), "the picker shows the title as written");
  Assert.equal(picker().querySelector("img, b"), null, "the picker parsed no markup");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !picker()?.open, "closed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function route_add_creates_a_private_config_toml() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-security");
  const file = PathUtils.join(dir, "vimma", "config.toml");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
  await ConfigHost.reload();

  const why = await ConfigHost.addRoute({ domain: "example.org", workspace: 'x" [keys] y = "z' });
  Assert.equal(why, null, "the rule is written");
  Assert.equal((await IOUtils.stat(file)).permissions, 0o600, "a new config.toml is 0600");
  Assert.equal((await IOUtils.stat(PathUtils.parent(file))).permissions, 0o700, "its folder 0700");
  const text = await IOUtils.readUTF8(file);
  Assert.ok(
    text.endsWith('[[routes]]\ndomain = "example.org"\nworkspace = "x\\" [keys] y = \\"z"\n'),
    "the workspace name is one escaped TOML string, never a new table",
  );

  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
  await IOUtils.remove(dir, { recursive: true });
});

// docs/specs/mcp-drive.md D9 (security.md M16): `agent-keys` runs only its whitelist, so the
// agent role never reaches `ctrl+b shift+a` (mcp.answer: an agent answering its own question),
// the command line or any prefix binding, and nothing is asked or changes.
add_task(async function agent_keys_never_reach_the_prefix_the_command_line_or_mcp_answer() {
  const { AgentGate } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
  );
  const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/mcp-ops.mjs",
  );
  const { WorkspaceStore } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
  );
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  const tab = gBrowser.addTab(PAGE, {
    userContextId: agent.userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  await focusContent(gBrowser.selectedBrowser);
  const before = snapshot();
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "x" } });
  for (const keys of ["ctrl+b A", "<C-b>A", "prefix+shift+a", ":", ":mcp revoke<CR>", "ctrl+b"]) {
    const r = await c.call("agent-keys", { tab: String(tab.linkedBrowser.browserId), keys });
    Assert.equal(r.error?.code, "invalid-args", `${keys}: refused`);
  }
  Assert.equal(AgentGate.waiting.length, 0, "nothing was asked");
  Assert.equal(snapshot(), before, "nothing changed in the window");
  c.close();
  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
});

// docs/specs/mcp-forms.md F8 (security.md M26): an agent's click is the child's click(), so the
// code the agent role reaches never synthesises input through nsIDOMWindowUtils or the widget,
// and never gives a page user activation. Comments are left out: they may name what is avoided.
add_task(async function agent_clicks_never_synthesise_input_or_user_activation() {
  const base = "chrome://browser/content/vimma/";
  const files = [
    "ctl/agent-commands.mjs",
    "ctl/AgentAct.sys.mjs",
    "ctl/AgentDrive.sys.mjs",
    "actors/VimmaActors.sys.mjs",
    "actors/VimmaChild.sys.mjs",
    "actors/agent-fields.mjs",
    "actors/hint-collect.mjs",
  ];
  const forbidden =
    /\bsend(?:Native)?(?:Mouse|Touch|Wheel|Key|Pointer)\w*\b|\bsynthesize\w*|\bnotifyUserGestureActivation\b/g;
  for (const file of files) {
    const source = await (await fetch(base + file)).text();
    Assert.greater(source.length, 0, `${file} is read`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    Assert.deepEqual(code.match(forbidden) ?? [], [], `${file} synthesises no input (M26)`);
  }
});

// docs/specs/mcp-forms.md F13 (security.md M27): an agent's fill never sets a file field. The
// code the agent role reaches has no way to give a file input a file, and the one place that
// calls setUserInput refuses a file field, an editable root and a sensitive field just before.
add_task(async function agent_fills_never_set_a_file() {
  const base = "chrome://browser/content/vimma/";
  const files = [
    "ctl/agent-commands.mjs",
    "ctl/AgentAct.sys.mjs",
    "ctl/AgentDrive.sys.mjs",
    "actors/VimmaActors.sys.mjs",
    "actors/VimmaChild.sys.mjs",
    "actors/agent-fields.mjs",
  ];
  const forbidden = /\bmozSet\w*|\.files\s*=|\bmozFileOrDirectory\w*|\bDataTransfer\b/g;
  /** @type {string[]} */
  const setters = [];
  for (const file of files) {
    const source = await (await fetch(base + file)).text();
    Assert.greater(source.length, 0, `${file} is read`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    Assert.deepEqual(code.match(forbidden) ?? [], [], `${file} gives no input a file (M27)`);
    for (const m of code.matchAll(/\bsetUserInput\(/g)) setters.push(`${file}@${m.index}`);
  }
  Assert.equal(setters.length, 1, `one call of setUserInput: ${setters.join(", ")}`);
  Assert.ok(setters[0].startsWith("actors/agent-fields.mjs@"), "in agent-fields.mjs");
  const fields = await (await fetch(`${base}actors/agent-fields.mjs`)).text();
  const fill = fields.slice(fields.indexOf("export function fillField("));
  const body = fill.slice(0, fill.indexOf("\n}\n"));
  Assert.ok(
    body.indexOf("if (secretOf(el)) return false;") < body.indexOf("setUserInput(") &&
      body.indexOf('field === "text" || field === "textarea"') < body.indexOf("setUserInput("),
    "fillField checks the field is no secret and is text before it sets it",
  );
});

// security.md M28: the child's test hook that runs a page function just before an agent's
// submission is checked is read only behind Cu.isInAutomation, so a release never runs one,
// whoever sets it. Comments are left out: they may name the hook.
add_task(async function the_submit_check_test_hook_is_read_only_in_automation() {
  const file = "chrome://browser/content/vimma/actors/VimmaChild.sys.mjs";
  const source = await (await fetch(file)).text();
  Assert.greater(source.length, 0, "VimmaChild.sys.mjs is read");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const uses = [...code.matchAll(/^.*\b_beforeSubmitCheck\w*.*$/gm)].map((m) => m[0].trim());
  Assert.deepEqual(
    uses,
    [
      "static _beforeSubmitCheckForTests = null;",
      "const test = Cu.isInAutomation ? VimmaChild._beforeSubmitCheckForTests : null;",
    ],
    "the hook is declared, and read once, behind Cu.isInAutomation",
  );
});

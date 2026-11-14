/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Cross-cutting rules of docs/security/ that no feature's own test file covers. Each task is
// linked from that page by name (tools/security/check-doc-links.ts keeps the links honest).

"use strict";

/* global focusContent, contextOf, windowGlobalOf -- from head.js */
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

/** @param {() => unknown} cond @param {string} msg */
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
  while (gBrowser.tabs.length > 1)
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
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

  const bar = /** @type {HTMLElement} */ (document.getElementById("vimma-statusbar"));
  const title = () => bar.querySelector('[data-segment="title"]');
  await until(() => !!title()?.textContent.includes("<img"), "the status bar shows the title");
  Assert.equal(bar.querySelector("img, b"), null, "the status bar parsed no markup");

  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("ls");
  EventUtils.synthesizeKey("KEY_Enter");
  /** The picker, or null while there is none. */
  const picker = () =>
    /** @type {HTMLDialogElement | null} */ (document.getElementById("vimma-picker"));
  await until(() => !!picker()?.open, ":ls opens the tab picker");
  const rowTitles = [
    .../** @type {HTMLDialogElement} */ (picker()).querySelectorAll(".vimma-picker-title"),
  ].map((e) => e.textContent);
  Assert.ok(rowTitles.includes(HOSTILE_TITLE), "the picker shows the title as written");
  Assert.equal(
    /** @type {HTMLDialogElement} */ (picker()).querySelector("img, b"),
    null,
    "the picker parsed no markup",
  );
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
  Assert.equal(
    (await IOUtils.stat(/** @type {string} */ (PathUtils.parent(file)))).permissions,
    0o700,
    "its folder 0700",
  );
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
    "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
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

// security.md section 13: content-process messages enter the parent only through Vimma's parent
// actor, which Firefox loads from the URL VimmaActors.register() is given. A wrong URL fails in
// silence (no parent actor, so every page report is dropped and no tab leaves normal mode), so
// this asks for the actor in a normal tab and has the page's own focus reach the host.
add_task(async function a_tabs_focus_report_reaches_the_host_through_the_parent_actor() {
  await BrowserTestUtils.withNewTab(`${PAGE}?actor`, async (browser) => {
    await focusContent(browser);
    let actor = null;
    try {
      actor = windowGlobalOf(contextOf(browser)).getActor("Vimma");
    } catch (e) {
      Assert.ok(false, `the parent actor loads from its registered URL: ${e}`);
    }
    Assert.equal(actor?.constructor.name, "VimmaParent", "a normal tab has Vimma's parent actor");
    await until(() => VimmaHost._browserMode(browser) === "normal", "the tab starts in normal");
    await SpecialPowers.spawn(browser, [], () => {
      const input = content.document.createElement("input");
      content.document.body.append(input);
      input.focus();
    });
    await until(
      () => VimmaHost._browserMode(browser) === "insert",
      "the page's focus report reached the host: the tab is in insert",
    );
  });
});

// security.md section 13: a parent actor URL that is not a module of host/ is refused before
// anything is registered, so a typo fails at startup instead of dropping page reports in silence.
// The actor is registered once per process already; the check runs before that guard, and the
// real URL passes it (a second call with it is the guard's no-op).
add_task(async function the_parent_actors_url_is_checked_before_it_is_registered() {
  const { VimmaActors } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
  );
  const bad = [
    undefined,
    "",
    "https://example.org/VimmaParent.sys.mjs",
    "chrome://browser/content/other/VimmaParent.sys.mjs",
    "chrome://browser/content/vimma/actors/VimmaParent.sys.mjs",
    "chrome://browser/content/vimma/host/../actors/VimmaChild.sys.mjs",
    "chrome://browser/content/vimma/host/VimmaParent.mjs",
  ];
  for (const uri of bad) {
    Assert.throws(
      () => VimmaActors.register(/** @type {string} */ (uri)),
      /parent actor/,
      `refused: ${JSON.stringify(uri)}`,
    );
  }
  VimmaActors.register("chrome://browser/content/vimma/host/VimmaParent.sys.mjs");
  Assert.ok(true, "the real URL passes the check");
});

// security.md section 12: every agent command asks the agent gate (host/AgentGate.sys.mjs), and
// the agent line shows its questions. The control commands (ctl/), the agent line and :mcp
// (host/) must load one and the same gate: a second copy under another URL would hold questions
// that no line shows, and every call would wait out its timeout instead of reaching the user. So
// an agent's call over the socket must open the line with its question, be held by the gate this
// test loads from host/, and get the user's no back.
add_task(async function an_agents_question_reaches_the_user_and_the_answer_reaches_the_agent() {
  const { AgentGate } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
  );
  const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/mcp-ops.mjs",
  );
  const ARMING = "security.dialog_enable_delay";
  /** @type {InstanceType<typeof Client> | null} */
  let c = null;
  // Also run when an assertion fails, so no later task inherits [mcp], the arming delay or the
  // connection.
  registerCleanupFunction(async () => {
    c?.close();
    Services.prefs.clearUserPref(ARMING);
    Services.prefs.clearUserPref(MCP_ENABLED_PREF);
    await VimmaControl.settled();
  });
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  Services.prefs.setIntPref(ARMING, 100);
  await VimmaControl.settled();
  const line = () =>
    /** @type {HTMLElement | null} */ (document.getElementById("vimma-agent-prompt"));
  const lineOpen = () => !!line() && !(/** @type {HTMLElement} */ (line()).hidden);
  const hint = () =>
    /** @type {HTMLElement | null | undefined} */ (
      line()?.querySelector(".vimma-agent-prompt-hint")
    );
  // Quiet keys and a focused page: the line opens by itself after 1,500 ms (vimma-mcp.md, 14).
  await focusContent(gBrowser.selectedBrowser);
  await new Promise((r) => setTimeout(r, 1600));
  c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "gate-check" }, via: "example" });
  const id = c.request("agent-tabs");
  await until(lineOpen, "the agent line opens with the question");
  Assert.stringMatches(
    line()?.querySelector(".vimma-agent-prompt-text")?.textContent ?? "",
    /^◇ gate-check wants vimma_tabs: the list of agent tabs \(\d+\)$/,
    "it says who wants what",
  );
  Assert.equal(AgentGate.waiting.length, 1, "the gate host/ holds is the one the socket asked");
  await until(() => !!hint() && !hint()?.hidden && hint()?.textContent !== "", "the line arms");
  EventUtils.synthesizeKey("n");
  const r = await c.response(id);
  Assert.equal(r.error?.code, "denied", "the user's n reaches the agent");
  Assert.equal(r.error?.reason, "user", "as the user's no");
  Assert.equal(AgentGate.waiting.length, 0, "nothing is left waiting");
  await until(() => !lineOpen(), "the line closes");
  c.close();
  c = null;
  Services.prefs.clearUserPref(ARMING);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
});

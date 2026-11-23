/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's fifth chapter, Privacy and agents (docs/specs/setup-v2.md; behaviours 27 and 28,
// decisions 14 and 16).

"use strict";

/* global SetupHost, ConfigHost, McpHost, found, configFile -- from head_vimma_setup_chapters.js */
/* global press, step, openFlow, closeFlow, atStep, current -- from head_vimma_setup_chapters.js */
/* global writes, notice, choiceNote -- from head_vimma_setup_chapters.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_setup_chapters.js",
  this,
);

const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);

registerCleanupFunction(() => {
  McpHost._clearHoldForTests();
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
});

/** `:mcp off`, as typed: its notice's text. */
const mcpOff = () =>
  McpHost.run(
    "off",
    () => {},
    () => {},
  );

/** From the welcome screen to chapter 5's first step, by its digit. */
async function toUpdates(/** @type {Document} */ doc) {
  await press(doc, "5");
  await atStep(doc, "updates");
}

add_task(async function updates_step_says_what_the_check_sends() {
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  const text = found(doc.getElementById("v2-text")).textContent;
  Assert.ok(text.includes("the update channel and the platform"), "what the check sends");
  Assert.ok(text.includes("Never check stops every request to updates.vimma.dev"), text);
  Assert.equal(current(doc), "Tell me when a release is out", "the default in force");
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "j");
  Assert.equal(writes(doc), "Writes [updates] check = false");
  await press(doc, "KEY_Enter");
  await atStep(doc, "agents");
  Assert.ok(
    (await IOUtils.readUTF8(configFile())).includes("[updates]\ncheck = false"),
    "[updates] check = false written at enter",
  );
  Assert.ok(!VimmaUpdates.status().enabled, "checks are off at once");
  // `:update` too: the check stops before any request.
  Assert.equal((await VimmaUpdates.check({ asked: true })).outcome, "off", "no request");
  await closeFlow(tab);
  await TestUtils.waitForCondition(() => VimmaUpdates.status().enabled, "on again");
});

add_task(async function agents_step_selects_off_first_and_writes_enabled_on_enter() {
  Assert.ok(!McpHost.state.enabled, "agents are off");
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  const text = found(doc.getElementById("v2-text"));
  Assert.equal(text.querySelectorAll("br").length, 2, "two lines, then :mcp off");
  Assert.ok(text.textContent.startsWith("Agents reach only the agent workspace."));
  Assert.ok(
    text.textContent.includes("Sending a form, paying and showing you a page always ask you"),
  );
  Assert.ok(text.textContent.includes(":mcp off turns agents off until :mcp on or a restart"));
  Assert.equal(current(doc), "Off", "off is selected first");
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "j");
  Assert.equal(current(doc), "On");
  Assert.equal(writes(doc), "Writes [mcp] enabled = true");
  Assert.equal(choiceNote(doc), "", "no hold to end, the workspace is Vimma's");
  const changed = TestUtils.topicObserved("vimma-mcp-changed");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  await changed;
  Assert.ok((await IOUtils.readUTF8(configFile())).includes("[mcp]\nenabled = true"));
  Assert.deepEqual(McpHost.state, { enabled: true, from: "config" }, "agents are on");
  Assert.ok(found(doc.getElementById("v2-last")).textContent.includes("agents are on"));
  Assert.ok(found(doc.getElementById("v2-stop-title")).textContent.includes("done"));
  await closeFlow(tab);
  Assert.ok(!McpHost.state.enabled, "off again without the file");
});

add_task(async function agents_on_ends_mcp_off_as_mcp_on_does() {
  const text = "schema = 2\n[mcp]\nenabled = true\n";
  await IOUtils.writeUTF8(configFile(), text);
  await ConfigHost.reload();
  Assert.ok(McpHost.state.enabled, "the file turns agents on");
  mcpOff();
  Assert.deepEqual(McpHost.state, { enabled: false, from: "session" }, ":mcp off holds");
  let { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  Assert.equal(current(doc), "Off", "off is in force under the hold");
  Assert.equal(writes(doc), "Writes nothing");
  Assert.equal(
    choiceNote(doc),
    "config.toml's [mcp] enabled = true turns agents on again at the next start.",
  );
  // Plain enter on off keeps the file and the hold (behaviour 8).
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.equal(await IOUtils.readUTF8(configFile()), text, "byte for byte");
  Assert.ok(!McpHost.state.enabled, "still held off");
  await press(doc, "h");
  await atStep(doc, "agents");
  await press(doc, "j");
  Assert.equal(writes(doc), "Writes nothing", "the file says on already");
  Assert.equal(choiceNote(doc), "Also ends :mcp off for this session.");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.equal(await IOUtils.readUTF8(configFile()), text, "nothing written");
  Assert.deepEqual(McpHost.state, { enabled: true, from: "config" }, "the hold ended, as y does");
  Assert.ok(found(doc.getElementById("v2-last")).textContent.includes("agents are on"));
  BrowserTestUtils.removeTab(tab);

  // Held without the key: on writes it, and ends the hold.
  await IOUtils.writeUTF8(configFile(), "schema = 2\n");
  await ConfigHost.reload();
  mcpOff();
  ({ tab, doc } = await openFlow());
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  await press(doc, "j");
  Assert.equal(writes(doc), "Writes [mcp] enabled = true");
  Assert.equal(choiceNote(doc), "Also ends :mcp off for this session.");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.deepEqual(McpHost.state, { enabled: true, from: "config" });
  await closeFlow(tab);
});

add_task(async function an_mcp_off_after_the_step_was_drawn_wins_over_its_enter() {
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  await press(doc, "j");
  Assert.equal(current(doc), "On");
  // Agents are off already, so `:mcp off` changes no state the page hears of: only the count
  // of `:mcp off`s, which the enter is checked against, as a yes to `:mcp on` is.
  mcpOff();
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.failed === "true", "refused");
  Assert.equal(
    notice(doc).textContent,
    "Not saved: :mcp off ran since this step was drawn; nothing written",
  );
  Assert.equal(step(doc), "agents", "the step stays open");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  Assert.ok(!McpHost.state.enabled, "agents stay off");
  // Drawn again after the refusal with the cursor on off, the row in force: a second enter at
  // once turns nothing on, as a refused yes needs `:mcp on` and `y` again.
  await atStep(doc, "agents");
  Assert.equal(current(doc), "Off", "the cursor is back on the row in force");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok(!McpHost.state.enabled, "a second enter turns nothing on");
  Assert.ok(!(await IOUtils.exists(configFile())), "and writes nothing");
  // Back, `j` and enter, on a screen drawn after the `:mcp off`: a new consent.
  await press(doc, "h");
  await atStep(doc, "agents");
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok(McpHost.state.enabled, "the newer consent turns agents on");
  await closeFlow(tab);
});

/** Resolves once the open step was drawn again after now. @param {Document} doc */
function redrawn(doc) {
  const real = SetupHost.stepView;
  return new Promise((resolve) => {
    SetupHost.stepView = async (...args) => {
      SetupHost.stepView = real;
      const v = await real.apply(SetupHost, args);
      // The page draws the view after this resolves; viewReady is set once it has.
      TestUtils.waitForCondition(() => doc.documentElement.dataset.viewReady === "true").then(() =>
        resolve(v),
      );
      return v;
    };
  });
}

add_task(async function an_mcp_off_the_page_hears_keeps_the_ticket_and_moves_the_cursor() {
  await IOUtils.writeUTF8(configFile(), "schema = 2\n[mcp]\nenabled = true\n");
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  Assert.equal(current(doc), "On", "on is in force, the cursor on it");
  // `:mcp off` in another window: agents were on, so the page hears of it and draws again.
  const again = redrawn(doc);
  mcpOff();
  await again;
  Assert.equal(current(doc), "Off", "the cursor follows the row in force");
  await press(doc, "j");
  Assert.equal(current(doc), "On");
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.failed === "true", "refused");
  Assert.equal(
    notice(doc).textContent,
    "Not saved: :mcp off ran since this step was drawn; nothing written",
    "the redraw did not take a new consent",
  );
  Assert.deepEqual(McpHost.state, { enabled: false, from: "session" }, "the hold stands");
  await closeFlow(tab);
  McpHost._clearHoldForTests();
});

add_task(async function a_config_read_redraw_keeps_the_ticket() {
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  await press(doc, "j");
  Assert.equal(current(doc), "On");
  // Agents are off already: `:mcp off` tells the page nothing, but a config read draws it again.
  mcpOff();
  const again = redrawn(doc);
  await IOUtils.writeUTF8(configFile(), 'schema = 2\n[ui]\ntoolbar = "shown"\n');
  await ConfigHost.reload();
  await again;
  Assert.equal(current(doc), "On", "the row in force did not change: the cursor stays");
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.failed === "true", "refused");
  Assert.ok(notice(doc).textContent.includes(":mcp off ran since this step was drawn"));
  Assert.ok(!McpHost.state.enabled, "agents stay off");
  Assert.ok(!(await IOUtils.readUTF8(configFile())).includes("[mcp]"), "nothing written");
  await closeFlow(tab);
  McpHost._clearHoldForTests();
});

add_task(async function a_workspace_gone_during_the_write_holds_agents_off() {
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  await press(doc, "j");
  // The agent workspace goes away after the write was planned, before the hold is ended.
  const realSet = ConfigHost.setConfigKeys;
  ConfigHost.setConfigKeys = async (...args) => {
    const r = await realSet.apply(ConfigHost, args);
    Object.defineProperty(WorkspaceStore, "agent", { value: null, configurable: true });
    return r;
  };
  try {
    await press(doc, "KEY_Enter");
    await TestUtils.waitForCondition(
      () => doc.documentElement.dataset.failed === "true",
      "refused",
    );
  } finally {
    ConfigHost.setConfigKeys = realSet;
    delete (/** @type {{ agent?: unknown }} */ (WorkspaceStore).agent);
  }
  Assert.ok(
    notice(doc).textContent.includes("config.toml was written, agents stay off"),
    notice(doc).textContent,
  );
  Assert.ok((await IOUtils.readUTF8(configFile())).includes("[mcp]\nenabled = true"), "written");
  Assert.deepEqual(
    McpHost.state,
    { enabled: false, from: "session" },
    "held off, so the page's words are true",
  );
  await closeFlow(tab);
  McpHost._clearHoldForTests();
});

add_task(async function a_redraw_during_the_load_after_a_refusal_keeps_the_cursor_on_off() {
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  await press(doc, "j");
  mcpOff();
  // The load the refusal asks for waits; a config read's redraw arrives and finishes first.
  const real = SetupHost.stepView;
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  let freshAsked = false;
  SetupHost.stepView = async (b, id, options) => {
    if (options?.fresh && !freshAsked) {
      freshAsked = true;
      // Superseded by the redraw: the page drops whatever it answers, so it answers nothing,
      // and the list the redraw was sent stays the host's last.
      await held;
      return null;
    }
    return real.call(SetupHost, b, id, options);
  };
  try {
    await press(doc, "KEY_Enter");
    await TestUtils.waitForCondition(() => freshAsked, "the load after the refusal started");
    await IOUtils.writeUTF8(configFile(), 'schema = 2\n[ui]\ntoolbar = "shown"\n');
    await ConfigHost.reload();
    await TestUtils.waitForCondition(
      () => doc.documentElement.dataset.viewReady === "true",
      "drawn again",
    );
  } finally {
    release();
    SetupHost.stepView = real;
  }
  // The refused enter finishes once the held load returns (dropped, as superseded).
  await TestUtils.waitForCondition(
    () => doc.documentElement.dataset.failed === "true" && !doc.documentElement.dataset.busy,
    "the refusal is shown",
  );
  Assert.equal(current(doc), "Off", "the redraw kept the load fresh: the cursor is on off");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok(!McpHost.state.enabled, "a second enter turns nothing on");
  await closeFlow(tab);
  McpHost._clearHoldForTests();
});

add_task(async function a_redraw_with_no_ticket_takes_none() {
  const { tab, doc } = await openFlow();
  await toUpdates(doc);
  await press(doc, "s");
  await atStep(doc, "agents");
  const b = tab.linkedBrowser;
  // An enter spends the ticket; a redraw that is not an arrival at the step takes no new one.
  const first = found(await SetupHost.stepView(b, "agents", { fresh: true }));
  Assert.ok("written" in (await SetupHost.saveStep(b, "agents", 0, first.serial)), "off saved");
  const v = found(await SetupHost.stepView(b, "agents"));
  Assert.deepEqual(await SetupHost.saveStep(b, "agents", 1, v.serial), {
    error: "no consent asked; nothing written",
  });
  Assert.ok(!McpHost.state.enabled, "agents stay off");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

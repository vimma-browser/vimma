/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 3: `vimma_fill` (`agent-fill`) fills fields of an agent
// tab by their labels from `vimma_elements`, in the background, as Firefox's form autofill fills
// them: `setUserInput` for text, the option and `input` and `change` for a select, `click()` for
// a checkbox or radio, never focusing the field (F12; security.md M25). Password, payment card,
// one-time-code and file fields, hidden, disabled and read-only fields and rich text editors are
// refused before anything is asked, and a field that turns sensitive after the question stops the
// call (F13; M27). A fill that submits asks every time, also under a grant, and a page that
// submits by itself after a fill is stopped (F15, F16; M28). The values are in the question and
// in `:mcp log` (F14; M32), fills share the clicks' rate (F26), and a tab the user is typing in
// is `in-use` (F27).

"use strict";

/* global focusContent -- from head.js */
/* global Client, tidyTask -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentAct } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentAct.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
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
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const FILL = `${DIR}file_vimma_agent_fill.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const CLICK = `${DIR}file_vimma_agent_click.html`;
const NOTICE_ID = "vimma-notice";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";

registerCleanupFunction(async () => {
  AgentAct._settleMs = null;
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  await VimmaControl.settled();
  ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => WindowWorkspaces.get(window);
const activeName = () => ww().model.workspaces.find((w) => w.id === ww().model.active)?.name;
const mainId = () => ww().model.workspaces.find((w) => w.name === "main")?.id;
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = FILL) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** The connections the running task opened. @type {any[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  AgentAct._settleMs = 50;
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await mcp(false);
}

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/** The list's elements by what they say. @param {any} c @param {any} tab */
async function labels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  // Under a grant the list runs unasked (mcp-grants G1).
  if (!AgentGate.grants().length) AgentGate.answer((await question()).id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "vimma_elements runs");
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of r.result.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = e.label;
  }
  return by;
}

/**
 * `agent-fill` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {{ label: string, value: string | boolean }[]} fields
 * @param {{ answer?: object | null, submit?: true | string, asked?: (q: any) => any }} [o]
 */
async function fill(c, tab, fields, { answer = { kind: "once" }, submit, asked } = {}) {
  const id = c.request("agent-fill", {
    tab: idOf(tab),
    fields,
    ...(submit === undefined ? {} : { submit }),
  });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_fill", "agent-fill asks as vimma_fill");
    await asked?.(q);
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-fill" });
    Assert.deepEqual(v.errors, [], "a valid agent-fill result");
  }
  return r;
}

/**
 * The status of the next request to a URL starting with `prefix`, once every observer of it
 * has run: NS_BINDING_ABORTED when Vimma cancelled it.
 * @param {string} prefix
 * @returns {Promise<number>}
 */
function requestStatus(prefix) {
  return new Promise((resolve) => {
    const observe = (/** @type {any} */ subject) => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (!channel.URI.spec.startsWith(prefix)) return;
      Services.obs.removeObserver(observe, "http-on-modify-request");
      Services.tm.dispatchToMainThread(() => resolve(channel.status));
    };
    Services.obs.addObserver(observe, "http-on-modify-request");
  });
}

/** What the page's fields hold, and the events they got. @param {any} tab */
const page = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const d = content.document;
    const v = (/** @type {string} */ id) => /** @type {any} */ (d.getElementById(id)).value;
    const on = (/** @type {string} */ id) => /** @type {any} */ (d.getElementById(id)).checked;
    return {
      email: v("email"),
      name: v("name"),
      country: v("country"),
      remember: on("remember"),
      free: on("free"),
      pro: on("pro"),
      bio: v("bio"),
      age: v("age"),
      day: v("day"),
      pw: v("pw"),
      otp: v("otp"),
      cc: v("cc"),
      cardno: v("cardno"),
      files: /** @type {any} */ (d.getElementById("upload")).files.length,
      stubborn: v("stubborn"),
      q: v("q"),
      events: JSON.parse(JSON.stringify(content.wrappedJSObject.events)),
      focused: d.activeElement?.localName ?? "",
      gesture: d.hasValidTransientUserGestureActivation,
    };
  });

add_task(async function setup() {
  // A fill that starts no load is over at once: many fills stay quick.
  AgentAct._settleMs = 50;
});

addTidyTask(async function test_fill_sets_values_and_fires_input_and_change() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  const fields = [
    { label: by.Email, value: "ada@example.com" },
    { label: by.Name, value: "Ada Lovelace" },
    { label: by.Country, value: "Sweden" },
    { label: by.Remember, value: false },
    { label: by.Pro, value: true },
    { label: by.Bio, value: "two\nlines" },
    { label: by.Age, value: "36" },
    { label: by.Day, value: "1815-12-10" },
  ];
  /** @type {any} */
  let what = null;
  const r = await fill(c, tab, fields, { asked: (q) => (what = q.what) });
  Assert.ok(r.ok, `the fill ran: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.filled, 8, "every field was filled");
  Assert.ok(!("reset" in r.result), "every value stuck");
  Assert.equal(r.result.navigated, false, "the page stayed");
  Assert.equal(r.result.url, FILL, "on the form");
  Assert.deepEqual(
    what.fields.slice(0, 2),
    [
      { label: by.Email, name: "Email", value: "ada@example.com" },
      { label: by.Name, name: "Name", value: "Ada Lovelace" },
    ],
    "the question names each field and its value (F14)",
  );
  const p = await page(tab);
  Assert.deepEqual(
    [p.email, p.name, p.country, p.remember, p.free, p.pro, p.bio, p.age, p.day],
    ["ada@example.com", "Ada Lovelace", "se", false, false, true, "two\nlines", "36", "1815-12-10"],
    "the page's fields hold the values",
  );
  for (const id of ["email", "name", "country", "remember", "pro", "bio", "age", "day"]) {
    Assert.ok(p.events.includes(`${id}:input:trusted`), `${id} got input`);
    // A text area gets no change from setUserInput, as when form autofill fills it.
    if (id !== "bio") Assert.ok(p.events.includes(`${id}:change:trusted`), `${id} got change`);
  }
  Assert.ok(!p.events.some((e) => e.includes(":keydown:")), "no key event was sent");
  Assert.equal(p.gesture, false, "the page got no user activation (M26)");
  Assert.ok(
    AgentGate.log[0].detail.startsWith(`${by.Email} Email = "ada@example.com", `),
    ":mcp log names each field and value",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fill_never_focuses_the_field() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const before = { selected: gBrowser.selectedTab, workspace: activeName() };
  const r = await fill(c, tab, [
    { label: by.Email, value: "ada@example.com" },
    { label: by.Country, value: "se" },
  ]);
  Assert.ok(r.ok, "the fill ran");
  const p = await page(tab);
  Assert.ok(!p.events.some((e) => e.includes(":focus:")), "no field got focus");
  Assert.equal(p.focused, "body", "the page's focus did not move");
  Assert.equal(gBrowser.selectedTab, before.selected, "the window's tab did not change (M25)");
  Assert.equal(activeName(), before.workspace, "nor its workspace");
  Assert.equal(VimmaHost.status(window).mode, "normal", "nor its mode");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fill_refuses_password_card_otp_and_file_fields() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  for (const [field, value, message] of [
    [by.Password, "hunter2", `field "${by.Password}" is a password field; Vimma never fills it`],
    [by.Code, "123456", `field "${by.Code}" is a one-time-code field; Vimma never fills it`],
    [by.Card, "4111111111111111", `field "${by.Card}" is a payment card field`],
    [by.cardnumber, "4111111111111111", `field "${by.cardnumber}" is a payment card field`],
    [by.cvc, "737", `field "${by.cvc}" is a payment card field`],
    [by.Upload, "/etc/passwd", `field "${by.Upload}" is a file field; Vimma never fills it`],
    [by.Readonly, "x", `field "${by.Readonly}" is read-only`],
    [by.Off, "x", `field "${by.Off}" is disabled`],
    [by.Rich, "x", `label "${by.Rich}" is a rich text editor`],
    [by.Plain, "x", `label "${by.Plain}" is a button, not a field: use vimma_activate`],
    [by.Free, false, `field "${by.Free}" is a radio button: to unselect it`],
    [by.Remember, "yes", `field "${by.Remember}" is a checkbox: its value is true or false`],
    [by.Name, "a\nb", `field "${by.Name}" is one line`],
    [by.Country, "Norway", `select "${by.Country}" has no option with the value or text "Norway"`],
    [by.Day, "tomorrow", `field "${by.Day}" does not take "tomorrow" as a date`],
    [by.Age, "many", `field "${by.Age}" does not take "many" as a number`],
  ]) {
    Assert.ok(field, `the list has ${message}`);
    // A refused field among good ones refuses the whole call.
    const r = await c.call("agent-fill", {
      tab: idOf(tab),
      fields: [
        { label: by.Email, value: "ada@example.com" },
        { label: field, value },
      ],
    });
    Assert.equal(r.error?.code, "failed", `refused: ${message}`);
    Assert.ok(r.error?.message.startsWith(message), `${r.error?.message} says ${message}`);
    Assert.equal(AgentGate.waiting.length, 0, "before anything is asked (M27)");
    Assert.equal(AgentGate.log[0].outcome, "failed", "and logged");
  }
  const p = await page(tab);
  Assert.deepEqual(
    [p.email, p.pw, p.otp, p.cc, p.cardno, p.files],
    ["", "", "", "", "", 0],
    "nothing was filled",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fill_stops_when_a_field_turns_sensitive() {
  await mcp(true);
  const c = await agentClient();
  for (const [type, attr] of [
    ["password", null],
    ["text", "cc-number"],
    ["file", null],
  ]) {
    // A fresh page each time: a field that was ever a password field stays sensitive.
    const tab = await openAgentTab();
    const by = await labels(c, tab);
    const r = await fill(
      c,
      tab,
      [
        { label: by.Name, value: "Ada" },
        { label: by.Email, value: "ada@example.com" },
      ],
      {
        // Between the question and the answer the page turns the email field into a secret.
        asked: () =>
          SpecialPowers.spawn(tab.linkedBrowser, [type, attr], (t, a) => {
            const email = /** @type {any} */ (content.document.getElementById("email"));
            email.type = t;
            if (a) email.setAttribute("autocomplete", a);
          }),
      },
    );
    Assert.equal(r.error?.code, "failed", `${type} ${attr}: the call stopped (M27)`);
    Assert.ok(
      r.error?.message.includes("changed since the user was asked") &&
        r.error.message.includes("1 of 2 fields were filled"),
      `it says so: ${r.error?.message}`,
    );
    const p = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
      name: /** @type {any} */ (content.document.getElementById("name")).value,
      email: /** @type {any} */ (content.document.getElementById("email")).value,
      files: /** @type {any} */ (content.document.getElementById("email")).files?.length ?? 0,
    }));
    Assert.equal(p.name, "Ada", "the field before it was filled");
    Assert.equal(p.email, "", "the field that turned secret was not");
    Assert.equal(p.files, 0, "and holds no file");
    Assert.equal(AgentGate.log[0].outcome, "stopped", ":mcp log says the call stopped");
    BrowserTestUtils.removeTab(tab);
  }
  c.close();
  await mcp(false);
});

addTidyTask(async function test_fill_reports_a_value_the_page_put_back() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await fill(c, tab, [
    { label: by.Stubborn, value: "changed" },
    { label: by.Email, value: "ada@example.com" },
  ]);
  Assert.ok(r.ok, "the fill ran");
  Assert.equal(r.result.filled, 2, "both fields were set");
  Assert.deepEqual(r.result.reset, [by.Stubborn], "the result names the one the page put back");
  Assert.equal((await page(tab)).stubborn, "keep", "the page's value");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fill_submit_asks_under_a_grant() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  let r = await fill(c, tab, [{ label: by.Name, value: "Ada" }], {
    answer: { kind: "grant", minutes: 12 },
  });
  Assert.ok(r.ok, "a grants vimma_fill");
  r = await fill(c, tab, [{ label: by.Name, value: "Ada L." }], { answer: null });
  Assert.ok(r.ok, "the next fill runs unasked");
  await until(
    () => noticeText().startsWith('claude-code filled 1 field in "Fill agent fixture" (grant'),
    "with a notice naming the page",
  );
  Assert.equal(AgentGate.log[0].outcome, "grant", "and a row in :mcp log (M32)");
  /** @type {any} */
  let what = null;
  r = await fill(c, tab, [{ label: by.Query, value: "cats" }], {
    submit: true,
    answer: { kind: "grant", minutes: 60 },
    asked: (q) => (what = q.what),
  });
  Assert.deepEqual(
    what.submit,
    { method: "get", action: PAGE, host: "example.com", fields: 1 },
    "a fill that submits asks under the grant, with the form's destination (M28)",
  );
  Assert.ok(r.ok, `the fill and submit ran: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.navigated, true, "the form was sent");
  Assert.equal(r.result.url, `${PAGE}?q=cats`, "to its destination, with the value");
  Assert.ok(!("blocked" in r.result), "the submission the user allowed was not stopped");
  Assert.ok(
    AgentGate.grants().every((g) => g.until < Date.now() + 13 * 60_000),
    "the yes to a submit made no grant of 60 min",
  );
  Assert.ok(
    AgentGate.log[0].detail.endsWith(`→ GET ${PAGE} (1 field)`),
    ":mcp log names the destination",
  );
  // A submit button's label: asked again, under the grant.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, FILL);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, FILL);
  const again = await labels(c, tab);
  r = await fill(c, tab, [{ label: again.Query, value: "dogs" }], {
    submit: again.Search,
    asked: (q) => (what = q.what),
  });
  Assert.equal(what.submit?.host, "example.com", "asked as a submission");
  Assert.equal(r.result?.url, `${PAGE}?q=dogs`, "sent through its button");
  // A label that is no submit button is refused before anything is asked.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, FILL);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, FILL);
  const third = await labels(c, tab);
  r = await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: third.Query, value: "x" }],
    submit: third.Plain,
  });
  Assert.ok(r.error?.message.includes("not a submit button"), `refused: ${r.error?.message}`);
  // `true` needs every field in one form.
  r = await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [
      { label: third.Query, value: "x" },
      { label: third.Email, value: "ada@example.com" },
    ],
    submit: true,
  });
  Assert.ok(r.error?.message.includes("one form"), `refused: ${r.error?.message}`);
  Assert.equal(AgentGate.waiting.length, 0, "nothing was asked");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

/** The click fixture's forms whose button is skipped, then sends the form itself (M28). */
const BOUNCES = [
  { form: "bounce", button: "Bounce", field: "Bounce note", how: "100 ms later" },
  { form: "bounce-now", button: "Bounce now", field: "Bounce now note", how: "at once" },
  {
    form: "bounce-busy",
    button: "Bounce busy",
    field: "Bounce busy note",
    how: "after 1.2 s busy",
  },
];

addTidyTask(async function test_a_skipped_submit_is_not_sent_and_allows_nothing_after_it() {
  await mcp(true);
  AgentAct._settleMs = null;
  const c = await agentClient();
  for (const { form, button, field, how } of BOUNCES) {
    const tab = await openAgentTab(CLICK);
    const by = await labels(c, tab);
    const sent = requestStatus(`${PAGE}?${form}-note=`);
    // The page moves the destination as its submit button is pressed, so the click is skipped;
    // then it puts the destination back and calls submit(), which matches what was allowed.
    const r = await fill(c, tab, [{ label: by[field], value: "hello" }], { submit: by[button] });
    Assert.ok(
      r.error?.message.startsWith("the form changed since the user was asked; it was not sent"),
      `${how}: the fill says the form was not sent: ${r.error?.message}`,
    );
    Assert.equal(await sent, Cr.NS_BINDING_ABORTED, `${how}: the page's submission was cancelled`);
    await until(
      async () =>
        await SpecialPowers.spawn(
          tab.linkedBrowser,
          [form],
          (f) => content.wrappedJSObject.bounced[f],
        ),
      `${how}: the page sent the form itself`,
    );
    Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, `${how}: the page stayed`);
    BrowserTestUtils.removeTab(tab);
  }
  c.close();
  await mcp(false);
});

/**
 * Names the page function Vimma's child calls just before it checks an agent's form
 * submission in `tab`'s process (VimmaChild._beforeSubmitCheck), or null for none.
 * @param {any} tab @param {string | null} name
 */
const beforeSubmitCheck = (tab, name) =>
  SpecialPowers.spawn(tab.linkedBrowser, [name], (n) => {
    const { VimmaChild } = ChromeUtils.importESModule(
      "chrome://browser/content/vimma/actors/VimmaChild.sys.mjs",
    );
    VimmaChild._beforeSubmitCheck = n;
  });

addTidyTask(async function test_a_skipped_default_submit_is_not_sent_and_allows_nothing_after_it() {
  await mcp(true);
  AgentAct._settleMs = null;
  const tab = await openAgentTab(CLICK);
  const c = await agentClient();
  const by = await labels(c, tab);
  // The form's default submission, not a button's click: just before the child's check the
  // page moves the destination, so the submission is skipped, then at once it puts it back and
  // calls submit(), which matches what was allowed.
  await beforeSubmitCheck(tab, "bounceForm");
  try {
    const sent = requestStatus(`${PAGE}?bounce-note=`);
    const r = await fill(c, tab, [{ label: by["Bounce note"], value: "hello" }], { submit: true });
    Assert.ok(
      r.error?.message.startsWith("the form changed since the user was asked; it was not sent"),
      `the fill says the form was not sent: ${r.error?.message}`,
    );
    Assert.equal(await sent, Cr.NS_BINDING_ABORTED, "the page's own submission was cancelled");
    await until(
      async () =>
        await SpecialPowers.spawn(
          tab.linkedBrowser,
          [],
          () => content.wrappedJSObject.bounced["bounce-form"],
        ),
      "the page sent the form itself",
    );
    Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "the page stayed");
  } finally {
    await beforeSubmitCheck(tab, null);
  }
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_page_script_submit_after_a_fill_is_cancelled() {
  await mcp(true);
  AgentAct._settleMs = null;
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await fill(c, tab, [{ label: by.Note, value: "hello" }]);
  Assert.ok(r.ok, "the fill ran");
  Assert.equal(r.result.navigated, false, "the form the page sent was not sent (M28)");
  Assert.equal(r.result.blocked, "example.com", "the result says Vimma stopped it");
  Assert.equal(tab.linkedBrowser.currentURI.spec, FILL, "the page stayed");
  AgentAct._settleMs = 50;
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_a_page_submit_during_a_fill_is_not_the_asked_one() {
  await mcp(true);
  AgentAct._settleMs = null;
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // The first field's change submits the form before the second is filled: that submission is
  // the page's, with half the values, and only the one after the last field is allowed.
  const r = await fill(
    c,
    tab,
    [
      { label: by.First, value: "one" },
      { label: by.Second, value: "two" },
    ],
    { submit: true },
  );
  Assert.ok(r.ok, `the fill ran: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.filled, 2, "both fields were filled");
  Assert.equal(r.result.blocked, "example.com", "the page's own submission was stopped (M28)");
  Assert.equal(r.result.navigated, true, "the asked submission, after the last field, was sent");
  Assert.equal(r.result.url, `${PAGE}?early`, "to its destination");
  AgentAct._settleMs = 50;
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_selects_ranges_and_a_submit_button_of_another_form() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  let r = await fill(c, tab, [{ label: by.Tags, value: "Beta" }]);
  Assert.ok(r.ok, "a multiple select is filled");
  const picked = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    [.../** @type {any} */ (content.document.getElementById("tags")).selectedOptions].map(
      (o) => o.value,
    ),
  );
  Assert.deepEqual(picked, ["b"], "with that option alone, as the question showed");
  for (const [field, value, message] of [
    [by.Size, "XL", `select "${by.Size}" has no option with the value or text "XL"`],
    [by.Volume, "50", `field "${by.Volume}" does not take "50" as a range`],
  ]) {
    r = await c.call("agent-fill", { tab: idOf(tab), fields: [{ label: field, value }] });
    Assert.ok(r.error?.message.startsWith(message), `${r.error?.message} says ${message}`);
  }
  // A submit button must send the filled fields' own form.
  r = await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by.Query, value: "cats" }],
    submit: by["Sign up"],
  });
  Assert.ok(r.error?.message.includes("same form"), `refused: ${r.error?.message}`);
  // A fill that submits must show every value whole in its question.
  r = await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by.Query, value: "x".repeat(60) }],
    submit: true,
  });
  Assert.ok(r.error?.message.includes("does not fit"), `refused: ${r.error?.message}`);
  Assert.equal(AgentGate.waiting.length, 0, "nothing was asked");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fill_reports_a_dialog_and_stops() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await fill(c, tab, [
    { label: by.Alerting, value: "x" },
    { label: by.Query, value: "cats" },
  ]);
  Assert.ok(r.ok, "the fill ran");
  Assert.equal(r.result.dialog?.type, "alert", "the result names the dialog");
  Assert.ok(r.result.dialog.text.includes("Saved"), "with its text");
  Assert.equal(r.result.filled, 1, "the fields after it were not filled");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fill_in_use_while_the_user_types() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("q").focus(),
  );
  await until(() => VimmaHost.status(window).mode === "insert", "the user is in insert mode");
  const r = await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by.Email, value: "ada@example.com" }],
  });
  Assert.equal(r.error?.reason, "in-use", "a tab the user types in is denied (F27)");
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");
  Assert.equal((await page(tab)).email, "", "nothing was filled");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_fills_take_labels_only_from_elements_and_share_the_click_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient();
  // No list yet: nothing to fill.
  let r = await c.call("agent-fill", { tab: idOf(tab), fields: [{ label: "sd", value: "x" }] });
  Assert.ok(r.error?.message.includes("call vimma_elements"), `refused: ${r.error?.message}`);
  const by = await labels(c, tab);
  // 30 clicks and fills a minute together, counted when asked (F26): 1 so far.
  let busy = null;
  for (let i = 0; i < 30 && !busy; i++) {
    const x =
      i % 2
        ? await c.call("agent-activate", { tab: idOf(tab), label: by.Email })
        : await c.call("agent-fill", { tab: idOf(tab), fields: [{ label: by.Plain, value: "x" }] });
    if (x.error?.reason === "busy") busy = { i, x };
  }
  Assert.equal(busy?.i, 29, "the 31st click or fill in a minute is refused");
  Assert.equal(AgentGate.log[0].outcome, "busy", "and logged");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

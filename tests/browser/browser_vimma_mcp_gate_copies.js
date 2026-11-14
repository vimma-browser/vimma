/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Security: docs/security.md M62 (issue #1018). What the agent gate keeps from a caller, and what
// it hands to a reader (its getters, its listeners' events), is its own frozen copy: a caller that
// changes its request after asking, or a module that changes a label, a question or a log row it
// read, changes neither what the question shows, what the answer is checked against, nor
// `:mcp log`.

"use strict";

const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { AgentUi } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/agent-ui.mjs");

/** Connection ids no socket hands out, so these are this file's own. */
const CONN = 1018001;
const OTHER = 1018002;
const ASKED = "https://asked.example/";
const LATER = "https://later.example/";
const READER = "https://reader.example/";

registerCleanupFunction(() => {
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  AgentGate.revoke();
  AgentGate.disconnect(CONN);
  AgentGate.disconnect(OTHER);
});

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const line = () =>
  /** @type {HTMLElement | null} */ (document.getElementById("vimma-agent-prompt"));
const lineText = () => {
  const l = line();
  return l && !l.hidden ? (l.textContent ?? "").replace(/[⁨⁩]/g, "") : "";
};
/** @param {number} conn */
const labelOf = (conn) =>
  AgentGate.grants().find((/** @type {{ conn: unknown }} */ g) => g.conn === conn)?.label ?? null;
/** The waiting question of `conn`. @param {number} conn */
const questionOf = (conn) => AgentGate.waiting.find((q) => q.conn === conn);
/** A write the way any module could try it; false when the object is frozen. */
const tryWrite = (/** @type {any} */ o, /** @type {string} */ key, /** @type {unknown} */ v) =>
  Reflect.set(o, key, v);

// A reader of `connections` or `waiting` that renames a connection, and a caller that changes its
// request after it asked: the question line, the waiting question, the answer's event and the log
// row all still show the agent's own name and the URL it asked for.
add_task(async function test_question_and_log_show_what_was_asked() {
  AgentGate.connect(CONN, { client: "agent-a", via: "test" });
  const conn = AgentGate.connections.find((l) => l.client === "agent-a");
  Assert.ok(conn, "the connection is listed");
  tryWrite(conn, "client", "built-in agent");
  Assert.ok(
    AgentGate.connections.some((l) => l.client === "agent-a"),
    "a reader cannot rename a connection",
  );

  /** @type {any[]} */
  const events = [];
  const listener = (/** @type {any} */ e) => {
    if (e && "question" in e && e.question.conn === CONN) {
      // A listener that changes what it was told, before the others hear it.
      tryWrite(e.question.what, "url", READER);
      tryWrite(e.question.label, "client", "built-in agent");
      events.push(e);
    }
  };
  AgentGate.addListener(listener);
  try {
    const what = { url: ASKED, host: "asked.example", title: "Asked" };
    const outcome = AgentGate.request(CONN, "vimma_open", what);
    // The caller changes its own object after asking.
    what.url = LATER;
    what.host = "later.example";
    const q = questionOf(CONN);
    Assert.ok(q, "the open asks");
    const asked = /** @type {NonNullable<typeof q>} */ (q);
    tryWrite(asked.label, "client", "built-in agent");
    tryWrite(asked.what, "url", READER);
    tryWrite(asked, "tool", "vimma_read_page");

    const again = /** @type {NonNullable<typeof q>} */ (questionOf(CONN));
    Assert.equal(again.label.client, "agent-a", "the waiting question keeps the agent's name");
    Assert.equal(/** @type {any} */ (again.what).url, ASKED, "and the URL it asked for");
    Assert.equal(again.tool, "vimma_open", "and its tool");
    Assert.equal(what.url, LATER, "a reader's write never reaches the caller's object");
    Assert.equal(events[0]?.question.what.url, ASKED, "the asked event keeps the URL");
    Assert.equal(events[0]?.question.label.client, "agent-a", "and the name");

    AgentUi.answer(window);
    await until(() => lineText().includes("agent-a"), "the question line shows the agent's name");
    const shown = lineText();
    Assert.ok(shown.includes("asked.example"), `the line shows the asked host: ${shown}`);
    Assert.ok(!shown.includes("built-in"), "not the name a reader wrote");
    Assert.ok(!shown.includes("later.example") && !shown.includes("reader.example"), "nor a URL");

    AgentGate.answer(again.id, { kind: "once" });
    Assert.ok((await outcome).allow, "the yes allows");
    const answered = events.find((e) => e.kind === "answered");
    Assert.equal(answered?.question.what.url, ASKED, "the answered event keeps the URL");

    const row = AgentGate.log[0];
    Assert.equal(row?.client, "agent-a", "the log row names the agent");
    Assert.equal(row?.detail, ASKED, "and the URL it asked for");
    tryWrite(row, "client", "built-in agent");
    tryWrite(row, "detail", READER);
    Assert.equal(AgentGate.log[0]?.client, "agent-a", "a reader cannot change a log row");
    Assert.equal(AgentGate.log[0]?.detail, ASKED, "nor its URL");
  } finally {
    AgentGate.removeListener(listener);
    for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
    AgentGate.disconnect(CONN);
  }
});

// The answer is checked against what the question showed: a dangerous download whose caller
// drops `danger` after asking still makes no grant, and `a` on a form allows the button the
// question named, not one a reader or the caller wrote into the request after it asked.
add_task(async function test_a_dangerous_download_stays_one_file_after_the_caller_changes_it() {
  AgentGate.connect(CONN, { client: "agent-a" });
  try {
    /** @type {Record<string, unknown>} */
    const file = { name: "setup.exe", size: 10, host: "asked.example", danger: "a program" };
    const download = AgentGate.request(CONN, "vimma_download", file, { always: true });
    delete file.danger;
    const dq = /** @type {NonNullable<ReturnType<typeof questionOf>>} */ (questionOf(CONN));
    Assert.equal(
      AgentGate.answer(dq.id, { kind: "grant", minutes: 5 }),
      null,
      "a grant answer to the dangerous file the user saw makes no grant",
    );
    Assert.equal(labelOf(CONN), null, "the connection has no grant");
    AgentGate.answer(dq.id, { kind: "once" });
    Assert.ok((await download).allow, "that one file is allowed");
  } finally {
    for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
    AgentGate.revoke();
    AgentGate.disconnect(CONN);
  }
});

add_task(async function test_a_here_answer_allows_the_button_the_question_named() {
  AgentGate.connect(CONN, { client: "agent-a" });
  try {
    // A grant, then a form checkpoint that offers `a` for one button.
    const read = AgentGate.request(CONN, "vimma_read_page", { url: ASKED });
    AgentGate.answer(/** @type {any} */ (questionOf(CONN)).id, { kind: "grant", minutes: 5 });
    Assert.ok((await read).allow, "granted");
    const buy = "asked.example|form|buy";
    const other = "asked.example|form|other";
    const form = {
      url: ASKED,
      submit: { method: "post", action: `${ASKED}buy`, host: "asked.example" },
      here: { site: "asked.example", key: buy },
    };
    const click = AgentGate.request(CONN, "vimma_activate", form, { always: true, covered: buy });
    const fq = /** @type {NonNullable<ReturnType<typeof questionOf>>} */ (questionOf(CONN));
    tryWrite(/** @type {any} */ (fq.what).here, "key", other);
    form.here.key = other;
    AgentGate.answer(fq.id, { kind: "here" });
    Assert.ok((await click).allow, "a allows the button");

    const otherClick = AgentGate.request(CONN, "vimma_activate", form, {
      always: true,
      covered: other,
    });
    const waits = questionOf(CONN);
    Assert.ok(waits, "a button the question never named still asks");
    if (waits) AgentGate.answer(waits.id, { kind: "deny" });
    Assert.ok(!(await otherClick).allow, "and is denied here");
    const same = await AgentGate.request(CONN, "vimma_activate", form, {
      always: true,
      covered: buy,
    });
    Assert.ok(same.allow, "the button the question named runs under the allowance");
  } finally {
    for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
    AgentGate.revoke();
    AgentGate.disconnect(CONN);
  }
});

// A call under a grant: one listener that changes its event leaves the next listener's as the
// gate sent it, and a grant's label read from `grants()` cannot rename the connection.
add_task(async function test_ran_events_and_grant_labels_are_the_gates_own() {
  AgentGate.connect(OTHER, { client: "agent-b" });
  try {
    const read = AgentGate.request(OTHER, "vimma_read_page", { url: ASKED });
    AgentGate.answer(/** @type {any} */ (questionOf(OTHER)).id, { kind: "grant", minutes: 5 });
    Assert.ok((await read).allow, "granted");
    const label = labelOf(OTHER);
    Assert.equal(label?.client, "agent-b", "the grant names its agent");
    tryWrite(label, "client", "built-in agent");
    Assert.equal(labelOf(OTHER)?.client, "agent-b", "a reader cannot rename it through grants()");

    /** @type {any[]} */
    const seen = [];
    const first = (/** @type {any} */ e) => {
      if (e?.kind !== "ran" || e.conn !== OTHER) return;
      tryWrite(e.what, "url", READER);
      tryWrite(e.label, "client", "built-in agent");
      tryWrite(e, "tool", "vimma_close_tab");
    };
    const second = (/** @type {any} */ e) => {
      if (e?.kind === "ran" && e.conn === OTHER) seen.push(e);
    };
    AgentGate.addListener(first);
    AgentGate.addListener(second);
    try {
      const what = { url: ASKED, title: "Asked" };
      const ran = AgentGate.request(OTHER, "vimma_read_page", what);
      what.url = LATER;
      Assert.ok((await ran).allow, "runs under the grant");
      Assert.equal(seen[0]?.what.url, ASKED, "the next listener hears the URL that ran");
      Assert.equal(seen[0]?.label.client, "agent-b", "and the agent's name");
      Assert.equal(seen[0]?.tool, "vimma_read_page", "and the tool");
      Assert.equal(AgentGate.log[0]?.detail, ASKED, "the log row has the URL that ran");
    } finally {
      AgentGate.removeListener(first);
      AgentGate.removeListener(second);
    }
  } finally {
    AgentGate.revoke();
    AgentGate.disconnect(OTHER);
  }
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Security: docs/security/12-agents-mcp.md M62 (issue #1018). What the agent gate keeps from a
// caller, and what it hands to a reader (its getters, its listeners' events), is its own frozen
// copy: a caller that changes its request after asking, or a module that changes a label, a
// question or a log row it read, changes neither what the question shows, what the answer is
// checked against, nor `:mcp log`.

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
  Assert.ok(Object.isFrozen(AgentGate.connections), "connections is a frozen array");
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

    Assert.ok(Object.isFrozen(AgentGate.waiting), "waiting is a frozen array");
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

    Assert.ok(Object.isFrozen(AgentGate.log), "log is a frozen array");
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
    const same = AgentGate.request(CONN, "vimma_activate", form, { always: true, covered: buy });
    // Answered when it asks instead, so a failure here never hangs the file.
    const asks = questionOf(CONN);
    if (asks) AgentGate.answer(asks.id, { kind: "deny" });
    Assert.ok(!asks, "the button the question named does not ask");
    Assert.ok((await same).allow, "it runs under the allowance");
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
    const grants = AgentGate.grants();
    Assert.ok(Object.isFrozen(grants), "grants() is a frozen array");
    const mine = grants.find((/** @type {{ conn: unknown }} */ g) => g.conn === OTHER);
    Assert.ok(mine && Object.isFrozen(mine), "and each grant in it is frozen");
    Assert.equal(tryWrite(mine, "until", 0), false, "so a reader cannot change its end");
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

// The other flags the answer is checked against (a file Vimma could not scan, a payment's `a`):
// a caller that drops one after asking changes nothing, as for `danger` above.
add_task(async function test_unscanned_and_pay_are_checked_as_asked() {
  AgentGate.connect(CONN, { client: "agent-a" });
  try {
    /** @type {Record<string, unknown>} */
    const file = { name: "data.zip", size: 10, host: "asked.example", unscanned: true };
    const download = AgentGate.request(CONN, "vimma_download", file, { always: true });
    delete file.unscanned;
    const dq = /** @type {NonNullable<ReturnType<typeof questionOf>>} */ (questionOf(CONN));
    Assert.equal(
      AgentGate.answer(dq.id, { kind: "grant", minutes: 5 }),
      null,
      "a grant answer to the unscanned file the user saw makes no grant",
    );
    Assert.equal(labelOf(CONN), null, "the connection has no grant");
    AgentGate.answer(dq.id, { kind: "deny" });
    Assert.ok(!(await download).allow, "denied");

    // A payment is one yes or no: a grant answer allows it once and makes no grant.
    const submit = { method: "post", action: `${ASKED}pay`, host: "asked.example" };
    /** @type {Record<string, unknown>} */
    const once = { url: ASKED, pay: { amount: "10 EUR" } };
    const paid = AgentGate.request(CONN, "vimma_activate", once, { always: true });
    delete once.pay;
    const oq = /** @type {NonNullable<ReturnType<typeof questionOf>>} */ (questionOf(CONN));
    Assert.equal(
      AgentGate.answer(oq.id, { kind: "grant", minutes: 5 }),
      null,
      "a grant answer to the payment the user saw makes no grant",
    );
    Assert.equal(labelOf(CONN), null, "the connection still has no grant");
    Assert.ok((await paid).allow, "that one payment is allowed");

    const read = AgentGate.request(CONN, "vimma_read_page", { url: ASKED });
    const rq = questionOf(CONN);
    if (rq) AgentGate.answer(rq.id, { kind: "grant", minutes: 5 });
    Assert.ok((await read).allow, "granted");
    const key = "asked.example|form|pay";
    /** @type {Record<string, unknown>} */
    const payment = {
      url: ASKED,
      pay: { amount: "10 EUR" },
      submit,
      here: { site: "asked.example", key },
    };
    const paying = AgentGate.request(CONN, "vimma_activate", payment, { always: true });
    delete payment.pay;
    const pq = /** @type {NonNullable<ReturnType<typeof questionOf>>} */ (questionOf(CONN));
    Assert.equal(AgentGate.answer(pq.id, { kind: "here" }), null, "a is no answer to a payment");
    Assert.ok(questionOf(CONN), "the payment still waits");
    AgentGate.answer(pq.id, { kind: "deny" });
    Assert.ok(!(await paying).allow, "denied");
    const again = AgentGate.request(CONN, "vimma_activate", payment, {
      always: true,
      covered: key,
    });
    const aq = questionOf(CONN);
    Assert.ok(aq, "and no allowance was made for it");
    if (aq) AgentGate.answer(aq.id, { kind: "deny" });
    await again;
  } finally {
    for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
    AgentGate.revoke();
    AgentGate.disconnect(CONN);
  }
});

// A new name (a conversation titled by its first message) is stored as a frozen copy too.
add_task(async function test_relabel_keeps_a_frozen_copy() {
  AgentGate.connect(CONN, { client: "agent-a" });
  try {
    AgentGate.relabel(CONN, "agent-c");
    const label = AgentGate.connections.find((l) => l.client === "agent-c");
    Assert.ok(label && Object.isFrozen(label), "the new label is frozen");
    tryWrite(label, "client", "built-in agent");
    Assert.ok(
      AgentGate.connections.some((l) => l.client === "agent-c"),
      "a reader cannot rename it",
    );
  } finally {
    AgentGate.disconnect(CONN);
  }
});

// A request too deep to copy is refused before it is queued: the caller's await throws, so it
// fails closed, and nothing waits.
add_task(async function test_a_request_too_deep_to_copy_is_never_queued() {
  AgentGate.connect(CONN, { client: "agent-a" });
  try {
    /** @type {any} */
    let what = { url: ASKED };
    for (let i = 0; i < 40; i++) what = { what };
    Assert.throws(
      () => AgentGate.request(CONN, "vimma_read_page", what),
      /deeper than 32 levels/,
      "the request throws",
    );
    Assert.equal(questionOf(CONN), undefined, "and nothing waits");
    Assert.equal(AgentGate.waiting.length, 0, "no question at all");
  } finally {
    AgentGate.disconnect(CONN);
  }
});

/**
 * A request nested exactly `levels` objects deep, the URL at the bottom.
 * @param {number} levels
 */
const nested = (levels) => {
  /** @type {any} */
  let what = { url: ASKED, title: "Deep" };
  for (let i = 1; i < levels; i++) what = { what };
  return what;
};

// Issue #1027: a request at the copy limit (32 levels) is asked, shown, answered and logged, and
// every listener hears its events: the gate's events hold the gate's own copy as it is, so the
// event copy never counts the request's levels again.
add_task(async function test_a_request_at_the_copy_limit_asks_and_is_heard() {
  AgentGate.connect(CONN, { client: "agent-a" });
  /** @type {any[]} */
  const first = [];
  /** @type {any[]} */
  const second = [];
  const one = (/** @type {any} */ e) => e?.question?.conn === CONN && first.push(e);
  const two = (/** @type {any} */ e) => e?.question?.conn === CONN && second.push(e);
  AgentGate.addListener(one);
  AgentGate.addListener(two);
  try {
    const outcome = AgentGate.request(CONN, "vimma_read_page", nested(32));
    const q = questionOf(CONN);
    Assert.ok(q, "the request at the limit asks");
    Assert.deepEqual(
      first.map((e) => e.kind),
      ["asked"],
      "the first listener hears it asked",
    );
    Assert.deepEqual(
      second.map((e) => e.kind),
      ["asked"],
      "and so does the next",
    );
    Assert.equal(first[0].question.what, q?.what, "the event holds the gate's own copy");
    AgentUi.answer(window);
    await until(() => lineText().includes("agent-a"), "the question line shows it");
    AgentGate.answer(/** @type {NonNullable<typeof q>} */ (q).id, { kind: "once" });
    Assert.ok((await outcome).allow, "the yes allows it");
    Assert.deepEqual(
      second.map((e) => e.kind),
      ["asked", "answered"],
      "every listener hears the answer",
    );
    Assert.equal(AgentGate.waiting.length, 0, "nothing still waits");
    Assert.equal(AgentGate.log[0]?.outcome, "yes", "the call is logged as allowed");
    Assert.equal(AgentGate.log[0]?.client, "agent-a", "under its agent");
  } finally {
    AgentGate.removeListener(one);
    AgentGate.removeListener(two);
    for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
    AgentGate.disconnect(CONN);
  }
});

// The same request under a grant runs with no throw, is logged as run under the grant, and every
// listener hears it ran; one level deeper is still refused before anything is logged.
add_task(async function test_a_request_at_the_copy_limit_runs_under_a_grant() {
  AgentGate.connect(OTHER, { client: "agent-b" });
  /** @type {any[]} */
  const seen = [];
  const listener = (/** @type {any} */ e) => e?.kind === "ran" && e.conn === OTHER && seen.push(e);
  try {
    const read = AgentGate.request(OTHER, "vimma_read_page", { url: ASKED });
    AgentGate.answer(/** @type {any} */ (questionOf(OTHER)).id, { kind: "grant", minutes: 5 });
    Assert.ok((await read).allow, "granted");
    AgentGate.addListener(listener);
    /** @type {Promise<any> | null} */
    let ran = null;
    try {
      ran = AgentGate.request(OTHER, "vimma_read_page", nested(32));
    } catch (e) {
      Assert.ok(false, `the request at the limit does not throw: ${e}`);
    }
    Assert.ok(ran && (await ran).allow, "it runs under the grant");
    Assert.equal(seen.length, 1, "the listener hears it ran");
    Assert.equal(seen[0]?.label.client, "agent-b", "under its agent's name");
    Assert.equal(AgentGate.log[0]?.outcome, "grant", "the log has it run under the grant");

    const top = AgentGate.log[0];
    Assert.throws(
      () => AgentGate.request(OTHER, "vimma_read_page", nested(33)),
      /deeper than 32 levels/,
      "one level deeper throws",
    );
    Assert.equal(AgentGate.log[0], top, "before anything is logged");
    Assert.equal(seen.length, 1, "or heard");
  } finally {
    AgentGate.removeListener(listener);
    AgentGate.revoke();
    AgentGate.disconnect(OTHER);
  }
});

// Issue #1027, the waiting path: a caller's `onCancel` that throws once the question is queued
// leaves no question pending with its timer behind a rejected promise. The question is withdrawn
// and the caller is denied, so it fails closed.
add_task(async function test_a_throwing_on_cancel_leaves_nothing_waiting() {
  AgentGate.connect(CONN, { client: "agent-a" });
  try {
    const outcome = AgentGate.request(
      CONN,
      "vimma_read_page",
      { url: ASKED },
      {
        onCancel: () => {
          throw new Error("the caller's own bug");
        },
      },
    );
    Assert.equal(questionOf(CONN), undefined, "no question waits");
    const settled = await outcome.then(
      (o) => o,
      (e) => ({ rejected: String(e) }),
    );
    Assert.deepEqual(settled, { allow: false, reason: "cancelled" }, "the caller is denied");
    Assert.equal(AgentGate.log[0]?.outcome, "cancelled", "and the log says so");
  } finally {
    for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
    AgentGate.disconnect(CONN);
  }
});

// A label that cannot be copied throws before the queue knows its connection, so it never takes
// the grant a dropped session left behind (mcp-session-grants S3); the next connection of that
// session still gets it.
add_task(async function test_a_label_that_cannot_be_copied_takes_no_session_grant() {
  const THIRD = 1018003;
  const SESSION = "gate-copies-1027";
  // A session's grant is parked only while MCP is on (mcp-session-grants S5).
  AgentGate.on();
  AgentGate.connect(CONN, { client: "agent-a" }, SESSION);
  try {
    const read = AgentGate.request(CONN, "vimma_read_page", { url: ASKED });
    AgentGate.answer(/** @type {any} */ (questionOf(CONN)).id, { kind: "grant", minutes: 5 });
    Assert.ok((await read).allow, "granted");
    AgentGate.disconnect(CONN);
    Assert.equal(AgentGate.grants().length, 0, "the grant is parked, not in force");

    Assert.throws(
      () => AgentGate.connect(OTHER, { client: nested(32) }, SESSION),
      /deeper than 32 levels/,
      "a label too deep to copy throws",
    );
    Assert.equal(AgentGate.grants().length, 0, "and took no grant");

    AgentGate.connect(THIRD, { client: "agent-c" }, SESSION);
    Assert.equal(labelOf(THIRD)?.client, "agent-c", "the session's next connection keeps it");
  } finally {
    AgentGate.revoke();
    AgentGate.disconnect(CONN);
    AgentGate.disconnect(OTHER);
    AgentGate.disconnect(THIRD);
    // Back to MCP off, as the file found it: no session parks a grant.
    AgentGate.off();
  }
});

// The same for a full-control question (decision 29 C): an `onCancel` that throws leaves no
// question waiting, and the caller is denied.
add_task(async function test_a_throwing_on_cancel_leaves_no_full_control_question() {
  /** @type {Promise<any> | null} */
  let outcome = null;
  try {
    outcome = AgentGate.askFull(null, () => {
      throw new Error("the caller's own bug");
    });
  } catch (e) {
    Assert.ok(false, `askFull does not throw: ${e}`);
  }
  Assert.equal(AgentGate.waiting.length, 0, "no question waits");
  Assert.deepEqual(await outcome, { allow: false, reason: "cancelled" }, "the caller is denied");
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
});

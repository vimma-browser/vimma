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

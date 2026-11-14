/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md (Behaviour 7) and docs/specs/builtin-agent-cli.md
// (Behaviour 1); issue #1001. The model picker and setup's agent CLI list are one view of the
// chat window, filled by answers that arrive later: the local servers' probe, the search of PATH
// for agent CLIs, the providers' key hints and a key's deletion. An answer is drawn only into the
// list that asked for it: one that arrives after the user moved to another list (the CLI list,
// the model list again, a new picker) changes nothing they see, and Enter acts on the row shown.
// The window is built with services of the test's own, whose answers the test gives when it
// chooses, and is driven through its own entry points: open() and its keys.

"use strict";

/* global add_setup -- the harness */

const { AgentChatWindow } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/agent-chat.mjs",
);

/**
 * A promise and its resolve, for an answer the test gives when it chooses.
 * @template T
 * @typedef {{ promise: Promise<T>, resolve: (value: T) => void }} Deferred
 */

/**
 * @template T
 * @returns {Deferred<T>}
 */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  const promise = new Promise((/** @type {(value: T) => void} */ r) => (resolve = r));
  return { promise, resolve };
}

/** @typedef {{ server: string, endpoint: string, models: string[] }} LocalServer */
/**
 * @typedef {{ cli: string, path: string, label: string, shim: string | null,
 *   problem: string | null }} FoundCli
 */

/** A model server on this machine, so it needs no key (and the window asks for none). */
const LOCAL = {
  name: "local",
  kind: "openai",
  endpoint: "http://127.0.0.1:8080/v1",
  model: "small",
  vision: false,
};
/** A hosted provider, whose key hint the picker asks for. */
const HOSTED = {
  name: "hosted",
  kind: "openai",
  endpoint: "https://example.com/v1",
  model: "big",
  vision: false,
};
/** @type {LocalServer[]} */
const OLLAMA = [{ server: "ollama", endpoint: "http://127.0.0.1:11434/v1", models: ["llama"] }];
/** @type {LocalServer[]} */
const LMSTUDIO = [{ server: "lmstudio", endpoint: "http://127.0.0.1:1234/v1", models: ["qwen"] }];
/** @type {FoundCli[]} */
const FOUND = [
  {
    cli: "claude-code",
    path: "/opt/fake/bin/claude",
    label: "claude 9.9.9 · /opt/fake/bin/claude",
    shim: null,
    problem: null,
  },
  {
    cli: "codex",
    path: "/opt/fake/bin/codex",
    label: "codex 9.9.9 · /opt/fake/bin/codex",
    shim: null,
    problem: null,
  },
];

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/**
 * A chat window built with fake services: each probe, model state, CLI search, key hint and key
 * deletion is a promise the test resolves; the host's prompts and notices are recorded.
 * @param {{ providers: object[] }} opts  the [agent] providers the services report
 */
function fakeWindow({ providers }) {
  const conversation = {
    id: 1,
    conn: "fake",
    title: "",
    provider: providers[0],
    cli: null,
    running: false,
    granted: false,
    asking: false,
    budget: null,
    used: 0,
  };
  /** @type {Deferred<LocalServer[]>[]} */
  const probes = [];
  /** @type {Deferred<Map<string, string>>[]} */
  const states = [];
  /** @type {Deferred<FoundCli[]>[]} */
  const finds = [];
  /** @type {Deferred<string | null>[]} */
  const hints = [];
  /** @type {Deferred<boolean>[]} */
  const deletes = [];
  /** @type {object[]} */
  const chosen = [];
  const services = {
    chat: {
      restored: true,
      chosen: null,
      restore: async () => {},
      list: () => [conversation],
      get: () => conversation,
      create: () => conversation,
      addListener() {},
      removeListener() {},
      transcript: () => ({ version: 0, entries: [] }),
      setProvider: () => null,
      choose: (/** @type {object} */ p) => chosen.push(p),
      probe: () => {
        const d = /** @type {Deferred<LocalServer[]>} */ (deferred());
        probes.push(d);
        return d.promise;
      },
      modelStates: () => {
        const d = /** @type {Deferred<Map<string, string>>} */ (deferred());
        states.push(d);
        return d.promise;
      },
    },
    cli: {
      enabled: true,
      find: () => {
        const d = /** @type {Deferred<FoundCli[]>} */ (deferred());
        finds.push(d);
        return d.promise;
      },
      noneFound: () => "none found by the test",
      use() {},
    },
    keys: {
      hint: () => {
        const d = /** @type {Deferred<string | null>} */ (deferred());
        hints.push(d);
        return d.promise;
      },
      delete: () => {
        const d = /** @type {Deferred<boolean>} */ (deferred());
        deletes.push(d);
        return d.promise;
      },
    },
    configRefused: () => ({ errors: [], file: "fake.toml" }),
    addAgentProvider: async () => ({ error: "the test keeps config.toml" }),
    agentConfig: () => ({ default: null, localOnly: false, providers }),
  };
  /** @type {{ label: string, placeholder?: string }[]} */
  const prompts = [];
  /** @type {string[]} */
  const said = [];
  const host = {
    ask: (/** @type {string} */ _question, /** @type {() => void} */ yes) => yes(),
    say: (/** @type {string} */ text) => said.push(text),
    give() {},
    copy() {},
    rearm() {},
    prompt: (/** @type {{ label: string, placeholder?: string }} */ o) => prompts.push(o),
    changed() {},
  };
  const chat = new AgentChatWindow(window, host, /** @type {any} */ (services));
  return { chat, probes, states, finds, hints, deletes, prompts, said, chosen };
}

/**
 * A key typed while focus is in the window, as VimmaHost's capture listener hands it over.
 * @param {InstanceType<typeof AgentChatWindow>} chat @param {string} key  a KeyboardEvent key
 */
function press(chat, key) {
  Assert.ok(chat.onKey(new KeyboardEvent("keydown", { key })), `the window takes ${key}`);
}

/**
 * Moves the picker's selection with j and k to the first row `match` accepts.
 * @param {InstanceType<typeof AgentChatWindow>} chat
 * @param {(row: { label: string, add?: string }) => boolean} match
 */
function selectRow(chat, match) {
  const at = chat.rows.findIndex(match);
  Assert.greaterOrEqual(at, 0, "the row is listed");
  while (chat.row > at) press(chat, "k");
  while (chat.row < at) press(chat, "j");
}

/** @param {{ label: string, add?: string }} r */
const isAddCli = (r) => r.add === "cli";

/**
 * The labels the window draws, from its rows in the document.
 * @param {InstanceType<typeof AgentChatWindow>} chat
 */
const drawn = (chat) =>
  [...(chat.log?.querySelectorAll(".vimma-agent-chat-row-label") ?? [])].map((n) => n.textContent);

/**
 * Resolves after every continuation the window chained on `promises` has run: the window chained
 * its own first, and a promise's reactions run in the order they were added.
 * @param {Promise<unknown>[]} promises
 */
async function afterWindow(promises) {
  await Promise.all(promises);
  await Promise.resolve();
}

/**
 * Esc back to the transcript, Esc to normal mode, then m: the model picker again.
 * @param {InstanceType<typeof AgentChatWindow>} chat
 */
function reopenPicker(chat) {
  press(chat, "Escape");
  Assert.equal(chat.view, "chat", "Esc leaves the list");
  press(chat, "Escape");
  press(chat, "m");
  Assert.equal(chat.view, "models", "m opens the model picker");
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.agent.cli.enabled", true]] });
});

add_task(async function test_a_late_probe_leaves_setups_agent_cli_list_alone() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open({ view: "models" });
    Assert.equal(f.probes.length, 1, "the picker asked the local servers");
    selectRow(f.chat, isAddCli);
    press(f.chat, "Enter");
    Assert.equal(f.finds.length, 1, "add: agent CLI looked for them");
    f.finds[0].resolve(FOUND);
    info("the CLI list shows");
    await until(() => drawn(f.chat)[0] === FOUND[0].label, "the CLIs found are listed");
    Assert.equal(f.said.at(-1), `agent: found ${FOUND[0].label}`, "and the first one named");

    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    info("the probe answers while the CLI list shows");
    await afterWindow([f.probes[0].promise, f.states[0].promise]);
    Assert.deepEqual(
      drawn(f.chat),
      FOUND.map((c) => c.label),
      "the CLI list stays as it is",
    );
    Assert.equal(f.chat.row, 0, "with its selection");
    press(f.chat, "Enter");
    Assert.deepEqual(
      f.prompts.map((p) => p.placeholder),
      ["empty: Claude Code's own default model"],
      "Enter uses the CLI selected: its model is asked for (builtin-agent-cli Behaviour 2)",
    );
    Assert.deepEqual(f.chosen, [], "and no model row was used");

    // The answer dropped is not lost: the picker asks the servers again when it opens.
    reopenPicker(f.chat);
    Assert.equal(f.probes.length, 2, "the model picker probes again");
    f.probes[1].resolve(OLLAMA);
    f.states[1].resolve(new Map());
    info("the second probe answers while the model list shows");
    await until(() => drawn(f.chat).includes("ollama · llama"), "its servers are listed");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_late_agent_cli_search_leaves_the_model_list_alone() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open({ view: "models" });
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    info("the model list shows the local servers");
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, isAddCli);
    press(f.chat, "Enter");
    Assert.equal(f.finds.length, 1, "add: agent CLI looked for them");

    reopenPicker(f.chat);
    f.probes[1].resolve(LMSTUDIO);
    f.states[1].resolve(new Map());
    info("the model list shows the second probe's servers");
    await until(() => drawn(f.chat).includes("lmstudio · qwen"), "the new probe is drawn");
    const shown = drawn(f.chat);

    f.finds[0].resolve(FOUND);
    info("the search answers while the model list shows");
    await afterWindow([f.finds[0].promise]);
    Assert.deepEqual(drawn(f.chat), shown, "the model list stays as it is");
    Assert.ok(!f.said.some((s) => s.startsWith("agent: found")), "and no CLI is named");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_an_earlier_pickers_probe_leaves_the_new_one_alone() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open({ view: "models" });
    reopenPicker(f.chat);
    Assert.equal(f.probes.length, 2, "each picker asked the servers");
    f.probes[1].resolve(LMSTUDIO);
    f.states[1].resolve(new Map());
    info("the second picker's probe answers first");
    await until(() => drawn(f.chat).includes("lmstudio · qwen"), "and is drawn");
    const shown = drawn(f.chat);

    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    info("the first picker's probe answers last");
    await afterWindow([f.probes[0].promise, f.states[0].promise]);
    Assert.deepEqual(drawn(f.chat), shown, "the picker shows the newer answer");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_late_key_hint_or_key_deletion_leaves_the_list_shown_alone() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  /** @param {InstanceType<typeof AgentChatWindow>} chat */
  const hostedRow = (chat) =>
    chat.rows.find((/** @type {{ provider?: object }} */ r) => r.provider === HOSTED);
  try {
    f.chat.open({ view: "models" });
    Assert.equal(f.hints.length, 1, "the picker asked for the hosted provider's key hint");
    reopenPicker(f.chat);
    Assert.equal(f.hints.length, 2, "and again when it opened again");
    f.hints[1].resolve(null);
    info("the second picker's hint answers first");
    await until(() => hostedRow(f.chat)?.detail === "no key · Enter adds one", "and is drawn");

    f.hints[0].resolve("key stored · ends …old0");
    info("the first picker's hint answers last");
    await afterWindow([f.hints[0].promise]);
    Assert.equal(
      hostedRow(f.chat)?.detail,
      "no key · Enter adds one",
      "the row keeps the newer hint",
    );

    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "x");
    Assert.equal(f.deletes.length, 1, "x deletes the key after the y");
    selectRow(f.chat, isAddCli);
    press(f.chat, "Enter");
    f.finds[0].resolve(FOUND);
    info("the CLI list shows before the deletion answers");
    await until(() => drawn(f.chat)[0] === FOUND[0].label, "the CLIs found are listed");

    f.deletes[0].resolve(true);
    info("the deletion answers while the CLI list shows");
    await afterWindow([f.deletes[0].promise]);
    Assert.equal(f.said.at(-1), "agent: deleted the key of hosted", "it is said");
    Assert.deepEqual(
      drawn(f.chat),
      FOUND.map((c) => c.label),
      "but the CLI list stays as it is",
    );
  } finally {
    f.chat.destroy();
  }
});

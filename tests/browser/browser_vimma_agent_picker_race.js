/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md (Behaviour 7) and docs/specs/builtin-agent-cli.md
// (Behaviour 1); issue #1001. The model picker and setup's agent CLI list are one view of the
// chat window, filled by answers that arrive later: the local servers' probe, the search of PATH
// for agent CLIs, the providers' key hints and a key's deletion. An answer is drawn only into the
// list that asked for it: one that arrives after the user moved to another list (the CLI list,
// the model list again, a new picker) changes nothing they see, and Enter acts on the row shown.
// Issue #1005: a pick, a send or a key's store that waits (for a key hint, a local model's
// preparation, login storage) and finds the user gone elsewhere switches no view and leaves the
// key field as the user has it; every way out of the key field empties it (docs/security.md M46).
// The window is built with services of the test's own, whose answers the test gives when it
// chooses, and is driven through its own entry points: open() and its keys.

"use strict";

/* global add_setup -- the harness */

const { AgentChatWindow } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/agent-chat.mjs",
);
const { RenamePrompt } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/rename-prompt.mjs",
);

/**
 * A promise with its resolve and reject, for an answer the test gives when it chooses.
 * @template T
 * @typedef {{ promise: Promise<T>, resolve: (value: T) => void,
 *   reject: (error: Error) => void }} Deferred
 */

/**
 * @template T
 * @returns {Deferred<T>}
 */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(error: Error) => void} */
  let reject = () => {};
  const promise = new Promise(
    (/** @type {(value: T) => void} */ r, /** @type {(error: Error) => void} */ j) => {
      resolve = r;
      reject = j;
    },
  );
  return { promise, resolve, reject };
}

/** @typedef {{ server: string, endpoint: string, models: string[] }} LocalServer */
/** @typedef {{ label: string, placeholder?: string, submit: (text: string) => void }} Prompt */
/**
 * @typedef {{ cli: string, path: string, label: string, shim: string | null,
 *   problem: string | null }} FoundCli
 */

/**
 * A model server on this machine, so it needs no key (and the window asks for none).
 * @type {AgentProviderConfig}
 */
const LOCAL = {
  name: "local",
  kind: "openai",
  endpoint: "http://127.0.0.1:8080/v1",
  model: "small",
  vision: false,
};
/**
 * A hosted provider, whose key hint the picker asks for.
 * @type {AgentProviderConfig}
 */
const HOSTED = {
  name: "hosted",
  kind: "openai",
  endpoint: "https://example.com/v1",
  model: "big",
  vision: false,
};
/**
 * Setup's Anthropic provider, whose key the field asks for.
 * @type {AgentProviderConfig}
 */
const ANTHROPIC = {
  name: "anthropic",
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-test",
  vision: true,
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
 * A chat window built with fake services: each probe, model state, CLI search, key hint, key
 * store, key deletion and local model preparation is a promise the test resolves; the host's
 * prompts, questions and notices, the models used and the messages sent are recorded. Every
 * question is answered y.
 * @param {{ providers: object[], notice?: boolean, sendWaits?: boolean,
 *   prompt?: (o: Prompt) => void, localOnly?: boolean }} opts  the [agent] providers the services report; `notice`:
 *   the conversation's first send needs Behaviour 5's notice; `sendWaits`: each send's answer is
 *   a promise the test resolves (in `sendAnswers`); `prompt`: also hands each prompt to this;
 *   `localOnly`: config.toml's [agent] local_only
 */
function fakeWindow({ providers, notice = false, sendWaits = false, prompt, localOnly = false }) {
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
  /** @type {Deferred<void>[]} */
  const sets = [];
  /** @type {Deferred<{ model: string }>[]} */
  const prepares = [];
  /** @type {string[]} the models placeLocal was asked to load */
  const places = [];
  /** @type {string[]} */
  const sends = [];
  /** @type {Deferred<object>[]} */
  const sendAnswers = [];
  /** @type {object[]} */
  const chosen = [];
  let confirmed = false;
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
      setProvider: (/** @type {number} */ _id, /** @type {any} */ p) => {
        conversation.provider = p;
        return null;
      },
      choose: (/** @type {object} */ p) => chosen.push(p),
      needsNotice: () => notice && !confirmed,
      confirm: () => (confirmed = true),
      send: (/** @type {number} */ _id, /** @type {string} */ text) => {
        sends.push(text);
        if (!sendWaits) return Promise.resolve({ started: true });
        const d = /** @type {Deferred<object>} */ (deferred());
        sendAnswers.push(d);
        return d.promise;
      },
      prepareLocal: () => {
        const d = /** @type {Deferred<{ model: string }>} */ (deferred());
        prepares.push(d);
        return d.promise;
      },
      placeLocal: (/** @type {string} */ _endpoint, /** @type {string} */ model) => {
        places.push(model);
        return Promise.resolve(null);
      },
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
      set: () => {
        const d = /** @type {Deferred<void>} */ (deferred());
        sets.push(d);
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
    agentConfig: () => ({ default: null, localOnly, providers }),
  };
  /** @type {Prompt[]} */
  const prompts = [];
  /** @type {string[]} */
  const said = [];
  /** @type {string[]} */
  const asked = [];
  const host = {
    ask: (/** @type {string} */ question, /** @type {() => void} */ yes) => {
      asked.push(question);
      yes();
    },
    say: (/** @type {string} */ text) => said.push(text),
    give() {},
    copy() {},
    rearm() {},
    prompt: (/** @type {Prompt} */ o) => {
      prompts.push(o);
      prompt?.(o);
    },
    changed() {},
  };
  const chat = new AgentChatWindow(window, host, /** @type {any} */ (services));
  return {
    chat,
    conversation,
    probes,
    states,
    finds,
    hints,
    deletes,
    sets,
    prepares,
    places,
    sends,
    sendAnswers,
    prompts,
    said,
    asked,
    chosen,
  };
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

/** @param {InstanceType<typeof AgentChatWindow>} chat */
const keyField = (chat) => /** @type {HTMLInputElement} */ (chat.keyInput);

/**
 * Types into the key field as a user does: the keys go to the focused field, not the window.
 * @param {InstanceType<typeof AgentChatWindow>} chat @param {string} text
 */
function typeKey(chat, text) {
  Assert.equal(chat.view, "key", "the key field shows");
  Assert.equal(document.activeElement, chat.keyInput, "and has focus");
  EventUtils.sendString(text);
  Assert.equal(keyField(chat).value, text, "it holds what was typed");
}

/**
 * Resolves once the window's continuation on a promise the test rejects has run.
 * @param {Promise<unknown>} promise
 */
async function afterRefusal(promise) {
  await promise.catch(() => {});
  await Promise.resolve();
}

/** The notice for a pick the user left before it was ready (issue #1005). */
const NOT_USED = (/** @type {string} */ label) =>
  `agent: ${label} not used: the picker was left before it was ready`;
const NOT_SENT =
  "agent: not sent: the chat was left before its key was read; the message is still in the input";

add_task(async function test_every_way_out_of_the_key_field_empties_it() {
  const f = fakeWindow({ providers: [LOCAL] });
  /**
   * @type {[string, (chat: InstanceType<typeof AgentChatWindow>) => void,
   *   AgentProviderConfig | null][]}
   */
  const ways = [
    ["Esc", (chat) => press(chat, "Escape"), null],
    ["closing the window", (chat) => chat.close(), null],
    [":agent model", (chat) => chat.open({ view: "models" }), null],
    [":agent list", (chat) => chat.open({ view: "list" }), null],
    [":agent new", (chat) => chat.newConversation(), null],
    ["opening a conversation", (chat) => chat.open({ conversation: 1 }), null],
    ["another provider's key field", (chat) => chat.askKey(HOSTED), HOSTED],
    ["the transcript, as a late pick or store goes to it", (chat) => chat.insert(), null],
  ];
  try {
    for (const [how, leave, keyFor] of ways) {
      info(`leaving the key field: ${how}`);
      f.chat.askKey(ANTHROPIC);
      typeKey(f.chat, "sk-ant-half");
      leave(f.chat);
      Assert.equal(keyField(f.chat).value, "", `${how} empties the key field`);
      Assert.equal(f.chat.keyFor, keyFor, `${how}: the field is for no key typed before`);
      f.chat.askKey(ANTHROPIC);
      Assert.equal(keyField(f.chat).value, "", `after ${how} the field opens empty`);
      const editor = /** @type {any} */ (keyField(f.chat)).editor;
      Assert.ok(editor, `after ${how} the field has its editor`);
      Assert.ok(!editor.canUndo, `after ${how} nothing typed before comes back with an undo`);
      press(f.chat, "Escape");
    }
    info("leaving the key field: the window goes with the browser window");
    f.chat.askKey(ANTHROPIC);
    typeKey(f.chat, "sk-ant-half");
    f.chat.destroy();
    Assert.equal(keyField(f.chat).value, "", "destroying the window empties the key field");
    Assert.equal(f.chat.keyFor, null, "and it is for no provider");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_pick_left_while_its_model_is_prepared_leaves_the_key_field_alone() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open({ view: "models" });
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === "ollama · llama");
    press(f.chat, "Enter");
    Assert.equal(f.said.at(-1), "agent: preparing llama…", "the local model is prepared");

    info("while it is prepared, the user sets up Anthropic and starts typing its key");
    reopenPicker(f.chat);
    selectRow(f.chat, (r) => r.add === "anthropic");
    press(f.chat, "Enter");
    const model = f.prompts.at(-1);
    Assert.equal(model?.label, "agent model: ", "add: Anthropic asks for its model");
    model?.submit("claude-test");
    typeKey(f.chat, "sk-ant-half");

    f.prepares[0].resolve({ model: "llama" });
    info("the preparation ends while the key field shows");
    await afterWindow([f.prepares[0].promise]);
    Assert.equal(f.chat.view, "key", "the key field stays");
    Assert.equal(keyField(f.chat).value, "sk-ant-half", "with what was typed");
    Assert.equal(f.chat.keyFor?.name, "anthropic", "for the provider it was opened for");
    Assert.deepEqual(f.chosen, [], "the model picked before is not used");
    Assert.deepEqual(f.places, [], "nor loaded");
    Assert.equal(f.said.at(-1), NOT_USED("ollama · llama"), "and the user is told");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_pick_whose_window_closed_while_it_was_prepared_is_not_used() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open({ view: "models" });
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === "ollama · llama");
    press(f.chat, "Enter");
    f.chat.close();

    f.prepares[0].resolve({ model: "llama" });
    info("the preparation ends after the window closed");
    await afterWindow([f.prepares[0].promise]);
    Assert.ok(!f.chat.isOpen, "the window stays closed");
    Assert.deepEqual(f.chosen, [], "the model is not used");
    Assert.equal(f.conversation.provider, LOCAL, "the conversation keeps its model");
    Assert.deepEqual(f.places, [], "nor is the model loaded");
    Assert.equal(f.said.at(-1), NOT_USED("ollama · llama"), "and the user is told");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_the_later_of_two_picks_wins_whichever_is_ready_first() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  try {
    f.chat.open({ view: "models" });
    f.hints[0].resolve("key stored · ends …abcd");
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === "ollama · llama");
    press(f.chat, "Enter");
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "Enter");
    Assert.equal(f.hints.length, 2, "the second pick reads its provider's key hint");

    f.prepares[0].resolve({ model: "llama" });
    info("the first pick is ready first");
    await afterWindow([f.prepares[0].promise]);
    Assert.deepEqual(f.chosen, [], "it is not used: a later pick was made");
    Assert.equal(f.chat.view, "models", "and the picker stays");
    Assert.deepEqual(f.places, [], "nor is its model loaded");

    f.hints[1].resolve("key stored · ends …abcd");
    info("the second pick is ready");
    await afterWindow([f.hints[1].promise]);
    Assert.deepEqual(f.chosen, [HOSTED], "the later pick is used");
    Assert.equal(f.conversation.provider, HOSTED, "by the conversation");
    Assert.equal(f.chat.view, "chat", "and the transcript shows");
    Assert.ok(!f.said.some((s) => s.includes("not used")), "the pick replaced says nothing");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_pick_left_before_its_key_hint_opens_no_key_field() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  try {
    f.chat.open({ view: "models" });
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "Enter");
    Assert.equal(f.hints.length, 2, "the pick reads its provider's key hint");
    press(f.chat, "Escape");
    Assert.equal(f.chat.view, "chat", "the user goes back to the transcript");

    f.hints[1].resolve(null);
    info("the hint says there is no key, after the user left");
    await afterWindow([f.hints[1].promise]);
    Assert.equal(f.chat.view, "chat", "the key field does not open over the transcript");
    Assert.equal(f.chat.keyFor, null, "and asks for no key");
    Assert.deepEqual(f.chosen, [], "the model is not used");
    Assert.equal(f.said.at(-1), NOT_USED("hosted · big"), "and the user is told");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_send_waiting_for_its_key_hint_is_sent_only_if_the_user_stayed() {
  /**
   * A window on a hosted provider whose message waits for its key hint after Enter.
   * @returns {ReturnType<typeof fakeWindow>}
   */
  const waiting = () => {
    const f = fakeWindow({ providers: [HOSTED], notice: true });
    f.chat.open();
    /** @type {HTMLTextAreaElement} */ (f.chat.input).value = "hello";
    press(f.chat, "Enter");
    Assert.equal(f.hints.length, 1, "the send reads the provider's key hint first");
    return f;
  };
  /** @param {ReturnType<typeof fakeWindow>} f */
  const input = (f) => /** @type {HTMLTextAreaElement} */ (f.chat.input).value;

  info("the user stays: the notice, then the send, as before");
  let f = waiting();
  try {
    f.hints[0].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[0].promise]);
    Assert.equal(f.asked.length, 1, "Behaviour 5's notice is asked");
    Assert.deepEqual(f.sends, ["hello"], "after its y the message is sent");
    Assert.equal(input(f), "", "and leaves the input");
  } finally {
    f.chat.destroy();
  }

  info("the user goes to normal mode and opens the picker before the hint answers");
  f = waiting();
  try {
    press(f.chat, "Escape");
    press(f.chat, "m");
    f.hints[0].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[0].promise]);
    Assert.deepEqual(f.asked, [], "no notice is asked over the picker");
    Assert.deepEqual(f.sends, [], "nothing is sent");
    Assert.equal(input(f), "hello", "the message stays in the input");
    Assert.equal(f.chat.view, "models", "the picker stays");
    Assert.ok(f.said.includes(NOT_SENT), "and the user is told");
  } finally {
    f.chat.destroy();
  }

  info("the hint says there is no key, after the user left");
  f = waiting();
  try {
    press(f.chat, "Escape");
    press(f.chat, "m");
    f.hints[0].resolve(null);
    await afterWindow([f.hints[0].promise]);
    Assert.equal(f.chat.view, "models", "the key field does not open over the picker");
    Assert.equal(f.chat.keyFor, null, "and asks for no key");
    Assert.deepEqual(f.sends, [], "nothing is sent");
    Assert.equal(input(f), "hello", "the message stays in the input");
    Assert.ok(f.said.includes(NOT_SENT), "and the user is told");
  } finally {
    f.chat.destroy();
  }

  info("the window closes before the hint answers");
  f = waiting();
  try {
    f.chat.close();
    f.hints[0].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[0].promise]);
    Assert.deepEqual(f.asked, [], "no notice is asked");
    Assert.deepEqual(f.sends, [], "nothing is sent");
    Assert.equal(input(f), "hello", "the message stays in the input");
    Assert.ok(!f.chat.isOpen, "and the window stays closed");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_key_stored_after_the_field_was_left_switches_nothing() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open();
    f.chat.askKey(ANTHROPIC);
    typeKey(f.chat, "sk-ant-one");
    press(f.chat, "Enter");
    Assert.equal(keyField(f.chat).value, "", "Enter takes the key out of the field at once");
    Assert.equal(f.sets.length, 1, "and hands it to login storage");
    press(f.chat, "Escape");
    Assert.equal(f.chat.view, "chat", "Esc leaves the field while it is stored");
    f.chat.askKey(HOSTED);
    typeKey(f.chat, "sk-other-half");

    f.sets[0].resolve();
    info("the key is stored while the user types another provider's key");
    await afterWindow([f.sets[0].promise]);
    Assert.equal(f.hints.length, 1, "the stored key's end is read");
    f.hints[0].resolve("key stored · ends …-one");
    await until(() => f.said.some((s) => s.startsWith("agent: anthropic:")), "it is said");
    Assert.equal(
      f.said.at(-1),
      "agent: anthropic: key stored · ends …-one; not saved to config.toml (the test keeps config.toml)",
      "with its end and its provider kept as a stored key's is",
    );
    Assert.equal(f.chat.view, "key", "the other key field stays");
    Assert.equal(keyField(f.chat).value, "sk-other-half", "with what was typed");
    Assert.equal(f.chat.keyFor, HOSTED, "for its provider");
    Assert.deepEqual(f.chosen, [], "and the conversation's model is not changed");

    info("a store refused after the user left the field");
    press(f.chat, "Escape");
    f.chat.askKey(ANTHROPIC);
    typeKey(f.chat, "sk-ant-two");
    press(f.chat, "Enter");
    press(f.chat, "Escape");
    f.sets[1].reject(new Error("refused"));
    await afterRefusal(f.sets[1].promise);
    Assert.equal(
      f.said.at(-1),
      "agent: the key for anthropic could not be stored",
      "is said, without the error's text",
    );
    Assert.equal(f.chat.view, "chat", "the transcript stays");
    Assert.equal(f.chat.keyFor, null, "and the field is for no provider");

    info("a store refused while the user waits in the field");
    f.chat.askKey(ANTHROPIC);
    typeKey(f.chat, "sk-ant-three");
    press(f.chat, "Enter");
    f.sets[2].reject(new Error("refused"));
    await afterRefusal(f.sets[2].promise);
    Assert.equal(f.chat.view, "key", "the field stays, to type the key again");
    Assert.equal(keyField(f.chat).value, "", "empty");
    Assert.equal(f.chat.keyFor, ANTHROPIC, "for the same provider");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_key_deleted_as_the_picker_opens_again_is_shown_gone() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  /** @param {InstanceType<typeof AgentChatWindow>} chat */
  const hostedRow = (chat) =>
    chat.rows.find((/** @type {{ provider?: object }} */ r) => r.provider === HOSTED);
  try {
    f.chat.open({ view: "models" });
    f.hints[0].resolve("key stored · ends …abcd");
    await until(() => hostedRow(f.chat)?.detail === "key stored · ends …abcd", "its key shows");
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "x");
    Assert.equal(f.deletes.length, 1, "x deletes the key after the y");
    reopenPicker(f.chat);
    Assert.equal(f.hints.length, 2, "the picker opened again asks for the hint before that");

    f.deletes[0].resolve(true);
    info("the deletion answers while the model list shows again");
    await afterWindow([f.deletes[0].promise]);
    Assert.equal(f.hints.length, 3, "the model list shown asks for the hint again");
    f.hints[1].resolve("key stored · ends …abcd");
    info("the hint read before the deletion answers");
    await afterWindow([f.hints[1].promise]);
    Assert.notEqual(
      hostedRow(f.chat)?.detail,
      "key stored · ends …abcd",
      "the deleted key is not shown",
    );
    f.hints[2].resolve(null);
    await until(
      () => hostedRow(f.chat)?.detail === "no key · Enter adds one",
      "the row says there is no key",
    );
  } finally {
    f.chat.destroy();
  }
});

/** The notice for a pick whose model list was reloaded after a key was deleted. */
const RELOADED = (/** @type {string} */ label) =>
  `agent: ${label} not used: the model list was reloaded after a key was deleted; pick it again`;
const STILL_STORING = "agent: a key is still being stored; enter this one again once it is";

/**
 * Resolves after a 0 ms timer queued now has run: after the prompt's focusout check, which a
 * focus change queues as a 0 ms timer before this one (timers of one delay run in order).
 */
const afterTimers = () => new Promise((r) => window.setTimeout(r, 0));

add_task(async function test_a_refused_send_opens_the_picker_only_if_the_user_stayed() {
  const REFUSED = { refused: "small is gone; pick another model", pick: true };
  /** @returns {ReturnType<typeof fakeWindow>} */
  const sent = () => {
    const f = fakeWindow({ providers: [LOCAL], sendWaits: true });
    f.chat.open();
    /** @type {HTMLTextAreaElement} */ (f.chat.input).value = "hello";
    press(f.chat, "Enter");
    Assert.deepEqual(f.sends, ["hello"], "the message goes to the conversation's model");
    return f;
  };
  /** @param {ReturnType<typeof fakeWindow>} f */
  const input = (f) => /** @type {HTMLTextAreaElement} */ (f.chat.input).value;

  info("the user stays: the picker opens for another model, as before");
  let f = sent();
  try {
    f.sendAnswers[0].resolve(REFUSED);
    await afterWindow([f.sendAnswers[0].promise]);
    Assert.equal(f.chat.view, "models", "the picker opens");
    Assert.equal(input(f), "hello", "the message is back in the input");
    Assert.equal(f.said.at(-1), "agent: small is gone; pick another model", "and it is said");
  } finally {
    f.chat.destroy();
  }

  info("the user sets up Anthropic and types its key before the refusal answers");
  f = sent();
  try {
    press(f.chat, "Escape");
    press(f.chat, "m");
    selectRow(f.chat, (r) => r.add === "anthropic");
    press(f.chat, "Enter");
    f.prompts.at(-1)?.submit("claude-test");
    typeKey(f.chat, "sk-ant-half");

    f.sendAnswers[0].resolve(REFUSED);
    await afterWindow([f.sendAnswers[0].promise]);
    Assert.equal(f.chat.view, "key", "the picker does not open over the key field");
    Assert.equal(keyField(f.chat).value, "sk-ant-half", "which keeps what was typed");
    Assert.equal(f.chat.keyFor?.name, "anthropic", "for its provider");
    Assert.equal(document.activeElement, f.chat.keyInput, "and keeps focus");
    Assert.equal(input(f), "hello", "the message is back in the input");
    Assert.equal(
      f.said.at(-1),
      "agent: small is gone; pick another model; the message is still in the input",
      "and the user is told",
    );
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_prompt_opened_from_the_picker_ends_a_pick_still_waiting() {
  const rename = new RenamePrompt(window, { apply() {} });
  const f = fakeWindow({ providers: [LOCAL, HOSTED], prompt: (o) => rename.prompt(o) });
  try {
    f.chat.open({ view: "models" });
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "Enter");
    Assert.equal(f.hints.length, 2, "the pick reads its provider's key hint");

    info("while it waits, add: Anthropic opens the prompt line");
    selectRow(f.chat, (r) => r.add === "anthropic");
    press(f.chat, "Enter");
    Assert.ok(rename.isOpen, "add: Anthropic asks for its model on the prompt line");
    Assert.equal(document.activeElement, rename.input, "which has focus");

    f.hints[1].resolve(null);
    await afterWindow([f.hints[1].promise]);
    await afterTimers();
    Assert.equal(f.chat.view, "models", "the hosted pick opens no key field");
    Assert.equal(f.chat.keyFor, null, "asks for no key");
    Assert.ok(rename.isOpen, "the prompt line stays open");
    Assert.equal(document.activeElement, rename.input, "and keeps focus");
    Assert.deepEqual(f.chosen, [], "no model is used");
    Assert.equal(f.said.at(-1), NOT_USED("hosted · big"), "and the user is told");

    f.prompts.at(-1)?.submit("claude-test");
    Assert.equal(f.chat.keyFor?.name, "anthropic", "the prompt's model asks for its own key");
  } finally {
    rename.close({ restoreFocus: false });
    rename.el?.remove();
    f.chat.destroy();
  }

  info("a local model prepared while the prompt line is open is not used");
  const g = fakeWindow({ providers: [LOCAL] });
  try {
    g.chat.open({ view: "models" });
    g.probes[0].resolve(OLLAMA);
    g.states[0].resolve(new Map());
    await until(() => drawn(g.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(g.chat, (r) => r.label === "ollama · llama");
    press(g.chat, "Enter");
    selectRow(g.chat, (r) => r.add === "anthropic");
    press(g.chat, "Enter");
    Assert.equal(g.prompts.at(-1)?.label, "agent model: ", "the prompt line asks");
    g.prepares[0].resolve({ model: "llama" });
    await afterWindow([g.prepares[0].promise]);
    Assert.equal(g.chat.view, "models", "the transcript does not open under the prompt");
    Assert.deepEqual(g.chosen, [], "the model is not used");
    Assert.deepEqual(g.places, [], "nor loaded");
    Assert.equal(g.said.at(-1), NOT_USED("ollama · llama"), "and the user is told");
  } finally {
    g.chat.destroy();
  }
});

add_task(async function test_a_second_key_entered_while_one_is_stored_is_said_dropped() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open();
    f.chat.askKey(ANTHROPIC);
    typeKey(f.chat, "sk-ant-one");
    press(f.chat, "Enter");
    Assert.equal(f.sets.length, 1, "the first key goes to login storage");
    EventUtils.sendString("sk-ant-two");
    press(f.chat, "Enter");
    Assert.equal(keyField(f.chat).value, "", "the second leaves the field at once");
    Assert.equal(f.sets.length, 1, "but is not stored over the first");
    Assert.equal(f.said.at(-1), STILL_STORING, "and the user is told");
    Assert.ok(!f.said.some((s) => s.includes("sk-ant")), "no notice holds the key's text");
  } finally {
    f.chat.destroy();
  }
});

add_task(
  async function test_a_send_whose_key_hint_fails_asks_for_the_key_only_if_the_user_stayed() {
    /** @returns {ReturnType<typeof fakeWindow>} */
    const waiting = () => {
      const f = fakeWindow({ providers: [HOSTED] });
      f.chat.open();
      /** @type {HTMLTextAreaElement} */ (f.chat.input).value = "hello";
      press(f.chat, "Enter");
      Assert.equal(f.hints.length, 1, "the send reads the provider's key hint first");
      return f;
    };
    info("the user stays: the key field opens");
    let f = waiting();
    try {
      f.hints[0].reject(new Error("keyring"));
      await afterRefusal(f.hints[0].promise);
      Assert.equal(f.chat.view, "key", "the key field asks for the key");
      Assert.equal(f.chat.keyFor, HOSTED, "of the conversation's provider");
      Assert.deepEqual(f.sends, [], "and nothing is sent");
    } finally {
      f.chat.destroy();
    }
    info("the user opened the picker meanwhile");
    f = waiting();
    try {
      press(f.chat, "Escape");
      press(f.chat, "m");
      f.hints[0].reject(new Error("keyring"));
      await afterRefusal(f.hints[0].promise);
      Assert.equal(f.chat.view, "models", "the key field does not open over the picker");
      Assert.equal(f.chat.keyFor, null, "and asks for no key");
      Assert.deepEqual(f.sends, [], "nothing is sent");
      Assert.ok(f.said.includes(NOT_SENT), "and the user is told");
    } finally {
      f.chat.destroy();
    }
  },
);

add_task(async function test_a_failed_preparation_replaced_by_a_later_pick_says_nothing() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  try {
    f.chat.open({ view: "models" });
    f.hints[0].resolve("key stored · ends …abcd");
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === "ollama · llama");
    press(f.chat, "Enter");
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "Enter");
    f.prepares[0].reject(new Error("out of disk"));
    await afterRefusal(f.prepares[0].promise);
    Assert.ok(!f.said.some((s) => s.includes("out of disk")), "the replaced pick says nothing");
    f.hints[1].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[1].promise]);
    Assert.deepEqual(f.chosen, [HOSTED], "the later pick is used");
  } finally {
    f.chat.destroy();
  }
});

add_task(async function test_a_pick_on_a_list_reloaded_after_a_key_deletion_says_so() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  try {
    f.chat.open({ view: "models" });
    f.hints[0].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[0].promise]);
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "Enter");
    Assert.equal(f.hints.length, 2, "the pick reads its provider's key hint");
    press(f.chat, "x");
    f.deletes[0].resolve(true);
    await afterWindow([f.deletes[0].promise]);
    Assert.equal(f.hints.length, 3, "the deletion reloads the model list");
    f.hints[1].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[1].promise]);
    Assert.deepEqual(f.chosen, [], "the pick made before the deletion is not used");
    Assert.equal(f.said.at(-1), RELOADED("hosted · big"), "and the notice says why");
  } finally {
    f.chat.destroy();
  }
});

/** What the address bar holds. */
const addressBar = () => /** @type {string} */ (/** @type {any} */ (gURLBar).value);

/**
 * Moves focus out of the chat window to the address bar and types there, as a user who clicks
 * into a field elsewhere does; returns what the address bar holds.
 * @param {string} text
 */
function typeElsewhere(text) {
  gURLBar.focus();
  EventUtils.sendString(text);
  return addressBar();
}

/** @param {string} what */
function assertFocusStaysElsewhere(what) {
  Assert.equal(
    document.activeElement,
    /** @type {any} */ (gURLBar).inputField,
    `${what}: focus stays in the address bar`,
  );
}

function revertAddressBar() {
  const bar = /** @type {any} */ (gURLBar);
  bar.handleRevert();
  bar.view.close();
  bar.blur();
}

add_task(async function test_a_pick_answering_after_focus_left_the_window_takes_no_focus() {
  /**
   * The picker on LOCAL, HOSTED and ollama, with `label` picked and focus gone elsewhere.
   * @param {string} label
   * @param {string | null} hint  HOSTED's key hint as the picker opens
   */
  const pickedThenAway = async (label, hint) => {
    const f = fakeWindow({ providers: [LOCAL, HOSTED] });
    f.chat.open({ view: "models" });
    f.hints[0].resolve(hint);
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === label);
    press(f.chat, "Enter");
    Assert.equal(document.activeElement, f.chat.log, "the picker keeps focus after Enter");
    Assert.ok(f.chat.focused, "and the window counts as focused");
    Assert.equal(typeElsewhere("abc"), "abc", "the user types in the address bar");
    return f;
  };
  /**
   * @param {ReturnType<typeof fakeWindow>} f @param {string} label @param {string} what
   */
  const assertUntouched = (f, label, what) => {
    assertFocusStaysElsewhere(what);
    Assert.equal(f.chat.view, "models", `${what}: the view stays`);
    Assert.equal(f.chat.keyFor, null, `${what}: no key is asked for`);
    Assert.deepEqual(f.chosen, [], `${what}: the model is not used`);
    Assert.deepEqual(f.places, [], `${what}: nor loaded`);
    Assert.equal(f.said.at(-1), NOT_USED(label), `${what}: and the user is told`);
    EventUtils.sendString("def");
    Assert.equal(addressBar(), "abcdef", `${what}: what is typed next stays in the address bar`);
    Assert.equal(keyField(f.chat).value, "", `${what}: none of it in the key field`);
    Assert.equal(
      /** @type {HTMLTextAreaElement} */ (f.chat.input).value,
      "",
      `${what}: nor in the chat input`,
    );
  };

  info("a hosted model whose key hint says there is no key");
  let f = await pickedThenAway("hosted · big", "no key");
  try {
    f.hints[1].resolve(null);
    await afterWindow([f.hints[1].promise]);
    assertUntouched(f, "hosted · big", "no key");
  } finally {
    revertAddressBar();
    f.chat.destroy();
  }

  info("a hosted model whose key is there");
  f = await pickedThenAway("hosted · big", "key stored · ends …abcd");
  try {
    f.hints[1].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[1].promise]);
    assertUntouched(f, "hosted · big", "a stored key");
  } finally {
    revertAddressBar();
    f.chat.destroy();
  }

  info("a local model prepared after focus left");
  f = await pickedThenAway("ollama · llama", "key stored · ends …abcd");
  try {
    f.prepares[0].resolve({ model: "llama" });
    await afterWindow([f.prepares[0].promise]);
    assertUntouched(f, "ollama · llama", "a local model");
  } finally {
    revertAddressBar();
    f.chat.destroy();
  }
});

add_task(async function test_a_pick_whose_browser_window_lost_os_focus_is_still_used() {
  const f = fakeWindow({ providers: [LOCAL, HOSTED] });
  /** @type {any} */
  let other = null;
  try {
    f.chat.open({ view: "models" });
    f.hints[0].resolve("key stored · ends …abcd");
    selectRow(f.chat, (r) => r.label === "hosted · big");
    press(f.chat, "Enter");
    info("another window takes OS focus, as a keyring prompt does, while the hint is read");
    other = await BrowserTestUtils.openNewBrowserWindow();
    Assert.ok(!document.hasFocus(), "the browser window has lost OS focus");
    Assert.equal(document.activeElement, f.chat.log, "its focused element is still the picker");
    Assert.ok(f.chat.focused, "so the chat window still counts as focused");
    f.hints[1].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[1].promise]);
    Assert.deepEqual(f.chosen, [HOSTED], "the pick is used");
    Assert.equal(f.chat.view, "chat", "and the transcript shows, as before");
  } finally {
    if (other) await BrowserTestUtils.closeWindow(other);
    f.chat.destroy();
  }
});

add_task(async function test_a_send_or_refusal_answering_after_focus_left_moves_nothing() {
  info("a send whose key hint answers after focus left");
  const f = fakeWindow({ providers: [HOSTED], notice: true });
  try {
    f.chat.open();
    /** @type {HTMLTextAreaElement} */ (f.chat.input).value = "hello";
    press(f.chat, "Enter");
    typeElsewhere("abc");
    f.hints[0].resolve("key stored · ends …abcd");
    await afterWindow([f.hints[0].promise]);
    assertFocusStaysElsewhere("a late hint");
    Assert.deepEqual(f.asked, [], "no notice is asked");
    Assert.deepEqual(f.sends, [], "nothing is sent");
    Assert.equal(
      /** @type {HTMLTextAreaElement} */ (f.chat.input).value,
      "hello",
      "the message stays in the input",
    );
    Assert.ok(f.said.includes(NOT_SENT), "and the user is told");
  } finally {
    revertAddressBar();
    f.chat.destroy();
  }

  info("a refusal that answers after focus left");
  const g = fakeWindow({ providers: [LOCAL], sendWaits: true });
  try {
    g.chat.open();
    /** @type {HTMLTextAreaElement} */ (g.chat.input).value = "hello";
    press(g.chat, "Enter");
    typeElsewhere("abc");
    g.sendAnswers[0].resolve({ refused: "small is gone; pick another model", pick: true });
    await afterWindow([g.sendAnswers[0].promise]);
    assertFocusStaysElsewhere("a late refusal");
    Assert.equal(g.chat.view, "chat", "the picker does not open");
    Assert.equal(
      /** @type {HTMLTextAreaElement} */ (g.chat.input).value,
      "hello",
      "the message is back in the input",
    );
    Assert.equal(
      g.said.at(-1),
      "agent: small is gone; pick another model; the message is still in the input",
      "and the user is told",
    );
    EventUtils.sendString("def");
    Assert.equal(addressBar(), "abcdef", "what is typed next stays in the address bar");
  } finally {
    revertAddressBar();
    g.chat.destroy();
  }
});

add_task(async function test_a_key_stored_after_focus_left_the_window_takes_no_focus() {
  const f = fakeWindow({ providers: [LOCAL] });
  try {
    f.chat.open();
    f.chat.askKey(ANTHROPIC);
    typeKey(f.chat, "sk-ant-one");
    press(f.chat, "Enter");
    typeElsewhere("abc");
    f.sets[0].resolve();
    await afterWindow([f.sets[0].promise]);
    f.hints[0].resolve("key stored · ends …-one");
    await until(() => f.said.some((s) => s.startsWith("agent: anthropic:")), "it is said");
    assertFocusStaysElsewhere("a late store");
    Assert.deepEqual(f.chosen, [], "the conversation's model is left as it was");
    Assert.notEqual(f.chat.view, "chat", "the transcript does not open");
    EventUtils.sendString("def");
    Assert.equal(addressBar(), "abcdef", "what is typed next stays in the address bar");
    Assert.ok(!f.said.some((s) => s.includes("sk-ant")), "no notice holds the key's text");
  } finally {
    revertAddressBar();
    f.chat.destroy();
  }
});

add_task(async function test_a_refused_add_provider_leaves_a_waiting_pick_alone() {
  const f = fakeWindow({ providers: [LOCAL], localOnly: true });
  try {
    f.chat.open({ view: "models" });
    f.probes[0].resolve(OLLAMA);
    f.states[0].resolve(new Map());
    await until(() => drawn(f.chat).includes("ollama · llama"), "the probe's models are listed");
    selectRow(f.chat, (r) => r.label === "ollama · llama");
    press(f.chat, "Enter");
    selectRow(f.chat, (r) => r.add === "anthropic");
    press(f.chat, "Enter");
    Assert.deepEqual(f.prompts, [], "local_only refuses Anthropic before any prompt");
    f.prepares[0].resolve({ model: "llama" });
    await afterWindow([f.prepares[0].promise]);
    Assert.equal(f.chosen.length, 1, "the waiting pick is used");
    Assert.ok(!f.said.some((s) => s.includes("not used")), "with no notice that it was not");
  } finally {
    f.chat.destroy();
  }
});

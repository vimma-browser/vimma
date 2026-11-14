/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The commands of higher folders that the host runs (ADR-026, decision 4): the built-in agent's
// conversations (agent/), the agent-download test (ctl/) and `:route add`'s write to config.toml
// (config/), and what the agent chat window the host builds uses of them: the agent CLIs and the
// API keys (agent/), config.toml's refusal and setup's write to it (config/). The host may not
// import those folders, so vimma.js, the window script, which imports every folder, hands them
// over here before the first window's host starts, and the host calls them through here or
// hands them to the window (host/agent-chat-ops.mjs). Only host/ imports this registry. Each
// service is provided once and never replaced, and the registry is frozen: that is the
// guarantee. The check that the caller is vimma.js only catches mistakes, since code that
// already runs with the system principal can run under that file name. The keys' service is
// AgentKeys narrowed to what the window does with a key (hint, set, delete): the registry never
// hands out AgentKeys.get, which returns the key itself, and holds no key.

/** @import { BudgetStatus } from "../core/agent-chat.mjs" */
/** @import { ChatConversations, ChatClis, ChatKeys, AgentChatServices } from "../ui/agent-chat.mjs" */

/**
 * The built-in agent's conversations, as far as the host uses them: the agent line follows them
 * and stops their tasks, `:agent give` hands a tab to one, the status bar counts the running
 * ones; and as far as the chat window drives them (ChatConversations).
 * @typedef {object} HostChatService
 * @property {(listener: () => void) => void} addListener
 * @property {(listener: () => void) => void} removeListener
 * @property {() => void} stopAll
 * @property {() => { id: number, running: boolean, budget: BudgetStatus | null }[]} list
 * @property {(tab: any) => number | null} ownerOf  the conversation that owns a tab, or null
 * @property {(id: number, tab: any, title: string) => void} give
 * @typedef {HostChatService & ChatConversations} AgentChatService
 */

/**
 * @typedef {object} Services
 * @property {AgentChatService} agentChat  agent/AgentChat.sys.mjs's `AgentChat`
 * @property {(download: any) => boolean} isAgentDownload  ctl/AgentDownloads.sys.mjs's test
 *   (docs/security.md M11): the downloads picker opens, retries, unblocks and follows none
 * @property {(rule: { domain: string, workspace: string }) => Promise<string | null>} addRoute
 *   config/ConfigHost.sys.mjs's: appends a `[[routes]]` rule and reads the file again; why not,
 *   or null
 * @property {ChatClis} agentCli  agent/AgentCli.sys.mjs's `AgentCli`, for the chat window
 * @property {ChatKeys} agentKeys  agent/AgentKeys.sys.mjs's `AgentKeys`, served as its `hint`,
 *   `set` and `delete` only, for the chat window (docs/security.md M40, M46)
 * @property {AgentChatServices["configRefused"]} configRefused  config/ConfigHost.sys.mjs's
 *   `refused`: why config.toml did not apply, for the chat window (Behaviour 6)
 * @property {AgentChatServices["addAgentProvider"]} addAgentProvider
 *   config/ConfigHost.sys.mjs's: setup's write of a provider to config.toml, for the chat
 *   window (B12)
 */

/** @typedef {keyof Services} ServiceName */

/**
 * The one caller expected to provide the services: the window script, at startup. A guard
 * against a mistaken caller, not a boundary (see the header).
 */
const PROVIDER = "chrome://browser/content/vimma/vimma.js";

/** @type {readonly ServiceName[]} */
const NAMES = Object.freeze([
  "agentChat",
  "isAgentDownload",
  "addRoute",
  "agentCli",
  "agentKeys",
  "configRefused",
  "addAgentProvider",
]);

/**
 * The services that are objects, by the members their users call: methods, then the properties
 * they read. The others are functions.
 * @type {Readonly<Partial<Record<ServiceName, { methods: readonly string[],
 *   properties: readonly string[] }>>>}
 */
const SHAPES = Object.freeze({
  agentChat: Object.freeze({
    methods: Object.freeze([
      // The host's.
      "addListener",
      "removeListener",
      "stopAll",
      "list",
      "ownerOf",
      "give",
      // The chat window's.
      "restore",
      "get",
      "create",
      "send",
      "stop",
      "clear",
      "delete",
      "forgetAll",
      "transcript",
      "setProvider",
      "choose",
      "needsNotice",
      "confirm",
      "probe",
      "modelStates",
      "prepareLocal",
      "placeLocal",
    ]),
    properties: Object.freeze(["restored", "chosen"]),
  }),
  agentCli: Object.freeze({
    methods: Object.freeze(["find", "noneFound", "use"]),
    properties: Object.freeze(["enabled"]),
  }),
  agentKeys: Object.freeze({
    methods: Object.freeze(["hint", "set", "delete"]),
    properties: Object.freeze([]),
  }),
});

const NOT_STARTED = "the built-in agent is not started";
const notStarted = () => {
  throw new Error(NOT_STARTED);
};

/** config.toml before vimma.js provides ConfigHost's refusal: refused, since nothing applies. */
const NOT_READ = Object.freeze({
  errors: Object.freeze([
    Object.freeze({ path: "", message: "not read yet: Vimma has not started" }),
  ]),
  file: "config.toml",
});

/**
 * What a service does before it is provided, which vimma.js's order makes unreachable: never
 * more than the provided one would. Every download counts as an agent's, so the picker refuses
 * it; there are no conversations, so nothing stops, nothing is owned, given, created, sent,
 * switched or confirmed, and a send would first say where its data goes; no agent CLI is
 * offered or kept; no key is known, stored or deleted; config.toml counts as refused, so the
 * chat window offers no setup, and nothing is written to it.
 * @type {Readonly<Services>}
 */
const UNPROVIDED = Object.freeze({
  agentChat: Object.freeze({
    addListener() {},
    removeListener() {},
    stopAll() {},
    list: () => [],
    ownerOf: () => null,
    give: notStarted,
    // true: nothing to restore, so the window never waits for a restore that brings nothing.
    restored: true,
    chosen: null,
    restore: async () => {},
    get: notStarted,
    create: notStarted,
    send: async () => notStarted(),
    stop() {},
    clear: () => NOT_STARTED,
    delete: async () => {},
    forgetAll: async () => {},
    transcript: notStarted,
    setProvider: () => NOT_STARTED,
    choose() {},
    needsNotice: () => true,
    confirm() {},
    probe: async () => [],
    modelStates: async () => new Map(),
    prepareLocal: async () => notStarted(),
    placeLocal: async () => null,
  }),
  isAgentDownload: () => true,
  addRoute: async () => "config.toml cannot be written before Vimma has started",
  agentCli: Object.freeze({
    enabled: false,
    find: async () => [],
    noneFound: () => "agent CLIs are not available before Vimma has started",
    use: notStarted,
  }),
  agentKeys: Object.freeze({
    hint: async () => null,
    set: async () => {
      throw new Error("no key can be stored before Vimma has started");
    },
    delete: async () => false,
  }),
  configRefused: () => NOT_READ,
  addAgentProvider: async () => ({
    error: "config.toml cannot be written before Vimma has started",
  }),
});

/**
 * Why `value` cannot be service `name`, or null.
 * @param {string} name @param {unknown} value
 */
function refusal(name, value) {
  if (!NAMES.includes(/** @type {ServiceName} */ (name))) return `there is no service ${name}`;
  const shape = SHAPES[/** @type {ServiceName} */ (name)];
  if (!shape) return typeof value === "function" ? null : `${name} must be a function`;
  const service = /** @type {Record<string, unknown> | null} */ (value);
  const missing = [
    ...shape.methods.filter((m) => typeof service?.[m] !== "function"),
    ...shape.properties.filter((p) => !service || typeof service !== "object" || !(p in service)),
  ];
  return missing.length ? `${name} must have ${missing.join(", ")}` : null;
}

/**
 * AgentKeys as the registry serves it: the three calls the chat window makes, each passed
 * straight through, so no key is held here and AgentKeys.get, which returns one, is not
 * reachable through the registry.
 * @param {ChatKeys} keys
 * @returns {ChatKeys}
 */
const narrowKeys = (keys) =>
  Object.freeze({
    hint: (/** @type {string} */ provider, /** @type {string} */ endpoint) =>
      keys.hint(provider, endpoint),
    set: (
      /** @type {string} */ provider,
      /** @type {string} */ key,
      /** @type {string} */ endpoint,
    ) => keys.set(provider, key, endpoint),
    delete: (/** @type {string} */ provider) => keys.delete(provider),
  });

/**
 * A registry of the host's services. The app has one, `HostServices`; a test makes its own,
 * naming its own file as the provider.
 * @param {string} [provider]  the script URL whose top-level code may call `provide`
 */
export function createHostServices(provider = PROVIDER) {
  /** @type {Partial<Services>} what vimma.js handed over, to tell a second value from the same */
  const provided = {};
  /** @type {Partial<Services>} what the host gets: the same, but the keys narrowed */
  const served = {};
  /** @type {Set<ServiceName>} */
  const reported = new Set();

  /**
   * @template {ServiceName} K
   * @param {K} name
   * @returns {Services[K]}
   */
  function get(name) {
    const service = served[name];
    if (service) return /** @type {Services[K]} */ (service);
    if (!reported.has(name)) {
      reported.add(name);
      console.error(`vimma: the host asked for ${name} before vimma.js provided it`);
    }
    return UNPROVIDED[name];
  }

  return Object.freeze({
    /**
     * Hands the host its services, from vimma.js only. Each window runs vimma.js, so a service
     * provided again as the same value changes nothing; another value, a name the host does not
     * use or a value of the wrong shape throws, and then nothing of the call is provided.
     * @param {Partial<Services>} services
     */
    provide(services) {
      const caller = Components.stack.caller?.filename;
      if (caller !== provider) {
        throw new Error(
          `HostServices: only ${provider} provides the host's services, not ${caller}`,
        );
      }
      for (const [name, value] of Object.entries(services)) {
        const why = refusal(name, value);
        if (why) throw new Error(`HostServices: ${why}`);
        const known = provided[/** @type {ServiceName} */ (name)];
        if (known && known !== value) throw new Error(`HostServices: ${name} is already provided`);
      }
      for (const [name, value] of Object.entries(services)) {
        const key = /** @type {ServiceName} */ (name);
        if (provided[key]) continue;
        /** @type {Record<string, unknown>} */ (provided)[key] = value;
        /** @type {Record<string, unknown>} */ (served)[key] =
          key === "agentKeys" ? narrowKeys(/** @type {ChatKeys} */ (value)) : value;
      }
    },

    /** The services not provided yet, in a fixed order. */
    missing() {
      return NAMES.filter((name) => !provided[name]);
    },

    get agentChat() {
      return get("agentChat");
    },
    get isAgentDownload() {
      return get("isAgentDownload");
    },
    get addRoute() {
      return get("addRoute");
    },
    get agentCli() {
      return get("agentCli");
    },
    get agentKeys() {
      return get("agentKeys");
    },
    get configRefused() {
      return get("configRefused");
    },
    get addAgentProvider() {
      return get("addAgentProvider");
    },
  });
}

/** The host's services, which vimma.js provides before the first window's host starts. */
export const HostServices = createHostServices();

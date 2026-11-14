/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The commands of higher folders that the host runs (ADR-026, decision 4): the built-in agent's
// conversations (agent/), the agent-download test (ctl/) and `:route add`'s write to config.toml
// (config/). The host may not import those folders, so vimma.js, the window script, which imports
// every folder, hands them over here before the first window's host starts, and the host calls
// them through here. Each is provided once and never replaced, and the registry is frozen: that
// is the guarantee. The check that the caller is vimma.js only catches mistakes, since code that
// already runs with the system principal can run under that file name.

/** @import { BudgetStatus } from "../core/agent-chat.mjs" */

/**
 * The built-in agent's conversations, as far as the host uses them: the agent line follows them
 * and stops their tasks, `:agent give` hands a tab to one, the status bar counts the running ones.
 * @typedef {object} AgentChatService
 * @property {(listener: () => void) => void} addListener
 * @property {(listener: () => void) => void} removeListener
 * @property {() => void} stopAll
 * @property {() => { id: number, running: boolean, budget: BudgetStatus | null }[]} list
 * @property {(tab: any) => number | null} ownerOf  the conversation that owns a tab, or null
 * @property {(id: number, tab: any, title: string) => void} give
 */

/**
 * @typedef {object} Services
 * @property {AgentChatService} agentChat  agent/AgentChat.sys.mjs's `AgentChat`
 * @property {(download: any) => boolean} isAgentDownload  ctl/AgentDownloads.sys.mjs's test
 *   (docs/security.md M11): the downloads picker opens, retries, unblocks and follows none
 * @property {(rule: { domain: string, workspace: string }) => Promise<string | null>} addRoute
 *   config/ConfigHost.sys.mjs's: appends a `[[routes]]` rule and reads the file again; why not,
 *   or null
 */

/** @typedef {keyof Services} ServiceName */

/**
 * The one caller expected to provide the services: the window script, at startup. A guard
 * against a mistaken caller, not a boundary (see the header).
 */
const PROVIDER = "chrome://browser/content/vimma/vimma.js";

/** @type {readonly ServiceName[]} */
const NAMES = Object.freeze(["agentChat", "isAgentDownload", "addRoute"]);

/** @type {readonly (keyof AgentChatService)[]} */
const AGENT_CHAT_METHODS = Object.freeze([
  "addListener",
  "removeListener",
  "stopAll",
  "list",
  "ownerOf",
  "give",
]);

/**
 * What a service does before it is provided, which vimma.js's order makes unreachable: never
 * more than the provided one would. Every download counts as an agent's, so the picker refuses
 * it; there are no conversations, so nothing stops, nothing is owned and nothing is given; and
 * config.toml is not written.
 * @type {Readonly<Services>}
 */
const UNPROVIDED = Object.freeze({
  agentChat: Object.freeze({
    addListener() {},
    removeListener() {},
    stopAll() {},
    list: () => [],
    ownerOf: () => null,
    give() {
      throw new Error("the built-in agent is not started");
    },
  }),
  isAgentDownload: () => true,
  addRoute: async () => "config.toml cannot be written before Vimma has started",
});

/**
 * Why `value` cannot be service `name`, or null.
 * @param {string} name @param {unknown} value
 */
function refusal(name, value) {
  if (!NAMES.includes(/** @type {ServiceName} */ (name))) return `there is no service ${name}`;
  if (name !== "agentChat")
    return typeof value === "function" ? null : `${name} must be a function`;
  const chat = /** @type {Record<string, unknown> | null} */ (value);
  const missing = AGENT_CHAT_METHODS.filter((m) => typeof chat?.[m] !== "function");
  return missing.length ? `agentChat must have ${missing.join(", ")}` : null;
}

/**
 * A registry of the host's services. The app has one, `HostServices`; a test makes its own,
 * naming its own file as the provider.
 * @param {string} [provider]  the script URL whose top-level code may call `provide`
 */
export function createHostServices(provider = PROVIDER) {
  /** @type {Partial<Services>} */
  const provided = {};
  /** @type {Set<ServiceName>} */
  const reported = new Set();

  /**
   * @template {ServiceName} K
   * @param {K} name
   * @returns {Services[K]}
   */
  function get(name) {
    const service = provided[name];
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
      Object.assign(provided, services);
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
  });
}

/** The host's services, which vimma.js provides before the first window's host starts. */
export const HostServices = createHostServices();

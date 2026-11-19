/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local AI agents and the agent workspace (docs/specs/vimma-mcp.md): `[mcp]` from config.toml,
// the pref `vimma.mcp.enabled` that `:mcp on|off` sets, `:mcp off`'s hold for the session
// (docs/specs/setup-v2.md decision 16), `:mcp forget` and `:mcp revoke`. The
// control socket's agent role (ctl/VimmaControl.sys.mjs) runs while `state.enabled` is true and
// hears of every change through MCP_CHANGED_TOPIC.

import {
  MCP_FORGET_QUESTION,
  mcpActivity,
  mcpOnQuestion,
  mcpState,
  mcpStatus,
  parseMcpCommand,
  planMcpSwitch,
} from "../core/agent.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { ControlHost } from "./control-ops.mjs";

/** @import { AgentConfig, McpConfig } from "../core/config.mjs" */

/** `:mcp on|off` (decision 3); `[mcp] enabled` in config.toml wins over it (decision 26). */
export const MCP_ENABLED_PREF = "vimma.mcp.enabled";
/** Told when `[mcp]` was (re)read: the socket's agent role may have to start or stop. */
export const MCP_CHANGED_TOPIC = "vimma-mcp-changed";
/** Told when `[agent]` was (re)read: the built-in agent's `keep_days` may have to run. */
export const AGENT_CONFIG_TOPIC = "vimma-agent-config";

const lazy = /** @type {Lazy<"AgentGate">} */ ({});
// Lazily, at call time: AgentGate reads `[mcp]` from this module too.
ChromeUtils.defineESModuleGetters(lazy, {
  AgentGate: "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
});

/** @type {McpConfig | null} config.toml's `[mcp]`, once read; until then the defaults apply. */
let config = null;
/** @type {AgentConfig | null} config.toml's `[agent]` (docs/specs/builtin-agent.md), once read. */
let agentConfig = null;
/**
 * `:mcp off` this session (setup-v2 decision 16): in memory only, so that a restart clears it,
 * and never touched by `configure`, so that no read of config.toml clears it; `:mcp on` does.
 */
let heldOff = false;
/** How many times `:mcp off` ran: a yes to an `:mcp on` asked before the latest one is refused. */
let offs = 0;

/**
 * @typedef {Readonly<{ offs: number, agent: string | null }>} McpConsentTicket  how many
 *   `:mcp off`s had run, and the agent workspace, when the setup's agents step was drawn
 */

/** @param {unknown} e */
const reason = (e) => /** @type {Error} */ (e).message;

export const McpHost = {
  /**
   * `[mcp]` from config.toml (ConfigHost, at every read).
   * @param {McpConfig | null} mcp  null: the defaults (tests)
   */
  configure(mcp) {
    config = mcp;
    Services.obs.notifyObservers(null, MCP_CHANGED_TOPIC);
  },

  /** `[mcp]` in force, or null before config.toml was read. */
  get config() {
    return config;
  },

  /**
   * `[agent]` from config.toml (ConfigHost, at every read): the built-in agent's providers and
   * limits.
   * @param {AgentConfig | null} agent  null: the defaults (tests)
   */
  configureAgent(agent) {
    agentConfig = agent;
    Services.obs.notifyObservers(null, AGENT_CONFIG_TOPIC);
  },

  /** `[agent]` in force, or null before config.toml was read. */
  get agentConfig() {
    return agentConfig;
  },

  /**
   * Whether agents may connect, and what decides it: `:mcp off` this session ("session"), else
   * `[mcp] enabled` when the file sets it, else the pref.
   * @returns {{ enabled: boolean, from: "session" | "config" | "pref" }}
   */
  get state() {
    return mcpState(switchState());
  },

  /**
   * Tests only: ends `:mcp off`'s hold, so that a test file stopped between its `:mcp off` and
   * `:mcp on` does not leave agents off for the files after it. Not reachable from a page, the
   * control socket or an agent.
   */
  _clearHoldForTests() {
    heldOff = false;
    Services.obs.notifyObservers(null, MCP_CHANGED_TOPIC);
  },

  /** `:mcp on|off`'s pref and whether `:mcp off` holds agents off (setup-v2 behaviour 9). */
  get switchState() {
    const { pref, off } = switchState();
    return { pref, off };
  },

  /**
   * What `:mcp on`'s question remembers when it is asked, taken when the setup's agents step is
   * drawn: that step's `enter` on "on" is the consent a yes is (setup-v2 behaviour 28), and is
   * checked against it as the yes is (docs/security/12-agents-mcp.md M65).
   * @returns {McpConsentTicket}
   */
  consentTicket() {
    return Object.freeze({ offs, agent: WorkspaceStore.agent?.id ?? null });
  },

  /**
   * Why a consent given on `ticket` may not turn agents on now, where `:mcp on`'s yes would be
   * refused too: no agent workspace, another one since, or an `:mcp off` since. Null when it may.
   * @param {McpConsentTicket} ticket
   * @returns {string | null}
   */
  consentRefusal(ticket) {
    const agent = WorkspaceStore.agent;
    if (!agent) return "there is no agent workspace (containers off?)";
    if (ticket.agent !== agent.id) return `"${agent.name}" changed since this step was drawn`;
    // An `:mcp off` typed after the step was drawn (in another window, say) is the newer word.
    if (ticket.offs !== offs) return ":mcp off ran since this step was drawn";
    return null;
  },

  /**
   * The setup's agents step turned agents on (its `[mcp] enabled = true` written and read):
   * ends `:mcp off`'s hold, as `:mcp on`'s yes does, after the same checks. Refused here, after
   * the write (the workspace changed or went away meanwhile), it holds agents off as `:mcp off`
   * does, so that the file just written does not turn them on without a consent that counts.
   * @param {McpConsentTicket} ticket
   * @returns {string | null} why not, or null once agents may connect
   */
  consentFromSetup(ticket) {
    const why = this.consentRefusal(ticket);
    if (why) {
      heldOff = true;
      Services.obs.notifyObservers(null, MCP_CHANGED_TOPIC);
      return why;
    }
    heldOff = false;
    // Always: the file's read already told the topic while the hold still stood.
    Services.obs.notifyObservers(null, MCP_CHANGED_TOPIC);
    return null;
  },

  /**
   * The agent workspace as the agents step shows it: missing (containers off), or one Vimma
   * did not make, with its tabs, as `:mcp on`'s question names it (decision 8).
   * @returns {{ missing?: boolean, adopted?: { name: string, tabs: number } | null }}
   */
  setupAgent() {
    const agent = WorkspaceStore.agent;
    if (!agent) return { missing: true };
    if (WorkspaceStore.agentIsOurs()) return { adopted: null };
    return { adopted: { name: agent.name, tabs: countTabs(agent) } };
  },

  /** The agent workspace's name, as questions and notices show it. */
  get workspaceName() {
    return WorkspaceStore.agent?.name ?? WorkspaceStore.agentName ?? "agent";
  },

  /**
   * `:mcp [on|off|forget|revoke|log]`: returns the notice's text, or null while a y/N question
   * or the log is open.
   * @param {string | undefined} text
   * @param {(question: string, yes: () => void) => void} ask
   * @param {(text: string) => void} say  the notice, after the answer
   * @param {() => void} [showLog]  opens `:mcp log`'s list (docs/specs/mcp-drive.md D14)
   * @returns {string | null}
   */
  run(text, ask, say, showLog) {
    const command = parseMcpCommand(text);
    const agent = WorkspaceStore.agent;
    const name = this.workspaceName;
    switch (command.kind) {
      case "refuse":
        return command.text;
      case "status": {
        const gate = lazy.AgentGate;
        const activity = mcpActivity({
          connections: gate.connections.length,
          waiting: gate.waiting.length,
          grants: gate.grants(),
          now: Date.now(),
        });
        // Decision 29: full control's state too, since an agent could use it.
        return `${mcpStatus({ ...this.state, workspace: name })}${activity} · ${ControlHost.status()}`;
      }
      case "revoke": {
        const n = lazy.AgentGate.revoke();
        return n
          ? `mcp: ended ${n} agent grant${n === 1 ? "" : "s"}`
          : "mcp: no agent grants to end";
      }
      case "forget":
        return forget(ask, say);
      case "log": {
        if (showLog) {
          showLog();
          return null;
        }
        const n = lazy.AgentGate.log.length;
        return `mcp log: ${n} agent call${n === 1 ? "" : "s"}`;
      }
      case "on":
      case "off": {
        const plan = planMcpSwitch(command.kind, switchState());
        if (plan.kind === "say") return plan.text;
        if (plan.kind === "off") {
          const was = this.state.enabled;
          heldOff = true;
          offs++;
          // The pref's observers hear the pref; the hold alone is told through the topic.
          if (plan.pref) Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
          else if (was) Services.obs.notifyObservers(null, MCP_CHANGED_TOPIC);
          return plan.text;
        }
        if (!agent) return "mcp: there is no agent workspace (containers off?)";
        // A workspace of yours that took the name: agents would read what is already in it.
        const adopted = WorkspaceStore.agentIsOurs() ? null : { tabs: countTabs(agent) };
        const asked = offs;
        ask(mcpOnQuestion(agent.name, adopted), () => {
          if (WorkspaceStore.agent?.id !== agent.id) {
            say(`mcp: "${agent.name}" changed since you were asked; MCP stays off`);
            return;
          }
          // An `:mcp off` typed after this question (in another window, say) is the newer word.
          if (offs !== asked) {
            say("mcp: :mcp off ran since you were asked; MCP stays off");
            return;
          }
          heldOff = false;
          // With `[mcp] enabled = true` the file turns agents on: the pref stays as it is.
          if (config?.enabled !== true) Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
          // Always: a pref that was already true (set under the hold) tells no observer.
          Services.obs.notifyObservers(null, MCP_CHANGED_TOPIC);
          say(`mcp on: agents may ask to use "${agent.name}"; each request asks you first`);
        });
        return null;
      }
    }
    return null;
  },
};

/** What `:mcp on|off` and `state` decide from: the pref, the file, and `:mcp off`'s hold. */
function switchState() {
  return {
    pref: Services.prefs.getBoolPref(MCP_ENABLED_PREF, false),
    ...(config?.enabled === undefined ? {} : { config: config.enabled }),
    off: heldOff,
  };
}

/**
 * `:mcp forget` (decision 8): after a yes, the agent workspace's cookies and site data go; the
 * workspace and its tabs stay.
 * @param {(question: string, yes: () => void) => void} ask
 * @param {(text: string) => void} say
 * @returns {string | null}
 */
function forget(ask, say) {
  const agent = WorkspaceStore.agent;
  if (!agent) return "mcp: there is no agent workspace (containers off?)";
  const asked = { id: agent.id, userContextId: agent.userContextId };
  ask(MCP_FORGET_QUESTION, () => {
    try {
      WorkspaceStore.forgetAgent({ confirmed: true, asked });
      say(`mcp: deleted the cookies and site data of "${agent.name}"; it stays, logged out`);
    } catch (e) {
      say(`mcp forget: ${reason(e)}`);
    }
  });
  return null;
}

/**
 * The agent workspace's open tabs, in every browser window.
 * @param {{ userContextId: number | null }} agent
 */
function countTabs({ userContextId }) {
  if (userContextId === null) return 0;
  let n = 0;
  for (const w of Services.wm.getEnumerator("navigator:browser")) {
    const tabs = /** @type {{ userContextId: number, closing?: boolean }[]} */ (
      w.gBrowser?.tabs ?? []
    );
    n += tabs.filter((t) => t.userContextId === userContextId && !t.closing).length;
  }
  return n;
}

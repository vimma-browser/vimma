/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local AI agents and the agent workspace (docs/specs/vimma-mcp.md): `[mcp]` from config.toml,
// the pref `vimma.mcp.enabled` that `:mcp on|off` sets, `:mcp forget` and `:mcp revoke`. The
// control socket's agent role (ctl/VimmaControl.sys.mjs) runs while `state.enabled` is true and
// hears of every change through MCP_CHANGED_TOPIC.

import {
  MCP_FORGET_QUESTION,
  mcpActivity,
  mcpOnQuestion,
  mcpStatus,
  parseMcpCommand,
  planMcpSwitch,
} from "../core/agent.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { ControlHost } from "./control-ops.mjs";

/** @import { McpConfig } from "../core/config.mjs" */

/** `:mcp on|off` (decision 3); `[mcp] enabled` in config.toml wins over it (decision 26). */
export const MCP_ENABLED_PREF = "vimma.mcp.enabled";
/** Told when `[mcp]` was (re)read: the socket's agent role may have to start or stop. */
export const MCP_CHANGED_TOPIC = "vimma-mcp-changed";

const lazy = /** @type {any} */ ({});
// Lazily, at call time: AgentGate reads `[mcp]` from this module too.
ChromeUtils.defineESModuleGetters(lazy, {
  AgentGate: "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
});

/** @type {McpConfig | null} config.toml's `[mcp]`, once read; until then the defaults apply. */
let config = null;

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
   * Whether agents may connect, and what decides it: `[mcp] enabled` when the file sets it,
   * else the pref.
   * @returns {{ enabled: boolean, from: "config" | "pref" }}
   */
  get state() {
    if (config?.enabled !== undefined) return { enabled: config.enabled, from: "config" };
    return { enabled: Services.prefs.getBoolPref(MCP_ENABLED_PREF, false), from: "pref" };
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
        const plan = planMcpSwitch(command.kind, {
          pref: Services.prefs.getBoolPref(MCP_ENABLED_PREF, false),
          ...(config?.enabled === undefined ? {} : { config: config.enabled }),
        });
        if (plan.kind === "say") return plan.text;
        if (plan.kind === "set") {
          Services.prefs.setBoolPref(MCP_ENABLED_PREF, plan.value);
          return plan.text;
        }
        if (!agent) return "mcp: there is no agent workspace (containers off?)";
        // A workspace of yours that took the name: agents would read what is already in it.
        const adopted = WorkspaceStore.agentIsOurs() ? null : { tabs: countTabs(agent) };
        ask(mcpOnQuestion(agent.name, adopted), () => {
          if (WorkspaceStore.agent?.id !== agent.id) {
            say(`mcp: "${agent.name}" changed since you were asked; MCP stays off`);
            return;
          }
          Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
          say(`mcp on: agents may ask to use "${agent.name}"; each request asks you first`);
        });
        return null;
      }
    }
    return null;
  },
};

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
  for (const w of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
    const tabs = /** @type {{ userContextId: number, closing?: boolean }[]} */ (
      /** @type {any} */ (w).gBrowser?.tabs ?? []
    );
    n += tabs.filter((t) => t.userContextId === userContextId && !t.closing).length;
  }
  return n;
}

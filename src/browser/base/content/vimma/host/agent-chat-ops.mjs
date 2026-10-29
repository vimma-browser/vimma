/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's chat window, run (docs/specs/builtin-agent.md Behaviour 14, 17): `:agent`
// and its words, and giving the selected tab to a conversation, which moves it to the agent
// workspace after a y/N, as the workspace picker's `m` does (host/workspace-ops.mjs), so that
// one rule describes sharing a tab with any agent (B16).

import { parseAgentCommand } from "../core/agent-chat.mjs";
import { moveTabQuestion } from "../core/workspacedefs.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AgentChat: "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
});

/** What a tab is called in the transcript: its label, on one line, cut. @param {any} tab */
const tabTitle = (tab) =>
  [
    ...String(tab.label ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, 60)
    .join("");

/**
 * `P`, `:agent give` (Behaviour 17): the browser window's selected tab becomes conversation
 * `id`'s. A tab of another workspace moves to the agent workspace after a y, reopened there with
 * its cookies and without its history; the agent never reads it where it is (B16).
 * @param {Window} win @param {number} id
 * @param {(question: string, yes: () => void) => void} ask
 * @param {(text: string) => void} say
 */
export function giveSelectedTab(win, id, ask, say) {
  const agent = WorkspaceStore.agent;
  const ww = WindowWorkspaces.get(win);
  if (!agent || !ww?.model) {
    say("agent: there is no agent workspace (containers off?)");
    return;
  }
  const gBrowser = /** @type {any} */ (win).gBrowser;
  const tab = gBrowser.selectedTab;
  const title = tabTitle(tab);
  if (tab.userContextId === /** @type {any} */ (agent).userContextId && !ww.isForeign(tab)) {
    const owner = lazy.AgentChat.ownerOf(tab);
    if (owner === id) say("agent: that tab is this conversation's already");
    // Another conversation's tab stays its own: one model never reaches another's pages (B17).
    else if (owner !== null) say("agent: that tab is another conversation's");
    else lazy.AgentChat.give(id, tab, title);
    return;
  }
  ask(moveTabQuestion(agent.name, { agent: WorkspaceStore.agentName }), () => {
    // The yes stands for this tab and this agent workspace, as the picker's m does.
    if (!tab.isConnected || gBrowser.selectedTab !== tab || WorkspaceStore.agent?.id !== agent.id) {
      say("agent: the tab changed since you were asked; nothing was moved");
      return;
    }
    let given = false;
    const refused = ww.moveTab(
      tab,
      { id: agent.id },
      {
        onMoved: (fresh) => {
          lazy.AgentChat.give(id, fresh, title);
          given = true;
        },
      },
    );
    if (refused) say(`agent: ${refused}`);
    else if (given) say(`agent: gave "${title}" to the agent; it was reopened in "${agent.name}"`);
  });
}

/**
 * `:agent [word]` (Behaviour 14) for a window's chat.
 * @param {import("../ui/agent-chat.mjs").AgentChatWindow} chat
 * @param {string | undefined} text
 * @param {(text: string, error?: boolean) => void} say
 */
export function runAgentCommand(chat, text, say) {
  const command = parseAgentCommand(text);
  switch (command.kind) {
    case "open":
      chat.open();
      return;
    case "stop":
      chat.stop();
      return;
    case "new":
      chat.newConversation();
      return;
    case "model":
      chat.open({ view: "models" });
      return;
    case "list":
      chat.open({ view: "list" });
      return;
    case "clear":
      chat.clear();
      return;
    case "give":
      if (chat.open()) chat.give();
      return;
    case "forget":
      chat.forgetAll();
      return;
    default:
      say(command.text, true);
  }
}

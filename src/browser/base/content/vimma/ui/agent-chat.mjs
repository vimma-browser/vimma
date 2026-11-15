/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's chat window (docs/specs/builtin-agent.md B1, B9, B16, B19, Behaviour
// 6-7, 10-17, 27-28): a box in the side panel's slot, about 420 px wide, styled by
// side-panel.css. Top to bottom: the header (where data goes, where the agent works), the
// transcript (core agent-chat.mjs, from the loop's and the gate's events), the prompt slot (an
// AgentPrompt that only host/agent-ui.mjs fills, with a question of the gate) and the input.
// Every value is set as text (security.md C1): no Markdown, HTML, image or link the model wrote
// becomes anything but characters; agent-chat-view.mjs builds and draws the box from this
// window's state, through its one text-only `el`, agent-chat-key.mjs holds the API key entry and
// its masked field (M46), and agent-chat-models.mjs the model setup (the models view, a pick,
// setup's providers and agent CLIs). Keys reach it from VimmaHost's capture listener while focus
// is inside it; they are fixed, as a picker's are, because the window's key in the keymap comes
// in its own pull request (B13). The host that builds it hands it the agent's services (the
// conversations, the agent CLIs, the API keys, config.toml's refusal, setup's write to it and
// the [agent] providers): ui/ sits below agent/, config/ and host/, and reaches none of them
// (ADR-026).

import { chatKey, needsKey, noModelNotice, noticeTarget, sendNotice } from "../core/agent-chat.mjs";
import { lastUseText } from "../core/agent-store.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import { AgentPrompt } from "./agent-prompt.mjs";
import { giveFocusBack, rememberFocus } from "./side-panel.mjs";
import {
  CHAT_SLOT_ID,
  build as buildView,
  refused,
  render as renderView,
} from "./agent-chat-view.mjs";
import { askKey, cancelKey, clearKey, deleteKey, storeKey } from "./agent-chat-key.mjs";
import {
  addProvider,
  askCliModel,
  askOtherModel,
  defaultProvider,
  findClis,
  loadModels,
  pick,
  remember,
  usePicked,
  useProvider,
} from "./agent-chat-models.mjs";

export { CHAT_ID, CHAT_INPUT_ID, CHAT_LOG_ID, CHAT_SLOT_ID } from "./agent-chat-view.mjs";

const lazy = /** @type {Lazy<"PrivateBrowsingUtils">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/** Where a message that was not sent is when its conversation was deleted meanwhile. */
const DROPPED = "its conversation was deleted, and the message with it";

/**
 * @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig
 * @typedef {import("../core/config.mjs").AgentConfig} AgentConfig
 * @typedef {import("../core/config.mjs").ConfigError} ConfigError
 * @typedef {import("../core/agent-chat.mjs").BudgetStatus} BudgetStatus
 * @typedef {import("../core/agent-chat.mjs").Transcript} Transcript
 * @typedef {import("../core/agent-setup.mjs").LocalServer} LocalServer
 * @typedef {import("../core/agent-setup.mjs").ModelState} ModelState
 * @typedef {import("../core/agent-setup.mjs").Placement} Placement
 */

/**
 * What the window reads of a conversation (agent/AgentChat.sys.mjs's view of one).
 * @typedef {object} ChatConversation
 * @property {number} id
 * @property {string} conn  its gate connection, whose questions the slot shows
 * @property {string} title
 * @property {AgentProviderConfig} provider
 * @property {{ model: string, tools: string[] | null } | null} cli  what its agent CLI reported
 * @property {boolean} running
 * @property {boolean} granted
 * @property {boolean} asking
 * @property {BudgetStatus | null} budget
 * @property {number} used  its last use, ms since the epoch
 */

/**
 * The built-in agent's conversations, as far as the window drives them (AgentChat).
 * @typedef {object} ChatConversations
 * @property {boolean} restored  the stored conversations were read
 * @property {AgentProviderConfig | null} chosen  the model picked this session
 * @property {() => Promise<void>} restore
 * @property {() => ChatConversation[]} list
 * @property {(id: number) => ChatConversation} get
 * @property {(o: { provider: AgentProviderConfig }) => ChatConversation} create
 * @property {(listener: () => void) => void} addListener
 * @property {(listener: () => void) => void} removeListener
 * @property {(id: number, text: string, o: { ask: boolean }) =>
 *   Promise<{ started: true } | { steered: true } | { held: true }
 *   | { refused: string, pick?: true }>} send
 * @property {(id: number) => void} stop
 * @property {(id: number) => string | null} clear  why not, or null
 * @property {(id: number) => Promise<void>} delete
 * @property {() => Promise<void>} forgetAll
 * @property {(id: number) => Readonly<Transcript>} transcript
 * @property {(id: number, provider: AgentProviderConfig) => string | null} setProvider  why not
 * @property {(provider: AgentProviderConfig | null) => void} choose
 * @property {(id: number) => boolean} needsNotice  Behaviour 5's notice comes before a send
 * @property {(id: number, target: string) => void} confirm  the notice was answered y
 * @property {(o: { extra?: { server: string, endpoint: string }[] }) => Promise<LocalServer[]>}
 *   probe  the local model servers, only while the picker is open
 * @property {(providers: AgentProviderConfig[]) => Promise<Map<string, ModelState>>} modelStates
 * @property {(endpoint: string, model: string) => Promise<{ model: string }>} prepareLocal
 * @property {(endpoint: string, model: string) => Promise<Placement | null>} placeLocal
 */

/**
 * The agent CLIs, as far as setup and the picker offer them (agent/AgentCli.sys.mjs).
 * @typedef {object} ChatClis
 * @property {boolean} enabled  `vimma.agent.cli.enabled`
 * @property {() => Promise<{ cli: string, path: string, label: string, shim: string | null,
 *   problem: string | null }[]>} find  a search of PATH, only while setup asks
 * @property {() => string} noneFound  why setup lists none
 * @property {(cli: string, path: string) => void} use  the path setup picked, kept as a pref
 */

/**
 * The provider API keys, as far as the window asks for and shows them (agent/AgentKeys.sys.mjs):
 * a stored key's last four characters, a typed key stored, a key deleted. Never the key itself
 * (docs/security/12-agents-mcp-built-in-agent.md M46).
 * @typedef {object} ChatKeys
 * @property {(provider: string, endpoint: string) => Promise<string | null>} hint
 * @property {(provider: string, key: string, endpoint: string) => Promise<void>} set
 * @property {(provider: string) => Promise<boolean>} delete  whether there was a key
 */

/**
 * What the window uses of higher folders, handed over by the host that builds it, which reads
 * each one when the window calls (host/agent-chat-ops.mjs's CHAT_SERVICES).
 * @typedef {object} AgentChatServices
 * @property {ChatConversations} chat
 * @property {ChatClis} cli
 * @property {ChatKeys} keys
 * @property {() => { errors: readonly ConfigError[], file: string }} configRefused  the errors
 *   that kept config.toml from applying, and the file they are about (Behaviour 6)
 * @property {(provider: AgentProviderConfig, opts: { makeDefault: boolean }) =>
 *   Promise<{ name: string } | { error: string }>} addAgentProvider  setup's write of a
 *   provider to config.toml (B12)
 * @property {() => AgentConfig | null} agentConfig  `[agent]` in force, null before the read
 */

/**
 * @typedef {object} AgentChatHost
 * @property {(question: string, yes: () => void) => void} ask  a y/N on the prompt line
 * @property {(text: string, error?: boolean) => void} say  a notice
 * @property {(id: number) => void} give  `P`, `:agent give`: the selected tab to conversation id
 * @property {(text: string) => void} copy  to the clipboard
 * @property {() => void} rearm  focus came into the window: its slot's question arms again
 * @property {(o: { label: string, value?: string, placeholder?: string,
 *   submit: (text: string) => void }) => void} prompt  a line of text on the prompt line (a
 *   hosted provider's endpoint and model, an agent CLI's model)
 * @property {() => void} changed  the window opened, closed or switched conversation: the
 *   question may move between the line and the slot, and the status bar redraws
 * @typedef {{ label: string, detail: string, provider?: AgentProviderConfig,
 *   add?: "anthropic" | "openai" | "cli", cliPick?: { cli: string, path: string },
 *   local?: { endpoint: string, model: string, server: string }, id?: number,
 *   unavailable?: string, current?: boolean, otherModel?: AgentProviderConfig }} Row
 *   `unavailable`: why it cannot be picked; `otherModel`: the agent CLI provider whose model
 *   the row asks for by name
 */

export class AgentChatWindow {
  /**
   * @param {BrowserWindow} win @param {AgentChatHost} host
   * @param {AgentChatServices} services  the agent's, from the host
   */
  constructor(win, host, services) {
    this.win = win;
    this.host = host;
    this.services = services;
    /** @type {HTMLElement | null} */
    this.box = null;
    /** @type {HTMLElement[]} the header's two lines */
    this.head = [];
    /** @type {HTMLElement | null} */
    this.log = null;
    /** @type {HTMLElement | null} */
    this.slotBox = null;
    /** @type {HTMLTextAreaElement | null} */
    this.input = null;
    /** @type {HTMLElement | null} */
    this.hint = null;
    /** The question slot: shown and answered by host/agent-ui.mjs only (B19). */
    this.slot = new AgentPrompt(win, {
      id: CHAT_SLOT_ID,
      color: "var(--vimma-text-cyan)",
      parent: () => this.slotBox,
    });
    /** @type {number | null} the conversation shown */
    this.conversation = null;
    /** @type {"chat" | "models" | "list" | "key"} */
    this.view = "chat";
    /** @type {HTMLInputElement | null} the masked key field (Behaviour 3) */
    this.keyInput = null;
    /** @type {HTMLElement | null} */
    this.keyLabel = null;
    /** @type {AgentProviderConfig | null} the provider whose key the field asks for */
    this.keyFor = null;
    /** A key is being stored. */
    this.storing = false;
    /**
     * The `listed` count of a send waiting for its provider's key hint, else -1: a second Enter in
     * the same view finds its message still in the input, and is not sent again (issue #1010).
     */
    this.sendingAt = -1;
    /**
     * @type {Map<number, string>} the input of each conversation not shown: the text belongs to
     *   the conversation it was typed in, so that none of it is sent to another's provider
     *   (security.md M45, issue #1010)
     */
    this.drafts = new Map();
    /** @type {Row[]} the models or conversations listed */
    this.rows = [];
    /**
     * Which list the window shows, counted up each time it shows another: the model picker and
     * setup's agent CLI list are both the `models` view, and a probe, a search or a key hint
     * that answers late is drawn only into the list that asked for it (issue #1001).
     */
    this.listed = 0;
    /** The `listed` count of the model list last shown: a late key deletion reloads only it. */
    this.modelsAt = -1;
    /** Counted up by each pick: of picks that wait, only the latest is used (issue #1005). */
    this.picks = 0;
    /**
     * Counted up by each prompt line a picker row opens: it takes focus, so no pick still
     * waiting is used under it, nor moves focus to the key field (issue #1005).
     */
    this.prompted = 0;
    /** The `listed` count of a model list a key's deletion reloaded: its picks say why. */
    this.reloadedAt = -1;
    /** The conversation list's filter by title (Behaviour 19), lower case. */
    this.filter = "";
    this.row = 0;
    /** The entry selected in normal mode, for `y`; -1: none yet (the last). */
    this.entry = -1;
    /** `g` waiting for a second `g`. */
    this.pending = "";
    /** The transcript version last drawn, and whose. */
    this.drawn = -1;
    /** @type {number | null} */
    this.drawnId = null;
    this.opened = false;
    /** @type {import("./side-panel.mjs").Opener | null} */
    this.opener = null;
    this.onChange = () => this.render();
  }

  get isOpen() {
    return this.opened;
  }

  /** Whether focus is in the window: its keys are its own then. */
  get focused() {
    const active = this.win.document.activeElement;
    return this.opened && !!this.box && !!active && this.box.contains(active);
  }

  /** The transcript has focus: the window's normal mode, for the status bar. */
  get inNormal() {
    return this.opened && !!this.log && this.win.document.activeElement === this.log;
  }

  /** The open conversation's gate connection, whose questions the slot shows (Behaviour 27). */
  get conn() {
    if (!this.opened || this.conversation === null) return null;
    try {
      return this.services.chat.get(this.conversation).conn;
    } catch {
      return null;
    }
  }

  /**
   * Opens the window on the last conversation shown, else a new one with the default provider.
   * @param {{ conversation?: number, view?: "chat" | "models" | "list", then?: () => void,
   *   ifMoved?: () => void, focus?: boolean }} [opts]
   *   `then`: run once it is open, which waits for the stored conversations the first time;
   *   `ifMoved`: run instead of `then` when focus moved elsewhere during that wait, since the
   *   window then opens without taking focus; `focus`: false opens it so (that wait's own use)
   * @returns {boolean} whether it opened
   */
  open({ conversation, view = "chat", then, ifMoved, focus = true } = {}) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) {
      this.host.say("the built-in agent works in a normal window");
      return false;
    }
    if (!this.services.chat.restored) {
      // The stored conversations are read (and decrypted) only when the window first opens,
      // so a user who never opens it is never asked for the keyring (B15). The read can wait on
      // the keyring: a user who clicked into a page or a field meanwhile keeps their focus
      // (security.md M46), and what was to follow, which would take it, is not done. A keyring
      // prompt taking OS focus leaves activeElement as it was, so it counts as staying.
      const from = this.win.document.activeElement;
      this.services.chat.restore().then(() => {
        const stayed = this.win.document.activeElement === from || this.focused;
        this.open({ conversation, view, then, ifMoved, focus: stayed });
      });
      return true;
    }
    const known = new Set(this.services.chat.list().map((c) => c.id));
    if (conversation !== undefined) this.show(conversation);
    if (this.conversation === null || !known.has(this.conversation)) {
      const last = this.services.chat.list().at(-1);
      this.show(last ? last.id : this.create());
    }
    const box = this.box ?? buildView(this);
    if (!this.opened) {
      this.opener = rememberFocus(this.win);
      this.opened = true;
      this.services.chat.addListener(this.onChange);
    }
    box.hidden = false;
    this.clearKey();
    this.view = view;
    this.drawn = -1;
    this.render();
    if (view === "chat") this.toTranscript({ focus });
    else if (focus) /** @type {HTMLElement} */ (this.log).focus();
    if (view === "models") this.loadModels();
    if (view === "list") {
      this.filter = "";
      this.loadList();
    }
    this.host.changed();
    if (focus) then?.();
    else ifMoved?.();
    return true;
  }

  /**
   * Shows conversation `id`: the input keeps the text typed for the conversation it shows, and
   * the one left keeps its own, so a message typed for one provider is never sent to another's
   * (security.md M45). From no conversation (no model yet), what was typed stays.
   * @param {number | null} id
   */
  show(id) {
    if (id === this.conversation) return;
    const input = this.input;
    if (input && this.conversation !== null) {
      if (input.value) this.drafts.set(this.conversation, input.value);
      else this.drafts.delete(this.conversation);
      input.value = "";
    }
    this.conversation = id;
    if (input && id !== null && this.drafts.has(id)) {
      this.putBack(input, /** @type {string} */ (this.drafts.get(id)));
      this.drafts.delete(id);
    }
  }

  /**
   * Text that was not sent goes back in the input, before anything typed there since.
   * @param {HTMLTextAreaElement} input @param {string} text
   * @returns {boolean} whether the input was empty
   */
  putBack(input, text) {
    if (!input.value) {
      input.value = text;
      return true;
    }
    // "preserve" keeps the caret and selection where the user had them.
    input.setRangeText(`${text}\n`, 0, 0, "preserve");
    return false;
  }

  /**
   * A message of conversation `id` that was not sent: back in its input, the shown one or the
   * one kept for its conversation, never over what the user typed since (issue #1010).
   * @param {number} id @param {string} text
   * @returns {{ where: string, plain: boolean }} the notice's words for where it is; `plain`: in
   *   the input shown, which was empty
   */
  keepUnsent(id, text) {
    const input = /** @type {HTMLTextAreaElement} */ (this.input);
    if (id === this.conversation) {
      if (input.value === text) return { where: "the message is still in the input", plain: true };
      return this.putBack(input, text)
        ? { where: "the message is still in the input", plain: true }
        : { where: "the message is back in the input, before what was typed since", plain: false };
    }
    const kept = this.keptIn(id);
    if (!kept) return { where: DROPPED, plain: false };
    const draft = this.drafts.get(id);
    this.drafts.set(id, draft ? `${text}\n${draft}` : text);
    return { where: kept, plain: false };
  }

  /**
   * The notice's words for where a message of conversation `id`, not the one shown, is kept.
   * @param {number} id
   * @returns {string | null} null once that conversation was deleted
   */
  keptIn(id) {
    const c = this.services.chat.list().find((x) => x.id === id);
    return c ? `the message is kept in the input of "${c.title || "New conversation"}"` : null;
  }

  /** A new conversation with the default provider, or null when none is set up. */
  create() {
    const provider = defaultProvider(this.services);
    if (!provider) return null;
    return this.services.chat.create({ provider }).id;
  }

  close() {
    this.clearKey();
    this.listed++;
    if (!this.opened) return;
    this.opened = false;
    this.services.chat.removeListener(this.onChange);
    const box = /** @type {HTMLElement} */ (this.box);
    giveFocusBack(this.win, box, this.opener);
    this.opener = null;
    box.hidden = true;
    this.host.changed();
  }

  destroy() {
    this.close();
    this.slot.destroy();
    this.box?.remove();
    this.box = null;
  }

  /** The input, in insert mode. */
  insert() {
    this.toTranscript({ focus: true });
  }

  /**
   * The transcript and its input, with focus in the input only if `focus`.
   * @param {{ focus: boolean }} opts
   */
  toTranscript({ focus }) {
    // Every way out of the key field empties it (security.md M46), a late pick's included.
    this.clearKey();
    this.view = "chat";
    this.listed++;
    // Drawn first: the input is hidden in the other views, and a hidden field takes no focus.
    this.render();
    if (focus) this.input?.focus();
  }

  /** Normal mode: the transcript has focus. */
  normal() {
    this.log?.focus();
    this.render();
  }

  /** No model to act with: the setup hint, or the error that kept config.toml from applying. */
  sayNoModel() {
    const why = refused(this.services);
    this.host.say(noModelNotice(why), why !== null);
  }

  /** `n`, `:agent new`: a new conversation, with the default provider and no grant (B5). */
  newConversation() {
    const id = this.create();
    if (id === null) {
      this.sayNoModel();
      return;
    }
    this.open({ conversation: id });
  }

  /** `s`, `:agent stop` (Behaviour 16). */
  stop() {
    if (this.conversation === null) return;
    this.services.chat.stop(this.conversation);
  }

  /** `C`, `:agent clear` (Behaviour 22). */
  clear() {
    if (this.conversation === null) return;
    const refused = this.services.chat.clear(this.conversation);
    if (refused) this.host.say(`agent: ${refused}`);
  }

  /**
   * `:agent forget all` (Behaviour 23): after a y, running tasks stop and every conversation
   * goes, with every file of the store.
   */
  async forgetAll() {
    // The first read can wait on the keyring: a user who moved meanwhile is not handed a y/N
    // that takes their focus, where a typed y would delete everything (security.md M46).
    const from = this.win.document.activeElement;
    await this.services.chat.restore();
    if (this.win.document.activeElement !== from && !this.focused) {
      this.host.say("agent: not deleted: focus moved while the conversations were read");
      return;
    }
    const n = this.services.chat.list().length;
    if (!n) {
      this.host.say("agent: there are no conversations");
      return;
    }
    this.host.ask(`Delete all ${n} agent conversation${n === 1 ? "" : "s"}? y/N`, () => {
      this.conversation = null;
      this.drafts.clear();
      if (this.input) this.input.value = "";
      if (this.opened) this.close();
      this.services.chat.forgetAll().then(
        () => this.host.say(`agent: deleted ${n} conversation${n === 1 ? "" : "s"}`),
        (/** @type {any} */ e) => {
          console.error("vimma agent: forget all failed", e?.name);
          this.host.say("agent: some conversation files could not be deleted", true);
        },
      );
    });
  }

  /** `P`, `:agent give` (Behaviour 17). */
  give() {
    if (this.conversation === null) {
      this.sayNoModel();
      return;
    }
    this.host.give(this.conversation);
  }

  /**
   * A keydown while focus is in the window and no key sequence is under way. Plain keys and
   * the window's own chords are its; other chords (ctrl+b) go on to the keymap.
   * @param {KeyboardEvent} e
   * @returns {boolean} whether the key was the window's
   */
  onKey(e) {
    if (!this.focused) return false;
    const chord = chordFromEvent(e);
    if (!chord) return false;
    const key = formatKey(chord);
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
    if (this.view === "key") {
      // Typing goes to the masked field; only Enter and Esc are the window's.
      if (key === "enter") {
        consume();
        this.storeKey();
        return true;
      }
      if (key === "esc") {
        consume();
        this.cancelKey();
        return true;
      }
      return false;
    }
    if (this.view !== "chat") {
      if (chord.ctrl || chord.alt || chord.meta) return false;
      consume();
      this.listKey(key);
      return true;
    }
    if (this.win.document.activeElement === this.input) {
      // The input is read-only while a question waits in the slot (Behaviour 27): nothing
      // typed for the model is sent then, and the question takes its own keys first.
      if (key === "enter" || key === "ctrl+enter") {
        consume();
        if (!this.slot.isOpen) this.submit({ ask: key === "ctrl+enter" });
        return true;
      }
      if (key === "esc") {
        consume();
        this.normal();
        return true;
      }
      return false;
    }
    if (chord.alt || chord.meta) return false;
    if (chord.ctrl && key !== "ctrl+d" && key !== "ctrl+u") return false;
    consume();
    const r = chatKey(this.pending, key);
    this.pending = r.kind === "pending" ? r.pending : "";
    if (r.kind === "do") this.normalAction(r.what);
    return true;
  }

  /** @param {string} what */
  normalAction(what) {
    const log = /** @type {HTMLElement} */ (this.log);
    const entries = log.querySelectorAll(".vimma-agent-chat-entry");
    const last = entries.length - 1;
    const select = (/** @type {number} */ i) => {
      this.entry = Math.max(0, Math.min(last, i));
      this.render();
      entries[this.entry]?.scrollIntoView({ block: "nearest" });
    };
    const at = this.entry < 0 ? last : this.entry;
    switch (what) {
      case "down":
        return select(at + 1);
      case "up":
        return select(at - 1);
      case "half-down":
        log.scrollBy(0, log.clientHeight / 2);
        return undefined;
      case "half-up":
        log.scrollBy(0, -log.clientHeight / 2);
        return undefined;
      case "top":
        return select(0);
      case "bottom":
        return select(last);
      case "insert":
        return this.insert();
      case "stop":
        return this.stop();
      case "model":
        return this.open({ view: "models" });
      case "new":
        return this.newConversation();
      case "list":
        return this.open({ view: "list" });
      case "clear":
        return this.clear();
      case "give":
        return this.give();
      case "yank": {
        const text = entries[at]?.getAttribute("data-text") ?? "";
        if (text) {
          this.host.copy(text);
          this.host.say("agent: copied the entry");
        }
        return undefined;
      }
      case "close":
        return this.close();
      default:
        return undefined;
    }
  }

  /**
   * Enter or ctrl+Enter in the input (Behaviour 14-15, 24-25): the text goes to the open
   * conversation, after Behaviour 5's notice for a provider off this machine.
   * @param {{ ask: boolean }} opts
   */
  submit({ ask }) {
    const input = /** @type {HTMLTextAreaElement} */ (this.input);
    const text = input.value;
    if (!text.trim()) return;
    const id = this.conversation;
    if (id === null) {
      this.sayNoModel();
      return;
    }
    if (this.sendingAt === this.listed) {
      // Its message is still in the input, waiting for the key hint: sent once, not twice.
      this.host.say("agent: the message is already being sent; its key is still being read");
      return;
    }
    const go = () => {
      // Emptied at once, so a second Enter while the send settles sends nothing twice.
      input.value = "";
      // A refusal can come a second later (a local server is asked first): a user who left the
      // transcript meanwhile (a list, the key field) is not pulled into the picker (#1005).
      const sentAt = this.listed;
      this.services.chat.send(id, text, { ask }).then(
        (r) => {
          if ("refused" in r) {
            const { where, plain } = this.keepUnsent(id, text);
            // The model is not there: another is picked, and the message waits for it.
            const stayed = this.focused && this.conversation === id && this.listed === sentAt;
            if (r.pick && stayed) this.open({ view: "models" });
            const kept = (r.pick && !stayed) || !plain ? `; ${where}` : "";
            this.host.say(`agent: ${r.refused}${kept}`, true);
          }
        },
        (/** @type {any} */ e) => {
          console.error("vimma agent: send failed", e);
          const { where, plain } = this.keepUnsent(id, text);
          this.host.say(`agent: ${e?.message ?? e}${plain ? "" : `; ${where}`}`, true);
        },
      );
    };
    const chosen = this.services.chat.get(id).provider;
    if (needsKey(chosen)) {
      // A hosted provider without a key for its endpoint: the key first, and the task stays in
      // the input to be sent once it is stored (Behaviour 3).
      const shownAt = this.listed;
      this.sendingAt = shownAt;
      // The hint can wait on the keyring. A user who left the transcript meanwhile (another
      // list, the key field, another conversation, the window closed) gets neither the key
      // field nor Behaviour 5's notice over what they went to, and nothing is sent: the
      // message stays in its conversation's input, to be sent with Enter again (issue #1005).
      const left = () => {
        if (this.sendingAt === shownAt) this.sendingAt = -1;
        if (this.listed === shownAt && this.focused) return false;
        const where =
          this.conversation === id
            ? "the message is still in the input"
            : (this.keptIn(id) ?? DROPPED);
        this.host.say(`agent: not sent: the chat was left before its key was read; ${where}`);
        return true;
      };
      this.services.keys.hint(chosen.name, chosen.endpoint).then(
        (/** @type {string | null} */ hint) => {
          if (left()) return;
          if (hint === null) this.askKey(chosen);
          else if (input.value !== text) {
            // The input stays editable while the hint waits: what is sent is what the user has
            // now, never the text of the first Enter over an edit (a password taken out).
            this.host.say(
              "agent: not sent: the message was changed while its key was read; it is still in the input",
            );
          } else this.afterKey(id, go);
        },
        (/** @type {any} */ e) => {
          console.error("vimma agent: the key could not be read", e?.name);
          if (!left()) this.askKey(chosen);
        },
      );
      return;
    }
    this.afterKey(id, go);
  }

  /**
   * The rest of a send once its provider has the key it needs: Behaviour 5's notice, then go.
   * @param {number} id @param {() => void} go
   */
  afterKey(id, go) {
    if (this.services.chat.needsNotice(id)) {
      const provider = this.services.chat.get(id).provider;
      this.host.ask(sendNotice(provider), () => {
        this.services.chat.confirm(id, noticeTarget(provider));
        go();
      });
      return;
    }
    go();
  }

  /** @param {string} key */
  listKey(key) {
    if (key === "j" || key === "down") this.row = Math.min(this.rows.length - 1, this.row + 1);
    else if (key === "k" || key === "up") this.row = Math.max(0, this.row - 1);
    else if (key === "esc" || key === "q") {
      this.insert();
      return;
    } else if (key === "enter") {
      this.pick();
      return;
    } else if (this.view === "list" && key === "n") {
      this.newConversation();
      return;
    } else if (this.view === "list" && key === "d") {
      this.deleteRow();
      return;
    } else if (this.view === "list" && key === "/") {
      this.host.prompt({
        label: "filter: ",
        value: this.filter,
        submit: (text) => {
          this.filter = text.trim().toLowerCase();
          this.loadList();
          this.log?.focus();
        },
      });
      return;
    } else if (this.view === "models" && key === "x") {
      this.deleteKey();
      return;
    } else if (this.view === "models" && (key === "D" || key === "shift+d")) {
      this.pick({ makeDefault: true });
      return;
    }
    this.render();
  }

  /** See agent-chat-models.mjs. */
  loadModels() {
    loadModels(this);
  }

  /**
   * The conversations view (Behaviour 19): the stored ones and those of this session, newest
   * first, by title, provider, model and last use, filtered by title after `/`.
   */
  loadList() {
    this.listed++;
    const now = Date.now();
    this.rows = this.services.chat
      .list()
      .filter((c) => (c.title || "New conversation").toLowerCase().includes(this.filter))
      .sort((a, b) => b.used - a.used || b.id - a.id)
      .map((c) => ({
        label: `${c.running ? "▶ " : ""}${c.title || "New conversation"}`,
        detail: `${c.provider.name} · ${c.provider.model || c.provider.cli} · ${lastUseText(c.used, now)}`,
        id: c.id,
      }));
    this.row = Math.max(
      0,
      this.rows.findIndex((r) => r.id === this.conversation),
    );
    this.render();
  }

  /**
   * See agent-chat-models.mjs.
   * @param {{ makeDefault?: boolean }} [opts]
   */
  pick(opts) {
    return pick(this, opts);
  }

  /**
   * See agent-chat-models.mjs.
   * @param {string} cli @param {string} path @param {{ makeDefault: boolean }} opts
   * @param {string} [value]
   */
  askCliModel(cli, path, opts, value) {
    askCliModel(this, cli, path, opts, value);
  }

  /**
   * See agent-chat-models.mjs.
   * @param {AgentProviderConfig} base @param {{ makeDefault: boolean }} opts
   * @param {string} [value]
   */
  askOtherModel(base, opts, value) {
    askOtherModel(this, base, opts, value);
  }

  /**
   * See agent-chat-models.mjs.
   * @param {AgentProviderConfig} picked
   * @param {{ makeDefault: boolean, addedCli?: boolean }} opts
   */
  usePicked(picked, opts) {
    usePicked(this, picked, opts);
  }

  /** See agent-chat-models.mjs. */
  findClis() {
    findClis(this);
  }

  /**
   * See agent-chat-models.mjs.
   * @param {AgentProviderConfig} provider @param {{ makeDefault?: boolean }} [opts]
   */
  remember(provider, opts) {
    return remember(this, provider, opts);
  }

  /**
   * See agent-chat-models.mjs.
   * @param {AgentProviderConfig} provider
   */
  useProvider(provider) {
    return useProvider(this, provider);
  }

  /**
   * See agent-chat-models.mjs.
   * @param {"anthropic" | "openai"} kind
   */
  addProvider(kind) {
    addProvider(this, kind);
  }

  /**
   * The masked key field for `provider` (Behaviour 3); agent-chat-key.mjs.
   * @param {AgentProviderConfig} provider
   */
  askKey(provider) {
    askKey(this, provider);
  }

  /** See agent-chat-key.mjs. */
  cancelKey() {
    cancelKey(this);
  }

  /** See agent-chat-key.mjs. */
  clearKey() {
    clearKey(this);
  }

  /** See agent-chat-key.mjs. */
  storeKey() {
    return storeKey(this);
  }

  /** See agent-chat-key.mjs. */
  deleteKey() {
    deleteKey(this);
  }

  deleteRow() {
    const row = this.rows[this.row];
    if (row?.id === undefined) return;
    const id = row.id;
    this.host.ask(`Delete "${row.label}"? y/N`, () => {
      this.services.chat.delete(id);
      this.drafts.delete(id);
      // Its unsent text goes with it: the input shows no other conversation's.
      if (this.conversation === id) {
        this.conversation = null;
        if (this.input) this.input.value = "";
      }
      this.loadList();
    });
  }

  /** The prompt slot opened or closed: the input is read-only while it shows (Behaviour 27). */
  slotChanged() {
    if (!this.input) return;
    this.input.readOnly = this.slot.isOpen;
    this.render();
  }

  render() {
    renderView(this);
  }
}

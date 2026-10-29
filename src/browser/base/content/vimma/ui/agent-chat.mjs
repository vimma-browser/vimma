/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's chat window (docs/specs/builtin-agent.md B1, B9, B16, B19, Behaviour
// 6-7, 10-17, 27-28): a box in the side panel's slot, about 420 px wide, styled by
// side-panel.css. Top to bottom: the header (where data goes, where the agent works), the
// transcript (core agent-chat.mjs, from the loop's and the gate's events), the prompt slot (an
// AgentPrompt that only host/agent-ui.mjs fills, with a question of the gate) and the input.
// Every value is set as text (security.md C1): no Markdown, HTML, image or link the model wrote
// becomes anything but characters. Keys reach it from VimmaHost's capture listener while focus
// is inside it; they are fixed, as a picker's are, because the window's key in the keymap comes
// in its own pull request (B13).

import {
  USER_LABEL,
  chatHeader,
  chatKey,
  entryView,
  externalNotice,
  isLocalEndpoint,
  whereDataGoes,
} from "../core/agent-chat.mjs";
import { checkEndpoint } from "../core/agent-providers.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import { AgentPrompt } from "./agent-prompt.mjs";
import { buildPanelBox, giveFocusBack, rememberFocus } from "./side-panel.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  // Lazily: AgentChat reaches VimmaHost through the agent commands, and VimmaHost builds this.
  AgentChat: "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
  AgentKeys: "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
  McpHost: "chrome://browser/content/vimma/host/mcp-ops.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export const CHAT_ID = "vimma-agent-chat";
export const CHAT_INPUT_ID = "vimma-agent-chat-input";
export const CHAT_LOG_ID = "vimma-agent-chat-log";
export const CHAT_SLOT_ID = "vimma-agent-chat-slot";
export const CHAT_KEY_ID = "vimma-agent-chat-key";
/** Anthropic's API, which setup's "add: Anthropic" uses (Behaviour 3). */
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const KEY_HINT = "Enter stores it, encrypted, in login storage · Esc cancels";

/**
 * Whether a provider's requests need an API key: Anthropic's always; an OpenAI-compatible
 * endpoint off this machine (a local server takes none).
 * @param {{ kind: string, endpoint: string }} p
 */
const needsKey = (p) => p.kind === "anthropic" || !isLocalEndpoint(p.endpoint);
const HTML_NS = "http://www.w3.org/1999/xhtml";

const INSERT_HINT = "Enter sends · ctrl+Enter asks every step · shift+Enter new line · Esc";
const NORMAL_HINT =
  "i write · j k move · s stop · m model · n new · c list · P give · y copy · q close";
const LIST_HINT = "j k move · Enter open · d delete · n new · Esc back";
const MODELS_HINT = "j k move · Enter use · x delete its key · Esc back";
const SLOT_HINT = "a question waits: answer it here";

/**
 * @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig
 * @typedef {object} AgentChatHost
 * @property {(question: string, yes: () => void) => void} ask  a y/N on the prompt line
 * @property {(text: string, error?: boolean) => void} say  a notice
 * @property {(id: number) => void} give  `P`, `:agent give`: the selected tab to conversation id
 * @property {(text: string) => void} copy  to the clipboard
 * @property {() => void} rearm  focus came into the window: its slot's question arms again
 * @property {(o: { label: string, value?: string, submit: (text: string) => void }) => void}
 *   prompt  a line of text on the prompt line (a hosted provider's endpoint and model)
 * @property {() => void} changed  the window opened, closed or switched conversation: the
 *   question may move between the line and the slot, and the status bar redraws
 * @typedef {{ label: string, detail: string, provider?: AgentProviderConfig,
 *   add?: "anthropic" | "openai",
 *   local?: { endpoint: string, model: string, server: string }, id?: number }} Row
 */

/** @param {Document} doc @param {string} tag @param {string} className @param {string} [text] */
const el = (doc, tag, className, text = "") => {
  const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
  node.className = className;
  node.textContent = text;
  return node;
};

/** The provider `[agent] default` names, else the first configured, else none (setup). */
function defaultProvider() {
  const config = lazy.McpHost.agentConfig;
  const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []);
  return providers.find((p) => p.name === config?.default) ?? providers[0] ?? null;
}

export class AgentChatWindow {
  /** @param {Window} win @param {AgentChatHost} host */
  constructor(win, host) {
    this.win = win;
    this.host = host;
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
    /** @type {Row[]} the models or conversations listed */
    this.rows = [];
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
      return lazy.AgentChat.get(this.conversation).conn;
    } catch {
      return null;
    }
  }

  /**
   * Opens the window on the last conversation shown, else a new one with the default provider.
   * @param {{ conversation?: number, view?: "chat" | "models" | "list" }} [opts]
   * @returns {boolean} whether it opened
   */
  open({ conversation, view = "chat" } = {}) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) {
      this.host.say("the built-in agent works in a normal window");
      return false;
    }
    const known = new Set(lazy.AgentChat.list().map((/** @type {any} */ c) => c.id));
    if (conversation !== undefined) this.conversation = conversation;
    if (this.conversation === null || !known.has(this.conversation)) {
      const last = lazy.AgentChat.list().at(-1);
      this.conversation = last ? last.id : this.create();
    }
    const box = this.box ?? this.build();
    if (!this.opened) {
      this.opener = rememberFocus(this.win);
      this.opened = true;
      lazy.AgentChat.addListener(this.onChange);
    }
    box.hidden = false;
    this.view = view;
    this.drawn = -1;
    this.render();
    if (view === "chat") this.insert();
    else /** @type {HTMLElement} */ (this.log).focus();
    if (view === "models") this.loadModels();
    if (view === "list") this.loadList();
    this.host.changed();
    return true;
  }

  /** A new conversation with the default provider, or null when none is set up. */
  create() {
    const provider = defaultProvider();
    if (!provider) return null;
    return lazy.AgentChat.create({ provider }).id;
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    lazy.AgentChat.removeListener(this.onChange);
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
    this.view = "chat";
    // Drawn first: the input is hidden in the other views, and a hidden field takes no focus.
    this.render();
    this.input?.focus();
  }

  /** Normal mode: the transcript has focus. */
  normal() {
    this.log?.focus();
    this.render();
  }

  /** `n`, `:agent new`: a new conversation, with the default provider and no grant (B5). */
  newConversation() {
    const id = this.create();
    if (id === null) {
      this.host.say("agent: no model is set up; add one under [agent] in config.toml");
      return;
    }
    this.open({ conversation: id });
  }

  /** `s`, `:agent stop` (Behaviour 16). */
  stop() {
    if (this.conversation === null) return;
    lazy.AgentChat.stop(this.conversation);
  }

  /** `C`, `:agent clear` (Behaviour 22). */
  clear() {
    if (this.conversation === null) return;
    const refused = lazy.AgentChat.clear(this.conversation);
    if (refused) this.host.say(`agent: ${refused}`);
  }

  /** `:agent forget all` (Behaviour 23): after a y, every conversation goes. */
  forgetAll() {
    const n = lazy.AgentChat.list().length;
    if (!n) {
      this.host.say("agent: there are no conversations");
      return;
    }
    this.host.ask(`Delete all ${n} agent conversation${n === 1 ? "" : "s"}? y/N`, () => {
      lazy.AgentChat.stopAll();
      for (const c of lazy.AgentChat.list()) lazy.AgentChat.delete(c.id);
      this.conversation = null;
      if (this.opened) this.close();
      this.host.say(`agent: deleted ${n} conversation${n === 1 ? "" : "s"}`);
    });
  }

  /** `P`, `:agent give` (Behaviour 17). */
  give() {
    if (this.conversation === null) {
      this.host.say("agent: no model is set up; add one under [agent] in config.toml");
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
      this.host.say("agent: no model is set up; add one under [agent] in config.toml");
      return;
    }
    const go = () => {
      // Emptied at once, so a second Enter while the send settles sends nothing twice.
      input.value = "";
      lazy.AgentChat.send(id, text, { ask }).then(
        (/** @type {any} */ r) => {
          if ("refused" in r) {
            if (!input.value) input.value = text;
            this.host.say(`agent: ${r.refused}`, true);
          }
        },
        (/** @type {any} */ e) => {
          console.error("vimma agent: send failed", e);
          if (!input.value) input.value = text;
          this.host.say(`agent: ${e?.message ?? e}`, true);
        },
      );
    };
    const chosen = lazy.AgentChat.get(id).provider;
    if (needsKey(chosen)) {
      // A hosted provider without a key for its endpoint: the key first, and the task stays in
      // the input to be sent once it is stored (Behaviour 3).
      lazy.AgentKeys.hint(chosen.name, chosen.endpoint).then(
        (/** @type {string | null} */ hint) => {
          if (hint === null) this.askKey(chosen);
          else this.afterKey(id, go);
        },
        (/** @type {any} */ e) => {
          console.error("vimma agent: the key could not be read", e);
          this.askKey(chosen);
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
    if (lazy.AgentChat.needsNotice(id)) {
      const provider = lazy.AgentChat.get(id).provider;
      this.host.ask(externalNotice(provider), () => {
        lazy.AgentChat.confirm(id, provider.endpoint);
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
    } else if (this.view === "models" && key === "x") {
      this.deleteKey();
      return;
    }
    this.render();
  }

  /** The models view (Behaviour 7): the configured providers, then what local servers report. */
  loadModels() {
    const config = lazy.McpHost.agentConfig;
    /** @type {Row[]} */
    const rows = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []).map((p) => ({
      label: `${p.name} · ${p.model}`,
      detail: whereDataGoes(p.endpoint),
      provider: p,
    }));
    // Setup's hosted providers (Behaviour 3): before the probe's rows, which come later.
    rows.push(
      { label: "add: Anthropic (Messages API)", detail: "api key", add: "anthropic" },
      { label: "add: OpenAI-compatible endpoint", detail: "https:// and api key", add: "openai" },
    );
    this.rows = rows;
    for (const row of rows) {
      const p = row.provider;
      if (!p || !needsKey(p)) continue;
      lazy.AgentKeys.hint(p.name, p.endpoint).then(
        (/** @type {string | null} */ hint) => {
          row.detail = hint ?? "no key · Enter adds one";
          if (this.view === "models") this.render();
        },
        () => {},
      );
    }
    this.row = 0;
    this.render();
    // Asked only now, while the picker is open, and only on 127.0.0.1 (Behaviour 2, B12).
    lazy.AgentChat.probe().then(
      (/** @type {any[]} */ found) => {
        if (!this.opened || this.view !== "models") return;
        for (const s of found) {
          for (const model of s.models) {
            this.rows.push({
              label: `${s.server} · ${model}`,
              detail: whereDataGoes(s.endpoint),
              local: { endpoint: s.endpoint, model, server: s.server },
            });
          }
        }
        this.render();
      },
      (/** @type {any} */ e) => console.error("vimma agent: probe failed", e),
    );
  }

  /** The conversations view (Behaviour 19), newest first, in memory. */
  loadList() {
    this.rows = lazy.AgentChat.list()
      .slice()
      .reverse()
      .map((/** @type {any} */ c) => ({
        label: `${c.running ? "▶ " : ""}${c.title || "New conversation"}`,
        detail: `${c.provider.name} · ${c.provider.model}`,
        id: c.id,
      }));
    this.row = Math.max(
      0,
      this.rows.findIndex((r) => r.id === this.conversation),
    );
    this.render();
  }

  async pick() {
    const row = this.rows[this.row];
    if (!row) return;
    if (this.view === "list" && row.id !== undefined) {
      this.open({ conversation: row.id });
      return;
    }
    if (row.add) {
      this.addProvider(row.add);
      return;
    }
    let provider = row.provider;
    if (
      provider &&
      needsKey(provider) &&
      (await lazy.AgentKeys.hint(provider.name, provider.endpoint)) === null
    ) {
      this.askKey(provider);
      return;
    }
    if (row.local) {
      this.host.say(`agent: preparing ${row.local.model}…`);
      try {
        const model = await lazy.AgentChat.prepareLocal(row.local.endpoint, row.local.model);
        provider = {
          name: row.local.server,
          kind: "openai",
          endpoint: row.local.endpoint,
          model: model.model,
          vision: false,
        };
      } catch (e) {
        this.host.say(`agent: ${/** @type {any} */ (e)?.message ?? e}`, true);
        return;
      }
    }
    if (!provider) return;
    this.useProvider(provider);
    this.insert();
  }

  /** @param {AgentProviderConfig} provider */
  useProvider(provider) {
    if (this.conversation === null) {
      this.conversation = lazy.AgentChat.create({ provider }).id;
      return;
    }
    if (
      lazy.AgentChat.get(this.conversation).provider.endpoint === provider.endpoint &&
      lazy.AgentChat.get(this.conversation).provider.model === provider.model &&
      lazy.AgentChat.get(this.conversation).provider.name === provider.name
    ) {
      return;
    }
    const refused = lazy.AgentChat.setProvider(this.conversation, provider);
    if (refused) this.host.say(`agent: ${refused}`, true);
  }

  /**
   * Setup's hosted provider (Behaviour 3): Anthropic's API, or an OpenAI-compatible endpoint,
   * which must be https:// off this machine; then its model on the prompt line, then its key in
   * the window's masked field. The provider lasts the session; config.toml keeps one for good.
   * @param {"anthropic" | "openai"} kind
   */
  addProvider(kind) {
    const localOnly = !!lazy.McpHost.agentConfig?.localOnly;
    /** @param {string} endpoint */
    const askModel = (endpoint) =>
      this.host.prompt({
        label: "agent model: ",
        value: kind === "anthropic" ? ANTHROPIC_MODEL : "",
        submit: (model) => {
          const name = kind === "anthropic" ? "anthropic" : new URL(endpoint).hostname;
          if (!model.trim()) return this.host.say("agent: a model name is needed", true);
          return this.askKey({
            name,
            kind,
            endpoint,
            model: model.trim(),
            vision: kind === "anthropic",
          });
        },
      });
    if (kind === "anthropic") {
      const refused = checkEndpoint(ANTHROPIC_ENDPOINT, { localOnly });
      if (refused) return this.host.say(`agent: ${refused}`, true);
      return askModel(ANTHROPIC_ENDPOINT);
    }
    return this.host.prompt({
      label: "agent endpoint (https://…/v1): ",
      submit: (text) => {
        const endpoint = text.trim().replace(/\/+$/, "");
        const refused = checkEndpoint(endpoint, { localOnly });
        if (refused) return this.host.say(`agent: ${refused}`, true);
        return askModel(endpoint);
      },
    });
  }

  /**
   * The masked key field for `provider` (Behaviour 3): what is typed there goes only to login
   * storage, encrypted with OSKeyStore (B8), and is never drawn, logged or kept by the window.
   * @param {AgentProviderConfig} provider
   */
  askKey(provider) {
    if (!this.opened) this.open();
    this.keyFor = provider;
    this.view = "key";
    this.render();
    /** @type {HTMLInputElement} */ (this.keyInput).focus();
  }

  cancelKey() {
    const field = /** @type {HTMLInputElement} */ (this.keyInput);
    field.value = "";
    this.keyFor = null;
    this.insert();
  }

  async storeKey() {
    const field = /** @type {HTMLInputElement} */ (this.keyInput);
    const provider = this.keyFor;
    // Out of the field at once: it holds the key only while it is typed.
    const key = field.value.trim();
    field.value = "";
    if (!provider) return this.insert();
    if (!key) {
      this.host.say(`agent: ${provider.name} needs an API key`, true);
      return undefined;
    }
    try {
      await lazy.AgentKeys.set(provider.name, key, provider.endpoint);
      const hint = await lazy.AgentKeys.hint(provider.name, provider.endpoint);
      this.host.say(`agent: ${provider.name}: ${hint ?? "key stored"}`);
    } catch (e) {
      // The error's text is not shown: it could carry what was typed.
      console.error("vimma agent: the key could not be stored", /** @type {any} */ (e)?.name);
      this.host.say(`agent: the key for ${provider.name} could not be stored`, true);
      return undefined;
    }
    this.keyFor = null;
    this.useProvider(provider);
    this.insert();
    return undefined;
  }

  /** `x` on a provider in the picker: its stored key goes, after a y (Behaviour 3). */
  deleteKey() {
    const p = this.rows[this.row]?.provider;
    if (!p) return;
    this.host.ask(`Delete the API key of ${p.name}? y/N`, () => {
      lazy.AgentKeys.delete(p.name).then(
        (/** @type {boolean} */ had) => {
          this.host.say(
            had ? `agent: deleted the key of ${p.name}` : `agent: ${p.name} has no key`,
          );
          if (this.opened && this.view === "models") this.loadModels();
        },
        (/** @type {any} */ e) => console.error("vimma agent: deleting the key failed", e?.name),
      );
    });
  }

  deleteRow() {
    const row = this.rows[this.row];
    if (row?.id === undefined) return;
    const id = row.id;
    this.host.ask(`Delete "${row.label}"? y/N`, () => {
      lazy.AgentChat.delete(id);
      if (this.conversation === id) this.conversation = null;
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
    if (!this.box || !this.opened) return;
    const doc = this.win.document;
    const c =
      this.conversation === null
        ? null
        : lazy.AgentChat.list().find((/** @type {any} */ x) => x.id === this.conversation);
    const config = lazy.McpHost.agentConfig;
    const lines = chatHeader({
      provider: c?.provider ?? null,
      granted: !!c?.granted,
      localOnly: !!config?.localOnly,
      budget: c?.running ? c.budget : null,
    });
    this.head.forEach((h, i) => (h.textContent = lines[i] ?? ""));
    const log = /** @type {HTMLElement} */ (this.log);
    const input = /** @type {HTMLTextAreaElement} */ (this.input);
    input.hidden = this.view !== "chat";
    const keyBox = /** @type {HTMLElement} */ (this.keyInput?.parentElement);
    keyBox.hidden = this.view !== "key";
    if (this.view === "key") {
      /** @type {HTMLElement} */ (this.keyLabel).textContent =
        `API key for ${this.keyFor?.name ?? ""} (${whereDataGoes(this.keyFor?.endpoint ?? "")})`;
      /** @type {HTMLElement} */ (this.hint).textContent = KEY_HINT;
      return;
    }
    if (this.view !== "chat") {
      log.setAttribute("role", "listbox");
      log.replaceChildren(
        ...this.rows.map((r, i) => {
          const row = el(doc, "div", "vimma-agent-chat-row");
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", String(i === this.row));
          row.append(
            el(doc, "span", "vimma-agent-chat-row-label", r.label),
            el(doc, "span", "vimma-agent-chat-row-detail", r.detail),
          );
          return row;
        }),
      );
      if (!this.rows.length) {
        log.append(
          el(
            doc,
            "div",
            "vimma-agent-chat-empty",
            this.view === "models" ? "looking for local model servers…" : "no conversations",
          ),
        );
      }
      this.drawn = -1;
      /** @type {HTMLElement} */ (this.hint).textContent =
        this.view === "list" ? LIST_HINT : MODELS_HINT;
      return;
    }
    log.setAttribute("role", "log");
    if (!c) {
      log.replaceChildren(
        el(doc, "div", "vimma-agent-chat-empty", "No model is set up for the built-in agent."),
        el(
          doc,
          "div",
          "vimma-agent-chat-empty",
          "Add a provider under [agent] in config.toml, or press Esc, then m to look for a " +
            "local model server (Ollama, LM Studio, llama.cpp) on this machine.",
        ),
      );
      this.drawn = -1;
    } else {
      const t = lazy.AgentChat.transcript(c.id);
      const key = t.version * 1000 + Math.max(this.entry, -1) + 1;
      if (key !== this.drawn || this.drawnId !== c.id) {
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
        const selected = this.focusedLog() ? this.entry : -2;
        log.replaceChildren(
          ...t.entries.map((/** @type {any} */ entry, /** @type {number} */ i) =>
            this.entryNode(
              doc,
              entry,
              i === selected || (selected === -1 && i === t.entries.length - 1),
            ),
          ),
        );
        if (atEnd || this.drawnId !== c.id) log.scrollTop = log.scrollHeight;
        this.drawn = key;
        this.drawnId = c.id;
      }
    }
    /** @type {HTMLElement} */ (this.hint).textContent = this.slot.isOpen
      ? SLOT_HINT
      : this.focusedLog()
        ? NORMAL_HINT
        : INSERT_HINT;
  }

  /** @private */
  focusedLog() {
    return this.win.document.activeElement === this.log;
  }

  /**
   * One transcript entry, as text: a label line, then its lines, indented (B19).
   * @param {Document} doc @param {import("../core/agent-chat.mjs").Entry} entry
   * @param {boolean} selected
   */
  entryNode(doc, entry, selected) {
    const view = entryView(entry);
    const node = el(doc, "div", `vimma-agent-chat-entry vimma-agent-chat-${view.tone}`);
    node.setAttribute("data-text", view.lines.join("\n"));
    if (selected) node.setAttribute("aria-current", "true");
    if (view.label) {
      const label = el(doc, "div", "vimma-agent-chat-label", view.label);
      if (view.label === USER_LABEL) label.classList.add("vimma-agent-chat-you");
      node.append(label);
    }
    for (const line of view.lines) {
      node.append(el(doc, "div", view.indent ? "vimma-agent-chat-line" : "", line));
    }
    return node;
  }

  /** @private */
  build() {
    const { box, header, list } = buildPanelBox(this.win, {
      id: CHAT_ID,
      label: "Built-in agent",
      hint: INSERT_HINT,
    });
    const doc = this.win.document;
    box.classList.add("vimma-agent-chat");
    this.head = [el(doc, "div", "vimma-agent-chat-head"), el(doc, "div", "vimma-agent-chat-head")];
    header.replaceChildren(...this.head);
    // The transcript: a log, read by screen readers as it grows.
    const log = el(doc, "div", "vimma-agent-chat-log");
    log.id = CHAT_LOG_ID;
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");
    log.tabIndex = -1;
    list.replaceWith(log);
    const slotBox = el(doc, "div", "vimma-agent-chat-slotbox");
    const input = /** @type {HTMLTextAreaElement} */ (doc.createElementNS(HTML_NS, "textarea"));
    input.id = CHAT_INPUT_ID;
    input.className = "vimma-agent-chat-input";
    input.rows = 3;
    input.setAttribute("aria-label", "Task for the agent");
    input.placeholder = "Write a task for the agent";
    // The masked key field (Behaviour 3): a password field, so the key is never drawn.
    const keyBox = el(doc, "label", "vimma-agent-chat-keybox");
    keyBox.hidden = true;
    const keyLabel = el(doc, "div", "vimma-agent-chat-keylabel");
    const keyInput = /** @type {HTMLInputElement} */ (doc.createElementNS(HTML_NS, "input"));
    keyInput.id = CHAT_KEY_ID;
    keyInput.type = "password";
    keyInput.autocomplete = "off";
    keyInput.className = "vimma-agent-chat-input";
    keyBox.append(keyLabel, keyInput);
    log.after(slotBox, input, keyBox);
    this.keyInput = keyInput;
    this.keyLabel = keyLabel;
    this.hint = /** @type {HTMLElement} */ (box.querySelector(".vimma-panel-hint"));
    this.box = box;
    this.log = log;
    this.slotBox = slotBox;
    this.input = input;
    // Focus coming into the window from outside arms the slot's question again (security.md
    // M4, M43): a key typed on the way in, meant for the input, never answers it.
    box.addEventListener("focusin", (e) => {
      const from = /** @type {Node | null} */ (e.relatedTarget);
      if (!from || !box.contains(from)) this.host.rearm();
    });
    input.addEventListener("focus", () => this.render());
    log.addEventListener("focus", () => this.render());
    return box;
  }
}

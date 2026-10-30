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
  needsKey,
  noModelLines,
  noModelNotice,
  noModelReason,
  noticeTarget,
  providerWhere,
  sendNotice,
  whereDataGoes,
} from "../core/agent-chat.mjs";
import {
  CLIS,
  DEFAULT_MAX_MINUTES,
  cliModelText,
  modelProblem,
  modelPrompt,
} from "../core/agent-cli.mjs";
import { checkEndpoint, isLocalEndpoint } from "../core/agent-providers.mjs";
import { pickerEntries, unavailableText } from "../core/agent-setup.mjs";
import { lastUseText } from "../core/agent-store.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import { AgentPrompt } from "./agent-prompt.mjs";
import { buildPanelBox, giveFocusBack, rememberFocus } from "./side-panel.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  // Lazily: AgentChat reaches VimmaHost through the agent commands, and VimmaHost builds this.
  AgentChat: "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
  AgentCli: "chrome://browser/content/vimma/agent/AgentCli.sys.mjs",
  AgentKeys: "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
  ConfigHost: "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
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

const HTML_NS = "http://www.w3.org/1999/xhtml";
// The key field's eye button: `::-moz-reveal` parses only in user-agent sheets, so this one rule
// goes in as an agent sheet (an author sheet such as side-panel.css drops it).
const NO_REVEAL_SHEET =
  "data:text/css," + encodeURIComponent(`#${CHAT_KEY_ID}::-moz-reveal { display: none; }`);
/** @type {WeakSet<Window>} windows NO_REVEAL_SHEET is loaded into (a second load throws) */
const noReveal = new WeakSet();

const INSERT_HINT = "Enter sends · ctrl+Enter asks every step · shift+Enter new line · Esc";
const NORMAL_HINT =
  "i write · j k move · s stop · m model · n new · c list · P give · y copy · q close";
const LIST_HINT = "j k move · Enter open · d delete · n new · / filter · Esc back";
const MODELS_HINT = "j k move · Enter use · D default · x delete its key · Esc back";
const SLOT_HINT = "a question waits: answer it here";

/**
 * @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig
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

/** @param {Document} doc @param {string} tag @param {string} className @param {string} [text] */
const el = (doc, tag, className, text = "") => {
  const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
  node.className = className;
  node.textContent = text;
  return node;
};

/**
 * A name for a provider set up in the window: `base`, or with a number when config.toml has a
 * provider of that name already, so its key (stored by name) and the file agree.
 * @param {string} base
 */
function freeName(base) {
  const taken = new Set(
    (lazy.McpHost.agentConfig?.providers ?? []).map((/** @type {any} */ p) => p.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** Why there is no model when config.toml was refused, else null (Behaviour 6). */
function refused() {
  const { errors, file } = lazy.ConfigHost.refused;
  return noModelReason(errors, file);
}

/**
 * The model picked this session (Behaviour 7), else the provider `[agent] default` names, else
 * the first configured, else none (setup).
 */
function defaultProvider() {
  const config = lazy.McpHost.agentConfig;
  const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []);
  return (
    lazy.AgentChat.chosen ??
    providers.find((p) => p.name === config?.default) ??
    providers[0] ??
    null
  );
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
    /** A key is being stored. */
    this.storing = false;
    /** @type {Row[]} the models or conversations listed */
    this.rows = [];
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
      return lazy.AgentChat.get(this.conversation).conn;
    } catch {
      return null;
    }
  }

  /**
   * Opens the window on the last conversation shown, else a new one with the default provider.
   * @param {{ conversation?: number, view?: "chat" | "models" | "list", then?: () => void }} [opts]
   *   `then`: run once it is open, which waits for the stored conversations the first time
   * @returns {boolean} whether it opened
   */
  open({ conversation, view = "chat", then } = {}) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) {
      this.host.say("the built-in agent works in a normal window");
      return false;
    }
    if (!lazy.AgentChat.restored) {
      // The stored conversations are read (and decrypted) only when the window first opens,
      // so a user who never opens it is never asked for the keyring (B15).
      lazy.AgentChat.restore().then(() => this.open({ conversation, view, then }));
      return true;
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
    this.clearKey();
    this.view = view;
    this.drawn = -1;
    this.render();
    if (view === "chat") this.insert();
    else /** @type {HTMLElement} */ (this.log).focus();
    if (view === "models") this.loadModels();
    if (view === "list") {
      this.filter = "";
      this.loadList();
    }
    this.host.changed();
    then?.();
    return true;
  }

  /** A new conversation with the default provider, or null when none is set up. */
  create() {
    const provider = defaultProvider();
    if (!provider) return null;
    return lazy.AgentChat.create({ provider }).id;
  }

  close() {
    this.clearKey();
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

  /** No model to act with: the setup hint, or the error that kept config.toml from applying. */
  sayNoModel() {
    const why = refused();
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
    lazy.AgentChat.stop(this.conversation);
  }

  /** `C`, `:agent clear` (Behaviour 22). */
  clear() {
    if (this.conversation === null) return;
    const refused = lazy.AgentChat.clear(this.conversation);
    if (refused) this.host.say(`agent: ${refused}`);
  }

  /**
   * `:agent forget all` (Behaviour 23): after a y, running tasks stop and every conversation
   * goes, with every file of the store.
   */
  async forgetAll() {
    await lazy.AgentChat.restore();
    const n = lazy.AgentChat.list().length;
    if (!n) {
      this.host.say("agent: there are no conversations");
      return;
    }
    this.host.ask(`Delete all ${n} agent conversation${n === 1 ? "" : "s"}? y/N`, () => {
      this.conversation = null;
      if (this.opened) this.close();
      lazy.AgentChat.forgetAll().then(
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
    const go = () => {
      // Emptied at once, so a second Enter while the send settles sends nothing twice.
      input.value = "";
      lazy.AgentChat.send(id, text, { ask }).then(
        (/** @type {any} */ r) => {
          if ("refused" in r) {
            if (!input.value) input.value = text;
            // The model is not there: another is picked, and the message waits for it.
            if (r.pick && this.opened && this.conversation === id) this.open({ view: "models" });
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
          console.error("vimma agent: the key could not be read", e?.name);
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
      this.host.ask(sendNotice(provider), () => {
        lazy.AgentChat.confirm(id, noticeTarget(provider));
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

  /**
   * The models view (Behaviour 7): the conversation's model when nothing else lists it, the
   * configured providers, setup's hosted providers, then what the local servers list now; the
   * conversation's model is selected, and one that is not there is shown as such.
   */
  loadModels() {
    const config = lazy.McpHost.agentConfig;
    // An agent CLI only while that feature is on (builtin-agent-cli, Delivery).
    const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []).filter(
      (p) => p.kind !== "cli" || lazy.AgentCli.enabled,
    );
    const current =
      this.conversation === null ? null : lazy.AgentChat.get(this.conversation).provider;
    /** @type {Map<string, string>} key hints, which arrive one by one */
    const hints = new Map();
    let first = true;
    /** @param {any} found @param {any} states */
    const draw = (found, states) => {
      const selected = this.rows[this.row]?.label;
      const entries = pickerEntries({ providers, found, states, current });
      /** @type {Row[]} */
      const rows = entries.map((e) => {
        const p = e.provider;
        if (p && e.otherModel) {
          // builtin-agent-cli Behaviour 17: a model of the CLI's that the list does not name.
          const unavailable = unavailableText(p, e.state);
          return {
            label: `${p.name} · other model…`,
            detail: unavailable ? "not available" : "type its name",
            otherModel: p,
            ...(unavailable ? { unavailable } : {}),
          };
        }
        const what = p
          ? {
              label: `${p.name} · ${p.kind === "cli" ? cliModelText(p.cli ?? "", p.model) : p.model}`,
              provider: p,
              endpoint: p.endpoint,
            }
          : {
              label: `${e.local?.server} · ${e.local?.model}`,
              local: e.local,
              endpoint: e.local?.endpoint ?? "",
            };
        const unavailable = p ? unavailableText(p, e.state) : null;
        // Short, so the label keeps its room; Enter on the row says why in full.
        const where =
          (p && hints.get(what.label)) ?? (p ? providerWhere(p) : whereDataGoes(what.endpoint));
        // An agent CLI's model config.toml names, among the models its list adds.
        const listed = p?.kind === "cli" && !e.cliModel ? `config.toml · ${where}` : where;
        const detail = unavailable ? "not available" : listed;
        return {
          label: what.label,
          detail: e.current ? `in use · ${detail}` : detail,
          ...(what.provider ? { provider: what.provider } : {}),
          ...(what.local ? { local: what.local } : {}),
          ...(unavailable ? { unavailable } : {}),
          current: e.current,
        };
      });
      // Setup's hosted providers (Behaviour 3): before the local servers' models.
      const at = rows.findIndex((r) => r.local);
      rows.splice(
        at < 0 ? rows.length : at,
        0,
        { label: "add: Anthropic (Messages API)", detail: "api key", add: "anthropic" },
        { label: "add: OpenAI-compatible endpoint", detail: "https:// and api key", add: "openai" },
        ...(lazy.AgentCli.enabled
          ? [
              {
                label: `add: agent CLI (${Object.values(CLIS)
                  .map((c) => c.title)
                  .join(", ")})`,
                detail: "its own login",
                add: /** @type {const} */ ("cli"),
              },
            ]
          : []),
      );
      this.rows = rows;
      const keep = first ? -1 : rows.findIndex((r) => r.label === selected);
      this.row =
        keep >= 0
          ? keep
          : Math.max(
              0,
              rows.findIndex((r) => r.current),
            );
      first = false;
      this.render();
    };
    draw(null, null);
    for (const p of providers) {
      if (!needsKey(p)) continue;
      lazy.AgentKeys.hint(p.name, p.endpoint).then(
        (/** @type {string | null} */ hint) => {
          hints.set(`${p.name} · ${p.model}`, hint ?? "no key · Enter adds one");
          const row = this.rows.find((r) => r.provider === p);
          if (row && !row.unavailable) {
            row.detail = `${row.current ? "in use · " : ""}${hints.get(row.label)}`;
          }
          if (this.view === "models") this.render();
        },
        () => {},
      );
    }
    // Asked only now, while the picker is open, and only on this machine (Behaviour 2, 7, B12):
    // the usual ports, and the configured providers' own endpoints.
    const asked = [...providers, ...(current ? [current] : [])];
    const locals = asked.filter((p) => p.kind === "openai" && isLocalEndpoint(p.endpoint));
    // An agent CLI's program: its path pref set and its file still passing C4's checks.
    const clis = asked.filter((p) => p.kind === "cli" && lazy.AgentCli.enabled);
    Promise.all([
      lazy.AgentChat.probe({
        extra: locals.map((p) => ({ server: p.name, endpoint: p.endpoint })),
      }),
      lazy.AgentChat.modelStates([...locals, ...clis]),
    ]).then(
      ([found, states]) => {
        if (!this.opened || this.view !== "models") return;
        draw(found, states);
      },
      (/** @type {any} */ e) => console.error("vimma agent: probe failed", e),
    );
  }

  /**
   * The conversations view (Behaviour 19): the stored ones and those of this session, newest
   * first, by title, provider, model and last use, filtered by title after `/`.
   */
  loadList() {
    const now = Date.now();
    this.rows = lazy.AgentChat.list()
      .filter((/** @type {any} */ c) =>
        (c.title || "New conversation").toLowerCase().includes(this.filter),
      )
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.used - a.used || b.id - a.id)
      .map((/** @type {any} */ c) => ({
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
   * `Enter` (or `D`, `makeDefault`) on a row: a conversation opens, or the model is used by the
   * open conversation and this session's new ones (Behaviour 7).
   * @param {{ makeDefault?: boolean }} [opts]
   */
  async pick({ makeDefault = false } = {}) {
    const row = this.rows[this.row];
    if (!row) return;
    if (this.view === "list" && row.id !== undefined) {
      this.open({ conversation: row.id });
      return;
    }
    if (row.add === "cli") {
      this.findClis();
      return;
    }
    if (row.add) {
      this.addProvider(row.add);
      return;
    }
    if (row.otherModel && !row.unavailable) {
      this.askOtherModel(row.otherModel, { makeDefault });
      return;
    }
    if (row.unavailable) {
      this.host.say(`agent: ${row.unavailable}; pick another model`, true);
      return;
    }
    let provider = row.provider;
    if (row.cliPick) {
      // builtin-agent-cli Behaviour 2, C4: the path picked here is a pref, and the provider
      // names only which CLI it is and its model.
      const info = CLIS[row.cliPick.cli];
      if (!info) return;
      const listed = (lazy.McpHost.agentConfig?.providers ?? []).find(
        (/** @type {AgentProviderConfig} */ p) => p.kind === "cli" && p.cli === info.id,
      );
      // A CLI config.toml lists keeps its model; only a new one asks for it.
      if (!listed) {
        this.askCliModel(info.id, row.cliPick.path, { makeDefault });
        return;
      }
      lazy.AgentCli.use(info.id, row.cliPick.path);
      provider = listed;
    }
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
    this.usePicked(provider, { makeDefault });
  }

  /**
   * A new agent CLI's model, on the prompt line (builtin-agent-cli Behaviour 2): the CLI's
   * suggested model, editable, and empty for the CLI's own default. A model the command line
   * would refuse is refused here and asked again; nothing is stored before a model is taken.
   * @param {string} cli  a key of CLIS
   * @param {string} path  the program setup found
   * @param {{ makeDefault: boolean }} opts
   * @param {string} [value]  what was typed before, to correct
   */
  askCliModel(cli, path, opts, value) {
    const info = CLIS[cli];
    if (!info) return;
    const ask = modelPrompt(cli);
    this.host.prompt({
      label: ask.label,
      value: value ?? ask.value,
      placeholder: ask.placeholder,
      submit: (text) => {
        const model = text.trim();
        const problem = modelProblem(model);
        if (problem) {
          this.host.say(`agent: ${problem}`, true);
          this.askCliModel(cli, path, opts, text);
          return;
        }
        lazy.AgentCli.use(cli, path);
        this.usePicked(
          {
            name: freeName(info.bin),
            kind: "cli",
            cli,
            endpoint: "",
            model,
            vision: false,
            maxMinutes: DEFAULT_MAX_MINUTES,
          },
          { ...opts, addedCli: true },
        );
      },
    });
  }

  /**
   * A model of a configured agent CLI that its list does not name (builtin-agent-cli
   * Behaviour 7), on the prompt line under setup's rule; then used as a picked row is.
   * @param {AgentProviderConfig} base  the CLI's provider in config.toml
   * @param {{ makeDefault: boolean }} opts
   * @param {string} [value]  what was typed before, to correct
   */
  askOtherModel(base, opts, value) {
    const ask = modelPrompt(base.cli ?? "");
    this.host.prompt({
      label: ask.label,
      value: value ?? "",
      placeholder: ask.placeholder,
      submit: (text) => {
        const model = text.trim();
        const problem = modelProblem(model);
        if (problem) {
          this.host.say(`agent: ${problem}`, true);
          this.askOtherModel(base, opts, text);
          return;
        }
        this.usePicked({ ...base, model }, opts);
      },
    });
  }

  /**
   * The picked provider goes to the open conversation, and to config.toml as `pick` says.
   * @param {AgentProviderConfig} picked
   * @param {{ makeDefault: boolean, addedCli?: boolean }} opts  `addedCli`: an agent CLI setup
   *   found that config.toml does not list yet
   */
  usePicked(picked, { makeDefault, addedCli = false }) {
    if (!this.useProvider(picked)) return;
    this.insert();
    const what =
      picked.kind === "cli" ? cliModelText(picked.cli ?? "", picked.model) : picked.model;
    // config.toml changes only for setup (no provider yet) or when asked with D (B12); an
    // agent CLI setup found is listed there, as a hosted provider added here is, so that it is
    // in the picker after a restart.
    const setup = !(lazy.McpHost.agentConfig?.providers ?? []).length;
    if (!makeDefault && !setup) {
      if (addedCli) {
        this.remember(picked).then((note) => {
          this.host.say(`agent: ${picked.name} · ${what}${note}`, note.startsWith(";"));
        });
        return;
      }
      this.host.say(
        `agent: ${picked.name} · ${what} until a restart; D in the picker makes it the default`,
      );
      return;
    }
    this.remember(picked, { makeDefault: true }).then((note) => {
      if (note) this.host.say(`agent: ${picked.name} · ${what}${note}`, note.startsWith(";"));
    });
  }

  /**
   * Setup's agent CLIs (builtin-agent-cli Behaviour 1): a search of PATH and each one's
   * `--version`, only while setup is open on this row, each listed with its path to pick.
   */
  findClis() {
    this.rows = [];
    this.row = 0;
    this.render();
    lazy.AgentCli.find().then(
      (
        /** @type {{ cli: string, path: string, label: string, problem: string | null }[]} */ found,
      ) => {
        if (!this.opened || this.view !== "models") return;
        if (!found.length) {
          this.host.say(`agent: ${lazy.AgentCli.noneFound()}`, true);
          this.loadModels();
          return;
        }
        this.rows = found.map((f) => ({
          label: f.label,
          detail: f.problem ? "not available" : "agent CLI · Enter uses it",
          ...(f.problem
            ? { unavailable: `${f.path} is refused: ${f.problem}` }
            : { cliPick: { cli: f.cli, path: f.path } }),
        }));
        this.render();
        // A row cuts a long path; the notice line shows the first one whole before it is used.
        const first = found[0];
        if (first) this.host.say(`agent: found ${first.label}`, !!first.problem);
      },
      (/** @type {any} */ e) => console.error("vimma agent: looking for agent CLIs failed", e),
    );
  }

  /**
   * A provider goes to config.toml (B12): a hosted provider added in the window, so that its
   * key has a provider after a restart, and, with `makeDefault` (setup, or `D` in the picker),
   * as `[agent] default`, which new conversations use. Its key stays in login storage.
   * @param {AgentProviderConfig} provider
   * @param {{ makeDefault?: boolean }} [opts]  without it, a listed provider writes nothing
   * @returns {Promise<string>} what the notice adds: "" when nothing was written
   */
  async remember(provider, { makeDefault = false } = {}) {
    const config = lazy.McpHost.agentConfig;
    const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []);
    const listed = providers.find(
      (p) =>
        p.kind === provider.kind &&
        p.endpoint === provider.endpoint &&
        p.model === provider.model &&
        p.cli === provider.cli,
    );
    const asDefault = makeDefault || providers.length === 0;
    if (listed && (!asDefault || config?.default === listed.name)) {
      return asDefault ? " · already [agent] default" : "";
    }
    const r = await lazy.ConfigHost.addAgentProvider(provider, { makeDefault: asDefault });
    if ("error" in r) return `; not saved to config.toml (${r.error})`;
    return asDefault ? " · saved to config.toml as [agent] default" : " · saved to config.toml";
  }

  /**
   * The open conversation's model, and this session's new conversations' (Behaviour 7).
   * @param {AgentProviderConfig} provider
   * @returns {boolean} whether it is in use (a running task keeps its model)
   */
  useProvider(provider) {
    if (this.conversation === null) {
      this.conversation = lazy.AgentChat.create({ provider }).id;
      lazy.AgentChat.choose(provider);
      return true;
    }
    const now = lazy.AgentChat.get(this.conversation).provider;
    if (
      now.endpoint !== provider.endpoint ||
      now.model !== provider.model ||
      now.name !== provider.name
    ) {
      const refused = lazy.AgentChat.setProvider(this.conversation, provider);
      if (refused) {
        this.host.say(`agent: ${refused}`, true);
        return false;
      }
    }
    lazy.AgentChat.choose(provider);
    return true;
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
          const name = freeName(kind === "anthropic" ? "anthropic" : new URL(endpoint).hostname);
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
    this.clearKey();
    this.keyFor = provider;
    this.view = "key";
    this.render();
    /** @type {HTMLInputElement} */ (this.keyInput).focus();
  }

  cancelKey() {
    this.clearKey();
    this.insert();
  }

  /** The field holds a key only while it is typed: any way out of it empties it (M46). */
  clearKey() {
    if (this.keyInput) this.keyInput.value = "";
    this.keyFor = null;
  }

  async storeKey() {
    const field = /** @type {HTMLInputElement} */ (this.keyInput);
    const provider = this.keyFor;
    // Out of the field at once: it holds the key only while it is typed.
    const key = field.value.trim();
    field.value = "";
    if (this.storing) return undefined;
    if (!provider) return this.insert();
    if (!key) {
      this.host.say(`agent: ${provider.name} needs an API key`, true);
      return undefined;
    }
    // One store at a time: a second Enter while this one runs neither errs nor races it.
    this.storing = true;
    this.keyFor = null;
    let hint;
    try {
      await lazy.AgentKeys.set(provider.name, key, provider.endpoint);
      hint = await lazy.AgentKeys.hint(provider.name, provider.endpoint);
    } catch (e) {
      // The error's text is not shown: it could carry what was typed.
      console.error("vimma agent: the key could not be stored", /** @type {any} */ (e)?.name);
      this.host.say(`agent: the key for ${provider.name} could not be stored`, true);
      this.keyFor = provider;
      return undefined;
    } finally {
      this.storing = false;
    }
    this.keyFor = null;
    this.useProvider(provider);
    this.insert();
    const note = await this.remember(provider);
    this.host.say(`agent: ${provider.name}: ${hint ?? "key stored"}${note}`, note.startsWith(";"));
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
      asking: !!c?.asking,
      localOnly: !!config?.localOnly,
      budget: c?.running ? c.budget : null,
      refused: c ? null : refused(),
      cli: c?.cli ?? null,
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
      const { file } = lazy.ConfigHost.refused;
      log.replaceChildren(
        ...noModelLines(refused(), file).map((line) =>
          el(doc, "div", "vimma-agent-chat-empty", line),
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
    if (!noReveal.has(this.win)) {
      noReveal.add(this.win);
      try {
        this.win.windowUtils.loadSheetUsingURIString(
          NO_REVEAL_SHEET,
          this.win.windowUtils.AGENT_SHEET,
        );
      } catch (e) {
        // The button would then show but do nothing: the listeners below still cancel it.
        console.error("vimma agent: the key field's sheet did not load", e);
      }
    }
    // An entered key is never shown again (M46). NO_REVEAL_SHEET hides the eye button, and every
    // reveal a user can ask for (that button, the textbox context menu's item, `revealPassword`)
    // goes through the cancelable MozWillToggleReveal; a masked field already refuses copy and cut. The context
    // menu goes too, since its only use here would be that reveal item; ctrl+v still pastes.
    for (const type of ["MozWillToggleReveal", "contextmenu", "copy", "cut", "dragstart"]) {
      keyInput.addEventListener(type, (e) => e.preventDefault());
    }
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

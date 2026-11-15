/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's chat window, drawn (docs/specs/builtin-agent.md B19, Behaviour 27): the
// box and its fields, built once, and each redraw of the header, the transcript, a list or the
// key field from the window's state. The state stays on the AgentChatWindow (ui/agent-chat.mjs)
// passed in, which is never imported here, so the two do not form a cycle. Every value is set
// as text through `el` (security.md C1, M42): no Markdown, HTML, image or link the model wrote
// becomes anything but characters.

import {
  USER_LABEL,
  chatHeader,
  entryView,
  noModelLines,
  noModelReason,
  whereDataGoes,
} from "../core/agent-chat.mjs";
import { keyField } from "./agent-chat-key.mjs";
import { buildPanelBox } from "./side-panel.mjs";

/** @import { AgentChatServices, AgentChatWindow } from "./agent-chat.mjs" */

export const CHAT_ID = "vimma-agent-chat";
export const CHAT_INPUT_ID = "vimma-agent-chat-input";
export const CHAT_LOG_ID = "vimma-agent-chat-log";
export const CHAT_SLOT_ID = "vimma-agent-chat-slot";
const KEY_HINT = "Enter stores it, encrypted, in login storage · Esc cancels";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const INSERT_HINT = "Enter sends · ctrl+Enter asks every step · shift+Enter new line · Esc";
const NORMAL_HINT =
  "i write · j k move · s stop · m model · n new · c list · P give · y copy · q close";
const LIST_HINT = "j k move · Enter open · d delete · n new · / filter · Esc back";
const MODELS_HINT = "j k move · Enter use · D default · x delete its key · Esc back";
const SLOT_HINT = "a question waits: answer it here";

/** @param {Document} doc @param {string} tag @param {string} className @param {string} [text] */
export const el = (doc, tag, className, text = "") => {
  const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
  node.className = className;
  node.textContent = text;
  return node;
};

/**
 * Why there is no model when config.toml was refused, else null (Behaviour 6).
 * @param {AgentChatServices} services
 */
export function refused(services) {
  const { errors, file } = services.configRefused();
  return noModelReason(errors, file);
}

/**
 * Redraws the open window from its state: the header, then the key field, a list or the
 * transcript, and the hint line.
 * @param {AgentChatWindow} chat
 */
export function render(chat) {
  if (!chat.box || !chat.opened) return;
  const doc = chat.win.document;
  const c =
    chat.conversation === null
      ? null
      : chat.services.chat.list().find((x) => x.id === chat.conversation);
  const config = chat.services.agentConfig();
  const lines = chatHeader({
    provider: c?.provider ?? null,
    granted: !!c?.granted,
    asking: !!c?.asking,
    localOnly: !!config?.localOnly,
    budget: c?.running ? c.budget : null,
    refused: c ? null : refused(chat.services),
    cli: c?.cli ?? null,
  });
  chat.head.forEach((h, i) => (h.textContent = lines[i] ?? ""));
  const log = /** @type {HTMLElement} */ (chat.log);
  const input = /** @type {HTMLTextAreaElement} */ (chat.input);
  input.hidden = chat.view !== "chat";
  const keyBox = /** @type {HTMLElement} */ (chat.keyInput?.parentElement);
  keyBox.hidden = chat.view !== "key";
  if (chat.view === "key") {
    /** @type {HTMLElement} */ (chat.keyLabel).textContent =
      `API key for ${chat.keyFor?.name ?? ""} (${whereDataGoes(chat.keyFor?.endpoint ?? "")})`;
    /** @type {HTMLElement} */ (chat.hint).textContent = KEY_HINT;
    return;
  }
  if (chat.view !== "chat") {
    log.setAttribute("role", "listbox");
    log.replaceChildren(
      ...chat.rows.map((r, i) => {
        const row = el(doc, "div", "vimma-agent-chat-row");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === chat.row));
        row.append(
          el(doc, "span", "vimma-agent-chat-row-label", r.label),
          el(doc, "span", "vimma-agent-chat-row-detail", r.detail),
        );
        return row;
      }),
    );
    if (!chat.rows.length) {
      log.append(
        el(
          doc,
          "div",
          "vimma-agent-chat-empty",
          chat.view === "models" ? "looking for local model servers…" : "no conversations",
        ),
      );
    }
    chat.drawn = -1;
    /** @type {HTMLElement} */ (chat.hint).textContent =
      chat.view === "list" ? LIST_HINT : MODELS_HINT;
    return;
  }
  log.setAttribute("role", "log");
  if (!c) {
    const { file } = chat.services.configRefused();
    log.replaceChildren(
      ...noModelLines(refused(chat.services), file).map((line) =>
        el(doc, "div", "vimma-agent-chat-empty", line),
      ),
    );
    chat.drawn = -1;
  } else {
    const t = chat.services.chat.transcript(c.id);
    const key = t.version * 1000 + Math.max(chat.entry, -1) + 1;
    if (key !== chat.drawn || chat.drawnId !== c.id) {
      const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
      const selected = focusedLog(chat) ? chat.entry : -2;
      log.replaceChildren(
        ...t.entries.map((entry, i) =>
          entryNode(doc, entry, i === selected || (selected === -1 && i === t.entries.length - 1)),
        ),
      );
      if (atEnd || chat.drawnId !== c.id) log.scrollTop = log.scrollHeight;
      chat.drawn = key;
      chat.drawnId = c.id;
    }
  }
  /** @type {HTMLElement} */ (chat.hint).textContent = chat.slot.isOpen
    ? SLOT_HINT
    : focusedLog(chat)
      ? NORMAL_HINT
      : INSERT_HINT;
}

/** @param {AgentChatWindow} chat */
function focusedLog(chat) {
  return chat.win.document.activeElement === chat.log;
}

/**
 * One transcript entry, as text: a label line, then its lines, indented (B19).
 * @param {Document} doc @param {import("../core/agent-chat.mjs").Entry} entry
 * @param {boolean} selected
 */
export function entryNode(doc, entry, selected) {
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

/**
 * Builds the window's box once and keeps its parts on `chat`.
 * @param {AgentChatWindow} chat
 */
export function build(chat) {
  const { box, header, list } = buildPanelBox(chat.win, {
    id: CHAT_ID,
    label: "Built-in agent",
    hint: INSERT_HINT,
  });
  const doc = chat.win.document;
  box.classList.add("vimma-agent-chat");
  chat.head = [el(doc, "div", "vimma-agent-chat-head"), el(doc, "div", "vimma-agent-chat-head")];
  header.replaceChildren(...chat.head);
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
  const keyInput = keyField(chat.win);
  keyBox.append(keyLabel, keyInput);
  log.after(slotBox, input, keyBox);
  chat.keyInput = keyInput;
  chat.keyLabel = keyLabel;
  chat.hint = /** @type {HTMLElement} */ (box.querySelector(".vimma-panel-hint"));
  chat.box = box;
  chat.log = log;
  chat.slotBox = slotBox;
  chat.input = input;
  // Focus coming into the window from outside arms the slot's question again (security.md
  // M4, M43): a key typed on the way in, meant for the input, never answers it.
  box.addEventListener("focusin", (e) => {
    const from = /** @type {Node | null} */ (e.relatedTarget);
    if (!from || !box.contains(from)) chat.host.rearm();
  });
  input.addEventListener("focus", () => chat.render());
  log.addEventListener("focus", () => chat.render());
  return box;
}

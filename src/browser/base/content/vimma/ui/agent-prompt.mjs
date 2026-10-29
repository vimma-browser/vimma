/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent question line (docs/specs/vimma-mcp.md decision 13): one line at the window's foot,
// in the command line's look (cmdline.css), an alertdialog named by its question. It never
// takes focus (decision 14): host/agent-ui.mjs gives it the keys from VimmaHost's capture
// listener, and only once it is armed (security.dialog_enable_delay, as Firefox's own security
// dialogs). Every value is set as text (security.md C1); the host of an open is a <b>, and a
// checkpoint's `▲` and verb are in the warning colour (docs/specs/mcp-checkpoints.md C3).

import { loadCmdlineSheet } from "./cmdline.mjs";

export const AGENT_PROMPT_ID = "vimma-agent-prompt";
const STATUSBAR_ID = "vimma-statusbar";
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** @import { Part } from "../core/agent-prompt.mjs" */

export class AgentPrompt {
  /**
   * @param {Window} win  a browser window
   * @param {{ id?: string, color?: string, parent?: () => Element | null }} [look]  the update
   *   question (docs/specs/update-notices.md) is the same line with its own id and colour; the
   *   built-in agent's prompt slot (docs/specs/builtin-agent.md Behaviour 27) is the same line
   *   inside the chat window (`parent`), in place of the window's foot
   */
  constructor(win, { id = AGENT_PROMPT_ID, color = "var(--vimma-text-cyan)", parent } = {}) {
    this.win = win;
    this.id = id;
    this.color = color;
    this.parent = parent ?? null;
    /** @type {HTMLElement | null} */
    this.el = null;
    /** @type {HTMLElement | null} */
    this.text = null;
    /** @type {HTMLElement | null} */
    this.count = null;
    /** @type {HTMLElement | null} */
    this.hint = null;
    this.armed = false;
    /** @type {number | null} */
    this.armTimer = null;
  }

  get isOpen() {
    return !!this.el && !this.el.hidden;
  }

  /**
   * Show a question; keys count only after `armMs`, and the hint appears then.
   * @param {{ parts: Part[], hint: string, label: string }} line
   * @param {number} armMs
   * @returns {boolean} whether it opened (never over a page in DOM full screen)
   */
  show(line, armMs) {
    const doc = this.win.document;
    if (doc.documentElement.hasAttribute("inDOMFullscreen")) return false;
    if (!this.el) this.build();
    const el = /** @type {HTMLElement} */ (this.el);
    const text = /** @type {HTMLElement} */ (this.text);
    text.replaceChildren(
      ...line.parts.map((p) => {
        // Text an agent or a page chose is its own bidi run (security.md M4): a name or a
        // title is a <bdi>, a URL a left-to-right isolate, so neither can reorder the question.
        const tag = p.isolate === "auto" && !p.strong ? "bdi" : p.strong ? "b" : "span";
        const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
        if (p.isolate === "ltr") {
          node.dir = "ltr";
          node.style.unicodeBidi = "isolate";
        } else if (p.isolate === "auto" && p.strong) {
          node.dir = "auto";
          node.style.unicodeBidi = "isolate";
        }
        // A checkpoint's glyph and verb (docs/specs/mcp-checkpoints.md C3): the theme's warning
        // colour, so that a payment or a form is not taken for a routine question.
        if (p.warn) node.style.color = "var(--vimma-text-yellow)";
        node.textContent = p.text;
        return node;
      }),
    );
    el.setAttribute("aria-label", line.label);
    /** @type {HTMLElement} */ (this.hint).textContent = line.hint;
    this.setCount("");
    el.hidden = false;
    this.rearm(armMs);
    return true;
  }

  /**
   * Keys count only `armMs` from now: after the window came to the front, lost it, or a key
   * arrived before the line was armed (security.md M4; as PopupNotifications re-arms on
   * activate). The hint hides until then.
   * @param {number} armMs
   */
  rearm(armMs) {
    if (!this.isOpen) return;
    this.disarm();
    /** @type {HTMLElement} */ (this.hint).hidden = true;
    this.armTimer = this.win.setTimeout(
      () => {
        this.armTimer = null;
        this.armed = true;
        /** @type {HTMLElement} */ (this.hint).hidden = false;
      },
      Math.max(0, armMs),
    );
  }

  /** @param {string} count  the digits of a grant typed so far */
  setCount(count) {
    if (this.count) this.count.textContent = count ? ` ${count}` : "";
  }

  hide() {
    this.disarm();
    if (this.el) this.el.hidden = true;
  }

  /** Close and remove the element (VimmaHost.uninit). */
  destroy() {
    this.hide();
    this.el?.remove();
    this.el = this.text = this.count = this.hint = null;
  }

  /** @private */
  disarm() {
    if (this.armTimer !== null) this.win.clearTimeout(this.armTimer);
    this.armTimer = null;
    this.armed = false;
  }

  /** @private */
  build() {
    const doc = this.win.document;
    loadCmdlineSheet(this.win);
    /** @param {string} tag @param {string} [className] */
    const el = (tag, className) => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
      if (className) node.className = className;
      return node;
    };
    const container = el("div");
    container.id = this.id;
    container.hidden = true;
    // An alertdialog that does not take focus: a screen reader hears it as it appears.
    container.setAttribute("role", "alertdialog");
    container.setAttribute("aria-live", "assertive");
    const panel = el("div", "vimma-cmdline-panel");
    const row = el("div", "vimma-cmdline-row");
    const text = el("span", "vimma-cmdline-prompt vimma-agent-prompt-text");
    text.style.color = this.color;
    const count = el("span", "vimma-agent-prompt-count");
    count.style.color = "var(--vimma-fg-bright)";
    const hint = el("span", "vimma-agent-prompt-hint");
    hint.style.color = "var(--vimma-fg-dim)";
    hint.style.marginInlineStart = "2ch";
    row.append(text, count, hint);
    panel.append(row);
    container.append(panel);
    const statusBar = doc.getElementById(STATUSBAR_ID);
    const browser = doc.getElementById("browser");
    const parent = this.parent?.();
    if (parent) parent.append(container);
    else if (statusBar) statusBar.before(container);
    else if (browser) browser.after(container);
    else doc.body.append(container);
    this.el = container;
    this.text = text;
    this.count = count;
    this.hint = hint;
  }
}

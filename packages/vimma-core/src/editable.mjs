/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Insert-mode detection over a plain descriptor of the focused element, built by the content
 * actor. See docs/specs/m1-core-logic.md § Insert detection for the rules and their sources.
 */

/**
 * @typedef {object} EditableDescriptor
 * @property {string} tagName              any case (XHTML is lowercase)
 * @property {string} [type]               `<input type>`, any case; missing or "" = "text"
 * @property {boolean} [readOnly]          the IDL property (input, textarea)
 * @property {boolean} [disabled]          `element.matches(":disabled")`
 * @property {boolean} [isContentEditable] the computed IDL property (inherits)
 * @property {string} [contentEditable]    the attribute, used only when isContentEditable is absent
 * @property {string | null} [role]        the role attribute (its first token is used)
 * @property {boolean} [ariaReadOnly]      aria-readonly="true" on the element
 * @property {boolean} [ariaDisabled]      aria-disabled="true" on the element or an ancestor
 *                                         (blocks ARIA-role widgets only, not native editables)
 * @property {boolean} [designMode]        `ownerDocument.designMode === "on"`
 * @property {readonly string[]} [classes] the element's own class tokens
 */
/** @typedef {{ editable: boolean, reason: string }} EditableResult */
/** @typedef {"auto" | "never" | "always"} InsertSiteMode */
/** @typedef {{ match: string, insert: InsertSiteMode }} InsertSiteRule */
/**
 * `focusin`: an element received focus. `recheck`: anything else (focusout, a blur, a page
 * change), which may leave insert mode but never enters it.
 * @typedef {"focusin" | "recheck"} InsertTrigger
 */

/** `<input>` types that take no typed characters. Every other type, known or not, is text. */
export const TEXT_INPUT_EXCLUDED_TYPES = Object.freeze([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
const EXCLUDED = new Set(TEXT_INPUT_EXCLUDED_TYPES);

/** ARIA roles of widgets that take typed characters. */
export const EDITABLE_ROLES = Object.freeze([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "application",
]);
const ROLES = new Set(EDITABLE_ROLES);

/**
 * Code and rich-text editors, recognised by a class on the focused element itself: the element
 * the editor focuses to receive keys. Most are also a textarea or contenteditable; the class
 * catches the ones that are neither (Monaco's EditContext `native-edit-context` div).
 */
export const KNOWN_EDITORS = Object.freeze(
  [
    { name: "monaco", classes: ["native-edit-context", "inputarea"] },
    { name: "codemirror6", classes: ["cm-content"] },
    { name: "ace", classes: ["ace_text-input"] },
    { name: "prosemirror", classes: ["ProseMirror"] },
    { name: "quill", classes: ["ql-editor"] },
  ].map((e) => Object.freeze({ name: e.name, classes: Object.freeze(e.classes) })),
);
/** @type {Map<string, string>} */
const EDITOR_BY_CLASS = new Map(KNOWN_EDITORS.flatMap((e) => e.classes.map((c) => [c, e.name])));

/** Native controls: an editor focus class on one of these (a search-panel button) means nothing. */
const NATIVE_CONTROLS = new Set([
  "a",
  "button",
  "details",
  "input",
  "label",
  "optgroup",
  "option",
  "select",
  "summary",
  "textarea",
]);

/** @type {readonly InsertTrigger[]} */
export const INSERT_TRIGGERS = Object.freeze(["focusin", "recheck"]);

/** @type {readonly InsertSiteMode[]} */
export const INSERT_SITE_MODES = Object.freeze(["auto", "never", "always"]);

const EDITABLE_CE = new Set(["true", "", "plaintext-only"]);

/**
 * Enter, sent as a trusted key press rather than run as an editor command: Enter is a different
 * action in each field (a new line, a form's submit, the page's own handler, the address bar's
 * load), and only a real Enter gets every one of them.
 */
export const INSERT_ENTER = "vimma_enter";

/**
 * Vim's insert-mode keys in text fields (docs/specs/key-handling-batch.md § 2): chord → the
 * editor's own command, so the edit is one undo step, or INSERT_ENTER.
 * @type {Readonly<Record<string, string>>}
 */
const INSERT_EDIT_KEYS = Object.freeze({
  "ctrl+w": "cmd_deleteWordBackward",
  "ctrl+u": "cmd_deleteToBeginningOfLine",
  "ctrl+h": "cmd_deleteCharBackward",
  "ctrl+j": INSERT_ENTER,
  "ctrl+m": INSERT_ENTER,
});

/**
 * The editor commands a text-field key may run; the content actor takes no other. INSERT_ENTER
 * is not one: the parent presses Enter itself (actors/enter-key.mjs).
 */
export const INSERT_EDIT_COMMANDS = Object.freeze(
  Object.values(INSERT_EDIT_KEYS).filter((c) => c !== INSERT_ENTER),
);

/**
 * The editor command a chord runs in a text field, or null. On macOS Cocoa's own key bindings
 * already make ctrl+h a backspace, so Vimma adds none there.
 * @param {string} chord  canonical (formatKey)
 * @param {{ mac?: boolean }} [options]
 * @returns {string | null}
 */
export function insertEditCommand(chord, { mac = false } = {}) {
  if (mac && chord === "ctrl+h") return null;
  return INSERT_EDIT_KEYS[chord] ?? null;
}

/**
 * @param {boolean} editable
 * @param {string} reason
 * @returns {EditableResult}
 */
const result = (editable, reason) => Object.freeze({ editable, reason });

/** Longest string field `parseDescriptor` accepts (tag names, types, roles, classes). */
export const DESCRIPTOR_MAX_STRING = 256;
/** Most class tokens `parseDescriptor` accepts. */
export const DESCRIPTOR_MAX_CLASSES = 64;

/** @param {unknown} v */
const isShortString = (v) => typeof v === "string" && v.length <= DESCRIPTOR_MAX_STRING;
/** @type {readonly ["readOnly", "disabled", "isContentEditable", "ariaReadOnly", "ariaDisabled", "designMode"]} */
const BOOLEAN_FIELDS = Object.freeze([
  "readOnly",
  "disabled",
  "isContentEditable",
  "ariaReadOnly",
  "ariaDisabled",
  "designMode",
]);

/**
 * A descriptor received from a content process, which may be compromised: a fresh copy with
 * only the known fields, each of its exact type and within the length caps, or null if any
 * field is wrong. Never throws.
 * @param {unknown} value
 * @returns {EditableDescriptor | null}
 */
export function parseDescriptor(value) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    const { tagName, type, contentEditable, role, classes } = v;
    if (!isShortString(tagName) || tagName === "") return null;
    /** @type {EditableDescriptor} */
    const d = { tagName: /** @type {string} */ (tagName) };
    if (type !== undefined) {
      if (!isShortString(type)) return null;
      d.type = /** @type {string} */ (type);
    }
    if (contentEditable !== undefined) {
      if (!isShortString(contentEditable)) return null;
      d.contentEditable = /** @type {string} */ (contentEditable);
    }
    if (role !== undefined) {
      if (role !== null && !isShortString(role)) return null;
      d.role = /** @type {string | null} */ (role);
    }
    for (const key of BOOLEAN_FIELDS) {
      const b = v[key];
      if (b === undefined) continue;
      if (typeof b !== "boolean") return null;
      d[key] = b;
    }
    if (classes !== undefined) {
      if (!Array.isArray(classes) || classes.length > DESCRIPTOR_MAX_CLASSES) return null;
      const copy = [...classes];
      if (!copy.every(isShortString)) return null;
      d.classes = /** @type {string[]} */ (copy);
    }
    return d;
  } catch {
    return null;
  }
}

/**
 * Whether keys typed into the described element belong to the page (insert mode).
 * @param {EditableDescriptor} d
 * @param {{ site?: InsertSiteMode, trigger?: InsertTrigger }} [options] `site`: the matched
 *   `[sites."<host>"]` table's `insert`; `trigger`: what made the host ask
 * @returns {EditableResult}
 */
export function isEditable(d, { site = "auto", trigger = "focusin" } = {}) {
  if (!INSERT_SITE_MODES.includes(site)) throw new TypeError(`unknown insert site mode "${site}"`);
  if (!INSERT_TRIGGERS.includes(trigger))
    throw new TypeError(`unknown insert trigger "${trigger}"`);
  if (site === "never") return result(false, "site:never");
  const tag = d.tagName.toLowerCase();
  // Esc blurs the element and focus falls to <body>: that must not read as "always editable".
  const root = tag === "body" || tag === "html";
  if (trigger === "recheck" && root && (site === "always" || d.designMode)) {
    return result(false, "document-root");
  }
  if (site === "always") return result(true, "site:always");
  if (d.designMode) return result(true, "design-mode");
  if (d.disabled) return result(false, "disabled");
  if (d.readOnly) return result(false, "readonly");

  if (tag === "input") {
    const type = (d.type ?? "").toLowerCase() || "text";
    return result(!EXCLUDED.has(type), `input:${type}`);
  }
  if (tag === "textarea" || tag === "select") return result(true, tag);
  if (tag === "embed" || tag === "object") return result(true, "embed");

  const ce =
    d.isContentEditable ??
    (d.contentEditable !== undefined && EDITABLE_CE.has(d.contentEditable.toLowerCase()));
  if (ce) return result(true, "contenteditable");

  const editor =
    NATIVE_CONTROLS.has(tag) || d.contentEditable?.toLowerCase() === "false"
      ? undefined
      : (d.classes ?? []).map((c) => EDITOR_BY_CLASS.get(c)).find(Boolean);
  const role = (d.role ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (editor || ROLES.has(role)) {
    if (d.ariaDisabled) return result(false, "aria-disabled");
    if (d.ariaReadOnly) return result(false, "aria-readonly");
    return result(true, editor ? `editor:${editor}` : `role:${role}`);
  }
  return result(false, "none");
}

/**
 * The mode after a focus change, for the host's focus tracking. Only a `focusin` of an editable
 * element enters insert (or the explicit `i` action, which the host handles); a `recheck` can
 * only leave it. Modes other than normal and insert are left alone.
 * @param {{ mode: import("./modes.mjs").Mode, trigger: InsertTrigger,
 *   descriptor: EditableDescriptor, site?: InsertSiteMode }} change
 * @returns {import("./modes.mjs").Mode}
 */
export function insertModeAfterFocus({ mode, trigger, descriptor, site = "auto" }) {
  if (mode !== "normal" && mode !== "insert") return mode;
  const { editable } = isEditable(descriptor, { site, trigger });
  if (mode === "insert") return editable ? "insert" : "normal";
  return editable && trigger === "focusin" ? "insert" : "normal";
}

/** @param {string} host */
const normaliseHost = (host) =>
  host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");

/** IPv4 and IPv6 literals (and anything with a colon, such as a stray port) match exactly. */
/** @param {string} host */
const isLiteral = (host) => host.includes(":") || /^\d+(\.\d+){3}$/.test(host);

/**
 * The `[sites."<host>"]` rule for a hostname (`URL.hostname`: no port; IPv6 in brackets).
 * A domain rule matches the host or any subdomain, on label boundaries (`example.com` matches
 * `www.example.com`, not `badexample.com`); IP literals match only exactly. The longest match
 * wins, the earlier rule on a tie. Case and a trailing dot are ignored. A host with a port
 * (`example.com:8080`) is not a hostname and matches only a rule written exactly so.
 * @param {string} host
 * @param {readonly InsertSiteRule[]} rules
 * @returns {InsertSiteRule | undefined}
 */
export function matchSiteRule(host, rules) {
  const h = normaliseHost(host);
  const literal = isLiteral(h);
  /** @type {InsertSiteRule | undefined} */
  let best;
  let bestLength = -1;
  for (const rule of rules) {
    const m = normaliseHost(rule.match);
    if (!m) continue;
    const hit = h === m || (!literal && !isLiteral(m) && h.endsWith(`.${m}`));
    if (hit && m.length > bestLength) {
      best = rule;
      bestLength = m.length;
    }
  }
  return best;
}

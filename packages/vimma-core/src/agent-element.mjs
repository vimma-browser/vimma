/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What a page's child says of one element for `vimma_elements` (docs/specs/mcp-forms.md F5, F6;
 * security.md M31), checked like any reply from a content process: a fresh copy with only the
 * known fields, each of its type and within its cap, or null. A password input and a sensitive
 * autocomplete name make a field sensitive whatever the child says. Imports nothing, so hints.mjs can
 * check a collection's reply with it; agent-act.mjs builds the list from what passes.
 */

/** The kinds an element is listed as (F5). */
export const ELEMENT_KINDS = Object.freeze([
  "link",
  "button",
  "field",
  "checkbox",
  "radio",
  "select",
  "click",
]);

/** Caps on what a child may send, in UTF-16 code units: the list cuts them further (F5). */
export const ELEMENT_REPLY_CAPS = Object.freeze({
  text: 512,
  type: 32,
  name: 512,
  autocomplete: 64,
  caption: 512,
  value: 1024,
  options: 50,
  forms: 64,
  action: 8192,
});

/** Form methods, as `HTMLFormElement.method` reports them. */
const METHODS = new Set(["get", "post", "dialog"]);

/** Autocomplete field names that are never listed with a value or filled (F6). */
const SECRET_NAMES = new Set(["current-password", "new-password", "one-time-code"]);

/**
 * Whether an autocomplete field name marks a sensitive field (F6): a password, a one-time code
 * or any payment card field (`cc-*`).
 * @param {unknown} name
 */
export function isSensitiveAutocomplete(name) {
  return typeof name === "string" && (SECRET_NAMES.has(name) || name.startsWith("cc-"));
}

/**
 * Whether a control submits its form when clicked (F15): a `button` or an `input` of type
 * `submit` (a `<button>`'s default) or `image`, in a form that sends somewhere. A form whose
 * method (or the button's `formmethod`) is `dialog` only closes its dialog.
 * @param {{ localName: string, type?: string, inForm: boolean, method?: string }} c
 */
export function isSubmitControl({ localName, type, inForm, method }) {
  if (!inForm || method === "dialog") return false;
  if (localName === "button") return type === "submit";
  return localName === "input" && (type === "submit" || type === "image");
}

/**
 * @typedef {{ value: string, text: string }} ElementOption
 * @typedef {object} AgentElementInfo  one element as its child describes it (F5)
 * @property {string} kind  one of ELEMENT_KINDS
 * @property {string} text  its rendered text, else aria-label, title or alt
 * @property {string} [type]  a field's type (`email`, `password`, `contenteditable` …)
 * @property {string} [name]
 * @property {string} [autocomplete]  the parsed autocomplete field name
 * @property {string} [caption]  the text of its `<label>` elements, else its placeholder
 * @property {boolean} [required]
 * @property {boolean} [disabled]
 * @property {boolean} [readonly]
 * @property {boolean} [checked]  checkboxes and radios
 * @property {boolean} [sensitive]  F6: listed without a value
 * @property {string} [value]  never for a sensitive field
 * @property {ElementOption[]} [options]  a select's, at most 50
 * @property {string} [selected]  a select's selected value, never for a sensitive one
 * @property {number} [form]  the index of its form in the frame's reply
 * @typedef {{ method: string, action: string }} AgentForm
 */

/** @param {unknown} v @param {number} max */
const isText = (v, max) => typeof v === "string" && v.length <= max;

/**
 * A child's description of one element, or null when anything is wrong. An autocomplete name
 * that is sensitive makes the field sensitive whatever the child says, and a sensitive field
 * that carries a value or a selected option is refused (F6).
 * @param {unknown} value
 * @param {number} forms  how many forms the frame reported
 * @returns {AgentElementInfo | null}
 */
export function parseAgentElement(value, forms) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    const caps = ELEMENT_REPLY_CAPS;
    if (typeof v.kind !== "string" || !ELEMENT_KINDS.includes(v.kind)) return null;
    if (!isText(v.text, caps.text)) return null;
    /** @type {AgentElementInfo} */
    const out = { kind: v.kind, text: /** @type {string} */ (v.text) };
    for (const key of /** @type {const} */ (["type", "name", "autocomplete", "caption"])) {
      if (v[key] === undefined) continue;
      if (!isText(v[key], caps[key])) return null;
      out[key] = /** @type {string} */ (v[key]);
    }
    for (const key of /** @type {const} */ ([
      "required",
      "disabled",
      "readonly",
      "checked",
      "sensitive",
    ])) {
      if (v[key] === undefined) continue;
      if (typeof v[key] !== "boolean") return null;
      out[key] = /** @type {boolean} */ (v[key]);
    }
    // A password input is sensitive whatever the child says, as is a sensitive autocomplete name.
    if (isSensitiveAutocomplete(out.autocomplete) || out.type === "password") out.sensitive = true;
    if (v.value !== undefined) {
      if (!isText(v.value, caps.value) || out.sensitive) return null;
      out.value = /** @type {string} */ (v.value);
    }
    if (v.options !== undefined) {
      if (!Array.isArray(v.options) || v.options.length > caps.options) return null;
      /** @type {ElementOption[]} */
      const options = [];
      for (const o of [...v.options]) {
        if (typeof o !== "object" || o === null) return null;
        const { value: ov, text: ot } = /** @type {Record<string, unknown>} */ (o);
        if (!isText(ov, caps.text) || !isText(ot, caps.text)) return null;
        options.push({ value: /** @type {string} */ (ov), text: /** @type {string} */ (ot) });
      }
      out.options = options;
    }
    if (v.selected !== undefined) {
      if (!isText(v.selected, caps.text) || out.sensitive) return null;
      out.selected = /** @type {string} */ (v.selected);
    }
    if (v.form !== undefined) {
      if (!Number.isSafeInteger(v.form) || /** @type {number} */ (v.form) < 0) return null;
      if (/** @type {number} */ (v.form) >= forms) return null;
      out.form = /** @type {number} */ (v.form);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A frame's forms as its child reports them, or null: at most 64, each a method Firefox reports
 * and an action URL as a string.
 * @param {unknown} value
 * @returns {AgentForm[] | null}
 */
export function parseAgentForms(value) {
  try {
    if (!Array.isArray(value) || value.length > ELEMENT_REPLY_CAPS.forms) return null;
    /** @type {AgentForm[]} */
    const out = [];
    for (const f of [...value]) {
      if (typeof f !== "object" || f === null) return null;
      const { method, action } = /** @type {Record<string, unknown>} */ (f);
      if (typeof method !== "string" || !METHODS.has(method)) return null;
      if (!isText(action, ELEMENT_REPLY_CAPS.action)) return null;
      out.push({ method, action: /** @type {string} */ (action) });
    }
    return out;
  } catch {
    return null;
  }
}

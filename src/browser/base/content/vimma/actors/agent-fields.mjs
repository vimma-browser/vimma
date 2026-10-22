/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What an agent's `vimma_elements` says of each element (docs/specs/mcp-forms.md F5, F6;
// security.md M31), and what a `vimma_activate` click on one would reach (F9, F10, F15). Runs in
// the content process, in VimmaChild, in the element's own frame. Reads only: nothing here
// focuses, clicks or changes an element. The parent checks every field again (core
// agent-element.mjs, agent-act.mjs) and builds the list.
//
// A field is sensitive, and its value is never read into the reply, when it is or was ever a
// password field, when the page draws it as dots (`-webkit-text-security`), when its autocomplete
// field name is a password, one-time-code or payment card one, or when Firefox's form autofill
// heuristics infer a payment card field name for it (in a card form, also a field they leave to
// their machine-learning model). A failure of the heuristics makes every field of that form
// sensitive: it refuses rather than fills.

import { isSensitiveAutocomplete, isSubmitControl } from "../core/agent-element.mjs";
import { linkText } from "./hint-collect.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AutofillFormFactory: "resource://gre/modules/shared/AutofillFormFactory.sys.mjs",
  FormAutofillHeuristics: "resource://gre/modules/shared/FormAutofillHeuristics.sys.mjs",
  FormAutofillUtils: "resource://gre/modules/shared/FormAutofillUtils.sys.mjs",
});

/** The child's caps, in UTF-16 code units: core's ELEMENT_REPLY_CAPS. */
const TEXT = 512;
const VALUE = 1024;
const OPTIONS = 50;
const FORMS = 64;
const ACTION = 8192;

/** Inputs that are buttons. */
const BUTTON_TYPES = new Set(["button", "submit", "reset", "image"]);
/** Inputs whose value is no text an agent reads: a file's is a fake path, a button's its text. */
const NO_VALUE = new Set(["file", "checkbox", "radio", ...BUTTON_TYPES]);
/** ARIA roles and the kind they list as, for elements that are not form controls. */
const ROLE_KINDS = /** @type {Record<string, string>} */ ({
  button: "button",
  link: "link",
  checkbox: "checkbox",
  switch: "checkbox",
  menuitemcheckbox: "checkbox",
  radio: "radio",
  menuitemradio: "radio",
});

/** @param {unknown} s @param {number} max */
const cap = (s, max) => String(s ?? "").slice(0, max);

/** @param {string} s */
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/**
 * @typedef {import("../core/agent-element.mjs").AgentElementInfo} AgentElementInfo
 * @typedef {import("../core/agent-element.mjs").AgentForm} AgentForm
 */

/**
 * The kind an element is listed as (F5).
 * @param {Element} el
 */
function kindOf(el) {
  const html = /** @type {any} */ (el);
  switch (el.localName) {
    case "a":
      return el.hasAttribute("href") ? "link" : roleKind(el);
    case "button":
    case "summary":
      return "button";
    case "select":
      return "select";
    case "textarea":
      return "field";
    case "input":
      if (BUTTON_TYPES.has(html.type)) return "button";
      if (html.type === "checkbox" || html.type === "radio") return html.type;
      return "field";
  }
  if (html.isContentEditable) return "field";
  return roleKind(el);
}

/** @param {Element} el */
function roleKind(el) {
  const role = el.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return ROLE_KINDS[role] ?? "click";
}

/**
 * Whether `el` is a form control whose text is its value (a field, a select): its own text
 * would be its content, so it is named only by its accessible label or title.
 * @param {Element} el @param {string} kind
 */
const isControl = (el, kind) =>
  (kind === "field" || kind === "select" || kind === "checkbox" || kind === "radio") &&
  ["input", "select", "textarea"].includes(el.localName);

/**
 * What the element says: a button input's value, a control's accessible label or title, else
 * the rendered text as for an agent's link list.
 * @param {Element} el @param {string} kind
 */
function textOf(el, kind) {
  const html = /** @type {any} */ (el);
  if (el.localName === "input" && BUTTON_TYPES.has(html.type)) {
    return oneLine(html.value || el.getAttribute("alt") || el.getAttribute("aria-label") || "");
  }
  if (isControl(el, kind) || (kind === "field" && html.isContentEditable)) {
    // A rich text editor's text is what the user wrote: never read as its name.
    return oneLine(el.getAttribute("aria-label") || el.getAttribute("title") || "");
  }
  return linkText(el);
}

/**
 * The text of a control's `<label>` elements, else its placeholder.
 * @param {Element} el
 */
function captionOf(el) {
  const html = /** @type {any} */ (el);
  const labels = html.labels ? [...html.labels] : [];
  const text = oneLine(labels.map((l) => l.innerText ?? l.textContent ?? "").join(" "));
  return text || oneLine(el.getAttribute("placeholder") ?? "");
}

/**
 * The payment card fields among `fields`, as form autofill's heuristics infer them over each
 * field's form-like group (F6). Every field of a group whose heuristics throw counts too.
 * @param {Element[]} fields  inputs, selects and text areas
 * @returns {Set<Element>}
 */
function cardFields(fields) {
  /** @type {Set<Element>} */
  const out = new Set();
  /** @type {Set<Element>} roots of the groups already read */
  const done = new Set();
  for (const field of fields) {
    /** @type {any} */
    let formLike = null;
    try {
      formLike = lazy.AutofillFormFactory.createFromField(field);
      if (done.has(formLike.rootElement)) continue;
      done.add(formLike.rootElement);
      const details = lazy.FormAutofillHeuristics.getFormInfo(formLike, false) ?? [];
      /** Fields whose name form autofill leaves to its machine-learning model, decided later. */
      const undecided = [];
      let card = false;
      for (const d of details) {
        const names = /** @type {unknown[]} */ ([]).concat(d?.fieldName ?? []);
        if (names.some((n) => lazy.FormAutofillUtils.isCreditCardField(n))) {
          out.add(d.element);
          card = true;
        } else if (!names.length) {
          undecided.push(d.element);
        }
      }
      // In a card form, a field the synchronous heuristics could not name may be a card field.
      if (card) for (const el of undecided) out.add(el);
    } catch (e) {
      console.error("vimma agent-elements: form autofill heuristics", e);
      const group = formLike?.elements ? [...formLike.elements] : [field];
      for (const el of group) out.add(el);
    }
  }
  return out;
}

/**
 * Whether a field is sensitive now (F6), without the heuristics: it is or was ever a password
 * field, the page draws it as dots, or its autocomplete field name says so.
 * @param {Element} el
 */
export function plainlySensitive(el) {
  const html = /** @type {any} */ (el);
  if (html.hasBeenTypePassword === true || html.type === "password") return true;
  // Drawn as dots without type=password (PIN and card code widgets): the page treats it as secret.
  try {
    const masked = el.ownerDocument?.defaultView
      ?.getComputedStyle(el)
      ?.getPropertyValue("-webkit-text-security");
    if (masked && masked !== "none") return true;
  } catch {
    // no style: not masked
  }
  try {
    return isSensitiveAutocomplete(html.getAutocompleteInfo?.()?.fieldName);
  } catch {
    return false;
  }
}

/**
 * Each element as `vimma_elements` lists it, in the same order, and the forms they belong to,
 * each once, by index (F5). A sensitive field's value and selected option are never read.
 * @param {Element[]} els
 * @returns {{ elements: AgentElementInfo[], forms: AgentForm[] }}
 */
export function describeAgentElements(els) {
  const fields = els.filter((el) => ["input", "select", "textarea"].includes(el.localName));
  const cards = fields.length ? cardFields(fields) : new Set();
  /** @type {Map<Element, number>} */
  const formIndex = new Map();
  /** @type {AgentForm[]} */
  const forms = [];
  const elements = els.map((el) => {
    const html = /** @type {any} */ (el);
    const kind = kindOf(el);
    /** @type {AgentElementInfo} */
    const info = { kind, text: cap(textOf(el, kind), TEXT) };
    const control = ["input", "select", "textarea", "button"].includes(el.localName);
    if (el.localName === "input" || el.localName === "button") info.type = cap(html.type, 32);
    else if (el.localName === "textarea") info.type = "textarea";
    else if (kind === "field" && html.isContentEditable) info.type = "contenteditable";
    if (control && typeof html.name === "string" && html.name) info.name = cap(html.name, TEXT);
    if (["input", "select", "textarea"].includes(el.localName)) {
      let auto = "";
      try {
        auto = String(html.getAutocompleteInfo?.()?.fieldName ?? "");
      } catch {
        // an element without autocomplete info: none
      }
      if (auto) info.autocomplete = cap(auto, 64);
      const caption = captionOf(el);
      if (caption) info.caption = cap(caption, TEXT);
      if (html.required === true) info.required = true;
      if (html.readOnly === true) info.readonly = true;
    } else if (kind === "checkbox" || kind === "radio") {
      const caption = captionOf(el);
      if (caption) info.caption = cap(caption, TEXT);
    }
    if (el.matches(":disabled")) info.disabled = true;
    if (el.localName === "input" && (html.type === "checkbox" || html.type === "radio")) {
      info.checked = html.checked === true;
    } else if (kind === "checkbox" || kind === "radio") {
      info.checked = el.getAttribute("aria-checked") === "true";
    }
    const sensitive =
      ["input", "select", "textarea"].includes(el.localName) &&
      (plainlySensitive(el) || cards.has(el));
    if (sensitive) info.sensitive = true;
    if (!sensitive) {
      if (el.localName === "textarea" || (el.localName === "input" && !NO_VALUE.has(html.type))) {
        info.value = cap(html.value, VALUE);
      }
    }
    if (el.localName === "select") {
      info.options = [...html.options].slice(0, OPTIONS).map((/** @type {any} */ o) => ({
        value: cap(o.value, TEXT),
        text: cap(oneLine(o.text), TEXT),
      }));
      if (!sensitive && html.selectedIndex >= 0) info.selected = cap(html.value, TEXT);
    }
    const form = control ? html.form : null;
    if (form) {
      let n = formIndex.get(form);
      if (n === undefined && forms.length < FORMS) {
        n = forms.length;
        formIndex.set(form, n);
        forms.push({ method: String(form.method), action: cap(form.action, ACTION) });
      }
      if (n !== undefined) info.form = n;
    }
    return info;
  });
  return { elements, forms };
}

/** Elements whose own click a surrounding `<label>` does not pass on to its control. */
const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "label"]);

/**
 * What a click on `el` would reach that an agent may not click (F9): a text-like field, a
 * select, an editable root or a file field, else null.
 * @param {Element | null | undefined} el
 */
function fieldOf(el) {
  if (!el) return null;
  const html = /** @type {any} */ (el);
  if (el.localName === "input") {
    if (html.type === "file") return "file";
    if (NO_VALUE.has(html.type) || html.type === "hidden") return null;
    return "text";
  }
  if (el.localName === "textarea") return "text";
  if (el.localName === "select") return "select";
  if (html.isContentEditable) return "editable";
  return null;
}

/**
 * The control a click on `el` also activates: a `<label>`'s, when `el` is the label or plain
 * content inside it (a click on a label clicks or focuses its control).
 * @param {Element} el
 * @returns {Element | null}
 */
function labelledControl(el) {
  const label = /** @type {any} */ (el.closest("label"));
  if (!label?.control || label.control === el) return null;
  if (el !== label && INTERACTIVE.has(el.localName)) return null;
  return label.control;
}

/**
 * How many fields a submission by `submitter` sends (F15): the form's enabled, named controls,
 * checkboxes and radios only when checked, and of the buttons only the submitter.
 * @param {any} form @param {any} submitter
 */
function fieldCount(form, submitter) {
  let n = 0;
  for (const el of form.elements) {
    if (!el.name || el.matches(":disabled") || el.closest("datalist")) continue;
    if (el.localName === "fieldset" || el.localName === "output" || el.localName === "object") {
      continue;
    }
    if (el.localName === "button" || BUTTON_TYPES.has(el.type)) {
      if (el === submitter) n++;
    } else if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked) n++;
    } else {
      n++;
    }
  }
  return n;
}

/**
 * Where a submission by `submitter` (or by the form's own script, without one) goes: the
 * button's `formmethod` and `formaction` when it has them, else the form's (F15). A button's
 * `formAction` is the document's URL when it has no attribute, so the attribute decides.
 * @param {any} form @param {any} [submitter]
 * @returns {{ method: string, action: string }}
 */
export function destinationOf(form, submitter) {
  const method = submitter?.hasAttribute("formmethod") ? submitter.formMethod : form.method;
  const action = submitter?.hasAttribute("formaction") ? submitter.formAction : form.action;
  return { method: String(method ?? ""), action: cap(action, ACTION) };
}

/**
 * The submit control a click on `el` presses, and its form: `el` itself, the button it is
 * inside, or its label's control (F15).
 * @param {Element} el
 * @returns {{ submitter: any, form: any, method: string, action: string } | null}
 */
export function submitOf(el) {
  const candidates = [el, el.closest("button"), labelledControl(el)];
  for (const c of candidates) {
    if (!c) continue;
    const html = /** @type {any} */ (c);
    if (!html?.form) continue;
    const { method, action } = destinationOf(html.form, html);
    const control = { localName: c.localName, type: html.type, inForm: true, method };
    if (!isSubmitControl(control)) continue;
    return { submitter: html, form: html.form, method, action };
  }
  return null;
}

const XLINK = "http://www.w3.org/1999/xlink";

/**
 * The address of the link a click on `el` follows, resolved: an HTML `a` or `area` with an
 * href, or an SVG `a` with `href` or `xlink:href`, the element or one around it; else null.
 * @param {Element} el
 * @returns {string | null}
 */
function linkHrefOf(el) {
  for (
    let node = el.closest("a, area");
    node;
    node = node.parentElement?.closest("a, area") ?? null
  ) {
    const html = /** @type {any} */ (node);
    if (typeof html.href === "string") {
      if (node.hasAttribute("href")) return html.href;
      continue;
    }
    const raw = node.getAttribute("href") ?? node.getAttributeNS(XLINK, "href");
    if (raw === null) continue;
    try {
      return new URL(raw, node.baseURI).href;
    } catch {
      return raw; // not a URL: the parent refuses what it cannot parse
    }
  }
  return null;
}

/**
 * The element now, as a click on it would find it (F4, F9, F10, F15), for core's
 * `parseActTarget`: its kind and text, whether it is disabled, a field the click would reach,
 * the link it would follow, and the form it would submit.
 * @param {Element | null | undefined} el
 * @returns {Record<string, unknown>}
 */
export function actTargetOf(el) {
  if (!el?.isConnected) return { alive: false };
  const html = /** @type {any} */ (el);
  const kind = kindOf(el);
  /** @type {Record<string, unknown>} */
  const out = { alive: true, kind, text: cap(textOf(el, kind), TEXT) };
  if (el.localName === "input" || el.localName === "button") out.type = cap(html.type, 32);
  if (el.matches(":disabled")) out.disabled = true;
  const field = fieldOf(el) ?? fieldOf(labelledControl(el));
  if (field) out.field = field;
  const href = linkHrefOf(el);
  if (href !== null) out.href = cap(href, ACTION);
  const submit = submitOf(el);
  if (submit) {
    out.submit = {
      method: submit.method,
      action: submit.action,
      fields: fieldCount(submit.form, submit.submitter),
    };
  }
  return out;
}

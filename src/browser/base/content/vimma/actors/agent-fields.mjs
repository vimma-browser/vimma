/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What an agent's `vimma_elements` says of each element (docs/specs/mcp-forms.md F5, F6;
// security.md M31), and what a `vimma_activate` click on one would reach (F9, F10, F15). Runs in
// the content process, in VimmaChild, in the element's own frame. Reads only: nothing here
// focuses, clicks or changes an element. The parent checks every field again (core
// agent-element.mjs, agent-act.mjs) and builds the list. Before an agent's screenshot, the same
// rules say whether a sensitive field with a value is on screen (F21), and before a step that
// may pay or send a form, whether the page shows a payment card field, what the pressed control
// says, the total the page states before it and what the form sends (docs/specs/
// mcp-checkpoints.md).
//
// A field is sensitive, and its value is never read into the reply, when it is or was ever a
// password field, when the page draws it as dots (`-webkit-text-security`), when its autocomplete
// field name is a password, one-time-code or payment card one, or when Firefox's form autofill
// heuristics infer a payment card field name for it (in a card form, also a field they leave to
// their machine-learning model). A failure of the heuristics makes every field of that form
// sensitive: it refuses rather than fills.

import { IDENTITY_FIELDS, isStatedTotal } from "../core/agent-checkpoint.mjs";
import { isSensitiveAutocomplete, isSubmitControl } from "../core/agent-element.mjs";
import { isHTML, isHTMLElement, linkText } from "./hint-collect.mjs";

/**
 * @typedef {"AutofillFormFactory" | "FormAutofillHeuristics" | "FormAutofillUtils"} LazyName
 */
const lazy = /** @type {Lazy<LazyName>} */ ({});
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
      if (!isHTML(el, "input")) break;
      if (BUTTON_TYPES.has(el.type)) return "button";
      if (el.type === "checkbox" || el.type === "radio") return el.type;
      return "field";
  }
  if (isHTMLElement(el) && el.isContentEditable) return "field";
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
  if (isHTML(el, "input") && BUTTON_TYPES.has(el.type)) {
    return oneLine(el.value || el.getAttribute("alt") || el.getAttribute("aria-label") || "");
  }
  if (isControl(el, kind) || (kind === "field" && isHTMLElement(el) && el.isContentEditable)) {
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
  const labels = labelableOf(el)?.labels ?? [];
  const text = oneLine([...labels].map((l) => l.innerText ?? l.textContent ?? "").join(" "));
  return text || oneLine(el.getAttribute("placeholder") ?? "");
}

/**
 * `el` as one of the elements a `<label>` can label (HTML's labelable elements), else null.
 * @param {Element} el
 */
function labelableOf(el) {
  return isHTML(el, "input") ||
    isHTML(el, "select") ||
    isHTML(el, "textarea") ||
    isHTML(el, "button") ||
    isHTML(el, "meter") ||
    isHTML(el, "output") ||
    isHTML(el, "progress")
    ? el
    : null;
}

/**
 * `el` as a form field (an HTML input, select or text area), else null.
 * @param {Element | null | undefined} el
 */
function fieldElementOf(el) {
  return isHTML(el, "input") || isHTML(el, "select") || isHTML(el, "textarea") ? el : null;
}

/**
 * The field name of `el`'s autocomplete attribute as Firefox parses it, undefined for an element
 * that is no form field. Throws as getAutocompleteInfo does.
 * @param {Element} el
 */
function autocompleteOf(el) {
  return fieldElementOf(el)?.getAutocompleteInfo()?.fieldName;
}

/**
 * The form `el` belongs to, for any element that has one (a form control, a label, a legend);
 * null for any other.
 * @param {Element} el
 */
export function formOf(el) {
  const form = "form" in el ? el.form : null;
  return isHTML(form, "form") ? form : null;
}

/** Selector of the headings a product card names its product in. */
const HEADINGS = "h1, h2, h3, h4, h5, h6, [role='heading']";
/** How many ancestors up a card's heading is looked for: product cards rarely nest deeper. */
const CARD_DEPTH = 8;

/** How many of an `aria-labelledby`'s ids are read: a name rarely joins more than a few. */
const LABELLEDBY_IDS = 8;
/** How many nodes one `aria-labelledby` text is gathered from, so a page's whole body costs little. */
const LABELLEDBY_NODES = 2048;
/**
 * Subtrees whose text is never part of a name: script and style source (a page's inline state
 * can hold account data), and what a user writes in a field or a rich text editor.
 */
const NOT_NAME = "script, style, noscript, template, textarea, select, [contenteditable]";

/** @param {Node | undefined} n @returns {n is Text} */
const isText = (n) => n?.nodeType === 3; /* Node.TEXT_NODE */
/** @param {Node | undefined} n @returns {n is Element} */
const isElement = (n) => n?.nodeType === 1; /* Node.ELEMENT_NODE */

/**
 * The text of `node` as part of an accessible name: its text nodes, hidden ones included, but
 * none inside NOT_NAME, gathered until `max` characters or LABELLEDBY_NODES nodes.
 * @param {Element} node @param {number} max
 */
function labelTextOf(node, max) {
  if (node.matches(NOT_NAME)) return "";
  let out = "";
  let seen = 0;
  /** @type {Node[]} iterative: a page may nest deeper than the stack allows */
  const stack = [...node.childNodes].reverse();
  while (stack.length && out.length < max && seen++ < LABELLEDBY_NODES) {
    const n = stack.pop();
    if (isText(n)) out += n.data;
    else if (isElement(n) && !n.matches(NOT_NAME)) {
      for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
    }
  }
  return cap(out, max);
}

/**
 * @param {Node} root
 * @returns {root is Document | DocumentFragment}
 */
const hasIds = (root) =>
  root.nodeType === 9 /* Node.DOCUMENT_NODE */ ||
  root.nodeType === 11; /* Node.DOCUMENT_FRAGMENT_NODE */

/**
 * A target's accessible label: the text of the elements its `aria-labelledby` names (hidden ones
 * too, as a screen reader reads them, but never script, style or a field's content), else its
 * `aria-label`. A shop's add button that shows only `+` names its product here (issue #693).
 * The pay check reads it too (mcp-checkpoints C6), so the model is never shown a name that the
 * checkpoint does not read.
 * @param {Element} el
 */
function ariaLabelOf(el) {
  const ids = (el.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [])
    .filter(Boolean)
    .slice(0, LABELLEDBY_IDS);
  const root = el.getRootNode();
  /** @type {string[]} */
  const named = [];
  let length = 0;
  for (const id of ids) {
    if (length >= TEXT) break;
    // A document or a shadow root; the root of a detached subtree has no ids to look up.
    const n = hasIds(root) ? root.getElementById(id) : null;
    if (!n || n === el) continue;
    const t = labelTextOf(n, TEXT - length);
    named.push(t);
    length += t.length + 1;
  }
  return oneLine(named.join(" ")) || oneLine(el.getAttribute("aria-label") ?? "");
}

/**
 * The heading of the card `el` is in: that of the nearest ancestor holding exactly one heading.
 * An ancestor with more is a list of cards, whose headings belong to other cards: none.
 * @param {Element} el
 * @param {Map<Element, Element | null | false>} seen  each ancestor's lone heading (null: none,
 *   false: several), shared across one list: repeated buttons share their ancestors
 */
function cardHeadingOf(el, seen) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < CARD_DEPTH; depth++, node = node.parentElement) {
    let lone = seen.get(node);
    if (lone === undefined) {
      const headings = node.querySelectorAll(HEADINGS);
      lone = headings.length > 1 ? false : (headings[0] ?? null);
      seen.set(node, lone);
    }
    if (lone === false) return "";
    if (lone) {
      // innerText is HTML's: an SVG or MathML heading has only its text content.
      return oneLine(cap(isHTMLElement(lone) ? lone.innerText : lone.textContent, TEXT));
    }
  }
  return "";
}

/**
 * Give each element whose kind, text and caption repeat in `infos` its card's heading as (the
 * start of) its caption, so that a row of identical "Add" buttons says which product each adds.
 * @param {Element[]} els @param {AgentElementInfo[]} infos  in the same order
 */
function nameRepeats(els, infos) {
  const key = (/** @type {AgentElementInfo} */ i) => `${i.kind}\n${i.text}\n${i.caption ?? ""}`;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const i of infos) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
  /** @type {Map<Element, Element | null | false>} */
  const seen = new Map();
  infos.forEach((info, n) => {
    if ((counts.get(key(info)) ?? 0) < 2) return;
    const el = els[n];
    const heading = el ? cardHeadingOf(el, seen) : "";
    if (!heading || heading === info.text || info.caption?.includes(heading)) return;
    info.caption = cap(info.caption ? `${heading} · ${info.caption}` : heading, TEXT);
  });
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
    /** @type {FormLike | null} */
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
        const el = d.element;
        if (names.some((n) => lazy.FormAutofillUtils.isCreditCardField(n))) {
          if (el) out.add(el);
          card = true;
        } else if (!names.length && el) {
          undecided.push(el);
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
  if (isHTML(el, "input") && (el.hasBeenTypePassword || el.type === "password")) return true;
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
    return isSensitiveAutocomplete(autocompleteOf(el));
  } catch {
    return false;
  }
}

/**
 * Whether a form control shows a value: text in a field or text area (a number field's text it
 * cannot parse, an autofill preview), a select's choice other than the page's own default. A file field's value is a fake path and a button's its text.
 * @param {Element} el
 */
function showsValue(el) {
  if (isHTML(el, "textarea")) return el.value !== "";
  if (isHTML(el, "input")) {
    if (NO_VALUE.has(el.type) || el.type === "hidden") return false;
    // A number field shows text it cannot parse with an empty value, and form autofill's
    // preview shows text before it is a value.
    return el.value !== "" || el.validity.badInput || !!el.previewValue;
  }
  if (isHTML(el, "select")) {
    const chosen = el.selectedOptions[0];
    if (!chosen || chosen.value === "") return false;
    const options = [...el.options];
    return chosen !== (options.find((o) => o.defaultSelected) ?? options[0]);
  }
  return false;
}

/**
 * Whether a sensitive field (F6) with a value is in `win`'s viewport, before an agent's
 * screenshot (docs/specs/mcp-forms.md F21): a card number the user typed shows in clear, and the
 * element list keeps such values from the agent too. Every form control of the document and its
 * shadow trees (open and closed) is visited, not only those a click reaches, and one whose box
 * meets the viewport counts even if the page hides it otherwise, so that a doubt refuses.
 * @param {Window} win
 * @returns {boolean}
 */
export function sensitiveValueShown(win) {
  const doc = win.document;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  /** @type {Element[]} */
  const shown = [];
  /** @param {Node} root */
  const visit = (root) => {
    const walker = doc.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = /** @type {Element} */ (node);
      if (["input", "select", "textarea"].includes(el.localName) && showsValue(el)) {
        const r = el.getBoundingClientRect();
        const onScreen =
          r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
        if (onScreen) shown.push(el);
      }
      const shadow = el.openOrClosedShadowRoot;
      if (shadow) visit(shadow);
    }
  };
  visit(doc);
  if (!shown.length) return false;
  if (shown.some(plainlySensitive)) return true;
  const cards = cardFields(shown);
  return shown.some((el) => cards.has(el));
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
    const kind = kindOf(el);
    /** @type {AgentElementInfo} */
    const info = { kind, text: cap(textOf(el, kind), TEXT) };
    const field = fieldElementOf(el);
    const control = field ?? (isHTML(el, "button") ? el : null);
    if (isHTML(el, "input") || isHTML(el, "button")) info.type = cap(el.type, 32);
    else if (el.localName === "textarea") info.type = "textarea";
    else if (kind === "field" && isHTMLElement(el) && el.isContentEditable) {
      info.type = "contenteditable";
    }
    if (control?.name) info.name = cap(control.name, TEXT);
    if (["input", "select", "textarea"].includes(el.localName)) {
      let auto = "";
      try {
        auto = String(autocompleteOf(el) ?? "");
      } catch {
        // an element without autocomplete info: none
      }
      if (auto) info.autocomplete = cap(auto, 64);
      const caption = captionOf(el);
      if (caption) info.caption = cap(caption, TEXT);
      if (field?.required) info.required = true;
      if (field && !isHTML(field, "select") && field.readOnly) info.readonly = true;
    } else {
      // A button, link or other target: its accessible label when the text does not say it.
      const caption =
        ((kind === "checkbox" || kind === "radio") && captionOf(el)) || ariaLabelOf(el);
      if (caption && caption !== info.text) info.caption = cap(caption, TEXT);
    }
    if (el.matches(":disabled")) info.disabled = true;
    if (isHTML(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
      info.checked = el.checked;
    } else if (kind === "checkbox" || kind === "radio") {
      info.checked = el.getAttribute("aria-checked") === "true";
    }
    const sensitive =
      ["input", "select", "textarea"].includes(el.localName) &&
      (plainlySensitive(el) || cards.has(el));
    if (sensitive) info.sensitive = true;
    if (!sensitive) {
      if (isHTML(el, "textarea") || (isHTML(el, "input") && !NO_VALUE.has(el.type))) {
        info.value = cap(el.value, VALUE);
      }
    }
    if (isHTML(el, "select")) {
      info.options = [...el.options].slice(0, OPTIONS).map((o) => ({
        value: cap(o.value, TEXT),
        text: cap(oneLine(o.text), TEXT),
      }));
      if (!sensitive && el.selectedIndex >= 0) info.selected = cap(el.value, TEXT);
    }
    const form = control?.form;
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
  nameRepeats(els, elements);
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
  if (isHTML(el, "input")) {
    if (el.type === "file") return "file";
    if (NO_VALUE.has(el.type) || el.type === "hidden") return null;
    return "text";
  }
  if (el.localName === "textarea") return "text";
  if (el.localName === "select") return "select";
  if (isHTMLElement(el) && el.isContentEditable) return "editable";
  return null;
}

/**
 * The control a click on `el` also activates: a `<label>`'s, when `el` is the label or plain
 * content inside it (a click on a label clicks or focuses its control).
 * @param {Element} el
 * @returns {Element | null}
 */
function labelledControl(el) {
  const label = el.closest("label");
  if (!isHTML(label, "label") || !label.control || label.control === el) return null;
  if (el !== label && INTERACTIVE.has(el.localName)) return null;
  return label.control;
}

/**
 * One of a form's listed elements (`form.elements`) as the HTML control it is; null for a
 * form-associated custom element, whose name and value its page script holds: an Xray shows
 * neither.
 * @param {Element} el
 */
function listedControl(el) {
  return (
    fieldElementOf(el) ??
    (isHTML(el, "button") || isHTML(el, "fieldset") || isHTML(el, "output") || isHTML(el, "object")
      ? el
      : null)
  );
}

/**
 * How many fields a submission by `submitter` sends (F15): the form's enabled, named controls,
 * checkboxes and radios only when checked, and of the buttons only the submitter.
 * @param {HTMLFormElement} form @param {Submitter | null} submitter
 */
function fieldCount(form, submitter) {
  let n = 0;
  for (const listed of form.elements) {
    const el = listedControl(listed);
    if (!el?.name || el.matches(":disabled") || el.closest("datalist")) continue;
    if (el.localName === "fieldset" || el.localName === "output" || el.localName === "object") {
      continue;
    }
    if (el.localName === "button" || BUTTON_TYPES.has(el.type)) {
      if (el === submitter) n++;
    } else if (isHTML(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
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
 * @param {HTMLFormElement} form @param {Submitter | null} [submitter]
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
 * @returns {{ submitter: Submitter, form: HTMLFormElement, method: string, action: string }
 *   | null}
 */
export function submitOf(el) {
  const candidates = [el, el.closest("button"), labelledControl(el)];
  for (const c of candidates) {
    // Only a button or an input submits (core isSubmitControl).
    const submitter = isHTML(c, "button") || isHTML(c, "input") ? c : null;
    const form = submitter?.form;
    if (!submitter || !form) continue;
    const { method, action } = destinationOf(form, submitter);
    const control = { localName: submitter.localName, type: submitter.type, inForm: true, method };
    if (!isSubmitControl(control)) continue;
    return { submitter, form, method, action };
  }
  return null;
}

/** @typedef {HTMLButtonElement | HTMLInputElement} Submitter */

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
    if (isHTML(node, "a") || isHTML(node, "area")) {
      if (node.hasAttribute("href")) return node.href;
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
 * What actTargetOf answers; the parent checks it again (core parseActTarget).
 * @typedef {{ alive: boolean, kind?: string, text?: string, type?: string, disabled?: true,
 *   field?: string, href?: string,
 *   submit?: { method: string, action: string, fields: number } }} ActTargetRaw
 */

/**
 * The element now, as a click on it would find it (F4, F9, F10, F15), for core's
 * `parseActTarget`: its kind and text, whether it is disabled, a field the click would reach,
 * the link it would follow, and the form it would submit.
 * @param {Element | null | undefined} el
 * @returns {ActTargetRaw}
 */
export function actTargetOf(el) {
  if (!el?.isConnected) return { alive: false };
  const kind = kindOf(el);
  /** @type {ActTargetRaw} */
  const out = { alive: true, kind, text: cap(textOf(el, kind), TEXT) };
  if (isHTML(el, "input") || isHTML(el, "button")) out.type = cap(el.type, 32);
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

// ---------------------------------------------------------------------------------------------
// `vimma_fill` (docs/specs/mcp-forms.md F12-F14; security.md M27).

/**
 * Why a field is sensitive now (F6), or null: `password` when it is or was ever a password field
 * or the page draws it as dots, `code` or `card` by its autocomplete field name, `card` when form
 * autofill's heuristics infer a payment card field for it, or every field of its group when they
 * fail.
 * @param {Element} el
 * @returns {"password" | "code" | "card" | null}
 */
export function secretOf(el) {
  if (!["input", "select", "textarea"].includes(el.localName)) return null;
  if (plainlySensitive(el)) {
    let name = "";
    try {
      name = String(autocompleteOf(el) ?? "");
    } catch {
      // no autocomplete info: a password field by its type or its dots
    }
    if (name === "one-time-code") return "code";
    return name.startsWith("cc-") ? "card" : "password";
  }
  return cardFields([el]).has(el) ? "card" : null;
}

/**
 * What a field is to a fill (F12, F13): how it would be set, or what it is instead.
 * @param {Element | null | undefined} el
 */
function fillFieldOf(el) {
  if (!el) return "none";
  if (isHTML(el, "input")) {
    if (el.type === "file") return "file";
    if (el.type === "hidden") return "hidden";
    if (el.type === "checkbox" || el.type === "radio") return el.type;
    return BUTTON_TYPES.has(el.type) ? "none" : "text";
  }
  if (isHTML(el, "textarea")) return "textarea";
  if (isHTML(el, "select")) return "select";
  return isHTMLElement(el) && el.isContentEditable ? "editable" : "none";
}

/**
 * The option of a select that a fill's value names: by its value, else by its exact text.
 * Disabled options are never chosen, as the user cannot choose them.
 * @param {HTMLSelectElement} select @param {string} value
 */
function optionOf(select, value) {
  // `:disabled` counts a disabled group too, which the user cannot choose from either.
  const options = [...select.options].filter((o) => !o.matches(":disabled"));
  return options.find((o) => o.value === value) ?? options.find((o) => o.text === value) ?? null;
}

/**
 * Whether a text input takes `value` as it is (F13): a date, number or color input empties a
 * value that does not parse, an email or URL input trims it. A detached input of the same type
 * in the same document tells, without touching the page's field or running page code.
 * @param {HTMLInputElement} input @param {string} value
 */
function inputTakes(input, value) {
  const probe = input.ownerDocument.createElement("input");
  probe.type = input.type;
  // A range clamps to its bounds and step, an email field with `multiple` takes a list.
  for (const name of ["min", "max", "step", "multiple"]) {
    const v = input.getAttribute(name);
    if (v !== null) probe.setAttribute(name, v);
  }
  probe.value = value;
  return probe.value === value;
}

/**
 * The form's default submission (F15): where its first submit button, or the form itself when
 * it has none, sends it, and how many fields it sends; null when it only closes a dialog or its
 * default button is disabled, which no implicit submission passes.
 * @param {HTMLFormElement} form
 * @returns {{ submitter: Submitter | null, method: string, action: string, fields: number }
 *   | null}
 */
export function defaultSubmitOf(form) {
  /** @type {Submitter | null} */
  let submitter = null;
  for (const e of form.elements) {
    if (
      (isHTML(e, "button") && e.type === "submit") ||
      (isHTML(e, "input") && (e.type === "submit" || e.type === "image"))
    ) {
      submitter = e;
      break;
    }
  }
  if (submitter?.matches(":disabled")) return null;
  const { method, action } = destinationOf(form, submitter);
  if (method === "dialog") return null;
  return { submitter, method, action, fields: fieldCount(form, submitter) };
}

/**
 * What fillTargetOf answers; the parent checks it again (core parseFillTarget).
 * @typedef {{ alive: boolean, kind?: string, field?: string, type?: string, name?: string,
 *   caption?: string, autocomplete?: string, secret?: "password" | "code" | "card",
 *   readonly?: true, disabled?: true, checked?: boolean, accepts?: boolean,
 *   submit?: { method: string, action: string, fields: number } }} FillTargetRaw
 */

/**
 * A field now, as a fill with `value` would find it (F4, F6, F12, F13), for core's
 * `parseFillTarget`: its kind, how it is set, why it is sensitive, its state, whether it takes
 * the value, and its form's default submission.
 * @param {Element | null | undefined} el @param {unknown} value
 * @returns {FillTargetRaw}
 */
export function fillTargetOf(el, value) {
  if (!el?.isConnected) return { alive: false };
  const kind = kindOf(el);
  const field = fillFieldOf(el);
  const control = fieldElementOf(el);
  /** @type {FillTargetRaw} */
  const out = { alive: true, kind, field };
  if (isHTML(el, "input")) out.type = cap(el.type, 32);
  else if (el.localName === "textarea") out.type = "textarea";
  if (["input", "select", "textarea"].includes(el.localName)) {
    if (control?.name) out.name = cap(control.name, TEXT);
    const caption = cap(textOf(el, kind) || captionOf(el), TEXT);
    if (caption) out.caption = caption;
    try {
      const auto = String(autocompleteOf(el) ?? "");
      if (auto) out.autocomplete = cap(auto, 64);
    } catch {
      // no autocomplete info
    }
    const secret = secretOf(el);
    if (secret) out.secret = secret;
    if (control && !isHTML(control, "select") && control.readOnly) out.readonly = true;
  }
  if (el.matches(":disabled")) out.disabled = true;
  if (isHTML(el, "input") && (field === "checkbox" || field === "radio")) out.checked = el.checked;
  if (typeof value === "string") {
    if (field === "text" && isHTML(el, "input")) out.accepts = inputTakes(el, value);
    else if (field === "select" && isHTML(el, "select")) out.accepts = !!optionOf(el, value);
    else if (field === "textarea") out.accepts = true;
  }
  const form = control?.form;
  const submit = form ? defaultSubmitOf(form) : null;
  if (submit) {
    out.submit = { method: submit.method, action: submit.action, fields: submit.fields };
  }
  return out;
}

/**
 * Sets a field as the user would (F12; security.md M27): text with `setUserInput`, which fires
 * `input` and `change` without focus; a select's option, then the select's own end of a user's
 * choice, which fires them as its popup does; a checkbox or radio with `click()` when its state
 * differs. Nothing is focused and no key event is sent. A file field, an editable root or a
 * sensitive field is never set, whatever the caller checked before.
 * @param {Element} el @param {string | boolean} value
 * @returns {boolean} whether the field holds the value afterwards (the page may put it back)
 */
export function fillField(el, value) {
  if (secretOf(el)) return false;
  // fillFieldOf's kinds: a text input or a text area, a select, a checkbox or radio input.
  const field = fillFieldOf(el);
  if (field === "text" || field === "textarea") {
    const text = isHTML(el, "input") || isHTML(el, "textarea") ? el : null;
    if (!text || typeof value !== "string") return false;
    text.setUserInput(value);
    return text.value === value;
  }
  if (field === "select" && isHTML(el, "select")) {
    if (typeof value !== "string") return false;
    const option = optionOf(el, value);
    if (!option) return false;
    // A multiple select gets that option alone, as the question showed it, not one more.
    const others = [...el.options].filter((o) => o !== option && o.selected);
    const changed = !option.selected || others.length > 0;
    for (const o of others) o.selected = false;
    option.selected = true;
    el.userFinishedInteracting(changed);
    return option.selected && el.selectedOptions.length === 1;
  }
  if ((field === "checkbox" || field === "radio") && isHTML(el, "input")) {
    if (typeof value !== "boolean") return false;
    if (el.checked !== value) el.click();
    return el.checked === value;
  }
  return false;
}

/** Elements a page shows as a dialog of its own, not the browser's tab-modal ones. */
const PAGE_DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** Elements whose text is code or markup, not text the page shows. */
const NOT_SHOWN = new Set(["script", "style", "noscript", "template"]);

/**
 * The page's text in `doc`, outside scripts and styles, as its length and a 32-bit FNV-1a hash:
 * enough to tell that it changed, without keeping a copy of a large page between polls.
 * @param {Document} doc
 */
function textMark(doc) {
  if (!doc.body) return "";
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  let hash = 0x811c9dc5;
  let length = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (NOT_SHOWN.has(node.parentElement?.localName ?? "")) continue;
    const text = /** @type {Text} */ (node).data;
    length += text.length;
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    }
  }
  return `${length}:${hash >>> 0}`;
}

/**
 * What a click could change in place in `doc` (#510), to compare with `pageChanges` after it:
 * the clicked element and the other listed elements as `vimma_elements` describes them (no
 * sensitive value, M31) and whether each is shown, the page's text, and its visible dialogs.
 * Kept in this process: the parent only ever gets the words of `pageChanges`.
 * @param {Document} doc @param {(Element | undefined)[]} listed  undefined: gone
 * @param {number} clicked  its index in `listed`
 */
export function pageMarks(doc, listed, clicked) {
  const live = /** @type {Element[]} */ (listed.filter((el) => el?.isConnected));
  const { elements } = describeAgentElements(live);
  /** @type {Map<Element, string>} */
  const described = new Map();
  live.forEach((el, i) => {
    const shown = el.checkVisibility?.() ?? true;
    described.set(el, JSON.stringify([elements[i], shown]));
  });
  const markOf = (/** @type {Element | undefined} */ el) => (el && described.get(el)) ?? "gone";
  return {
    clicked: markOf(listed[clicked]),
    listed: listed.filter((_, i) => i !== clicked).map(markOf),
    text: textMark(doc),
    dialogs: new Set(
      [...doc.querySelectorAll(PAGE_DIALOGS)].filter((el) => el.checkVisibility?.() ?? true),
    ),
  };
}

/**
 * Which parts of the page changed since `before` (#510), in core's fixed words
 * (ACTIVATE_CHANGES): a dialog counts when one is shown that was not before.
 * @param {ReturnType<typeof pageMarks>} before @param {ReturnType<typeof pageMarks>} now
 * @returns {string[]}
 */
export function pageChanges(before, now) {
  const changed = [];
  if (now.clicked !== before.clicked) changed.push("element");
  if (now.listed.some((mark, i) => mark !== before.listed[i])) changed.push("elements");
  if (now.text !== before.text) changed.push("text");
  if ([...now.dialogs].some((el) => !before.dialogs.has(el))) changed.push("dialog");
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Checkpoints (docs/specs/mcp-checkpoints.md C6, C7, Behaviour 4; security.md M33): what the
// payment and form questions show, read from the page without touching it. A card field's value
// is never read (F6).

/** An element bigger than this is a container, not the line that states a total. */
const TOTAL_TEXT_MAX = 300;
const TOTAL_CHILDREN_MAX = 12;

/**
 * Every input and select of `root` and its shadow trees, open and closed.
 * @param {Document} doc @param {Node} root
 * @returns {Element[]}
 */
function controlsIn(doc, root) {
  /** @type {Element[]} */
  const out = [];
  const walker = doc.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = /** @type {Element} */ (node);
    if (el.localName === "input" || el.localName === "select") out.push(el);
    const shadow = el.openOrClosedShadowRoot;
    if (shadow) out.push(...controlsIn(doc, shadow));
  }
  return out;
}

/**
 * Whether `doc` shows a payment card field (C6): one whose autocomplete field name is a card's
 * (`cc-*`), or that form autofill's heuristics infer as one. Only fields the page shows count, so
 * a card form a shop keeps hidden on every page does not make every click a payment; a failure
 * of the heuristics counts as one (cardFields), so that a doubt asks.
 * @param {Document} doc
 */
export function cardFieldShown(doc) {
  const shown = controlsIn(doc, doc).filter((el) => {
    if (isHTML(el, "input") && (NO_VALUE.has(el.type) || el.type === "hidden")) return false;
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!shown.length) return false;
  const named = shown.some((el) => {
    try {
      return String(autocompleteOf(el) ?? "").startsWith("cc-");
    } catch {
      return false;
    }
  });
  return named || cardFields(shown).size > 0;
}

/**
 * The text of the nearest element before `el` in reading order that states a total (C7), or of
 * the last one in the document when there is no `el` (a key step). Elements with many children
 * or much text are containers and are skipped, so the quote is the line that states it; an
 * element the page does not show has no rendered text and never matches.
 * @param {Document} doc @param {Element | null} el
 * @returns {string | undefined}
 */
export function totalBefore(doc, el) {
  if (!doc.body) return undefined;
  /** @type {string | undefined} */
  let found;
  const walker = doc.createTreeWalker(doc.body, 1 /* NodeFilter.SHOW_ELEMENT */, {
    acceptNode: (node) =>
      NOT_SHOWN.has(/** @type {Element} */ (node).localName)
        ? 2 /* NodeFilter.FILTER_REJECT */
        : 1 /* NodeFilter.FILTER_ACCEPT */,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === el) break;
    // SHOW_ELEMENT: every node is an element.
    const element = /** @type {Element} */ (node);
    if (element.childElementCount > TOTAL_CHILDREN_MAX) continue;
    const raw = node.textContent ?? "";
    if (raw.length > TOTAL_TEXT_MAX || !/\d/.test(raw)) continue;
    // innerText is HTML's: an SVG or MathML element has only its text content.
    const text = oneLine(isHTMLElement(element) ? element.innerText : raw);
    if (text && isStatedTotal(text)) found = text;
  }
  return found === undefined ? undefined : cap(found, TEXT);
}

/**
 * The control a step presses: for a click, the submit control it presses (`el`, the button it
 * is in, its label's control) or else `el`; for a form's default submission (`form`), the form's
 * default button, or null when it has none.
 * @param {Element} el @param {"click" | "form"} by
 * @returns {Element | null}
 */
function pressedBy(el, by) {
  if (by === "form") {
    const form = formOf(el);
    return form ? (defaultSubmitOf(form)?.submitter ?? null) : null;
  }
  return submitOf(el)?.submitter ?? el;
}

/**
 * What a payment's question needs of the control a step presses (C6, C7): its text, accessible
 * name, title and value, and the text of the total before it.
 * @param {Element | null | undefined} el @param {"click" | "form"} by
 * @returns {{ texts: string[], total?: string } | null} null: the element is gone
 */
export function payInfoOf(el, by) {
  if (!el?.isConnected) return null;
  const control = pressedBy(el, by);
  /** @type {string[]} */
  const texts = [];
  if (control) {
    const words = [
      textOf(control, kindOf(control)),
      // The accessible label, aria-labelledby first: the name the element list shows the model.
      ariaLabelOf(control),
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      isHTML(control, "input") || isHTML(control, "button") ? control.value : "",
    ];
    for (const w of words) {
      const t = cap(oneLine(String(w ?? "")), TEXT);
      if (t && !texts.includes(t)) texts.push(t);
    }
  }
  const total = totalBefore(/** @type {Document} */ (el.ownerDocument), control ?? el);
  return { texts: texts.slice(0, 4), ...(total ? { total } : {}) };
}

/** @typedef {HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} SentControl */

/** Fields a form's question gets at most; the rest are counted (core CHECKPOINT_CAPS). */
const SENT_MAX = 64;

/**
 * Input types someone types free text into (docs/specs/mcp-consequence.md K2); an input of a
 * type Firefox does not know is `text`. A search field is left out: what it sends is a search.
 */
const TEXT_TYPES = new Set(["text", "url", "email", "tel"]);

/**
 * The fields of `form` that hold a person's identity, contact or address (mcp-consequence K2): by
 * the autocomplete name the page gives, by `type=email` or `type=tel`, or by the name form
 * autofill's address heuristics infer. A failure of the heuristics marks every field, so that a
 * doubt asks.
 * @param {HTMLFormElement} form
 * @returns {Set<Element>}
 */
function identityFields(form) {
  /** @type {Set<Element>} */
  const out = new Set();
  /** @type {(HTMLInputElement | HTMLSelectElement)[]} */
  const fields = [];
  for (const c of form.elements) if (isHTML(c, "input") || isHTML(c, "select")) fields.push(c);
  for (const c of fields) {
    if (c.type === "email" || c.type === "tel") out.add(c);
    try {
      if (IDENTITY_FIELDS.includes(String(c.getAutocompleteInfo()?.fieldName ?? ""))) out.add(c);
    } catch {
      out.add(c);
    }
  }
  const first = fields[0];
  if (!first) return out;
  try {
    const formLike = lazy.AutofillFormFactory.createFromField(first);
    for (const d of lazy.FormAutofillHeuristics.getFormInfo(formLike, false) ?? []) {
      const names = /** @type {unknown[]} */ ([]).concat(d?.fieldName ?? []);
      if (d.element && names.some((n) => lazy.FormAutofillUtils.isAddressField(n))) {
        out.add(d.element);
      }
    }
  } catch (e) {
    console.error("vimma agent-checkpoint: form autofill heuristics", e);
    for (const c of fields) out.add(c);
  }
  return out;
}

/**
 * What a submission by the control a step presses sends (Behaviour 4): each named, enabled
 * field's name and value, as the form would send it, but for those in `skip` (the fields a fill
 * sets, which its question shows with their new values); a sensitive field (F6) by its name
 * only, never its value; a file field by its name; hidden fields counted, not listed. A field
 * someone types into is marked `text`, one of a person's identity `identity`, so that the parent
 * can tell a form that sends them from one that sends only the page's own values
 * (docs/specs/mcp-consequence.md K2).
 * @param {Element | null | undefined} el @param {"click" | "form"} by @param {Set<Element>} skip
 * @returns {{ fields: { name: string, value?: string, secret?: true, file?: true, text?: true,
 *   identity?: true, cut?: true }[], hidden: number, more: number } | null} null: it submits no form
 */
export function sentFieldsOf(el, by, skip) {
  if (!el?.isConnected) return null;
  const form = by === "form" ? formOf(el) : submitOf(el)?.form;
  const submit = form ? (by === "form" ? defaultSubmitOf(form) : submitOf(el)) : null;
  if (!form || !submit) return null;
  /** @type {{ name: string, value?: string, secret?: true, file?: true, text?: true,
   *   identity?: true, cut?: true }[]} */
  const fields = [];
  let hidden = 0;
  let more = 0;
  const identity = identityFields(form);
  /**
   * One field sent; `f.value` is the whole value, cut here.
   * @param {{ name: string, value?: string, secret?: true, file?: true }} f
   * @param {SentControl} [c] the field, for its marks
   */
  const add = (f, c) => {
    if (fields.length >= SENT_MAX) return more++;
    /** @type {{ name: string, value?: string, secret?: true, file?: true, text?: true,
     *   identity?: true, cut?: true }} */
    const out = { ...f };
    if (c && (c.localName === "textarea" || TEXT_TYPES.has(c.type))) out.text = true;
    if (c && identity.has(c)) out.identity = true;
    // What is past the cut is not known: a doubt asks (mcp-consequence K3). Judged on each value
    // sent, as the pressed button's and every chosen option's are not the field's own `value`.
    if ("value" in f) {
      const whole = String(f.value ?? "");
      out.value = cap(whole, VALUE);
      if (whole.length > VALUE) out.cut = true;
    }
    return fields.push(out);
  };
  for (const listed of form.elements) {
    const c = listedControl(listed);
    if (!c?.name || c.matches(":disabled") || c.closest("datalist") || skip.has(c)) continue;
    if (isHTML(c, "fieldset") || isHTML(c, "output") || isHTML(c, "object")) continue;
    const name = cap(c.name, TEXT);
    const input = isHTML(c, "input") ? c : null;
    const box = input?.type === "checkbox" || input?.type === "radio";
    if (c.localName === "button" || BUTTON_TYPES.has(c.type)) {
      // Of the buttons only the one pressed is sent; an image button's click point means nothing.
      if (c === submit.submitter && c.type !== "image") add({ name, value: c.value });
    } else if (c.type === "hidden") {
      hidden++;
    } else if (box && !input?.checked) {
      // an unchecked box sends nothing
    } else if (secretOf(c)) {
      add({ name, secret: true });
    } else if (box) {
      add({ name, value: c.value }, c);
    } else if (c.type === "file") {
      add({ name, file: true });
    } else if (isHTML(c, "select")) {
      for (const o of c.selectedOptions) add({ name, value: o.value }, c);
    } else {
      add({ name, value: c.value }, c);
    }
  }
  return { fields, hidden, more };
}

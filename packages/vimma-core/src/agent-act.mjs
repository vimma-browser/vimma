/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Agents acting on a page of the agent workspace (docs/specs/mcp-forms.md). Pure: the element
 * list `vimma_elements` returns (F2-F7; security.md M25, M31), with its labels and caps, and what
 * `vimma_activate` will click (F8-F10, F15; M26, M28, M29). The browser collects the elements
 * (ctl/AgentAct.sys.mjs) and wraps the list in the untrusted-content delimiters; every string in
 * it is the page's.
 */

import { AGENT_LINKS, cutTo, labelAgentLinks, shown } from "./agent-keys.mjs";
import { DEFAULT_HINT_CHARS } from "./hints.mjs";
import { ELEMENT_KINDS, ELEMENT_REPLY_CAPS, isSensitiveAutocomplete } from "./agent-element.mjs";

export {
  ELEMENT_KINDS,
  isSensitiveAutocomplete,
  isSubmitControl,
  parseAgentElement,
  parseAgentForms,
} from "./agent-element.mjs";

/** @import { AgentElementInfo } from "./agent-element.mjs" */

/**
 * F5: at most `max` targets a list, each text and caption cut at `text`, each value at `value`,
 * each href at `href` characters, at most `options` options a select and `forms` forms a list,
 * at most `bytes` of the reply line; labels live `ttlMs`, as `f`'s do (mcp-drive D12).
 */
export const AGENT_ELEMENTS = Object.freeze({
  max: AGENT_LINKS.max,
  text: AGENT_LINKS.text,
  value: 256,
  href: AGENT_LINKS.href,
  options: 50,
  forms: 64,
  bytes: 768 * 1024,
  ttlMs: AGENT_LINKS.ttlMs,
});

/**
 * One element as the parent collected it: where it is, the child's description, its href for a
 * link, the host of the frame of another site it is in, and its form (`key`: the frame and the
 * form's index there, which tells two forms apart across frames).
 * @typedef {{ rect: { x: number, y: number, width: number, height: number }, href?: string,
 *   info: AgentElementInfo, frame?: string,
 *   form?: { key: string, method: string, action: string } }} AgentElementTarget
 */

/**
 * The elements with their labels (F5): in reading order, at most AGENT_ELEMENTS.max, labelled
 * over the default hint characters as `f`'s links are; the rest dropped and counted.
 * @template {{ rect: { x: number, y: number, width: number, height: number } }} T
 * @param {readonly T[]} targets
 * @returns {{ elements: { label: string, target: T }[], dropped: number }}
 */
export function labelAgentElements(targets) {
  const { links, dropped } = labelAgentLinks(targets);
  return { elements: links, dropped };
}

/** @param {unknown} s @param {number} max  one line, shown as the list shows page text */
const line = (s, max) =>
  cutTo(
    shown(String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );

/** @param {unknown} s @param {number} max  a value: its line breaks kept as \n in JSON */
const valueText = (s, max) => cutTo(shown(String(s ?? "")), max);

/**
 * One line of the list: no page `<` appears literally, so no page string can spell a delimiter
 * in any escaping, and line and paragraph separators, which JSON.stringify leaves raw, are
 * escaped too, so a value cannot look like a line of its own (security.md M31). JSON.parse reads
 * them back as they were.
 * @param {unknown} o
 */
const jsonLine = (o) =>
  JSON.stringify(o)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

/**
 * One element's JSON object, keys in a fixed order: the label, kind and text; for a link its
 * href; the frame of another site; a field's details; its state; its form's number.
 * @param {string} label @param {AgentElementTarget} t @param {number | undefined} form
 */
function elementObject(label, t, form) {
  const i = t.info;
  const max = AGENT_ELEMENTS;
  /** @type {Record<string, unknown>} */
  const o = { label, kind: i.kind, text: line(i.text, max.text) };
  if (t.href) o.href = cutTo(shown(t.href).replace(/\s/g, ""), max.href);
  if (t.frame) o.frame = line(t.frame, 253);
  if (i.type !== undefined) o.type = line(i.type, 32);
  if (i.name !== undefined) o.name = line(i.name, max.text);
  if (i.autocomplete !== undefined) o.autocomplete = line(i.autocomplete, 64);
  if (i.caption) o.caption = line(i.caption, max.text);
  for (const key of /** @type {const} */ (["required", "disabled", "readonly"])) {
    if (i[key]) o[key] = true;
  }
  if (i.checked !== undefined) o.checked = i.checked;
  if (i.sensitive) {
    // F6: never a value or which option is chosen.
    o.sensitive = true;
  } else if (i.value !== undefined) {
    o.value = valueText(i.value, max.value);
  }
  if (i.options) {
    o.options = i.options
      .slice(0, max.options)
      .map((op) => ({ value: line(op.value, max.text), text: line(op.text, max.text) }));
  }
  if (!i.sensitive && i.selected !== undefined) o.selected = line(i.selected, max.text);
  if (form !== undefined) o.form = form;
  return o;
}

/**
 * The list's text (F5, security.md M31): the forms its elements name, numbered from 1 in the
 * order first named, then one element a line, each a JSON object. Elements past `maxBytes` of
 * the JSON-encoded reply are left out and counted, and so are forms only they named; at most
 * AGENT_ELEMENTS.forms forms, and an element of a form past them names none. The browser wraps
 * the text in the untrusted-content delimiters.
 * @param {readonly { label: string, target: AgentElementTarget }[]} elements
 * @param {number} maxBytes
 * @returns {{ text: string, omitted: number }}
 */
export function agentElementList(elements, maxBytes) {
  const encoder = new TextEncoder();
  /** The cost of one more line in the JSON string, with its \n. @param {string} s */
  const cost = (s) => encoder.encode(JSON.stringify(s)).length - 2 + 2;
  /** @type {Map<string, { n: number, line: string }>} */
  const forms = new Map();
  /** @type {string[]} */
  const lines = [];
  // Each line counts with a \n (2 bytes in JSON); the string's quotes take the first one's place.
  let bytes = 0;
  for (const { label, target } of elements) {
    const f = target.form;
    let form = f ? forms.get(f.key) : undefined;
    let formLine = null;
    if (f && !form && forms.size < AGENT_ELEMENTS.forms) {
      const n = forms.size + 1;
      formLine = jsonLine({
        form: n,
        method: line(f.method, 8),
        action: cutTo(shown(f.action).replace(/\s/g, ""), AGENT_ELEMENTS.href),
      });
      form = { n, line: formLine };
    }
    const own = jsonLine(elementObject(label, target, form?.n));
    const more = cost(own) + (formLine ? cost(formLine) : 0);
    if (bytes + more > maxBytes) break;
    bytes += more;
    if (f && formLine && form) forms.set(f.key, form);
    lines.push(own);
  }
  const text = [...[...forms.values()].map((f) => f.line), ...lines].join("\n");
  return { text, omitted: elements.length - lines.length };
}

// ---------------------------------------------------------------------------------------------
// `vimma_activate` (F8-F11, F15).

/**
 * Whether `label` can name an element of a list (F3): 1 to AGENT_LINKS.label of the default hint
 * characters, as the lists are labelled.
 * @param {unknown} label
 */
export function isAgentLabel(label) {
  if (typeof label !== "string" || !label || label.length > AGENT_LINKS.label) return false;
  return [...label].every((c) => DEFAULT_HINT_CHARS.includes(c));
}

/** What a click would reach that it refuses (F9): a text-like field, a select, an editable root
 * or a file field, the element itself or the control of the `<label>` it is in. */
const ACT_FIELDS = Object.freeze(["text", "select", "editable", "file"]);
/** Form methods a submission can have. */
const SUBMIT_METHODS = new Set(["get", "post"]);

/**
 * @typedef {{ method: string, action: string, fields: number }} ActSubmit
 * @typedef {object} ActTarget  the element now, as its frame's child sees it just before a click
 * @property {boolean} alive  still in its document (F4)
 * @property {string} [kind]  one of ELEMENT_KINDS
 * @property {string} [text]
 * @property {string} [type]
 * @property {boolean} [disabled]
 * @property {string} [field]  one of ACT_FIELDS: what the click would reach that it refuses
 * @property {string} [href]  the link the click would follow, resolved
 * @property {ActSubmit} [submit]  the form a click would submit (F15)
 */

/** @param {unknown} v @param {number} max */
const isText = (v, max) => typeof v === "string" && v.length <= max;

/**
 * A child's account of an element before a click, checked like any reply from a content
 * process: a fresh copy with only the known fields, or null when anything is wrong.
 * @param {unknown} value
 * @returns {ActTarget | null}
 */
export function parseActTarget(value) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    if (typeof v.alive !== "boolean") return null;
    if (!v.alive) return { alive: false };
    if (typeof v.kind !== "string" || !ELEMENT_KINDS.includes(v.kind)) return null;
    if (!isText(v.text, ELEMENT_REPLY_CAPS.text)) return null;
    /** @type {ActTarget} */
    const out = { alive: true, kind: v.kind, text: /** @type {string} */ (v.text) };
    if (v.type !== undefined) {
      if (!isText(v.type, ELEMENT_REPLY_CAPS.type)) return null;
      out.type = /** @type {string} */ (v.type);
    }
    if (v.disabled !== undefined) {
      if (typeof v.disabled !== "boolean") return null;
      if (v.disabled) out.disabled = true;
    }
    if (v.field !== undefined) {
      if (typeof v.field !== "string" || !ACT_FIELDS.includes(v.field)) return null;
      out.field = v.field;
    }
    if (v.href !== undefined) {
      if (!isText(v.href, ELEMENT_REPLY_CAPS.action)) return null;
      out.href = /** @type {string} */ (v.href);
    }
    if (v.submit !== undefined) {
      const f = v.submit;
      if (typeof f !== "object" || f === null || Array.isArray(f)) return null;
      const { method, action, fields } = /** @type {Record<string, unknown>} */ (f);
      if (typeof method !== "string" || !SUBMIT_METHODS.has(method)) return null;
      if (!isText(action, ELEMENT_REPLY_CAPS.action)) return null;
      if (!Number.isSafeInteger(fields) || /** @type {number} */ (fields) < 0) return null;
      out.submit = {
        method,
        action: /** @type {string} */ (action),
        fields: /** @type {number} */ (fields),
      };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Why a click on `t` is refused, before anything is asked (F4, F9, F10; security.md M29), or
 * null when it may be asked. `crossSite`: its link goes to another site than the tab's, which
 * the parent decides by registrable domain (mcp-drive D18); `otherScheme`: its link is neither
 * http, https nor `javascript:` (a mail or app link would leave the agent workspace).
 * @param {string} label @param {ActTarget} t
 * @param {{ crossSite: boolean, otherScheme?: boolean }} where
 * @returns {string | null}
 */
export function actRefusal(label, t, { crossSite, otherScheme = false }) {
  if (!t.alive) return "that element is gone: call vimma_elements again";
  if (t.field === "file") {
    return `label "${label}" is a file field; Vimma never clicks it: ask the user to choose the file`;
  }
  if (t.field === "select") return `label "${label}" is a select: use vimma_fill`;
  if (t.field) return `label "${label}" is a field: use vimma_fill`;
  if (t.disabled) return `label "${label}" is disabled`;
  if (otherScheme) return "that link does not go to a web page; Vimma does not click it";
  if (crossSite) return "that link goes to another site: follow it with vimma_keys";
  return null;
}

/**
 * What a click is, for `:mcp log` and its question (F28): the label, the kind and the text, and
 * for a submit its method, destination and number of fields.
 * @param {string} label @param {ActTarget} t
 */
export function actDetail(label, t) {
  const text = cutTo(
    shown(String(t.text ?? ""))
      .replace(/\s+/g, " ")
      .trim(),
    AGENT_ELEMENTS.text,
  );
  const what = `${label} ${t.kind ?? "click"} "${text}"`;
  if (!t.submit) return what;
  const { method, action, fields } = t.submit;
  return `${what} → ${method.toUpperCase()} ${action} (${fields} field${fields === 1 ? "" : "s"})`;
}

// ---------------------------------------------------------------------------------------------
// `vimma_fill` (F12-F14).

/**
 * F14: at most `fields` fields a call, each value at most `value` characters (code points), no
 * control character but a line break, and that only in a text area.
 */
export const AGENT_FILL = Object.freeze({ fields: 32, value: 1024 });

/** What a field is to a fill (F12, F13): how it is set, or why it is not. */
const FILL_FIELDS = Object.freeze([
  "text",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "file",
  "editable",
  "hidden",
  "none",
]);
/** Why a field is sensitive, as the refusal names it (F6). */
const SECRETS = /** @type {Record<string, string>} */ ({
  password: "password",
  card: "payment card",
  code: "one-time-code",
});

/**
 * @typedef {object} FillTarget  a field now, as its frame's child sees it just before a fill
 * @property {boolean} alive  still in its document (F4)
 * @property {string} [kind]  one of ELEMENT_KINDS
 * @property {string} [field]  one of FILL_FIELDS
 * @property {string} [type]
 * @property {string} [name]
 * @property {string} [caption]
 * @property {string} [autocomplete]
 * @property {string} [secret]  `password`, `card` or `code`: never filled (F6)
 * @property {boolean} [disabled]
 * @property {boolean} [readonly]
 * @property {boolean} [checked]
 * @property {boolean} [accepts]  the value asked for parses for the field, or names an option
 * @property {ActSubmit} [submit]  where the field's form goes when submitted with its default
 *   button (F15)
 */

/**
 * A child's account of a field before a fill, checked like any reply from a content process: a
 * fresh copy with only the known fields, or null when anything is wrong.
 * @param {unknown} value
 * @returns {FillTarget | null}
 */
export function parseFillTarget(value) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    if (typeof v.alive !== "boolean") return null;
    if (!v.alive) return { alive: false };
    if (typeof v.kind !== "string" || !ELEMENT_KINDS.includes(v.kind)) return null;
    if (typeof v.field !== "string" || !FILL_FIELDS.includes(v.field)) return null;
    /** @type {Record<string, unknown>} */
    const out = { alive: true, kind: v.kind, field: v.field };
    for (const [key, max] of /** @type {const} */ ([
      ["type", ELEMENT_REPLY_CAPS.type],
      ["name", ELEMENT_REPLY_CAPS.name],
      ["caption", ELEMENT_REPLY_CAPS.caption],
      ["autocomplete", ELEMENT_REPLY_CAPS.autocomplete],
    ])) {
      if (v[key] === undefined) continue;
      if (!isText(v[key], max)) return null;
      out[key] = v[key];
    }
    if (v.secret !== undefined) {
      if (typeof v.secret !== "string" || !(v.secret in SECRETS)) return null;
      out.secret = v.secret;
    }
    for (const key of ["disabled", "readonly", "checked", "accepts"]) {
      if (v[key] === undefined) continue;
      if (typeof v[key] !== "boolean") return null;
      if (v[key] || key === "checked" || key === "accepts") out[key] = v[key];
    }
    if (v.submit !== undefined) {
      const parsed = parseActTarget({ alive: true, kind: v.kind, text: "", submit: v.submit });
      if (!parsed?.submit) return null;
      out.submit = parsed.submit;
    }
    return /** @type {FillTarget} */ (out);
  } catch {
    return null;
  }
}

/** Why an autocomplete field name makes a field sensitive (F6), or undefined. @param {unknown} name */
function secretOf(name) {
  if (!isSensitiveAutocomplete(name)) return undefined;
  if (name === "one-time-code") return "code";
  return String(name).startsWith("cc-") ? "card" : "password";
}

/** @param {unknown} s  an agent's value, shown in a refusal on one line */
const shownValue = (s) => cutTo(String(s).replace(/\s+/g, " "), AGENT_ELEMENTS.text);

/**
 * Why a fill of `t` with `value` is refused, before anything is asked (F6, F13; security.md
 * M27), or null when it may be asked. A field whose autocomplete name is sensitive is
 * sensitive, whatever the child says.
 * @param {string} label @param {FillTarget} t @param {string | boolean} value
 * @returns {string | null}
 */
export function fillRefusal(label, t, value) {
  if (!t.alive) return "that element is gone: call vimma_elements again";
  const secret = t.secret ?? secretOf(t.autocomplete);
  if (secret) {
    return `field "${label}" is a ${SECRETS[secret]} field; Vimma never fills it: ask the user to type it`;
  }
  switch (t.field) {
    case "file":
      return `field "${label}" is a file field; Vimma never fills it: ask the user to choose the file`;
    case "editable":
      return `label "${label}" is a rich text editor; Vimma does not fill those`;
    case "none":
      return `label "${label}" is a ${t.kind}, not a field: use vimma_activate`;
    case "hidden":
      return `field "${label}" is hidden`;
  }
  if (t.disabled) return `field "${label}" is disabled`;
  if (t.readonly) return `field "${label}" is read-only`;
  if (t.field === "checkbox") {
    return typeof value === "boolean"
      ? null
      : `field "${label}" is a checkbox: its value is true or false`;
  }
  if (t.field === "radio") {
    if (value === true) return null;
    return value === false
      ? `field "${label}" is a radio button: to unselect it, fill another of its group with true`
      : `field "${label}" is a radio button: its value is true`;
  }
  if (typeof value !== "string") return `field "${label}" takes text, not true or false`;
  if (t.field !== "textarea" && value.includes("\n")) {
    return `field "${label}" is one line: its value must not contain a line break`;
  }
  if (t.accepts === false) {
    return t.field === "select"
      ? `select "${label}" has no option with the value or text "${shownValue(value)}"`
      : `field "${label}" does not take "${shownValue(value)}" as a ${t.type ?? "value"}`;
  }
  return null;
}

/**
 * What a fill is, for `:mcp log` (F14, F28): each field's label, name and value in full (the
 * log is in memory only), and for a submit its method, destination and number of fields.
 * @param {readonly { label: string, name: string, value: string | boolean }[]} fields
 * @param {ActSubmit} [submit]
 */
export function fillDetail(fields, submit) {
  const what = fields
    .map(({ label, name, value }) => {
      const shown =
        typeof value === "boolean" ? (value ? "checked" : "unchecked") : JSON.stringify(value);
      const who = line(name, AGENT_ELEMENTS.text);
      return `${label}${who ? ` ${who}` : ""} = ${shown}`;
    })
    .join(", ");
  if (!submit) return what;
  const { method, action, fields: n } = submit;
  return `${what} → ${method.toUpperCase()} ${action} (${n} field${n === 1 ? "" : "s"})`;
}

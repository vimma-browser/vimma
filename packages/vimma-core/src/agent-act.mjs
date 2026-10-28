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

/**
 * Characters a fill's value must not hold because they draw nothing (F14; security.md M27):
 * format characters (zero-width, bidirectional, tags), line and paragraph separators, variation
 * selectors and fillers. Text hidden in them would pass the question unseen. The same list is in
 * vimma-ctl's mcp.rs.
 */
export const FILL_INVISIBLE = Object.freeze(
  /** @type {[number, number][]} */ ([
    [0xad, 0xad],
    [0x34f, 0x34f],
    [0x600, 0x605],
    [0x61c, 0x61c],
    [0x6dd, 0x6dd],
    [0x70f, 0x70f],
    [0x890, 0x891],
    [0x8e2, 0x8e2],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x206f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff0, 0xfffb],
    [0x110bd, 0x110bd],
    [0x110cd, 0x110cd],
    [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe0fff],
  ]),
);

/** Whether `s` holds a character of FILL_INVISIBLE. @param {string} s */
export function hasInvisible(s) {
  for (const c of s) {
    const n = /** @type {number} */ (c.codePointAt(0));
    if (FILL_INVISIBLE.some(([a, b]) => n >= a && n <= b)) return true;
  }
  return false;
}

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
  const secret =
    t.secret ?? secretOf(t.autocomplete) ?? (t.type === "password" ? "password" : undefined);
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

/**
 * `vimma_screenshot` (F18, F19): the image is at most `width` pixels wide and `height` high, its
 * base64 at most `base64` characters, so the reply fits the protocol's 1 MiB line; a PNG that
 * does not fit is encoded as JPEG at each of `jpeg`'s qualities in turn.
 */
export const AGENT_SCREENSHOT = Object.freeze({
  width: 1280,
  height: 16384,
  base64: 700 * 1024,
  jpeg: Object.freeze([0.8, 0.6]),
});

/**
 * `vimma_screenshot`'s default image (issue #584): a model pays for a screenshot by its pixels,
 * and some clients by its base64 too, so unless `full` is asked the image is at most `width`
 * pixels wide, and the smaller of a PNG and a JPEG at `jpeg[0]` (a page of flat colours is
 * smaller as a PNG, a photo as a JPEG), else a JPEG at the next quality.
 */
export const AGENT_SCREENSHOT_SMALL = Object.freeze({
  width: 1024,
  jpeg: Object.freeze([0.75, 0.5]),
});

/**
 * How a screenshot is encoded (F19, issue #584): the smallest of `smallest` whose base64 fits,
 * else the first of `then` that fits.
 * @param {boolean} full
 * @returns {{ smallest: { type: string, quality?: number }[],
 *   then: { type: string, quality?: number }[] }}
 */
export function screenshotEncodings(full) {
  const jpeg = (/** @type {number} */ quality) => ({ type: "image/jpeg", quality });
  const png = { type: "image/png" };
  if (full) return { smallest: [png], then: AGENT_SCREENSHOT.jpeg.map(jpeg) };
  const [first, ...rest] = AGENT_SCREENSHOT_SMALL.jpeg;
  return { smallest: [png, jpeg(/** @type {number} */ (first))], then: rest.map(jpeg) };
}

/**
 * The scale a viewport `width` by `height` CSS pixels is drawn at (F18): the device pixel ratio,
 * or less so the image is at most `maxWidth` (never more than AGENT_SCREENSHOT.width) pixels
 * wide and AGENT_SCREENSHOT.height high; null when there is nothing to draw. Without a height
 * only the width limits it.
 * @param {number} width @param {number} dpr @param {number} [height]
 * @param {number} [maxWidth]
 * @returns {number | null}
 */
export function screenshotScale(width, dpr, height = 1, maxWidth = AGENT_SCREENSHOT.width) {
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = dpr > 0 ? dpr : 1;
  const wide = Math.min(maxWidth, AGENT_SCREENSHOT.width);
  return Math.min(ratio, wide / width, AGENT_SCREENSHOT.height / height);
}

/**
 * Where each label of an element list is drawn on a screenshot (F20): at its element's top left
 * corner (top-frame CSS pixels, scaled), kept inside the image; a label whose element is not on
 * the image is left out.
 * @param {Map<string, { rect: { x: number, y: number, width: number, height: number } }>} labels
 * @param {number} scale
 * @param {{ width: number, height: number }} size  the image's, in pixels
 * @returns {{ label: string, x: number, y: number }[]}
 */
export function screenshotLabels(labels, scale, size) {
  const out = [];
  for (const [label, { rect }] of labels) {
    const x = rect.x * scale;
    const y = rect.y * scale;
    const right = (rect.x + rect.width) * scale;
    const bottom = (rect.y + rect.height) * scale;
    if (right <= 0 || bottom <= 0 || x >= size.width || y >= size.height) continue;
    out.push({ label, x: Math.max(0, x), y: Math.max(0, y) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// `vimma_console` (F22-F24; security.md M30, M31).

/**
 * F24: at most `errors` errors and `requests` failed requests a reply, each message cut at
 * `message` and each URL or file at `url` characters, the two lists at most `bytes` of the
 * reply line; at most `log` failed requests kept per agent tab.
 */
export const AGENT_CONSOLE = Object.freeze({
  errors: 100,
  requests: 100,
  message: 1000,
  url: 512,
  log: 100,
  bytes: 512 * 1024,
  frames: 100,
});

/** Where an error entry comes from: a script error's category, or the page's own console call. */
export const CONSOLE_SOURCES = Object.freeze([
  "script",
  "console",
  "csp",
  "mixed-content",
  "cors",
  "network",
  "other",
]);

/** nsIScriptError's flags (dom/bindings/nsIScriptError.idl): error is 0, warning 1, info 8. */
const WARNING_FLAG = 0x1;
const INFO_FLAG = 0x8;

/**
 * An nsIScriptError's level (F22): `error` or `warn`, as WebDriver BiDi's ConsoleListener maps
 * its flags; null for info and anything that is no flag word, which the reply leaves out.
 * @param {unknown} flags
 * @returns {"error" | "warn" | null}
 */
export function scriptErrorLevel(flags) {
  if (typeof flags !== "number" || !Number.isInteger(flags) || flags < 0) return null;
  if (flags & WARNING_FLAG) return "warn";
  if (flags & INFO_FLAG) return null;
  return "error";
}

/**
 * Where an nsIScriptError comes from, by Firefox's category for it (F22): a fixed word, so the
 * reply carries no category name of Firefox's that a later version might add.
 * @param {unknown} category
 * @returns {typeof CONSOLE_SOURCES[number]}
 */
export function scriptErrorSource(category) {
  const c = typeof category === "string" ? category : "";
  if (/\bCSP\b/.test(c)) return "csp";
  if (/mixed content/i.test(c)) return "mixed-content";
  if (/\bCORS\b/.test(c)) return "cors";
  if (/javascript/i.test(c)) return "script";
  if (/\b(SSL|Security|HTTPS|SRI|Network|Cookie)/i.test(c)) return "network";
  return "other";
}

/**
 * A console call's arguments as one message (F23; security.md M30): strings as they are,
 * numbers, booleans, bigints, null and undefined as their text, and any other value only as its
 * type in brackets (`[object]`, `[function]`), read with `typeof`, so no getter, `toString` or
 * proxy trap of the page runs.
 * @param {unknown} args
 */
export function consoleArgsText(args) {
  if (!Array.isArray(args)) return "";
  // A page may log a string of any size, or any number of arguments: each is cut, and the
  // joining stops, once there is more than a message's worth (the caller cuts it to size).
  const room = 2 * AGENT_CONSOLE.message;
  let out = "";
  for (let i = 0; i < args.length && out.length < room; i++) {
    const v = args[i];
    const type = typeof v;
    /** @type {string} */
    let text;
    if (type === "string") text = /** @type {string} */ (v).slice(0, room);
    else if (v === null) text = "null";
    else if (type === "number" || type === "boolean" || type === "bigint" || type === "undefined") {
      text = String(v);
    } else text = `[${type}]`;
    out = out ? `${out} ${text}` : text;
  }
  return out.slice(0, room);
}

/**
 * Channel statuses that end a request without its failing (F22): a navigation's cancel, the first
 * leg of a redirect, and a load handed to a download.
 */
const NOT_FAILED = Object.freeze([
  "NS_BINDING_ABORTED",
  "NS_BINDING_REDIRECTED",
  "NS_BINDING_RETARGETED",
]);

/**
 * Whether a stopped request failed (F22): an HTTP status of 400 or above, or a channel error by
 * its name; null when it did not.
 * @param {number} status  the response's HTTP status, 0 without a response
 * @param {string | null} error  the channel's status name, null when it succeeded
 * @returns {{ status?: number, error?: string } | null}
 */
export function requestFailure(status, error) {
  if (error && NOT_FAILED.includes(error)) return null;
  const bad = Number.isInteger(status) && status >= 400 && status <= 999;
  if (!bad && !error) return null;
  return { ...(bad ? { status } : {}), ...(error ? { error } : {}) };
}

/**
 * One error entry: its level and source, the message, the file, line and column it names, and
 * when it was logged (ms since the epoch).
 * @typedef {{ level: "error" | "warn", source: typeof CONSOLE_SOURCES[number], message: string,
 *   file: string, line: number, column: number, time: number }} ConsoleEntry
 */

/**
 * One failed request: method, URL, status or error, Firefox's content type of the request, time.
 * @typedef {{ method: string, url: string, status?: number, error?: string, type: string,
 *   time: number }} RequestEntry
 */

/** @param {unknown} n */
const isCountOf = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * An error entry from a frame's child (F22), checked like any reply from a content process: the
 * level, the source and the numbers must be what the child may send, and the strings are cut.
 * @param {unknown} raw
 * @returns {ConsoleEntry | null}
 */
export function parseConsoleEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (r.level !== "error" && r.level !== "warn") return null;
  if (!CONSOLE_SOURCES.includes(/** @type {any} */ (r.source))) return null;
  if (typeof r.message !== "string" || typeof r.file !== "string") return null;
  if (!isCountOf(r.line) || !isCountOf(r.column) || !isCountOf(r.time)) return null;
  return {
    level: r.level,
    source: /** @type {ConsoleEntry["source"]} */ (r.source),
    // Sliced first: a content process's string of any size is never spread whole.
    message: cutTo(r.message.slice(0, 4 * AGENT_CONSOLE.message), AGENT_CONSOLE.message),
    file: cutTo(r.file.slice(0, 4 * AGENT_CONSOLE.url), AGENT_CONSOLE.url),
    line: /** @type {number} */ (r.line),
    column: /** @type {number} */ (r.column),
    time: /** @type {number} */ (r.time),
  };
}

/**
 * `url` without a user name and password, which a script's or request's URL may carry and which
 * are never the agent's (security.md M30).
 * @param {string} url
 */
const withoutUserinfo = (url) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");

/**
 * A frame's entries as it answers them (F24): only those after `since`, newest first, at most
 * `max`, so that no frame sends more than one reply's worth to the parent.
 * @template {{ time: number }} T
 * @param {readonly T[]} entries @param {number} since @param {number} max
 * @returns {T[]}
 */
export function newestEntries(entries, since, max) {
  return entries
    .filter((e) => e.time > since)
    .sort((a, b) => b.time - a.time)
    .slice(0, max);
}

/** @param {ConsoleEntry} e */
const errorLine = (e) =>
  jsonLine({
    level: e.level,
    source: e.source,
    message: valueText(e.message, AGENT_CONSOLE.message),
    file: cutTo(withoutUserinfo(shown(e.file).replace(/\s/g, "")), AGENT_CONSOLE.url),
    line: e.line,
    column: e.column,
    time: e.time,
  });

/** @param {RequestEntry} r */
const requestLine = (r) =>
  jsonLine({
    method: line(r.method, 16),
    url: cutTo(withoutUserinfo(shown(r.url).replace(/\s/g, "")), AGENT_CONSOLE.url),
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.error !== undefined ? { error: line(r.error, 64) } : {}),
    type: line(r.type, 32),
    time: r.time,
  });

/**
 * The two lists of a reply (F22, F24; security.md M31): the entries newer than `since`, newest
 * first, at most AGENT_CONSOLE.errors and AGENT_CONSOLE.requests, one JSON object a line; past
 * `maxBytes` of the two JSON-encoded texts together the oldest entries of either are left out.
 * Every entry left out is counted in `dropped`. The browser wraps each text in the
 * untrusted-content delimiters.
 * @param {readonly ConsoleEntry[]} errors @param {readonly RequestEntry[]} requests
 * @param {number} since @param {number} maxBytes
 * @returns {{ errors: string, requests: string, dropped: number }}
 */
export function consoleLists(errors, requests, since, maxBytes) {
  const newest = (/** @type {{ time: number }} */ a, /** @type {{ time: number }} */ b) =>
    b.time - a.time;
  const e = errors.filter((x) => x.time > since).sort(newest);
  const r = requests.filter((x) => x.time > since).sort(newest);
  const total = e.length + r.length;
  const shownE = e
    .slice(0, AGENT_CONSOLE.errors)
    .map((x) => ({ time: x.time, text: errorLine(x), e: true }));
  const shownR = r
    .slice(0, AGENT_CONSOLE.requests)
    .map((x) => ({ time: x.time, text: requestLine(x), e: false }));
  const encoder = new TextEncoder();
  // Each line counts with its \n (2 bytes in JSON); newest first across both lists.
  let bytes = 4;
  /** @type {string[]} */
  const outE = [];
  /** @type {string[]} */
  const outR = [];
  for (const x of [...shownE, ...shownR].sort(newest)) {
    const cost = encoder.encode(JSON.stringify(x.text)).length - 2 + 2;
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    (x.e ? outE : outR).push(x.text);
  }
  return {
    errors: outE.join("\n"),
    requests: outR.join("\n"),
    dropped: total - outE.length - outR.length,
  };
}

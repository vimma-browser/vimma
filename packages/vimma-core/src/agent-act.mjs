/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Agents acting on a page of the agent workspace (docs/specs/mcp-forms.md). Pure: the element
 * list `vimma_elements` returns (F2-F7; security.md M25, M31), with its labels and caps. The
 * browser collects the elements (ctl/AgentAct.sys.mjs) and wraps the list in the
 * untrusted-content delimiters; every string in it is the page's.
 */

import { AGENT_LINKS, cutTo, labelAgentLinks, shown } from "./agent-keys.mjs";

export {
  ELEMENT_KINDS,
  isSensitiveAutocomplete,
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

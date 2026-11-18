/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `:siteunbind --save` and `:sitebind --delete` (docs/specs/site-unbind-command.md decision 10):
 * keys added to or removed from `[sites."<host>"] unbind` in config.toml text by editing those
 * lines alone, so every other line, comment and the layout stay byte for byte, as setTomlKeys
 * does for scalar keys. The result is parsed again and must equal the old file with only that
 * list changed, and must load: an edit the line scan got wrong is an error, never a changed file.
 */

import { parseConfig } from "./config.mjs";
import { formatConfigTemplate } from "./defaults.mjs";
import { locateKeys, parseToml, sameToml, tomlLiteral } from "./toml.mjs";

/**
 * @typedef {{ text: string | null, added: string[], already: string[], removed: string[] }
 *   | { error: string }} SiteEdit
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isTable = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether `line` is the header `[sites."<table>"]`, however it is quoted and spaced: the line
 * alone parsed as TOML must make exactly that table.
 * @param {string} line @param {string} table
 */
function isHeaderOf(line, table) {
  if (!/^[ \t]*\[[^[]/.test(line)) return false;
  const r = parseToml(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (!r.ok) return false;
  const sites = r.value.sites;
  if (Object.keys(r.value).length !== 1 || !isTable(sites)) return false;
  const keys = Object.keys(sites);
  return keys.length === 1 && keys[0] === table && isTable(sites[table]);
}

/**
 * An array value starting at `text[start]` (its `[`): each element's span and the comma after
 * it, the offset after the last thing that is not blank or a comment before `]`, and the offset
 * after `]`. Null for anything but a flat array of strings, which `unbind` is once it loads.
 * @param {string} text @param {number} start
 * @returns {{ elements: { start: number, end: number, comma: number }[], last: number,
 *   end: number } | null}
 */
function scanArray(text, start) {
  /** @type {{ start: number, end: number, comma: number }[]} */
  const elements = [];
  let last = start + 1;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
    else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "]") return { elements, last, end: i + 1 };
    else if (c === ",") {
      const e = elements[elements.length - 1];
      if (!e || e.comma >= 0) return null;
      e.comma = i;
      last = ++i;
    } else if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      for (;;) {
        if (j >= text.length) return null;
        if (c === '"' && text[j] === "\\") j += 2;
        else if (text.startsWith(quote, j)) break;
        else if (!triple && text[j] === "\n") return null;
        else j++;
      }
      // A triple-quoted string may end in more quotes than three ("""a"""").
      j += quote.length;
      while (triple && text[j] === c) j++;
      elements.push({ start: i, end: j, comma: -1 });
      last = i = j;
    } else return null;
  }
  return null;
}

/**
 * The offset where line `n` (1-based) of `text` starts.
 * @param {string} text @param {number} n
 */
function lineStart(text, n) {
  let at = 0;
  for (let k = 1; k < n; k++) at = text.indexOf("\n", at) + 1;
  return at;
}

/**
 * `text` without the line holding `at` when that line is now blank and was not before.
 * @param {string} text @param {number} at
 */
function dropBlankLine(text, at) {
  const from = text.lastIndexOf("\n", at - 1) + 1;
  const nl = text.indexOf("\n", at);
  const to = nl < 0 ? text.length : nl + 1;
  return /^[ \t]*\r?\n?$/.test(text.slice(from, to)) ? text.slice(0, from) + text.slice(to) : text;
}

/**
 * Keys added to, or removed from, `[sites."<table>"] unbind` in config.toml `text` (null when
 * the file does not exist: the template, for an addition). Each key is canonical (`ctrl+k`); one
 * the list has in another spelling (`<C-k>`) is the same key, so it is not added twice and every
 * spelling of a removed key goes. A list left empty loses its line, and a table left with nothing
 * but blank lines loses its header, since an empty table still replaces a parent domain's rule.
 * Refused when the file has errors now, writes the table some other way than its own header
 * (dotted keys, an inline table), or would not load, or would change anything else, after.
 * `text` is null in the result when nothing is to be written to a missing file.
 * @param {string | null} text
 * @param {string} table  as written in the file, or the new table's host
 * @param {{ add?: readonly string[], remove?: readonly string[] }} change
 * @param {{ mac?: boolean }} [options]
 * @returns {SiteEdit}
 */
export function editSiteUnbindText(text, table, { add = [], remove = [] }, { mac = false } = {}) {
  if (text === null && add.length === 0) return { text, added: [], already: [], removed: [] };
  const base = text ?? formatConfigTemplate();
  const now = parseConfig(base, { mac });
  const first = now.errors[0];
  if (first || !now.keymap) {
    const where = first?.line === undefined ? "" : `line ${first.line}: `;
    const what = first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "";
    return { error: `config.toml has errors; fix them first (:config): ${where}${what}` };
  }
  const keymap = now.keymap;
  const doc = /** @type {{ ok: true, value: Record<string, unknown> }} */ (parseToml(base)).value;
  const sites = isTable(doc.sites) ? doc.sites : {};
  const own = isTable(sites[table]) ? /** @type {Record<string, unknown>} */ (sites[table]) : null;
  const list = own && Array.isArray(own.unbind) ? /** @type {string[]} */ (own.unbind) : [];
  const canonical = (/** @type {string} */ k) => {
    const r = keymap.siteKey(k);
    return r.ok ? r.key : k;
  };
  const listed = list.map(canonical);
  const added = add.filter((k, i) => !listed.includes(k) && add.indexOf(k) === i);
  const already = add.filter((k, i) => listed.includes(k) && add.indexOf(k) === i);
  const removed = remove.filter((k, i) => listed.includes(k) && remove.indexOf(k) === i);
  if (added.length === 0 && removed.length === 0) return { text, added, already, removed };

  const leftAlone = {
    error: `config.toml writes [sites.${tomlLiteral(table)}] in a form this edit leaves alone; edit it there (:config)`,
  };
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const cr = eol === "\r\n" ? "\r" : "";
  const kept = list.filter((_, i) => !removed.includes(/** @type {string} */ (listed[i])));
  const want = [...kept, ...added];
  const literals = added.map(tomlLiteral);

  let out = base;
  const lines = base.split("\n");
  const headers = lines.flatMap((l, i) => (isHeaderOf(l, table) ? [i] : []));
  if (!own) {
    if (sites[table] !== undefined || headers.length) return leftAlone;
    const glue =
      base === "" || base.endsWith("\n\n") || base.endsWith("\r\n\r\n")
        ? ""
        : base.endsWith("\n")
          ? eol
          : eol + eol;
    out = `${base}${glue}[sites.${tomlLiteral(table)}]${eol}unbind = [${literals.join(", ")}]${eol}`;
  } else {
    if (headers.length !== 1) return leftAlone;
    const header = /** @type {number} */ (headers[0]);
    const where = locateKeys(base);
    if (!("unbind" in own)) {
      // After the table's last key: only `insert` can be there in a file that loads.
      const insertLine = "insert" in own ? where(["sites", table, "insert"]) : undefined;
      const after = insertLine === undefined ? header : insertLine - 1;
      lines.splice(after + 1, 0, `unbind = [${literals.join(", ")}]${cr}`);
      out = lines.join("\n");
    } else {
      const n = where(["sites", table, "unbind"]);
      if (n === undefined || n - 1 <= header) return leftAlone;
      const at = lineStart(base, n);
      const m = /^[ \t]*(?:unbind|"unbind"|'unbind')[ \t]*=[ \t]*\[/.exec(base.slice(at));
      if (!m) return leftAlone;
      const open = at + m[0].length - 1;
      // Removals first, one at a time from the end, scanning again after each.
      for (let i = list.length - 1; i >= 0; i--) {
        if (!removed.includes(/** @type {string} */ (listed[i]))) continue;
        const scan = scanArray(out, open);
        const e = scan?.elements[i];
        if (!scan || !e) return leftAlone;
        if (scan.elements.length === 1) {
          // The last key: the whole `unbind = [...]` line goes.
          const nl = out.indexOf("\n", scan.end);
          out = out.slice(0, at) + out.slice(nl < 0 ? out.length : nl + 1);
          continue;
        }
        /** @type {number} */
        let from = e.start;
        /** @type {number} */
        let to = e.end;
        if (e.comma >= 0) {
          to = e.comma + 1;
          while (out[to] === " " || out[to] === "\t") to++;
        } else {
          from = /** @type {{ comma: number }} */ (scan.elements[i - 1]).comma;
        }
        out = dropBlankLine(out.slice(0, from) + out.slice(to), from);
      }
      if (want.length === 0) {
        // The table goes too when nothing but blank lines is left in it.
        if (Object.keys(own).length === 1) {
          const rest = out.split("\n");
          let end = header + 1;
          while (end < rest.length - 1 && /^[ \t]*\r?$/.test(/** @type {string} */ (rest[end])))
            end++;
          const next = rest[end];
          if (end >= rest.length - 1 || (next !== undefined && /^[ \t]*\[/.test(next))) {
            rest.splice(header, end - header);
            out = rest.join("\n");
          }
        }
      } else if (literals.length) {
        const scan = scanArray(out, open);
        if (!scan) return leftAlone;
        const lastEl = scan.elements[scan.elements.length - 1];
        if (!lastEl) {
          out = `${out.slice(0, open + 1)}${literals.join(", ")}${out.slice(open + 1)}`;
        } else if (lastEl.comma < 0) {
          out = `${out.slice(0, lastEl.end)}, ${literals.join(", ")}${out.slice(lastEl.end)}`;
        } else if (out.slice(lastEl.comma, scan.end).includes("\n")) {
          // A list written one key a line gets one key a line, indented as its last.
          const from = out.lastIndexOf("\n", lastEl.start) + 1;
          const indent = /^[ \t]*/.exec(out.slice(from))?.[0] ?? "";
          const more = literals.map((l) => `${eol}${indent}${l},`).join("");
          out = `${out.slice(0, lastEl.comma + 1)}${more}${out.slice(lastEl.comma + 1)}`;
        } else {
          const more = literals.map((l) => ` ${l},`).join("");
          out = `${out.slice(0, lastEl.comma + 1)}${more}${out.slice(lastEl.comma + 1)}`;
        }
      }
    }
  }

  // The file as it must read now: the old one with only this list (or table) changed.
  const expected = structuredClone(doc);
  const expSites = /** @type {Record<string, unknown>} */ (
    isTable(expected.sites) ? expected.sites : (expected.sites = {})
  );
  const expTable = /** @type {Record<string, unknown>} */ (
    isTable(expSites[table]) ? expSites[table] : (expSites[table] = {})
  );
  if (want.length) expTable.unbind = want;
  else delete expTable.unbind;
  const after = parseToml(out);
  if (!after.ok) return leftAlone;
  if (!(table in /** @type {Record<string, unknown>} */ (after.value.sites ?? {}))) {
    delete expSites[table];
    if (Object.keys(expSites).length === 0 && !("sites" in after.value)) delete expected.sites;
  }
  if (!sameToml(after.value, expected)) return leftAlone;
  const loads = parseConfig(out, { mac }).errors[0];
  if (loads) {
    return { error: `config.toml would not load with the change: ${loads.path}: ${loads.message}` };
  }
  return { text: out, added, already, removed };
}

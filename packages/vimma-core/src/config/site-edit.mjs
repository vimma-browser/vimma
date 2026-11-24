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
import { locateKeys, parseToml, sameTomlValue, tomlLiteral } from "./toml.mjs";

/**
 * @typedef {{ text: string | null, added: string[], already: string[], removed: string[] }
 *   | { error: string }} SiteEdit
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isTable = (v) =>
  typeof v === "object" &&
  // Stryker disable next-line ConditionalExpression: TOML has no null, and every value here is parseToml's
  v !== null &&
  !Array.isArray(v);

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
  // A line that parses alone and starts with one `[` is a table header, which makes exactly one
  // table: one top-level key, and one key under `sites`. The key counts are guards, never false.
  // Stryker disable next-line ConditionalExpression: see above
  if (Object.keys(r.value).length !== 1 || !isTable(sites)) return false;
  const keys = Object.keys(sites);
  // `keys[0] === table` refuses a table name that is not a string; a lookup would coerce it.
  // Stryker disable next-line ConditionalExpression: see above
  return keys.length === 1 && keys[0] === table && isTable(sites[table]);
}

/**
 * An array value starting at `text[start]` (its `[`): each element's span and the comma after
 * it, and the offset after `]`. Null for anything but a flat array of strings, which `unbind` is
 * once it loads. `text` parsed (the file, or the file with keys removed from this list), so the
 * nulls for an unclosed list, string or a misplaced comma are guards, never reached.
 * @param {string} text @param {number} start
 * @returns {{ elements: { start: number, end: number, comma: number }[], end: number } | null}
 */
function scanArray(text, start) {
  /** @type {{ start: number, end: number, comma: number }[]} */
  const elements = [];
  let i = start + 1;
  // Past the end, c is undefined, and the last branch ends the scan.
  for (;;) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
    // A comment runs to its line break, which a list that parsed has (with none, i is -1).
    else if (c === "#") i = text.indexOf("\n", i);
    else if (c === "]") return { elements, end: i + 1 };
    else if (c === ",") {
      const e = elements[elements.length - 1];
      // Stryker disable next-line ConditionalExpression,LogicalOperator: a guard: the text parsed
      if (!e || e.comma !== -1) return null;
      e.comma = i++;
    } else if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      for (;;) {
        // Guards, as is the line break in a one-line string: the text parsed.
        // Stryker disable next-line ConditionalExpression: see above
        if (text[j] === undefined) return null;
        if (c === '"' && text[j] === "\\") j += 2;
        else if (text.startsWith(quote, j)) break;
        else if (
          // Stryker disable next-line ConditionalExpression: see above
          !triple &&
          // Stryker disable next-line StringLiteral: see above
          text[j] === "\n"
        )
          return null;
        else j++;
      }
      // A triple-quoted string may end in more quotes than three ("""a"""").
      j += quote.length;
      while (triple && text[j] === c) j++;
      elements.push({ start: i, end: j, comma: -1 });
      i = j;
    } else return null;
  }
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
  // The list's ] is after at: a line holding at with no line break after it holds the ] too.
  return nl !== -1 && /^[ \t]*\r?$/.test(text.slice(from, nl))
    ? text.slice(0, from) + text.slice(nl + 1)
    : text;
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
export function editSiteUnbindText(
  text,
  table,
  {
    add = [],
    // Stryker disable next-line ArrayDeclaration: the default removes nothing whatever it holds
    remove = [],
  },
  { mac = false } = {},
) {
  if (
    // Stryker disable next-line ConditionalExpression: the template has no [sites], so the edit below writes nothing either
    text === null &&
    add.length === 0
  )
    return { text, added: [], already: [], removed: [] };
  const base = text ?? formatConfigTemplate();
  const now = parseConfig(base, { mac });
  const first = now.errors[0];
  if (first) {
    // For an error without a line, which parseConfig has none of today.
    const where =
      // Stryker disable next-line ConditionalExpression: see above
      first.line === undefined
        ? // Stryker disable next-line StringLiteral: see above
          ""
        : `line ${first.line}: `;
    const what = `${first.path ? `${first.path}: ` : ""}${first.message}`;
    return { error: `config.toml has errors; fix them first (:config): ${where}${what}` };
  }
  // parseConfig gives a keymap whenever it gives no error.
  const keymap = /** @type {NonNullable<typeof now.keymap>} */ (now.keymap);
  // parseToml's tables have no prototype, so a table named `__proto__` (a page at
  // http://__proto__/) is an own key like any other, never Object.prototype; so are the tables
  // made here that a table's name is looked up in or written to.
  const parsed = () =>
    /** @type {{ ok: true, value: Record<string, unknown> }} */ (parseToml(base)).value;
  const doc = parsed();
  const sites = isTable(doc.sites) ? doc.sites : Object.create(null);
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
    // A site that loads is a table, so the file has no other form of it; but a header line in a
    // multi-line string cannot be told from the table's own.
    if (headers.length) return leftAlone;
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
      // A header line inside a multi-line string counts as the table's one header, and the key
      // can then sit in an inline table above it: leave that file to the user. `unbind` is in the
      // table, so locateKeys finds its line (never undefined), and a header line holds no key, so
      // `n - 1` never equals `header`.
      const n = where(["sites", table, "unbind"]);
      // Stryker disable next-line ConditionalExpression,EqualityOperator: see above
      if (n === undefined || n - 1 <= header) return leftAlone;
      const at = lineStart(base, n);
      const key = /[ \t]*(?:unbind|"unbind"|'unbind')[ \t]*=[ \t]*\[/y;
      key.lastIndex = at;
      const m = key.exec(base);
      if (!m) return leftAlone;
      const open = at + m[0].length - 1;
      // Removals first, one at a time from the end, scanning again after each.
      // Stryker disable next-line ArithmeticOperator: listed[list.length] is undefined, never removed
      for (let i = list.length - 1; i >= 0; i--) {
        if (!removed.includes(/** @type {string} */ (listed[i]))) continue;
        const scan = scanArray(out, open);
        // A guard: the scan finds the list it parsed to, key for key.
        // Stryker disable next-line OptionalChaining: see above
        const e = scan?.elements[i];
        // Stryker disable next-line ConditionalExpression,LogicalOperator: see above
        if (!scan || !e) return leftAlone;
        if (scan.elements.length === 1) {
          // The last key: the whole `unbind = [...]` line goes.
          const nl = out.indexOf("\n", scan.end);
          out = out.slice(0, at) + out.slice(nl === -1 ? out.length : nl + 1);
          continue;
        }
        /** @type {number} */
        let from = e.start;
        /** @type {number} */
        let to = e.end;
        if (e.comma !== -1) {
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
          // Defined whenever it is read: the test before it stops at the last line.
          const next = /** @type {string} */ (rest[end]);
          if (end >= rest.length - 1 || /^[ \t]*\[/.test(next)) {
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
        } else if (out.slice(open, scan.end).includes("\n")) {
          // A list written one key a line gets one key a line, indented as its last, after the
          // end of the last key's line so that a comment there stays on its key; a trailing
          // comma is kept or left out as the list has it.
          const from = out.lastIndexOf("\n", lastEl.start) + 1;
          // The blanks the line starts with: a match of [ \t]* is at 0, empty or not.
          const indent = /** @type {RegExpExecArray} */ (/[ \t]*/.exec(out.slice(from)))[0];
          const trailing = lastEl.comma !== -1;
          const tail = trailing ? lastEl.comma + 1 : lastEl.end;
          const close = scan.end - 1;
          const nl = out.indexOf("\n", tail);
          // Before the line break, or the ] when that comes first (no CR is just before a ]).
          let at = nl === -1 ? close : Math.min(nl, close);
          if (out[at - 1] === "\r") at--;
          const more = literals.map((l) => `${eol}${indent}${l}`).join(",");
          const lead = trailing ? "" : ",";
          const end = trailing ? "," : "";
          out = `${out.slice(0, tail)}${lead}${out.slice(tail, at)}${more}${end}${out.slice(at)}`;
        } else if (lastEl.comma === -1) {
          out = `${out.slice(0, lastEl.end)}, ${literals.join(", ")}${out.slice(lastEl.end)}`;
        } else {
          const more = literals.map((l) => ` ${l},`).join("");
          out = `${out.slice(0, lastEl.comma + 1)}${more}${out.slice(lastEl.comma + 1)}`;
        }
      }
    }
  }

  // The file as it must read now: the old one with only this list (or table) changed.
  const expected = parsed();
  const expSites = /** @type {Record<string, unknown>} */ (
    isTable(expected.sites) ? expected.sites : (expected.sites = Object.create(null))
  );
  const expTable = /** @type {Record<string, unknown>} */ (
    isTable(expSites[table]) ? expSites[table] : (expSites[table] = {})
  );
  if (want.length) expTable.unbind = want;
  else delete expTable.unbind;
  const after = parseToml(out);
  // A guard: the edits above put whole keys, commas and lines between the list's tokens, and a
  // line put inside a multi-line string still parses (the comparison refuses it).
  // Stryker disable next-line ConditionalExpression: see above
  if (!after.ok) return leftAlone;
  // The table may be gone only when this edit emptied it; any other loss fails the comparison.
  // (The edit above drops a header only then, so this test is a guard too.)
  // Stryker disable next-line ConditionalExpression,LogicalOperator: see above
  const emptied = want.length === 0 && Object.keys(expTable).length === 0;
  if (emptied && !Object.hasOwn(after.value.sites ?? {}, table)) {
    delete expSites[table];
    // Stryker disable next-line ConditionalExpression: a guard: the edit drops no other site's table
    if (Object.keys(expSites).length === 0 && !("sites" in after.value)) delete expected.sites;
  }
  if (!sameTomlValue(after.value, expected)) return leftAlone;
  // Stryker disable next-line ObjectLiteral: a site's keys read the same with macOS's keys, and the file loaded with them before
  const loads = parseConfig(out, { mac }).errors[0];
  if (loads) {
    return { error: `config.toml would not load with the change: ${loads.path}: ${loads.message}` };
  }
  return { text: out, added, already, removed };
}

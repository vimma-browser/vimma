/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TOML for vimma: parsing through the vendored smol-toml, and source lines for config paths.
 * See docs/specs/m5-core-config-and-theme.md § Errors with file:line.
 */
import { TomlError, parse } from "../vendor/smol-toml/smol-toml.mjs";

/** @typedef {(string | number)[]} Path  table keys and array indices, outermost first */

/**
 * @typedef {object} TomlSyntaxError
 * @property {number} line      1-based
 * @property {number} column    1-based
 * @property {string} message   one line, without smol-toml's code block
 */

/**
 * Deepest nesting of tables and arrays accepted. Vimma's files need 4 (`keys.new_tab[1]`,
 * `sites."host".insert`); smol-toml's own maxDepth bounds only inline values, not dotted keys
 * or table headers (`a.a.a.….b = 1`), whose depth would otherwise be bounded by the file size:
 * a recursive reader of the result overflows the stack and locateKeys takes quadratic time.
 */
export const MAX_DEPTH = 32;

/**
 * The path to the first value nested deeper than MAX_DEPTH, or null. Iterative, so a deep
 * value cannot overflow the stack here.
 * @param {Record<string, unknown>} root
 * @returns {Path | null}
 */
function tooDeep(root) {
  /** @type {[unknown, Path][]} */
  const stack = [[root, []]];
  while (stack.length) {
    const [v, path] = /** @type {[unknown, Path]} */ (stack.pop());
    // TOML has no null: an object here is a table, an array or a date.
    if (typeof v !== "object" || v instanceof Date) continue;
    if (path.length >= MAX_DEPTH) return path;
    const entries = Array.isArray(v) ? v.entries() : Object.entries(/** @type {object} */ (v));
    for (const [k, child] of entries) stack.push([child, [...path, k]]);
  }
  return null;
}

/**
 * @param {string} text
 * @param {{ integersAsBigInt?: boolean }} [options]
 *   integersAsBigInt: integers become BigInt, so `1.0` (a float) can be told from `1`
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: TomlSyntaxError }}
 */
export function parseToml(text, { integersAsBigInt = false } = {}) {
  try {
    const value = parse(text, { integersAsBigInt, maxDepth: MAX_DEPTH });
    const deep = tooDeep(value);
    if (!deep) return { ok: true, value };
    const line = locateKeys(text)(deep) ?? 1;
    const message = `tables and arrays nest deeper than ${MAX_DEPTH} levels`;
    return { ok: false, error: { line, column: 1, message } };
  } catch (e) {
    if (!(e instanceof TomlError)) throw e;
    // Stryker disable next-line Regex: every smol-toml message starts so; `^` changes nothing
    const first = e.message.replace(/^Invalid TOML document: /, "").split("\n")[0];
    let message = /** @type {string} */ (first);
    const opened = unclosedBracket(text, e.line, e.column);
    if (opened) message += ` (unclosed "${opened.char}" opened at line ${opened.line}?)`;
    return { ok: false, error: { line: e.line, column: e.column, message } };
  }
}

/**
 * The innermost `[` or `{` opened on an earlier line and still open at (line, column):
 * the parser reports an unterminated array where it notices, often at the next table header.
 * Skips strings and comments; a rough scan, only used to word a hint.
 * @param {string} text
 * @param {number} line
 * @param {number} column
 * @returns {{ char: string, line: number } | undefined}
 */
function unclosedBracket(text, line, column) {
  // Stryker disable next-line ArrayDeclaration: an element with no line is never found below
  const stack = /** @type {{ char: string, line: number }[]} */ ([]);
  let at = 1;
  let col = 1;
  for (let i = 0; i < text.length && (at < line || (at === line && col < column)); i++, col++) {
    const c = text[i];
    if (c === "\n") {
      at++;
      col = 0;
    } else if (c === "#") {
      i += /** @type {string} */ (matchAt(/[^\n]*/y, text, i)).length - 1; // to the comment's end
    } else if (c === '"' || c === "'") {
      const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < text.length && !text.startsWith(q, j) && (q.length === 3 || text[j] !== "\n")) {
        j += c === '"' && text[j] === "\\" ? 2 : 1;
      }
      for (let k = i; k < j; k++) if (text[k] === "\n") at++;
      i = j + q.length - 1;
    } else if (c === "[" || c === "{") {
      stack.push({ char: c, line: at });
    } else if (c === "]" || c === "}") {
      stack.pop();
    }
  }
  return [...stack].reverse().find((open) => open.line < line);
}

const BARE = /^[A-Za-z0-9_-]+$/;

/**
 * What `re`, a sticky (`y`) regex, matches starting exactly at `text[at]`, or undefined. Sticky
 * rather than `^` on a slice: no copy of the rest of the text, and no bound to check past its end.
 * @param {RegExp} re @param {string} text @param {number} at
 */
function matchAt(re, text, at) {
  re.lastIndex = at;
  return re.exec(text)?.[0];
}

/**
 * `keys.new_tab[1]`, `modal.normal."<C-w>h"`: bare keys plain, others as JSON strings.
 * @param {Path} path
 */
export function formatPath(path) {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += (out ? "." : "") + (BARE.test(seg) ? seg : JSON.stringify(seg));
  }
  return out;
}

/**
 * Inverse of formatPath; also reads KeymapError paths, which quote every modal sequence.
 * @param {string} text
 * @returns {Path}
 */
export function parsePath(text) {
  /** @type {Path} */
  const out = [];
  let i = 0;
  while (i < text.length) {
    const index = matchAt(/\[\d+\]/y, text, i);
    // `^` on a slice, not sticky: CodeQL (js/polynomial-redos) reads a sticky regex as unanchored.
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i))?.[0];
    if (text[i] === ".") {
      i++;
    } else if (index) {
      out.push(Number(index.slice(1, -1)));
      i += index.length;
    } else if (quoted) {
      out.push(JSON.parse(quoted));
      i += quoted.length;
    } else {
      // A bare segment, or text formatPath does not write (an unclosed `[` or `"`): up to the
      // next separator, at least one character, so the loop always ends (issue #134).
      const seg = /** @type {string} */ (matchAt(/[\s\S][^.[]*/y, text, i));
      out.push(seg);
      i += seg.length;
    }
  }
  return out;
}

/** @type {Record<string, string>} */
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

/**
 * Line of every key, table header, array element and inline-table member in `text`, which must
 * already have parsed (parseToml): the scanner trusts the syntax and only tracks positions.
 * @param {string} text
 * @returns {(path: Path) => number | undefined}  line of `path` or of its nearest located ancestor
 */
export function locateKeys(text) {
  /** @type {number[]} */
  const starts = [0];
  for (const nl of text.matchAll(/\n/g)) starts.push(nl.index + 1);
  /** @param {number} pos */
  const lineAt = (pos) => {
    let lo = 0;
    // Stryker disable next-line ArithmeticOperator: starts[starts.length] is never <= pos, so lo never gets there
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (/** @type {number} */ (starts[mid]) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  /** @type {Map<string, number>} */
  const lines = new Map();
  /** @param {Path} path @param {number} pos */
  const record = (path, pos) => {
    const k = JSON.stringify(path);
    if (!lines.has(k)) lines.set(k, lineAt(pos));
  };
  /**
   * Paths deeper than MAX_DEPTH + 1 only occur in a file parseToml refuses, which looks up just
   * that prefix; cutting them keeps the scan linear (each key records every prefix).
   * @param {Path} path
   */
  const cap = (path) => path.slice(0, MAX_DEPTH + 1);

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM
  const ws = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const wsNl = () => {
    for (;;) {
      ws();
      if (text[i] === "#") i += /** @type {string} */ (matchAt(/[^\n]*/y, text, i)).length;
      if (text[i] === "\r" || text[i] === "\n") i++;
      else return;
    }
  };
  /** @param {string} q */
  const quoted = (q) => {
    let s = "";
    i++;
    while (text[i] !== q) {
      const c = /** @type {string} */ (text[i]);
      if (q === '"' && c === "\\") {
        const e = /** @type {string} */ (text[i + 1]);
        const hex = { u: 4, U: 8, x: 2 }[e];
        if (hex) {
          s += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + hex), 16));
          i += 2 + hex;
        } else {
          s += ESCAPES[e] ?? e;
          i += 2;
        }
      } else {
        s += c;
        i++;
      }
    }
    i++;
    return s;
  };
  /** @returns {string[]} */
  const key = () => {
    /** @type {string[]} */
    const segs = [];
    for (;;) {
      ws();
      const c = text[i];
      if (c === '"' || c === "'") {
        segs.push(quoted(c));
      } else {
        const bare = /** @type {string} */ (matchAt(/[A-Za-z0-9_-]*/y, text, i));
        segs.push(bare);
        i += bare.length;
      }
      ws();
      if (text[i] !== ".") return segs;
      i++;
    }
  };
  /** @param {string} delim */
  const multiline = (delim) => {
    i += 3;
    for (;;) {
      if (delim === '"""' && text[i] === "\\") i += 2;
      else if (text.startsWith(delim, i)) break;
      else i++;
    }
    i += 3;
    while (text[i] === delim[0]) i++; // up to two quotes may end the content
  };
  /** @param {Path} path */
  const value = (path) => {
    const c = text[i];
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      multiline(text.slice(i, i + 3));
    } else if (c === '"' || c === "'") {
      quoted(c);
    } else if (c === "[") {
      i++;
      for (let idx = 0; ; idx++) {
        wsNl();
        if (text[i] === "]") break;
        record([...path, idx], i);
        value([...path, idx]);
        wsNl();
        if (text[i] === ",") i++;
      }
      i++;
    } else if (c === "{") {
      i++;
      for (;;) {
        wsNl();
        if (text[i] === "}") break;
        keyval(path);
        wsNl();
        if (text[i] === ",") i++;
      }
      i++;
    } else {
      i += /** @type {string} */ (matchAt(/[^,\]}\r\n#]*/y, text, i)).length;
    }
  };
  /** @param {Path} base */
  const keyval = (base) => {
    // Stryker disable next-line CallExpression: both callers have just skipped the blanks
    ws();
    const at = i;
    const full = cap([...base, ...key()]);
    // Stryker disable next-line ArithmeticOperator: it only adds prefixes recorded at or before at
    for (let n = base.length + 1; n <= full.length; n++) record(full.slice(0, n), at);
    i++; // "="
    ws();
    value(full);
  };

  /** @type {Path} */
  let table = [];
  /** `[[name]]` headers seen so far, by name: the next one is element `count` of the array. */
  /** @type {Map<string, number>} */
  const arrays = new Map();
  for (;;) {
    wsNl();
    if (i >= text.length) break;
    if (text[i] === "[") {
      const at = i;
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      table = key();
      i += array ? 2 : 1;
      if (array) {
        const name = JSON.stringify(table);
        const index = arrays.get(name) ?? 0;
        arrays.set(name, index + 1);
        table = [...table, index];
      }
      table = cap(table);
      // implicit parent tables (`[sites."a.com"]` alone) are located at their first header
      for (let n = 1; n <= table.length; n++) record(table.slice(0, n), at);
    } else {
      // Every pass moves on: a header past its `[`, a key/value past its `=` (keyval's `i++`).
      keyval(table);
    }
  }

  return (path) => {
    for (let n = path.length; n; n--) {
      const line = lines.get(JSON.stringify(path.slice(0, n)));
      if (line !== undefined) return line;
    }
    return undefined;
  };
}

/**
 * @typedef {object} TomlEdit
 * @property {string} table  a top-level `[table]`
 * @property {string} key    a bare key in it
 * @property {string | boolean | number} value
 */

/** A TOML literal for `value`: a basic string, a boolean or an integer. */
export function tomlLiteral(/** @type {string | boolean | number} */ value) {
  // JSON writes booleans and integers as TOML does, and its string escapes are valid TOML,
  // except that TOML also requires DEL to be escaped.
  return JSON.stringify(value).replace(/\x7f/g, "\\u007F");
}

/**
 * Structural equality of two parsed TOML values (key order ignored). Exported for its tests:
 * setTomlKeys reaches it only with what a wrong line edit could change.
 * @returns {boolean}
 */
export function sameTomlValue(/** @type {unknown} */ a, /** @type {unknown} */ b) {
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return Object.is(a, b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      sameTomlValue(
        /** @type {Record<string, unknown>} */ (a)[k],
        /** @type {Record<string, unknown>} */ (b)[k],
      ),
    )
  );
}

/**
 * The end of a one-line value starting at `line[i]`, or -1 when it is not one: a multi-line
 * string, an array or an inline table, which a line edit cannot replace safely.
 * @param {string} line @param {number} i
 */
function valueEnd(line, i) {
  if (line.startsWith('"""', i) || line.startsWith("'''", i)) return -1;
  const c = line[i];
  if (c === "[" || c === "{") return -1;
  // A one-line string closes on its line, since the text parsed.
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|'[^']*')/.exec(line.slice(i))?.[0]; // `^`: see parsePath
  if (quoted) return i + quoted.length;
  // Up to a comment or the line's end, less the blanks before it (`line[i]` is not blank).
  return i + trimBlank(/** @type {string} */ (matchAt(/[^#\r]*/y, line, i))).length;
}

/** @param {string} s @returns {string} `s` without spaces and tabs at either end */
function trimBlank(s) {
  let a = 0;
  let b = s.length;
  while (s[a] === " " || s[a] === "\t") a++;
  // All blank: b goes below a, and the slice is "" all the same.
  while (s[b - 1] === " " || s[b - 1] === "\t") b--;
  return s.slice(a, b);
}

/**
 * The name in a `[table]` header line, or null. Scanned by hand rather than with a regex,
 * because a pattern with blank runs on both sides of the name backtracks quadratically on a long
 * line of blanks (CodeQL js/polynomial-redos). Without a `]` (close is -1), the rest is the whole
 * line, which starts with `[`: null. `[]` and `[[a]]` give "" and "[a", which no bare name equals.
 * @param {string} line
 */
function headerName(line) {
  const s = trimBlank(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (s[0] !== "[") return null;
  const close = s.indexOf("]");
  const name = trimBlank(s.slice(1, close));
  const rest = trimBlank(s.slice(close + 1));
  return rest === "" || rest[0] === "#" ? name : null;
}

/**
 * One edit on parsed `text`.
 * @param {string} text @param {Record<string, unknown>} doc  `text`, parsed @param {TomlEdit} edit
 * @returns {{ ok: true, text: string } | { ok: false, error: TomlSyntaxError }}
 */
function setKey(text, doc, { table, key, value }) {
  const fail = (/** @type {number} */ line, /** @type {string} */ message) => ({
    ok: /** @type {const} */ (false),
    error: { line, column: 1, message },
  });
  const where = locateKeys(text);
  const name = formatPath([table, key]);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n");
  const literal = tomlLiteral(value);
  const headerAt = lines.findIndex((l) => headerName(l) === table);
  if (headerAt < 0) {
    if (table in doc) return fail(where([table]) ?? 1, `${table} is not a plain [${table}] table`);
    const body = `[${table}]${eol}${key} = ${literal}${eol}`;
    if (text === "") return { ok: true, text: body };
    return { ok: true, text: `${text}${text.endsWith("\n") ? "" : eol}${eol}${body}` };
  }
  // A `[table]` line inside a multi-line string is no header: the file has no such table.
  const t = doc[table]; // TOML has no null
  if (typeof t !== "object" || Array.isArray(t)) {
    return fail(headerAt + 1, `${table} is not a plain [${table}] table`);
  }
  // The table's lines: after its header, up to the next line that starts with `[`.
  const first = headerAt + 1;
  const next = lines.findIndex((l, n) => n > headerAt && /^[ \t]*\[/.test(l));
  const body = lines.slice(first, next === -1 ? lines.length : next);
  const keyRe = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)`);
  for (const [k, line] of body.entries()) {
    const m = keyRe.exec(line);
    if (!m || where([table, key]) !== first + k + 1) continue;
    const stop = valueEnd(line, m[0].length);
    if (stop === -1) return fail(first + k + 1, `${name} is not a one-line value`);
    lines[first + k] = `${m[0]}${literal}${line.slice(stop)}`;
    return { ok: true, text: lines.join("\n") };
  }
  if (key in /** @type {object} */ (t)) {
    // Stryker disable next-line ArithmeticOperator: unreachable, locateKeys has every key's line
    return fail(where([table, key]) ?? headerAt + 1, `${name} is not a plain key = value line`);
  }
  let last = headerAt;
  for (const [k, line] of body.entries()) if (!/^[ \t]*(#.*)?\r?$/.test(line)) last = first + k;
  lines.splice(last + 1, 0, `${key} = ${literal}${eol === "\r\n" ? "\r" : ""}`);
  return { ok: true, text: lines.join("\n") };
}

/**
 * Sets keys in config.toml text by editing their lines only (spec first-run-setup, decision 10):
 * every other line, comment and the key order stay byte for byte. smol-toml has no writer that
 * keeps comments, hence the line edit; the result is parsed again and must equal the old file
 * plus the new values, so an edit the line scan got wrong is an error, never a changed file.
 * @param {string} text  the file; "" for a new one
 * @param {TomlEdit[]} edits
 * @returns {{ ok: true, text: string } | { ok: false, error: TomlSyntaxError }}
 */
export function setTomlKeys(text, edits) {
  const before = parseToml(text);
  if (!before.ok) return before;
  const want = structuredClone(before.value);
  let out = text;
  for (const edit of edits) {
    if (!BARE.test(edit.table) || !BARE.test(edit.key)) {
      return { ok: false, error: { line: 1, column: 1, message: "not a bare key" } };
    }
    const now = parseToml(out);
    if (!now.ok) return now;
    const r = setKey(out, now.value, edit);
    if (!r.ok) return r;
    out = r.text;
    // setKey refused a `table` that is there but is not a table: it is one, or not there yet.
    want[edit.table] = {
      .../** @type {Record<string, unknown> | undefined} */ (want[edit.table]),
      [edit.key]: edit.value,
    };
  }
  const after = parseToml(out);
  if (!after.ok) return after;
  if (!sameTomlValue(after.value, want)) {
    return {
      ok: false,
      error: { line: 1, column: 1, message: "the edit would change other keys" },
    };
  }
  return { ok: true, text: out };
}

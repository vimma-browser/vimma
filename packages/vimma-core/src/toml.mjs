/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TOML for vimma: parsing through the vendored smol-toml, and source lines for config paths.
 * See docs/specs/m5-core-config-and-theme.md § Errors with file:line.
 */
import { TomlError, parse } from "./vendor/smol-toml/smol-toml.mjs";

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
    if (typeof v !== "object" || v === null || v instanceof Date) continue;
    if (path.length >= MAX_DEPTH) return path;
    const entries = Array.isArray(v) ? v.entries() : Object.entries(v);
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
    /* c8 ignore next */
    if (!(e instanceof TomlError)) throw e;
    let message = e.message.replace(/^Invalid TOML document: /, "").split("\n")[0] ?? "";
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
  /** @type {{ char: string, line: number }[]} */
  const stack = [];
  let at = 1;
  let col = 1;
  for (let i = 0; i < text.length && (at < line || (at === line && col < column)); i++, col++) {
    const c = text[i];
    if (c === "\n") {
      at++;
      col = 0;
    } else if (c === "#") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
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
    const c = text[i];
    if (c === ".") {
      i++;
    } else if (c === "[" && /^\[\d+\]/.test(text.slice(i))) {
      const end = text.indexOf("]", i);
      out.push(Number(text.slice(i + 1, end)));
      i = end + 1;
    } else if (c === '"' && /^"(?:[^"\\]|\\.)*"/.test(text.slice(i))) {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(JSON.parse(text.slice(i, j + 1)));
      i = j + 1;
    } else {
      // A bare segment, or text formatPath does not write (an unclosed `[` or `"`): up to the
      // next separator, at least one character, so the loop always ends (issue #134).
      const m = /^[\s\S][^.[]*/.exec(text.slice(i));
      const seg = /** @type {RegExpExecArray} */ (m)[0];
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
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") starts.push(k + 1);
  /** @param {number} pos */
  const lineAt = (pos) => {
    let lo = 0;
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
  const cap = (path) => (path.length > MAX_DEPTH + 1 ? path.slice(0, MAX_DEPTH + 1) : path);

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM
  const ws = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const wsNl = () => {
    for (;;) {
      ws();
      if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
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
        const start = i;
        while (i < text.length && /[A-Za-z0-9_-]/.test(/** @type {string} */ (text[i]))) i++;
        segs.push(text.slice(start, i));
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
      while (i < text.length && !",]}\r\n#".includes(/** @type {string} */ (text[i]))) i++;
    }
  };
  /** @param {Path} base */
  const keyval = (base) => {
    ws();
    const at = i;
    const full = cap([...base, ...key()]);
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
    const before = i;
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
      keyval(table);
    }
    /* c8 ignore next */
    if (i === before) i++; // never loop forever on input the parser would have rejected
  }

  return (path) => {
    for (let n = path.length; n > 0; n--) {
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
function tomlLiteral(/** @type {string | boolean | number} */ value) {
  if (typeof value !== "string") return String(value);
  // JSON's escapes are valid TOML except that TOML also requires DEL to be escaped.
  return JSON.stringify(value).replace(/\x7f/g, "\\u007F");
}

/** Structural equality of two parsed TOML values (key order ignored). */
/** @returns {boolean} */
function same(/** @type {unknown} */ a, /** @type {unknown} */ b) {
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return Object.is(a, b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => same(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]))
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
  if (c === '"') {
    for (let k = i + 1; k < line.length; k++) {
      if (line[k] === "\\") k++;
      else if (line[k] === '"') return k + 1;
    }
    return -1;
  }
  if (c === "'") {
    const k = line.indexOf("'", i + 1);
    return k < 0 ? -1 : k + 1;
  }
  let k = i;
  while (k < line.length && !"#\r".includes(/** @type {string} */ (line[k]))) k++;
  while (k > i && /[ \t]/.test(/** @type {string} */ (line[k - 1]))) k--;
  return k;
}

/** @param {string} s @returns {string} `s` without spaces and tabs at either end */
function trimBlank(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === " " || s[a] === "\t")) a++;
  while (b > a && (s[b - 1] === " " || s[b - 1] === "\t")) b--;
  return s.slice(a, b);
}

/**
 * The name in a `[table]` header line, or null. Scanned by hand rather than with a regex,
 * because a pattern with blank runs on both sides of the name backtracks quadratically on a long
 * line of blanks (CodeQL js/polynomial-redos).
 * @param {string} line
 */
function headerName(line) {
  const s = trimBlank(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (s[0] !== "[") return null;
  const close = s.indexOf("]");
  if (close < 0) return null;
  const name = trimBlank(s.slice(1, close));
  if (!name || name.includes("[")) return null;
  const rest = trimBlank(s.slice(close + 1));
  return rest === "" || rest[0] === "#" ? name : null;
}

/**
 * One edit on parsed `text`.
 * @param {string} text @param {Record<string, any>} doc @param {TomlEdit} edit
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
  let end = lines.length;
  for (let n = headerAt + 1; n < lines.length; n++) {
    if (/^[ \t]*\[/.test(/** @type {string} */ (lines[n]))) {
      end = n;
      break;
    }
  }
  const keyRe = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)`);
  for (let n = headerAt + 1; n < end; n++) {
    const line = /** @type {string} */ (lines[n]);
    const m = keyRe.exec(line);
    if (!m || where([table, key]) !== n + 1) continue;
    const stop = valueEnd(line, m[0].length);
    if (stop < 0) return fail(n + 1, `${name} is not a one-line value`);
    lines[n] = `${m[0]}${literal}${line.slice(stop)}`;
    return { ok: true, text: lines.join("\n") };
  }
  if (key in doc[table]) {
    return fail(where([table, key]) ?? headerAt + 1, `${name} is not a plain key = value line`);
  }
  let last = headerAt;
  for (let n = headerAt + 1; n < end; n++) {
    if (!/^[ \t]*(#.*)?\r?$/.test(/** @type {string} */ (lines[n]))) last = n;
  }
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
  /** @type {Record<string, any>} */
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
    want[edit.table] = { ...want[edit.table], [edit.key]: edit.value };
  }
  const after = parseToml(out);
  if (!after.ok) return after;
  if (!same(after.value, want)) {
    return {
      ok: false,
      error: { line: 1, column: 1, message: "the edit would change other keys" },
    };
  }
  return { ok: true, text: out };
}

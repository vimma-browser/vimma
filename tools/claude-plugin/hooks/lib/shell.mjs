/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A small reader for the shell commands an agent runs: enough of POSIX sh and bash to split a
// command line into simple commands and their words, so the guard rules look at what runs and
// not at text that merely mentions it (a commit message, a heredoc, a grep pattern). It does not
// evaluate anything: a word built from `$VAR` or `$(...)` is marked dynamic, and the commands in
// a substitution are parsed and checked like the others.

/**
 * @typedef {{ text: string, dynamic: boolean }} Word
 * @typedef {{ words: Word[], subs: Segment[][], writes: Word[], stdin: string[], op: string | null }} Segment
 *   a simple command, the commands of its substitutions, the files its output redirections
 *   write, the text its here-strings and heredocs feed it, and the operator after it
 * @typedef {{ name: string, args: Word[] }} Command
 */

/** @param {string} src @returns {Segment[]} */
export function parseShell(src) {
  return new Parser(src).script(false);
}

const NAME = /[A-Za-z0-9_{@*#?!$-]/;

class Parser {
  /** @param {string} src */
  constructor(src) {
    this.s = src;
    this.i = 0;
    /** @type {{ delim: string, strip: boolean, into: string[] }[]} */
    this.heredocs = [];
  }

  /**
   * Reads commands up to the end of the input or, inside `$(`, up to its closing parenthesis.
   * @param {boolean} inSub
   * @returns {Segment[]}
   */
  script(inSub) {
    const s = this.s;
    /** @type {Segment[]} */
    const segs = [];
    /** @type {Word[]} */
    let words = [];
    /** @type {Segment[][]} */
    let subs = [];
    /** @type {Word[]} */
    let writes = [];
    /** @type {string[]} */
    let stdin = [];
    /** @type {Word | null} */
    let word = null;
    /** @type {"" | "in" | "out" | "here"} the next word is a redirection target or a here-string */
    let target = "";
    let depth = 0;
    const cur = () => (word ??= { text: "", dynamic: false });
    // A closure, so that tsc reads `word` as declared: it does not follow the closures that set it.
    const fdNumber = () => !!word && !word.dynamic && /^\d+$/.test(word.text);
    const endWord = () => {
      if (!word) return;
      if (target === "out") writes.push(word);
      if (target === "here") stdin.push(word.text);
      if (target) target = "";
      else words.push(word);
      word = null;
    };
    /** @param {string | null} op */
    const endSeg = (op) => {
      endWord();
      if (words.length || subs.length || writes.length || stdin.length) {
        segs.push({ words, subs, writes, stdin, op });
      }
      words = [];
      subs = [];
      writes = [];
      stdin = [];
    };

    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "\\") {
        if (s[this.i + 1] !== "\n") cur().text += s[this.i + 1] ?? "";
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end < 0 ? s.length : end;
        cur().text += s.slice(this.i + 1, stop);
        this.i = stop + 1;
      } else if (c === '"') {
        this.i++;
        this.doubleQuoted(cur(), subs);
      } else if (c === "`") {
        subs.push(this.backtick());
        cur().dynamic = true;
      } else if (c === "$" && s[this.i + 1] === "'") {
        this.i++;
        this.ansiC(cur());
      } else if (c === "$" && s[this.i + 1] === '"') {
        // A locale string reads like a double-quoted one.
        this.i++;
      } else if (c === "$") {
        this.dollar(cur(), subs);
      } else if (c === " " || c === "\t") {
        endWord();
        this.i++;
      } else if (c === "\n") {
        endSeg(";");
        this.i++;
        this.skipHeredocs();
      } else if (c === "#" && !word) {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (c === ";") {
        endSeg(";");
        this.i += s[this.i + 1] === ";" ? 2 : 1;
      } else if (c === "&" && s[this.i + 1] === "&") {
        endSeg("&&");
        this.i += 2;
      } else if (c === "&" && s[this.i + 1] === ">") {
        endWord();
        this.i += s[this.i + 2] === ">" ? 3 : 2;
        target = "out";
      } else if (c === "&") {
        endSeg("&");
        this.i++;
      } else if (c === "|") {
        const two = s[this.i + 1];
        endSeg(two === "|" ? "||" : "|");
        this.i += two === "|" || two === "&" ? 2 : 1;
      } else if (c === "(" && !word) {
        endSeg(null);
        depth++;
        this.i++;
      } else if (c === ")") {
        this.i++;
        if (depth > 0) {
          depth--;
          endSeg(";");
        } else if (inSub) {
          endSeg(null);
          return segs;
        } else endSeg(";");
      } else if (c === "<" || c === ">") {
        // A file descriptor number before a redirection (2>&1) is not an argument.
        if (fdNumber()) word = null;
        endWord();
        if (s[this.i + 1] === "(") {
          this.i += 2;
          subs.push(this.script(true));
        } else if (s.startsWith("<<<", this.i)) {
          this.i += 3;
          target = "here";
        } else if (s.startsWith("<<", this.i)) {
          this.i += 2;
          this.heredocStart(stdin);
        } else {
          const start = this.i;
          while (this.i < s.length && "<>&|".includes(s[this.i] ?? "")) this.i++;
          // `>&2` duplicates a descriptor; `>`, `>>`, `>|` and `<>` write a file.
          const dup = s[this.i - 1] === "&" && /\d/.test(s[this.i] ?? "");
          target = s.slice(start, this.i).includes(">") && !dup ? "out" : "in";
        }
      } else {
        cur().text += c;
        this.i++;
      }
    }
    endSeg(null);
    return segs;
  }

  /** @param {Word} word @param {Segment[][]} subs */
  doubleQuoted(word, subs) {
    const s = this.s;
    while (this.i < s.length && s[this.i] !== '"') {
      const c = s[this.i];
      if (c === "\\" && '$`"\\\n'.includes(s[this.i + 1] ?? "")) {
        if (s[this.i + 1] !== "\n") word.text += s[this.i + 1];
        this.i += 2;
      } else if (c === "`") {
        subs.push(this.backtick());
        word.dynamic = true;
      } else if (c === "$") {
        this.dollar(word, subs);
      } else {
        word.text += c;
        this.i++;
      }
    }
    this.i++;
  }

  /** @param {Word} word @param {Segment[][]} subs */
  dollar(word, subs) {
    const next = this.s[this.i + 1] ?? "";
    if (next === "(") {
      this.i += 2;
      subs.push(this.script(true));
      word.dynamic = true;
    } else if (NAME.test(next)) {
      word.text += "$";
      word.dynamic = true;
      this.i++;
    } else {
      word.text += "$";
      this.i++;
    }
  }

  /**
   * Reads `$'...'` from its opening quote, decoding the escapes bash decodes there, so that
   * `$'n\x70m'` reads as the word it runs. An escape it does not know makes the word dynamic.
   * @param {Word} word
   */
  ansiC(word) {
    const s = this.s;
    this.i++;
    /** @type {Record<string, string>} */
    const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t" };
    Object.assign(simple, { v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" });
    while (this.i < s.length && s[this.i] !== "'") {
      const c = s[this.i] ?? "";
      if (c !== "\\") {
        word.text += c;
        this.i++;
        continue;
      }
      const e = s[this.i + 1] ?? "";
      const rest = s.slice(this.i + 1);
      const code =
        /^[0-7]{1,3}/.exec(rest) ??
        /^x([0-9A-Fa-f]{1,2})/.exec(rest) ??
        /^u([0-9A-Fa-f]{1,4})/.exec(rest) ??
        /^U([0-9A-Fa-f]{1,8})/.exec(rest);
      if (simple[e] !== undefined) {
        word.text += simple[e];
        this.i += 2;
      } else if (code) {
        const octal = /^[0-7]/.test(e);
        const n = parseInt(octal ? code[0] : (code[1] ?? ""), octal ? 8 : 16);
        word.text += n <= 0x10ffff ? String.fromCodePoint(n) : "";
        this.i += 1 + code[0].length;
      } else {
        word.dynamic = true;
        word.text += e;
        this.i += 2;
      }
    }
    this.i++;
  }

  /** @returns {Segment[]} */
  backtick() {
    const s = this.s;
    let body = "";
    this.i++;
    while (this.i < s.length && s[this.i] !== "`") {
      if (s[this.i] === "\\" && this.i + 1 < s.length) {
        body += s[this.i + 1];
        this.i += 2;
      } else body += s[this.i++];
    }
    this.i++;
    return parseShell(body);
  }

  /**
   * Reads the delimiter after `<<` or `<<-`; the body starts at the next newline.
   * @param {string[]} into the stdin of the command the heredoc feeds
   */
  heredocStart(into) {
    const s = this.s;
    const strip = s[this.i] === "-";
    if (strip) this.i++;
    while (s[this.i] === " " || s[this.i] === "\t") this.i++;
    let delim = "";
    while (this.i < s.length && !" \t\n;&|<>()".includes(s[this.i] ?? "")) {
      const c = s[this.i];
      if (c !== "'" && c !== '"' && c !== "\\") delim += c;
      this.i++;
    }
    if (delim) this.heredocs.push({ delim, strip, into });
  }

  /**
   * Skips the bodies of the heredocs opened on the line just ended: they are data, kept as the
   * stdin of their command, not parsed as commands.
   */
  skipHeredocs() {
    const s = this.s;
    for (const { delim, strip, into } of this.heredocs.splice(0)) {
      const body = [];
      while (this.i < s.length) {
        const nl = s.indexOf("\n", this.i);
        const end = nl < 0 ? s.length : nl;
        const line = s.slice(this.i, end);
        this.i = end + 1;
        const text = strip ? line.replace(/^\t+/, "") : line;
        if (text === delim) break;
        body.push(text);
      }
      into.push(body.join("\n"));
    }
  }
}

const KEYWORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
]);

/** Wrappers that run the command after them, with their options that take a value. */
const WRAPPERS = new Map([
  [
    "sudo",
    [
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "-D",
      "--chdir",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-U",
      "--other-user",
      "-r",
      "--role",
      "-t",
      "--type",
    ],
  ],
  ["doas", ["-u", "-C"]],
  ["env", ["-u", "-C", "-S"]],
  ["command", []],
  ["exec", ["-a"]],
  ["builtin", []],
  ["nohup", []],
  ["time", []],
  ["nice", ["-n"]],
  ["setsid", []],
  ["stdbuf", ["-i", "-o", "-e"]],
  ["timeout", ["-s", "-k"]],
  [
    "xargs",
    [
      "-n",
      "-I",
      "-L",
      "-P",
      "-d",
      "-s",
      "-E",
      "-a",
      "--max-args",
      "--max-procs",
      "--delimiter",
      "--max-chars",
      "--process-slot-var",
      "--arg-file",
    ],
  ],
  [
    "parallel",
    [
      "-j",
      "--jobs",
      "-S",
      "--sshlogin",
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-I",
      "-C",
      "--colsep",
    ],
  ],
]);

/**
 * The command a segment runs, past variable assignments, shell keywords and wrappers such as
 * `sudo`, `env`, `timeout` and `xargs`.
 * @param {Word[]} words
 * @returns {Command | null}
 */
export function commandOf(words) {
  let k = 0;
  const at = (/** @type {number} */ n) => words[n]?.text ?? "";
  for (;;) {
    while (
      k < words.length &&
      (KEYWORDS.has(at(k)) || (!words[k]?.dynamic && /^[A-Za-z_]\w*=/.test(at(k))))
    )
      k++;
    const takesValue = WRAPPERS.get(at(k));
    if (!takesValue) break;
    const wrapper = at(k);
    k++;
    while (k < words.length) {
      const w = at(k);
      if (takesValue.includes(w)) k += 2;
      else if (w.startsWith("-") && w !== "-") k++;
      else if (wrapper === "env" && /^[A-Za-z_]\w*=/.test(w)) k++;
      else break;
    }
    if (wrapper === "timeout" && k < words.length) k++;
  }
  const head = words[k];
  if (!head) return null;
  return { name: head.text.replace(/^.*\//, ""), args: words.slice(k + 1) };
}

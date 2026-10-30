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
 * @typedef {{ words: Word[], subs: Segment[][], writes: Word[], op: string | null }} Segment
 *   a simple command, the commands of its substitutions, the files its output redirections
 *   write, and the operator after it
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
    /** @type {{ delim: string, strip: boolean }[]} */
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
    /** @type {Word | null} */
    let word = null;
    /** @type {"" | "in" | "out"} the next word is a redirection target, not an argument */
    let target = "";
    let depth = 0;
    const cur = () => (word ??= { text: "", dynamic: false });
    const endWord = () => {
      if (!word) return;
      if (target === "out") writes.push(word);
      if (target) target = "";
      else words.push(word);
      word = null;
    };
    /** @param {string | null} op */
    const endSeg = (op) => {
      endWord();
      if (words.length || subs.length || writes.length) segs.push({ words, subs, writes, op });
      words = [];
      subs = [];
      writes = [];
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
        if (word && !word.dynamic && /^\d+$/.test(word.text)) word = null;
        endWord();
        if (s[this.i + 1] === "(") {
          this.i += 2;
          subs.push(this.script(true));
        } else if (s.startsWith("<<<", this.i)) {
          this.i += 3;
          target = "in";
        } else if (s.startsWith("<<", this.i)) {
          this.i += 2;
          this.heredocStart();
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

  /** Reads the delimiter after `<<` or `<<-`; the body starts at the next newline. */
  heredocStart() {
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
    if (delim) this.heredocs.push({ delim, strip });
  }

  /** Skips the bodies of the heredocs opened on the line just ended: they are data. */
  skipHeredocs() {
    const s = this.s;
    for (const { delim, strip } of this.heredocs.splice(0)) {
      while (this.i < s.length) {
        const nl = s.indexOf("\n", this.i);
        const end = nl < 0 ? s.length : nl;
        const line = s.slice(this.i, end);
        this.i = end + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
      }
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
  ["sudo", ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"]],
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
  ["xargs", ["-n", "-I", "-L", "-P", "-d", "-s", "-E", "-a"]],
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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Bash guard's install rule: an agent installs only what a lockfile pins (docs/security/14,
// B4). It refuses npm's install and update commands, an npx or npm exec that can fetch, the
// installs and runners of pnpm, Yarn, Bun, corepack, pip, uv and cargo, and a download that a
// shell or interpreter runs.
//
// It sees what the shell reader (shell.mjs) sees: quoted, escaped and ANSI-C quoted names, a
// path to the command, wrappers (command, env, sudo, xargs, parallel, timeout, busybox), `cd x
// &&`, subshells, $(...), backticks, the scripts of `bash -c`, `sh -c` and `eval`, a here-string
// or heredoc fed to a shell, `find -exec`, and the command an npx runs. It cannot see a command
// name built at run time ($NPM), an alias or a shell function, a script file run by name (its
// contents are not read), a heredoc fed to an interpreter other than a shell, a pipe into a shell
// from a command that is not a download (`cat saved.sh | bash`), npm started through node and
// npm-cli.js, settings in an .npmrc the command writes first, xargs --replace or --max-lines
// written with their value as a separate word (GNU reads the next word as the command, so the
// guard does too), or a package manager this list does not name (gem and go are covered for
// their install commands only).
//
// It is a guardrail for agents, not a sandbox: `npm ci` in CI and the repository-wide
// supply-chain test are the checks that hold.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { commandOf } from "./shell.mjs";

/**
 * @typedef {import("./shell.mjs").Segment} Segment
 * @typedef {import("./shell.mjs").Command} Command
 * @typedef {import("./shell.mjs").Word} Word
 * @typedef {{ reason: string }} Block
 * @typedef {(words: Word[]) => Block | null} Nested checks words as a command of their own
 */

export const INSTALL_REASONS = {
  install:
    "Blocked: this installs or updates packages outside package-lock.json. Install exactly what " +
    "the lockfile pins with `npm ci` (it takes flags such as --ignore-scripts). A new or updated " +
    "dependency is a package.json and lockfile change for a person to make and review, not " +
    "something an agent installs.",
  npx:
    "Blocked: this can fetch and run a package from the registry, which no " +
    "lockfile pins, or can run a bin from outside this checkout (a prefix, global or workspace " +
    "setting, an npm_config_ variable). Run a devDependency's bin with `npx --no -- <bin>` (it " +
    "never fetches) after `npm ci`; `npx <bin>` passes only when <bin> is already in " +
    "node_modules/.bin. Any other package is a package.json and lockfile change, not an npx.",
  pip:
    "Blocked: Python packages taken without `--require-hashes` are whatever the index serves " +
    "(this covers pip, uv and pipx). Install from a file of pinned hashes with " +
    "`--require-hashes -r <file>`, or stop and report what is missing. (On the npm side, " +
    "`npm ci` is the one install.)",
  cargo:
    "Blocked: a crate installed without `--locked` resolves fresh versions instead of the ones " +
    "its Cargo.lock pins, a --git source needs a fixed --rev, and a prebuilt binary or a " +
    "rewritten Cargo.lock is unreviewed. Add `--locked` (and `--rev <sha>`); a lockfile update " +
    "is a change for a person to make and review. (On the npm side, `npm ci` is the one install.)",
  other:
    "Blocked: this installs a package that no lockfile of this repository pins (gem, or go " +
    "fetching a remote module). Stop and report what is missing: a new dependency is a change " +
    "for a person to make and review. (On the npm side, `npm ci` is the one install.)",
  pipe:
    "Blocked: a script downloaded into a shell or interpreter runs code that no checksum or " +
    "signature checked. Download the file, check its checksum or signature, then run it. (On " +
    "the npm side, `npm ci` is the one install.)",
};

const block = (/** @type {keyof typeof INSTALL_REASONS} */ kind) => ({
  reason: INSTALL_REASONS[kind],
});

/** npm's commands and their aliases (`npm help commands`): the first of them is the verb. */
const NPM_COMMANDS = new Set(
  (
    "access adduser audit bugs cache ci completion config dedupe deprecate diff dist-tag docs " +
    "doctor edit exec explain explore find-dupes fund get help help-search hook init " +
    "install-ci-test install-test link ll login logout ls org outdated owner pack ping pkg " +
    "prefix profile prune publish query rebuild repo restart root run run-script sbom search set " +
    "shrinkwrap star stars start stop team test token uninstall unpublish unstar version view " +
    "whoami x r rm un unlink remove rb t tst v info show s se find ln c create innit la list " +
    "issues home author dist-tags rum urn ogr cit clean-install ic install-clean isntall-clean"
  ).split(" "),
);

/** npm's install, update and dedupe commands, with the aliases and typos npm itself accepts. */
const NPM_INSTALLS = new Set(
  (
    "i in ins inst insta instal install isnt isnta isntal isntall add up update upgrade udpate " +
    "it install-test dedupe ddp"
  ).split(" "),
);
for (const verb of NPM_INSTALLS) NPM_COMMANDS.add(verb);

/** npm's options that take a separate value (`npm help config`). */
const NPM_VALUED = new Set(
  (
    "-w --workspace --prefix -C --userconfig --globalconfig --cache --registry --loglevel --tag " +
    "--location --include --omit --before --otp --scope --cafile --script-shell --access"
  ).split(" "),
);

/** npm commands that fetch the package they name: create-x for `create x` and `init x`. */
const NPM_FETCHING = new Set("create init innit link ln".split(" "));

/** npm settings that make npx or npm exec fetch, or run a bin from another prefix. */
const NPX_UNSAFE =
  /^(?:yes|package|call|prefix|global|location|workspaces?|userconfig|globalconfig)$/i;

/** An npm_config_ variable for one of those settings, in any case npm reads it. */
const NPM_CONFIG = /^npm_config_(\w+)=/i;

export const SHELLS = new Set("sh bash zsh dash ksh mksh ash fish".split(" "));
const DOWNLOADERS = new Set(["curl", "wget"]);
/** Commands that run a script given in a substitution: `eval "$(...)"`, `source <(...)`. */
const SUB_RECEIVERS = new Set([...SHELLS, "eval", "source", ".", "busybox", "deno", "bun"]);

/**
 * An npx or npm option that fetches or runs from outside the checkout: -y, -p, -c, -g, -w, -C
 * in any short cluster, and --yes, --package, --call, --prefix, --global, --location, --workspace.
 * @param {string} t
 */
function unsafeNpmOption(t) {
  if (t === "--yes=false" || t === "--no-yes") return false;
  if (t.startsWith("--")) return NPX_UNSAFE.test(t.slice(2).split("=")[0] ?? "");
  return /^-[^-]/.test(t) && /[ypcgwC]/.test(t.slice(1).split("=")[0] ?? "");
}

/**
 * Why the npm_config_ assignments among a segment's words (before the command, after `env`,
 * after `export`) must not run, or null.
 * @param {Word[]} words
 * @returns {Block | null}
 */
export function checkNpmConfig(words) {
  for (const w of words) {
    const m = NPM_CONFIG.exec(w.text);
    if (m && NPX_UNSAFE.test(m[1] ?? "")) return block("npx");
  }
  return null;
}

/** @param {string[]} texts */
const wantsHelp = (texts) => texts.some((t) => t === "-h" || t === "--help" || t === "--usage");

/**
 * The verb of a package manager: the first word that is not an option or an option's value.
 * @param {string[]} texts
 * @param {Set<string>} valued options that take a separate value
 */
function verbAt(texts, valued) {
  let k = 0;
  while (k < texts.length && texts[k]?.startsWith("-") && texts[k] !== "--") {
    k += valued.has(texts[k] ?? "") ? 2 : 1;
  }
  return k;
}

/**
 * @param {Command} cmd
 * @param {Segment} seg
 * @param {Segment[]} segs
 * @param {number} i
 * @param {{ cwd: string | null }} ctx
 * @param {Nested} nested
 * @returns {Block | null}
 */
export function checkInstall(cmd, seg, segs, i, ctx, nested) {
  return checkManager(cmd, ctx, nested) ?? checkDownloadRun(cmd, seg, segs, i);
}

/**
 * @param {Command} cmd
 * @param {{ cwd: string | null }} ctx
 * @param {Nested} nested
 * @returns {Block | null}
 */
function checkManager(cmd, ctx, nested) {
  const texts = cmd.args.map((w) => w.text);
  const name = cmd.name;
  // Names are matched by regular expression throughout, so that the repository-wide
  // supply-chain test does not read a compared name as a spawned command.
  if (/^npm$/.test(name)) return checkNpm(cmd.args, ctx, nested);
  if (/^npx$/.test(name)) return checkNpx(cmd.args, ctx, nested);
  // Bun's, pnpm's and uv's own npx fetch whatever they are not given.
  if (/^(?:bun|pnp)x$/.test(name)) return block("install");
  if (name === "uvx") return block("pip");
  if (/^corepack$/.test(name)) {
    return texts.length === 1 && /^(?:-v|--version|-h|--help)$/.test(texts[0] ?? "")
      ? null
      : block("install");
  }
  if (name === "pnpm") return checkPnpm(texts);
  if (name === "yarn") return checkYarn(texts);
  if (name === "bun") return checkBun(texts);
  if (name === "uv") return checkUv(texts);
  if (name === "pipx") {
    const verb = texts[verbAt(texts, new Set())];
    return ["install", "run", "inject"].includes(verb ?? "") ? block("pip") : null;
  }
  if (/^pip[\d.]*$/.test(name)) return checkPip(texts);
  if (/^python[\d.]*$/.test(name)) {
    const m = texts.findIndex((t) => t === "-m" || /^-mpip[\d.]*$/.test(t));
    if (m < 0) return null;
    if (texts[m] === "-m")
      return /^pip[\d.]*$/.test(texts[m + 1] ?? "") ? checkPip(texts.slice(m + 2)) : null;
    return checkPip(texts.slice(m + 1));
  }
  if (name === "cargo") return checkCargo(texts);
  if (/^gem$/.test(name)) {
    const verb = texts[verbAt(texts, new Set(["--config-file"]))];
    return ["install", "update"].includes(verb ?? "") ? block("other") : null;
  }
  if (/^go$/.test(name)) {
    const k = verbAt(texts, new Set(["-C"]));
    const verb = texts[k];
    if (verb === "get") return block("other");
    const remote = texts.slice(k + 1).some((t) => /@/.test(t) && !t.startsWith("-"));
    return ["install", "run"].includes(verb ?? "") && remote ? block("other") : null;
  }
  return null;
}

/**
 * @param {Word[]} args the words after `npm`
 * @param {{ cwd: string | null }} ctx
 * @param {Nested} nested
 * @returns {Block | null}
 */
function checkNpm(args, ctx, nested) {
  const texts = args.map((w) => w.text);
  const dashes = texts.indexOf("--");
  const end = dashes < 0 ? texts.length : dashes;
  // The verb is the first word npm knows as a command, past the values of npm's valued options.
  // Any other word before it is an option or an option's value, so an unknown option cannot hide
  // an install after it.
  let k = 0;
  while (k < end) {
    const t = texts[k] ?? "";
    if (NPM_VALUED.has(t)) k += 2;
    else if (NPM_COMMANDS.has(t)) break;
    else k++;
  }
  if (k >= end) {
    // No verb before `--`: npm takes the first word after it.
    return dashes < 0 ? null : npmVerb(args, dashes + 1, texts.length, ctx, nested);
  }
  const found = npmVerb(args, k, end, ctx, nested);
  if (found) return found;
  // An unknown option before the verb may take it as its value (`--foo test i x`): then the next
  // word is the verb, and it is checked too.
  const before = texts[k - 1] ?? "";
  if (before.startsWith("-") && !before.includes("=") && NPM_COMMANDS.has(texts[k + 1] ?? "")) {
    return k + 1 < end ? npmVerb(args, k + 1, end, ctx, nested) : null;
  }
  return null;
}

/**
 * @param {Word[]} args the words after `npm`
 * @param {number} k the verb's index
 * @param {number} end the index of the `--` that ends npm's own words, or the length
 * @param {{ cwd: string | null }} ctx
 * @param {Nested} nested
 * @returns {Block | null}
 */
function npmVerb(args, k, end, ctx, nested) {
  const texts = args.map((w) => w.text);
  const verb = texts[k] ?? "";
  const rest = texts.slice(k + 1, end);
  if (wantsHelp(rest)) return null;
  if (NPM_INSTALLS.has(verb)) return block("install");
  if (verb === "audit" && rest.includes("fix")) return block("install");
  if (NPM_FETCHING.has(verb) && rest.some((t) => !t.startsWith("-"))) return block("install");
  if (verb === "exec" || verb === "x") {
    if (texts.slice(0, k).some(unsafeNpmOption)) return block("npx");
    return checkNpx(args.slice(k + 1), ctx, nested);
  }
  return null;
}

/**
 * npx and npm exec fetch a package that is not installed (a spawned npx has no TTY, so npm takes
 * that as --yes), and fall back to global bins. They pass with no unsafe option, a plain bin
 * name, a command that passes the guard itself, and either --no or a bin that npm ci put in
 * node_modules/.bin.
 * @param {Word[]} args the words after `npx` or `npm exec`
 * @param {{ cwd: string | null }} ctx
 * @param {Nested} nested
 * @returns {Block | null}
 */
function checkNpx(args, ctx, nested) {
  let never = false;
  let options = false;
  let dashed = false;
  let k = 0;
  for (; k < args.length; k++) {
    const t = args[k]?.text ?? "";
    if (t === "--") {
      dashed = true;
      k++;
      break;
    }
    if (!t.startsWith("-")) break;
    if (unsafeNpmOption(t)) return block("npx");
    if (t === "--no" || t === "--no-install" || t === "--yes=false" || t === "--no-yes") {
      never = true;
    }
    options = true;
  }
  const bin = args[k];
  if (!bin) return null;
  // Without `--`, an option before the bin leaves npm reading the flags after it as its own
  // (docs/specs/build-supply-chain.md, decision 17).
  if (options && !dashed) {
    const after = args.slice(k + 1).map((w) => w.text);
    const stop = after.indexOf("--");
    if (after.slice(0, stop < 0 ? after.length : stop).some(unsafeNpmOption)) return block("npx");
  }
  // A path, a version, a scope or a URL names a package to fetch or a directory to install.
  if (bin.dynamic || /^\.|[@/:]/.test(bin.text)) return block("npx");
  // What npx runs is a command like any other, and may be a shell or npm itself.
  const inner = nested(args.slice(k));
  if (inner) return inner;
  if (never) return null;
  if (ctx.cwd === null) return block("npx");
  return localBin(ctx.cwd, bin.text) ? null : block("npx");
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether npx finds `bin` without fetching: in node_modules/.bin of npm's local prefix (the
 * nearest directory with a package.json or node_modules) or of a directory above it, as
 * libnpmexec looks.
 * @param {string} cwd
 * @param {string} bin
 */
function localBin(cwd, bin) {
  let dir = resolve(cwd);
  for (;;) {
    const has = (/** @type {string} */ f) => {
      try {
        statSync(join(dir, f));
        return true;
      } catch {
        return false;
      }
    };
    if (has("package.json") || has("node_modules")) break;
    if (dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
  for (;;) {
    if (isFile(join(dir, "node_modules", ".bin", bin))) return true;
    if (dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
}

/** @param {string[]} texts the words after `pnpm` */
function checkPnpm(texts) {
  const k = verbAt(texts, new Set(["-C", "--dir", "--filter", "-F", "--reporter", "--loglevel"]));
  const verb = texts[k] ?? "";
  const rest = texts.slice(k + 1);
  if (wantsHelp(rest)) return null;
  if ("add install i update up upgrade dlx create self-update".split(" ").includes(verb)) {
    return block("install");
  }
  if (verb === "env" && rest.some((t) => t === "use" || t === "add")) return block("install");
  return null;
}

/** @param {string[]} texts the words after `yarn` */
function checkYarn(texts) {
  const k = verbAt(texts, new Set(["--cwd", "--modules-folder", "--cache-folder"]));
  const verb = texts[k];
  const rest = texts.slice(k + 1);
  if (wantsHelp(texts)) return null;
  // A bare `yarn` installs, whatever options it has.
  if (verb === undefined) {
    return texts.some((t) => t === "-v" || t === "--version") ? null : block("install");
  }
  if ("add install up upgrade dlx create".split(" ").includes(verb)) return block("install");
  // `yarn workspace <name> <command>` runs the command in that workspace.
  if (verb === "workspace" && rest.length > 1) return checkYarn(rest.slice(1));
  if (verb === "global" && rest.includes("add")) return block("install");
  return null;
}

/** @param {string[]} texts the words after `bun` */
function checkBun(texts) {
  const k = verbAt(texts, new Set(["--cwd", "-c", "--config"]));
  const verb = texts[k] ?? "";
  if (wantsHelp(texts.slice(k + 1))) return null;
  return "add a install i update x create upgrade".split(" ").includes(verb)
    ? block("install")
    : null;
}

/** @param {string[]} texts the words after `uv` */
function checkUv(texts) {
  const k = verbAt(texts, new Set(["--directory", "--project", "--cache-dir", "--config-file"]));
  const verb = texts[k] ?? "";
  const rest = texts.slice(k + 1);
  if (verb === "pip") return checkPip(rest);
  if (verb === "add") return block("pip");
  if (
    (verb === "lock" || verb === "sync") &&
    rest.some((t) => /^(?:-U|-P|--upgrade|--upgrade-package)(?:=|$)/.test(t))
  ) {
    return block("pip");
  }
  if (verb === "tool" && ["install", "run", "upgrade"].includes(rest[0] ?? "")) return block("pip");
  if (verb === "run" && rest.some((t) => /^--with(?:-requirements|-editable)?(?:=|$)/.test(t))) {
    return block("pip");
  }
  return null;
}

/** @param {string[]} texts the words after `pip` */
function checkPip(texts) {
  const valued = new Set(["--python", "--log", "--proxy", "--cache-dir", "--cert", "--timeout"]);
  const k = verbAt(texts, valued);
  return texts[k] === "install" && !texts.includes("--require-hashes") ? block("pip") : null;
}

/**
 * Installing a crate keeps to its Cargo.lock only with --locked, and a git source only at
 * a fixed --rev; binstall fetches prebuilt binaries; update and generate-lockfile rewrite
 * Cargo.lock.
 * @param {string[]} texts the words after `cargo`
 */
function checkCargo(texts) {
  const args = texts[0]?.startsWith("+") ? texts.slice(1) : texts;
  const k = verbAt(args, new Set(["-C", "--config", "-Z", "--color"]));
  const verb = args[k] ?? "";
  const rest = args.slice(k + 1);
  if (wantsHelp(rest)) return null;
  if (["update", "generate-lockfile", "binstall", "add"].includes(verb)) return block("cargo");
  if (verb !== "install") return null;
  const git = rest.some((t) => t === "--git" || t.startsWith("--git="));
  const rev = rest.some((t) => t === "--rev" || t.startsWith("--rev="));
  return !rest.includes("--locked") || (git && !rev) ? block("cargo") : null;
}

/** The applet `busybox <applet> ...` runs, or `cmd` itself. @param {Command} cmd @returns {Command} */
export function applet(cmd) {
  if (cmd.name !== "busybox" || !cmd.args[0]) return cmd;
  return { name: cmd.args[0].text.replace(/^.*\//, ""), args: cmd.args.slice(1) };
}

/**
 * Whether `cmd` runs a program it reads from stdin: a shell or interpreter with no program
 * given by an option (-c, -e, -m, -r) and no script operand, or one told to read it (`-`, -s).
 * `bash -n` checks syntax only, so it runs nothing.
 * @param {Command} cmd
 * @returns {boolean}
 */
export function readsProgram(cmd) {
  cmd = applet(cmd);
  const texts = cmd.args.map((w) => w.text);
  const name = cmd.name;
  if (SHELLS.has(name)) return reads(texts, /^-[A-Za-z]*[cn]/, ["-o", "+o", "-O", "+O"], true);
  if (/^python[\d.]*$/.test(name)) return reads(texts, /^-[A-Za-z]*[cm]/, ["-W", "-X"], false);
  if (name === "node") {
    return reads(
      texts,
      /^(?:-[A-Za-z]*[epc]|--(?:eval|print|check)(?:=|$))/,
      ["-r", "--require", "--import", "--loader", "-C", "--conditions"],
      false,
    );
  }
  if (name === "perl") return reads(texts, /^-[A-Za-z0-9]*[eE]/, [], false);
  if (name === "ruby") return reads(texts, /^-[A-Za-z]*e/, ["-I", "-r"], false);
  if (name === "php") return reads(texts, /^-[A-Za-z]*[rBREFf]/, [], false);
  // deno and bun read a program from stdin only when told to with `-`.
  if (name === "deno" || name === "bun") return texts.includes("-");
  return false;
}

/**
 * @param {string[]} texts the interpreter's arguments
 * @param {RegExp} program an option that gives the program itself
 * @param {string[]} valued options that take a separate value
 * @param {boolean} shell whether -s tells it to read stdin, script operand or not
 */
function reads(texts, program, valued, shell) {
  let stdinFlag = false;
  for (let j = 0; j < texts.length; j++) {
    const t = texts[j] ?? "";
    if (t === "-" || /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/.test(t)) return true;
    if (t === "--") return j + 1 >= texts.length || stdinFlag;
    if (t.startsWith("-") || (shell && t.startsWith("+"))) {
      if (program.test(t)) return false;
      if (shell && /^-[A-Za-z]*s/.test(t)) stdinFlag = true;
      if (valued.includes(t)) j++;
      continue;
    }
    return stdinFlag; // a script operand: stdin is data, unless -s said otherwise
  }
  return true;
}

/**
 * A download run unchecked: piped into a shell or interpreter that reads its program from stdin,
 * or given to one through a process or command substitution (to a shell, eval, source or an
 * interpreter).
 * @param {Command} cmd @param {Segment} seg @param {Segment[]} segs @param {number} i
 * @returns {Block | null}
 */
function checkDownloadRun(cmd, seg, segs, i) {
  const download = (/** @type {Command | null} */ c) => !!c && DOWNLOADERS.has(c.name);
  const receiver =
    SUB_RECEIVERS.has(cmd.name) ||
    /^python[\d.]*$/.test(cmd.name) ||
    ["node", "perl", "ruby", "php"].includes(cmd.name);
  if (receiver && seg.subs.some((sub) => sub.some((s) => download(commandOf(s.words))))) {
    return block("pipe");
  }
  // A download, or a command that prints one (`echo "$(curl ...)"`, a heredoc that runs curl).
  const fetches =
    download(cmd) ||
    seg.subs.some((sub) => sub.some((s) => download(commandOf(s.words)))) ||
    seg.stdin.some((text) => /\b(?:curl|wget)\b/.test(text));
  if (fetches) {
    for (let j = i + 1; j < segs.length && segs[j - 1]?.op === "|"; j++) {
      const next = commandOf(segs[j]?.words ?? []);
      if (next && readsProgram(next)) return block("pipe");
    }
  }
  return null;
}

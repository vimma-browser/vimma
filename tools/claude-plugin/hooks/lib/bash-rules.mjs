/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The rules the Bash guard enforces. Each one stops a command that has already cost the project
// something when an agent ran it: an unchecked squash message (#278), a pattern kill that took the
// agent's own shell, a rewritten branch, a dismissed alert, a disabled workflow. The install rule
// keeps an agent from bringing in code that no lockfile pins (docs/security/14, B4).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { commandOf, parseShell } from "./shell.mjs";

/**
 * @typedef {import("./shell.mjs").Segment} Segment
 * @typedef {import("./shell.mjs").Command} Command
 * @typedef {import("./shell.mjs").Word} Word
 * @typedef {(message: string, cwd: string) => { ok: boolean, output: string }} Commitlint
 * @typedef {{ reason: string }} Block
 * @typedef {{ cwd: string | null, commitlint: Commitlint, written: Set<string> }} Context
 */

export const REASONS = {
  kill:
    "Blocked: `pkill -f` and `pgrep -f ... | kill` match their pattern against whole command " +
    "lines, the agent's own shell included, and have killed it. Kill only processes you " +
    "started, by exact PID: `kill <PID>` (list candidates with `pgrep -a <name>`).",
  push:
    "Blocked: force pushes rewrite pushed history. Update the branch with " +
    "`git merge origin/main` (git's default message) and push without force. If the history " +
    "itself is wrong, squash the work onto a fresh branch from origin/main and open a " +
    "replacement pull request.",
  alert:
    "Blocked: code-scanning, secret-scanning and Dependabot alerts are fixed, never dismissed " +
    "to get a check green. Fix the finding, or stop and report the alert.",
  workflow:
    "Blocked: a workflow is never disabled to get green. Fix the failure, or stop and report it.",
  apiMerge:
    "Blocked: merge pull requests with `gh pr merge` and a checked message, not through the " +
    "REST API.",
  merge:
    'Blocked: `gh pr merge` needs --subject "<type(scope): subject> (#N)" and --body-file ' +
    "<file> with the squash body, so the guard can run commitlint on the exact message first. " +
    'Write the body to a file, then run: gh pr merge <N> --squash --subject "..." ' +
    "--body-file <file>.",
  install:
    "Blocked: this installs or updates packages outside package-lock.json. Install exactly what " +
    "the lockfile pins with `npm ci` (it takes flags such as --ignore-scripts). A new or updated " +
    "dependency is a package.json and lockfile change for a person to make and review, not " +
    "something an agent installs.",
  npx:
    "Blocked: this npx or npm exec can fetch and run a package from the registry, which no " +
    "lockfile pins. Run a devDependency's bin with `npx --no -- <bin>` (it never fetches) after " +
    "`npm ci`; `npx <bin>` passes only when <bin> is already in node_modules/.bin. Any other " +
    "package is a package.json and lockfile change, not an npx.",
  pip:
    "Blocked: pip installs without `--require-hashes` take whatever the index serves. Use " +
    "`pip install --require-hashes -r <file>` with pinned hashes, or stop and report what is " +
    "missing. (The npm side installs with `npm ci` only.)",
  cargo:
    "Blocked: `cargo install` without `--locked` resolves fresh crate versions instead of the " +
    "ones Cargo.lock pins (and a --git source needs a fixed --rev); `cargo update` rewrites " +
    "Cargo.lock. Add `--locked` (and `--rev <sha>`); a lockfile update is a change for a person " +
    "to make and review. (The npm side installs with `npm ci` only.)",
  pipe:
    "Blocked: a script piped from the network into a shell or interpreter runs code that no " +
    "checksum or signature checked. Download the file, check its checksum or signature, then " +
    "run it. (The npm side installs with `npm ci` only.)",
};

/**
 * Why `command` must not run, or null when it may.
 * @param {string} command
 * @param {{ cwd?: string | null, commitlint?: Commitlint }} [opts]
 * @returns {Block | null}
 */
export function checkBash(command, opts = {}) {
  return checkScript(parseShell(command ?? ""), {
    cwd: opts.cwd ?? null,
    commitlint: opts.commitlint ?? runCommitlint,
    written: new Set(),
  });
}

/**
 * @param {Segment[]} segs
 * @param {Context} ctx
 * @returns {Block | null}
 */
function checkScript(segs, ctx) {
  let cwd = ctx.cwd;
  for (const [i, seg] of segs.entries()) {
    for (const sub of seg.subs) {
      const found = checkScript(sub, { ...ctx, cwd });
      if (found) return found;
    }
    const cmd = commandOf(seg.words);
    if (!cmd) continue;

    const inner = innerScript(cmd);
    if (inner !== null) {
      const found = checkScript(parseShell(inner), { ...ctx, cwd });
      if (found) return found;
    }

    if (cmd.name === "cd" || cmd.name === "pushd") cwd = changeDir(cwd, cmd.args);
    for (const w of [...seg.writes, ...fileArgsWritten(cmd)]) {
      if (cwd !== null || isAbsolute(w.text)) ctx.written.add(resolve(cwd ?? "/", w.text));
    }

    const found =
      checkKill(cmd, seg, segs, i) ??
      checkPush(cmd) ??
      checkGh(cmd, { ...ctx, cwd }) ??
      checkAlertRequest(cmd) ??
      checkInstall(cmd, { ...ctx, cwd }) ??
      checkPipedScript(cmd, seg, segs, i);
    if (found) return found;
  }
  return null;
}

/** The script a `bash -c` or `eval` runs, or null. @param {Command} cmd */
function innerScript(cmd) {
  if (cmd.name === "eval") return cmd.args.map((w) => w.text).join(" ");
  if (!["bash", "sh", "zsh", "dash", "ksh"].includes(cmd.name)) return null;
  const at = cmd.args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
  return at < 0 ? null : (cmd.args[at + 1]?.text ?? null);
}

/** Files a command writes through its arguments: `tee`'s, and the target of `cp` or `mv`. @param {Command} cmd */
function fileArgsWritten(cmd) {
  const operands = cmd.args.filter((w) => !w.text.startsWith("-"));
  if (cmd.name === "tee") return operands;
  if (["cp", "mv", "install", "ln"].includes(cmd.name)) return operands.slice(-1);
  return [];
}

/** @param {string | null} cwd @param {Word[]} args */
function changeDir(cwd, args) {
  const target = args.find((w) => !w.text.startsWith("-") || w.text === "-");
  if (!target) return homedir();
  if (target.dynamic || target.text === "-") return null;
  const path = target.text.replace(/^~(?=\/|$)/, homedir());
  if (isAbsolute(path)) return path;
  return cwd === null ? null : resolve(cwd, path);
}

/** A short-option cluster (`-fa`, `-9f`) that contains `letter`. @param {Word} w @param {string} letter */
function hasShort(w, letter) {
  return /^-[A-Za-z0-9]+$/.test(w.text) && w.text.includes(letter);
}

/** @param {Command | null} cmd */
function matchesFullCommandLine(cmd) {
  return (
    (cmd?.name === "pkill" || cmd?.name === "pgrep") &&
    cmd.args.some((w) => w.text === "--full" || hasShort(w, "f"))
  );
}

/**
 * `pkill -f`, `pgrep -f ... | xargs kill` and `kill $(pgrep -f ...)`.
 * @param {Command} cmd @param {Segment} seg @param {Segment[]} segs @param {number} i
 */
function checkKill(cmd, seg, segs, i) {
  if (cmd.name === "pkill" && matchesFullCommandLine(cmd)) return { reason: REASONS.kill };
  if (cmd.name === "kill") {
    const fromPgrep = seg.subs.some((sub) =>
      sub.some((s) => matchesFullCommandLine(commandOf(s.words))),
    );
    if (fromPgrep) return { reason: REASONS.kill };
  }
  if (cmd.name === "pgrep" && matchesFullCommandLine(cmd)) {
    for (let j = i + 1; j < segs.length && segs[j - 1]?.op === "|"; j++) {
      const next = commandOf(segs[j]?.words ?? []);
      if (next?.name === "kill") return { reason: REASONS.kill };
    }
  }
  return null;
}

/** Git options that come before the subcommand and take a separate value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** @param {Command} cmd */
function checkPush(cmd) {
  if (cmd.name !== "git") return null;
  let k = 0;
  while (k < cmd.args.length && cmd.args[k]?.text.startsWith("-")) {
    k += GIT_VALUE_OPTIONS.has(cmd.args[k]?.text ?? "") ? 2 : 1;
  }
  if (cmd.args[k]?.text !== "push") return null;
  const args = cmd.args.slice(k + 1);
  for (let j = 0; j < args.length; j++) {
    const t = args[j]?.text ?? "";
    if (t === "-o" || t === "--push-option" || t === "--repo" || t === "--receive-pack") {
      j++;
      continue;
    }
    if (/^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(t)) return { reason: REASONS.push };
    if (/^-[A-Za-z0-9]+$/.test(t) && t.includes("f")) return { reason: REASONS.push };
    if (t.startsWith("+")) return { reason: REASONS.push };
  }
  return null;
}

/**
 * @param {Command} cmd
 * @param {Context} ctx
 */
function checkGh(cmd, ctx) {
  if (cmd.name !== "gh") return null;
  const texts = cmd.args.map((w) => w.text);
  const [group, action] = texts;
  if (group === "workflow" && action === "disable") return { reason: REASONS.workflow };
  if (group === "pr" && action === "merge") return checkMerge(cmd.args.slice(2), ctx);
  if (group === "api") return checkApi(texts.slice(1));
  // gh extensions that dismiss alerts, such as `gh code-scanning alert dismiss`
  if (texts.includes("dismiss") && texts.some((t) => /alert/.test(t))) {
    return { reason: REASONS.alert };
  }
  return null;
}

const ALERTS = /(?:code-scanning|secret-scanning|dependabot)\/alerts/;

/** @param {string[]} args the words after `gh api` */
function checkApi(args) {
  let method = null;
  let fields = false;
  for (let j = 0; j < args.length; j++) {
    const t = args[j] ?? "";
    if (t === "-X" || t === "--method") method = (args[++j] ?? "").toUpperCase();
    else if (t.startsWith("--method=")) method = t.slice(9).toUpperCase();
    else if (/^-X[A-Za-z]+$/.test(t)) method = t.slice(2).toUpperCase();
    else if (/^(?:-f|-F|--field|--raw-field|--input)$/.test(t) || /^--(?:raw-)?field=/.test(t)) {
      fields = true;
    }
  }
  // gh api sends a POST when fields are given and no method is (gh help api).
  const writes = (method ?? (fields ? "POST" : "GET")) !== "GET";
  const path = args.join(" ");
  if (ALERTS.test(path) && writes) return { reason: REASONS.alert };
  if (/actions\/workflows\/[^/\s]+\/disable/.test(path)) return { reason: REASONS.workflow };
  if (/pulls\/\d+\/merge/.test(path) && writes) return { reason: REASONS.apiMerge };
  return null;
}

/** An HTTP client (curl, wget, HTTPie) that writes a dismissed or resolved state to an alert. @param {Command} cmd */
function checkAlertRequest(cmd) {
  if (!["curl", "wget", "http", "https", "xh"].includes(cmd.name)) return null;
  const text = cmd.args.map((w) => w.text).join(" ");
  if (ALERTS.test(text) && /dismissed|resolved/.test(text)) return { reason: REASONS.alert };
  return null;
}

// Installs outside the lockfile. The rule sees what the shell reader sees: quoted or escaped
// names ('npm', n\pm), a path (/usr/bin/npm), wrappers (command, env, sudo, xargs, timeout),
// `cd x &&`, subshells, $(...) and backticks, and the scripts of `bash -c`, `sh -c`, `eval` and
// the one npx runs with -c (refused anyway). It cannot see a name built at run time ($NPM install), an alias or a function the
// shell defines, a script file the command runs (bash install.sh), or npm started another way
// (node .../npm-cli.js install, corepack). It is a guardrail for agents, not a sandbox: the
// repository-wide supply-chain test and `npm ci` in CI are the checks that hold.

/** npm's install and update commands, with the aliases and typos npm itself accepts. */
const NPM_INSTALLS = new Set([
  ..."i in ins inst insta instal install isnt isnta isntal isntall add".split(" "),
  ..."up update upgrade udpate".split(" "),
  ..."it install-test".split(" "),
]);

/** npm commands that fetch the package they name. */
const NPM_FETCHING = new Set("create init innit link ln".split(" "));

/** npm options before the subcommand that take a separate value. */
const NPM_VALUE_OPTIONS = new Set([
  ..."-w --workspace --prefix -C --userconfig --cache --registry --loglevel --tag".split(" "),
]);

/** The interpreters a downloaded script is piped into. */
const INTERPRETERS = new Set(
  "sh bash zsh dash ksh fish python python3 node perl ruby php".split(" "),
);

/**
 * @param {Command} cmd
 * @param {Context} ctx
 * @returns {Block | null}
 */
function checkInstall(cmd, ctx) {
  const texts = cmd.args.map((w) => w.text);
  switch (cmd.name) {
    case "npm": {
      const k = firstOperand(texts, NPM_VALUE_OPTIONS);
      const sub = texts[k] ?? "";
      if (NPM_INSTALLS.has(sub)) return { reason: REASONS.install };
      if (sub === "exec" || sub === "x") return checkNpx(cmd.args.slice(k + 1), ctx);
      // `create x` and `init x` run the create-x package, `link x` installs one: with a package
      // name they fetch; a bare `npm init` or `npm link` does not.
      if (NPM_FETCHING.has(sub) && texts.slice(k + 1).some((t) => !t.startsWith("-"))) {
        return { reason: REASONS.install };
      }
      return null;
    }
    case "npx":
      return checkNpx(cmd.args, ctx);
    case "pnpm":
      return ["add", "install", "i", "update", "up", "upgrade", "dlx"].includes(texts[0] ?? "")
        ? { reason: REASONS.install }
        : null;
    case "yarn":
      // A bare `yarn` installs.
      return texts.length === 0 ||
        ["add", "install", "up", "upgrade", "dlx"].includes(texts[0] ?? "")
        ? { reason: REASONS.install }
        : null;
    case "bun":
      return ["add", "install", "i", "update", "x"].includes(texts[0] ?? "")
        ? { reason: REASONS.install }
        : null;
    case "pip":
    case "pip3":
      return checkPip(texts);
    case "uv":
      return texts[0] === "pip" ? checkPip(texts.slice(1)) : null;
    case "pipx":
      return ["install", "run", "inject"].includes(texts[0] ?? "") ? { reason: REASONS.pip } : null;
    case "cargo":
      return checkCargo(texts);
    case "corepack":
      // Downloads package managers (`corepack pnpm ...`, `corepack enable`, `corepack use`).
      return texts.length === 1 && /^(?:-v|--version|-h|--help)$/.test(texts[0] ?? "")
        ? null
        : { reason: REASONS.install };
    default:
      // Bun's and pnpm's own npx always fetch what they are not given.
      if (/^(?:bun|pnp)x$/.test(cmd.name)) return { reason: REASONS.install };
      if (/^python[\d.]*$/.test(cmd.name)) {
        const m = texts.indexOf("-m");
        return m >= 0 && /^pip\d*$/.test(texts[m + 1] ?? "") ? checkPip(texts.slice(m + 2)) : null;
      }
      return null;
  }
}

/**
 * `cargo install` keeps to the crate's Cargo.lock only with --locked, and a git source only at
 * a fixed --rev; `cargo update` rewrites Cargo.lock.
 * @param {string[]} texts the words after `cargo`
 */
function checkCargo(texts) {
  const args = texts[0]?.startsWith("+") ? texts.slice(1) : texts;
  if (args[0] === "update") return { reason: REASONS.cargo };
  if (args[0] !== "install") return null;
  const git = args.some((t) => t === "--git" || t.startsWith("--git="));
  const rev = args.some((t) => t === "--rev" || t.startsWith("--rev="));
  return !args.includes("--locked") || (git && !rev) ? { reason: REASONS.cargo } : null;
}

/** @param {string[]} texts the words after `pip` */
function checkPip(texts) {
  return texts[0] === "install" && !texts.includes("--require-hashes")
    ? { reason: REASONS.pip }
    : null;
}

/** The index of the first word that is not an option or an option's value. @param {string[]} texts @param {Set<string>} valued */
function firstOperand(texts, valued) {
  let k = 0;
  while (k < texts.length && texts[k]?.startsWith("-") && texts[k] !== "--") {
    k += valued.has(texts[k] ?? "") ? 2 : 1;
  }
  if (texts[k] === "--") k++;
  return k;
}

/**
 * npx and npm exec fetch a package that is not installed (a spawned npx has no TTY, so npm takes
 * that as --yes). They pass with --no, or with no package option and a bin that npm ci already
 * put in node_modules/.bin, found the way npm finds its local prefix.
 * @param {Word[]} args the words after `npx` or `npm exec`
 * @param {Context} ctx
 * @returns {Block | null}
 */
function checkNpx(args, ctx) {
  let never = false;
  let k = 0;
  for (; k < args.length; k++) {
    const t = args[k]?.text ?? "";
    if (t === "--") {
      k++;
      break;
    }
    if (!t.startsWith("-")) break;
    // --yes, --package (also as -yes, -p=x) and a script through -c or --call, which can name
    // any package and is not worth reading for the few bins it would run.
    if (/^-[ypc]/.test(t) || /^--(?:yes(?:=true)?|package|call)(?:=|$)/.test(t)) {
      return { reason: REASONS.npx };
    }
    if (t === "--no" || t === "--no-install" || t === "--yes=false" || t === "--no-yes") {
      never = true;
    } else if (NPM_VALUE_OPTIONS.has(t)) k++;
  }
  if (never) return null;
  const bin = args[k];
  if (!bin) return null;
  if (bin.dynamic || /[@/:]/.test(bin.text) || ctx.cwd === null) return { reason: REASONS.npx };
  const prefix = localPrefix(ctx.cwd);
  return prefix && existsSync(join(prefix, "node_modules", ".bin", bin.text))
    ? null
    : { reason: REASONS.npx };
}

/** npm's local prefix: the nearest directory with a package.json or node_modules. @param {string} cwd */
function localPrefix(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * A download piped into a shell or interpreter, read by one through `<(...)`, or run as the
 * script of `sh -c "$(...)"`: code that nothing checked.
 * @param {Command} cmd @param {Segment} seg @param {Segment[]} segs @param {number} i
 */
function checkPipedScript(cmd, seg, segs, i) {
  const download = (/** @type {Command | null} */ c) => c?.name === "curl" || c?.name === "wget";
  if (INTERPRETERS.has(cmd.name)) {
    if (seg.subs.some((sub) => sub.some((s) => download(commandOf(s.words))))) {
      return { reason: REASONS.pipe };
    }
  }
  if (download(cmd)) {
    for (let j = i + 1; j < segs.length && segs[j - 1]?.op === "|"; j++) {
      const next = commandOf(segs[j]?.words ?? []);
      if (next && INTERPRETERS.has(next.name)) return { reason: REASONS.pipe };
    }
  }
  return null;
}

/**
 * `gh pr merge` runs only with a literal --subject and a --body-file whose message passes
 * commitlint: the guard lints the exact message itself, so no `&&` chain has to hold.
 * @param {Word[]} args the words after `gh pr merge`
 * @param {Context} ctx
 * @returns {Block | null}
 */
function checkMerge(args, ctx) {
  /** @type {Word | null} */
  let subject = null;
  /** @type {Word | null} */
  let bodyFile = null;
  let inlineBody = false;
  for (let j = 0; j < args.length; j++) {
    const t = args[j]?.text ?? "";
    if (t === "--disable-auto") return null;
    const eq = t.indexOf("=");
    const flag = t.startsWith("--") && eq > 0 ? t.slice(0, eq) : t;
    const value = () =>
      flag === t ? (args[++j] ?? null) : { text: t.slice(eq + 1), dynamic: !!args[j]?.dynamic };
    if (flag === "--subject" || flag === "-t") subject = value();
    else if (flag === "--body-file" || flag === "-F") bodyFile = value();
    else if (flag === "--body" || flag === "-b") {
      value();
      inlineBody = true;
    }
  }
  if (!subject || !bodyFile || inlineBody) return { reason: REASONS.merge };
  if (subject.dynamic || bodyFile.dynamic) {
    return {
      reason:
        `${REASONS.merge} The guard reads the subject and the file path as they are written, ` +
        "so give both as literal text, not through a variable or $(...).",
    };
  }
  const path = bodyFile.text.replace(/^~(?=\/)/, homedir());
  if (!isAbsolute(path) && ctx.cwd === null) {
    return { reason: `${REASONS.merge} Give the body file as a literal absolute path.` };
  }
  const file = resolve(ctx.cwd ?? "/", path);
  // The guard reads the file before the command runs, so a file the same command writes would
  // be checked in its old state and merged in its new one.
  if (ctx.written.has(file)) {
    return {
      reason:
        `${REASONS.merge} This command also writes ${file}: write the body file in an earlier ` +
        "command, so the guard checks the message that will be merged.",
    };
  }
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    return { reason: `${REASONS.merge} The body file ${file} was not found.` };
  }
  if (!body.trim()) return { reason: `${REASONS.merge} The body file ${file} is empty.` };
  const lint = ctx.commitlint(`${subject.text}\n\n${body}`, ctx.cwd ?? process.cwd());
  if (!lint.ok && lint.output.includes("ERR_UNKNOWN_FILE_EXTENSION")) {
    // commitlint's config loads TypeScript from tools/ (ADR-025), which a Node older than
    // package.json's engines cannot run: still a block, but the message is not what to fix.
    return {
      reason:
        "Blocked: commitlint could not run, so the squash message is unchecked. This Node " +
        `(${process.version}) is older than package.json's engines; use .nvmrc's Node.\n` +
        lint.output.trim(),
    };
  }
  if (!lint.ok) {
    return {
      reason:
        "Blocked: the squash message fails `npx commitlint` (lower-case subject, a body, body " +
        "lines at most 100 columns). Fix the subject or the body file and merge again.\n" +
        lint.output.trim(),
    };
  }
  return null;
}

/** Runs the repository's own commitlint (its config and plugins) on `message`. @type {Commitlint} */
export function runCommitlint(message, cwd) {
  // The CLI the repository installed, found the way node resolves it from cwd, runs with node
  // directly: going through npx adds an npm start-up to every merge check (it doubled the time
  // on a loaded machine). npx stays the fallback where node cannot resolve the package.
  const cli = localCommitlint(cwd);
  const [file, args] = cli ? [process.execPath, [cli]] : ["npx", ["--no-install", "commitlint"]];
  const run = spawnSync(file, args, {
    cwd,
    input: message,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) return { ok: false, output: `could not run commitlint: ${run.error.message}` };
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

/** @param {string} cwd @returns {string | null} the path of @commitlint/cli's cli.js, if any */
function localCommitlint(cwd) {
  try {
    return createRequire(join(resolve(cwd), "noop.js")).resolve("@commitlint/cli/cli.js");
  } catch {
    return null;
  }
}

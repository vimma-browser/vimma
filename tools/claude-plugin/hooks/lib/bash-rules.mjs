/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The rules the Bash guard enforces. Each one stops a command that has already cost the project
// something when an agent ran it: an unchecked squash message (#278), a pattern kill that took the
// agent's own shell, a rewritten branch, a dismissed alert, a disabled workflow.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { commandOf, parseShell } from "./shell.mjs";

/**
 * @typedef {import("./shell.mjs").Segment} Segment
 * @typedef {import("./shell.mjs").Command} Command
 * @typedef {import("./shell.mjs").Word} Word
 * @typedef {(message: string, cwd: string) => { ok: boolean, output: string }} Commitlint
 * @typedef {{ reason: string }} Block
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
  });
}

/**
 * @param {Segment[]} segs
 * @param {{ cwd: string | null, commitlint: Commitlint }} ctx
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

    const found =
      checkKill(cmd, seg, segs, i) ??
      checkPush(cmd) ??
      checkGh(cmd, { ...ctx, cwd }) ??
      checkAlertRequest(cmd);
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
 * @param {{ cwd: string | null, commitlint: Commitlint }} ctx
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

/**
 * `gh pr merge` runs only with a literal --subject and a --body-file whose message passes
 * commitlint: the guard lints the exact message itself, so no `&&` chain has to hold.
 * @param {Word[]} args the words after `gh pr merge`
 * @param {{ cwd: string | null, commitlint: Commitlint }} ctx
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
  if (!existsSync(file) || !statSync(file).isFile()) {
    return { reason: `${REASONS.merge} The body file ${file} was not found.` };
  }
  const body = readFileSync(file, "utf8");
  if (!body.trim()) return { reason: `${REASONS.merge} The body file ${file} is empty.` };
  const lint = ctx.commitlint(`${subject.text}\n\n${body}`, ctx.cwd ?? process.cwd());
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
  const run = spawnSync("npx", ["--no-install", "commitlint"], {
    cwd,
    input: message,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) return { ok: false, output: `could not run commitlint: ${run.error.message}` };
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

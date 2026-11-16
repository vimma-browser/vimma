import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobs, parseWorkflow } from "./workflow-runners.ts";
import type { Job } from "./workflow-types.ts";

// docs/security/14-build-and-release-supply-chain.md, B20 (docs/specs/build-supply-chain.md,
// Behaviour 7). One repository-wide guard: every file git tracks is read, so a new
// workflow, script, runbook or agent instruction is held to the rules without being listed.
// What installs a package installs it from the lockfile (`npm ci`), npx runs only a binary the
// lockfile already holds, every action is pinned by commit, and every lockfile entry comes from
// the npm registry with an integrity hash.

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Files that are only history or data: never run, never read as instructions. */
const SKIP = new Set([
  "CHANGELOG.md", // released history
  "package-lock.json", // read as data below
]);
const SKIP_DIRS = ["tools/package/vendor/"]; // third-party JSON schemas and licence lists

/**
 * The guards' own code and tests hold the commands they refuse as fixtures. Only these files may
 * mark a block of lines as fixtures, and only the marked lines are skipped.
 */
const FIXTURE_FILES = new Set([
  "tools/test/build-supply-chain.test.ts",
  "tools/test/supply-chain.test.ts",
  // The plugin's Bash guard refuses the same commands for agents: its block messages, rules and
  // test cases name them.
  "tools/claude-plugin/hooks/lib/bash-rules.mjs",
  "tools/claude-plugin/test/bash-guard.test.ts",
]);
const FIXTURES_BEGIN = "// supply-chain-guard: fixtures";
const FIXTURES_END = "// supply-chain-guard: end";

/**
 * Lines allowed to hold what the guard refuses: the whole list, each matched by its file and its
 * exact text, trimmed. A test checks that each still faults without its allowance.
 */
// supply-chain-guard: fixtures
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  // Prose that forbids the command it names.
  [
    "CONTRIBUTING.md",
    "- **No install scripts.** `.npmrc` sets `ignore-scripts=true`, so `npm ci` and `npm install` run",
  ],
  [
    "docs/security/14-build-and-release-supply-chain.md",
    "- B4. An npm install **never** runs install scripts, and the build **must** run Surfer only from",
  ],
  [
    "docs/specs/build-supply-chain.md",
    "7. **No install scripts.** No `npm ci` or `npm install` in the repository runs package",
  ],
  [
    "docs/specs/build-supply-chain.md",
    "- B4. An npm install **never** runs install scripts, and the build **must** run Surfer only from",
  ],
  // Research: Zen's macOS release workflow, as the spec found it.
  [
    "docs/specs/macos-build.md",
    "`cargo install apple-codesign`, the p12 from a secret, `mach macos-sign -r -c release -e",
  ],
  // Test names and fixtures of runner-node.test.ts, which refuses these before a guard.
  [
    "tools/test/runner-node.test.ts",
    'it("finds node, npm or npx at the end of a line too", () => {',
  ],
  [
    "tools/test/runner-node.test.ts",
    '["corepack", { steps: [CHECKOUT, { run: "corepack enable" }, GUARD] }, "step 1"],',
  ],
  [
    "tools/test/runner-node.test.ts",
    '["bun", { steps: [CHECKOUT, { run: "bun x tsc" }, GUARD] }, "step 1"],',
  ],
  // Cross-repository exception: commands run by and in vimma-browser/vimma-updates (its Workers
  // Builds deploy command, and the same by hand from its checkout), which has no lockfile of its
  // own; outside this repository's dependencies.
  [
    "docs/runbook/ci-update-keys-and-update-host.md",
    "repository → `vimma-browser/vimma-updates` (Workers Builds, deploy command `npx wrangler deploy`,",
  ],
  [
    "docs/runbook/ci-update-keys-and-update-host.md",
    "git pull && CLOUDFLARE_API_TOKEN=<workers-token> CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy",
  ],
];
// supply-chain-guard: end

// supply-chain-guard: fixtures
/** npm's names for install and update (`npm help install`, `npm help update`), longest first. */
const INSTALL_NAMES =
  "install-test|install|isntall|instal|isntal|insta|isnta|inst|isnt|ins|in|it|i|add|" +
  "update|udpate|upgrade|up";
/** npm's options before its command, each with or without a value: `--global`, `--prefix dir`. */
const NPM_OPTS = String.raw`(?:--?[\w-]+(?:=\S+|\s+(?!-)[^\s;&|]+)?\s+)*`;
/** Spellings no English sentence holds, checked on every line of every file. */
const INSTALL_ANYWHERE = new RegExp(
  String.raw`\bnpm\s+${NPM_OPTS}(install|isntall|i|add|update|upgrade)(?![\w-])`,
  "g",
);
/** Every spelling, checked where a line is a command (a script, a run: line, code in quotes). */
const INSTALL = new RegExp(String.raw`\bnpm\s+${NPM_OPTS}(${INSTALL_NAMES})(?![\w-])`, "g");
/** npm commands that fetch the package they name: `npm create x`, `npm init x`, `npm link x`. */
const FETCHING_VERB = new RegExp(
  String.raw`\bnpm\s+${NPM_OPTS}(create|init|innit|link|ln)\s+(?!-)[\w@]`,
  "g",
);
/** Runners that fetch whatever they are asked for: there is no form of them that is safe. */
const ALWAYS_FETCH = /\b(?:pnpm\s+dlx|yarn\s+dlx|pnpx|bunx)\b/g;
/** Other package managers' installs, and corepack, which downloads them. */
const OTHER_PM =
  /\b(?:(?:yarn|pnpm|bun)\s+(?:install|i|add|up|upgrade|update|x|dlx)(?![\w-])|corepack\b)/g;
const PIPE_TO_SHELL =
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo(?:\s+-\S+)*\s+)?(?:(?:ba|z|da|k)?sh|python3?|node|perl|ruby)\b/g;
const SUBST_TO_SHELL =
  /(?:^|[\s;&|(`"'])(?:(?:ba|z|da|k)?sh|source|eval|\.)\s+(?:-c\s+)?["']?(?:\$\(|<\()\s*(?:curl|wget)\b/g;
const PIP = /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b[^\n]*/g;
const CARGO_INSTALL = /\bcargo\s+(?:\+\S+\s+)?(?:install|binstall)\b[^\n]*/g;
const CARGO_UNLOCK = /\bcargo\s+(?:\+\S+\s+)?(?:update|generate-lockfile)\b/g;
/** A cargo command that resolves crates, to the end of its shell command. */
const CARGO_RUN =
  /\bcargo\s+(?:\+\S+\s+)?(?:build|test|clippy|run|check|doc|bench|fetch)\b[^\n&;|"]*/g;
// supply-chain-guard: end

/** @returns each cargo command in a script that does not keep to Cargo.lock */
function cargoFaults(run: string): string[] {
  return [
    ...[...run.matchAll(CARGO_RUN)]
      .map((m) => m[0].trim())
      .filter((c) => !/--locked|^cargo\s+(?:\+\S+\s+)?\w+\s+--version$/.test(c)),
    ...[...run.matchAll(CARGO_UNLOCK)].map((m) => m[0]),
  ];
}

/** @returns every path git tracks, relative to the repository root */
function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/** @returns every tracked text file, with its path relative to the repository root */
function trackedText(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  for (const path of tracked()) {
    if (SKIP.has(path) || SKIP_DIRS.some((d) => path.startsWith(d))) continue;
    const buf = readFileSync(new URL(path, root));
    if (buf.includes(0)) continue; // binary
    files.push([path, buf.toString("utf8")]);
  }
  return files;
}

/** The binaries the root's devDependencies install, from the lockfile: all npx may run. */
function lockedBins(): Set<string> {
  const lock = JSON.parse(read("package-lock.json"));
  const bins = new Set<string>();
  for (const name of Object.keys(lock.packages[""].devDependencies ?? {})) {
    const bin = lock.packages[`node_modules/${name}`]?.bin;
    for (const b of Object.keys(bin ?? {})) bins.add(b);
  }
  return bins;
}

/**
 * Every npx or `npm exec` call in a piece of command text that could fetch a package: a `--yes`,
 * a `--package`, or a binary that no devDependency installs. The word followed by anything but
 * a space (`npx` in backticks, at the end of a string) is a mention, not a call.
 * @returns each offending call, from its runner to the end of the piece
 */
export function fetchingNpx(text: string, bins: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:npx|npm\s+(?:exec|x))(?=\s)/g)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const args = rest
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^[`"'(]+|[`"'),.;:]+$/g, ""));
    if (badArgs(args, bins)) out.push(text.slice(m.index).trim());
  }
  return out;
}

/** @returns whether npx with these arguments could fetch a package */
function badArgs(args: string[], bins: ReadonlySet<string>): boolean {
  let no = false;
  for (const a of args) {
    if (a === "--no" || a === "--no-install") no = true;
    if (a === "--no" || a === "--no-install" || a === "--") continue;
    if (/^(?:-y|-yes|--yes|-p|--package|-c|--call)(?:=.*)?$/.test(a)) return true;
    if (a.startsWith("-")) continue; // npm's own options, such as --offline
    // Told --no, npx runs only what is installed: whatever the code fills in, it fetches nothing.
    if (no) return false;
    // An argument the code fills in, by a template or by joining strings, could be any package.
    if (a === "" || a.startsWith("${")) return true;
    // A bin name; anything else (`|`, `<`, a closing quote) ends the command.
    if (!/^[\w@][\w@./-]*$/.test(a)) return false;
    return !bins.has(a);
  }
  return false;
}

/**
 * The string literals a list starts with, up to its first other item (a variable, a call): what
 * decides what npm does. Null when it starts with something else.
 */
function literalList(list: string): string[] | null {
  const out: string[] = [];
  for (const item of list.split(",").map((t) => t.trim())) {
    if (item === "") continue; // a trailing comma
    const m = /^(["'`])([^"'`]*)\1$/.exec(item);
    // What the code fills in, after the first literal, stands as `${}`: it could be any word.
    if (!m && out.length === 0) return null;
    out.push(m ? (m[2] ?? "") : "${}");
  }
  return out.length > 0 ? out : null;
}

/** A string literal in code, without its quotes as a group: a non-capturing pattern. */
const LIT = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\`[^\`\n]*\`)`;
/** Each string literal: its quote, then its text. */
const LITERAL = /(["'`])((?:(?!\1)[^\n])*)\1/g;
/** A program expression that is a ternary of two literals: `win ? "npx.cmd" : "npx"`. */
const TERNARY = new RegExp(String.raw`\?\s*(${LIT})\s*:\s*(${LIT})$`);
/** npm or npx as a program: by a path, or as Windows' `.cmd` shim. */
const NPM_NAME = String.raw`(?:[\w./-]*\/)?(?:npx|npm)(?:\.cmd)?`;
const NPM_PROGRAM = /^(?:[\w./-]*\/)?(npx|npm)(?:\.cmd)?$/;

// supply-chain-guard: fixtures
/**
 * npm or npx spawned from code, as a program and its arguments: execFileSync("npm", ["ci"]) in
 * JavaScript, ["npm", "ci"] in Python. A spawned npx has no terminal, so npm takes `--yes` unless
 * told `--no`: its first argument must say so. The arguments must be a literal list this can
 * read, and a name held in a variable (`const r = "npx"`) is refused, since its call cannot be.
 * npm and npx are known by a path (`/usr/bin/npx`), by Windows' `npx.cmd` and on either side of a
 * ternary. Any program spawned with a literal list is checked as a command with its arguments
 * (`spawn("pnpm", ["install"])`), and so is each literal argument (`spawn("sh", ["-c", …])`).
 * @returns each refused spawn, with its offset in `text`
 */
function spawnFaults(text: string, bins: ReadonlySet<string>): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const add = (at: number, call: string) => out.push([at, call.replace(/\s+/g, " ")]);
  /**
   * Checks one spawn: each program it may run (both sides of a ternary), with its arguments, and
   * every literal argument on its own, as a shell given `-c` would run it.
   */
  const check = (at: number, call: string, progs: string[], list: string | undefined) => {
    const literals = [...(list ?? "").matchAll(LITERAL)].map((l) => l[2] ?? "");
    const args = list === undefined ? null : literalList(list);
    for (const prog of progs) {
      const npm = NPM_PROGRAM.exec(prog)?.[1];
      if (npm && args === null) return add(at, call);
      const name = npm ?? prog;
      if (npm === "npx" && !["--no", "--no-install"].includes(args?.[0] ?? ""))
        return add(at, call);
      if (args !== null && commandFaults(`${name} ${args.join(" ")}`, bins).length > 0)
        return add(at, call);
    }
    if (literals.some((l) => commandFaults(l, bins).length > 0)) add(at, call);
  };
  /** The programs of a program expression: a literal, or both sides of a ternary. */
  const progsOf = (expr: string) => {
    const t = TERNARY.exec(expr);
    return (t ? [t[1] ?? "", t[2] ?? ""] : [expr]).map((l) => l.slice(1, -1));
  };
  // spawn("npx", [ … ]), spawn(win ? "npx.cmd" : "npx", args), ["npm", [ … ]]: the program, then
  // its arguments, which must be a list to be read.
  const call = new RegExp(
    String.raw`([([])\s*((?:[^,?;\n]*?\?\s*${LIT}\s*:\s*)?${LIT})\s*,\s*(?:\[([^\]]*)\]|(?=\S))`,
    "g",
  );
  for (const m of text.matchAll(call)) {
    // ["npm", "ci"] is a list of literals, read below.
    if (m[1] === "[" && m[3] === undefined) continue;
    check(m.index ?? 0, m[0], progsOf((m[2] ?? "").trim()), m[3]);
  }
  // [ "npm", "install", … ]: a list that starts with the program and its literal arguments; what
  // follows them (`pkg`, `out`) is read as a word the code fills in.
  const list = new RegExp(String.raw`\[\s*(${LIT})\s*,((?:\s*${LIT}\s*,?)+[^\]\n]*)`, "g");
  for (const m of text.matchAll(list)) check(m.index ?? 0, m[0], progsOf(m[1] ?? ""), m[2]);
  // The program's name held in a variable, or first in a list whose next item is not a literal.
  const held = new RegExp(
    String.raw`=\s*(["'\`])${NPM_NAME}\1\s*[;,)\n]|\[\s*(["'\`])${NPM_NAME}\2\s*,\s*(?![\s"'\`[\]])`,
    "g",
  );
  for (const m of text.matchAll(held)) add(m.index ?? 0, m[0]);
  return out;
}
// supply-chain-guard: end

/** @returns each of npm's install or update commands in `text`, but prose forbidding one */
function installs(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    // Prose saying the opposite: "no" or "never" (or "not", "without") just before it.
    const before = text.slice(0, m.index).replace(/[`*_\s]+$/, "");
    if (!/\b(?:no|never|not|without)$/i.test(before)) out.push(`npm ${m[1]}: ${m[0]}`);
  }
  return out;
}

/** @returns each forbidden install or fetch that is wrong anywhere on a line, prose included */
function anywhereFaults(line: string): string[] {
  const faults = installs(line, INSTALL_ANYWHERE);
  for (const m of line.matchAll(ALWAYS_FETCH)) faults.push(`fetching runner: ${m[0]}`);
  for (const re of [PIPE_TO_SHELL, SUBST_TO_SHELL])
    for (const m of line.matchAll(re)) faults.push(`download run by a shell: ${m[0].trim()}`);
  for (const m of line.matchAll(PIP))
    if (!/--require-hashes/.test(m[0])) faults.push(`unhashed pip: ${m[0]}`);
  for (const m of line.matchAll(CARGO_INSTALL)) {
    if (!/--locked/.test(m[0])) faults.push(`unlocked cargo: ${m[0]}`);
    else if (/--git\b/.test(m[0]) && !/--rev\s+[0-9a-f]{40}\b/.test(m[0]))
      faults.push(`cargo git source without a commit: ${m[0]}`);
  }
  return faults;
}

/** @returns each forbidden install or fetch in a piece of text that is a command */
function commandFaults(text: string, bins: ReadonlySet<string>): string[] {
  return [
    ...anywhereFaults(text),
    ...installs(text, INSTALL),
    ...[...text.matchAll(FETCHING_VERB)].map((m) => `npm ${m[1]} <package>: ${m[0]}`),
    ...[...text.matchAll(OTHER_PM)].map((m) => `another package manager: ${m[0]}`),
    ...[...text.matchAll(CARGO_UNLOCK)].map((m) => `cargo off its lockfile: ${m[0]}`),
    ...[...text.matchAll(/\bcargo\s+(?:\+\S+\s+)?fetch\b[^\n&;|"]*/g)]
      .filter((m) => !/--locked/.test(m[0]))
      .map((m) => `cargo fetch without --locked: ${m[0]}`),
    ...fetchingNpx(text, bins).map((call) => `fetching npx: ${call}`),
  ];
}

/** @returns each forbidden install or fetch on one line read as a command */
export function lineFaults(line: string, bins: ReadonlySet<string>): string[] {
  return [
    ...new Set([
      ...commandFaults(line, bins),
      ...spawnFaults(line, bins).map(([, call]) => `spawned npm: ${call}`),
    ]),
  ];
}

/** Files whose every line is a command or a comment: scripts, workflows, package.json. */
const SHELL_LIKE =
  /\.(?:sh|bash|zsh|fish|ps1|cmd|bat|ya?ml|toml|json|jsonc)$|(?:^|\/)(?:Makefile|Dockerfile|PKGBUILD|mozconfig)$/;
/** Files whose comments are prose: Markdown, and code. */
const isShellLike = (path: string, text: string) => SHELL_LIKE.test(path) || text.startsWith("#!");

/**
 * The parts of a line that are commands: the whole line, less its comment, in a script or a
 * workflow, and each line of a fenced block in Markdown; elsewhere code in backticks that is not
 * a test's name in a link, and in code every string literal too.
 */
function commandPieces(path: string, line: string, shell: boolean, fenced: boolean): string[] {
  if (shell || fenced) return [line.replace(/(?:^|\s)#.*$/, "")];
  // A test's name in a link to it (docs/security) is a name, not a command.
  const pieces = [...line.matchAll(/`([^`]+)`(?!\]\()/g)].map((m) => m[1] ?? "");
  if (!path.endsWith(".md"))
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g))
      pieces.push(m[1] ?? m[2] ?? "");
  return pieces;
}

/**
 * @param allow whether the allowed lines are skipped; off, to check each still faults
 * @returns [line number, fault] for every fault in one file
 */
export function fileFaults(
  path: string,
  text: string,
  bins: ReadonlySet<string>,
  allow = true,
): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const shell = isShellLike(path, text);
  const lines = text.split("\n");
  const skip = new Set<number>();
  let fenced = false;
  let fixtures = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === FIXTURES_BEGIN || t === FIXTURES_END) {
      if (!FIXTURE_FILES.has(path)) out.push([i + 1, "a fixture marker outside the guard's tests"]);
      fixtures = t === FIXTURES_BEGIN;
      skip.add(i + 1);
      return;
    }
    const fence = path.endsWith(".md") && /^(?:```|~~~)/.test(t);
    if (fence) fenced = !fenced;
    if (fence || (fixtures && FIXTURE_FILES.has(path))) return void skip.add(i + 1);
    if (allow && ALLOWED.some(([p, l]) => p === path && l === t)) return void skip.add(i + 1);
    const faults = new Set(anywhereFaults(line));
    // In a script, a line continued with a backslash is read with the lines it runs on to.
    let command = line;
    for (let j = i; shell && /\\\s*$/.test(lines[j] ?? "") && j + 1 < lines.length; j++)
      command = `${command.replace(/\s*\\\s*$/, "")} ${(lines[j + 1] ?? "").trim()}`;
    for (const piece of commandPieces(path, command, shell, fenced))
      for (const f of commandFaults(piece, bins)) faults.add(f);
    for (const f of faults) out.push([i + 1, f]);
  });
  if (fixtures) out.push([lines.length, "a fixture block that is never closed"]);
  for (const [at, call] of spawnFaults(text, bins)) {
    const line = text.slice(0, at).split("\n").length;
    if (!skip.has(line)) out.push([line, `spawned npm: ${call}`]);
  }
  // A step's command as the shell gets it: a block's continued lines and a folded scalar joined.
  const seen = new Set(out.map(([n, f]) => `${n}:${f}`));
  for (const run of stepRuns(path, text)) {
    for (const command of run.replace(/\\\n\s*/g, " ").split("\n")) {
      const at = lineOf(lines, command);
      for (const f of commandFaults(command.replace(/(?:^|\s)#.*$/, ""), bins)) {
        if (skip.has(at) || seen.has(`${at}:${f}`)) continue;
        seen.add(`${at}:${f}`);
        out.push([at, f]);
      }
    }
  }
  return out;
}

/** @returns every step's `run:` of a workflow or a composite action, as YAML parses it */
function stepRuns(path: string, text: string): string[] {
  const steps: unknown[] = [];
  try {
    if (/(?:^|\/)action\.ya?ml$/.test(path)) {
      const doc = parseWorkflow(text) as { runs?: { steps?: unknown } } | null;
      if (Array.isArray(doc?.runs?.steps)) steps.push(...doc.runs.steps);
    } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) {
      for (const job of (jobs(text) as Map<string, Job>).values()) steps.push(...(job.steps ?? []));
    }
  } catch {
    return []; // not YAML a runner reads: its lines are still read one by one
  }
  return steps
    .map((s) => (s as { run?: unknown } | null)?.run)
    .filter((r): r is string => typeof r === "string");
}

/** @returns the number of the first line a command starts on, or 1 if none can be told */
function lineOf(lines: string[], command: string): number {
  const at = lines.findIndex((l) => {
    const t = l
      .trim()
      .replace(/^-?\s*run:\s*(?:[|>][+-]?|["'])?\s*/, "")
      .replace(/\s*\\$/, "");
    return t !== "" && command.trim().startsWith(t);
  });
  return at + 1 || 1;
}

/** @returns `path:line: fault` for every fault in every tracked file but the allowed lines */
function repoFaults(): string[] {
  const bins = lockedBins();
  const out: string[] = [];
  for (const [path, text] of trackedText())
    for (const [line, f] of fileFaults(path, text, bins)) out.push(`${path}:${line}: ${f}`);
  return out;
}

/** A workflow's or a composite action's `uses:` values, read from the parsed YAML. */
function usesOf(text: string, name: string): string[] {
  const doc = parseWorkflow(text) as Record<string, unknown>;
  const out: string[] = [];
  const steps = (s: unknown) => {
    if (!Array.isArray(s)) return;
    for (const step of s) if (step && typeof step.uses === "string") out.push(step.uses);
  };
  if (/(?:^|\/)action\.ya?ml$/.test(name)) {
    steps((doc.runs as Record<string, unknown> | undefined)?.steps);
    return out;
  }
  for (const job of (jobs(text) as Map<string, Record<string, unknown>>).values()) {
    if (typeof job.uses === "string") out.push(job.uses);
    steps(job.steps);
  }
  return out;
}

/** @returns each job's container and service images, as `job: image` */
function imagesOf(text: string): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [id, job] of jobs(text) as Map<string, Record<string, unknown>>) {
    const c = job.container;
    if (c !== undefined)
      out.push([
        `${id} container`,
        typeof c === "object" && c ? (c as { image?: unknown }).image : c,
      ]);
    for (const [name, svc] of Object.entries((job.services ?? {}) as Record<string, unknown>))
      out.push([`${id} service ${name}`, (svc as { image?: unknown } | null)?.image]);
  }
  return out;
}

/** Whether a container image is pinned by its digest. */
const pinnedImage = (image: unknown) =>
  typeof image === "string" && /^[\w./:-]+@sha256:[0-9a-f]{64}$/.test(image);

/**
 * Whether an action reference runs only reviewed, unchanging code: a file of this repository, an
 * action pinned to a full commit, or a Docker image pinned by digest.
 */
export function pinned(uses: string): boolean {
  if (/^\.\/[\w./-]+$/.test(uses) && !uses.includes("..")) return true;
  if (/^docker:\/\/[\w./:-]+@sha256:[0-9a-f]{64}$/.test(uses)) return true;
  return /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(uses);
}

/** The one lockfile entry outside the registry: a dependency of Surfer, pinned by commit. */
const GIT_EXCEPTION = {
  "node_modules/is-apple-silicon":
    "git+ssh://git@github.com/trickypr/is-apple-silicon.git#5f75501a1d7566ba9f94174b6825d7bd9d302b6a",
};

type LockEntry = { resolved?: string; integrity?: string; link?: boolean; version?: string };

/** @returns each lockfile entry that npm ci would not take from the registry by its hash */
export function lockFaults(lock: {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}): string[] {
  const faults: string[] = [];
  if (lock.lockfileVersion !== 3) faults.push(`lockfileVersion ${lock.lockfileVersion}`);
  const exceptions: Record<string, string> = GIT_EXCEPTION;
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue;
    if (/^packages\/[\w-]+$/.test(key) && !e.resolved) continue; // a workspace's own entry
    if (e.link) {
      if (!/^packages\/[\w-]+$/.test(e.resolved ?? ""))
        faults.push(`${key}: link to ${e.resolved}`);
      continue;
    }
    if (key in exceptions) {
      if (e.resolved !== exceptions[key]) faults.push(`${key}: resolved ${e.resolved}`);
      continue;
    }
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const tarball = name.slice(name.lastIndexOf("/") + 1);
    const url = `https://registry.npmjs.org/${name}/-/${tarball}-${e.version}.tgz`;
    if (e.resolved !== url) faults.push(`${key}: resolved ${e.resolved}`);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity ?? ""))
      faults.push(`${key}: integrity ${e.integrity}`);
  }
  return faults;
}

/** A version npm resolves from the registry: an exact version or a caret or tilde range. */
const REGISTRY_SPEC = /^[\^~]?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** @returns each dependency spec in a package.json that is not a registry version range */
export function specFaults(pkg: Record<string, unknown>, file: string): string[] {
  const faults: string[] = [];
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  for (const field of [...fields, "overrides", "bundleDependencies", "bundledDependencies"]) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (field.startsWith("bundle")) {
      faults.push(`${file} ${field}: a bundled package skips the lockfile's hash`);
      continue;
    }
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string" || !REGISTRY_SPEC.test(spec))
        faults.push(`${file} ${field}.${name}: ${JSON.stringify(spec)}`);
    }
  }
  return faults;
}

describe("supply chain: what installs and runs packages", () => {
  const bins = lockedBins();
  /** A workflow whose one step is `step`, its later lines indented as a step's keys. */
  const WORKFLOW = (step: string) =>
    `on: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - ${step}\n`;

  // Reads every tracked file: about two seconds, more on a loaded machine.
  it(
    "no tracked file installs a package outside the lockfile or pipes a download to a shell",
    {
      timeout: 60_000,
    },
    () => {
      expect(repoFaults()).toEqual([]);
    },
  );

  // supply-chain-guard: fixtures
  it("reads an npx call from code whose arguments span lines", () => {
    const code = 'execFileSync(\n  "npx",\n  [\n    "prettier",\n    out,\n  ],\n);';
    expect(spawnFaults(code, bins)).not.toEqual([]);
    expect(spawnFaults(code.replace('"prettier"', '"--no", "--", "prettier"'), bins)).toEqual([]);
  });

  it.each([
    ["tools/x.ts", 'execSync("npx left-pad");'],
    ["tools/x.ts", "// runs it: execSync('npm --prefix site install')"],
    ["tools/x.ts", 'const r = "npx";\nexecFileSync(r, ["x"]);'],
    ["tools/x.ts", 'spawnSync("npm", ["exec", "x"]);'],
    ["tools/x.py", 'subprocess.run(["npm", "install", "x"], check=True)'],
    ["tools/x.py", 'subprocess.run(\n    [\n        "npm",\n        "install",\n    ]\n)'],
    ["tools/x", "#!/bin/sh\nnpm i x"],
    ["configs/linux/mozconfig", "npm i x"],
    ["tools/x.zsh", "pnpm install"],
    ["docs/x.md", "Run:\n\n```sh\nnpm in x\n```"],
    ["docs/x.md", "Run `yarn add x` first."],
    ["docs/x.md", "Or install it with npm install x."],
    ["tools/x.ts", "// supply-chain-guard: fixtures\nnpm i x"],
    // npx with an argument the code fills in: it could be any package.
    ["tools/x.ts", "execSync(`npx ${pkg}`);"],
    ["tools/x.ts", 'execSync("npx " + pkg);'],
    ["tools/x.ts", 'execSync(["npx", pkg].join(" "));'],
    ["tools/x.py", 'subprocess.run(["npx.cmd", "left-pad"])'],
    ["tools/x.py", 'subprocess.run(["pnpm", "install"])'],
    // A command split over lines of a run: block or a folded scalar.
    [".github/workflows/x.yml", WORKFLOW("run: |\n          npm \\\n            install")],
    [".github/workflows/x.yml", WORKFLOW("run: >-\n          npx\n          left-pad")],
    [".github/workflows/x.yml", WORKFLOW("run: npx\n          left-pad")],
    // A shell script's line continued with a backslash.
    ["tools/x.sh", "#!/bin/sh\nnpm \\\n  install x"],
    ["Makefile", "deps:\n\tnpm \\\n\t  i x"],
    [
      "tools/x/action.yml",
      "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: >\n        npm\n        install",
    ],
  ])("finds the command in %s: %j", (path, text) => {
    expect(fileFaults(path, text, bins, false)).not.toEqual([]);
  });

  it("reports a joined run: command once, on the line it starts on", () => {
    const text = WORKFLOW('run: "npm \\\n          install"');
    expect(fileFaults(".github/workflows/x.yml", text, bins, false)).toEqual([
      [6, "npm install: npm install"],
    ]);
  });

  it.each([
    ["tools/x.ts", "// Node's built-ins only: no npm install, and npx in a comment is prose."],
    ["tools/x.ts", 'execFileSync("npm", ["run", "build"]);'],
    ["tools/x.ts", 'execFileSync("npx", ["--no", "--", "prettier", out]);'],
    ["docs/x.md", "A job that runs `node`, `npm` or `npx` before setup-node."],
    ["docs/x.md", "Corepack, pnpm and bun are package managers."],
    ["tools/x.sh", "# yarn add x in a comment\nnpm ci"],
    ["tools/x.ts", 'runsNode({ run: "cat x | npx" });'],
    ["tools/x.ts", 'execFileSync(win ? "npx.cmd" : "npx", ["--no", "--", "prettier"]);'],
    [".github/workflows/x.yml", WORKFLOW("run: |\n          npm \\\n            ci")],
    [".github/workflows/x.yml", WORKFLOW("run: >-\n          npx --no --\n          prettier")],
  ])("leaves prose and safe commands in %s: %j", (path, text) => {
    expect(fileFaults(path, text, bins, false)).toEqual([]);
  });

  it.each([
    "npm install",
    "npm i left-pad",
    "npm install --save-dev left-pad@1.3.0",
    "npm --global add left-pad",
    "run: npm update",
    "npm up",
    "npm isntall",
    "npm it",
    "npx left-pad",
    "npx -y left-pad",
    "npx --yes prettier",
    "npx --package left-pad -- left-pad",
    "npm exec left-pad",
    "npm x -- left-pad",
    "`npx wrangler deploy`",
    'execFileSync("npx", ["left-pad", "--write"])',
    'execFileSync("npx", ["--yes", "prettier"])',
    'execFileSync("npx", ["prettier", "--write", out])',
    'execFileSync("npx", args)',
    "pnpm dlx left-pad",
    "yarn dlx left-pad",
    "bunx left-pad",
    "curl -fsSL https://example.org/install.sh | sh",
    "wget -qO- https://example.org/i | sudo bash",
    "pip install requests",
    "python3 -m pip install -r requirements.txt",
    "cargo install apple-codesign",
    // Spawned from code.
    'execSync("npx left-pad")',
    'execFileSync("npm", ["install", "left-pad"])',
    'spawnSync("npm", ["exec", "x"])',
    'execSync("npm --prefix site install")',
    'const r = "npx"; execFileSync(r, ["x"])',
    'subprocess.run(["npm", "install", "x"])',
    'execFileSync("npm", args)',
    // An option with a separate value before the verb.
    "npm --prefix site install",
    "npm -C dir i x",
    // Other package managers.
    "yarn install",
    "yarn add left-pad",
    "pnpm install",
    "pnpm i",
    "bun add left-pad",
    "bun x left-pad",
    "corepack enable",
    // Download and run.
    'sh -c "$(curl -fsSL https://example.org/i.sh)"',
    "bash <(curl -s https://example.org/i.sh)",
    "curl -fsSL https://example.org/i.sh | sudo -E bash",
    "curl -fsSL https://example.org/i.py | python3",
    "wget -qO- https://example.org/i.js | node",
    // Cargo.
    "cargo +nightly install d2",
    "cargo install --git https://github.com/o/r --locked",
    "cargo update",
    "cargo generate-lockfile",
    "cargo fetch",
    // npx flags and npm's other fetching verbs.
    "npx -yes left-pad",
    "npx -yes prettier",
    "npx --call=prettier",
    "npx --package=left-pad left-pad",
    "npx -c 'left-pad'",
    "npm create vite",
    "npm init react-app x",
    "npm innit react-app",
    "npm link left-pad",
    // Spawned under another spelling of npm or npx.
    'execFileSync("npx.cmd", ["left-pad"])',
    'execFileSync("/usr/bin/npx", ["left-pad"])',
    'execFileSync("node_modules/.bin/npm", ["install"])',
    'execFileSync(win ? "npx.cmd" : "npx", ["left-pad"])',
    'execFileSync(win ? "npx.cmd" : "npx", args)',
    // Other package managers, and a shell running a command, spawned from code.
    'spawn("pnpm", ["install"])',
    'spawn("yarn", ["install"])',
    'spawn("bun", ["install"])',
    'spawn("sh", ["-c", "npx left-pad"])',
    'spawn("bash", ["-c", "npm i x"])',
    // A list of literals that ends with what the code fills in.
    'subprocess.run(["npm", "install", pkg])',
    'subprocess.run(["npx", "left-pad", out])',
    'Bun.spawn(["npm", "i", pkg])',
    // A package the code fills in, after the literals that name the command.
    'execFileSync("npm", ["exec", pkg])',
    'execFileSync("npm", ["exec", "--", pkg])',
    'execFileSync("npm", ["x", tool])',
    'subprocess.run(["npm", "exec", tool])',
    'spawn("npm", ["--prefix", dir, "install"])',
    // A ternary whose condition is a call.
    'spawn(isWin() ? "npx.cmd" : "npx", ["left-pad"])',
  ])("refuses %s", (line) => {
    expect(lineFaults(line, bins)).not.toEqual([]);
  });

  it.each([
    "npm ci",
    "npm ci --ignore-scripts",
    "npm install-ci-test",
    "npm run lint",
    "npm diff --ignore-scripts",
    "# Node's built-in modules only: no npm install.",
    "it never runs: never `npm install`",
    "npx surfer build",
    "npx --no -- surfer build --ui",
    "`npx commitlint < msg.txt`",
    "npx vitest run tools/",
    'execFileSync("npx", ["--no", "--", "prettier", "--write", out])',
    '["npx", ["--no-install", "commitlint"]]',
    "a job that runs `node`, `npm` or `npx` before",
    'runsNode({ run: "cat x | npx" })',
    "curl -fsSL -o file https://example.org/file",
    "pip install --require-hashes -r requirements.txt",
    "cargo install --locked d2",
    "cargo build --release --locked",
    'execFileSync("npm", ["run", "build"])',
    'spawnSync("npm", ["ci", "--ignore-scripts"])',
    'code=$(curl -sS --proto =https -o "$f" -w "%{http_code}" "$url")',
    "curl -fsSL -o x https://example.org/x && sha256sum -c x.sha256",
    "npm --global ls",
    "cargo install --git https://github.com/o/r --rev 0123456789abcdef0123456789abcdef01234567 --locked",
    "cargo fetch --locked",
    'execFileSync(win ? "npx.cmd" : "npx", ["--no", "--", "prettier"])',
    'execFileSync("/usr/bin/npm", ["ci"])',
    'spawn("pnpm", ["run", "build"])',
    'spawn("sh", ["-c", "npm ci"])',
    'subprocess.run(["npx", "--no", "--", "prettier", out])',
    'execFileSync("npx", ["--no", "--", tool])',
    'spawn(isWin() ? "npx.cmd" : "npx", ["--no", "--", "prettier"])',
    'execFileSync("npm", ["run", script])',
  ])("allows %s", (line) => {
    expect(lineFaults(line, bins)).toEqual([]);
  });
  // supply-chain-guard: end

  it("the devDependencies' binaries are the ones `npx` may run", () => {
    for (const b of ["surfer", "commitlint", "vitest", "prettier", "eslint", "tsc", "stryker"])
      expect(bins.has(b), b).toBe(true);
    expect(bins.has("wrangler")).toBe(false);
  });

  it("each allowed line is still there and still faults without its allowance", () => {
    expect(ALLOWED).toHaveLength(10);
    for (const [path, line] of ALLOWED) {
      const text = read(path);
      const at = text.split("\n").findIndex((l) => l.trim() === line) + 1;
      expect(at, `${path}: ${line}`).toBeGreaterThan(0);
      const faults = fileFaults(path, text, bins, false).filter(([n]) => n === at);
      expect(faults, `${path}:${at}`).not.toEqual([]);
    }
  });

  it("every cargo command a workflow runs keeps to Cargo.lock", () => {
    const faults: string[] = [];
    for (const path of tracked().filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
      for (const [id, job] of jobs(read(path)) as Map<string, Job>) {
        for (const step of job.steps ?? []) {
          for (const c of cargoFaults(String(step.run ?? ""))) faults.push(`${path} ${id}: ${c}`);
        }
      }
    }
    expect(faults).toEqual([]);
    // supply-chain-guard: fixtures
    expect(cargoFaults("cargo build --release")).toEqual(["cargo build --release"]);
    expect(cargoFaults("cargo +nightly test")).toEqual(["cargo +nightly test"]);
    expect(cargoFaults("cargo update -p x")).toEqual(["cargo update"]);
    expect(cargoFaults("cd x && cargo test --locked; cargo clippy --version")).toEqual([]);
    // supply-chain-guard: end
  });
});

describe("supply chain: GitHub Actions", () => {
  it("every action, reusable workflow and composite action step is pinned by full commit", () => {
    const files = tracked().filter((p) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$|(?:^|\/)action\.ya?ml$/.test(p),
    );
    const all: string[] = [];
    for (const path of files) {
      const uses = usesOf(read(path), path);
      all.push(...uses);
      for (const u of uses) expect(pinned(u), `${path}: uses ${u}`).toBe(true);
    }
    expect(all.length).toBeGreaterThan(100);
  });

  it("every job's container and service image is pinned by digest", () => {
    for (const path of tracked().filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)))
      for (const [where, image] of imagesOf(read(path)))
        expect(pinnedImage(image), `${path} ${where}: ${String(image)}`).toBe(true);
    const text = [
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-24.04",
      "    container: node:22",
      "    services:",
      "      db:",
      `        image: postgres@sha256:${"a".repeat(64)}`,
      "      cache:",
      "        image: redis:7",
      "  b:",
      "    runs-on: ubuntu-24.04",
      "    container:",
      "      image: fedora:42",
    ].join("\n");
    expect(imagesOf(text).filter(([, i]) => !pinnedImage(i))).toEqual([
      ["a container", "node:22"],
      ["a service cache", "redis:7"],
      ["b container", "fedora:42"],
    ]);
  });

  it.each([
    ["actions/checkout@v7", false],
    ["actions/checkout@main", false],
    ["actions/checkout@3d3c42e", false],
    ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", true],
    ["github/codeql-action/init@33d7b85da1a04171e211befe2c739303b9a4c066", true],
    ["octo/repo/.github/workflows/x.yml@main", false],
    ["./.github/workflows/e2e.yml", true],
    ["./../other/action", false],
    ["docker://alpine:3.20", false],
    [`docker://alpine@sha256:${"a".repeat(64)}`, true],
  ])("pinned(%s) is %s", (uses, ok) => {
    expect(pinned(uses)).toBe(ok);
  });

  it("finds a job-level reusable workflow and a step's action in a parsed workflow", () => {
    const text = [
      "on: push",
      "jobs:",
      "  a:",
      "    uses: octo/repo/.github/workflows/x.yml@main",
      "  b:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - uses: 'actions/checkout@v7'",
    ].join("\n");
    expect(usesOf(text, "w.yml").filter((u) => !pinned(u))).toEqual([
      "octo/repo/.github/workflows/x.yml@main",
      "actions/checkout@v7",
    ]);
  });
});

describe("supply chain: the npm lockfile", () => {
  it("every package comes from registry.npmjs.org with a sha512 integrity, but the one listed", () => {
    expect(lockFaults(JSON.parse(read("package-lock.json")))).toEqual([]);
  });

  it.each([
    ["no integrity", { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" }],
    [
      "another registry",
      {
        version: "1.0.0",
        resolved: "https://registry.example.org/a/-/a-1.0.0.tgz",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    ],
    [
      "a git dependency",
      { version: "1.0.0", resolved: "git+https://github.com/o/a.git#main", integrity: undefined },
    ],
    [
      "a sha1 integrity",
      {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
        integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    ],
    ["a link out of the workspaces", { link: true, resolved: "../elsewhere" }],
  ])("refuses an entry with %s", (_, entry) => {
    const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/a": entry } };
    expect(lockFaults(lock)).not.toEqual([]);
  });

  it("the git exception holds only while it stays at its commit", () => {
    const lock = JSON.parse(read("package-lock.json"));
    lock.packages["node_modules/is-apple-silicon"].resolved =
      "git+ssh://git@github.com/trickypr/is-apple-silicon.git#main";
    expect(lockFaults(lock)).toEqual([
      "node_modules/is-apple-silicon: resolved git+ssh://git@github.com/trickypr/is-apple-silicon.git#main",
    ]);
  });

  it("no package.json names a dependency by git, URL, path, tag or bundle", () => {
    const files = tracked().filter((p) => /(?:^|\/)package\.json$/.test(p));
    expect(files).toContain("package.json");
    for (const path of files) expect(specFaults(JSON.parse(read(path)), path)).toEqual([]);
    for (const spec of [
      "github:o/a",
      "git+https://github.com/o/a.git",
      "https://example.org/a.tgz",
      "file:../a",
      "latest",
      "*",
      "1.x",
      ">=1.0.0",
    ]) {
      expect(specFaults({ devDependencies: { a: spec } }, "p"), spec).not.toEqual([]);
    }
    expect(specFaults({ bundleDependencies: ["a"] }, "p")).not.toEqual([]);
  });

  it("one lockfile and one .npmrc, which sets no other registry", () => {
    const files = tracked();
    const pm =
      /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs)$/;
    expect(files.filter((f) => pm.test(f)).sort()).toEqual([".npmrc", "package-lock.json"]);
    const npmrc = read(".npmrc")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    expect(npmrc).toEqual(["ignore-scripts=true"]);
  });
});

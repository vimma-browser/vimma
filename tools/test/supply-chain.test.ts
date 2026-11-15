import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobs, parseWorkflow } from "./workflow-runners.mjs";
import type { Job } from "./workflow-types.ts";

// docs/security/14-build-and-release-supply-chain.md, B20 (docs/specs/build-supply-chain.md,
// Behaviour 7). One repository-wide guard: every file git tracks is read, so a new
// workflow, script, runbook or agent instruction is held to the rules without being listed.
// What installs a package installs it from the lockfile (`npm ci`), npx runs only a binary the
// lockfile already holds, every action is pinned by commit, and every lockfile entry comes from
// the npm registry with an integrity hash.

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Files that hold examples of the forbidden commands on purpose, or only history. */
const SKIP = new Set([
  "CHANGELOG.md", // released history, never run
  "package-lock.json", // read as data below
  "tools/test/build-supply-chain.test.ts", // its fixtures are the commands it refuses
  "tools/test/supply-chain.test.ts", // this file's fixtures
]);
const SKIP_DIRS = ["tools/package/vendor/"]; // third-party JSON schemas and licence lists

/**
 * Lines that name a forbidden command as prose, not as something to run: the whole list, each
 * matched by its file and an exact piece of the line.
 */
const PROSE: ReadonlyArray<readonly [string, string]> = [
  ["CONTRIBUTING.md", "so `npm ci` and `npm install` run"],
  ["docs/security/14-build-and-release-supply-chain.md", "An npm install **never** runs"],
  ["docs/specs/build-supply-chain.md", "No `npm ci` or `npm install` in the repository"],
  ["docs/specs/build-supply-chain.md", "An npm install **never** runs"],
  // Zen's macOS release workflow, as the spec's research found it.
  ["docs/specs/macos-build.md", "`cargo install apple-codesign`, the p12 from a secret"],
  // Commands run in vimma-browser/vimma-updates, another repository, not with this lockfile.
  ["docs/runbook/ci-update-keys-and-update-host.md", "deploy command `npx wrangler deploy`"],
  ["docs/runbook/ci-update-keys-and-update-host.md", "npx wrangler deploy"],
];

/** A cargo command that resolves crates, to the end of its shell command. */
const CARGO_RUN = /\bcargo\s+(?:build|test|clippy|run|check|doc|bench)\b[^\n&;|"]*/g;

/** @returns each cargo command in a run: script that does not keep to Cargo.lock */
function cargoFaults(run: string): string[] {
  return [...run.matchAll(CARGO_RUN)]
    .map((m) => m[0].trim())
    .filter((c) => !/--locked|^cargo\s+\w+\s+--version$/.test(c));
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

/** npm's names for install and update (`npm help install`, `npm help update`), longest first. */
const INSTALL_NAMES =
  "install-test|install|isntall|instal|isntal|insta|isnta|inst|isnt|ins|in|it|i|add|" +
  "update|udpate|upgrade|up";
/** Spellings no English sentence holds, checked on every line of every file. */
const INSTALL_ANYWHERE =
  /\bnpm\s+(?:--?[\w-]+(?:=\S+)?\s+)*(install|isntall|i|add|update|upgrade)(?![\w-])/g;
/** Every spelling, checked where a line is a command (a script, a run: line, code in backticks). */
const INSTALL = new RegExp(
  `\\bnpm\\s+(?:--?[\\w-]+(?:=\\S+)?\\s+)*(${INSTALL_NAMES})(?![\\w-])`,
  "g",
);
/** Runners that fetch whatever they are asked for: there is no form of them that is safe. */
const ALWAYS_FETCH = /\b(?:pnpm\s+dlx|yarn\s+dlx|pnpx|bunx)\b/g;
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/g;
const PIP = /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b[^\n]*/g;
const CARGO_INSTALL = /\bcargo\s+(?:install|binstall)\b[^\n]*/g;

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

/**
 * npx spawned from code: execFileSync("npx", ["--no", "--", "prettier", …]). A spawned npx has
 * no terminal, so npm takes `--yes` unless told `--no`: the first argument must say it, and the
 * arguments must be a literal list this can read.
 */
function fetchingNpxInCode(text: string, bins: ReadonlySet<string>): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const m of text.matchAll(/["'`]npx["'`]\s*,\s*(\[[^\]]*)?/g)) {
    const args = [...(m[1] ?? "").matchAll(/["'`]([^"'`]*)["'`]/g)].map((a) => a[1] ?? "");
    if (!m[1] || !["--no", "--no-install"].includes(args[0] ?? "") || badArgs(args, bins))
      out.push([m.index ?? 0, m[0].replace(/\s+/g, " ")]);
  }
  return out;
}

/** @returns whether npx with these arguments could fetch a package */
function badArgs(args: string[], bins: ReadonlySet<string>): boolean {
  for (const a of args) {
    if (a === "--no" || a === "--no-install" || a === "--") continue;
    if (/^(?:-y|--yes|-p|--package(?:=.*)?|-c|--call(?:=.*)?)$/.test(a)) return true;
    if (a.startsWith("-")) continue; // npm's own options, such as --offline
    // A bin name; anything else (`|`, `<`, a closing quote) ends the command.
    if (!/^[\w@][\w@./-]*$/.test(a)) return false;
    return !bins.has(a);
  }
  return false;
}

/** @returns each npm install or update in `text` that is not prose saying the opposite */
function installs(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    // "no npm install", "never `npm i`": prose saying the opposite.
    const before = text.slice(0, m.index).replace(/[`*_]+$/, "");
    if (!/\b(?:no|never|not|without)\s*$/i.test(before)) out.push(`npm ${m[1]}: ${m[0]}`);
  }
  return out;
}

/** @returns each forbidden install or fetch that is wrong anywhere on a line, prose included */
function anywhereFaults(line: string): string[] {
  const faults = installs(line, INSTALL_ANYWHERE);
  for (const m of line.matchAll(ALWAYS_FETCH)) faults.push(`fetching runner: ${m[0]}`);
  for (const m of line.matchAll(PIPE_TO_SHELL)) faults.push(`download piped to a shell: ${m[0]}`);
  for (const m of line.matchAll(PIP))
    if (!/--require-hashes/.test(m[0])) faults.push(`pip install without hashes: ${m[0]}`);
  for (const m of line.matchAll(CARGO_INSTALL))
    if (!/--locked/.test(m[0])) faults.push(`cargo install without --locked: ${m[0]}`);
  return faults;
}

/** @returns each forbidden install or fetch in a piece of text that is a command */
function commandFaults(text: string, bins: ReadonlySet<string>): string[] {
  return [
    ...installs(text, INSTALL),
    ...fetchingNpx(text, bins).map((call) => `npx that can fetch: ${call}`),
  ];
}

/** @returns each forbidden install or fetch on one line read as a command */
export function lineFaults(line: string, bins: ReadonlySet<string>): string[] {
  return [
    ...new Set([
      ...anywhereFaults(line),
      ...commandFaults(line, bins),
      ...fetchingNpxInCode(line, bins).map(([, call]) => `npx that can fetch: ${call}`),
    ]),
  ];
}

/** Files whose every line is a command or a comment: scripts, workflows, package.json. */
const SHELL_LIKE = /\.(?:sh|bash|ya?ml|toml|json|jsonc)$|(?:^|\/)(?:Makefile|Dockerfile|PKGBUILD)$/;

/**
 * The parts of a line that are commands: the whole line, less its comment, in a script or a
 * workflow; elsewhere (Markdown, code comments) only code in backticks that is not a test's name
 * in a link, and in Markdown each line of a fenced block.
 */
function commandPieces(path: string, line: string, fenced: boolean): string[] {
  if (SHELL_LIKE.test(path) || fenced) return [line.replace(/(?:^|\s)#.*$/, "")];
  // A test's name in a link to it (docs/security) is a name, not a command.
  return [...line.matchAll(/`([^`]+)`(?!\]\()/g)].map((m) => m[1] ?? "");
}

/** @returns `path:line: fault` for every fault in every tracked file but the allowed prose */
function repoFaults(): string[] {
  const bins = lockedBins();
  const out: string[] = [];
  for (const [path, text] of trackedText()) {
    let fenced = false;
    text.split("\n").forEach((line, i) => {
      const fence = path.endsWith(".md") && /^\s*(?:```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      if (fence || PROSE.some(([p, piece]) => p === path && line.includes(piece))) return;
      const faults = new Set(anywhereFaults(line));
      for (const piece of commandPieces(path, line, fenced))
        for (const f of commandFaults(piece, bins)) faults.add(f);
      for (const f of faults) out.push(`${path}:${i + 1}: ${f}`);
    });
    for (const [at, call] of fetchingNpxInCode(text, bins)) {
      const line = text.slice(0, at).split("\n").length;
      out.push(`${path}:${line}: npx that can fetch: ${call}`);
    }
  }
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

  it("reads an npx call from code whose arguments span lines", () => {
    const code = 'execFileSync(\n  "npx",\n  [\n    "prettier",\n    out,\n  ],\n);';
    expect(fetchingNpxInCode(code, bins)).not.toEqual([]);
    expect(fetchingNpxInCode(code.replace('"prettier"', '"--no", "--", "prettier"'), bins)).toEqual(
      [],
    );
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
  ])("allows %s", (line) => {
    expect(lineFaults(line, bins)).toEqual([]);
  });

  it("the binaries npx may run are the devDependencies' own", () => {
    for (const b of ["surfer", "commitlint", "vitest", "prettier", "eslint", "tsc", "stryker"])
      expect(bins.has(b), b).toBe(true);
    expect(bins.has("wrangler")).toBe(false);
  });

  it("the prose allowances each still match a line, so none outlives its text", () => {
    for (const [path, piece] of PROSE) expect(read(path), `${path}: ${piece}`).toContain(piece);
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
    expect(cargoFaults("cargo build --release")).toEqual(["cargo build --release"]);
    expect(cargoFaults("cd x && cargo test --locked; cargo clippy --version")).toEqual([]);
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

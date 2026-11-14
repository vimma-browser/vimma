import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobs, parseWorkflow } from "./workflow-runners.mjs";

// docs/specs/build-supply-chain.md, decisions 12, 14, 16 and 17;
// docs/security/14-build-and-release-supply-chain.md, B3 and B4. Surfer drives the Firefox build:
// it is pinned exactly, never merges without a person, installs without install scripts, and runs
// only from node_modules.
const root = new URL("../../", import.meta.url);
/** @param {string} path */
const read = (path) => readFileSync(new URL(path, root), "utf8");
/** @param {string} name */
const workflow = (name) => read(`.github/workflows/${name}`);
/**
 * @param {string} name
 * @returns {string} the build job's commands: every step's `run:`, one after another
 */
const buildJob = (name) => {
  const steps = jobs(workflow(name)).get("build")?.steps;
  if (!Array.isArray(steps)) throw new Error(`${name}: the build job has no steps`);
  return steps
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.trim())
    .join("\n");
};

const SURFER = "@zen-browser/surfer";

/**
 * Every package runner in a workflow that could fetch a package it does not find locally. npx
 * and npm exec are allowed only as `--no --`; pnpm dlx, yarn dlx and bunx always fetch.
 * @param {string} text a workflow, or a line of one
 * @returns {string[]} each offending call, from its runner to the end of its line
 */
function fetchingRunners(text) {
  /** @type {string[]} */
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    const starts = /\b(?:npx|npm\s+(?:exec|x)|pnpm\s+dlx|yarn\s+dlx|bunx)\b/g;
    for (const m of line.matchAll(starts)) {
      const call = line.slice(m.index);
      if (!/^(?:npx|npm\s+(?:exec|x))\s+--no\s+--\s/.test(call)) out.push(call);
    }
  }
  return out;
}

/**
 * Runs dependabot-automerge.yml's "Decide" step as GitHub would, with the given metadata.
 * @param {{ title: string, update: string, ecosystem?: string, deps: string, releasePath?: string }} pr
 * @returns {string} the decision it writes to GITHUB_OUTPUT
 */
function decide(pr) {
  const text = workflow("dependabot-automerge.yml");
  const step = text.slice(text.indexOf("- name: Decide"));
  const m = /\n {8}run: \|\n((?: {10}.*\n|\n)+)/.exec(step);
  const script = (m?.[1] ?? "").replace(/^ {10}/gm, "");
  expect(script).toContain("decision=");
  const dir = mkdtempSync(join(tmpdir(), "vimma-automerge-"));
  try {
    const out = join(dir, "output");
    writeFileSync(out, "");
    execFileSync("bash", ["-eo", "pipefail", "-c", script], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: out,
        TITLE: pr.title,
        UPDATE_TYPE: pr.update,
        ECOSYSTEM: pr.ecosystem ?? "npm_and_yarn",
        DEPENDENCIES: pr.deps,
        RELEASE_PATH: pr.releasePath ?? "merge",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return /^decision=(\w+)$/m.exec(readFileSync(out, "utf8"))?.[1] ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("build supply chain: npm", () => {
  it("package.json pins Surfer to an exact version, locked by integrity", () => {
    const pkg = JSON.parse(read("package.json"));
    const version = pkg.devDependencies[SURFER];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.packages[""].devDependencies[SURFER]).toBe(version);
    const entry = lock.packages[`node_modules/${SURFER}`];
    expect(entry.version).toBe(version);
    expect(entry.resolved).toBe(`https://registry.npmjs.org/${SURFER}/-/surfer-${version}.tgz`);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });

  it(".npmrc turns install scripts off for every install", () => {
    expect(read(".npmrc")).toMatch(/^ignore-scripts=true$/m);
    // What npm itself resolves in this repository, so a stray user or env setting shows up too.
    const value = execFileSync("npm", ["config", "get", "ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }).trim();
    expect(value).toBe("true");
  });

  it("the full builds install with npm ci --ignore-scripts and run Surfer with npx --no", () => {
    for (const name of ["release.yml", "nightly.yml", "macos.yml"]) {
      const block = buildJob(name);
      const installs = [...block.matchAll(/\bnpm (?:ci|install|i)\b[^\n]*/g)].map((m) => m[0]);
      expect(installs, name).not.toEqual([]);
      for (const line of installs) expect(line, name).toMatch(/^npm ci --ignore-scripts\b/);
      const npx = [...block.matchAll(/\bnpx\b[^\n]*/g)].map((m) => m[0]);
      expect(npx, name).not.toEqual([]);
      for (const line of npx) expect(line, name).toMatch(/^npx --no -- surfer /);
    }
  });

  it("no workflow lets npx fetch a package", () => {
    const dir = new URL(".github/workflows/", root);
    for (const name of readdirSync(dir)) {
      expect(fetchingRunners(readFileSync(new URL(name, dir), "utf8")), name).toEqual([]);
    }
    for (const line of [
      "npx --no -- a && npx b",
      "npx b",
      "npx --yes b",
      "npm exec b",
      "npm x b",
      "pnpm dlx b",
      "yarn dlx b",
      "bunx b",
      "run: npx --no -- a; npm exec -- b",
    ]) {
      expect(fetchingRunners(line), line).not.toEqual([]);
    }
    expect(fetchingRunners("npx --no -- a && npm exec --no -- b # npx b")).toEqual([]);
  });

  it("only npx --no -- passes the command's own flags through", () => {
    // After `--no`, npm reads every later flag as its own (`--verbose`, `--force`) unless `--`
    // ends its options first.
    /** @param {string[]} args */
    const npx = (args) =>
      execFileSync("npx", args, {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true" },
      });
    expect(npx(["--no", "--", "tsc", "--version"])).toMatch(/^Version \d/);
    expect(npx(["--no", "tsc", "--version"])).not.toMatch(/^Version \d/);
  });

  it("surfer.json lists no add-ons", () => {
    // Surfer downloads add-ons from addons.mozilla.org or GitHub with no hash check (spec, R3).
    expect(JSON.parse(read("surfer.json")).addons).toEqual({});
  });
});

const BASE_SHA = "${{ github.event.pull_request.base.sha }}";
const DEPENDABOT_IF = [
  "github.actor == 'dependabot[bot]'",
  "github.event.pull_request.user.login == 'dependabot[bot]'",
];
// Commands that would put the head commit's files in the workspace, where a later node or npm
// reads its configuration and modules from.
const WRITES_TREE = new RegExp(
  `\\bgit (?:${[
    ...["checkout", "switch", "restore", "reset", "worktree", "archive", "read-tree"],
    ...["checkout-index", "stash", "merge", "cherry-pick", "apply"],
  ].join("|")})\\b`,
);

/**
 * What would let the pull request's files reach classify's workspace before, or while, its tools
 * run (docs/security/14-build-and-release-supply-chain.md, B3): classify sets up .nvmrc's Node on
 * the base commit alone, so the order of its first steps is what keeps setup-node's npm and yarn
 * off the pull request's .npmrc and .yarnrc, and the head commit's files may only ever be written
 * under $RUNNER_TEMP.
 * @param {string} text dependabot-automerge.yml
 * @returns {string[]} each fault found; empty when the workflow keeps the rule
 */
function classifyFaults(text) {
  const doc = parseWorkflow(text);
  /** @type {string[]} */
  const faults = [];
  const on = doc.on;
  const events = typeof on === "string" ? [on] : Object.keys(on ?? {});
  if (events.join() !== "pull_request") faults.push(`triggers: ${events.join(", ")}`);
  for (const k of ["env", "defaults"]) if (k in doc) faults.push(`workflow ${k}`);
  const all = jobs(text);
  const classify = all.get("classify") ?? {};
  const automerge = all.get("automerge") ?? {};
  for (const k of ["env", "defaults", "container", "services", "continue-on-error"])
    if (k in classify) faults.push(`classify ${k}`);
  for (const [id, job] of Object.entries({ classify, automerge }))
    for (const c of DEPENDABOT_IF)
      if (!String(job.if ?? "").includes(c)) faults.push(`${id} if: no ${c}`);
  const steps = /** @type {Record<string, any>[]} */ (
    Array.isArray(classify.steps) ? classify.steps : []
  );
  const [checkout, setup, ...rest] = steps;
  if (
    !/^actions\/checkout@[0-9a-f]{40}$/.test(String(checkout?.uses)) ||
    JSON.stringify(Object.keys(checkout ?? {}).sort()) !== JSON.stringify(["uses", "with"]) ||
    JSON.stringify(checkout?.with) !==
      JSON.stringify({ ref: BASE_SHA, "persist-credentials": false })
  )
    faults.push("step 0: not the base commit's checkout alone");
  if (
    !/^actions\/setup-node@[0-9a-f]{40}$/.test(String(setup?.uses)) ||
    setup?.with?.["node-version-file"] !== ".nvmrc" ||
    setup?.with?.["node-version"] !== undefined ||
    setup?.with?.["package-manager-cache"] !== false ||
    setup?.with?.cache !== undefined
  )
    faults.push("step 1: not setup-node with .nvmrc and no cache");
  if (/head\.|HEAD_SHA/.test(JSON.stringify([checkout, setup])))
    faults.push("the head commit is named before setup-node");
  const run = rest.map((s) => String(s.run ?? "")).join("\n");
  for (const m of run.matchAll(/git show "\$HEAD_SHA:[^"]*"\s*>\s*(\S+)/g))
    if (!m[1]?.startsWith('"$RUNNER_TEMP/')) faults.push(`head file written to ${m[1]}`);
  if (WRITES_TREE.test(run)) faults.push(`writes the tree: ${WRITES_TREE.exec(run)?.[0]}`);
  rest.forEach((s, i) => {
    for (const k of ["working-directory", "shell"]) if (k in s) faults.push(`step ${i + 2} ${k}`);
  });
  const mergeSteps = /** @type {Record<string, any>[]} */ (
    Array.isArray(automerge.steps) ? automerge.steps : []
  );
  if (mergeSteps.some((s) => String(s.uses ?? "").startsWith("actions/checkout@")))
    faults.push("automerge checks out");
  return faults;
}

describe("build supply chain: Dependabot", () => {
  it("dependabot-automerge classifies on base-branch code with a read-only token", () => {
    const all = jobs(workflow("dependabot-automerge.yml"));
    const classify = all.get("classify");
    expect(classify).toBeDefined();
    expect(classify?.permissions).toEqual({ contents: "read" });
    const text = JSON.stringify(classify);
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toContain("pull_request_target");
    const steps = /** @type {Record<string, any>[]} */ (classify?.steps);
    const checkout = steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      "persist-credentials": false,
    });
    // No other step checks out code, and the head commit is only read as data.
    expect(steps.filter((s) => String(s.uses ?? "").startsWith("actions/checkout@"))).toHaveLength(
      1,
    );
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toMatch(/git show "\$HEAD_SHA:package-lock\.json"/);
    expect(run).toMatch(/node tools\/deps\/release-path\.ts --diff package-lock\.json /);
    expect(run).not.toMatch(/\bnpm (?:ci|install|i)\b|\bnpx\b|git (?:checkout|switch)/);
    // Only names and versions release-path.ts checked reach npm diff, which runs no scripts;
    // an unchecked entry is printed with anything but [\w@./+-] replaced, so no newline in a
    // lockfile field can forge a line of the loop's input.
    expect(run).toMatch(/npm diff --ignore-scripts --diff="\$name@\$old" --diff="\$name@\$new"/);
    expect(run).toContain('replace(/[^\\w@./+-]/g, "?")');
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({ name: "release-path-diff", "retention-days": 30 });

    // The job that can write holds no checkout and acts on classify's decision.
    const automerge = all.get("automerge");
    expect(automerge?.needs).toBe("classify");
    const automergeSteps = /** @type {Record<string, any>[]} */ (automerge?.steps);
    expect(automergeSteps.some((s) => String(s.uses ?? "").startsWith("actions/checkout@"))).toBe(
      false,
    );
    const decideStep = automergeSteps.find((s) => s.name === "Decide");
    expect(decideStep?.env?.RELEASE_PATH).toBe("${{ needs.classify.outputs.decision }}");
  });

  it("classify sets up Node on the base commit alone, before any of the head commit", () => {
    expect(classifyFaults(workflow("dependabot-automerge.yml"))).toEqual([]);
  });

  const SETUP = "      - uses: actions/setup-node@";
  const HEAD_LOCK = 'git show "$HEAD_SHA:package-lock.json" > "$RUNNER_TEMP/head-lock.json"';
  it.each([
    [
      "the head's .npmrc written before setup-node",
      (/** @type {string} */ t) =>
        t.replace(
          SETUP,
          "      - run: |\n" +
            '          git fetch origin "$HEAD_SHA"\n' +
            '          git show "$HEAD_SHA:.npmrc" > .npmrc\n' +
            SETUP,
        ),
      "step 1: not setup-node",
    ],
    [
      "the head's lockfile written into the workspace",
      (/** @type {string} */ t) =>
        t.replace(HEAD_LOCK, 'git show "$HEAD_SHA:package-lock.json" > package-lock.json'),
      "head file written to package-lock.json",
    ],
    [
      "a checkout of the head",
      (/** @type {string} */ t) =>
        t.replace(
          "ref: ${{ github.event.pull_request.base.sha }}",
          "ref: ${{ github.event.pull_request.head.sha }}",
        ),
      "step 0",
    ],
    [
      "setup-node with a bare major",
      (/** @type {string} */ t) =>
        t.replace(
          /node-version-file: \.nvmrc\n(\s+)package-manager-cache/,
          "node-version: 22\n$1package-manager-cache",
        ),
      "step 1",
    ],
    [
      "git checkout of the head after it",
      (/** @type {string} */ t) =>
        t.replace(HEAD_LOCK, `${HEAD_LOCK}\n          git checkout "$HEAD_SHA" -- .`),
      "writes the tree: git checkout",
    ],
    [
      "a working directory on a later step",
      (/** @type {string} */ t) =>
        t.replace(
          "        id: classify\n",
          "        id: classify\n        working-directory: tools\n",
        ),
      "step 2 working-directory",
    ],
    [
      "pull_request_target",
      (/** @type {string} */ t) =>
        t.replace("on:\n  pull_request:\n", "on:\n  pull_request_target:\n"),
      "triggers: pull_request_target",
    ],
    [
      "a workflow env",
      (/** @type {string} */ t) =>
        t.replace("permissions: {}\n", "permissions: {}\nenv:\n  A: b\n"),
      "workflow env",
    ],
    [
      "a classify env",
      (/** @type {string} */ t) =>
        t.replace("    timeout-minutes: 10\n", "    timeout-minutes: 10\n    env:\n      A: b\n"),
      "classify env",
    ],
    [
      "classify without the actor check",
      (/** @type {string} */ t) => t.replace("if: github.actor == 'dependabot[bot]' && ", "if: "),
      "classify if: no github.actor",
    ],
    [
      "a checkout in automerge",
      (/** @type {string} */ t) =>
        t.replace(
          "      - name: Dependabot metadata\n",
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n" +
            "      - name: Dependabot metadata\n",
        ),
      "automerge checks out",
    ],
  ])("classify's order check catches %s", (_, mutate, fault) => {
    const text = workflow("dependabot-automerge.yml");
    const mutated = mutate(text);
    expect(mutated).not.toBe(text);
    expect(classifyFaults(mutated).join("; ")).toContain(fault);
  });

  it("a release-path change is never auto-merged, security updates included", () => {
    for (const update of ["version-update:semver-patch", "version-update:semver-minor", ""]) {
      for (const title of ["bump vitest", "bump vitest [security]"]) {
        for (const releasePath of ["review", "", "merge\n", "Merge"]) {
          expect(
            decide({ title, update, deps: "vitest", releasePath }),
            `${title} ${update} ${JSON.stringify(releasePath)}`,
          ).toBe("review");
        }
      }
    }
  });

  it("the release-path group comes before the minor and patch group", () => {
    const text = read(".github/dependabot.yml");
    const npm = text.slice(
      text.indexOf("package-ecosystem: npm"),
      text.indexOf("- package-ecosystem: cargo"),
    );
    const group = /^ {6}release-path:\n {8}patterns:\n((?: {10}- .+\n)+)/m.exec(npm);
    expect(group?.[1]?.trim().split(/\n\s*/)).toEqual([`- "${SURFER}"`, `- "ajv"`]);
    expect(npm.indexOf("release-path:")).toBeLessThan(npm.indexOf("npm-minor-patch:"));
  });

  it("a Surfer update is never auto-merged, security updates included", () => {
    for (const update of [
      "version-update:semver-patch",
      "version-update:semver-minor",
      "version-update:semver-major",
    ]) {
      for (const title of [
        `build(deps-dev): bump ${SURFER} from 1.14.9 to 1.15.0`,
        `build(deps-dev): bump ${SURFER} from 1.14.9 to 1.15.0 [security]`,
      ]) {
        expect(decide({ title, update, deps: SURFER }), `${title} ${update}`).toBe("review");
        expect(decide({ title, update, deps: `ajv, ${SURFER}` }), title).toBe("review");
      }
    }
  });

  it("Surfer is held whatever the separator, quoting or case, or when only the title names it", () => {
    const update = "version-update:semver-patch";
    for (const deps of [
      `ajv\n${SURFER}`,
      `ajv\t${SURFER}`,
      `ajv;${SURFER}`,
      `"${SURFER}"`,
      "@zen-browser/Surfer",
      "@Zen-Browser/SURFER",
    ]) {
      expect(decide({ title: "bump", update, deps }), JSON.stringify(deps)).toBe("review");
    }
    expect(
      decide({ title: `build(deps-dev): bump ${SURFER} [security]`, update, deps: "ajv" }),
    ).toBe("review");
  });

  it("an update whose dependency list is empty waits for a person", () => {
    for (const update of ["version-update:semver-patch", ""]) {
      expect(decide({ title: "bump [security]", update, deps: "" })).toBe("review");
      expect(decide({ title: "bump", update, deps: " " })).toBe("review");
    }
  });

  it("security, patch and minor updates of other packages still auto-merge", () => {
    expect(
      decide({ title: "build(deps-dev): bump vitest [security]", update: "", deps: "vitest" }),
    ).toBe("merge");
    expect(
      decide({ title: "bump prettier", update: "version-update:semver-patch", deps: "prettier" }),
    ).toBe("merge");
    expect(
      decide({ title: "bump eslint", update: "version-update:semver-major", deps: "eslint" }),
    ).toBe("review");
    expect(
      decide({
        title: "ci: bump actions/checkout [security]",
        update: "version-update:semver-patch",
        ecosystem: "github_actions",
        deps: "actions/checkout",
      }),
    ).toBe("review");
  });
});

describe("the Safe Browsing key (decision 18, B6)", () => {
  it("the Safe Browsing key comes only from the build environment, in the release and nightly builds", () => {
    const dir = new URL(".github/workflows/", root);
    /** @type {string[]} */
    const users = [];
    /** @type {string[]} */
    const inBuild = [];
    for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      for (const [id, job] of jobs(workflow(name))) {
        const e = job.environment;
        const env = typeof e === "object" ? (e !== null && "name" in e ? e.name : undefined) : e;
        if (env === "build") inBuild.push(`${name}:${id}`);
        if (JSON.stringify(job).includes("secrets.SAFEBROWSING_API_KEY")) {
          users.push(`${name}:${id}`);
          expect(env, `${name}:${id} reads the key outside the build environment`).toBe("build");
        }
      }
    }
    const builds = ["nightly.yml:build", "release.yml:build", "release.yml:macos-build"];
    expect(users.sort()).toEqual(builds);
    expect(inBuild.sort()).toEqual(builds);
  });
});

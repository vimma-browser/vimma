/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #358: a push to main whose tree a successful pull_request run of the same workflow
// already checked (the usual squash merge) skips that workflow's checks once more.
// tools/ci/tree-covered.mjs answers; ci.yml, semgrep.yml and pkgbuild.yml gate their jobs on it.
// codeql.yml stays ungated: code scanning's default-branch alerts come only from analyses of
// main (docs/runbook.md, "CI and automation").

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  PER_PAGE,
  coveringRun,
  findCover,
  githubApi,
  report,
  workflowFile,
} from "../tree-covered.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../tree-covered.mjs", import.meta.url));

const TREE = "d0af22264eb389dd91ce42e3bdab437b3ab93f91";
const OTHER = "1111111111111111111111111111111111111111";
const sha = (/** @type {string} */ c) => c.repeat(40);
const run = (/** @type {number} */ id, /** @type {string} */ head) => ({
  id,
  head_sha: head,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
});

describe("coveringRun", () => {
  it("returns the newest run whose head commit has the pushed tree, and stops there", async () => {
    const asked = /** @type {string[]} */ ([]);
    const trees = { [sha("a")]: OTHER, [sha("b")]: TREE, [sha("c")]: TREE };
    const found = await coveringRun({
      tree: TREE,
      runs: [run(3, sha("a")), run(2, sha("b")), run(1, sha("c"))],
      treeOf: async (s) => (asked.push(s), trees[s] ?? null),
    });
    expect(found?.id).toBe(2);
    expect(asked).toEqual([sha("a"), sha("b")]);
  });

  it("skips a run whose head commit is gone and reports none when nothing matches", async () => {
    const found = await coveringRun({
      tree: TREE,
      runs: [run(2, sha("a")), run(1, sha("b"))],
      treeOf: async (s) => (s === sha("a") ? null : OTHER),
    });
    expect(found).toBeNull();
  });

  it("asks for each head commit once, however many runs it has", async () => {
    const asked = /** @type {string[]} */ ([]);
    await coveringRun({
      tree: TREE,
      runs: [run(3, sha("a")), run(2, sha("a")), run(1, sha("a"))],
      treeOf: async (s) => (asked.push(s), OTHER),
    });
    expect(asked).toEqual([sha("a")]);
  });
});

describe("findCover", () => {
  it("lists this workflow's successful pull_request runs and reads each head's tree", async () => {
    const paths = /** @type {string[]} */ ([]);
    /** @type {(path: string) => Promise<unknown>} */
    const api = async (path) => {
      paths.push(path);
      if (path.startsWith("repos/o/r/actions/workflows/ci.yml/runs?"))
        return { workflow_runs: [run(7, sha("a"))] };
      if (path === `repos/o/r/git/commits/${sha("a")}`) return { tree: { sha: TREE } };
      if (path === `repos/o/r/git/commits/${sha("9")}`) return { tree: { sha: TREE } };
      throw new Error(`unexpected ${path}`);
    };
    const found = await findCover({ repo: "o/r", workflow: "ci.yml", sha: sha("9"), api });
    expect(found).toEqual({ tree: TREE, run: run(7, sha("a")) });
    expect(paths[0]).toBe(`repos/o/r/git/commits/${sha("9")}`);
    expect(paths[1]).toBe(
      `repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=${PER_PAGE}`,
    );
    expect(PER_PAGE).toBe(50);
  });

  it("refuses a repository, workflow or commit it cannot put in a URL safely", async () => {
    const api = async () => ({});
    await expect(
      findCover({ repo: "o/r/x", workflow: "ci.yml", sha: sha("9"), api }),
    ).rejects.toThrow(/repository/);
    await expect(
      findCover({ repo: "o/r", workflow: "../ci.yml", sha: sha("9"), api }),
    ).rejects.toThrow(/workflow/);
    await expect(findCover({ repo: "o/r", workflow: "ci.yml", sha: "HEAD", api })).rejects.toThrow(
      /commit/,
    );
  });
});

describe("workflowFile", () => {
  it("is the file name in GITHUB_WORKFLOW_REF, so no workflow can name another by mistake", () => {
    expect(workflowFile("vimma-browser/vimma/.github/workflows/ci.yml@refs/heads/main")).toBe(
      "ci.yml",
    );
    expect(workflowFile("o/r/.github/workflows/semgrep.yml@refs/pull/1/merge")).toBe("semgrep.yml");
    expect(() => workflowFile("")).toThrow(/GITHUB_WORKFLOW_REF/);
    expect(() => workflowFile("o/r/ci.yml@refs/heads/main")).toThrow(/GITHUB_WORKFLOW_REF/);
  });
});

describe("report", () => {
  it("skips with a notice that names the covering run", () => {
    const r = report({ tree: TREE, run: run(7, sha("a")) });
    expect(r.outputs).toEqual(["skip=true", `run=https://github.com/o/r/actions/runs/7`]);
    expect(r.message).toMatch(/^::notice /);
    expect(r.message).toContain("https://github.com/o/r/actions/runs/7");
    expect(r.message).toContain(TREE);
  });

  it("runs the checks when no run covers the tree", () => {
    const r = report({ tree: TREE, run: null });
    expect(r.outputs).toEqual(["skip=false"]);
    expect(r.message).not.toMatch(/^::/);
    expect(r.message).toContain(TREE);
  });
});

describe("githubApi", () => {
  it("sends the token, returns null for 404 and throws on other errors", async () => {
    const calls = /** @type {{ url: string, auth: string | undefined }[]} */ ([]);
    /** @type {(status: number, body: unknown) => typeof fetch} */
    const fake = (status, body) => async (url, init) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(JSON.stringify(body), { status });
    };
    const ok = githubApi({ token: "t", base: "https://api.example", fetch: fake(200, { a: 1 }) });
    expect(await ok("repos/o/r/git/commits/x")).toEqual({ a: 1 });
    expect(calls[0]).toEqual({
      url: "https://api.example/repos/o/r/git/commits/x",
      auth: "Bearer t",
    });
    const gone = githubApi({ token: "t", base: "https://api.example", fetch: fake(404, {}) });
    expect(await gone("repos/o/r/git/commits/x")).toBeNull();
    const broken = githubApi({ token: "t", base: "https://api.example", fetch: fake(500, {}) });
    await expect(broken("repos/o/r/git/commits/x")).rejects.toThrow(/500/);
  });
});

describe("the command", () => {
  /** @type {import("node:http").Server} */
  let server;
  /** @type {string} */
  let base;
  /** @type {Record<string, { status?: number, body: unknown }>} */
  let routes;
  /** @type {string[]} */
  let seen;

  beforeEach(async () => {
    routes = {};
    seen = [];
    server = createServer((req, res) => {
      seen.push(`${req.headers.authorization ?? "-"} ${req.url}`);
      const hit = routes[req.url ?? ""];
      res.writeHead(hit ? (hit.status ?? 200) : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(hit ? hit.body : { message: "Not Found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(() => server.close());

  // Async, not spawnSync: the fake API answers from this process's event loop, which a blocking
  // spawn would hold while the child waits for it.
  /** @param {Record<string, string>} env */
  async function runScript(env) {
    const dir = tempDir("vimma-tree-covered-");
    const output = join(dir, "output");
    const res = await promisify(execFile)(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: base,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SHA: sha("9"),
        GITHUB_WORKFLOW_REF: "o/r/.github/workflows/ci.yml@refs/heads/main",
        GITHUB_TOKEN: "secret",
        GITHUB_OUTPUT: output,
        ...env,
      },
    }).then(
      (r) => ({ status: 0, ...r }),
      (err) => ({ status: err.code, stdout: err.stdout, stderr: err.stderr }),
    );
    let outputs = "";
    try {
      outputs = readFileSync(output, "utf8");
    } catch {
      // the script wrote nothing
    }
    return { ...res, outputs };
  }

  it("skips with a notice when a pull_request run of this workflow checked the same tree", async () => {
    routes[`/repos/o/r/git/commits/${sha("9")}`] = { body: { tree: { sha: TREE } } };
    routes[
      "/repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=50"
    ] = { body: { workflow_runs: [run(3, sha("a")), run(2, sha("b"))] } };
    routes[`/repos/o/r/git/commits/${sha("a")}`] = { body: { tree: { sha: OTHER } } };
    routes[`/repos/o/r/git/commits/${sha("b")}`] = { body: { tree: { sha: TREE } } };
    const res = await runScript({});
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("::notice ");
    expect(res.stdout).toContain("https://github.com/o/r/actions/runs/2");
    expect(res.outputs).toBe("skip=true\nrun=https://github.com/o/r/actions/runs/2\n");
    expect(seen.every((s) => s.startsWith("Bearer secret "))).toBe(true);
  });

  it("runs the checks when no run matches, and when the API fails (a warning, not an error)", async () => {
    routes[`/repos/o/r/git/commits/${sha("9")}`] = { body: { tree: { sha: TREE } } };
    routes[
      "/repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=50"
    ] = { body: { workflow_runs: [run(3, sha("a"))] } };
    routes[`/repos/o/r/git/commits/${sha("a")}`] = { body: { tree: { sha: OTHER } } };
    const none = await runScript({});
    expect(none.status).toBe(0);
    expect(none.outputs).toBe("skip=false\n");
    expect(none.stdout).not.toContain("::");

    routes[
      "/repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=50"
    ] = { status: 500, body: { message: "boom" } };
    const failed = await runScript({});
    expect(failed.status).toBe(0);
    expect(failed.outputs).toBe("skip=false\n");
    expect(failed.stdout).toMatch(/^::warning .*500/m);
  });

  it("fails loudly when the workflow does not give it what it needs", async () => {
    const res = await runScript({ GITHUB_WORKFLOW_REF: "" });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("GITHUB_WORKFLOW_REF");
    expect(res.outputs).toBe("");
    const noToken = await runScript({ GITHUB_TOKEN: "" });
    expect(noToken.status).toBe(2);
    expect(noToken.stderr).toMatch(/GITHUB_TOKEN|GH_TOKEN/);
  });
});

describe("workflow wiring", () => {
  /** @param {string} name */
  const workflow = (name) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

  /** @param {string} text @param {string} id */
  function job(text, id) {
    const body = text.slice(text.indexOf("\njobs:\n") + 7);
    const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
    throw new Error(`no job ${id}`);
  }

  /** @param {string} block */
  const jobIf = (block) => /^ {4}if: (.*)/m.exec(block)?.[1] ?? "";

  const GATED = /** @type {const} */ ([
    ["ci.yml", "check"],
    ["semgrep.yml", "scan"],
    ["pkgbuild.yml", "arch"],
    ["pkgbuild.yml", "cask"],
  ]);

  it.each(GATED)(
    "%s: a read-only guard job on push, and %s runs unless it found a cover",
    (name, gated) => {
      const text = workflow(name);
      const covered = job(text, "covered");
      expect(jobIf(covered)).toBe("github.event_name == 'push'");
      // actions: read lists this workflow's runs; contents: read reads a commit's tree.
      expect(covered).toMatch(
        /^ {4}permissions:\n {6}actions: read(?: #.*)?\n {6}contents: read(?: #.*)?\n {4}[a-z]/m,
      );
      expect(covered).toContain("skip: ${{ steps.tree.outputs.skip }}");
      const step = covered.split(/^ {6}- /m).find((s) => s.includes("id: tree"));
      expect(step).toContain("node tools/ci/tree-covered.mjs");
      expect(step).toContain("GH_TOKEN: ${{ github.token }}");
      // The workflow file comes from GITHUB_WORKFLOW_REF: a name typed here could be another's.
      expect(step).not.toContain("WORKFLOW");
      expect(step?.slice(step.indexOf("run:"))).not.toContain("${{");
      if (covered.includes("actions/checkout"))
        expect(covered).toContain("persist-credentials: false");
      const main = job(text, gated);
      expect(main).toMatch(/^ {4}needs: covered$/m);
      // !cancelled(), not success(): a failed guard runs the checks instead of skipping them; on a
      // pull request the guard is skipped, its output is empty and the checks run.
      expect(jobIf(main)).toBe("${{ !cancelled() && needs.covered.outputs.skip != 'true' }}");
    },
  );

  it("ci.yml: the guard lints the pushed commit messages when it skips the check job", () => {
    const covered = job(workflow("ci.yml"), "covered");
    const steps = covered.split(/^ {6}- /m).slice(1);
    const commitlint = steps.find((s) => s.startsWith("name: commitlint"));
    expect(commitlint).toMatch(/^ {8}if: steps\.tree\.outputs\.skip == 'true'$/m);
    expect(commitlint).toContain('npx --no -- commitlint --from "$FROM" --to "$TO"');
    expect(commitlint).toContain("FROM: ${{ github.event.before }}");
    for (const s of steps.filter((s) => !s.includes("id: tree") && !s.includes("actions/checkout")))
      expect(s).toMatch(/^ {8}if: steps\.tree\.outputs\.skip == 'true'$/m);
  });

  it("codeql.yml is not gated: its analyses of main feed code scanning", () => {
    const text = workflow("codeql.yml");
    expect(text).not.toContain("tree-covered");
    expect(text).not.toContain("needs.covered");
    expect(text).toMatch(/#.*code scanning/i);
    expect(text).toMatch(/#.*#358/);
  });

  it("every gated workflow keeps its push trigger and the same required-check job names", () => {
    expect(job(workflow("ci.yml"), "check")).toMatch(
      /^ {4}name: lint, typecheck, test, commitlint, licences$/m,
    );
    expect(job(workflow("semgrep.yml"), "scan")).toMatch(
      /^ {4}name: semgrep \(javascript, typescript, rust, secrets, github-actions\)$/m,
    );
    for (const [name] of GATED)
      expect(workflow(name)).toMatch(/^ {2}push:\n {4}branches: \[main\]/m);
  });
});

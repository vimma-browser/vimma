import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../png.ts";
import {
  loadScenarios,
  matchState,
  runSteps,
  scenarioLaunch,
  validateScenario,
} from "../scenario.ts";
import { tempDir } from "../../test/temp-dir.mjs";
import type { InstallState } from "../scenario.ts";

const SCENARIOS = fileURLToPath(new URL("../../../tests/e2e/scenarios/", import.meta.url));

const scenario = (over: object) => ({
  name: "m0-sample",
  description: "a sample",
  steps: [{ "assert-state": { mode: "insert" } }],
  ...over,
});

describe("validateScenario", () => {
  it("accepts a milestone happy path and a regression test with its issue number", () => {
    expect(validateScenario(scenario({}), "m0-sample.json")).toEqual([]);
    expect(
      validateScenario(
        scenario({
          prefs: { "browser.startup.page": null, "a.b": true, c: 3, d: "x" },
          steps: [
            { restart: "quit" },
            { restart: "kill" },
            { "wait-for-profile-file": "search.json.mozlz4", timeoutSeconds: 30 },
          ],
        }),
        undefined,
      ),
    ).toEqual([]);
    expect(
      validateScenario(scenario({ name: "issue-42-esc-closes-help", issue: 42 }), undefined),
    ).toEqual([]);
  });

  it.each([
    [{ name: "happy" }, /name must be m<N>-<slug> or issue-<N>-<slug>/],
    [{ name: "issue-42-x" }, /"issue": 42/],
    [{ name: "issue-42-x", issue: 43 }, /"issue": 42/],
    [{ description: "" }, /description/],
    [{ steps: [] }, /at least one step/],
    [{ steps: [{ keys: "esc", open: "about:blank" }] }, /step 1: exactly one of/],
    [{ steps: [{ click: "x" }] }, /step 1: exactly one of/],
    [{ steps: [{ keys: "" }] }, /step 1: keys/],
    [{ steps: [{ open: 3 }] }, /step 1: open/],
    [{ steps: [{ "wait-for-state": "help" }] }, /step 1: wait-for-state/],
    [{ steps: [{ screenshot: "Bad Name" }] }, /step 1: screenshot/],
    [{ steps: [{ keys: "esc", timeoutSeconds: 3 }] }, /timeoutSeconds/],
    [{ pending: "" }, /pending/],
    [{ timeoutSeconds: 0 }, /timeoutSeconds/],
    [{ extra: 1 }, /unknown field "extra"/],
    [{ steps: [{ restart: "crash" }] }, /step 1: restart/],
    [{ steps: [{ restart: true }] }, /step 1: restart/],
    [{ steps: [{ "wait-for-profile-file": "" }] }, /step 1: wait-for-profile-file/],
    [{ steps: [{ "wait-for-profile-file": "../x" }] }, /step 1: wait-for-profile-file/],
    [{ steps: [{ "wait-for-profile-file": "a/b" }] }, /step 1: wait-for-profile-file/],
    [{ steps: [{ "wait-for-profile-file": ".." }] }, /step 1: wait-for-profile-file/],
    [{ steps: [{ "wait-for-profile-file": 3 }] }, /step 1: wait-for-profile-file/],
    [{ prefs: [] }, /prefs must be an object/],
    [{ prefs: { "a b": 1 } }, /prefs: "a b"/],
    [{ prefs: { a: [1] } }, /prefs: "a"/],
  ])("rejects %o", (over, message) => {
    expect(validateScenario(scenario(over), undefined).join("\n")).toMatch(message);
  });

  // docs/specs/vimma-mcp.md, sub-PR 2b: a held full connection, an agent connection and an
  // asynchronous vimma-ctl, for the agent question line.
  it("accepts the agent steps", () => {
    expect(
      validateScenario(
        scenario({
          steps: [
            { hold: true },
            { sleep: 1.6 },
            { agent: { send: "agent-open", args: { url: "https://example.com/" }, as: "open1" } },
            { "agent-result": { of: "open1", expect: { ok: true } } },
            { agent: { send: "agent-read", args: { tab: "$open1.result.tab" }, as: "read1" } },
            { ctl: { run: ["state"], as: "c1" } },
            { "ctl-result": { of: "c1", expect: { exitCode: 0 } } },
          ],
        }),
        undefined,
      ),
    ).toEqual([]);
  });

  it.each([
    [[{ hold: false }], /step 1: hold is true/],
    [[{ sleep: 0 }], /step 1: sleep/],
    [[{ sleep: 31 }], /step 1: sleep/],
    [[{ agent: { send: "send-keys", as: "a" } }], /step 1: agent: send is an agent command/],
    [[{ agent: { send: "agent-tabs" } }], /step 1: agent: as names/],
    [[{ agent: { send: "agent-tabs", as: "a", extra: 1 } }], /step 1: agent: unknown/],
    [[{ "agent-result": { of: "nope", expect: {} } }], /step 1: agent-result: no agent step/],
    [[{ ctl: { run: "state", as: "c" } }], /step 1: ctl: run is/],
    [[{ "ctl-result": { of: "c", expect: {} } }], /step 1: ctl-result: no ctl step/],
    [
      [{ agent: { send: "agent-tabs", as: "a" } }, { agent: { send: "agent-tabs", as: "a" } }],
      /step 2: agent: "a" is taken/,
    ],
  ])("rejects agent steps %o", (steps, message) => {
    expect(validateScenario(scenario({ steps }), undefined).join("\n")).toMatch(message);
  });

  // docs/specs/vimma-mcp.md, sub-PR 3: the real `vimma-ctl mcp`, spoken to over stdio.
  it("accepts the mcp steps", () => {
    expect(
      validateScenario(
        scenario({
          steps: [
            { mcp: { method: "initialize", params: { protocolVersion: "2025-11-25" }, as: "i" } },
            { "mcp-result": { of: "i", expect: { result: { protocolVersion: "2025-11-25" } } } },
            { mcp: { method: "notifications/initialized" } },
            { mcp: { method: "tools/list", as: "list1" } },
          ],
        }),
        undefined,
      ),
    ).toEqual([]);
  });

  it.each([
    [[{ mcp: { as: "a" } }], /step 1: mcp: method is a string/],
    [[{ mcp: { method: 3 } }], /step 1: mcp: method is a string/],
    [[{ mcp: { method: "ping", params: [] } }], /step 1: mcp: params is an object/],
    [[{ mcp: { method: "ping", as: "A" } }], /step 1: mcp: as names the answer/],
    [[{ mcp: { method: "ping", id: 1 } }], /step 1: mcp: unknown field/],
    [[{ "mcp-result": { of: "x", expect: {} } }], /step 1: mcp-result: no mcp step/],
    [
      [{ agent: { send: "agent-tabs", as: "a" } }, { mcp: { method: "ping", as: "a" } }],
      /step 2: mcp: "a" is taken/,
    ],
  ])("rejects mcp steps %o", (steps, message) => {
    expect(validateScenario(scenario({ steps }), undefined).join("\n")).toMatch(message);
  });

  // docs/specs/builtin-agent-cli.md, "e2e": a CLI found on PATH, a theme folder in the checkout,
  // and a task typed into the chat window's input.
  it("accepts programs, checkout: pref values and the type step", () => {
    expect(
      validateScenario(
        scenario({
          programs: { claude: "tests/browser/fake_vimma_agent_cli.py" },
          prefs: { "vimma.theme.omarchyPath": "checkout:tests/e2e/fixtures/omarchy-theme" },
          steps: [{ type: "[[open fixture:shop.html]] [[own Bash ls ~/Downloads]]" }],
        }),
        undefined,
      ),
    ).toEqual([]);
  });

  it.each([
    [{ programs: [] }, /programs must be an object/],
    [{ programs: { "a/b": "x.py" } }, /programs: "a\/b"/],
    [{ programs: { "..": "x.py" } }, /programs: "\.\."/],
    [{ programs: { claude: "/usr/bin/true" } }, /programs: "claude"/],
    [{ programs: { claude: "../outside.py" } }, /programs: "claude"/],
    [{ programs: { claude: "tests/../../x.py" } }, /programs: "claude"/],
    [{ programs: { claude: "" } }, /programs: "claude"/],
    [{ programs: { claude: 3 } }, /programs: "claude"/],
    [{ prefs: { a: "checkout:/etc" } }, /prefs: "a": checkout:/],
    [{ prefs: { a: "checkout:../x" } }, /prefs: "a": checkout:/],
    [{ prefs: { a: "checkout:" } }, /prefs: "a": checkout:/],
    [{ steps: [{ type: "" }] }, /step 1: type/],
    [{ steps: [{ type: 3 }] }, /step 1: type/],
    [{ steps: [{ type: "a\nb" }] }, /step 1: type/],
    [{ steps: [{ type: "a\tb" }] }, /step 1: type/],
  ])("rejects %o", (over, message) => {
    expect(validateScenario(scenario(over), undefined).join("\n")).toMatch(message);
  });

  // docs/specs/app-routes.md, "Tests": the packaged vimma-open, run like another program.
  it("accepts the external step: vimma-open's arguments", () => {
    expect(
      validateScenario(
        scenario({ steps: [{ external: ["--from", "teams", "fixture:article.html"] }] }),
        undefined,
      ),
    ).toEqual([]);
  });

  it.each([
    [[{ external: [] }], /step 1: external/],
    [[{ external: "fixture:article.html" }], /step 1: external/],
    [[{ external: ["a", 3] }], /step 1: external/],
    [[{ external: ["a\nb"] }], /step 1: external/],
  ])("rejects external steps %o", (steps, message) => {
    expect(validateScenario(scenario({ steps }), undefined).join("\n")).toMatch(message);
  });

  it("wants the file named after the scenario", () => {
    expect(validateScenario(scenario({}), "m0-other.json").join("\n")).toMatch(/file name/);
  });
});

describe("scenarioLaunch", () => {
  it("resolves programs and checkout: prefs against the checkout, and names vimma-ctl", () => {
    expect(
      scenarioLaunch(
        scenario({
          programs: { claude: "tests/browser/fake.py" },
          prefs: { "vimma.theme.omarchyPath": "checkout:tests/e2e/fixtures/t", "a.b": "x" },
        }),
        { root: "/repo", vimmaCtl: "/repo/vimma-ctl" },
      ),
    ).toEqual({
      programs: { claude: "/repo/tests/browser/fake.py" },
      prefs: {
        "vimma.agent.cli.vimmaCtl": "/repo/vimma-ctl",
        "vimma.theme.omarchyPath": "/repo/tests/e2e/fixtures/t",
        "a.b": "x",
      },
    });
  });

  it("lets a scenario's own pref name another vimma-ctl, or none", () => {
    const { prefs } = scenarioLaunch(scenario({ prefs: { "vimma.agent.cli.vimmaCtl": null } }), {
      root: "/repo",
      vimmaCtl: "/repo/vimma-ctl",
    });
    expect(prefs).toEqual({ "vimma.agent.cli.vimmaCtl": null });
    expect(scenarioLaunch(scenario({}), { root: "/repo", vimmaCtl: null })).toEqual({
      programs: {},
      prefs: {},
    });
  });
});

describe("loadScenarios", () => {
  it("loads the repo's scenarios, all valid", () => {
    const all = loadScenarios(SCENARIOS);
    expect(all.map((s) => s.name)).toContain("m0-happy-path");
  });

  it("filters by substring and fails loudly on an invalid file", () => {
    const dir = tempDir("vimma-e2e-scn-");
    writeFileSync(join(dir, "m0-a.json"), JSON.stringify(scenario({ name: "m0-a" })));
    writeFileSync(join(dir, "m1-b.json"), JSON.stringify(scenario({ name: "m1-b" })));
    expect(loadScenarios(dir, { filter: "m1" }).map((s) => s.name)).toEqual(["m1-b"]);
    expect(() => loadScenarios(dir, { filter: "zzz" })).toThrow(/no scenario matches "zzz"/);
    writeFileSync(join(dir, "m2-c.json"), "{");
    expect(() => loadScenarios(dir)).toThrow(/m2-c\.json/);
  });
});

describe("the m0-happy-path scenario", () => {
  const happy = loadScenarios(SCENARIOS, { filter: "m0-happy-path" })[0];
  it("runs (is not pending) now that the control server exists (PR #38)", () => {
    expect(happy).toBeDefined();
    expect(happy?.pending).toBeUndefined();
  });
  it("opens about:blank, sends ctrl+b ? and expects help mode and a screenshot", () => {
    const steps = JSON.stringify(happy?.steps);
    expect(steps).toContain('"open":"about:blank"');
    expect(steps).toContain('"keys":"ctrl+b ?"');
    expect(steps).toContain('"mode":"help"');
    expect(steps).toContain('"screenshot"');
  });
});

describe("the m0-content-actor scenario (VimmaChild loads in the default content sandbox)", () => {
  const actor = loadScenarios(SCENARIOS, { filter: "m0-content-actor" })[0];
  it("runs, opens an http fixture page and waits for normal, then insert", () => {
    expect(actor?.pending).toBeUndefined();
    const steps = JSON.stringify(actor?.steps);
    expect(steps).toContain('"open":"fixture:focus-later.html"');
    expect(steps.indexOf('"mode":"normal"')).toBeGreaterThan(steps.indexOf('"open"'));
    expect(steps.lastIndexOf('"mode":"insert"')).toBeGreaterThan(steps.indexOf('"mode":"normal"'));
  });
});

describe("the m3-restart-restore scenario (m3-workspaces sub-spec 7)", () => {
  const restart = loadScenarios(SCENARIOS, { filter: "m3-restart-restore" })[0];
  const steps = JSON.stringify(restart?.steps);
  it("runs on Vimma's own startup.page (resume the session), not the harness's 0", () => {
    expect(restart?.pending).toBeUndefined();
    expect(restart?.prefs).toEqual({ "browser.startup.page": null });
  });
  it("quits and relaunches once, between building workspaces and asserting them", () => {
    expect(restart?.steps.filter((s) => s.restart === "quit")).toHaveLength(1);
    const at = steps.indexOf('"restart"');
    expect(steps.indexOf('"keys":"ctrl+b v"')).toBeGreaterThan(-1);
    expect(steps.indexOf('"keys":"ctrl+b v"')).toBeLessThan(at);
    expect(steps.lastIndexOf('"axis":"x"')).toBeGreaterThan(at);
    expect(steps.lastIndexOf("cookie ws=work")).toBeGreaterThan(at);
    expect(steps.lastIndexOf("cookie ws=personal")).toBeGreaterThan(at);
  });
});

describe("the m3-private-workspace scenario (#236)", () => {
  const priv = loadScenarios(SCENARIOS, { filter: "m3-private-workspace" })[0];
  const steps = priv?.steps ?? [];
  it("opens the private window only once the search service has initialized", () => {
    // SearchSettings writes search.json.mozlz4 once SearchService has initialized; a private
    // window opened before that keeps the URL bar's engine-less placeholder and icon.
    const ready = steps.findIndex((s) => s["wait-for-profile-file"] === "search.json.mozlz4");
    const open = steps.findIndex((s) => s.keys === "ctrl+b shift+p");
    expect(ready).toBeGreaterThan(-1);
    expect(ready).toBeLessThan(open);
  });
});

describe("screenshots taken a fixed time after a step (#981)", () => {
  // A screenshot right after a `sleep` photographs whatever the machine has drawn by then: under
  // load, a notice still shown or a list not yet filled. A scenario waits for the state it
  // photographs instead (`wait-for-state` on `notice`, `chat`, `agent`). These still sleep, each
  // judged in #981's pull request; a fixed one comes off the list, and none is added.
  const LEFT = [
    "issue-216-toolbar-hidden: toolbar-minimal",
    "issue-241-live-grep: live-grep",
    "issue-241-live-grep: live-grep-jump",
    "issue-487-pdf-mode: pdf-outline",
    "issue-618-downloads-picker: downloads-picker",
    "issue-682-multiple-splits: multiple-splits-panel",
    "m0-mcp-drive: m0-mcp-drive-shown",
  ];
  const all = loadScenarios(SCENARIOS, {});

  it("no screenshot follows a sleep beyond the ones left for follow-ups", () => {
    const afterSleep = all.flatMap((s) =>
      s.steps.flatMap((step, i) =>
        step.screenshot && s.steps[i - 1]?.sleep !== undefined
          ? [`${s.name}: ${step.screenshot}`]
          : [],
      ),
    );
    expect(afterSleep).toEqual(LEFT);
  });

  it("m0-agent-cli photographs each screen once its notice is gone", () => {
    const steps = all.find((s) => s.name === "m0-agent-cli")?.steps ?? [];
    const shots = steps.flatMap((step, i) => (step.screenshot ? [i] : []));
    expect(shots.length).toBe(3);
    for (const i of shots) {
      const wait = steps[i - 1]?.["wait-for-state"];
      expect(wait, `the step before ${steps[i]?.screenshot}`).toMatchObject({ notice: false });
    }
    expect(steps.some((step) => step.sleep !== undefined)).toBe(false);
  });

  // #1006: a step under a grant shows its notice (NOTICE_MS) and the ran dot (RAN_MS) from the
  // moment the gate lets it run, before its answer; each screenshot waits for the screen it shows.
  it.each<[string, string, Record<string, unknown>]>([
    // After a step under a grant: both gone, the bar back to `◇ agent 10m` or `15m`.
    [
      "m0-mcp-checkpoints",
      "m0-mcp-checkpoints-basket-ran",
      { notice: false, agent: { ran: false } },
    ],
    ["m0-mcp-stdio", "m0-mcp-stdio-grant", { notice: false, agent: { waiting: 0, ran: false } }],
    // Right after `y`: its notice and the dot, both still shown.
    [
      "m0-mcp-checkpoints",
      "m0-mcp-checkpoints-hosted-allowed",
      { notice: true, agent: { ran: true } },
    ],
    // A question on the agent line: it opens once no key came for 1.5 s and shows its keys hint
    // once armed (security.dialog_enable_delay); the bar says `◇ agent 1?` meanwhile.
    ...[
      ["m0-mcp-checkpoints", "m0-mcp-checkpoints-pay-question"],
      ["m0-mcp-checkpoints", "m0-mcp-checkpoints-card-question"],
      ["m0-mcp-checkpoints", "m0-mcp-checkpoints-hosted-question"],
      ["m0-mcp-drive", "m0-mcp-drive-keys-question"],
      ["m0-mcp-forms", "m0-mcp-forms-fill-question"],
      ["m0-mcp-forms", "m0-mcp-forms-submit-question"],
      ["m0-mcp-stdio", "m0-mcp-stdio-question"],
    ].map(([name = "", shot = ""]): [string, string, Record<string, unknown>] => [
      name,
      shot,
      { agent: { waiting: 1, armed: true } },
    ]),
    // The page's download has ended: the status bar says `↓ done`.
    ["issue-618-downloads-picker", "downloads-done", { downloads: "done" }],
  ])("%s photographs %s once the screen it shows is drawn", (name, shot, expected) => {
    const steps = all.find((s) => s.name === name)?.steps ?? [];
    const i = steps.findIndex((step) => step.screenshot === shot);
    expect(i).toBeGreaterThan(0);
    expect(steps[i - 1]?.["wait-for-state"]).toEqual(expected);
  });
});

describe("baselines", () => {
  const BASELINES = fileURLToPath(new URL("../../../tests/e2e/baselines/", import.meta.url));
  const shots = loadScenarios(SCENARIOS, {}).flatMap((s) =>
    s.steps.flatMap((step) => (step.screenshot ? [step.screenshot] : [])),
  );
  it.each(shots)("%s has a committed 1280×800 baseline (made in CI's Xvfb)", (name) => {
    const path = join(BASELINES, `${name}.png`);
    expect(existsSync(path)).toBe(true);
    const img = decodePng(readFileSync(path));
    expect([img.width, img.height]).toEqual([1280, 800]);
  });
});

describe("matchState", () => {
  const state = {
    mode: "help",
    pending: null,
    workspace: null,
    tabs: [
      { id: "1", url: "about:blank", title: "", selected: false },
      { id: "2", url: "about:blank", title: "", selected: true },
    ],
    panes: null,
    future: { field: 1 },
  };
  it("matches a subset and ignores fields it does not name", () => {
    expect(matchState({ mode: "help" }, state)).toEqual([]);
    expect(matchState({ pending: null, tabs: [{}, { selected: true }] }, state)).toEqual([]);
  });
  it("names each mismatch with its path", () => {
    expect(matchState({ mode: "insert", pending: "ctrl+b" }, state)).toEqual([
      'state.mode: expected "insert", got "help"',
      'state.pending: expected "ctrl+b", got null',
    ]);
    expect(matchState({ tabs: [{}] }, state)).toEqual(["state.tabs: expected 1 item(s), got 2"]);
    expect(matchState({ tabs: [{}, { url: "x" }] }, state)).toEqual([
      'state.tabs[1].url: expected "x", got "about:blank"',
    ]);
    expect(matchState({ nope: 1 }, state)).toEqual(["state.nope: expected 1, got undefined"]);
    expect(matchState({ panes: { a: 1 } }, state)).toEqual([
      'state.panes: expected {"a":1}, got null',
    ]);
  });
});

describe("runSteps", () => {
  const fakeCtl = (states: Array<object>) => {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      ctl: {
        state: async () => {
          calls.push("state");
          return states[Math.min(i++, states.length - 1)];
        },
        sendKeys: async (k: string) => void calls.push(`keys ${k}`),
        open: async (u: string) => (calls.push(`open ${u}`), "2"),
      },
    };
  };

  /** A fake ControlSessions: records what the agent steps ask of it. */
  const fakeControl = () => {
    const calls: string[] = [];
    const replies: Record<string, any> = {
      open1: { ok: true, result: { tab: "42" } },
      read1: { ok: true },
    };
    return {
      calls,
      control: {
        hold: async () => void calls.push("hold"),
        held: {
          state: async () => (calls.push("held state"), { mode: "normal" }),
          sendKeys: async (k: string) => void calls.push(`held keys ${k}`),
          open: async (u: string) => (calls.push(`held open ${u}`), "3"),
        },
        agentSend: (spec: any) =>
          void calls.push(`agent ${spec.send} ${JSON.stringify(spec.args ?? {})} as ${spec.as}`),
        agentResult: async (name: string) => replies[name],
        ctlSpawn: (args: string[], as: string) => void calls.push(`ctl ${args.join(" ")} as ${as}`),
        ctlResult: async () => ({ exitCode: 0, stderr: "" }),
        mcpSend: (spec: any) =>
          void calls.push(`mcp ${spec.method} ${JSON.stringify(spec.params ?? {})} as ${spec.as}`),
        mcpResult: async (name: string) => replies[name],
        external: async (args: string[]) => void calls.push(`external ${args.join(" ")}`),
      },
    };
  };

  it("external runs vimma-open with the step's arguments through the session", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const fake = fakeControl();
    await runSteps(
      scenario({ steps: [{ external: ["--from", "teams", "fixture:article.html"] }] }),
      { ctl, control: fake.control, screenshot: async () => {} },
    );
    expect(fake.calls).toEqual(["external --from teams fixture:article.html"]);
  });

  it("after hold, keys, state and open go through the held connection", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "normal" }]);
    const fake = fakeControl();
    await runSteps(
      scenario({
        steps: [
          { keys: "esc" },
          { hold: true },
          { keys: "j" },
          { "assert-state": { mode: "normal" } },
          { open: "about:blank" },
        ],
      }),
      { ctl, control: fake.control, screenshot: async () => {} },
    );
    expect(calls).toEqual(["keys esc"]);
    expect(fake.calls).toEqual(["hold", "held keys j", "held state", "held open about:blank"]);
  });

  it("agent steps send, then check the answer, with $name.path from earlier answers", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const fake = fakeControl();
    await runSteps(
      scenario({
        steps: [
          { agent: { send: "agent-open", args: { url: "https://a/" }, as: "open1" } },
          { "agent-result": { of: "open1", expect: { ok: true, result: { tab: "42" } } } },
          { agent: { send: "agent-read", args: { tab: "$open1.result.tab" }, as: "read1" } },
          { "agent-result": { of: "read1", expect: { ok: true } } },
          { ctl: { run: ["state"], as: "c1" } },
          { "ctl-result": { of: "c1", expect: { exitCode: 0 } } },
        ],
      }),
      { ctl, control: fake.control, screenshot: async () => {} },
    );
    expect(fake.calls).toEqual([
      'agent agent-open {"url":"https://a/"} as open1',
      'agent agent-read {"tab":"42"} as read1',
      "ctl state as c1",
    ]);
  });

  it("mcp steps send JSON-RPC, then check the answer, with $name.path anywhere in params", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const fake = fakeControl();
    await runSteps(
      scenario({
        steps: [
          { mcp: { method: "tools/call", params: { name: "vimma_open" }, as: "open1" } },
          { "mcp-result": { of: "open1", expect: { ok: true } } },
          { mcp: { method: "notifications/initialized" } },
          {
            mcp: {
              method: "tools/call",
              params: { name: "vimma_read_page", arguments: { tab: "$open1.result.tab" } },
              as: "read1",
            },
          },
          { "mcp-result": { of: "read1", expect: { ok: true } } },
        ],
      }),
      { ctl, control: fake.control, screenshot: async () => {} },
    );
    expect(fake.calls).toEqual([
      'mcp tools/call {"name":"vimma_open"} as open1',
      "mcp notifications/initialized {} as undefined",
      'mcp tools/call {"name":"vimma_read_page","arguments":{"tab":"42"}} as read1',
    ]);
  });

  it("an agent answer that does not match fails the step", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const fake = fakeControl();
    await expect(
      runSteps(
        scenario({
          steps: [
            { agent: { send: "agent-open", args: { url: "https://a/" }, as: "open1" } },
            { "agent-result": { of: "open1", expect: { ok: false } } },
          ],
        }),
        { ctl, control: fake.control, screenshot: async () => {} },
      ),
    ).rejects.toThrow(/step 2 \(agent-result\): open1\.ok: expected false, got true/);
  });

  it("type sends the text one chord per character, spaces as space, after the session's text()", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "normal" }]);
    await runSteps(scenario({ steps: [{ type: "[[open fixture:a.html]] ~/D+<" }] }), {
      ctl,
      screenshot: async () => {},
      text: (t) => t.replace("fixture:a.html", "http://h:9/a.html"),
    });
    expect(calls).toEqual([
      "keys [ [ o p e n space h t t p : / / h : 9 / a . h t m l ] ] space ~ / D + <",
    ]);
  });

  // Issue #953: a screenshot that differs from its baseline (or has none) fails the scenario only
  // at its end, so one run writes every image that differs, and a CI run can supply every
  // baseline of a re-record at once. The steps after it still run and can fail on their own.
  it("a screenshot that fails lets the steps go on and fails the scenario at its end", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "normal" }]);
    const shots: string[] = [];
    const screenshot = async (name: string) => {
      shots.push(name);
      return name === "ok" ? undefined : `${name}: 1.00 % of pixels differ`;
    };
    await expect(
      runSteps(
        scenario({
          steps: [{ screenshot: "a" }, { keys: "j" }, { screenshot: "ok" }, { screenshot: "b" }],
        }),
        { ctl, screenshot },
      ),
    ).rejects.toThrow(
      /^step 1 \(screenshot\): a: 1\.00 % of pixels differ\nstep 4 \(screenshot\): b: 1\.00 %/,
    );
    expect(shots).toEqual(["a", "ok", "b"]);
    expect(calls).toEqual(["keys j"]);
  });

  it("a later step's failure names the screenshots that failed before it", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    await expect(
      runSteps(scenario({ steps: [{ screenshot: "a" }, { "assert-state": { mode: "insert" } }] }), {
        ctl,
        screenshot: async () => "a: no baseline",
      }),
    ).rejects.toThrow(
      /^step 2 \(assert-state\): .*mode.*\nstep 1 \(screenshot\): a: no baseline$/s,
    );
  });

  it("sleep waits", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const started = Date.now();
    await runSteps(scenario({ steps: [{ sleep: 0.05 }] }), { ctl, screenshot: async () => {} });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("wait-for-profile-file waits until the file exists in the session's profile", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const profile = tempDir("vimma-e2e-step-");
    setTimeout(() => writeFileSync(join(profile, "search.json.mozlz4"), ""), 60);
    const started = Date.now();
    await runSteps(scenario({ steps: [{ "wait-for-profile-file": "search.json.mozlz4" }] }), {
      ctl,
      screenshot: async () => {},
      profile,
      pollMs: 10,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("wait-for-profile-file times out naming the file", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    const profile = tempDir("vimma-e2e-step-");
    await expect(
      runSteps(
        scenario({ steps: [{ "wait-for-profile-file": "nope.json", timeoutSeconds: 0.1 }] }),
        { ctl, screenshot: async () => {}, profile, pollMs: 10 },
      ),
    ).rejects.toThrow(
      /step 1 \(wait-for-profile-file\): nope\.json not in the profile after 0\.1 s/,
    );
  });

  it("wait-for-profile-file fails when the session has no profile", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    await expect(
      runSteps(scenario({ steps: [{ "wait-for-profile-file": "a.json" }] }), {
        ctl,
        screenshot: async () => {},
      }),
    ).rejects.toThrow(/step 1 \(wait-for-profile-file\): this session has no profile/);
  });

  it("runs each step in order", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "insert" }, { mode: "insert" }, { mode: "help" }]);
    const shots: string[] = [];
    await runSteps(
      scenario({
        steps: [
          { open: "about:blank" },
          { keys: "ctrl+b ?" },
          { "wait-for-state": { mode: "help" } },
          { screenshot: "m0-sample-help" },
        ],
      }),
      { ctl, screenshot: async (n: string) => void shots.push(n), pollMs: 1 },
    );
    expect(calls).toEqual(["open about:blank", "keys ctrl+b ?", "state", "state", "state"]);
    expect(shots).toEqual(["m0-sample-help"]);
  });

  it("assert-state checks once and fails with the step and the mismatch", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "insert" }, { mode: "help" }]);
    await expect(
      runSteps(scenario({ steps: [{ "assert-state": { mode: "help" } }] }), {
        ctl,
        screenshot: async () => {},
      }),
    ).rejects.toThrow(/step 1 \(assert-state\): state\.mode: expected "help", got "insert"/);
    expect(calls).toEqual(["state"]);
  });

  it("wait-for-state times out with the last mismatch", async () => {
    const { ctl } = fakeCtl([{ mode: "insert" }]);
    await expect(
      runSteps(
        scenario({
          steps: [{ keys: "esc" }, { "wait-for-state": { mode: "help" }, timeoutSeconds: 0.2 }],
        }),
        { ctl, screenshot: async () => {}, pollMs: 20 },
      ),
    ).rejects.toThrow(
      /step 2 \(wait-for-state\): not reached in 0\.2 s: state\.mode: expected "help", got "insert"/,
    );
  });

  it("restart quits and relaunches through the session, then goes on", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "normal" }]);
    await runSteps(
      scenario({ steps: [{ keys: "esc" }, { restart: "quit" }, { "assert-state": {} }] }),
      {
        ctl,
        screenshot: async () => {},
        restart: async (how: string) => void calls.push(`restart ${how}`),
      },
    );
    expect(calls).toEqual(["keys esc", "restart quit", "state"]);
  });

  it("restart kill hands the crash-style restart to the session", async () => {
    const { ctl, calls } = fakeCtl([{ mode: "normal" }]);
    await runSteps(scenario({ steps: [{ restart: "kill" }] }), {
      ctl,
      screenshot: async () => {},
      restart: async (how: string) => void calls.push(`restart ${how}`),
    });
    expect(calls).toEqual(["restart kill"]);
  });

  it("restart fails with the step when the session cannot restart", async () => {
    const { ctl } = fakeCtl([{ mode: "normal" }]);
    await expect(
      runSteps(scenario({ steps: [{ restart: "quit" }] }), { ctl, screenshot: async () => {} }),
    ).rejects.toThrow(/step 1 \(restart\): this session cannot restart/);
  });

  it("stops when the signal aborts (scenario timeout)", async () => {
    const { ctl } = fakeCtl([{ mode: "insert" }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      runSteps(scenario({ steps: [{ "wait-for-state": { mode: "help" }, timeoutSeconds: 30 }] }), {
        ctl,
        screenshot: async () => {},
        pollMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("update scenarios (m6a-updater, e2e)", () => {
  const update = (over: object) =>
    scenario({ name: "m6a-sample", update: { updater: "test" }, ...over });
  const ctl = { state: async () => ({}), sendKeys: async () => {}, open: async () => "1" };

  it("validates the update field and its two steps", () => {
    expect(
      validateScenario(
        update({
          steps: [
            { "serve-update": { offer: "n1" } },
            { "serve-update": { offer: "older-firefox", key: "test" } },
            { "serve-update": { offer: "n1", key: "unknown" } },
            { "serve-update": { offer: "none" } },
            { "wait-for-install": { buildId: "n1", marker: true }, timeoutSeconds: 60 },
            { "wait-for-install": { updateError: 23, marRequests: 0 } },
            { "wait-for-install": { updateError: null } },
          ],
        }),
        undefined,
      ),
    ).toEqual([]);
    const bad = (over: object) => validateScenario(update(over), undefined).join("; ");
    expect(bad({ update: { updater: "mine" } })).toMatch(/update: updater is test or shipped/);
    expect(bad({ update: { updater: "test", extra: 1 } })).toMatch(/update: unknown field extra/);
    expect(bad({ steps: [{ "serve-update": { offer: "n2" } }] })).toMatch(
      /step 1: serve-update: offer is one of n1, n, older-firefox, none/,
    );
    expect(bad({ steps: [{ "serve-update": { offer: "n1", key: "real" } }] })).toMatch(
      /step 1: serve-update: key is test or unknown/,
    );
    expect(bad({ steps: [{ "wait-for-install": {} }] })).toMatch(
      /step 1: wait-for-install needs one or more of buildId, marker, updateError, marRequests/,
    );
    expect(bad({ steps: [{ "wait-for-install": { buildId: "n3" } }] })).toMatch(
      /step 1: wait-for-install: buildId is n or n1/,
    );
    expect(bad({ steps: [{ "wait-for-install": { updateError: "19" } }] })).toMatch(
      /step 1: wait-for-install: updateError is an error code or null/,
    );
    expect(bad({ steps: [{ "wait-for-install": { marRequests: -1 } }] })).toMatch(
      /step 1: wait-for-install: marRequests is a count/,
    );
    // the update steps need an install the scenario updates
    expect(
      validateScenario(scenario({ steps: [{ "serve-update": { offer: "n1" } }] }), undefined).join(
        "; ",
      ),
    ).toMatch(/step 1: serve-update needs the scenario's "update" field/);
  });

  it("serve-update hands the offer to the session, wait-for-install waits for the install", async () => {
    const calls: string[] = [];
    let reads = 0;
    const install: () => Promise<InstallState> = async () => {
      reads++;
      return reads < 3
        ? { buildId: "n", marker: false, updateError: null, marRequests: 0 }
        : { buildId: "n1", marker: true, updateError: null, marRequests: 2 };
    };
    await runSteps(
      update({
        steps: [
          { "serve-update": { offer: "n1" } },
          { "wait-for-install": { buildId: "n1", marker: true, updateError: null } },
        ],
      }),
      {
        ctl,
        screenshot: async () => {},
        update: { serve: async (s) => void calls.push(JSON.stringify(s)), install },
        pollMs: 1,
      },
    );
    expect(calls).toEqual(['{"offer":"n1"}']);
    expect(reads).toBe(3);
  });

  it("wait-for-install times out naming what differs", async () => {
    const install: () => Promise<InstallState> = async () => ({
      buildId: "n",
      marker: false,
      updateError: 23,
      marRequests: 1,
    });
    await expect(
      runSteps(
        update({ steps: [{ "wait-for-install": { updateError: 19 }, timeoutSeconds: 0.05 }] }),
        { ctl, screenshot: async () => {}, update: { serve: async () => {}, install }, pollMs: 1 },
      ),
    ).rejects.toThrow(
      /step 1 \(wait-for-install\): not reached in 0\.05 s: install\.updateError: expected 19, got 23/,
    );
  });

  it("the update steps fail on a session without an update host", async () => {
    await expect(
      runSteps(update({ steps: [{ "serve-update": { offer: "n1" } }] }), {
        ctl,
        screenshot: async () => {},
      }),
    ).rejects.toThrow(/step 1 \(serve-update\): this session has no update host/);
  });
});

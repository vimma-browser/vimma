// Declarative e2e scenarios (spec m0-e2e-harness, "Scenario format"): one JSON file per
// scenario in tests/e2e/scenarios/, steps open / keys / wait-for-state / assert-state /
// screenshot / restart / wait-for-profile-file, and optional `prefs` overriding the harness profile's. For the agent
// question line (docs/specs/vimma-mcp.md, sub-PR 2b): `hold` keeps one full connection for the
// rest of the scenario (opened while MCP is off, so later keys never ask), `agent` sends an
// agent request without waiting and `agent-result` checks its answer, `ctl` runs vimma-ctl
// without waiting (a new full connection, which asks while MCP is on) and `ctl-result` checks
// how it ended, `wait-for-profile-file` waits for a file the browser writes into its profile
// (an internal service's own signal that it is ready, which state does not show), and `sleep` waits for a time-based rule (the 1.5 s quiet, the 1 s arming). For
// `vimma-ctl mcp` (sub-PR 3): `mcp` sends one JSON-RPC message to it over stdio (a request when
// it names its answer with `as`, else a notification) and `mcp-result` checks the response.
// For the built-in agent's CLI mode (docs/specs/builtin-agent-cli.md, "e2e"): `programs` names
// files in the checkout the browser finds on its PATH under a given name, a pref value
// `checkout:<path>` is that path in the checkout, and `type` types a text into the focused input.
// For app routes (docs/specs/app-routes.md, "Tests"): `external` runs the packaged vimma-open
// with the given arguments, as another program does, against the browser under test.
// For the updater (docs/specs/m6a-updater.md, "Tests", e2e): a scenario with `update` runs on
// an install of a VIMMA_UPDATES=1 build with a local update host (update-host.mjs); `serve-update`
// sets the manifest that host serves and `wait-for-install` waits on the install itself (its
// build ID, the MAR's marker file, the updater's error code) and the MAR requests the host saw.
// Names carry the milestone (m<N>-…) or, for regression tests, the issue (issue-<N>-…).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @typedef {{
 *   open?: string, keys?: string, "wait-for-state"?: Record<string, unknown>,
 *   "assert-state"?: Record<string, unknown>, screenshot?: string, restart?: "quit" | "kill",
 *   timeoutSeconds?: number, hold?: true, sleep?: number, agent?: AgentSend,
 *   "agent-result"?: { of: string, expect: unknown }, ctl?: { run: string[], as: string },
 *   "ctl-result"?: { of: string, expect: unknown }, mcp?: McpSend,
 *   "mcp-result"?: { of: string, expect: unknown }, "wait-for-profile-file"?: string,
 *   type?: string, external?: string[], "serve-update"?: UpdateServe,
 *   "wait-for-install"?: Partial<InstallState>,
 * }} Step
 * @typedef {{ offer: "n1" | "n" | "older-firefox" | "none", key?: "test" | "unknown" }}
 *   UpdateServe
 * @typedef {{ buildId: "n" | "n1" | null, marker: boolean, updateError: number | null,
 *   marRequests: number }} InstallState  `buildId`: which build the install holds and the profile
 *   last ran, null when they differ or are neither
 * @typedef {{ serve: (spec: UpdateServe) => Promise<void>, install: () => Promise<InstallState> }}
 *   UpdateControl
 * @typedef {{ method: string, params?: Record<string, unknown>, as?: string }} McpSend
 * @typedef {{ send: string, args?: Record<string, unknown>, as: string, client?: string }}
 *   AgentSend
 * @typedef {{
 *   hold: () => Promise<void>,
 *   held: { state: () => Promise<any>, sendKeys: (keys: string) => Promise<void>,
 *     open: (url: string) => Promise<string> },
 *   agentSend: (spec: AgentSend) => void,
 *   agentResult: (name: string) => Promise<unknown>,
 *   ctlSpawn: (args: string[], as: string) => void,
 *   ctlResult: (name: string) => Promise<{ exitCode: number | null, stderr: string }>,
 *   mcpSend: (spec: McpSend) => void,
 *   mcpResult: (name: string) => Promise<unknown>,
 *   external?: (args: string[]) => Promise<void>,
 * }} Control
 * @typedef {{
 *   name: string, description: string, issue?: number, pending?: string,
 *   timeoutSeconds?: number, prefs?: Record<string, boolean | number | string | null>,
 *   programs?: Record<string, string>, update?: { updater: "test" | "shipped" }, steps: Step[],
 * }} Scenario
 * @typedef {{
 *   ctl: { state: () => Promise<any>, sendKeys: (keys: string) => Promise<void>,
 *     open: (url: string) => Promise<string> },
 *   screenshot: (name: string) => Promise<void>,
 *   restart?: (how: "quit" | "kill") => Promise<void>,
 *   control?: Control,
 *   profile?: string,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   text?: (text: string) => string,
 *   update?: UpdateControl,
 * }} StepContext
 */

export const STEP_KINDS = Object.freeze([
  "open",
  "keys",
  "wait-for-state",
  "assert-state",
  "screenshot",
  "restart",
  "hold",
  "sleep",
  "agent",
  "agent-result",
  "ctl",
  "ctl-result",
  "mcp",
  "mcp-result",
  "wait-for-profile-file",
  "type",
  "external",
  "serve-update",
  "wait-for-install",
]);
/** Steps that wait for something and so take `timeoutSeconds`. */
const WAITS = ["wait-for-state", "wait-for-profile-file", "wait-for-install"];
/** What `serve-update` offers: N+1, N again, a MAR of an older Firefox, or nothing. */
const OFFERS = ["n1", "n", "older-firefox", "none"];
/** The manifest's signer: the run's pinned test key, or a key the browser does not pin. */
const SIGNERS = ["test", "unknown"];
/** The updater an update scenario's install carries: Mozilla's test build, or the shipped one. */
const UPDATERS = ["test", "shipped"];
const INSTALL_FIELDS = ["buildId", "marker", "updateError", "marRequests"];
/** A file directly in the profile directory: no path, no `.` or `..`. */
const PROFILE_FILE = /^(?!\.\.?$)[\w.-]+$/;
/** The agent commands an `agent` step may send (control protocol 2). */
const AGENT_SENDS = ["agent-tabs", "agent-read", "agent-open", "agent-close", "agent-ping"];
const AGENT_FIELDS = new Set(["send", "args", "as", "client"]);
const MCP_FIELDS = new Set(["method", "params", "as"]);
const RESULT_NAME = /^[a-z0-9]+$/;
/** The longest `sleep`, seconds: a wait for a rule's time, not a flake's. */
const MAX_SLEEP_SECONDS = 30;
const FIELDS = new Set([
  "name",
  "description",
  "issue",
  "pending",
  "timeoutSeconds",
  "prefs",
  "programs",
  "update",
  "steps",
]);
const PREF_NAME = /^[\w.-]+$/;
/** A program's name on PATH: one file name, not `.` or `..`. */
const PROGRAM_NAME = /^(?!\.\.?$)[\w.-]+$/;
/** A pref value naming a path in the checkout. */
const CHECKOUT = "checkout:";
/** The pref naming the vimma-ctl the agent CLI runs (AgentCli.sys.mjs, VIMMA_CTL_PREF). */
const VIMMA_CTL_PREF = "vimma.agent.cli.vimmaCtl";
/** control.mjs's MAX_CHORDS: the most chords one send-keys takes. */
const MAX_CHORDS = 256;
/** Control characters cannot be typed as one chord each. @param {string} text */
const hasControlChar = (text) =>
  [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
/**
 * How `restart` restarts: `quit` is ctrl+q, then a launch on the same profile; `kill` waits for
 * SessionStore's recovery file to settle, SIGKILLs the browser process (a crash: no quit
 * observers, no final session write), then launches on the same profile.
 */
const RESTARTS = ["quit", "kill"];
const MILESTONE_NAME = /^m\d+[a-z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISSUE_NAME = /^issue-(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Default wait for `wait-for-state` and `wait-for-profile-file`, seconds. */
export const DEFAULT_WAIT_SECONDS = 10;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * A relative path inside the checkout: no absolute path, no `..` part.
 * @param {unknown} v
 */
const checkoutPath = (v) =>
  typeof v === "string" &&
  v !== "" &&
  !v.startsWith("/") &&
  !v.split("/").some((part) => part === ".." || part === "");
/** @param {unknown} v */
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * @param {unknown} s
 * @param {string | undefined} fileName checked against `name` when given
 * @returns {string[]} problems, empty when valid
 */
export function validateScenario(s, fileName) {
  /** @type {string[]} */
  const errors = [];
  if (!isObject(s)) return ["a scenario must be a JSON object"];
  for (const key of Object.keys(s)) {
    if (!FIELDS.has(key)) errors.push(`unknown field "${key}"`);
  }
  const name = s.name;
  if (typeof name !== "string" || !(MILESTONE_NAME.test(name) || ISSUE_NAME.test(name))) {
    errors.push(
      "name must be m<N>-<slug> or issue-<N>-<slug> (milestone happy path, regression test)",
    );
  } else {
    const issue = ISSUE_NAME.exec(name)?.[1];
    if (issue !== undefined && s.issue !== Number(issue)) {
      errors.push(`a regression test named ${name} must have "issue": ${issue}`);
    }
    if (fileName !== undefined && basename(fileName, ".json") !== name) {
      errors.push(`file name ${basename(fileName)} must be ${name}.json`);
    }
  }
  if (typeof s.description !== "string" || s.description.trim() === "") {
    errors.push("description must be a non-empty string");
  }
  if ("pending" in s && (typeof s.pending !== "string" || s.pending.trim() === "")) {
    errors.push("pending must be a non-empty string saying why the scenario cannot run yet");
  }
  if ("timeoutSeconds" in s && !positive(s.timeoutSeconds)) {
    errors.push("timeoutSeconds must be a positive number");
  }
  if ("prefs" in s) {
    if (!isObject(s.prefs)) {
      errors.push("prefs must be an object of pref name to value (null: the build's default)");
    } else {
      for (const [name, value] of Object.entries(s.prefs)) {
        const ok = value === null || ["boolean", "number", "string"].includes(typeof value);
        if (!PREF_NAME.test(name) || !ok) {
          errors.push(
            `prefs: "${name}" must be a pref name with a boolean, number, string or null`,
          );
        } else if (
          typeof value === "string" &&
          value.startsWith(CHECKOUT) &&
          !checkoutPath(value.slice(CHECKOUT.length))
        ) {
          errors.push(`prefs: "${name}": checkout: needs a relative path in the checkout`);
        }
      }
    }
  }
  if ("programs" in s) {
    if (!isObject(s.programs)) {
      errors.push("programs must be an object of program name to a file in the checkout");
    } else {
      for (const [name, path] of Object.entries(s.programs)) {
        if (!PROGRAM_NAME.test(name) || !checkoutPath(path)) {
          errors.push(
            `programs: "${name}" must be a file name with a relative path in the checkout`,
          );
        }
      }
    }
  }
  if ("update" in s) {
    if (!isObject(s.update)) errors.push('update must be { "updater": "test" | "shipped" }');
    else {
      const extra = Object.keys(s.update).filter((k) => k !== "updater");
      if (extra.length) errors.push(`update: unknown field ${extra.join(", ")}`);
      if (!UPDATERS.includes(/** @type {string} */ (s.update.updater))) {
        errors.push("update: updater is test or shipped");
      }
    }
  }
  if (!Array.isArray(s.steps) || s.steps.length === 0) {
    errors.push("steps must be an array with at least one step");
    return errors;
  }
  /** @type {Set<string>} */
  const agentNames = new Set();
  /** @type {Set<string>} */
  const ctlNames = new Set();
  /** @type {Set<string>} */
  const mcpNames = new Set();
  /** Agent and mcp answers share one namespace for `$name.path`. @param {string} n */
  const answerTaken = (n) => agentNames.has(n) || mcpNames.has(n);
  s.steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    if (!isObject(step)) return void errors.push(`${at}: must be an object`);
    const kinds = Object.keys(step).filter((k) => k !== "timeoutSeconds");
    const kind = kinds[0];
    if (kinds.length !== 1 || kind === undefined || !STEP_KINDS.includes(kind)) {
      return void errors.push(`${at}: exactly one of ${STEP_KINDS.join(", ")}`);
    }
    const value = step[kind];
    if (kind === "open" && (typeof value !== "string" || value === "")) {
      errors.push(`${at}: open needs a URL string`);
    }
    if (kind === "keys" && (typeof value !== "string" || value.trim() === "")) {
      errors.push(`${at}: keys needs Herdr chords, e.g. "ctrl+b ?"`);
    }
    if (kind === "type" && (typeof value !== "string" || value === "" || hasControlChar(value))) {
      errors.push(`${at}: type needs a non-empty text without control characters`);
    }
    if (
      kind === "external" &&
      !(
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((a) => typeof a === "string" && !hasControlChar(a))
      )
    ) {
      errors.push(`${at}: external is vimma-open's arguments, a non-empty array of strings`);
    }
    if ((kind === "wait-for-state" || kind === "assert-state") && !isObject(value)) {
      errors.push(`${at}: ${kind} needs an object to match against state`);
    }
    if (
      kind === "wait-for-profile-file" &&
      (typeof value !== "string" || !PROFILE_FILE.test(value))
    ) {
      errors.push(`${at}: wait-for-profile-file needs a file name in the profile, without a path`);
    }
    if (kind === "screenshot" && (typeof value !== "string" || !SHOT_NAME.test(value))) {
      errors.push(`${at}: screenshot needs a baseline name of [a-z0-9-]`);
    }
    if (kind === "restart" && !RESTARTS.includes(/** @type {string} */ (value))) {
      errors.push(`${at}: restart is one of ${RESTARTS.join(", ")}`);
    }
    if (kind === "hold" && value !== true) errors.push(`${at}: hold is true`);
    if (
      kind === "sleep" &&
      (!positive(value) || /** @type {number} */ (value) > MAX_SLEEP_SECONDS)
    ) {
      errors.push(
        `${at}: sleep is a number of seconds, more than 0 and at most ${MAX_SLEEP_SECONDS}`,
      );
    }
    if (kind === "agent") {
      if (!isObject(value)) {
        errors.push(`${at}: agent needs { send, args?, as }`);
      } else {
        const extra = Object.keys(value).filter((k) => !AGENT_FIELDS.has(k));
        if (extra.length) errors.push(`${at}: agent: unknown field(s) ${extra.join(", ")}`);
        if (!AGENT_SENDS.includes(/** @type {string} */ (value.send))) {
          errors.push(`${at}: agent: send is an agent command (${AGENT_SENDS.join(", ")})`);
        }
        if ("args" in value && !isObject(value.args))
          errors.push(`${at}: agent: args is an object`);
        if (typeof value.as !== "string" || !RESULT_NAME.test(value.as)) {
          errors.push(`${at}: agent: as names the answer ([a-z0-9]+)`);
        } else if (answerTaken(value.as)) {
          errors.push(`${at}: agent: "${value.as}" is taken`);
        } else {
          agentNames.add(value.as);
        }
      }
    }
    if (kind === "mcp") {
      if (!isObject(value)) {
        errors.push(`${at}: mcp needs { method, params?, as? }`);
      } else {
        const extra = Object.keys(value).filter((k) => !MCP_FIELDS.has(k));
        if (extra.length) errors.push(`${at}: mcp: unknown field(s) ${extra.join(", ")}`);
        if (typeof value.method !== "string" || value.method === "") {
          errors.push(`${at}: mcp: method is a string`);
        }
        if ("params" in value && !isObject(value.params)) {
          errors.push(`${at}: mcp: params is an object`);
        }
        if ("as" in value) {
          if (typeof value.as !== "string" || !RESULT_NAME.test(value.as)) {
            errors.push(`${at}: mcp: as names the answer ([a-z0-9]+)`);
          } else if (answerTaken(value.as)) {
            errors.push(`${at}: mcp: "${value.as}" is taken`);
          } else {
            mcpNames.add(value.as);
          }
        }
      }
    }
    if (kind === "ctl") {
      const ok =
        isObject(value) &&
        Array.isArray(value.run) &&
        value.run.length > 0 &&
        value.run.every((a) => typeof a === "string");
      if (!ok) errors.push(`${at}: ctl: run is vimma-ctl's arguments, as a non-empty array`);
      else if (typeof value.as !== "string" || !RESULT_NAME.test(value.as)) {
        errors.push(`${at}: ctl: as names the run ([a-z0-9]+)`);
      } else if (ctlNames.has(value.as)) {
        errors.push(`${at}: ctl: "${value.as}" is taken`);
      } else {
        ctlNames.add(value.as);
      }
    }
    for (const [k, names, what] of /** @type {const} */ ([
      ["agent-result", agentNames, "agent"],
      ["ctl-result", ctlNames, "ctl"],
      ["mcp-result", mcpNames, "mcp"],
    ])) {
      if (kind !== k) continue;
      if (!isObject(value) || typeof value.of !== "string" || !("expect" in value)) {
        errors.push(`${at}: ${k} needs { of, expect }`);
      } else if (!names.has(value.of)) {
        errors.push(`${at}: ${k}: no ${what} step before it is named "${value.of}"`);
      }
    }
    if ((kind === "serve-update" || kind === "wait-for-install") && !("update" in s)) {
      errors.push(`${at}: ${kind} needs the scenario's "update" field`);
    }
    if (kind === "serve-update") {
      if (!isObject(value) || !OFFERS.includes(/** @type {string} */ (value.offer))) {
        errors.push(`${at}: serve-update: offer is one of ${OFFERS.join(", ")}`);
      } else {
        const extra = Object.keys(value).filter((k) => k !== "offer" && k !== "key");
        if (extra.length) errors.push(`${at}: serve-update: unknown field(s) ${extra.join(", ")}`);
        if ("key" in value && !SIGNERS.includes(/** @type {string} */ (value.key))) {
          errors.push(`${at}: serve-update: key is test or unknown`);
        }
      }
    }
    if (kind === "wait-for-install") {
      const keys = isObject(value) ? Object.keys(value) : [];
      if (!isObject(value) || keys.length === 0 || keys.some((k) => !INSTALL_FIELDS.includes(k))) {
        errors.push(`${at}: wait-for-install needs one or more of ${INSTALL_FIELDS.join(", ")}`);
      } else {
        if ("buildId" in value && value.buildId !== "n" && value.buildId !== "n1") {
          errors.push(`${at}: wait-for-install: buildId is n or n1`);
        }
        if ("marker" in value && typeof value.marker !== "boolean") {
          errors.push(`${at}: wait-for-install: marker is true or false`);
        }
        if (
          "updateError" in value &&
          value.updateError !== null &&
          !(Number.isInteger(value.updateError) && /** @type {number} */ (value.updateError) > 0)
        ) {
          errors.push(`${at}: wait-for-install: updateError is an error code or null`);
        }
        if (
          "marRequests" in value &&
          !(Number.isInteger(value.marRequests) && /** @type {number} */ (value.marRequests) >= 0)
        ) {
          errors.push(`${at}: wait-for-install: marRequests is a count`);
        }
      }
    }
    if ("timeoutSeconds" in step && (!WAITS.includes(kind) || !positive(step.timeoutSeconds))) {
      errors.push(`${at}: timeoutSeconds is a positive number, on ${WAITS.join(" and ")} only`);
    }
  });
  return errors;
}

/**
 * Load every scenario in `dir` (sorted by name), optionally those whose name contains `filter`.
 * Any invalid file throws: a broken scenario must not silently drop out of the suite.
 * @param {string} dir
 * @param {{ filter?: string }} [options]
 * @returns {Scenario[]}
 */
export function loadScenarios(dir, { filter } = {}) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  /** @type {Scenario[]} */
  const all = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      throw new Error(`${file}: ${/** @type {Error} */ (e).message}`, { cause: e });
    }
    const errors = validateScenario(parsed, file);
    if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
    all.push(parsed);
  }
  const selected = filter ? all.filter((s) => s.name.includes(filter)) : all;
  if (filter && selected.length === 0) throw new Error(`no scenario matches "${filter}"`);
  return selected;
}

/**
 * Subset match of `expected` against `actual`: objects match when every expected key matches
 * (extra actual keys are ignored, as protocol v1 lets the server add fields); arrays need the
 * same length and element-wise matches; anything else must be equal.
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} [path]
 * @returns {string[]} mismatches, empty when it matches
 */
export function matchState(expected, actual, path = "state") {
  const show = (/** @type {unknown} */ v) => (v === undefined ? "undefined" : JSON.stringify(v));
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${show(actual)}`];
    if (actual.length !== expected.length) {
      return [`${path}: expected ${expected.length} item(s), got ${actual.length}`];
    }
    return expected.flatMap((e, i) => matchState(e, actual[i], `${path}[${i}]`));
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return [`${path}: expected ${show(expected)}, got ${show(actual)}`];
    return Object.entries(expected).flatMap(([k, v]) => matchState(v, actual[k], `${path}.${k}`));
  }
  return Object.is(expected, actual)
    ? []
    : [`${path}: expected ${show(expected)}, got ${show(actual)}`];
}

/**
 * What the harness launches a scenario with: its programs and `checkout:` prefs as absolute
 * paths in the checkout `root`, and the vimma-ctl the agent CLI runs (the scenario's own pref
 * wins). The build has no vimma-ctl beside its binary in a checkout, so without the pref the
 * agent CLI could not start one.
 * @param {Scenario} scenario
 * @param {{ root: string, vimmaCtl: string | null }} o
 * @returns {{ programs: Record<string, string>,
 *   prefs: Record<string, boolean | number | string | null> }}
 */
export function scenarioLaunch(scenario, { root, vimmaCtl }) {
  /** @type {Record<string, boolean | number | string | null>} */
  const prefs = vimmaCtl ? { [VIMMA_CTL_PREF]: vimmaCtl } : {};
  for (const [name, value] of Object.entries(scenario.prefs ?? {})) {
    prefs[name] =
      typeof value === "string" && value.startsWith(CHECKOUT)
        ? resolve(root, value.slice(CHECKOUT.length))
        : value;
  }
  const programs = Object.fromEntries(
    Object.entries(scenario.programs ?? {}).map(([name, path]) => [name, resolve(root, path)]),
  );
  return { programs, prefs };
}

/**
 * A text as send-keys chords, one per character: a space is `space`, any other character is
 * its own chord (an upper-case letter is shift and the letter).
 * @param {string} text
 * @returns {string[]}
 */
function textChords(text) {
  return [...text].map((c) => (c === " " ? "space" : c));
}

/** @param {AbortSignal | undefined} signal */
function checkAborted(signal) {
  if (signal?.aborted) throw new Error("aborted (scenario timeout)");
}

/**
 * Run a scenario's steps against a session. Throws on the first failing step, naming it.
 * @param {Scenario} scenario
 * @param {StepContext} context
 */
export async function runSteps(
  scenario,
  {
    ctl: own,
    screenshot,
    restart,
    control,
    profile,
    pollMs = 100,
    signal,
    text = (t) => t,
    update,
  },
) {
  /** Agent answers so far, for `$name.path` in later args. @type {Record<string, unknown>} */
  const answers = {};
  let ctl = own;
  /** @param {string} what */
  const needControl = (what) => {
    if (!control) throw new Error(`this session cannot run ${what} steps`);
    return control;
  };
  const needUpdate = () => {
    if (!update) throw new Error("this session has no update host");
    return update;
  };
  for (const [i, step] of scenario.steps.entries()) {
    const kind = /** @type {string} */ (Object.keys(step).find((k) => k !== "timeoutSeconds"));
    const at = `step ${i + 1} (${kind})`;
    checkAborted(signal);
    try {
      if (step["serve-update"] !== undefined) {
        await needUpdate().serve(step["serve-update"]);
      } else if (step["wait-for-install"] !== undefined) {
        const { install } = needUpdate();
        const seconds = step.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
          const mismatches = matchState(step["wait-for-install"], await install(), "install");
          if (mismatches.length === 0) break;
          if (Date.now() >= deadline) {
            throw new Error(`not reached in ${seconds} s: ${mismatches.join("; ")}`);
          }
          await sleep(pollMs);
          checkAborted(signal);
        }
      } else if (step.hold !== undefined) {
        const c = needControl("hold");
        await c.hold();
        ctl = c.held;
      } else if (step.sleep !== undefined) {
        await sleep(step.sleep * 1000, undefined, signal ? { signal } : undefined);
      } else if (step.agent !== undefined) {
        const args = substitute(step.agent.args ?? {}, answers);
        needControl("agent").agentSend({ ...step.agent, args });
      } else if (step["agent-result"] !== undefined) {
        const { of, expect } = step["agent-result"];
        const answer = await needControl("agent-result").agentResult(of);
        answers[of] = answer;
        const mismatches = matchState(expect, answer, of);
        if (mismatches.length) throw new Error(mismatches.join("; "));
      } else if (step.mcp !== undefined) {
        const params = step.mcp.params && substitute(step.mcp.params, answers);
        needControl("mcp").mcpSend({ ...step.mcp, ...(params ? { params } : {}) });
      } else if (step["mcp-result"] !== undefined) {
        const { of, expect } = step["mcp-result"];
        const answer = await needControl("mcp-result").mcpResult(of);
        answers[of] = answer;
        const mismatches = matchState(expect, answer, of);
        if (mismatches.length) throw new Error(mismatches.join("; "));
      } else if (step.ctl !== undefined) {
        needControl("ctl").ctlSpawn(step.ctl.run, step.ctl.as);
      } else if (step["ctl-result"] !== undefined) {
        const { of, expect } = step["ctl-result"];
        const ended = await needControl("ctl-result").ctlResult(of);
        const mismatches = matchState(expect, ended, of);
        if (mismatches.length) throw new Error(mismatches.join("; "));
      } else if (step.external !== undefined) {
        const run = needControl("external").external;
        if (!run) throw new Error("this session cannot run vimma-open");
        await run(step.external);
      } else if (step.open !== undefined) await ctl.open(step.open);
      else if (step.keys !== undefined) await ctl.sendKeys(step.keys);
      else if (step.type !== undefined) {
        const chords = textChords(text(step.type));
        for (let at = 0; at < chords.length; at += MAX_CHORDS) {
          await ctl.sendKeys(chords.slice(at, at + MAX_CHORDS).join(" "));
        }
      } else if (step.screenshot !== undefined) await screenshot(step.screenshot);
      else if (step.restart !== undefined) {
        if (!restart) throw new Error("this session cannot restart");
        await restart(step.restart);
      } else if (step["assert-state"] !== undefined) {
        const mismatches = matchState(step["assert-state"], await ctl.state());
        if (mismatches.length) throw new Error(mismatches.join("; "));
      } else if (step["wait-for-profile-file"] !== undefined) {
        if (profile === undefined) throw new Error("this session has no profile");
        const name = step["wait-for-profile-file"];
        const seconds = step.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
        const deadline = Date.now() + seconds * 1000;
        while (!existsSync(join(profile, name))) {
          if (Date.now() >= deadline) {
            throw new Error(`${name} not in the profile after ${seconds} s`);
          }
          await sleep(pollMs);
          checkAborted(signal);
        }
      } else if (step["wait-for-state"] !== undefined) {
        const seconds = step.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
          const mismatches = matchState(step["wait-for-state"], await ctl.state());
          if (mismatches.length === 0) break;
          if (Date.now() >= deadline) {
            throw new Error(`not reached in ${seconds} s: ${mismatches.join("; ")}`);
          }
          await sleep(pollMs);
          checkAborted(signal);
        }
      }
    } catch (e) {
      throw new Error(`${at}: ${/** @type {Error} */ (e).message}`, { cause: e });
    }
  }
}

/**
 * `args` with each string `$name.a.b`, at any depth, replaced by that path in the answer `name`
 * (an `agent-result` or `mcp-result` before it): `{ tab: "$open1.result.tab" }`.
 * @param {Record<string, unknown>} args @param {Record<string, unknown>} answers
 * @returns {Record<string, unknown>}
 */
function substitute(args, answers) {
  /** @param {unknown} v @returns {unknown} */
  const one = (v) => {
    if (Array.isArray(v)) return v.map(one);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]));
    if (typeof v !== "string" || !v.startsWith("$")) return v;
    const [name, ...path] = v.slice(1).split(".");
    /** @type {any} */
    let value = answers[/** @type {string} */ (name)];
    if (value === undefined)
      throw new Error(`${v}: no agent-result or mcp-result named ${name} yet`);
    for (const p of path) value = value?.[p];
    if (value === undefined) throw new Error(`${v}: not in the answer`);
    return value;
  };
  return /** @type {Record<string, unknown>} */ (one(args));
}

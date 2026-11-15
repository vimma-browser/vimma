#!/usr/bin/env node
/**
 * End-to-end scenarios on a real Vimma build (spec m0-e2e-harness, plan §5). Each scenario in
 * tests/e2e/scenarios/ gets a fresh temp profile and browser (under Xvfb when DISPLAY is unset),
 * driven through vimma-ctl; screenshots are compared with tests/e2e/baselines/. On macOS (or
 * with --headless) the browser runs with MOZ_HEADLESS=1 instead, and screenshot steps are
 * skipped: there is no framebuffer to capture, so no baseline is checked.
 *
 *   npm run e2e                                  # every scenario, the default build
 *   npm run e2e -- --filter m0-happy-path        # names containing the text
 *   npm run e2e -- --artifact                    # engine/obj-artifact (ADR-010)
 *   npm run e2e -- --build path/to/vimma | --tarball vimma-*.tar.xz
 *   npm run e2e -- --xvfb --keep                 # own Xvfb even with a display; keep profiles
 *   npm run e2e -- --headless                    # MOZ_HEADLESS, no screenshots (macOS default)
 *   npm run e2e -- --build /Volumes/Vimma/Vimma.app --vimma-ctl path/to/vimma-ctl
 *   npm run e2e -- --update-baselines            # rewrite baselines: commit body says why
 *   npm run e2e -- --run-pending                 # also run scenarios marked pending
 *   npm run e2e -- --report-json out.json        # also write the results as JSON (Beta canary)
 *   npm run e2e -- --port 28472                  # fixture pages on another port (VIMMA_E2E_PORT)
 *   npm run e2e -- --updater engine/obj-x86_64-pc-linux-gnu --filter m6a-update
 *                                                # the updater's scenarios (VIMMA_UPDATES=1)
 *
 * A scenario's `restart` step quits with ctrl+q ("quit") or SIGKILLs the browser once its
 * session is saved ("kill", a crash), and relaunches on the same profile; its
 * `prefs` override the profile's (null: the build's default; `checkout:<path>`: that path in the
 * checkout). Its `programs` are files in the checkout the browser finds on its PATH by name, and
 * the profile names the vimma-ctl found here for the built-in agent's CLI mode.
 *
 * A scenario with `update` (docs/specs/m6a-updater.md, "Tests", e2e) runs only with --updater,
 * the objdir of a VIMMA_UPDATES=1 build after `./mach package`: each gets its own install of that
 * tarball, updated from a local host (update-host.ts). Without --updater it is reported pending.
 *
 * Fixture pages are served on 127.0.0.1:28471 (PAGE_PORT in pages.ts), the port the baselines
 * show in the URL and status bars. When another process holds it (another e2e run, most likely),
 * the run stops before launching anything: a different port would be drawn into every screenshot
 * that shows a URL. --port N (or VIMMA_E2E_PORT=N) picks another, 0 any free one.
 *
 * Exit 0 when nothing failed (pending scenarios are reported, not passed), 1 on failures,
 * 2 on usage errors.
 */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ControlSessions } from "./control-client.ts";
import { Ctl, findVimmaCtl } from "./driver.ts";
import {
  DISCOVERY_FILE,
  crashBrowser,
  displayMode,
  externalWrapper,
  findBuild,
  launch,
  quitBrowser,
  runVimmaOpen,
  scenarioFontconfig,
  unpackTarball,
  waitForSessionSaved,
} from "./launcher.ts";
import { PAGE_PORT, fixtureText, fixtureUrl, pagePort, startPageServer } from "./pages.ts";
import { exitCode, formatReport, githubAnnotations, reportJson, runScenarios } from "./runner.ts";
import { loadScenarios, scenarioLaunch } from "./scenario.ts";
import { capture, checkBaseline, shotFailure } from "./screenshot.ts";
import { installState, prepareUpdateRun, trustCa, updateEnv, updatePrefs } from "./update-host.ts";
import type { Build } from "./launcher.ts";
import type { UpdateRun } from "./update-host.ts";
import type { Scenario, UpdateServe } from "./scenario.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** Why an update scenario does not run without --updater. */
const NEEDS_UPDATER =
  "needs a VIMMA_UPDATES=1 build: --updater <objdir> after ./mach package (docs/runbook/)";

const OPTIONS = {
  filter: { type: "string" },
  build: { type: "string" },
  artifact: { type: "boolean", default: false },
  tarball: { type: "string" },
  "vimma-ctl": { type: "string" },
  keep: { type: "boolean", default: false },
  xvfb: { type: "boolean", default: false },
  headless: { type: "boolean", default: false },
  "update-baselines": { type: "boolean", default: false },
  "run-pending": { type: "boolean", default: false },
  budget: { type: "string", default: "300" },
  "discovery-timeout": { type: "string", default: "30" },
  scenarios: { type: "string", default: join(REPO, "tests/e2e/scenarios") },
  baselines: { type: "string", default: join(REPO, "tests/e2e/baselines") },
  out: { type: "string", default: join(REPO, "e2e-output") },
  "report-json": { type: "string" },
  updater: { type: "string" },
  port: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

function usage(message: string): never {
  process.stderr.write(`e2e: ${message}\nSee the comment at the top of tools/e2e/e2e.ts.\n`);
  process.exit(2);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, allowPositionals: false }));
  } catch (e) {
    return usage((e as Error).message);
  }
  if (values.help) {
    process.stdout.write(`${readHelp()}\n`);
    return 0;
  }
  if (values["update-baselines"] && process.env.CI) {
    return usage("--update-baselines is refused in CI: baselines change only in a reviewed commit");
  }
  if (values["report-json"] === "") return usage("--report-json needs a file path");
  let port: number;
  try {
    port = pagePort({ flag: values.port, env: process.env });
  } catch (e) {
    return usage((e as Error).message);
  }
  const budgetMs = Number(values.budget) * 1000;
  const discoveryTimeoutMs = Number(values["discovery-timeout"]) * 1000;
  if (!(budgetMs > 0) || !(discoveryTimeoutMs > 0))
    return usage("--budget and --discovery-timeout are seconds > 0");
  if ([values.build, values.artifact || undefined, values.tarball].filter(Boolean).length > 1) {
    return usage("pass at most one of --build, --artifact, --tarball");
  }
  let mode: "xvfb" | "display" | "headless";
  try {
    mode = displayMode({ xvfb: values.xvfb, headless: values.headless });
  } catch (e) {
    return usage((e as Error).message);
  }

  const scenarios = loadScenarios(values.scenarios, { filter: values.filter }).map((s) =>
    s.update && !values.updater ? { ...s, pending: s.pending ?? NEEDS_UPDATER } : s,
  );
  const runnable = scenarios.filter((s) => values["run-pending"] || !s.pending);
  if (values.updater && process.platform !== "linux") {
    return usage("--updater: Firefox's updater is built for Linux tarballs only");
  }

  const cleanups: Array<() => Promise<void>> = [];
  const cleanupAll = async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  };
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(sig, () => {
      process.stderr.write(`\ne2e: ${sig}, cleaning up\n`);
      cleanupAll().finally(() => process.exit(code));
    });
  }

  /** `open "fixture:<name>"` */
  let pages: { base: string; close: () => Promise<void> } | null = null;
  try {
    let build: Build | null = null;
    let ctlBin: string = "";
    if (runnable.some((s) => !s.update)) {
      if (values.tarball) {
        const dir = mkdtempSync(join(tmpdir(), "vimma-e2e-build-"));
        cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
        build = unpackTarball(values.tarball, dir);
      } else {
        build = findBuild({ build: values.build, artifact: values.artifact, env: process.env });
      }
    }
    if (runnable.length) {
      ctlBin = findVimmaCtl({ flag: values["vimma-ctl"], env: process.env });
      // In-process: it dies with the CLI, so a signal needs no cleanup for it.
      try {
        pages = await startPageServer(join(REPO, "tests/e2e/fixtures"), { port });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
        // Not another port on its own: the baselines show this one in the URL and status bars.
        await cleanupAll();
        return usage(
          `the fixture pages' port: ${(e as Error).message}, most likely another ` +
            `e2e run. The baselines show port ${PAGE_PORT} in the URL and status bars: wait for ` +
            "that run, or pass --port N (or VIMMA_E2E_PORT=N; 0 for any free port), and a " +
            "screenshot that shows a URL then differs from its baseline by a few digits.",
        );
      }
      const note = port === PAGE_PORT ? "" : ` (not the baselines' port ${PAGE_PORT})`;
      console.log(`build: ${build?.binary ?? "none"}\nvimma-ctl: ${ctlBin}`);
      console.log(`fixture pages: ${pages.base}${note}`);
    }
    /** the update scenarios' */
    let updateRun: Promise<UpdateRun> | null = null;
    const updateWork = () => {
      const work = mkdtempSync(join(tmpdir(), "vimma-e2e-update-"));
      cleanups.push(async () => rmSync(work, { recursive: true, force: true }));
      return work;
    };
    const startUpdateRun = () => {
      const objdir = resolve(values.updater as string);
      const work = updateWork();
      const run = prepareUpdateRun({
        objdir,
        engine: join(REPO, "engine"),
        work,
        log: (line) => console.log(`        ${line}`),
      });
      cleanups.push(async () => (await run.catch(() => null))?.close());
      return run;
    };
    // Made before the first scenario starts, so the MAR builds (minutes: xz) do not count
    // against any scenario's timeout or the suite's budget.
    if (runnable.some((s) => s.update)) {
      console.log("update run: preparing N, N+1 and the downgrade build");
      await (updateRun = startUpdateRun());
    }
    if (runnable.length && mode === "headless") console.log("headless: screenshots are skipped");

    const rewritten: string[] = [];
    /** @param options the scenario's timeout */
    const startSession = async (scenario: Scenario, { signal }: { signal: AbortSignal }) => {
      let registered: () => Promise<void> = async () => {};
      const teardown = async () => {
        const i = cleanups.indexOf(registered);
        if (i >= 0) cleanups.splice(i, 1);
        await registered();
      };
      const { programs, prefs } = scenarioLaunch(scenario, {
        root: REPO,
        vimmaCtl: ctlBin ? resolve(ctlBin) : null,
      });
      let run: UpdateRun | null = null;
      let sessionBuild: Build = build as Build;
      let install = "";
      if (scenario.update) {
        run = await (updateRun ??= startUpdateRun());
        install = run.newInstall(scenario.update.updater, join(updateWork(), "vimma"));
        // The updater replaces the install's files and execs the browser again in the same
        // process (nsUpdateDriver.cpp, updater.cpp: execv on Linux), so the harness keeps its pid
        // and the environment carries over.
        sessionBuild = { binary: join(install, "vimma"), env: updateEnv(install) };
        Object.assign(prefs, updatePrefs(run.testKey, `${run.host.origin}/update.xml`));
      }
      const caFile = run?.caFile;
      const session = await launch({
        build: sessionBuild,
        onProfile: caFile ? (p) => trustCa(p, caFile) : undefined,
        xvfb: mode === "xvfb",
        headless: mode === "headless",
        keep: values.keep,
        prefs,
        programs,
        fontconfig: scenarioFontconfig(),
        // The D-Bus remote vimma-open forwards over needs a session bus (Linux only).
        sessionBus: scenario.steps.some((s) => s.external !== undefined),
        discoveryTimeoutMs,
        signal,
        // registered before the browser starts, so SIGINT during the launch cleans it up
        onTeardown: (t) => {
          registered = t;
          cleanups.push(t);
        },
        log: (line) => console.log(`        ${line}`),
      }).catch(async (e) => {
        await teardown();
        throw e;
      });
      const ctl = new Ctl({ bin: ctlBin, profile: session.profile, signal });
      try {
        await ctl.ready();
      } catch (e) {
        await teardown();
        throw e;
      }
      const killTeardown = teardown;
      // Quit with ctrl+q first (quit observers remove the discovery file); signals stay the
      // fallback, and the only way out once the scenario's deadline has fired.
      const quitThenTeardown = async () => {
        let problem: string | null = null;
        // A browser that died on its own (MOZ_CRASH ends in SIGSEGV) says why on stderr only.
        const died = session.child.signalCode;
        if (died) problem = `the browser died (${died}); its last output:\n${session.stderrTail()}`;
        if (!signal.aborted && !died) {
          const clean = await quitBrowser({ ctl, child: session.child });
          if (!clean) console.log("        ctrl+q did not quit the browser; signalling it");
          else if (existsSync(join(session.profile, DISCOVERY_FILE)))
            problem = `the browser quit with ctrl+q but left ${DISCOVERY_FILE} behind`;
        }
        await killTeardown();
        // e.g. the content sandbox refusing VimmaChild (npm start's read_path_whitelist)
        const failed = session.loadFailure();
        if (failed) problem = `the browser logged "${failed}"`;
        if (problem) throw new Error(problem);
      };
      const screenshot = async (name: string) => {
        if (mode === "headless") {
          console.log(`        screenshot ${name}: skipped: headless, nothing to capture`);
          return;
        }
        if (!session.display) {
          throw new Error(
            "screenshots need the harness's own Xvfb: run with --xvfb (or without DISPLAY)",
          );
        }
        const image = await capture(session.display.fbFile);
        const result = checkBaseline({
          name,
          image,
          baselineDir: values.baselines,
          outDir: values.out,
          update: values["update-baselines"],
        });
        console.log(`        screenshot ${name}: ${result.status}: ${result.message}`);
        if (result.status === "updated") rewritten.push(name);
        // runSteps goes on and fails the scenario at its end (issue #953)
        return shotFailure(result);
      };
      const stepCtl = {
        state: () => ctl.state(),
        sendKeys: (keys: string) => ctl.sendKeys(keys),
        open: (url: string) => ctl.open(fixtureUrl(url, pages?.base ?? null)),
      };
      // A `restart` step: quit the way a user does (ctrl+q, so SessionStore writes the session
      // and the quit observers remove the discovery file), then start again on the profile.
      // `restart: "kill"` instead crashes it: once SessionStore's recovery file has settled,
      // SIGKILL to the browser's pid (no quit observers, so the discovery file stays), then a
      // start on the same profile that ignores the dead browser's discovery file.
      const restart = async (how: "quit" | "kill") => {
        if (how === "kill") {
          await waitForSessionSaved(session.profile);
          const pid = await crashBrowser(session.child);
          await session.relaunch({ stalePid: pid });
          await ctl.ready();
          return;
        }
        if (!(await quitBrowser({ ctl, child: session.child }))) {
          throw new Error("ctrl+q did not quit the browser");
        }
        if (existsSync(join(session.profile, DISCOVERY_FILE))) {
          throw new Error(`the browser quit with ctrl+q but left ${DISCOVERY_FILE} behind`);
        }
        await session.relaunch();
        await ctl.ready();
      };
      // The agent steps' connections (docs/specs/vimma-mcp.md, sub-PR 2b), closed before the quit.
      const sessions = new ControlSessions({ profile: session.profile, bin: ctlBin, signal });
      const control = {
        hold: () => sessions.hold(),
        held: {
          state: () => sessions.held.state(),
          sendKeys: (keys: string) => sessions.held.sendKeys(keys),
          open: (url: string) => sessions.held.open(fixtureUrl(url, pages?.base ?? null)),
        },
        agentSend: (spec: any) => {
          const url = spec.args?.url;
          const args =
            typeof url === "string"
              ? { ...spec.args, url: fixtureUrl(url, pages?.base ?? null) }
              : spec.args;
          sessions.agentSend({ ...spec, args });
        },
        agentResult: (name: string) => sessions.agentResult(name),
        ctlSpawn: (args: string[], as: string) => sessions.ctlSpawn(args, as),
        ctlResult: (name: string) => sessions.ctlResult(name),
        mcpSend: (spec: any) =>
          sessions.mcpSend({ ...spec, ...(spec.params ? { params: fixtures(spec.params) } : {}) }),
        mcpResult: (name: string) => sessions.mcpResult(name),
        // vimma-open run as another program runs it; its `vimma` is the build on this profile.
        external: async (args: string[]) => {
          const wrapper = join(session.profile, ".e2e-vimma");
          const binary = sessionBuild.binary;
          writeFileSync(wrapper, externalWrapper(binary, session.profile), { mode: 0o700 });
          await runVimmaOpen(
            args.map((a) => fixtureUrl(a, pages?.base ?? null)),
            { env: { ...session.env(), VIMMA_BIN: wrapper }, signal },
          );
        },
      };
      /** `fixture:` URLs anywhere in an mcp step's params. */
      const fixtures = (v: unknown): any => {
        if (typeof v === "string")
          return v.startsWith("fixture:") ? fixtureUrl(v, pages?.base ?? null) : v;
        if (Array.isArray(v)) return v.map(fixtures);
        if (v && typeof v === "object") {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixtures(x)]));
        }
        return v;
      };
      const teardownAll = async () => {
        const mcp = await sessions.mcpClose();
        sessions.close();
        await quitThenTeardown();
        if (mcp && !mcp.stdoutClean) {
          throw new Error("vimma-ctl mcp wrote something other than MCP messages on stdout");
        }
      };
      const since = run?.host.marRequests() ?? 0;
      const update = run
        ? {
            serve: async (spec: UpdateServe) => (run as UpdateRun).serve(spec),
            install: async () =>
              installState({
                install,
                profile: session.profile,
                run: run as UpdateRun,
                since,
              }),
          }
        : undefined;
      return {
        ctl: stepCtl,
        screenshot,
        restart,
        control,
        update,
        profile: session.profile,
        text: (t: string) => fixtureText(t, pages?.base ?? null),
        teardown: teardownAll,
      };
    };

    const results = await runScenarios(scenarios, {
      startSession,
      budgetMs,
      runPending: values["run-pending"],
      log: (line) => console.log(line),
    });
    const report = formatReport(results);
    console.log(`\n${report}`);
    if (values["report-json"]) {
      writeFileSync(values["report-json"], `${JSON.stringify(reportJson(results), null, 2)}\n`);
    }
    if (process.env.GITHUB_ACTIONS) {
      for (const line of githubAnnotations(results)) console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### e2e scenarios\n\n\`\`\`\n${report}\n\`\`\`\n`,
        );
      }
    }
    if (rewritten.length) {
      console.log(
        `\nBaselines rewritten: ${rewritten.join(", ")}. Check them by eye and commit them with ` +
          "a commit body saying why (CONTRIBUTING.md: never change a baseline without one).",
      );
    }
    return exitCode(results);
  } finally {
    await cleanupAll();
    await pages?.close();
  }
}

function readHelp() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const doc = /\/\*\*([^]*?)\*\//.exec(src)?.[1] ?? "";
  return doc
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`e2e: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}

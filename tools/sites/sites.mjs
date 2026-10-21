#!/usr/bin/env node
/**
 * Site compatibility (docs/specs/site-compat.md): loads each site of tools/sites/sites.json once
 * in a real Vimma build under its own Xvfb, a fresh profile per site, drives it with vimma-ctl
 * and reads the page over the DevTools protocol. Writes results.json, report.md and report.html
 * (with screenshots/) to the output directory. A report, not a gate: never run on PRs.
 *
 *   npm run sites                               # every site, the default build
 *   npm run sites -- --filter github            # ids or names containing the text (a,b: either)
 *   npm run sites -- --artifact                 # engine/obj-artifact (ADR-010)
 *   npm run sites -- --build path/to/vimma | --tarball vimma-*.tar.xz
 *   npm run sites -- --out dir                  # default site-compat-output/
 *   npm run sites -- --pref name=value          # an extra profile pref (repeatable)
 *   npm run sites -- --site-timeout 180         # seconds per site
 *   npm run sites -- --retry-blocked            # load blocked sites once more at the end
 *   npm run sites -- --offline                  # the snapshot gate: no network (see below)
 *   npm run sites -- --record wikipedia,mdn     # record snapshots (into <out>/snapshots/)
 *   npm run sites -- --record mdn=http://127.0.0.1:8000/x.html   # from a saved copy instead
 *
 * --retry-blocked is for the nightly hosted runner (spec, decision 11). From a home network every
 * extra visit to a site that already shows a bot check makes the next one more likely.
 *
 * --offline replays the recorded pages in tests/e2e/fixtures/sites/ (snapshots.json) from a page
 * server on 127.0.0.1, with every other host unreachable, and runs every check but shortcuts.
 * It exits 1 when a check that passed on the recording does not pass now (snapshot.mjs): e2e.yml
 * runs it on every pull request. Its default --out is site-compat-offline/. --record loads live
 * pages (only sites whose licence allows a committed copy) and checks each snapshot before it
 * writes it; review it before copying it into the fixtures.
 *
 * Exit 0 when the report was written, whatever the sites did (with --offline: and the gate
 * passed); 1 when the harness failed; 2 on usage errors.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Ctl, findVimmaCtl } from "../e2e/driver.mjs";
import { findBuild, launch, unpackTarball } from "../e2e/launcher.mjs";
import { startPageServer } from "../e2e/pages.mjs";
import { encodePng } from "../e2e/png.mjs";
import { capture } from "../e2e/screenshot.mjs";
import { recordSnapshot, runSite } from "./checks.mjs";
import { Rdp } from "./rdp.mjs";
import { renderHtml, renderMarkdown } from "./report.mjs";
import { completeChecks, exitCode, mergeRetry, retryTargets, siteStatus } from "./results.mjs";
import { filterSites, validateSites } from "./site-list.mjs";
import {
  finishSnapshot,
  offlineSites,
  recordable,
  renderGate,
  snapshotGate,
  validateManifest,
  verifySnapshot,
} from "./snapshot.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The DevTools server on, without its "allow incoming connection?" prompt (spec, decision 3). */
export const DEVTOOLS_PREFS = Object.freeze({
  "devtools.debugger.remote-enabled": true,
  "devtools.chrome.enabled": true,
  "devtools.debugger.prompt-connection": false,
});

/** The recorded pages the offline run replays (snapshot.mjs). */
export const SNAPSHOT_DIR = join(REPO, "tests/e2e/fixtures/sites");

/**
 * An offline run reaches only 127.0.0.1: every other host goes to a proxy on a port where
 * nothing listens, so a reference the sanitiser and the snapshot's policy both missed fails
 * instead of reaching the network. A loopback address never goes through the proxy
 * (allow_hijacking_localhost off), so the page server is reached directly.
 */
export const OFFLINE_PREFS = Object.freeze({
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1",
  "network.proxy.http_port": 1,
  "network.proxy.ssl": "127.0.0.1",
  "network.proxy.ssl_port": 1,
  "network.proxy.socks": "",
  "network.proxy.allow_hijacking_localhost": false,
  "network.dns.disablePrefetch": true,
  "network.prefetch-next": false,
  "network.predictor.enabled": false,
  // WebRTC's UDP traffic does not go through the proxy.
  "media.peerconnection.enabled": false,
});

const OPTIONS = /** @type {const} */ ({
  filter: { type: "string" },
  build: { type: "string" },
  artifact: { type: "boolean", default: false },
  tarball: { type: "string" },
  "vimma-ctl": { type: "string" },
  out: { type: "string" },
  sites: { type: "string", default: join(REPO, "tools/sites/sites.json") },
  pref: { type: "string", multiple: true, default: [] },
  "site-timeout": { type: "string", default: "180" },
  keep: { type: "boolean", default: false },
  "retry-blocked": { type: "boolean", default: false },
  offline: { type: "boolean", default: false },
  record: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
});

/** @param {string} message */
function usage(message) {
  process.stderr.write(`sites: ${message}\nSee the comment at the top of tools/sites/sites.mjs.\n`);
  process.exit(2);
}

/**
 * `name=value` → a pref; true/false and integers as such.
 * @param {string} text
 * @returns {[string, boolean | number | string]}
 */
export function parsePref(text) {
  const i = text.indexOf("=");
  if (i <= 0) throw new Error(`--pref wants name=value, got "${text}"`);
  const name = text.slice(0, i);
  const raw = text.slice(i + 1);
  if (raw === "true" || raw === "false") return [name, raw === "true"];
  if (/^-?\d+$/.test(raw)) return [name, Number(raw)];
  return [name, raw];
}

/** @param {string} path */
async function connectRdp(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return /** @type {Rdp} */ (await Rdp.connect(path, { timeoutMs: 5000 }));
      } catch (e) {
        if (Date.now() >= deadline) throw e;
      }
    } else if (Date.now() >= deadline) {
      throw new Error(`no DevTools server socket at ${path} (devtools prefs or the flag ignored?)`);
    }
    await sleep(100);
  }
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, allowPositionals: false }));
  } catch (e) {
    return usage(/** @type {Error} */ (e).message);
  }
  if (values.help) {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const doc = /\/\*\*([^]*?)\*\//.exec(src)?.[1] ?? "";
    process.stdout.write(
      `${doc
        .split("\n")
        .map((l) => l.replace(/^\s*\* ?/, ""))
        .join("\n")
        .trim()}\n`,
    );
    return 0;
  }
  if ([values.build, values.artifact || undefined, values.tarball].filter(Boolean).length > 1)
    return usage("pass at most one of --build, --artifact, --tarball");
  const siteTimeoutMs = Number(values["site-timeout"]) * 1000;
  if (!(siteTimeoutMs > 0)) return usage("--site-timeout is seconds > 0");
  /** @type {Record<string, boolean | number | string>} */
  const extraPrefs = {};
  try {
    for (const p of values.pref) {
      const [k, v] = parsePref(p);
      extraPrefs[k] = v;
    }
  } catch (e) {
    return usage(/** @type {Error} */ (e).message);
  }
  const list = JSON.parse(readFileSync(values.sites, "utf8"));
  const problems = validateSites(list);
  if (problems.length) return usage(`${values.sites}:\n  ${problems.join("\n  ")}`);
  const offline = values.offline;
  if (offline && (values.record || values["retry-blocked"]))
    return usage("--offline runs no live site: no --record or --retry-blocked with it");
  if (values.record && values["retry-blocked"]) return usage("--record takes no --retry-blocked");
  /** @type {Array<{ id: string, url: string }>} */
  const recordings = [];
  for (const item of (values.record ?? "").split(",").filter((x) => x.trim())) {
    const [id = "", from] = item.trim().split(/=(.*)/s);
    const site = list.find((/** @type {any} */ s) => s.id === id);
    if (!site) return usage(`--record ${id}: not in ${values.sites}`);
    if (!recordable(id))
      return usage(`--record ${id}: its licence does not allow a committed copy (snapshot.mjs)`);
    recordings.push({ id, url: from || site.url });
  }
  if (values.record !== undefined && !recordings.length) return usage("--record wants site ids");
  /** @type {import("./snapshot.mjs").SnapshotEntry[]} */
  let manifest = [];
  /** @type {Awaited<ReturnType<typeof startPageServer>> | null} */
  let server = null;
  let sites = filterSites(list, values.filter);
  if (offline) {
    manifest = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "snapshots.json"), "utf8"));
    const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".html"));
    const bad = validateManifest(manifest, list, files);
    if (bad.length) return usage(`${SNAPSHOT_DIR}/snapshots.json:\n  ${bad.join("\n  ")}`);
    manifest = filterSites(
      manifest.map((e) => ({
        ...e,
        name: list.find((/** @type {any} */ s) => s.id === e.id).name,
      })),
      values.filter,
    );
    server = await startPageServer(SNAPSHOT_DIR);
    sites = offlineSites(manifest, list, server.base);
  }
  if (!sites.length) return usage(`no site matches --filter ${values.filter}`);

  const out = values.out ?? join(REPO, offline ? "site-compat-offline" : "site-compat-output");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "screenshots"), { recursive: true });

  /** @type {Array<() => Promise<void>>} */
  const cleanups = [];
  if (server) cleanups.push(/** @type {NonNullable<typeof server>} */ (server).close);
  const cleanupAll = async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  };
  for (const [sig, code] of /** @type {const} */ ([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ])) {
    process.once(sig, () => {
      process.stderr.write(`\nsites: ${sig}, cleaning up\n`);
      cleanupAll().finally(() => process.exit(code));
    });
  }

  /** @type {import("./results.mjs").Run} */
  const run = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    network: process.env.GITHUB_ACTIONS ? "github-hosted" : "local",
    build: "",
    commit: gitCommit(),
    filter: values.filter?.trim() || null,
    ...(offline ? { offline: true } : {}),
    sites: [],
    harnessError: null,
  };
  try {
    /** @type {import("../e2e/launcher.mjs").Build} */
    let build;
    if (values.tarball) {
      const dir = mkdtempSync(join(tmpdir(), "vimma-sites-build-"));
      cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
      build = unpackTarball(values.tarball, dir);
    } else {
      build = findBuild({ build: values.build, artifact: values.artifact, env: process.env });
    }
    const ctlBin = findVimmaCtl({ flag: values["vimma-ctl"], env: process.env });
    run.build = build.binary;
    console.log(`build: ${build.binary}\nvimma-ctl: ${ctlBin}\nsites: ${sites.length}`);

    /**
     * One visit: a fresh profile and browser (decision 3). Screenshots are named after `prefix`.
     * `body` runs the checks by default; --record takes a snapshot instead.
     * @param {import("./site-list.mjs").Site} site
     * @param {string} prefix
     * @param {(ctx: import("./checks.mjs").Context, result: import("./results.mjs").SiteResult)
     *   => Promise<unknown>} [body]
     */
    const visit = async (
      site,
      prefix,
      body = (ctx, result) => runSite(site, ctx, result, { offline }),
    ) => {
      console.log(`\n${prefix}: ${site.url}`);
      const started = Date.now();
      /** @type {import("./results.mjs").SiteResult} */
      const result = {
        id: site.id,
        name: site.name,
        url: site.url,
        status: "error",
        checks: [],
        latency: {},
        screenshots: [],
        durationMs: 0,
      };
      // Short: a Unix socket path must fit in 107 bytes.
      const sockDir = mkdtempSync(join(tmpdir(), "vsc-"));
      const sock = join(sockDir, "rdp.sock");
      const abort = new AbortController();
      /** @type {Rdp | null} */
      let rdp = null;
      /** @type {(() => Promise<void>) | null} */
      let teardown = null;
      let shots = 0;
      const timer = setTimeout(() => abort.abort(), siteTimeoutMs);
      try {
        const session = await launch({
          build,
          xvfb: true, // always: screenshots, and a clipboard that is not the desktop's
          keep: values.keep,
          prefs: { ...DEVTOOLS_PREFS, ...(offline ? OFFLINE_PREFS : {}), ...extraPrefs },
          args: ["--start-debugger-server", sock],
          signal: abort.signal,
          onTeardown: (t) => {
            teardown = t;
            cleanups.push(t);
          },
          log: (line) => console.log(`    ${line}`),
        });
        const ctl = new Ctl({ bin: ctlBin, profile: session.profile, signal: abort.signal });
        await ctl.ready();
        rdp = await connectRdp(sock);
        const parent = await rdp.parentConsole();
        const display = session.display;
        const screenshot = async (/** @type {string} */ label) => {
          if (!display) return null;
          const file = `${prefix}-${++shots}-${label}.png`;
          writeFileSync(join(out, "screenshots", file), encodePng(await capture(display.fbFile)));
          return file;
        };
        const timedOut = new Promise((_, reject) =>
          abort.signal.addEventListener("abort", () =>
            reject(new Error(`timed out after ${siteTimeoutMs / 1000} s`)),
          ),
        );
        await Promise.race([
          body({ ctl, rdp, parent, screenshot, log: (l) => console.log(l) }, result),
          timedOut,
        ]);
        const failed = session.loadFailure();
        if (failed) result.error = `the browser logged "${failed}"`;
      } catch (e) {
        result.error = /** @type {Error} */ (e).message;
        console.log(`    error: ${result.error}`);
      } finally {
        clearTimeout(timer);
        rdp?.close();
        if (teardown) {
          const t = /** @type {() => Promise<void>} */ (teardown);
          const i = cleanups.indexOf(t);
          if (i >= 0) cleanups.splice(i, 1);
          await t().catch(() => {});
        }
        rmSync(sockDir, { recursive: true, force: true });
      }
      if (result.error) {
        result.checks = completeChecks(result.checks, `harness error: ${result.error}`);
        result.status = siteStatus(result);
      }
      result.durationMs = Date.now() - started;
      console.log(`  → ${result.status} (${Math.round(result.durationMs / 1000)} s)`);
      return result;
    };

    if (recordings.length) {
      mkdirSync(join(out, "snapshots"), { recursive: true });
      for (const { id, url } of recordings) {
        const site = { ...list.find((/** @type {any} */ s) => s.id === id), url };
        const result = await visit(site, `${id}.record`, async (ctx, r) => {
          const snap = await recordSnapshot(url, ctx);
          const html = finishSnapshot(snap.html);
          const bad = verifySnapshot(html);
          if (bad.length) throw new Error(`the snapshot fails verifySnapshot: ${bad.join("; ")}`);
          const file = join(out, "snapshots", `${id}.html`);
          writeFileSync(file, html);
          r.title = snap.title;
          r.checks = [];
          r.status = "ok";
          console.log(
            `    ${file}: ${Math.round(html.length / 1024)} kB, CSS ${Math.round(snap.cssBytes / 1024)} kB` +
              (snap.skippedSheets ? `, ${snap.skippedSheets} unreadable stylesheets left out` : ""),
          );
        });
        if (result.error) throw new Error(`--record ${id}: ${result.error}`);
      }
      console.log(
        `\nRecorded into ${join(out, "snapshots")}. Review each, then copy it into ` +
          "tests/e2e/fixtures/sites/ with its snapshots.json entry and README attribution.",
      );
      return 0;
    }
    for (const site of sites) run.sites.push(await visit(site, site.id));
    if (values["retry-blocked"]) {
      for (const first of retryTargets(run.sites)) {
        const site = sites.find((s) => s.id === first.id);
        if (!site) continue;
        const second = await visit(site, `${site.id}.retry`);
        run.sites[run.sites.indexOf(first)] = mergeRetry(first, second);
      }
    }
  } catch (e) {
    run.harnessError = /** @type {Error} */ (e).message;
    process.stderr.write(`sites: ${run.harnessError}\n`);
  } finally {
    await cleanupAll();
  }
  run.finishedAt = new Date().toISOString();
  const gate = offline ? snapshotGate(run, manifest) : null;
  const md = renderMarkdown(run) + (gate ? `\n${renderGate(gate)}` : "");
  writeFileSync(join(out, "results.json"), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(out, "report.md"), md);
  writeFileSync(join(out, "report.html"), renderHtml(run));
  console.log(`\n${md}\nReport: ${join(out, "report.html")}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  return gate ? Math.max(gate.exit, exitCode(run)) : exitCode(run);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`sites: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The update rehearsal (docs/specs/m6a-updater.md, Tests, "Security rehearsal", decision 23), for
 * .github/workflows/update-rehearsal.yml: an install of the previous release, taken from its
 * GitHub Release as a user would, must find the release updates.vimma.dev offers, stage it with
 * Firefox's updater and come back on it after a restart. It checks what a person checked by hand
 * for 0.1.17 to 0.1.18 (docs/runbook/ci-update-keys-and-update-host.md, "Checking an update on
 * real installs"), with no person acting.
 *
 *   rehearsal.ts plan --repo owner/name [--releases FILE]
 *       what a run would rehearse, from the served manifest and the published releases
 *   rehearsal.ts run --repo owner/name --out DIR [--releases FILE] [--timeout-minutes N]
 *       downloads the previous release's tarball into DIR, checks it against its SHA256SUMS,
 *       starts it under a new Xvfb with a new profile, HOME and session bus, and waits for the
 *       update; DIR/logs keeps the browser's output and the updater's log
 *   --releases FILE: the output of `gh api repos/R/releases --paginate --slurp`, read instead of
 *   running gh, so that the job token is not in the environment of the downloaded browser
 *
 * Both exit 0 with "nothing to rehearse" when the manifest offers nothing (an update pulled,
 * decision 22) or a release was published too recently for its manifest; the workflow runs only
 * while UPDATES_ENABLED is true, so a host that serves no manifest fails. Anything else that
 * keeps the install from taking the offered release exits 1. It reads only public files and
 * needs no secret: the GitHub token gh uses lists the releases. Node built-ins and this repository's files only, so the job installs
 * nothing. The summary goes to stdout only; the workflow copies it into the job summary.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  MAX_MANIFEST_CHARS,
  parseManifest,
  verifyManifest,
} from "../../packages/vimma-core/src/updates/updates.mjs";
import { UPDATE_KEYS } from "../../packages/vimma-core/src/updates/update-keys.mjs";
import { iniValue, lastBuildId } from "../e2e/update-host.ts";
import { killTree, startSessionBus, startXvfb } from "../e2e/launcher.ts";
import {
  CHANNEL,
  MANIFEST_PATH,
  TARGET,
  assetNames,
  ghRead,
  parseSums,
  previousRelease,
} from "./manifest.ts";
import type { PinnedKey } from "../../packages/vimma-core/src/updates/updates.mjs";
import type { ChildProcess } from "node:child_process";

/** Where the browser's pref `vimma.update.url` leads on the release channel's Linux build. */
export const MANIFEST_URL = `https://updates.vimma.dev/${MANIFEST_PATH.replace(/^public\//, "")}`;

/**
 * How long after a release is published its manifest may still be missing: update-publish.yml
 * starts on the publish and takes minutes, and a scheduled run can land in between. Past this,
 * a manifest that still offers an older release is a broken pipeline.
 */
export const GRACE_HOURS = 6;

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The first release whose tarball carries Firefox's updater (spec m6a-updater, sub-PR 4). */
export const FIRST_UPDATER_RELEASE = "v0.1.17";

export type PublishedRelease = { tag: string; publishedAt: string };

export type Plan =
  | { kind: "nothing"; reason: string }
  | {
      kind: "rehearse";
      /** the release installed, a tag */
      from: string;
      /** the release offered */
      to: { version: string; buildId: string; appVersion: string; urgent: boolean; marUrl: string };
      serial: string;
      key: string;
    };

export type Result =
  | { kind: "nothing"; reason: string }
  | { kind: "passed"; from: string; to: string; steps: string[] }
  | { kind: "failed"; from?: string; to?: string; problem: string };

function need(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(why);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The published releases (not drafts, not pre-releases such as the rolling `nightly`) with a
 * vX.Y.Z tag, from `gh api repos/R/releases --paginate --slurp`. Any other shape throws, so a
 * broken response is never read as "no releases".
 */
export function publishedReleases(pages: unknown): PublishedRelease[] {
  need(Array.isArray(pages), "not a list of pages");
  const out: PublishedRelease[] = [];
  for (const page of pages) {
    need(Array.isArray(page), "a page that is not a list of releases");
    for (const r of page) {
      need(
        isObject(r) &&
          typeof r.tag_name === "string" &&
          typeof r.draft === "boolean" &&
          typeof r.prerelease === "boolean",
        "a release without tag_name, draft and prerelease",
      );
      if (r.draft || r.prerelease || !TAG.test(r.tag_name)) continue;
      need(typeof r.published_at === "string", `${r.tag_name} has no published_at`);
      out.push({ tag: r.tag_name, publishedAt: r.published_at });
    }
  }
  return out;
}

function tagOrder(a: string, b: string) {
  const pa = TAG.exec(a)?.slice(1).map(Number) ?? [];
  const pb = TAG.exec(b)?.slice(1).map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * What to rehearse: the served manifest checked as the browser checks it (a pinned key, the
 * release channel, the Linux target), and its offer against the published releases. Nothing to
 * rehearse when no manifest is served, when it offers nothing, or when no older release exists;
 * a throw for a manifest the browser would refuse, an offer that is not a published release or
 * has no MAR, and a manifest still offering an older release GRACE_HOURS after a newer one was
 * published.
 * @param input `manifest`: the served text, or null when the host answers 404
 */
export async function planRehearsal({
  manifest,
  releases,
  keys,
  now,
}: {
  manifest: string | null;
  releases: readonly PublishedRelease[];
  keys: readonly PinnedKey[];
  now: Date;
}): Promise<Plan> {
  const newest = [...releases].sort((a, b) => tagOrder(b.tag, a.tag))[0];
  const hoursSince = (r: PublishedRelease) =>
    Math.floor((now.getTime() - Date.parse(r.publishedAt)) / 3_600_000);
  if (manifest === null) {
    // The job runs only while UPDATES_ENABLED is true, so no manifest past the grace hours is an
    // outage or a broken publish that leaves every install behind.
    if (!newest) {
      return {
        kind: "nothing",
        reason: `${MANIFEST_URL} serves no manifest and no release is published`,
      };
    }
    if (hoursSince(newest) < GRACE_HOURS) {
      return {
        kind: "nothing",
        reason: `${MANIFEST_URL} serves no manifest and ${newest.tag} was published ${hoursSince(newest)} h ago`,
      };
    }
    throw new Error(
      `${MANIFEST_URL} serves no manifest, but ${newest.tag} was published ${hoursSince(newest)} h ago`,
    );
  }
  const verified = await verifyManifest(manifest, keys, globalThis.crypto.subtle);
  need(
    verified.ok,
    `the served manifest fails verification: ${verified.ok ? "" : verified.reason}`,
  );
  const parsed = parseManifest(verified.body);
  need(parsed.ok, `the served manifest: ${parsed.ok ? "" : parsed.reason}`);
  const m = parsed.manifest;
  need(
    m.channel === CHANNEL && m.target === TARGET,
    `the served manifest is for ${m.channel} ${m.target}, not ${CHANNEL} ${TARGET}`,
  );
  const u = m.update;
  if (!u) return { kind: "nothing", reason: `the manifest offers no update (serial ${m.serial})` };
  const tags = releases.map((r) => r.tag);
  const offered = `v${u.displayVersion}`;
  need(
    tags.includes(offered),
    `the manifest offers ${u.displayVersion}, which is not a published release (the newest is ${newest?.tag ?? "none"})`,
  );
  if (newest && tagOrder(newest.tag, offered) > 0) {
    const hours = hoursSince(newest);
    if (hours < GRACE_HOURS) {
      return {
        kind: "nothing",
        reason:
          `${newest.tag} was published ${hours} h ago and the manifest still offers ` +
          `${u.displayVersion}; update-publish.yml may not have run yet`,
      };
    }
    throw new Error(
      `${newest.tag} was published ${hours} h ago, but the manifest still offers ${u.displayVersion}`,
    );
  }
  need(
    u.marUrl,
    `the manifest offers ${u.displayVersion} without a MAR (<patch>), so a tarball cannot stage it`,
  );
  const from = previousRelease(tags, offered);
  if (!from) return { kind: "nothing", reason: `no published release is older than ${offered}` };
  return {
    kind: "rehearse",
    from,
    to: {
      version: u.displayVersion,
      buildId: u.buildId,
      appVersion: u.appVersion,
      urgent: u.urgent,
      marUrl: u.marUrl,
    },
    serial: m.serial,
    key: verified.key.id,
  };
}

/**
 * The result for a tarball without Firefox's updater: nothing to rehearse for a release from
 * before it shipped, a failure for any later one, whose release.yml build lost it.
 */
export function missingUpdater(from: string): Result {
  if (tagOrder(from, FIRST_UPDATER_RELEASE) < 0) {
    return {
      kind: "nothing",
      reason: `${from}'s tarball predates Firefox's updater (first in ${FIRST_UPDATER_RELEASE})`,
    };
  }
  return {
    kind: "failed",
    from,
    problem: `${from}'s tarball has no updater or update-settings.ini`,
  };
}

/**
 * Whether the control `state`'s update field (docs/specs/m6a-updater.md, decision 41) shows the
 * offered build staged; `fail` for what more waiting cannot change. An unreachable host is
 * waited out: the browser checks again (decision 27).
 */
export function progress(
  update: unknown,
  want: { version: string; buildId: string },
): { done: boolean; fail?: string } {
  if (!isObject(update)) return { done: false, fail: "the control state has no update field" };
  if (update.installType !== null && update.installType !== "tarball") {
    return { done: false, fail: `the install is ${String(update.installType)}, not a tarball` };
  }
  if (update.outcome === "refused") {
    return { done: false, fail: "the browser refused the manifest (outcome refused)" };
  }
  if (update.outcome === "off" || update.outcome === "source" || update.enabled === false) {
    return {
      done: false,
      fail: `updates are off in this install (outcome ${String(update.outcome)})`,
    };
  }
  const offer = update.offer;
  if (update.outcome !== "offer" || !isObject(offer)) return { done: false };
  if (offer.version !== want.version || offer.buildId !== want.buildId) {
    return {
      done: false,
      fail:
        `the browser offers ${String(offer.version)} (build ${String(offer.buildId)}), ` +
        `not ${want.version} (build ${want.buildId})`,
    };
  }
  return update.stage === "staged" ? { done: true } : { done: false };
}

/** The last status the updater wrote to its log (`applied`, `succeeded`, `failed: 19`), or "". */
export function lastStatus(log: string) {
  const statuses = [...log.matchAll(/Writing status to file: (.+)$/gm)];
  return statuses.at(-1)?.[1]?.trim() ?? "";
}

/**
 * What is wrong with a staged update: Firefox's `updates/0/update.status`, the updater's own
 * log (it checks the MAR's signature, channel and version before it writes anything, so
 * `applied` means the shipped updater accepted the release's MAR), and the build in the staging
 * directory `updated/`.
 */
export function stagedProblems({
  status,
  log,
  stagedIni,
  buildId,
}: {
  status: string | null;
  log: string;
  stagedIni: string | null;
  buildId: string;
}) {
  const problems: string[] = [];
  const s = (status ?? "").trim();
  if (s !== "applied")
    problems.push(`updates/0/update.status is \`${s || "missing"}\`, not \`applied\``);
  const l = lastStatus(log);
  if (l !== "applied") problems.push(`the updater's log ends \`${l || "empty"}\`, not \`applied\``);
  if (stagedIni === null) problems.push("updated/application.ini is missing");
  else {
    const staged = iniValue(stagedIni, "App", "BuildID");
    if (staged !== buildId) problems.push(`the staged build is ${staged}, not ${buildId}`);
  }
  return problems;
}

/**
 * What is wrong after the restart that applies the update: the install's application.ini, the
 * build the profile last ran (compatibility.ini) and the updater's last status.
 */
export function appliedProblems({
  installIni,
  compatibility,
  log,
  buildId,
}: {
  installIni: string;
  compatibility: string;
  log: string;
  buildId: string;
}) {
  const problems: string[] = [];
  const installed = iniValue(installIni, "App", "BuildID");
  if (installed !== buildId) {
    problems.push(`the install's application.ini says build ${installed}, not ${buildId}`);
  }
  const ran = lastBuildId(compatibility);
  if (ran !== buildId) problems.push(`the profile last ran build ${ran}, not ${buildId}`);
  const l = lastStatus(log);
  if (l !== "succeeded")
    problems.push(`the updater's log ends \`${l || "empty"}\`, not \`succeeded\``);
  return problems;
}

/** The run's Markdown summary, for the job summary and the log. */
export function summary(result: Result) {
  const head = "## Update rehearsal\n\n";
  switch (result.kind) {
    case "nothing":
      return `${head}Nothing to rehearse: ${result.reason}.\n`;
    case "passed":
      return (
        `${head}${result.from} took ${result.to} from updates.vimma.dev:\n\n` +
        result.steps.map((s) => `- ${s}\n`).join("")
      );
    case "failed":
      return result.from
        ? `${head}Failed: ${result.from} did not take ${result.to}: ${result.problem}\n`
        : `${head}Failed: ${result.problem}\n`;
  }
}

/** Fetches with a few tries for a network failure or a 5xx; a 404 is not retried. */
async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number) {
  const waits = [2000, 4000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status < 500) return res;
      if (attempt >= waits.length) return res;
    } catch (e) {
      if (attempt >= waits.length) throw e;
    }
    await sleep(waits[attempt]);
  }
}

/**
 * The served manifest, or null for a 404. Like the browser's fetch (spec decision 30): no
 * redirects, no cookies, and at most MAX_MANIFEST_CHARS.
 */
async function fetchManifest(url = MANIFEST_URL) {
  const res = await fetchWithRetry(
    url,
    {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    },
    30_000,
  );
  if (res.status === 404) return null;
  need(res.ok, `${url} answered ${res.status}`);
  const text = await res.text();
  need(text.length <= MAX_MANIFEST_CHARS, `${url} is longer than ${MAX_MANIFEST_CHARS} characters`);
  return text;
}

/**
 * A release file, by curl: it streams the file (about 100 MB) to disk, retries, follows
 * GitHub's redirect to its download host over https only, and stops after 10 minutes.
 */
async function download(url: string, path: string) {
  await run("curl", [
    "-fsSL",
    "--retry",
    "3",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--max-time",
    "600",
    "-o",
    path,
    url,
  ]);
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The published releases: from `file` (the output of `gh api repos/R/releases --paginate
 * --slurp`), so the step that runs the downloaded browser need not hold the job token, or else
 * from gh.
 */
async function releasesOf(repo: string, file?: string) {
  if (file) return publishedReleases(JSON.parse(readFileSync(file, "utf8")));
  return ghRead(
    ["api", `repos/${repo}/releases`, "--paginate", "--slurp"],
    "the published releases",
    publishedReleases,
  );
}

export async function plan(
  repo: string,
  { releasesFile, now = new Date() }: { releasesFile?: string; now?: Date } = {},
) {
  const [manifest, releases] = await Promise.all([fetchManifest(), releasesOf(repo, releasesFile)]);
  return planRehearsal({ manifest, releases, keys: UPDATE_KEYS, now });
}

const run = promisify(execFile);
const readOrNull = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** The release's download URL for one of its files. */
const releaseFile = (repo: string, tag: string, name: string) =>
  `https://github.com/${repo}/releases/download/${tag}/${name}`;

/**
 * Installs `from` in `out` and waits for it to take `to`: offer, stage, and apply at the next
 * start. Every process it starts is killed by its own handle before it returns.
 */
async function install(
  plan: Extract<Plan, { kind: "rehearse" }>,
  { repo, out, timeoutMs }: { repo: string; out: string; timeoutMs: number },
): Promise<Result> {
  const { from, to } = plan;
  const fail = (problem: string): Result => ({ kind: "failed", from, to: to.version, problem });
  const dirs = Object.fromEntries(
    ["download", "install", "home", "run", "profile", "logs"].map((d) => [d, join(out, d)]),
  ) as Record<"download" | "install" | "home" | "run" | "profile" | "logs", string>;
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  chmodSync(dirs.run, 0o700);

  const version = TAG.exec(from)?.slice(1).join(".") ?? "";
  const tarball = assetNames(version).tarball ?? "";
  await download(releaseFile(repo, from, "SHA256SUMS"), join(dirs.download, "SHA256SUMS"));
  await download(releaseFile(repo, from, tarball), join(dirs.download, tarball));
  const sums = parseSums(readFileSync(join(dirs.download, "SHA256SUMS"), "utf8"));
  const expected = sums.get(tarball);
  if (!expected) return fail(`${from}'s SHA256SUMS has no line for ${tarball}`);
  if (sha256(join(dirs.download, tarball)) !== expected) {
    return fail(`${tarball} does not match ${from}'s SHA256SUMS`);
  }
  await run("tar", ["-xJf", join(dirs.download, tarball), "-C", dirs.install]);
  const app = join(dirs.install, "vimma");
  if (!existsSync(join(app, "updater")) || !existsSync(join(app, "update-settings.ini"))) {
    const r = missingUpdater(from);
    return r.kind === "failed" ? fail(r.problem) : r;
  }
  // The only pref: the control socket, which this run reads the update state through. No
  // automation or test prefs, so the browser checks and updates as a user's install does.
  writeFileSync(join(dirs.profile, "user.js"), 'user_pref("vimma.control.enabled", true);\n');

  const steps: string[] = [];
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  // The bus's socket path must fit in sockaddr_un (108 bytes), so it lives in a short temp path.
  const busDir = mkdtempSync(join(tmpdir(), "vimma-rehearsal-"));
  chmodSync(busDir, 0o700);
  const display = await startXvfb({ width: 1280, height: 800 });
  const bus = await startSessionBus(busDir).catch(async (e) => {
    await display.stop();
    throw e;
  });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dirs.home,
    TMPDIR: dirs.run,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
    XDG_DATA_HOME: join(dirs.home, ".local/share"),
    XDG_STATE_HOME: join(dirs.home, ".local/state"),
    XDG_RUNTIME_DIR: dirs.run,
    DISPLAY: display.display,
    GDK_BACKEND: "x11",
    MOZ_ENABLE_WAYLAND: "0",
    DBUS_SESSION_BUS_ADDRESS: bus.address,
    LANG: "C.UTF-8",
    MOZ_CRASHREPORTER_DISABLE: "1",
  };
  let browser: ChildProcess | null = null;
  const start = (name: string) => {
    const log = openSync(join(dirs.logs, name), "a");
    browser = spawn(join(app, "vimma"), ["-no-remote", "-profile", dirs.profile], {
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
  };
  const state = async () => {
    try {
      const { stdout } = await run(
        join(app, "vimma-ctl"),
        ["--profile", dirs.profile, "--timeout", "10", "state", "--json"],
        { env, timeout: 20_000 },
      );
      return JSON.parse(stdout);
    } catch {
      return null; // not up yet, or between the quit and the start
    }
  };
  try {
    start("browser.log");
    const deadline = started + timeoutMs;
    let offered = false;
    let last: unknown = null;
    for (;;) {
      const s = await state();
      if (s) {
        last = s.update;
        if (!offered && isObject(s.update) && s.update.outcome === "offer") {
          offered = true;
          steps.push(
            `offered ${to.version}${to.urgent ? " (security)" : ""} after ${seconds()} s ` +
              `(manifest serial ${plan.serial}, key ${plan.key})`,
          );
        }
        const p = progress(s.update, to);
        if (p.done) break;
        if (p.fail) return fail(p.fail);
      }
      if (Date.now() > deadline) {
        return fail(
          `not staged within ${timeoutMs / 60_000} min; the last update state: ${JSON.stringify(last)}`,
        );
      }
      await sleep(5000);
    }
    const updateLog = join(app, "updates", "last-update.log");
    const staged = stagedProblems({
      status: readOrNull(join(app, "updates", "0", "update.status")),
      log: readOrNull(updateLog) ?? "",
      stagedIni: readOrNull(join(app, "updated", "application.ini")),
      buildId: to.buildId,
    });
    if (staged.length) return fail(staged.join("; "));
    steps.push(`staged after ${seconds()} s: the updater accepted the MAR (build ${to.buildId})`);

    // SIGTERM is Firefox's quit (nsAppShell); the start after it applies the staged update.
    if (browser) await killTree(browser, { graceMs: 30_000 });
    start("browser-restart.log");
    const restartDeadline = Date.now() + 180_000;
    while (!(await state())) {
      if (Date.now() > restartDeadline)
        return fail("the browser did not come back after the restart");
      await sleep(2000);
    }
    const applied = appliedProblems({
      installIni: readOrNull(join(app, "application.ini")) ?? "",
      compatibility: readOrNull(join(dirs.profile, "compatibility.ini")) ?? "",
      log: readOrNull(updateLog) ?? "",
      buildId: to.buildId,
    });
    if (applied.length) return fail(applied.join("; "));
    steps.push(
      `applied at the next start after ${seconds()} s: the install and the profile run build ` +
        `${to.buildId} (Firefox ${to.appVersion})`,
    );
    return { kind: "passed", from, to: to.version, steps };
  } finally {
    if (browser) await killTree(browser, { graceMs: 10_000 });
    await bus.stop();
    await display.stop();
    rmSync(busDir, { recursive: true, force: true });
    for (const f of ["last-update.log", "backup-update.log"]) {
      const p = join(app, "updates", f);
      if (existsSync(p)) copyFileSync(p, join(dirs.logs, f));
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      releases: { type: "string" },
      out: { type: "string" },
      "timeout-minutes": { type: "string", default: "15" },
    },
  });
  need(values.repo, `${command ?? "rehearsal"} needs --repo owner/name`);
  const repo = values.repo;
  let result: Result;
  let rehearsal: Plan | null = null;
  try {
    rehearsal = await plan(repo, { releasesFile: values.releases });
    if (command === "plan") {
      process.stdout.write(`${JSON.stringify(rehearsal, null, 1)}\n`);
      return;
    }
    need(command === "run", "usage: rehearsal.ts plan|run (see the file's header)");
    need(values.out, "run needs --out DIR");
    need(
      !existsSync(values.out) || readdirSync(values.out).length === 0,
      `${values.out} is not empty`,
    );
    const minutes = Number(values["timeout-minutes"]);
    need(Number.isFinite(minutes) && minutes > 0, "--timeout-minutes takes a positive number");
    result =
      rehearsal.kind === "nothing"
        ? rehearsal
        : await install(rehearsal, { repo, out: values.out, timeoutMs: minutes * 60_000 });
  } catch (e) {
    const problem = e instanceof Error ? e.message : String(e);
    result =
      rehearsal?.kind === "rehearse"
        ? { kind: "failed", from: rehearsal.from, to: rehearsal.to.version, problem }
        : { kind: "failed", problem };
  }
  const text = summary(result);
  process.stdout.write(text);
  if (result.kind === "failed") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`rehearsal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

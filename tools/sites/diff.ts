// Night-to-night comparison of site-compatibility runs (docs/specs/site-compat.md, decision 12).
// Pure: compares a run with the previous scheduled run, carries the tracked regressions from one
// night to the next, picks what to do with the rolling `site-compat` issue and renders the
// summary diff and the issue body.
//
// Page titles and check reasons come from live pages and reach a GitHub issue, where Markdown
// renders, `@name` notifies a user and `#123` or a URL links another issue. Every such value goes
// through inertCode; the previous run's files are checked for shape before they are used.
import { md } from "./report.ts";
import { CHECKS } from "./results.ts";

import type { Run, SiteResult, SiteStatus } from "./results.ts";
/** a check that passed in the baseline and fails now */
export interface Regression {
  site: string;
  name: string;
  check: string;
  reason?: string;
  title?: string;
}
/** a regression carried from night to night until it passes */
export interface Tracked {
  site: string;
  check: string;
  /** startedAt of the run that first saw it fail */
  since: string;
  /** the latest failure's reason */
  reason?: string;
  /** whether this run checked it (false: blocked, skipped and so on) */
  checked: boolean;
}
export interface Diff {
  baseline: { startedAt: string; commit: string | null } | null;
  regressions: Regression[];
  tracked: Tracked[];
  fixed: Array<{ site: string; name: string; check: string }>;
  changes: Array<{ site: string; name: string; from: SiteStatus; to: SiteStatus }>;
  added: string[];
  removed: string[];
}
export type IssueAction = "create" | "update" | "close" | "none";

/** Characters of one untrusted value in the issue body. */
export const MAX_TEXT = 160;
/** Entries of one list in the issue body. */
export const MAX_ITEMS = 50;
/** The whole issue body; GitHub's limit is 65 536. */
export const MAX_BODY = 60_000;

const SITE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SITE_STATUSES = new Set(["ok", "fail", "blocked", "consent", "error"]);
const CHECK_STATUSES = new Set(["pass", "fail", "skip", "info"]);
const BLOCK_KINDS = new Set(["bot-check", "consent"]);
const CHECK_IDS = new Set(CHECKS as readonly string[]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

/**
 * One untrusted value as an inline code span, inside which GitHub renders no mention, issue
 * reference, autolink, emphasis or HTML. On one line, with control and format characters
 * (bidirectional overrides among them) replaced, and cut to `max` characters.
 */
export function inertCode(text: unknown, max: number = MAX_TEXT) {
  let s = String(text ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "(none)";
  const chars = [...s];
  if (chars.length > max) s = `${chars.slice(0, max - 1).join("")}…`;
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/**
 * A results.json checked for the shape this module reads, or null with the problems. A filtered
 * run is no baseline: the sites it skipped would look removed.
 * @param o false for the current run, which may be filtered
 */
export function parseRun(
  value: unknown,
  { baseline = true }: { baseline?: boolean } = {},
): { run: Run | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(value)) return { run: null, problems: ["not an object"] };
  if (typeof value.startedAt !== "string" || !ISO_TIME.test(value.startedAt))
    problems.push("startedAt is not a time");
  if (value.commit != null && typeof value.commit !== "string") problems.push("bad commit");
  if (value.filter != null && typeof value.filter !== "string") problems.push("bad filter");
  else if (baseline && value.filter) problems.push("a filtered run (--filter) is no baseline");
  if (!Array.isArray(value.sites)) problems.push("sites is not a list");
  else {
    value.sites.forEach((site, i) => {
      const at = `site ${i}`;
      if (!isObject(site)) return problems.push(`${at}: not an object`);
      if (typeof site.id !== "string" || !SITE_ID.test(site.id)) problems.push(`${at}: bad id`);
      if (typeof site.name !== "string") problems.push(`${at}: bad name`);
      if (typeof site.status !== "string" || !SITE_STATUSES.has(site.status))
        problems.push(`${at}: bad status`);
      if (!optionalString(site.title)) problems.push(`${at}: bad title`);
      if (
        site.block !== undefined &&
        !(
          isObject(site.block) &&
          BLOCK_KINDS.has(String(site.block.kind)) &&
          typeof site.block.reason === "string"
        )
      )
        problems.push(`${at}: bad block`);
      if (!Array.isArray(site.checks)) return problems.push(`${at}: checks is not a list`);
      for (const c of site.checks) {
        if (
          !isObject(c) ||
          !CHECK_IDS.has(String(c.id)) ||
          !CHECK_STATUSES.has(String(c.status)) ||
          !optionalString(c.reason)
        ) {
          problems.push(`${at}: bad check`);
          break;
        }
      }
    });
  }
  return problems.length
    ? { run: null, problems: problems.slice(0, 10) }
    : { run: value as unknown as Run, problems };
}

/** "site/check" → its last pass or fail */
export type Known = Record<string, "pass" | "fail">;

/**
 * A previous run's diff.json: the tracked regressions, the last known status of each check, and
 * whether its chain of comparisons was unbroken. Absent (an artifact from before diff.json):
 * nothing tracked, and an unbroken chain. The wrong shape: nothing, and a broken chain. Entries
 * for checks that no longer exist are dropped.
 */
export function parseState(value: unknown): {
  tracked: Tracked[];
  known: Known;
  complete: boolean;
  problems: string[];
} {
  if (value === undefined) return { tracked: [], known: {}, complete: true, problems: [] };
  const broken = (problem: string) => ({
    tracked: [],
    known: {},
    complete: false,
    problems: [problem],
  });
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.tracked) ||
    typeof value.complete !== "boolean" ||
    !isObject(value.known)
  )
    return broken("diff.json is not version 1 with tracked, known and complete");
  const ok = value.tracked.every(
    (t) =>
      isObject(t) &&
      typeof t.site === "string" &&
      SITE_ID.test(t.site) &&
      typeof t.check === "string" &&
      typeof t.since === "string" &&
      ISO_TIME.test(t.since) &&
      optionalString(t.reason) &&
      typeof t.checked === "boolean",
  );
  if (!ok) return broken("diff.json has a tracked entry of the wrong shape");
  const known: Known = {};
  for (const [k, v] of Object.entries(value.known)) {
    const [site = "", check = "", extra] = k.split("/");
    if (extra === undefined && SITE_ID.test(site) && CHECK_IDS.has(check))
      if (v === "pass" || v === "fail") known[k] = v;
  }
  const tracked = (value.tracked as Tracked[]).filter((t) => CHECK_IDS.has(t.check));
  return { tracked, known, complete: value.complete, problems: [] };
}

const checkOf = (site: SiteResult | undefined, id: string) => site?.checks.find((c) => c.id === id);
const keyOf = (r: { site: string; check: string }) => `${r.site}/${r.check}`;
/** A run that did not visit every listed site: filtered, or stopped by a harness error. */
const isPartial = (run: Run) => Boolean(run.filter || run.harnessError);

/**
 * The last pass or fail of each check, `base` updated with `run`'s results. A check that was
 * skipped (its site blocked, say) keeps its earlier status, so a regression after a blocked night
 * is still seen.
 */
function withStatuses(run: Run | null, base: Known): Known {
  const known: Known = { ...base };
  for (const site of run?.sites ?? [])
    for (const c of site.checks)
      if (c.status === "pass" || c.status === "fail") known[`${site.id}/${c.id}`] = c.status;
  return known;
}

/**
 * The known statuses to keep in this run's diff.json. Sites that left the list are forgotten,
 * unless this run was partial and did not visit them.
 */
export function nextKnown(prev: Run | null, cur: Run, prevKnown: Known): Known {
  const known = withStatuses(cur, withStatuses(prev, prevKnown));
  if (isPartial(cur)) return known;
  const listed = new Set(cur.sites.map((s) => s.id));
  return Object.fromEntries(
    Object.entries(known).filter(([k]) => listed.has(k.slice(0, k.indexOf("/")))),
  );
}

/**
 * @param prev the previous scheduled run, null when there is none to read
 * @param prevTracked the previous run's tracked regressions
 * @param prevKnown the previous run's known statuses
 */
export function compareRuns(
  prev: Run | null,
  cur: Run,
  prevTracked: Tracked[],
  prevKnown: Known = {},
): Diff {
  const before = new Map((prev?.sites ?? []).map((s) => [s.id, s]));
  const now = new Map(cur.sites.map((s) => [s.id, s]));
  const name = (id: string) => now.get(id)?.name ?? id;
  const known = withStatuses(prev, prevKnown);
  const partial = isPartial(cur);

  const regressions: Regression[] = [];
  const fixed: Diff["fixed"] = [];
  const changes: Diff["changes"] = [];
  for (const site of cur.sites) {
    const old = before.get(site.id);
    if (old && old.status !== site.status)
      changes.push({ site: site.id, name: site.name, from: old.status, to: site.status });
    for (const c of site.checks) {
      const was = known[`${site.id}/${c.id}`];
      if (c.status === "fail" && was === "pass")
        regressions.push({
          site: site.id,
          name: site.name,
          check: c.id,
          reason: c.reason,
          title: site.title,
        });
      else if (old && c.status === "pass" && checkOf(old, c.id)?.status === "fail")
        fixed.push({ site: site.id, name: site.name, check: c.id });
    }
  }

  const tracked: Map<string, Tracked> = new Map();
  for (const t of prevTracked) {
    const site = now.get(t.site);
    if (!site) {
      // A partial run did not visit the site; a full one no longer lists it.
      if (partial) tracked.set(keyOf(t), { ...t, checked: false });
      continue;
    }
    const c = checkOf(site, t.check);
    if (!c) continue; // the site was visited and has no such check any more
    if (c.status === "fail") tracked.set(keyOf(t), { ...t, reason: c.reason, checked: true });
    else if (c.status === "pass") {
      if (!fixed.some((f) => keyOf(f) === keyOf(t)))
        fixed.push({ site: t.site, name: name(t.site), check: t.check });
    } else tracked.set(keyOf(t), { ...t, checked: false });
  }
  for (const r of regressions) {
    if (!tracked.has(keyOf(r)))
      tracked.set(keyOf(r), {
        site: r.site,
        check: r.check,
        since: cur.startedAt,
        reason: r.reason,
        checked: true,
      });
  }

  return {
    baseline: prev ? { startedAt: prev.startedAt, commit: prev.commit ?? null } : null,
    regressions,
    tracked: [...tracked.values()],
    fixed,
    changes,
    added: prev ? cur.sites.filter((s) => !before.has(s.id)).map((s) => s.id) : [],
    removed: prev && !partial ? prev.sites.filter((s) => !now.has(s.id)).map((s) => s.id) : [],
  };
}

/**
 * What diff.json keeps for the next night. `complete` is false once a night could not compare
 * (no baseline, a broken diff.json, a partial run) while an issue was open: that issue's list
 * may then be missing entries, so it is never closed automatically until it is closed by hand.
 */
export function diffState(
  diff: Diff,
  cur: Run,
  { known, complete }: { known: Known; complete: boolean },
) {
  return { version: 1, startedAt: cur.startedAt, complete, known, tracked: diff.tracked };
}

/**
 * What to do with the rolling issue. Only a scheduled run with a baseline touches it, so the
 * chain stays one run a night. A new regression opens it; it is updated while anything is
 * tracked and closed when nothing is, but only after a full run on an unbroken chain (else it is
 * updated, and says why). Closed by hand while something is still tracked, it stays closed until
 * a new regression appears.
 */
export function issueAction(
  diff: Diff,
  {
    scheduled,
    openIssue,
    trusted = true,
    partial = false,
  }: { scheduled: boolean; openIssue: number | null; trusted?: boolean; partial?: boolean },
): IssueAction {
  if (!scheduled) return "none";
  // Without a baseline, only a regression found against diff.json's known results counts.
  if (!diff.baseline && !diff.regressions.length) return "none";
  if (!diff.tracked.length) {
    if (!openIssue) return "none";
    return trusted && diff.baseline && !partial ? "close" : "update";
  }
  if (openIssue) return "update";
  return diff.regressions.length ? "create" : "none";
}

const statusLabel = (status: SiteStatus) => (status === "blocked" ? "blocked (bot check)" : status);

/** @param time an ISO time, validated by parseRun or parseState */
const day = (time: string) => (ISO_TIME.test(time) ? time.slice(0, 10) : "an earlier run");

function capped(items: string[]): string[] {
  if (items.length <= MAX_ITEMS) return items;
  return [...items.slice(0, MAX_ITEMS), `- … and ${items.length - MAX_ITEMS} more`];
}

function baselineLine(baseline: Diff["baseline"]) {
  if (!baseline) return "";
  const commit =
    baseline.commit && COMMIT.test(baseline.commit) ? `, commit ${baseline.commit}` : "";
  return `the scheduled run of ${day(baseline.startedAt)}${commit}`;
}

function lists(diff: Diff, name: (id: string) => string) {
  const fresh = new Set(diff.regressions.map(keyOf));
  const label = (id: string, known: string = name(id)) => `**${md(known)}**`;
  return {
    regressions: diff.regressions.map(
      (r) =>
        `- ${label(r.site, r.name)}, ${r.check}: ${inertCode(r.reason)}; page title ${inertCode(r.title)}`,
    ),
    still: diff.tracked
      .filter((t) => t.checked && !fresh.has(keyOf(t)))
      .map((t) => `- ${label(t.site)}, ${t.check}: ${inertCode(t.reason)} (since ${day(t.since)})`),
    unchecked: diff.tracked
      .filter((t) => !t.checked)
      .map(
        (t) =>
          `- ${label(t.site)}, ${t.check}: not checked; last ${inertCode(t.reason)} ` +
          `(since ${day(t.since)})`,
      ),
    fixed: diff.fixed.map((f) => `- ${label(f.site, f.name)}, ${f.check}`),
    changes: diff.changes.map(
      (c) => `- ${label(c.site, c.name)}: ${statusLabel(c.from)} → ${statusLabel(c.to)}`,
    ),
  };
}

function section(out: string[], heading: string, items: string[]) {
  if (items.length) out.push(heading, "", ...capped(items), "");
}

function capBody(body: string) {
  if (body.length <= MAX_BODY) return body;
  const note = "\n\n(Cut here: the full diff is diff.md in the run's site-compat artifact.)\n";
  const cut = body.lastIndexOf("\n", MAX_BODY - note.length);
  return `${body.slice(0, cut)}${note}`;
}

const namesOf = (cur: Run | undefined) => {
  const names = new Map((cur?.sites ?? []).map((s) => [s.id, s.name]));
  return (id: string) => names.get(id) ?? id;
};

/** The job summary's diff (also diff.md). */
export function renderDiff(diff: Diff, cur: Run) {
  const l = lists(diff, namesOf(cur));
  const out = diff.baseline
    ? [`### Changes since ${baselineLine(diff.baseline)}`, ""]
    : [
        "### Night-to-night diff",
        "",
        "No baseline: no earlier scheduled run's results could be read, so only the tracked " +
          "regressions and last known results from its diff.json, if any, are compared.",
        "",
      ];
  if (l.regressions.length)
    section(out, "**New regressions** (passed then, fail now):", l.regressions);
  else out.push("No new regression.", "");
  section(out, "**Still failing** (tracked regressions):", l.still);
  section(out, "**Not checked in this run** (tracked regressions):", l.unchecked);
  section(out, "**Fixed** (failed then, pass now):", l.fixed);
  section(out, "**Site status changes:**", l.changes);
  section(
    out,
    "**Sites added to the list:**",
    diff.added.map((id) => `- ${md(id)}`),
  );
  section(
    out,
    "**Sites removed from the list:**",
    diff.removed.map((id) => `- ${md(id)}`),
  );
  return `${out.join("\n")}\n`;
}

/**
 * The rolling issue's body (or, for "close", the closing comment).
 */
export function renderIssue(
  diff: Diff,
  {
    action,
    runUrl,
    cur,
    trusted = true,
  }: { action: IssueAction; runUrl?: string; cur?: Run; trusted?: boolean },
) {
  const l = lists(diff, namesOf(cur));
  const out = [
    "Checks of the nightly site-compatibility suite (`sites.yml`, spec site-compat, " +
      "decision 12) that passed in an earlier scheduled run and fail now. Each scheduled run " +
      "updates this issue, and closes it when none is left.",
    "",
  ];
  if (runUrl && RUN_URL.test(runUrl)) out.push(`Run: ${runUrl}`, "");
  if (diff.baseline) out.push(`Compared with ${baselineLine(diff.baseline)}.`, "");
  if (!trusted)
    out.push(
      "**The tracking was interrupted** (a night without a readable baseline or diff.json), so " +
        "this list may be missing regressions and the issue is not closed automatically. Close " +
        "it by hand once the report shows the checks passing; tracking then starts afresh.",
      "",
    );
  if (cur && isPartial(cur))
    out.push("This run did not visit every site (a harness error), so the issue stays open.", "");
  if (action === "close") {
    out.push(
      "No regression is left: every tracked check passes again, or its site left the list.",
      "",
    );
    section(out, "### Fixed", l.fixed);
  } else {
    section(out, "### New in this run", l.regressions);
    section(out, "### Still failing", l.still);
    section(out, "### Not checked in this run", l.unchecked);
    section(out, "### Fixed in this run", l.fixed);
  }
  out.push(
    "Text in code spans comes from the pages and the checks, cut to " +
      `${MAX_TEXT} characters. Screenshots and the full report are in the run's artifact.`,
  );
  return capBody(`${out.join("\n")}\n`);
}

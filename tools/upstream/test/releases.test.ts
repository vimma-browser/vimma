import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DRIFT_LIMIT_DAYS,
  classify,
  compareVersions,
  drift,
  driftLimitDays,
  maxSeverity,
  parseAdvisories,
  parseLongDate,
  parseReleasesFeed,
  parseVersionsFeed,
  releaseKind,
  versionKey,
} from "../releases.mjs";

// Real feeds of 2026-10-10, trimmed (tools/upstream/test/fixtures). No network in tests.
const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const versionsText = fixture("firefox_versions.json");
const releasesText = fixture("firefox.json");
const advisoriesText = fixture("advisories.html");
const releases = parseReleasesFeed(releasesText);
const advisories = parseAdvisories(advisoriesText);

/** An advisories page with one more entry on top, as Mozilla would add it. */
const withAdvisory = (/** @type {string} */ level, /** @type {string} */ title) =>
  advisoriesText.replace(
    "<main>\n",
    `<main>\n<h2>October 13, 2026</h2>\n<ul><li class="level-item">\n` +
      `<a href="/en-US/security/advisories/mfsa2026-105/"><span class="level ${level}">` +
      `MFSA 2026-105</span> ${title}</a></li></ul>\n`,
  );

/** firefox.json with an extra release. */
const withRelease = (
  /** @type {string} */ version,
  /** @type {string} */ date,
  category = "stability",
) => {
  const data = JSON.parse(releasesText);
  data.releases[`firefox-${version}`] = { category, date, version, product: "firefox" };
  return parseReleasesFeed(JSON.stringify(data));
};

describe("versions", () => {
  it("compares release versions numerically, ignoring trailing zeros", () => {
    expect(compareVersions("157.0.1", "157.0")).toBeGreaterThan(0);
    expect(compareVersions("157.0", "157")).toBe(0);
    expect(compareVersions("158.0", "157.0.1")).toBeGreaterThan(0);
    expect(compareVersions("157.0.10", "157.0.9")).toBeGreaterThan(0);
    expect(compareVersions("99.0", "100.0")).toBeLessThan(0);
  });

  it("refuses beta, esr and nightly versions", () => {
    for (const v of ["158.0b5", "140.17.0esr", "160.0a1", "", "157..1", 157]) {
      expect(() => versionKey(v)).toThrow(/not a Firefox release version/);
    }
  });

  it("a major release is X.0, a dot release X.Y.Z", () => {
    expect(releaseKind("158.0")).toBe("major");
    expect(releaseKind("158")).toBe("major");
    expect(releaseKind("157.0.1")).toBe("dot");
  });
});

describe("feeds", () => {
  it("reads LATEST_FIREFOX_VERSION from firefox_versions.json", () => {
    expect(parseVersionsFeed(versionsText)).toEqual({
      latest: "157.0.1",
      lastReleaseDate: "2026-10-09",
    });
  });

  it("refuses a malformed versions feed or one without the key", () => {
    expect(() => parseVersionsFeed("{")).toThrow(/malformed JSON/);
    expect(() => parseVersionsFeed("[]")).toThrow(/not a JSON object/);
    expect(() => parseVersionsFeed('{"FIREFOX_NIGHTLY":"160.0a1"}')).toThrow(/no LATEST/);
    expect(() => parseVersionsFeed('{"LATEST_FIREFOX_VERSION":"158.0b1"}')).toThrow(/not a/);
  });

  it("keeps only release-channel releases from firefox.json, oldest first", () => {
    expect(releases.map((r) => r.version)).toEqual([
      "155.0",
      "155.0.1",
      "156.0",
      "156.0.1",
      "157.0",
      "157.0.1",
    ]);
    expect(releases.at(-1)).toEqual({ version: "157.0.1", kind: "dot", date: "2026-10-06" });
  });

  it("reads Firefox advisories from the MFSA index, skipping Thunderbird and ESR", () => {
    expect(advisories.map((a) => [a.id, a.severity, a.versions, a.date])).toEqual([
      ["MFSA 2026-104", "moderate", ["157.0.1"], "2026-10-06"],
      ["MFSA 2026-97", "high", ["157"], "2026-09-29"],
    ]);
    expect(advisories[0]?.url).toBe(
      "https://www.mozilla.org/en-US/security/advisories/mfsa2026-104/",
    );
  });

  it("a page with no MFSA links at all is an error, not 'no advisories'", () => {
    expect(() => parseAdvisories("<html><h2>Oops</h2></html>")).toThrow(/no MFSA links/);
  });

  it("reads a combined title and decodes entities", () => {
    const page = withAdvisory(
      "critical",
      "Security Vulnerabilities fixed in Firefox 157.0.2 &amp; Firefox ESR 153.4.1",
    );
    const [first] = parseAdvisories(page);
    expect(first).toMatchObject({
      versions: ["157.0.2"],
      date: "2026-10-13",
      severity: "critical",
    });
    expect(first?.title).toContain("& Firefox ESR");
  });

  it("parses the index's long dates", () => {
    expect(parseLongDate("October  6, 2026")).toBe("2026-10-06");
    expect(parseLongDate("Smarch 1, 2026")).toBeNull();
    expect(parseLongDate("soon")).toBeNull();
  });
});

describe("classify", () => {
  it("157.0.1 is a security dot release (MFSA 2026-104, moderate)", () => {
    expect(classify("157.0.1", { releases, advisories })).toEqual({
      version: "157.0.1",
      kind: "dot",
      date: "2026-10-06",
      security: true,
      severity: "moderate",
      advisories: [
        {
          id: "MFSA 2026-104",
          url: "https://www.mozilla.org/en-US/security/advisories/mfsa2026-104/",
          severity: "moderate",
        },
      ],
    });
  });

  it("156.0.1 had no advisory: a regular dot release", () => {
    expect(classify("156.0.1", { releases, advisories })).toMatchObject({
      kind: "dot",
      security: false,
      severity: null,
      advisories: [],
    });
  });

  it("a major release matches the index's 'Firefox 157'", () => {
    expect(classify("157.0", { releases, advisories })).toMatchObject({
      kind: "major",
      security: true,
      severity: "high",
    });
  });

  it("unreadable advisories make security unknown (null), never false", () => {
    expect(classify("157.0.1", { releases, advisories: null }).security).toBeNull();
  });

  it("a release missing from firefox.json takes the fallback date", () => {
    expect(classify("157.0.2", { releases, advisories, fallbackDate: "2026-10-09" }).date).toBe(
      "2026-10-09",
    );
  });

  it("severity is the highest by Mozilla's impact key", () => {
    const a = (/** @type {string} */ severity) => ({
      id: "x",
      url: "u",
      severity,
      title: "t",
      date: null,
      versions: ["1"],
    });
    expect(maxSeverity([a("low"), a("critical"), a("high")])).toBe("critical");
    expect(maxSeverity([a("severe"), a("moderate")])).toBe("moderate");
    expect(maxSeverity([a("severe")])).toBe("severe");
    expect(maxSeverity([])).toBeNull();
  });
});

describe("drift", () => {
  const at = (/** @type {string} */ iso) => new Date(iso);

  it("is current when surfer.json pins the latest release", () => {
    const d = drift({
      current: "157.0.1",
      latest: "157.0.1",
      releases,
      advisories,
      now: at("2026-10-10T12:00:00Z"),
    });
    expect(d).toEqual({ status: "current", current: "157.0.1", unshipped: [], worst: null });
  });

  it("limits: 3 days for a security dot release, 7 for a major, 14 otherwise", () => {
    expect(DRIFT_LIMIT_DAYS).toEqual({ securityDot: 3, major: 7, other: 14 });
    expect(driftLimitDays("dot", true)).toBe(3);
    expect(driftLimitDays("dot", null)).toBe(3);
    expect(driftLimitDays("dot", false)).toBe(14);
    expect(driftLimitDays("major", true)).toBe(7);
    expect(driftLimitDays("major", false)).toBe(7);
  });

  it("a security dot release is behind for 3 days, then overdue", () => {
    const rel = withRelease("157.0.2", "2026-10-13");
    const adv = parseAdvisories(
      withAdvisory("critical", "Security Vulnerabilities fixed in Firefox 157.0.2"),
    );
    const input = { current: "157.0.1", latest: "157.0.2", releases: rel, advisories: adv };
    const behind = drift({ ...input, now: at("2026-10-15T23:59:00Z") });
    expect(behind.status).toBe("behind");
    expect(behind.worst).toMatchObject({
      version: "157.0.2",
      security: true,
      severity: "critical",
      limitDays: 3,
      deadline: "2026-10-16T00:00:00.000Z",
      overdueHours: 0,
    });
    const overdue = drift({ ...input, now: at("2026-10-16T05:00:00Z") });
    expect(overdue.status).toBe("overdue");
    expect(overdue.worst).toMatchObject({ overdueHours: 5, ageHours: 77 });
  });

  it("a dot release without an advisory may wait 14 days", () => {
    const rel = withRelease("157.0.2", "2026-10-13");
    const input = { current: "157.0.1", latest: "157.0.2", releases: rel, advisories };
    expect(drift({ ...input, now: at("2026-10-26T12:00:00Z") }).status).toBe("behind");
    expect(drift({ ...input, now: at("2026-10-27T00:00:01Z") }).status).toBe("overdue");
  });

  it("the earliest deadline wins: a skipped security release still counts", () => {
    // 157.0.2 (security, 3 days) then 157.0.3 (no advisory): the older one fails first.
    const rel = withRelease("157.0.3", "2026-10-15").concat(
      withRelease("157.0.2", "2026-10-13").filter((r) => r.version === "157.0.2"),
    );
    const adv = parseAdvisories(
      withAdvisory("high", "Security Vulnerabilities fixed in Firefox 157.0.2"),
    );
    const d = drift({
      current: "157.0.1",
      latest: "157.0.3",
      releases: rel,
      advisories: adv,
      now: at("2026-10-17T00:00:00Z"),
    });
    expect(d.status).toBe("overdue");
    expect(d.worst?.version).toBe("157.0.2");
    expect(d.unshipped.map((u) => u.version)).toEqual(["157.0.2", "157.0.3"]);
  });

  it("unknown security status (advisories unreadable) uses the security limit", () => {
    const rel = withRelease("157.0.2", "2026-10-13");
    const d = drift({
      current: "157.0.1",
      latest: "157.0.2",
      releases: rel,
      advisories: null,
      now: at("2026-10-17T00:00:00Z"),
    });
    expect(d.worst).toMatchObject({ security: null, limitDays: 3 });
    expect(d.status).toBe("overdue");
  });

  it("the latest release missing from firefox.json counts from the fallback date", () => {
    const d = drift({
      current: "157.0.1",
      latest: "158.0",
      releases,
      advisories,
      now: at("2026-10-24T00:00:00Z"),
      fallbackDate: "2026-10-23",
    });
    expect(d.status).toBe("behind");
    expect(d.worst).toMatchObject({ version: "158.0", kind: "major", limitDays: 7 });
  });

  it("an old pin is behind every newer release", () => {
    const d = drift({
      current: "156.0",
      latest: "157.0.1",
      releases,
      advisories,
      now: at("2026-10-10T00:00:00Z"),
    });
    expect(d.unshipped.map((u) => u.version)).toEqual(["157.0", "156.0.1", "157.0.1"]);
    expect(d.status).toBe("overdue");
    // 157.0 (2026-09-29 + 7) and 156.0.1 (2026-09-22 + 14) tie: the security release is named.
    expect(d.worst?.version).toBe("157.0");
  });
});

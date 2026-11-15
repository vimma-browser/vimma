/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Firefox release and security-advisory logic for the upstream autopilot (spec
 * m7-upstream-autopilot, ADR-015). Pure: no network, no files. detect.mjs feeds it Mozilla's
 * product-details JSON and the security advisories index; tests feed it fixtures.
 *
 * Three feeds:
 * - firefox_versions.json (product-details): LATEST_FIREFOX_VERSION, the newest release.
 * - firefox.json (product-details): every release with its category and date.
 * - https://www.mozilla.org/en-US/security/advisories/: the MFSA index (Mozilla publishes no
 *   Atom or RSS feed of it). Each entry is a link whose title says "fixed in Firefox X.Y.Z".
 */

export const VERSIONS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json";
export const RELEASES_URL = "https://product-details.mozilla.org/1.0/firefox.json";
export const ADVISORIES_URL = "https://www.mozilla.org/en-US/security/advisories/";
const ADVISORY_ORIGIN = "https://www.mozilla.org";

/**
 * How long the shipped Firefox may stay behind a newer release before the drift check fails
 * (docs/security/10-firefox-updates.md, rule G2). The clock starts at 00:00 UTC of the release
 * date.
 */
export const DRIFT_LIMIT_DAYS = Object.freeze({
  /** a dot release (X.Y.Z) with an MFSA advisory: a few backported fixes, mechanical bump */
  securityDot: 3,
  /** a 4-weekly major release (X.0); these always carry an MFSA advisory */
  major: 7,
  /** a dot release without an advisory: stability fixes only */
  other: 14,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_ORDER = ["low", "moderate", "high", "critical"];
const RELEASE = /^\d+(?:\.\d+)*$/;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Comparable parts of a Firefox release version: "157.0.1" → [157, 0, 1], "157.0" → [157].
 * Trailing zeros go so that "157" and "157.0" are the same release (the MFSA index writes
 * "Firefox 157" for 157.0).
 * @param {unknown} version
 * @returns {number[]}
 */
export function versionKey(version) {
  if (typeof version !== "string" || !RELEASE.test(version)) {
    throw new Error(`not a Firefox release version: ${JSON.stringify(version)}`);
  }
  const parts = version.split(".").map(Number);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return parts;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} <0, 0 or >0 as a is older than, the same as, or newer than b
 */
export function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * "major" for X.0 (the 4-weekly release), "dot" for X.Y.Z (a point release).
 * @param {string} version
 * @returns {"major" | "dot"}
 */
export function releaseKind(version) {
  return versionKey(version).length === 1 ? "major" : "dot";
}

/**
 * @param {string} text firefox_versions.json
 * @returns {{ latest: string, lastReleaseDate: string | null }}
 */
export function parseVersionsFeed(text) {
  const data = parseJson(text, "firefox_versions.json");
  const latest = data.LATEST_FIREFOX_VERSION;
  if (latest === undefined) throw new Error("firefox_versions.json has no LATEST_FIREFOX_VERSION");
  versionKey(latest);
  const date = data.LAST_RELEASE_DATE;
  return { latest, lastReleaseDate: typeof date === "string" && isDate(date) ? date : null };
}

/**
 * @typedef {{ version: string, kind: "major" | "dot", date: string }} Release
 */

/**
 * Release-channel releases (categories major and stability; not dev, esr or aurora).
 * @param {string} text firefox.json
 * @returns {Release[]} oldest first
 */
export function parseReleasesFeed(text) {
  const data = parseJson(text, "firefox.json");
  const releases = data.releases;
  if (!releases || typeof releases !== "object") throw new Error("firefox.json has no releases");
  /** @type {Release[]} */
  const out = [];
  for (const r of Object.values(releases)) {
    if (!r || typeof r !== "object") continue;
    if (r.category !== "major" && r.category !== "stability") continue;
    if (typeof r.version !== "string" || !RELEASE.test(r.version) || !isDate(r.date)) continue;
    out.push({ version: r.version, kind: releaseKind(r.version), date: r.date });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * @typedef {{ id: string, url: string, severity: string, title: string, date: string | null,
 *   versions: string[] }} Advisory
 */

/**
 * Firefox (desktop, release channel) advisories in the MFSA index page. Thunderbird, ESR,
 * Firefox for iOS/Android and old one-bug advisories without "fixed in Firefox N" are skipped.
 * @param {string} html https://www.mozilla.org/en-US/security/advisories/
 * @returns {Advisory[]} as listed, newest first
 */
export function parseAdvisories(html) {
  const re =
    /<h2>([^<]+)<\/h2>|<a href="([^"]*\/advisories\/mfsa\d{4}-\d+\/)"><span class="level ([a-z]+)">(MFSA [\d-]+)<\/span>\s*([^<]+)<\/a>/g;
  /** @type {Advisory[]} */
  const out = [];
  let date = null;
  let links = 0;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      date = parseLongDate(m[1]);
      continue;
    }
    links++;
    const title = decodeEntities(/** @type {string} */ (m[5]).trim());
    const fixed = /\bfixed in (.+)$/i.exec(title);
    if (!fixed?.[1]) continue;
    const versions = [...fixed[1].matchAll(/\bFirefox (\d+(?:\.\d+)*)\b/g)].map(
      (v) => /** @type {string} */ (v[1]),
    );
    if (versions.length === 0) continue;
    const href = /** @type {string} */ (m[2]);
    out.push({
      id: /** @type {string} */ (m[4]),
      url: href.startsWith("/") ? ADVISORY_ORIGIN + href : href,
      severity: /** @type {string} */ (m[3]),
      title,
      date,
      versions,
    });
  }
  if (links === 0)
    throw new Error("no MFSA links in the advisories page (has its layout changed?)");
  return out;
}

/**
 * @param {string} version
 * @param {Advisory[]} advisories
 * @returns {Advisory[]}
 */
export function advisoriesFor(version, advisories) {
  return advisories.filter((a) => a.versions.some((v) => compareVersions(v, version) === 0));
}

/**
 * The highest severity, by Mozilla's impact key (critical > high > moderate > low).
 * @param {Advisory[]} advisories
 * @returns {string | null}
 */
export function maxSeverity(advisories) {
  let best = null;
  let rank = -2; // an unknown level (-1) still beats nothing; any known level beats it
  for (const a of advisories) {
    const r = SEVERITY_ORDER.indexOf(a.severity);
    if (r > rank) {
      best = a.severity;
      rank = r;
    }
  }
  return best;
}

/**
 * @typedef {{ version: string, kind: "major" | "dot", date: string | null,
 *   security: boolean | null, severity: string | null,
 *   advisories: { id: string, url: string, severity: string }[] }} Classification
 */

/**
 * Is this release a security release? Yes when an MFSA advisory names it ("fixed in Firefox
 * X.Y.Z"). null when the advisories could not be read: unknown, never silently "no".
 * @param {string} version
 * @param {{ releases: Release[], advisories: Advisory[] | null, fallbackDate?: string | null }} feeds
 * @returns {Classification}
 */
export function classify(version, { releases, advisories, fallbackDate = null }) {
  const release = releases.find((r) => compareVersions(r.version, version) === 0);
  const found = advisories ? advisoriesFor(version, advisories) : [];
  return {
    version,
    kind: releaseKind(version),
    date: release?.date ?? fallbackDate,
    security: advisories ? found.length > 0 : null,
    severity: maxSeverity(found),
    advisories: found.map(({ id, url, severity }) => ({ id, url, severity })),
  };
}

/**
 * Days a release may stay unshipped (DRIFT_LIMIT_DAYS). An unknown security status counts as
 * a security release: the check fails loudly rather than late.
 * @param {"major" | "dot"} kind
 * @param {boolean | null} security
 */
export function driftLimitDays(kind, security) {
  if (kind === "major") return DRIFT_LIMIT_DAYS.major;
  return security === false ? DRIFT_LIMIT_DAYS.other : DRIFT_LIMIT_DAYS.securityDot;
}

/**
 * @typedef {Classification & { limitDays: number, deadline: string, ageHours: number,
 *   overdueHours: number }} Unshipped
 * @typedef {{ status: "current" | "behind" | "overdue", current: string,
 *   unshipped: Unshipped[], worst: Unshipped | null }} Drift
 */

/**
 * How far the shipped Firefox (surfer.json on main) is behind: every newer release-channel
 * release, each with the deadline its limit sets. "overdue" once any deadline has passed;
 * `worst` is the release whose deadline is earliest (the one that fails first, or failed).
 * @param {{ current: string, latest: string, releases: Release[], advisories: Advisory[] | null,
 *   now: Date, fallbackDate?: string | null }} input
 * @returns {Drift}
 */
export function drift({ current, latest, releases, advisories, now, fallbackDate = null }) {
  const newer = releases.filter((r) => compareVersions(r.version, current) > 0);
  // product-details can list the latest version before firefox.json has its entry.
  if (compareVersions(latest, current) > 0 && !newer.some((r) => sameVersion(r.version, latest))) {
    newer.push({ version: latest, kind: releaseKind(latest), date: fallbackDate ?? isoDay(now) });
  }
  /** @type {Unshipped[]} */
  const unshipped = newer.map((r) => {
    const c = classify(r.version, { releases: newer, advisories });
    const limitDays = driftLimitDays(c.kind, c.security);
    const start = Date.parse(`${r.date}T00:00:00Z`);
    const deadline = start + limitDays * DAY_MS;
    return {
      ...c,
      date: r.date,
      limitDays,
      deadline: new Date(deadline).toISOString(),
      ageHours: Math.floor((now.getTime() - start) / 3_600_000),
      overdueHours: Math.max(0, Math.floor((now.getTime() - deadline) / 3_600_000)),
    };
  });
  // Earliest deadline first; on a tie, a security release before one without an advisory.
  unshipped.sort(
    (a, b) =>
      Date.parse(a.deadline) - Date.parse(b.deadline) ||
      Number(a.security === false) - Number(b.security === false),
  );
  const worst = unshipped[0] ?? null;
  const status =
    worst === null ? "current" : Date.parse(worst.deadline) < now.getTime() ? "overdue" : "behind";
  return { status, current, unshipped, worst };
}

/** @param {string} a @param {string} b */
function sameVersion(a, b) {
  return compareVersions(a, b) === 0;
}

/**
 * @param {string} text
 * @param {string} name
 * @returns {Record<string, any>}
 */
function parseJson(text, name) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`malformed JSON in ${name}: ${e instanceof Error ? e.message : e}`, {
      cause: e,
    });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${name} is not a JSON object`);
  }
  return data;
}

/** @param {unknown} s */
function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** @param {Date} d */
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * "October  6, 2026" → "2026-10-06"; null if it is not such a date.
 * @param {string} text
 */
export function parseLongDate(text) {
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(/** @type {string} */ (m[1]).toLowerCase());
  if (month < 0) return null;
  return isoDay(new Date(Date.UTC(Number(m[3]), month, Number(m[2]))));
}

/** @param {string} s */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The first-run setup's pure parts (docs/specs/first-run-setup.md): the curated add-ons, the
 * filter on AMO answers, the step state machine and the plan the summary applies.
 */

/**
 * The curated content blockers, pinned by GUID and slug (decision 13): all three are AMO
 * "Recommended". An AMO answer for one of these slugs with another GUID is dropped.
 */
export const CURATED = Object.freeze([
  { slug: "ublock-origin", guid: "uBlock0@raymondhill.net" },
  { slug: "adguard-adblocker", guid: "adguardadblocker@adguard.com" },
  { slug: "privacy-badger17", guid: "jid1-MnnxcxisBPnSXQ@jetpack" },
]);

/** The AMO request timeout (behaviour 7). */
export const AMO_TIMEOUT_MS = 10_000;

/** AMO's public search: no key, no account (Research). */
export const AMO_API = "https://addons.mozilla.org/api/v5/addons/";

/** @param {string} terms */
export function amoSearchUrl(terms) {
  const q = new URLSearchParams({ q: terms, app: "firefox", type: "extension", sort: "users" });
  return `${AMO_API}search/?${q}`;
}

/** The curated entries in one request: AMO's search takes a comma-separated `guid` list. */
export function amoCuratedUrl() {
  const q = new URLSearchParams({ guid: CURATED.map((c) => c.guid).join(","), app: "firefox" });
  return `${AMO_API}search/?${q}`;
}

/**
 * @typedef {object} AddonEntry
 * @property {string} guid
 * @property {string} slug
 * @property {string} name
 * @property {string} author
 * @property {string} summary
 * @property {number} users      average daily users
 * @property {string} url        the signed .xpi on addons.mozilla.org
 * @property {string} hash       "sha256:…"
 * @property {boolean} installed
 */

/** A localised AMO string: the en-US text, else the first one. */
function text(/** @type {unknown} */ v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    const s = o["en-US"] ?? Object.values(o)[0];
    return typeof s === "string" ? s : "";
  }
  return "";
}

/** Only an https file on addons.mozilla.org itself (decision 4). */
function amoFile(/** @type {unknown} */ url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "addons.mozilla.org" && u.port === "";
  } catch {
    return false;
  }
}

/**
 * AMO results the setup may offer (decision 4, Security "Only AMO, only signed"): an extension,
 * its file https on addons.mozilla.org with a sha256 hash. With `curated`, only the pinned
 * slug and GUID pairs pass.
 * @param {unknown[]} results  `results` of an AMO search answer
 * @param {{ curated?: boolean, installed?: Set<string> }} [options]
 * @returns {AddonEntry[]}
 */
export function amoEntries(results, { curated = false, installed = new Set() } = {}) {
  /** @type {AddonEntry[]} */
  const out = [];
  for (const raw of Array.isArray(results) ? results : []) {
    const r = /** @type {any} */ (raw);
    if (!r || typeof r !== "object" || r.type !== "extension") continue;
    if (typeof r.guid !== "string" || typeof r.slug !== "string") continue;
    const file = r.current_version?.file;
    if (!amoFile(file?.url)) continue;
    if (typeof file.hash !== "string" || !/^sha256:[0-9a-f]+$/i.test(file.hash)) continue;
    if (curated && !CURATED.some((c) => c.slug === r.slug && c.guid === r.guid)) continue;
    out.push({
      guid: r.guid,
      slug: r.slug,
      name: text(r.name) || r.slug,
      author: text(r.authors?.[0]?.name),
      summary: text(r.summary),
      users: Number.isFinite(r.average_daily_users) ? r.average_daily_users : 0,
      url: file.url,
      hash: file.hash,
      installed: installed.has(r.guid),
    });
  }
  if (curated) out.sort((a, b) => curatedIndex(a.guid) - curatedIndex(b.guid));
  return out;
}

const curatedIndex = (/** @type {string} */ guid) => CURATED.findIndex((c) => c.guid === guid);

/**
 * @typedef {object} SetupState
 * @property {"welcome" | "addons" | "engine" | "summary" | "closed"} step
 * @property {number} cursor
 * @property {AddonEntry[]} addons   the list step 1 shows
 * @property {Map<string, AddonEntry>} marked  by GUID, kept across searches
 * @property {string[]} engines
 * @property {string | null} engine  the current default, then the chosen one
 */

/**
 * @param {{ addons: AddonEntry[], engines: string[], engine: string | null }} init
 * @returns {SetupState}
 */
export function initialSetup({ addons, engines, engine }) {
  return { step: "welcome", cursor: 0, addons, marked: new Map(), engines, engine };
}

/** Step 1's list replaced (a search answered, or the curated list back). */
export function withAddons(/** @type {SetupState} */ s, /** @type {AddonEntry[]} */ addons) {
  return { ...s, addons, cursor: 0 };
}

/**
 * @typedef {{ type: "close" } | { type: "search" } | { type: "apply", plan: SetupPlan }
 *   | { type: "done" }} SetupEffect
 */

/**
 * One key on the page, outside the search field. Nothing is applied here: the summary's
 * `enter` returns the plan for the host to apply (decision 2).
 * @param {SetupState} s
 * @param {string} key  "enter", "esc", "q", "j", "k", "space", "/" (Vimma's key notation)
 * @returns {{ state: SetupState, effect: SetupEffect | null }}
 */
export function setupKey(s, key) {
  const stay = { state: s, effect: null };
  const close = {
    state: { ...s, step: /** @type {const} */ ("closed") },
    effect: { type: /** @type {const} */ ("close") },
  };
  const move = (/** @type {number} */ n, /** @type {number} */ d) =>
    n === 0
      ? stay
      : { state: { ...s, cursor: Math.max(0, Math.min(n - 1, s.cursor + d)) }, effect: null };
  switch (s.step) {
    case "welcome":
      if (key === "enter") return { state: { ...s, step: "addons", cursor: 0 }, effect: null };
      if (key === "esc" || key === "q") return close;
      return stay;
    case "addons": {
      if (key === "esc" || key === "q") return close;
      if (key === "j" || key === "down") return move(s.addons.length, 1);
      if (key === "k" || key === "up") return move(s.addons.length, -1);
      if (key === "/") return { state: s, effect: { type: "search" } };
      if (key === "space") {
        const a = s.addons[s.cursor];
        if (!a || a.installed) return stay;
        const marked = new Map(s.marked);
        if (marked.has(a.guid)) marked.delete(a.guid);
        else marked.set(a.guid, a);
        return { state: { ...s, marked }, effect: null };
      }
      if (key === "enter") {
        const at = s.engine ? s.engines.indexOf(s.engine) : -1;
        return { state: { ...s, step: "engine", cursor: Math.max(0, at) }, effect: null };
      }
      return stay;
    }
    case "engine":
      if (key === "esc" || key === "q") return close;
      if (key === "j" || key === "down") return move(s.engines.length, 1);
      if (key === "k" || key === "up") return move(s.engines.length, -1);
      if (key === "enter") {
        const engine = s.engines[s.cursor] ?? s.engine;
        return { state: { ...s, step: "summary", engine }, effect: null };
      }
      return stay;
    case "summary": {
      if (key === "esc") {
        const at = s.engine ? s.engines.indexOf(s.engine) : 0;
        return { state: { ...s, step: "engine", cursor: Math.max(0, at) }, effect: null };
      }
      const plan = planSetup(s);
      if (key === "enter" && plan) return { state: s, effect: { type: "apply", plan } };
      return stay;
    }
    default:
      return stay;
  }
}

/**
 * @typedef {object} SetupPlan
 * @property {AddonEntry[]} addons  to install, one after another
 * @property {string | null} engine  `[search] default` to write
 */

/**
 * What the summary would apply: null before the summary and after a skip (behaviour 2, 6).
 * @param {SetupState} s
 * @returns {SetupPlan | null}
 */
export function planSetup(s) {
  if (s.step !== "summary") return null;
  return { addons: [...s.marked.values()].filter((a) => !a.installed), engine: s.engine };
}

/** "1.2M users" style, for the list. */
export function formatUsers(/** @type {number} */ n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M users`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k users`;
  return `${n} users`;
}

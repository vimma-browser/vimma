// The snapshot layer of the site suite (docs/specs/site-compat.md, "Snapshot layer"): a page's
// rendered DOM, recorded once with its scripts, handlers, embedded content and network
// references removed, and replayed offline on every pull request (`npm run sites -- --offline`).
// The recorder (probes.mjs, contentSnapshot) runs in the page; this module is pure: the check that a snapshot
// holds nothing that runs or loads (verifySnapshot), the manifest (snapshots.json), and the gate
// that fails a run when a check that passed on the recording does not pass now
// (docs/security.md, SC5).
import { md } from "./report.mjs";
import { CHECKS } from "./results.mjs";

/** @typedef {import("./results.mjs").Run} Run */
/** @typedef {import("./site-list.mjs").Site} Site */

/**
 * Pages whose licence allows a copy in this public repository, and that licence (the spec's
 * "Licences decide what may be committed"). Every other site is replayed only by hand-written
 * fixtures that reproduce its structure.
 */
export const SNAPSHOT_LICENCES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    wikipedia: "CC BY-SA 4.0",
    mdn: "CC BY-SA 2.5",
    "python-docs": "PSF-2.0",
    "rust-std": "MIT OR Apache-2.0",
  }),
);

/**
 * Every snapshot's first element in <head>. Nothing may run or load, whatever the sanitiser
 * missed: no script (inline, `javascript:` URLs, handlers), no image, font, frame or fetch.
 * Inline styles stay, since the recorded stylesheets are inlined. The DevTools server's
 * evaluations, which the checks read the page with, are not subject to the page's policy.
 */
export const SNAPSHOT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/** Where every link of a snapshot leads (a hint's follow lands here), next to the snapshots. */
export const FOLLOW_TARGET = "followed.html";

/** The checks a snapshot replays: all but `shortcuts`, which needs the site's own scripts. */
export const GATED_CHECKS = Object.freeze(CHECKS.filter((id) => id !== "shortcuts"));

/** @param {string} id @returns {string | null} the licence a snapshot of `id` is committed under */
export function recordable(id) {
  return Object.hasOwn(SNAPSHOT_LICENCES, id) ? (SNAPSHOT_LICENCES[id] ?? null) : null;
}

/** The recorder's serialised document as the file to commit. @param {string} html */
export function finishSnapshot(html) {
  return `<!doctype html>\n${html}\n`;
}

// ---------------------------------------------------------------------------------------------
// The check every committed snapshot must pass

/** Elements that run, load or embed something, or swallow the markup after them. */
const FORBIDDEN = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "img",
  "image",
  "feimage",
  "picture",
  "video",
  "audio",
  "source",
  "track",
  "link",
  "base",
  "animate",
  "set",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
]);
/** Attributes that name a URL to fetch or navigate to; `href` has a rule of its own. */
const URL_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "background",
  "ping",
  "lowsrc",
  "dynsrc",
  "manifest",
  "codebase",
  "xlink:href",
]);
/** CSS that fetches something, once its escapes and comments are read (cssText). */
const CSS_LOADS = /url\s*\(|@import|image-set\s*\(|\bsrc\s*\(/i;

/**
 * CSS as the engine reads it for what CSS_LOADS looks for: comments removed and escapes
 * decoded (`u\72l(` is `url(`).
 * @param {string} css
 */
export function cssText(css) {
  return css
    .replace(/\/\*[^]*?(\*\/|$)/g, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n0-9a-fA-F])/g, (_, hex, ch) =>
      hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch,
    );
}
/** @param {string} css */
const loads = (css) => CSS_LOADS.test(cssText(css));

/**
 * @typedef {{ name: string, attributes: Array<[string, string]> }} Tag
 */

/**
 * The start tags of `html` in order (with the text of raw-text elements), read as the HTML
 * tokenizer does: comments and text skipped, quoted attribute values may hold `>`.
 * @param {string} html
 * @returns {{ tags: Tag[], styles: string[] }}
 */
function tokenize(html) {
  /** @type {Tag[]} */
  const tags = [];
  /** @type {string[]} */
  const styles = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (html.startsWith("<!--", i)) {
      // As the parser ends a comment: "<!-->" and "<!--->" are whole ones, and "--!>" ends one.
      if (html.startsWith("<!-->", i)) {
        i += 5;
        continue;
      }
      if (html.startsWith("<!--->", i)) {
        i += 6;
        continue;
      }
      const ends = [html.indexOf("-->", i + 4), html.indexOf("--!>", i + 4)].filter((e) => e >= 0);
      if (!ends.length) break;
      const end = Math.min(...ends);
      i = end + (html.startsWith("-->", end) ? 3 : 4);
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?" || html[i + 1] === "/") {
      const end = html.indexOf(">", i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const nameMatch = /^[A-Za-z][^\s/>]*/.exec(html.slice(i + 1, i + 200));
    if (!nameMatch) {
      i++;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    i += 1 + nameMatch[0].length;
    /** @type {Array<[string, string]>} */
    const attributes = [];
    for (;;) {
      while (i < n && /[\s/]/.test(html[i] ?? "")) i++;
      if (i >= n || html[i] === ">") {
        i++;
        break;
      }
      const start = i;
      i++; // an attribute name may start with "="
      while (i < n && !/[\s/>=]/.test(html[i] ?? "")) i++;
      const attr = html.slice(start, i).toLowerCase();
      let j = i;
      while (j < n && /\s/.test(html[j] ?? "")) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && /\s/.test(html[j] ?? "")) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const startValue = j;
          while (j < n && !/[\s>]/.test(html[j] ?? "")) j++;
          value = html.slice(startValue, j);
        }
        i = j;
      }
      attributes.push([attr, value]);
    }
    tags.push({ name, attributes });
    // The content of raw-text elements is read as markup too: inside <svg> or <math> they are
    // not raw text, and reading more than the parser makes elements of never hides one.
    if (name === "style") {
      const close = /<\/style[\s/>]/i.exec(html.slice(i));
      styles.push(html.slice(i, close ? i + close.index : n));
    }
  }
  return { tags, styles };
}

/**
 * What in `html` could run, load or navigate away; empty when it is a clean snapshot. A file
 * that fails is not committed (the snapshot test runs this on every one).
 * @param {string} html
 * @returns {string[]}
 */
export function verifySnapshot(html) {
  /** @type {string[]} */
  const problems = [];
  const add = (/** @type {string} */ p) => {
    if (!problems.includes(p)) problems.push(p);
  };
  if (!html.startsWith("<!doctype html>\n")) add("does not start with <!doctype html>");
  const { tags, styles } = tokenize(html);
  const head = tags.findIndex((t) => t.name === "head");
  // <html>, <head>, the policy: anything before them would put the <meta> in the body (a <head>
  // after <body> is ignored), where Firefox applies no policy.
  const first = head === 1 && tags[0]?.name === "html" ? tags[2] : undefined;
  const attr = (/** @type {Tag | undefined} */ t, /** @type {string} */ name) =>
    t?.attributes.find(([a]) => a === name)?.[1];
  const cspFirst =
    first?.name === "meta" &&
    attr(first, "http-equiv")?.toLowerCase() === "content-security-policy" &&
    attr(first, "content") === SNAPSHOT_CSP;
  if (!cspFirst)
    add("the first element in <head> is not the snapshot's Content-Security-Policy meta");
  tags.forEach((tag, index) => {
    const at = `<${tag.name}>`;
    if (FORBIDDEN.has(tag.name)) add(`${at} is not allowed`);
    if (tag.name === "meta" && attr(tag, "http-equiv") !== undefined) {
      if (!(cspFirst && index === head + 1))
        add("<meta http-equiv> other than the first Content-Security-Policy");
    }
    for (const [name, value] of tag.attributes) {
      if (name.startsWith("on")) add(`event handler attribute ${name} on ${at}`);
      else if (name === "href") {
        if (!value.startsWith("#") && value !== FOLLOW_TARGET)
          add(`href ${JSON.stringify(value)} on ${at} is not a fragment or ${FOLLOW_TARGET}`);
      } else if (URL_ATTRIBUTES.has(name)) add(`${name} on ${at} is not allowed`);
      else if (name === "style" && loads(value)) add(`style attribute on ${at} loads something`);
    }
  });
  for (const css of styles) if (loads(css)) add("a <style> element loads something");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The manifest, tests/e2e/fixtures/sites/snapshots.json

/**
 * @typedef {object} SnapshotEntry
 * @property {string} id        a sites.json id whose licence allows a snapshot
 * @property {string} licence   SNAPSHOT_LICENCES[id]
 * @property {string} recorded  YYYY-MM-DD
 * @property {Record<string, "pass" | "skip">} expect  each gated check's result on the recording
 */

const ENTRY_FIELDS = new Set(["id", "licence", "recorded", "expect"]);

/**
 * @param {unknown} manifest snapshots.json
 * @param {Array<{ id: string }>} sites sites.json
 * @param {string[]} files the .html files next to it
 * @returns {string[]} problems, empty when valid
 */
export function validateManifest(manifest, sites, files) {
  if (!Array.isArray(manifest)) return ["snapshots.json must be an array"];
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  for (const raw of manifest) {
    const e = /** @type {Record<string, unknown>} */ (raw ?? {});
    const id = String(e.id);
    if (seen.has(id)) {
      problems.push(`${id}: duplicate`);
      continue;
    }
    seen.add(id);
    const licence = typeof e.id === "string" ? recordable(e.id) : null;
    if (!licence || !sites.some((s) => s.id === id)) {
      problems.push(`${id}: not a site whose licence allows a committed snapshot`);
      continue;
    }
    if (e.licence !== licence) problems.push(`${id}: licence must be "${licence}"`);
    if (typeof e.recorded !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.recorded))
      problems.push(`${id}: recorded must be a date (YYYY-MM-DD)`);
    for (const key of Object.keys(e))
      if (!ENTRY_FIELDS.has(key)) problems.push(`${id}: unknown field ${key}`);
    const expect = /** @type {Record<string, unknown>} */ (
      e.expect && typeof e.expect === "object" ? e.expect : {}
    );
    for (const check of GATED_CHECKS)
      if (expect[check] !== "pass" && expect[check] !== "skip")
        problems.push(`${id}: expect.${check} must be pass or skip`);
    for (const key of Object.keys(expect))
      if (!GATED_CHECKS.includes(/** @type {any} */ (key)))
        problems.push(`${id}: expect.${key} is not a gated check`);
    if (!files.includes(`${id}.html`)) problems.push(`${id}: no ${id}.html`);
  }
  for (const file of files)
    if (file !== FOLLOW_TARGET && !seen.has(file.replace(/\.html$/, "")))
      problems.push(`${file}: not in snapshots.json`);
  return problems;
}

/**
 * The sites an offline run visits: each snapshot under the page server's `base`, with the
 * `find` word and `search` selector of its sites.json entry.
 * @param {SnapshotEntry[]} manifest
 * @param {Site[]} sites
 * @param {string} base
 * @returns {Site[]}
 */
export function offlineSites(manifest, sites, base) {
  return manifest.map((entry) => {
    const site = sites.find((s) => s.id === entry.id);
    if (!site) throw new Error(`${entry.id}: not in sites.json`);
    return {
      id: site.id,
      name: `${site.name} (snapshot)`,
      url: `${base}${site.id}.html`,
      ...(site.find ? { find: site.find } : {}),
      ...(site.search ? { search: site.search } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The gate

/**
 * @typedef {{ site: string, check: string, expected: string, actual: string,
 *   reason: string | null }} Regression
 * @typedef {{ snapshots: number, regressions: Regression[],
 *   improved: Array<{ site: string, check: string }>, missing: string[], exit: 0 | 1 }} Gate
 */

/**
 * An offline run against the manifest: a check that passed on the recording must pass, and one
 * that was skipped must not fail. A snapshot that did not run, or a harness error, fails too.
 * @param {Pick<Run, "sites" | "harnessError">} run
 * @param {SnapshotEntry[]} manifest the entries the run was meant to visit
 * @returns {Gate}
 */
export function snapshotGate(run, manifest) {
  /** @type {Regression[]} */
  const regressions = [];
  /** @type {Array<{ site: string, check: string }>} */
  const improved = [];
  /** @type {string[]} */
  const missing = [];
  for (const entry of manifest) {
    const result = run.sites.find((s) => s.id === entry.id);
    if (!result) {
      missing.push(entry.id);
      continue;
    }
    for (const check of GATED_CHECKS) {
      const expected = entry.expect[check] ?? "pass";
      const got = result.checks.find((c) => c.id === check);
      const actual = got?.status ?? "skip";
      if ((expected === "pass" && actual !== "pass") || (expected === "skip" && actual === "fail"))
        regressions.push({
          site: entry.id,
          check,
          expected,
          actual,
          reason: got?.reason ?? null,
        });
      else if (expected === "skip" && actual === "pass") improved.push({ site: entry.id, check });
    }
  }
  const failed = regressions.length > 0 || missing.length > 0 || !!run.harnessError;
  return { snapshots: manifest.length, regressions, improved, missing, exit: failed ? 1 : 0 };
}

/** The gate's verdict as Markdown, for report.md and the job summary. @param {Gate} gate */
export function renderGate(gate) {
  const plural = (/** @type {number} */ k, /** @type {string} */ w) =>
    `${k} ${w}${k === 1 ? "" : "s"}`;
  const lines = ["## Snapshot gate", ""];
  if (gate.exit === 0) {
    lines.push(
      `Passed: ${plural(gate.snapshots, "snapshot")}, and every check that passed on its ` +
        "recording passes.",
    );
  } else {
    lines.push(
      `Failed: ${plural(gate.regressions.length, "check")} no longer gave the result recorded ` +
        "for it" +
        (gate.missing.length ? `; did not run: ${gate.missing.map(md).join(", ")}` : "") +
        ".",
    );
  }
  if (gate.regressions.length) {
    lines.push(
      "",
      "| Snapshot | Check | Recorded | Now | Reason |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const r of gate.regressions)
      lines.push(
        `| ${md(r.site)} | ${r.check} | ${r.expected} | ${r.actual} | ${md(r.reason ?? "")} |`,
      );
  }
  if (gate.improved.length)
    lines.push(
      "",
      "Skipped on the recording, passing now (set them to pass in snapshots.json): " +
        gate.improved.map((i) => `${md(i.site)} ${i.check}`).join(", ") +
        ".",
    );
  return `${lines.join("\n")}\n`;
}

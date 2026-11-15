#!/usr/bin/env node
/**
 * The Firefox version in release notes (spec firefox-versions, decisions 6 to 10). release-please
 * writes `## [0.5.2](<compare>) (2026-10-20)` and a bump line `* firefox 158.0 (MFSA 2026-106)`
 * (the bump PR's subject); this turns the newest entry into
 * `## [0.5.2](<compare>) · Firefox 158.0 (2026-10-20)` and
 * `* Firefox 158.0 ([MFSA 2026-106](<advisory>))`. Used on the release PR's CHANGELOG.md (job
 * firefox-notes) and on the GitHub Release's notes (job release-title) in release-please.yml.
 *
 * Idempotent: a second pass changes nothing. Only the newest entry (the first `## <version>`
 * heading up to the next `## `) is touched; text after it, such as the third-party notice
 * release.yml appends to a release, is kept byte for byte.
 *
 * Usage: node tools/release/firefox-notes.mjs <markdown file> --surfer <surfer.json>
 * Prints the result to stdout. Node built-ins only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FIREFOX, surferVersions } from "../version-files/version-files.ts";

/** Mozilla's advisory page for an ID such as `MFSA 2026-106` (tools/upstream/releases.mjs). */
const ADVISORIES = "https://www.mozilla.org/en-US/security/advisories/";
const MFSA_ID = /^MFSA (\d{4}-\d+)$/;

/**
 * The newest release heading as release-please 17.6.0 writes it (`## [x.y.z](compare) (date)`,
 * or `## x.y.z (date)` without a previous tag), with the Firefox part this module adds.
 * Groups: 1 the heading up to the version or its compare link, 2 the date part.
 */
const HEADING =
  /^(## (?:\[\d+\.\d+\.\d+[^\]]*\]\([^)\s]*\)|\d+\.\d+\.\d+\S*))(?: · Firefox \S+)?( \(\d{4}-\d{2}-\d{2}\))$/m;
/** A bump line release-please wrote from `upstream: firefox <version> (MFSA a, MFSA b)`. */
const BUMP =
  /^\* firefox (\d+\.\d+(?:\.\d+)?(?:[ab]\d+)?)(?: \((MFSA \d{4}-\d+(?:, MFSA \d{4}-\d+)*)\))?(?= |$)/gm;

/**
 * @param {string} id e.g. `MFSA 2026-106`
 * @returns {string} e.g. https://www.mozilla.org/en-US/security/advisories/mfsa2026-106/
 */
export function advisoryUrl(id) {
  const m = MFSA_ID.exec(id);
  if (!m) throw new Error(`not an MFSA ID: ${id}`);
  return `${ADVISORIES}mfsa${m[1]}/`;
}

/**
 * @param {string} section the `### Changed` section of the newest entry
 * @returns {string}
 */
function linkBumps(section) {
  return section.replace(BUMP, (_, version, ids) => {
    const links = ids
      ? ` (${ids
          .split(", ")
          .map((/** @type {string} */ id) => `[${id}](${advisoryUrl(id)})`)
          .join(", ")})`
      : "";
    return `* Firefox ${version}${links}`;
  });
}

/**
 * @param {string} markdown a CHANGELOG.md, or a release's notes
 * @param {{ firefox: string }} options the Firefox version the release is built on
 * @returns {string}
 */
export function firefoxNotes(markdown, { firefox }) {
  if (!FIREFOX.test(firefox)) throw new Error(`not a Firefox version: ${firefox}`);
  const heading = HEADING.exec(markdown);
  if (!heading) return markdown;
  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const next = markdown.slice(afterHeading).search(/^## /m);
  const end = next === -1 ? markdown.length : afterHeading + next;

  let entry = `${heading[1]} · Firefox ${firefox}${heading[2]}` + markdown.slice(afterHeading, end);
  // Only the Changed section, where release-please puts `upstream` commits.
  entry = entry.replace(/^### Changed\n[\s\S]*?(?=^###? |^---$|(?![\s\S]))/m, linkBumps);
  return markdown.slice(0, start) + entry + markdown.slice(end);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { surfer: { type: "string" } },
  });
  const [file] = positionals;
  if (!file || !values.surfer) {
    throw new Error("usage: firefox-notes.mjs <markdown file> --surfer <surfer.json>");
  }
  const { firefox } = surferVersions(JSON.parse(readFileSync(values.surfer, "utf8")));
  process.stdout.write(firefoxNotes(readFileSync(file, "utf8"), { firefox }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`firefox-notes: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

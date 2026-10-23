#!/usr/bin/env node
/**
 * The hand-written `## [Unreleased]` lines of CHANGELOG.md in a release (issue #529).
 *
 * Contributors write what users see under `## [Unreleased]`, as `- ` items under Keep a
 * Changelog's `### Added` / `### Changed` / … headings. release-please writes each release's
 * entry from commit subjects (`* ` items) and puts it above the first `## [` heading, which is
 * `[Unreleased]`, so without help the hand-written section would stay behind below the release
 * it describes. A release shows both: the hand-written lines first, then release-please's list.
 *
 * - `move`: on the release pull request's CHANGELOG.md, move every `[Unreleased]` item into the
 *   same section of the new version's entry (added after release-please's sections when it has
 *   none), above release-please's items, and leave an empty `## [Unreleased]` at the top. Job
 *   firefox-notes in release-please.yml runs it on each rebuild of the release branch.
 * - `notes`: on a GitHub release's notes, add the hand-written items of that version's entry in
 *   the tagged CHANGELOG.md, since release-please writes a release's notes from the release pull
 *   request's body, which holds only its own list. Job release-title runs it.
 * - `check`: `npm run lint` fails unless `## [Unreleased]` is the first `## ` heading, appears
 *   once and holds only what `move` can carry whole.
 *
 * Every function is idempotent: a second pass changes nothing. Text outside the new entry, such
 * as the update steps and third-party notice release.yml adds to a release's notes, is kept byte
 * for byte.
 *
 * Usage:
 *   node tools/release/changelog.mjs move <CHANGELOG.md>
 *   node tools/release/changelog.mjs notes <notes.md> --changelog <CHANGELOG.md> --version <x.y.z>
 *   node tools/release/changelog.mjs check [CHANGELOG.md]
 * move and notes print the result to stdout. Node built-ins only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const UNRELEASED = "## [Unreleased]";
/** Keep a Changelog's section names: the headings a hand-written item may sit under. */
const HAND_SECTIONS = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);
/**
 * Headings inside a release entry: Keep a Changelog's, release-please's (release-please-config
 * .json changelog-sections) and its breaking-changes heading. Any other `### ` heading, such as
 * the `### Third-party notice` release.yml appends to a release's notes, ends the entry.
 */
const ENTRY_SECTIONS = new Set([
  ...HAND_SECTIONS,
  "Documentation",
  "Tests",
  "Build",
  "CI",
  "Miscellaneous",
  "⚠ BREAKING CHANGES",
]);
/** A release heading as release-please writes it, with or without a compare link. */
const VERSION_HEADING = /^## \[?(\d+\.\d+\.\d+[^\]\s(]*)\]?[\s(]/;

/**
 * @typedef {{ name: string, items: string[] }} Section  items: each a `- ` line plus its
 *   indented continuation lines, joined by "\n"
 */

/** @param {string} line */
const isHeading2 = (line) => line.startsWith("## ");

/**
 * The hand-written items at the top of each section of `lines` (an entry without its heading).
 * @param {string[]} lines
 * @returns {Section[]}
 */
function handItems(lines) {
  /** @type {Section[]} */
  const sections = [];
  /** @type {Section | undefined} */
  let current;
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      current = { name: /** @type {string} */ (heading[1]), items: [] };
      sections.push(current);
    } else if (current && line.startsWith("- ")) {
      let item = line;
      while (/^ {2}\S/.test(lines[i + 1] ?? "")) item += `\n${lines[++i]}`;
      current.items.push(item);
    }
  }
  return sections.filter((s) => s.items.length > 0);
}

/**
 * Adds `sections`' items to `entry`, the lines of one release entry from its heading up to (not
 * including) whatever follows it. Items already in the entry are skipped.
 * @param {string[]} entry
 * @param {Section[]} sections
 * @returns {string[]}
 */
function mergeInto(entry, sections) {
  let out = [...entry];
  const text = () => out.join("\n");
  for (const { name, items } of sections) {
    // Whole lines, so that an item that only starts a longer line is still moved.
    const fresh = items.filter((item) => !`\n${text()}\n`.includes(`\n${item}\n`));
    if (fresh.length === 0) continue;
    const at = out.indexOf(`### ${name}`);
    if (at === -1) {
      // A section release-please did not write goes after its own ones, two blank lines above
      // it as release-please spaces them.
      let end = out.length;
      while (end > 0 && out[end - 1] === "") end--;
      const trailing = out.slice(end);
      out = [
        ...out.slice(0, end),
        "",
        "",
        `### ${name}`,
        "",
        ...fresh.flatMap((i) => i.split("\n")),
        ...(trailing.length ? trailing : [""]),
      ];
      continue;
    }
    // The section: blank lines, the hand-written items an earlier pass moved, then the rest.
    let first = at + 1;
    while (out[first] === "") first++;
    let after = first;
    while ((out[after] ?? "").startsWith("- ")) {
      after++;
      while (/^ {2}\S/.test(out[after] ?? "")) after++;
    }
    const added = fresh.flatMap((item) => item.split("\n"));
    if (after > first) {
      out = [...out.slice(0, after), ...added, ...out.slice(after)];
    } else if (first < out.length && !(out[first] ?? "").startsWith("#")) {
      // a blank line between the hand-written list and release-please's
      out = [...out.slice(0, at + 1), "", ...added, "", ...out.slice(first)];
    } else {
      out = [...out.slice(0, at + 1), "", ...added, ...out.slice(at + 1)];
    }
  }
  return out;
}

/**
 * Where the newest release entry starts and ends in `lines`: from the first version heading up
 * to the next `## ` heading, a `---` rule or a heading that is not a changelog section.
 * @param {string[]} lines
 * @returns {{ start: number, end: number, version: string } | null}
 */
function newestEntry(lines) {
  const start = lines.findIndex((l) => VERSION_HEADING.test(l));
  if (start === -1) return null;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = /** @type {string} */ (lines[end]);
    if (isHeading2(line) || line === "---") break;
    const h3 = /^### (.+)$/.exec(line);
    if (h3 && !ENTRY_SECTIONS.has(/** @type {string} */ (h3[1]))) break;
  }
  const version = /** @type {string} */ (VERSION_HEADING.exec(lines[start] ?? "")?.[1]);
  return { start, end, version };
}

/**
 * Problems with the `[Unreleased]` section's body (`lines`, after its heading), as messages
 * with 1-based line numbers counted from `offset`.
 * @param {string[]} lines
 * @param {number} offset the 0-based index of the heading
 * @returns {string[]}
 */
function unreleasedProblems(lines, offset) {
  const problems = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let inItem = false;
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    const n = offset + i + 2;
    const heading = /^### (.+)$/.exec(line);
    if (line === "") {
      inItem = false;
    } else if (heading) {
      const name = /** @type {string} */ (heading[1]);
      if (!HAND_SECTIONS.has(name)) {
        problems.push(
          `line ${n}: \`${line}\` is not a Keep a Changelog section (${[...HAND_SECTIONS].join(", ")})`,
        );
      } else if (seen.has(name)) {
        problems.push(`line ${n}: \`${line}\` appears twice in [Unreleased]`);
      }
      seen.add(name);
      inItem = false;
    } else if (line.startsWith("- ") && seen.size > 0) {
      inItem = true;
    } else if (inItem && /^ {2}\S/.test(line)) {
      // a continuation of the item above
    } else {
      problems.push(
        `line ${n}: [Unreleased] holds only \`### Added\`-style headings and \`- \` items under them`,
      );
    }
  }
  return problems;
}

/**
 * @param {string} markdown a CHANGELOG.md
 * @returns {string[]} what is wrong with its `[Unreleased]` section; empty when nothing is
 */
export function checkChangelog(markdown) {
  const lines = markdown.split("\n");
  const at = lines.flatMap((l, i) => (l === UNRELEASED ? [i] : []));
  const first = lines.findIndex(isHeading2);
  if (at.length === 0) return [`no \`${UNRELEASED}\` heading: add it above the newest release`];
  /** @type {string[]} */
  const problems = [];
  if (first !== at[0]) {
    problems.push(
      `line ${first + 1}: \`${UNRELEASED}\` must be the first \`## \` heading, above \`${lines[first]}\``,
    );
  }
  for (const i of at.slice(1)) {
    problems.push(`line ${i + 1}: \`${UNRELEASED}\` may appear only once`);
  }
  if (problems.length) return problems;
  const start = /** @type {number} */ (at[0]);
  let end = start + 1;
  while (end < lines.length && !isHeading2(/** @type {string} */ (lines[end]))) end++;
  return unreleasedProblems(lines.slice(start + 1, end), start);
}

/**
 * @param {string} markdown CHANGELOG.md on the release branch, with release-please's new entry
 * @returns {string} the same with the `[Unreleased]` items moved into the newest entry and an
 *   empty `## [Unreleased]` right above it
 */
export function moveUnreleased(markdown) {
  let lines = markdown.split("\n");
  const at = lines.flatMap((l, i) => (l === UNRELEASED ? [i] : []));
  if (at.length > 1) throw new Error(`more than one ${UNRELEASED} section`);
  /** @type {Section[]} */
  let sections = [];
  if (at.length === 1) {
    const start = /** @type {number} */ (at[0]);
    let end = start + 1;
    while (end < lines.length && !isHeading2(/** @type {string} */ (lines[end]))) end++;
    const body = lines.slice(start + 1, end);
    const problems = unreleasedProblems(body, start);
    if (problems.length) throw new Error(`cannot move [Unreleased] whole: ${problems.join("; ")}`);
    sections = handItems(body);
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  const entry = newestEntry(lines);
  if (!entry) throw new Error(`no version entry to move ${UNRELEASED} into`);
  const merged = mergeInto(lines.slice(entry.start, entry.end), sections);
  return [
    ...lines.slice(0, entry.start),
    UNRELEASED,
    "",
    ...merged,
    ...lines.slice(entry.end),
  ].join("\n");
}

/**
 * @param {string} notes a GitHub release's notes, release-please's entry for `version`
 * @param {string} changelog CHANGELOG.md at the release's tag
 * @param {string} version e.g. 0.1.9
 * @returns {string} the notes with the hand-written items of `version`'s changelog entry
 */
export function handWrittenNotes(notes, changelog, version) {
  const log = changelog.split("\n");
  const start = log.findIndex((l) => VERSION_HEADING.exec(l)?.[1] === version);
  if (start === -1) throw new Error(`CHANGELOG.md has no ${version} entry`);
  const logEntry = /** @type {{ start: number, end: number }} */ (newestEntry(log.slice(start)));
  const sections = handItems(log.slice(start + 1, start + logEntry.end));

  const lines = notes.split("\n");
  const entry = newestEntry(lines);
  if (!entry || entry.version !== version) {
    throw new Error(`the release notes' newest entry is not ${version}`);
  }
  const merged = mergeInto(lines.slice(entry.start, entry.end), sections);
  return [...lines.slice(0, entry.start), ...merged, ...lines.slice(entry.end)].join("\n");
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { changelog: { type: "string" }, version: { type: "string" } },
  });
  const [command, file = "CHANGELOG.md"] = positionals;
  const read = (/** @type {string} */ path) => readFileSync(path, "utf8");
  if (command === "move") {
    process.stdout.write(moveUnreleased(read(file)));
  } else if (command === "notes" && values.changelog && values.version) {
    process.stdout.write(handWrittenNotes(read(file), read(values.changelog), values.version));
  } else if (command === "check") {
    const problems = checkChangelog(read(file));
    for (const p of problems) console.error(`${file}: ${p}`);
    if (problems.length) process.exit(1);
    console.log(`Changelog: ${file}'s [Unreleased] is the first heading, once, and movable.`);
  } else {
    throw new Error(
      "usage: changelog.mjs move <file> | notes <file> --changelog <file> --version <x.y.z> | check [file]",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`changelog: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

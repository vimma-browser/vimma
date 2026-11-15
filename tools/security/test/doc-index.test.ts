/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The index pages of docs/security/ and docs/runbook/ are how a citation that gives only a rule
// identifier or a heading ("security.md M31") finds its page, so each index has to list every
// page of its folder, and the security index the rules each page really defines.
//
// The paths are literal `new URL`s of Markdown files so that tools/ci/docs-only.mjs's check finds
// this file among the tests a docs-only pull request runs.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SECURITY = fileURLToPath(new URL("../../../docs/security/README.md", import.meta.url));
const RUNBOOK = fileURLToPath(new URL("../../../docs/runbook/README.md", import.meta.url));

/** The pages of an index's folder: every Markdown file but the index, sorted. */
const pagesOf = (index: string) =>
  readdirSync(dirname(index))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();

/** The table rows under "## Sections", as their cells. */
function rows(index: string): string[][] {
  const text = readFileSync(index, "utf8");
  const at = text.indexOf("\n## Sections\n");
  expect(at).toBeGreaterThan(-1);
  return text
    .slice(at)
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-{3,}/.test(line))
    .slice(1) // the header row
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** The page a cell links: `[title](page.md)`. */
function linked(cell: string): string {
  const m = /\]\(([\w.-]+\.md)\)/.exec(cell);
  if (!m?.[1]) throw new Error(`no page link in "${cell}"`);
  return m[1];
}

/** "M1 to M34, M62" as its identifiers; "none" as none. */
function listed(cell: string): string[] {
  if (cell === "none") return [];
  return cell.split(/,\s*/).flatMap((part) => {
    const m = /^([A-Z]+)(\d+)(?: to \1(\d+))?$/.exec(part);
    if (!m) throw new Error(`not a rule or a range of rules: "${part}"`);
    const from = Number(m[2]);
    const to = Number(m[3] ?? m[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => `${m[1]}${from + i}`);
  });
}

/** The rules a page defines: its list items that open with an identifier, "- M31. …". */
const defined = (page: string) =>
  [...readFileSync(page, "utf8").matchAll(/^- ([A-Z]+\d+)[a-z]?\. /gm)].map((m) => m[1] as string);

const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

describe("docs/security/README.md", () => {
  const table = rows(SECURITY);

  test("lists every page of the folder exactly once, and no page that is not there", () => {
    expect(table.map((row) => linked(row[1] ?? "")).sort()).toEqual(pagesOf(SECURITY));
  });

  test("gives each page its section number", () => {
    for (const [section = "", page = ""] of table)
      expect(`§${Number(linked(page).slice(0, 2))}`, page).toBe(section);
  });

  test("names, for each page, exactly the rules that page defines", () => {
    let rules = 0;
    for (const [, page = "", cell = ""] of table) {
      const on = defined(join(dirname(SECURITY), linked(page)));
      expect(listed(cell).sort(byNumber), page).toEqual([...new Set(on)].sort(byNumber));
      rules += on.length;
    }
    expect(rules).toBeGreaterThan(200);
  });

  test("no rule identifier is defined on two pages", () => {
    const all = pagesOf(SECURITY).flatMap((page) => defined(join(dirname(SECURITY), page)));
    expect(all.filter((id, i) => all.indexOf(id) !== i)).toEqual([]);
  });
});

describe("docs/runbook/README.md", () => {
  test("lists every page of the folder exactly once, and no page that is not there", () => {
    const pages = rows(RUNBOOK).map((row) => linked(row[0] ?? ""));
    expect(pages.length).toBeGreaterThan(30);
    expect(pages.sort()).toEqual(pagesOf(RUNBOOK));
  });
});

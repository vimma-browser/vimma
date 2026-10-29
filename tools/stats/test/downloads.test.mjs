import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  HEADER,
  assetRows,
  fetchReleases,
  formatSummary,
  mergeRows,
  parseCsv,
  summarise,
  toCsv,
} from "../downloads.mjs";

// #647: a daily snapshot of every release asset's download count, kept on the `stats` branch
// (docs/runbook.md, "Release download counts"), and a summary of the daily deltas.

const SCRIPT = fileURLToPath(new URL("../downloads.mjs", import.meta.url));

/** @param {string} date @param {string} tag @param {string} asset @param {number} downloads */
const row = (date, tag, asset, downloads) => ({ date, tag, asset, downloads });

describe("asset rows", () => {
  it("one row per asset of each published release, sorted by tag and asset", () => {
    const releases = [
      {
        tag_name: "v0.1.2",
        draft: false,
        assets: [
          { name: "b.tar.xz", download_count: 5 },
          { name: "a.dmg", download_count: 2 },
        ],
      },
      { tag_name: "v0.1.3", draft: true, assets: [{ name: "x", download_count: 0 }] },
      { tag_name: "v0.1.1", draft: false, assets: [{ name: "a.dmg", download_count: 9 }] },
    ];
    expect(assetRows(releases, "2026-10-29")).toEqual([
      row("2026-10-29", "v0.1.1", "a.dmg", 9),
      row("2026-10-29", "v0.1.2", "a.dmg", 2),
      row("2026-10-29", "v0.1.2", "b.tar.xz", 5),
    ]);
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    expect(() => assetRows([], "29.10.2026")).toThrow(/date/);
  });
});

describe("CSV", () => {
  it("writes a header and quotes a field with a comma or a quote", () => {
    const rows = [row("2026-10-29", "v1", 'a,"b"', 3), row("2026-10-29", "v1", "plain", 0)];
    const text = toCsv(rows);
    expect(text).toBe(`${HEADER}\n2026-10-29,v1,"a,""b""",3\n2026-10-29,v1,plain,0\n`);
    expect(parseCsv(text)).toEqual(rows);
  });

  it("reads an empty file or a header alone as no rows", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv(`${HEADER}\n`)).toEqual([]);
  });

  it("refuses a file with another header or a count that is not a whole number", () => {
    expect(() => parseCsv("day,tag,asset,downloads\n")).toThrow(/header/);
    expect(() => parseCsv(`${HEADER}\n2026-10-29,v1,a,many\n`)).toThrow(/line 2/);
  });
});

describe("merging a day into the history", () => {
  const history = [row("2026-10-28", "v1", "a", 1)];

  it("appends a new day", () => {
    const today = [row("2026-10-29", "v1", "a", 4)];
    expect(mergeRows(history, today)).toEqual({ rows: [...history, ...today], added: 1 });
  });

  it("leaves the history as it is when the day is already recorded", () => {
    const again = [row("2026-10-28", "v1", "a", 7)];
    expect(mergeRows(history, again)).toEqual({ rows: history, added: 0 });
  });
});

describe("summary", () => {
  const rows = [
    row("2026-10-27", "v1", "a", 10),
    row("2026-10-27", "v1", "b", 1),
    row("2026-10-28", "v1", "a", 12),
    row("2026-10-28", "v1", "b", 1),
    row("2026-10-28", "v2", "a", 3),
    row("2026-10-29", "v1", "a", 20),
    row("2026-10-29", "v1", "b", 2),
    row("2026-10-29", "v2", "a", 3),
  ];

  it("totals each release per day, with the change since its previous snapshot", () => {
    expect(summarise(rows).releases).toEqual([
      { date: "2026-10-27", tag: "v1", downloads: 11, delta: null },
      { date: "2026-10-28", tag: "v1", downloads: 13, delta: 2 },
      { date: "2026-10-28", tag: "v2", downloads: 3, delta: null },
      { date: "2026-10-29", tag: "v1", downloads: 22, delta: 9 },
      { date: "2026-10-29", tag: "v2", downloads: 3, delta: 0 },
    ]);
  });

  it("gives each asset's daily change, and the day's total across releases", () => {
    const s = summarise(rows);
    expect(s.assets.filter((a) => a.date === "2026-10-29")).toEqual([
      { date: "2026-10-29", tag: "v1", asset: "a", downloads: 20, delta: 8 },
      { date: "2026-10-29", tag: "v1", asset: "b", downloads: 2, delta: 1 },
      { date: "2026-10-29", tag: "v2", asset: "a", downloads: 3, delta: 0 },
    ]);
    expect(s.days).toEqual([
      { date: "2026-10-27", downloads: 11, delta: null },
      { date: "2026-10-28", downloads: 16, delta: 5 },
      { date: "2026-10-29", downloads: 25, delta: 9 },
    ]);
  });

  it("renders a Markdown table of the release totals, newest day first", () => {
    const md = formatSummary(summarise(rows), { markdown: true });
    const lines = md.trim().split("\n");
    expect(lines[0]).toBe("| Date | Release | Downloads | Change |");
    expect(lines[2]).toBe("| 2026-10-29 | v1 | 22 | +9 |");
    expect(md).toContain("| 2026-10-27 | v1 | 11 |  |");
  });

  it("renders plain text with the asset deltas when asked", () => {
    const text = formatSummary(summarise(rows), { assets: true });
    expect(text).toMatch(/^2026-10-29 {2}v1 {2}a +20 +\+8$/m);
  });
});

describe("fetching releases", () => {
  it("follows the pages until one comes back short, with the token when there is one", async () => {
    /** @type {{ url: string, auth: string | undefined }[]} */
    const calls = [];
    const page = (n) => Array.from({ length: n }, (_, i) => ({ tag_name: `v${i}`, assets: [] }));
    const pages = [page(100), page(3)];
    /** @type {typeof fetch} */
    const fakeFetch = async (url, init) => {
      const headers = /** @type {Record<string, string>} */ (init?.headers ?? {});
      calls.push({ url: String(url), auth: headers.authorization });
      return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
    };
    const releases = await fetchReleases("o/r", { token: "t", fetch: fakeFetch });
    expect(releases).toHaveLength(103);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/o/r/releases?per_page=100&page=1",
      "https://api.github.com/repos/o/r/releases?per_page=100&page=2",
    ]);
    expect(calls[0]?.auth).toBe("Bearer t");
  });

  it("fails on an HTTP error rather than recording a partial day", async () => {
    /** @type {typeof fetch} */
    const fakeFetch = async () => new Response("rate limited", { status: 403 });
    await expect(fetchReleases("o/r", { fetch: fakeFetch })).rejects.toThrow(/403/);
  });
});

describe("the command line", () => {
  it("summary prints the totals of a history file", () => {
    const dir = tempDir("vimma-downloads-");
    const csv = join(dir, "downloads.csv");
    writeFileSync(csv, toCsv([row("2026-10-28", "v1", "a", 1), row("2026-10-29", "v1", "a", 4)]));
    const r = spawnSync(process.execPath, [SCRIPT, "summary", "--csv", csv], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^2026-10-29 {2}v1 +4 +\+3$/m);
  });

  it("merge appends a day's rows to a history file once", () => {
    const dir = tempDir("vimma-downloads-");
    const csv = join(dir, "downloads.csv");
    const day = join(dir, "day.csv");
    writeFileSync(csv, toCsv([row("2026-10-28", "v1", "a", 1)]));
    writeFileSync(day, toCsv([row("2026-10-29", "v1", "a", 4)]));
    const merge = () =>
      spawnSync(process.execPath, [SCRIPT, "merge", "--csv", csv, "--day", day], {
        encoding: "utf8",
      });
    expect(merge().stdout).toMatch(/added 1 row/);
    expect(merge().stdout).toMatch(/2026-10-29 is already recorded/);
    expect(parseCsv(readFileSync(csv, "utf8"))).toHaveLength(2);
  });

  it("an unknown command exits 2 with the usage", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "nope"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });
});

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Release download counts over time (#647, docs/runbook.md "Release download counts"). GitHub
 * keeps one running `download_count` per release asset and no history, so a jump cannot be told
 * apart from our own automation fetching an asset. downloads.yml records every asset's count once
 * a day into `downloads.csv` on the `stats` branch; this script takes the snapshot, adds it to
 * the history and summarises the daily changes.
 *
 *   node tools/stats/downloads.ts collect --repo <owner/name> [--date YYYY-MM-DD] > <day.csv>
 *       today's (UTC) count of every asset of every published release; GITHUB_TOKEN or GH_TOKEN
 *       is used when set (public data: the token only raises the rate limit), GITHUB_API_URL
 *       when set; the CSV goes to stdout, a one-line total to stderr
 *   node tools/stats/downloads.ts merge --csv <downloads.csv> --day <day.csv>
 *       appends the day to the history, unless that date is already recorded
 *   node tools/stats/downloads.ts summary --csv <downloads.csv> [--assets] [--markdown]
 *       per-release totals per day and the change since the release's previous snapshot;
 *       --assets adds each asset's change
 *
 * Exit 0 on success, 1 on a failed fetch or a malformed file, 2 on a usage error.
 * Node built-ins only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const HEADER = "date,tag,asset,downloads";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PER_PAGE = 100;

export type Row = { date: string; tag: string; asset: string; downloads: number };
export type Asset = { name: string; download_count: number };
export type Release = { tag_name: string; draft?: boolean; assets: Asset[] };
export type ReleaseDay = { date: string; tag: string; downloads: number; delta: number | null };
export type AssetDay = ReleaseDay & { asset: string };
export type Day = { date: string; downloads: number; delta: number | null };
export type Summary = { releases: ReleaseDay[]; assets: AssetDay[]; days: Day[] };

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * One row per asset of every published release. Drafts are left out: nobody outside the
 * repository can download their assets.
 * @param date YYYY-MM-DD
 */
export function assetRows(releases: Release[], date: string): Row[] {
  if (!DATE.test(date)) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return releases
    .filter((r) => !r.draft)
    .flatMap((r) =>
      r.assets.map((a) => ({ date, tag: r.tag_name, asset: a.name, downloads: a.download_count })),
    )
    .sort((a, b) => byName(a.tag, b.tag) || byName(a.asset, b.asset));
}

const quote = (field: string) =>
  /[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;

/**
 * @returns the CSV text, header first
 */
export function toCsv(rows: Row[]): string {
  const lines = rows.map((r) => [r.date, r.tag, r.asset, String(r.downloads)].map(quote).join(","));
  return [HEADER, ...lines].join("\n") + "\n";
}

/**
 * Splits one CSV line into fields (RFC 4180 quoting; no field spans lines).
 */
function fields(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else value += line[i++];
      }
      out.push(value);
      i++; // the comma
    } else {
      const end = line.indexOf(",", i);
      const stop = end === -1 ? line.length : end;
      out.push(line.slice(i, stop));
      i = stop + 1;
    }
  }
  return out;
}

export function parseCsv(text: string): Row[] {
  const lines = text.split("\n").filter((l) => l !== "");
  if (lines.length === 0) return [];
  if (lines[0] !== HEADER) throw new Error(`unexpected header: ${lines[0]} (want ${HEADER})`);
  return lines.slice(1).map((line, i) => {
    const [date = "", tag = "", asset = "", count = ""] = fields(line);
    if (!DATE.test(date) || !/^\d+$/.test(count) || fields(line).length !== 4) {
      throw new Error(`line ${i + 2}: not date,tag,asset,downloads: ${line}`);
    }
    return { date, tag, asset, downloads: Number(count) };
  });
}

/**
 * Adds a day's rows to the history unless a date among them is already recorded, so a second
 * run on the same day changes nothing.
 */
export function mergeRows(history: Row[], day: Row[]): { rows: Row[]; added: number } {
  const recorded = new Set(history.map((r) => r.date));
  if (day.some((r) => recorded.has(r.date))) return { rows: history, added: 0 };
  return { rows: [...history, ...day], added: day.length };
}

/**
 * @param groups snapshots per key, in date order
 */
function withDeltas<T extends { downloads: number }>(
  groups: Map<string, T[]>,
  make: (key: string, item: T) => Omit<T, "delta">,
) {
  const out: (T & { delta: number | null })[] = [];
  for (const [key, items] of groups) {
    let prev: number | null = null;
    for (const item of items) {
      out.push({
        ...make(key, item),
        delta: prev === null ? null : item.downloads - prev,
      } as T & { delta: number | null });
      prev = item.downloads;
    }
  }
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, item: T) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/**
 * Totals per release and per day, and each asset's count, each with the change since its own
 * previous snapshot (null on its first).
 */
export function summarise(rows: Row[]): Summary {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const releaseTotals: Map<string, { date: string; tag: string; downloads: number }> = new Map();
  const dayTotals: Map<string, { date: string; downloads: number }> = new Map();
  const assets: Map<string, Row[]> = new Map();
  for (const r of sorted) {
    const key = `${r.date}\n${r.tag}`;
    const rel = releaseTotals.get(key) ?? { date: r.date, tag: r.tag, downloads: 0 };
    rel.downloads += r.downloads;
    releaseTotals.set(key, rel);
    const day = dayTotals.get(r.date) ?? { date: r.date, downloads: 0 };
    day.downloads += r.downloads;
    dayTotals.set(r.date, day);
    push(assets, `${r.tag}\n${r.asset}`, r);
  }
  const perRelease: Map<string, { date: string; tag: string; downloads: number }[]> = new Map();
  for (const rel of releaseTotals.values()) push(perRelease, rel.tag, rel);

  const order = (a: { date: string; tag: string }, b: { date: string; tag: string }) =>
    a.date.localeCompare(b.date) || byName(a.tag, b.tag);
  const releases = withDeltas(perRelease, (_k, r) => ({ ...r })).sort(order);
  const assetDays = withDeltas(assets, (_k, r) => ({ ...r }))
    .sort((a, b) => order(a, b) || byName(a.asset, b.asset))
    .map(({ date, tag, asset, downloads, delta }) => ({ date, tag, asset, downloads, delta }));
  const days = withDeltas(new Map([["", [...dayTotals.values()]]]), (_k, d) => ({ ...d }));
  return { releases, assets: assetDays, days };
}

const signed = (delta: number | null) =>
  delta === null ? "" : delta > 0 ? `+${delta}` : String(delta);

/**
 * The summary as text, newest day first: Markdown tables for a job summary, or aligned columns.
 */
export function formatSummary(
  summary: Summary,
  opts: { markdown?: boolean; assets?: boolean } = {},
): string {
  const newestFirst = (a: { date: string }, b: { date: string }) => b.date.localeCompare(a.date);
  // Array sort is stable, so the release and asset order within a day stays.
  const releases = [...summary.releases].sort(newestFirst);
  const assets = [...summary.assets].sort(newestFirst);
  const days = [...summary.days].sort(newestFirst);
  if (opts.markdown) {
    const out = ["| Date | Release | Downloads | Change |", "| --- | --- | ---: | ---: |"];
    for (const r of releases)
      out.push(`| ${r.date} | ${r.tag} | ${r.downloads} | ${signed(r.delta)} |`);
    if (opts.assets) {
      out.push(
        "",
        "| Date | Release | Asset | Downloads | Change |",
        "| --- | --- | --- | ---: | ---: |",
      );
      for (const a of assets)
        out.push(`| ${a.date} | ${a.tag} | ${a.asset} | ${a.downloads} | ${signed(a.delta)} |`);
    }
    return out.join("\n") + "\n";
  }
  const tagWidth = Math.max(0, ...summary.releases.map((r) => r.tag.length));
  const assetWidth = Math.max(0, ...summary.assets.map((a) => a.asset.length));
  const nums = (n: number, delta: number | null) =>
    `${String(n).padStart(8)}  ${signed(delta).padStart(6)}`;
  const out = ["All releases"];
  for (const d of days) out.push(`${d.date}  ${nums(d.downloads, d.delta)}`.trimEnd());
  out.push("", "Per release");
  for (const r of releases)
    out.push(`${r.date}  ${r.tag.padEnd(tagWidth)}  ${nums(r.downloads, r.delta)}`.trimEnd());
  if (opts.assets) {
    out.push("", "Per asset");
    for (const a of assets) {
      const name = `${a.tag.padEnd(tagWidth)}  ${a.asset.padEnd(assetWidth)}`;
      out.push(`${a.date}  ${name}  ${nums(a.downloads, a.delta)}`.trimEnd());
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Every release of the repository, following the pages.
 * @param repo owner/name
 * @param opts `api` is the REST API's base URL (the runner's GITHUB_API_URL), api.github.com by
 *   default
 */
export async function fetchReleases(
  repo: string,
  opts: { token?: string; api?: string; fetch?: typeof fetch } = {},
): Promise<Release[]> {
  const get = opts.fetch ?? fetch;
  const api = (opts.api ?? "https://api.github.com").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const all: Release[] = [];
  for (let page = 1; ; page++) {
    const url = `${api}/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    const res = await get(url, { headers });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as Release[];
    all.push(...batch);
    if (batch.length < PER_PAGE) return all;
  }
}

const USAGE = `usage:
  downloads.ts collect --repo <owner/name> [--date YYYY-MM-DD] > <day.csv>
  downloads.ts merge --csv <downloads.csv> --day <day.csv>
  downloads.ts summary --csv <downloads.csv> [--assets] [--markdown]`;

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      date: { type: "string" },
      csv: { type: "string" },
      day: { type: "string" },
      assets: { type: "boolean" },
      markdown: { type: "boolean" },
    },
    strict: true,
  });
  if (command === "collect" && values.repo) {
    const date = values.date ?? new Date().toISOString().slice(0, 10);
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
    const api = process.env.GITHUB_API_URL || undefined;
    const rows = assetRows(await fetchReleases(values.repo, { token, api }), date);
    // The CSV goes to stdout, so this script never writes fetched data to a path of its own
    // choosing; the caller redirects it.
    process.stdout.write(toCsv(rows));
    const total = rows.reduce((n, r) => n + r.downloads, 0);
    console.error(`${date}: ${rows.length} assets, ${total} downloads`);
    return 0;
  }
  if (command === "merge" && values.csv && values.day) {
    const day = parseCsv(readFileSync(values.day, "utf8"));
    const { rows, added } = mergeRows(parseCsv(readFileSync(values.csv, "utf8")), day);
    if (added === 0) {
      console.log(`${day[0]?.date ?? "the day"} is already recorded; nothing added`);
      return 0;
    }
    writeFileSync(values.csv, toCsv(rows));
    console.log(`added ${added} rows for ${day[0]?.date}`);
    return 0;
  }
  if (command === "summary" && values.csv) {
    const summary = summarise(parseCsv(readFileSync(values.csv, "utf8")));
    process.stdout.write(formatSummary(summary, values));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : err}`);
      process.exit(err instanceof TypeError && /parseArgs|option/i.test(String(err)) ? 2 : 1);
    },
  );
}

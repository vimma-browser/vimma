#!/usr/bin/env node
/**
 * The Discord announcement of a published release (docs/runbook/ci-releases.md, "Release
 * announcements on Discord"; docs/security/16-update-check.md UP15). update-publish.yml's
 * `announce` job runs it once the Linux release's update manifest is live on updates.vimma.dev.
 *
 * The release's name and notes are text anyone who can edit a release controls, so they reach
 * Discord only as data: the payload asks Discord to parse no mention (`allowed_mentions`), and
 * `@everyone`, `@here` and `<@…>` are broken up besides. The release link is built from the tag,
 * never taken from the JSON.
 *
 * Usage:
 *   discord-announce.ts build --release FILE [--out FILE]
 *       FILE is `gh release view TAG --json tagName,name,body,url,isDraft,isPrerelease`; prints
 *       the webhook payload (a dry run), or writes it to --out. A draft or a pre-release gets a
 *       notice and no payload.
 *   discord-announce.ts post --payload FILE [--dry-run]
 *       posts the payload to $DISCORD_WEBHOOK_URL; unset, it exits 0 with a notice. --dry-run
 *       prints the payload and posts nothing.
 *   discord-announce.ts offered --tag vX.Y.Z --published FILE...
 *       prints offered=true when a published update manifest (a missing file is none) already
 *       offers the tag, offered=false otherwise, for $GITHUB_OUTPUT.
 * Node built-ins only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { publishedState } from "../update/manifest.ts";

export const REPO = "vimma-browser/vimma";
export const INSTALL_URL = "https://vimma.dev/install/";
/** Discord's limit for an embed's description is 4096 characters. */
export const DESCRIPTION_LIMIT = 4096;
/** One changelog line longer than this is shortened at a word. */
const ITEM_LIMIT = 300;

/** The release-please sections users read; Documentation, CI and the like are hidden there. */
const SECTIONS = new Set([
  "⚠ BREAKING CHANGES",
  "Security",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
]);
/** The version entry's heading, as release-please and the Firefox note write it. */
const VERSION_HEADING = /^## \[?\d+\.\d+\.\d+\]?[\s(]/;
const TITLE = /^Vimma (\d+\.\d+\.\d+) · Firefox (\d+\.\d+(?:\.\d+)?)$/;
const TAG = /^v(\d+\.\d+\.\d+)$/;

export type Release = {
  tagName: string;
  name: string;
  body: string;
  url?: string;
  isDraft: boolean;
  isPrerelease: boolean;
};

export type Payload = {
  content: string;
  allowed_mentions: { parse: string[] };
  embeds: { title: string; url: string; description: string }[];
};

/**
 * The version and Firefox version of a release named `Vimma X.Y.Z · Firefox N` (spec
 * firefox-versions, decision 3); another name gives the tag's version and no Firefox version.
 * @throws when the tag is not vX.Y.Z, or the name names another version
 */
export function parseTitle(name: string, tag: string): { version: string; firefox: string | null } {
  const version = TAG.exec(tag)?.[1];
  if (!version) throw new Error(`'${tag}' is not a vX.Y.Z release tag`);
  const named = /^Vimma (\S+)/.exec(name.trim())?.[1];
  if (named && named !== version) {
    throw new Error(`the release's name names ${named}, but its tag is ${tag}`);
  }
  return { version, firefox: TITLE.exec(name.trim())?.[2] ?? null };
}

/**
 * A changelog item as one line: its continuation lines joined, release-please's pull request,
 * commit and `closes` links dropped (noise in a chat message), other links kept.
 */
function plainItem(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .join(" ")
    .replace(/^[*-] /, "")
    .replace(/,? closes (?:\[#\d+\]\([^)\s]*\)(?:, )?)+/g, "")
    .replace(/ \(\[(?:#\d+|[0-9a-f]{7,40})\]\([^)\s]*\)\)/g, "")
    .trim();
}

/**
 * The user-facing sections of the notes' version entry, in the notes' order. Text above the
 * entry (the update steps) and any heading that is not a changelog section (the third-party
 * notice release.yml appends) are left out.
 */
export function changelogSections(body: string): { name: string; items: string[] }[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => VERSION_HEADING.test(l));
  if (start < 0) return [];
  const sections: { name: string; items: string[] }[] = [];
  let current: { name: string; items: string[] } | null = null;
  let item: string[] | null = null;
  const flush = () => {
    if (current && item) current.items.push(plainItem(item));
    item = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1] as string;
      current = SECTIONS.has(name) ? { name, items: [] } : null;
      if (current) sections.push(current);
      else if (!["Documentation", "Tests", "Build", "CI", "Miscellaneous"].includes(name)) break;
      continue;
    }
    if (/^[*-] /.test(line)) {
      flush();
      item = [line];
    } else if (item && /^\s+\S/.test(line)) {
      item.push(line);
    } else {
      flush();
    }
  }
  flush();
  return sections.filter((s) => s.items.length > 0);
}

/** Text that cannot mention anyone, even if Discord's allowed_mentions were ignored. */
function noMentions(text: string): string {
  return text.replace(/@(everyone|here)/gi, "@​$1").replace(/<@/g, "<​@");
}

function shorten(line: string): string {
  if (line.length <= ITEM_LIMIT) return line;
  const cut = line.slice(0, ITEM_LIMIT - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > ITEM_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The webhook payload announcing `release`, or why it gets none (a draft or a pre-release).
 */
export function announcement(release: Release): { skip: string } | { payload: Payload } {
  if (release.isDraft) return { skip: `${release.tagName} is a draft` };
  if (release.isPrerelease) return { skip: `${release.tagName} is a pre-release` };
  const { version, firefox } = parseTitle(release.name ?? "", release.tagName);
  const url = `https://github.com/${REPO}/releases/tag/v${version}`;
  const footer = `[Full release notes](${url}) · [Install Vimma](${INSTALL_URL})`;

  const blocks: string[] = [];
  const sections = changelogSections(release.body ?? "");
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  // Room for the footer and the "And N more" line, whose number has at most four digits.
  const more = (n: number) => `And ${n} more in the full release notes.`;
  const budget = DESCRIPTION_LIMIT - footer.length - more(9999).length - 4;
  let used = 0;
  let shown = 0;
  outer: for (const s of sections) {
    const head = `**${s.name}**`;
    const lines: string[] = [];
    for (const raw of s.items) {
      const line = `- ${shorten(noMentions(raw))}`;
      // Each block is joined by a blank line; each line by a newline.
      const cost = line.length + 1 + (lines.length === 0 ? head.length + 2 : 0);
      if (used + cost > budget) {
        if (lines.length) blocks.push([head, ...lines].join("\n"));
        break outer;
      }
      used += cost;
      lines.push(line);
      shown++;
    }
    blocks.push([head, ...lines].join("\n"));
  }
  if (shown < total) blocks.push(more(total - shown));
  blocks.push(footer);

  const title = firefox ? `Vimma ${version} · Firefox ${firefox}` : `Vimma ${version}`;
  return {
    payload: {
      content: `Vimma ${version} is available.`,
      allowed_mentions: { parse: [] },
      embeds: [{ title, url, description: blocks.join("\n\n") }],
    },
  };
}

const WEBHOOK =
  /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

/**
 * A Discord channel webhook URL, checked so the payload goes to Discord alone.
 * @throws without the value in the message: it is a secret
 */
export function webhookUrl(value: string): URL {
  if (!WEBHOOK.test(value)) throw new Error("DISCORD_WEBHOOK_URL is not a Discord webhook URL");
  return new URL(value);
}

/**
 * Posts `payload` and returns the message's ID. Tries once more after a 429, which Discord sends
 * before it posts anything; never after another error, which may have posted already.
 * @throws on an error answer, naming its status, never the URL
 */
export async function postAnnouncement(
  payload: object,
  url: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const target = new URL(url);
  target.searchParams.set("wait", "true");
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(target.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
    });
    const text = await res.text();
    if (res.status === 429 && attempt === 1) {
      const wait = Number((JSON.parse(text || "{}") as { retry_after?: number }).retry_after);
      await new Promise((r) =>
        setTimeout(r, Math.min(Number.isFinite(wait) ? wait : 1, 30) * 1000),
      );
      continue;
    }
    if (!res.ok) throw new Error(`Discord answered ${res.status}: ${text.slice(0, 200)}`);
    return String((JSON.parse(text || "{}") as { id?: string }).id ?? "");
  }
}

/** True when any published manifest already offers `tag`'s version. */
export function alreadyOffered(tag: string, published: (string | null)[]): boolean {
  const version = TAG.exec(tag)?.[1];
  if (!version) throw new Error(`'${tag}' is not a vX.Y.Z release tag`);
  return published.some((text) => publishedState(text)?.version === version);
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      release: { type: "string" },
      out: { type: "string" },
      payload: { type: "string" },
      "dry-run": { type: "boolean" },
      tag: { type: "string" },
      published: { type: "string", multiple: true },
    },
  });
  if (command === "build" && values.release) {
    const result = announcement(JSON.parse(readFileSync(values.release, "utf8")) as Release);
    if ("skip" in result) {
      console.error(`::notice::no announcement: ${result.skip}`);
      return;
    }
    const json = `${JSON.stringify(result.payload, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);
    return;
  }
  if (command === "post" && values.payload) {
    const payload = JSON.parse(readFileSync(values.payload, "utf8")) as Partial<Payload>;
    if (JSON.stringify(payload.allowed_mentions) !== JSON.stringify({ parse: [] })) {
      throw new Error('the payload must set allowed_mentions to {"parse": []}');
    }
    if (values["dry-run"]) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    const secret = process.env.DISCORD_WEBHOOK_URL ?? "";
    if (secret === "") {
      console.log("::notice::DISCORD_WEBHOOK_URL is not set; the release is not announced");
      return;
    }
    const id = await postAnnouncement(payload, webhookUrl(secret));
    console.log(`posted the announcement (message ${id})`);
    return;
  }
  if (command === "offered" && values.tag) {
    const texts = (values.published ?? []).map((f) =>
      existsSync(f) ? readFileSync(f, "utf8") : null,
    );
    console.log(`offered=${alreadyOffered(values.tag, texts)}`);
    return;
  }
  throw new Error(
    "usage: discord-announce.ts build --release FILE [--out FILE] | " +
      "post --payload FILE [--dry-run] | offered --tag vX.Y.Z --published FILE...",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

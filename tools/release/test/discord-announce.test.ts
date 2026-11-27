import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.ts";
import {
  DESCRIPTION_LIMIT,
  INSTALL_URL,
  alreadyOffered,
  announcement,
  changelogSections,
  parseTitle,
  postAnnouncement,
  webhookUrl,
} from "../discord-announce.ts";
import { buildManifest } from "../../update/manifest.ts";

// docs/runbook/ci-releases.md, "Release announcements on Discord", and docs/security/
// 16-update-check.md UP15: update-publish.yml's announce job posts each stable release to the
// Discord announcement channel once its update is live. The release's name and notes are text
// anyone who can edit a release controls, so they reach Discord as data that can mention no one.

type Release = {
  tagName: string;
  name: string;
  body: string;
  url: string;
  isDraft: boolean;
  isPrerelease: boolean;
};

const fixture = (): Release =>
  JSON.parse(
    readFileSync(new URL("./fixtures/release-v0.1.25.json", import.meta.url), "utf8"),
  ) as Release;

const RELEASE_URL = "https://github.com/vimma-browser/vimma/releases/tag/v0.1.25";

/** A release-please item line, with its pull request, commit and closed-issue links. */
const item = (scope: string, text: string, n: number) =>
  `* **${scope}:** ${text} ([#${n}](https://github.com/vimma-browser/vimma/issues/${n})) ` +
  `([abc1234](https://github.com/vimma-browser/vimma/commit/abc1234${"0".repeat(33)})), ` +
  `closes [#${n - 1}](https://github.com/vimma-browser/vimma/issues/${n - 1})`;

const release = (body: string, over: Partial<Release> = {}): Release => ({
  tagName: "v0.2.0",
  name: "Vimma 0.2.0 · Firefox 162.0",
  body,
  url: "https://github.com/vimma-browser/vimma/releases/tag/v0.2.0",
  isDraft: false,
  isPrerelease: false,
  ...over,
});

const entry = (...sections: string[]) =>
  [
    "### Updating",
    "",
    "- **Linux:** `:update` shows the command.",
    "",
    "## [0.2.0](https://github.com/vimma-browser/vimma/compare/v0.1.25...v0.2.0) · Firefox 162.0 (2026-12-03)",
    "",
    "",
    ...sections,
    "### Third-party notice",
    "",
    "The AppImage starts with the unmodified AppImage type-2 runtime.",
    "",
  ].join("\n");

/** The embed of an announcement that is not skipped. */
function embedOf(r: Release) {
  const a = announcement(r);
  if ("skip" in a) throw new Error(`skipped: ${a.skip}`);
  const embed = a.payload.embeds[0];
  if (!embed) throw new Error("no embed");
  return { payload: a.payload, embed };
}

describe("parseTitle", () => {
  it("reads the version and the Firefox version from the release's name", () => {
    expect(parseTitle("Vimma 0.1.25 · Firefox 161.0", "v0.1.25")).toEqual({
      version: "0.1.25",
      firefox: "161.0",
    });
    expect(parseTitle("Vimma 1.2.3 · Firefox 161.0.1", "v1.2.3")).toEqual({
      version: "1.2.3",
      firefox: "161.0.1",
    });
  });

  it("falls back to the tag's version, without a Firefox version, for another name", () => {
    expect(parseTitle("v0.1.25", "v0.1.25")).toEqual({ version: "0.1.25", firefox: null });
    expect(parseTitle("", "v0.1.25")).toEqual({ version: "0.1.25", firefox: null });
  });

  it("refuses a name whose version is not the tag's, and a tag that is not vX.Y.Z", () => {
    expect(() => parseTitle("Vimma 0.1.24 · Firefox 161.0", "v0.1.25")).toThrow(
      /0\.1\.24.*v0\.1\.25/,
    );
    expect(() => parseTitle("Vimma 0.1.25 · Firefox 161.0", "nightly")).toThrow(/vX\.Y\.Z/);
    expect(() => parseTitle("Vimma 0.1.25 · Firefox 161.0", "v0.1.25-rc1")).toThrow(/vX\.Y\.Z/);
  });
});

describe("changelogSections", () => {
  it("takes the version entry's sections and lines, without links, from the 0.1.25 notes", () => {
    const sections = changelogSections(fixture().body);
    expect(sections.map((s) => s.name)).toEqual(["Added", "Fixed"]);
    expect(sections[0]?.items).toEqual([
      "**copy-mode:** gy copies the url of the link under the caret or the selection",
      "**mcp:** separate configurable rates for new agent tabs and loads into a tab",
    ]);
    expect(sections[1]?.items).toHaveLength(8);
    expect(sections[1]?.items[0]).toBe(
      "**bookmarks:** a private window's change during an apply is not written",
    );
  });

  it("leaves out the update steps above the entry and the third-party notice below it", () => {
    const text = JSON.stringify(changelogSections(fixture().body));
    expect(text).not.toMatch(/brew upgrade|AppImage|Third-party|libfuse/);
  });

  it("keeps Security, breaking changes, Added, Changed, Removed and Fixed in the notes' order", () => {
    const body = entry(
      "### ⚠ BREAKING CHANGES",
      "",
      item("keys", "ctrl+b x closes the pane", 10),
      "",
      "### Security",
      "",
      "- Firefox 162.0 fixes MFSA 2026-140.",
      "",
      "### Changed",
      "",
      item("upstream", "firefox 162.0", 12),
      "",
      "### Removed",
      "",
      item("tabs", "the old picker", 14),
      "",
    );
    expect(changelogSections(body)).toEqual([
      { name: "⚠ BREAKING CHANGES", items: ["**keys:** ctrl+b x closes the pane"] },
      { name: "Security", items: ["Firefox 162.0 fixes MFSA 2026-140."] },
      { name: "Changed", items: ["**upstream:** firefox 162.0"] },
      { name: "Removed", items: ["**tabs:** the old picker"] },
    ]);
  });

  it("joins a hand-written item's continuation lines and keeps its own links", () => {
    const body = entry(
      "### Added",
      "",
      "- Workspaces show their colour in the",
      "  [status bar](https://github.com/vimma-browser/vimma/blob/main/docs/guide.md#status-bar).",
      item("tabs", "gt moves right", 20),
      "",
    );
    expect(changelogSections(body)).toEqual([
      {
        name: "Added",
        items: [
          "Workspaces show their colour in the [status bar](https://github.com/vimma-browser/vimma/blob/main/docs/guide.md#status-bar).",
          "**tabs:** gt moves right",
        ],
      },
    ]);
  });

  it("leaves out sections release-please hides, such as Documentation and CI", () => {
    const body = entry(
      "### Fixed",
      "",
      item("keys", "f7 asks once", 30),
      "",
      "### Documentation",
      "",
      item("guide", "a new page", 32),
      "",
      "### CI",
      "",
      item("e2e", "faster", 34),
      "",
    );
    expect(changelogSections(body).map((s) => s.name)).toEqual(["Fixed"]);
  });

  it("gives nothing for notes without a version entry", () => {
    expect(changelogSections("Just some text.\n\n### Added\n\n* a thing\n")).toEqual([]);
  });
});

describe("announcement", () => {
  it("announces 0.1.25 with its Firefox version, its lines and links to the notes and the install page", () => {
    const { payload, embed } = embedOf(fixture());
    expect(payload.content).toBe("Vimma 0.1.25 is available.");
    expect(embed.title).toBe("Vimma 0.1.25 · Firefox 161.0");
    expect(embed.url).toBe(RELEASE_URL);
    expect(embed.description).toContain(
      "**Added**\n- **copy-mode:** gy copies the url of the link under the caret or the selection\n",
    );
    expect(embed.description).toContain("**Fixed**\n- **bookmarks:**");
    expect(
      embed.description.endsWith(
        `[Full release notes](${RELEASE_URL}) · [Install Vimma](${INSTALL_URL})`,
      ),
    ).toBe(true);
    expect(INSTALL_URL).toBe("https://vimma.dev/install/");
  });

  it("mentions no one: allowed_mentions parses nothing, and mention text is broken up", () => {
    const body = entry(
      "### Fixed",
      "",
      "- @everyone and @here see <@123456789012345678> and <@&987654321098765432>.",
      "",
    );
    const { payload, embed } = embedOf(
      release(body, { name: "Vimma 0.2.0 · Firefox 162.0 @everyone" }),
    );
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const all = JSON.stringify(payload);
    expect(all).not.toMatch(/@everyone|@here|<@\d|<@&/);
    expect(embed.description).toContain("@\u200beveryone and @\u200bhere");
  });

  it("skips a draft and a pre-release", () => {
    expect(announcement({ ...fixture(), isDraft: true })).toEqual({ skip: "v0.1.25 is a draft" });
    expect(announcement({ ...fixture(), isPrerelease: true })).toEqual({
      skip: "v0.1.25 is a pre-release",
    });
  });

  it("builds the release link from the tag, whatever url the release JSON gives", () => {
    const { embed } = embedOf({ ...fixture(), url: "https://example.com/phish" });
    expect(embed.url).toBe(RELEASE_URL);
    expect(JSON.stringify(embed)).not.toContain("example.com");
  });

  it("stays within Discord's description limit, cutting at a whole line and saying how many are left", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      item("scope", `change number ${i} ${"word ".repeat(12)}`, 1000 + i),
    );
    const { embed } = embedOf(release(entry("### Fixed", "", ...many, "")));
    expect(embed.description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(DESCRIPTION_LIMIT).toBeLessThanOrEqual(4096);
    const shown = embed.description.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(120);
    expect(embed.description).toContain(`\nAnd ${120 - shown} more in the full release notes.\n`);
    expect(embed.description).toMatch(/\[Install Vimma\]\(https:\/\/vimma\.dev\/install\/\)$/);
  });

  it("shortens one very long line at a word, with an ellipsis", () => {
    const body = entry("### Added", "", `- ${"longword ".repeat(100)}end`, "");
    const { embed } = embedOf(release(body));
    const line = embed.description.split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(line.length).toBeLessThanOrEqual(302);
    expect(line).toMatch(/longword…$/);
  });

  it("never cuts a line inside an emoji's surrogate pair", () => {
    const body = entry("### Added", "", `- ${"a".repeat(298)}${"\u{1F600}".repeat(5)}`, "");
    const { embed } = embedOf(release(body));
    expect(embed.description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("names the release by its tag when the name has no Firefox version", () => {
    const { embed } = embedOf(release(entry("### Fixed", "", item("a", "b", 2), ""), { name: "" }));
    expect(embed.title).toBe("Vimma 0.2.0");
  });

  it("still links the notes when there are no changelog lines", () => {
    const { embed } = embedOf(release("Notes without an entry."));
    expect(embed.description).toBe(
      "[Full release notes](https://github.com/vimma-browser/vimma/releases/tag/v0.2.0) · " +
        `[Install Vimma](${INSTALL_URL})`,
    );
  });
});

describe("webhookUrl", () => {
  it("accepts a Discord channel webhook URL", () => {
    const u = "https://discord.com/api/webhooks/123456789012345678/abc_DEF-123";
    expect(webhookUrl(u).href).toBe(u);
    expect(webhookUrl("https://discordapp.com/api/webhooks/1/x").host).toBe("discordapp.com");
  });

  it("refuses any other host, scheme or path, without echoing the value", () => {
    for (const bad of [
      "http://discord.com/api/webhooks/1/x",
      "https://discord.com.evil.example/api/webhooks/1/x",
      "https://evil.example/api/webhooks/1/x",
      "https://discord.com/api/webhooks/1/x/slack",
      "https://discord.com/api/webhooks/1/x?thread_id=2",
      "https://user@discord.com/api/webhooks/1/x",
      " https://discord.com/api/webhooks/1/x",
      "secret-token-value",
    ]) {
      expect(() => webhookUrl(bad), bad).toThrow(/not a Discord webhook URL/);
      try {
        webhookUrl(bad);
      } catch (e) {
        expect(String(e)).not.toContain(bad.trim());
      }
    }
  });
});

describe("postAnnouncement", () => {
  const url = webhookUrl("https://discord.com/api/webhooks/1/secret-token");
  const payload = { content: "x", allowed_mentions: { parse: [] as string[] } };

  it("posts the payload as JSON and waits for Discord's answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), init: init ?? {} });
      return new Response(JSON.stringify({ id: "42" }), { status: 200 });
    };
    expect(await postAnnouncement(payload, url, fake as typeof fetch)).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/webhooks/1/secret-token?wait=true");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(payload);
  });

  it("fails on an error answer without naming the webhook's token", async () => {
    const fake = async () => new Response('{"message": "Unknown Webhook"}', { status: 404 });
    const err = await postAnnouncement(payload, url, fake as typeof fetch).catch((e) => e);
    expect(String(err)).toMatch(/404/);
    expect(String(err)).not.toContain("secret-token");
  });

  it("tries once more after a rate limit, which Discord answers before it posts anything", async () => {
    let n = 0;
    const fake = async () =>
      ++n === 1
        ? new Response('{"retry_after": 0.01}', { status: 429 })
        : new Response('{"id": "7"}', { status: 200 });
    expect(await postAnnouncement(payload, url, fake as typeof fetch)).toBe("7");
    expect(n).toBe(2);
  });

  it("fails a network error without naming the webhook's token", async () => {
    const fake = async () => {
      throw new TypeError("fetch failed");
    };
    const err = await postAnnouncement(payload, url, fake as typeof fetch).catch((e) => e);
    expect(String(err)).toMatch(/fetch failed/);
    expect(String(err)).not.toContain("secret-token");
  });

  it("counts a 2xx whose body is not JSON as posted, so a re-run never posts twice", async () => {
    const fake = async () => new Response("<html>ok</html>", { status: 200 });
    expect(await postAnnouncement(payload, url, fake as typeof fetch)).toBe("");
  });

  it("tries once more after a 429 whose body is not JSON", async () => {
    let n = 0;
    const fake = async () =>
      ++n === 1
        ? new Response("<html>slow down</html>", { status: 429, headers: { "retry-after": "0" } })
        : new Response('{"id": "8"}', { status: 200 });
    expect(await postAnnouncement(payload, url, fake as typeof fetch)).toBe("8");
  });

  it("never tries again after a server error, which may have posted already", async () => {
    let n = 0;
    const fake = async () => {
      n++;
      return new Response("", { status: 502 });
    };
    await expect(postAnnouncement(payload, url, fake as typeof fetch)).rejects.toThrow(/502/);
    expect(n).toBe(1);
  });
});

describe("alreadyOffered", () => {
  // The Linux manifest updates.vimma.dev served once 0.1.25 was published.
  const served = readFileSync(
    new URL("./fixtures/update-linux-v0.1.25.xml", import.meta.url),
    "utf8",
  );
  // Read, not verified (publishedState), so the served file's signature line will do.
  const signature = served.trimEnd().split("\n").pop() ?? "";
  const nothing = `${buildManifest({ serial: "20261127045724", update: null })}${signature}\n`;

  it("is true when either published copy already offered the tag before this run", () => {
    expect(alreadyOffered("v0.1.25", [served, null])).toBe(true);
    expect(alreadyOffered("v0.1.25", [nothing, served])).toBe(true);
  });

  it("is false for a first publish, a manifest that offers nothing, or no published copy", () => {
    expect(alreadyOffered("v0.1.26", [served, served])).toBe(false);
    expect(alreadyOffered("v0.1.25", [nothing])).toBe(false);
    expect(alreadyOffered("v0.1.25", [null, null])).toBe(false);
  });

  it("offered prints the line for $GITHUB_OUTPUT, a missing file being no published copy", () => {
    const dir = tempDir("vimma-discord-");
    writeFileSync(join(dir, "served.xml"), served);
    const script = fileURLToPath(new URL("../discord-announce.ts", import.meta.url));
    const run = (tag: string) =>
      spawnSync(
        process.execPath,
        [
          script,
          "offered",
          "--tag",
          tag,
          "--published",
          join(dir, "served.xml"),
          "--published",
          join(dir, "repo.xml"),
        ],
        { encoding: "utf8" },
      );
    expect(run("v0.1.25").stdout).toBe("offered=true\n");
    expect(run("v0.1.26").stdout).toBe("offered=false\n");
  });
});

describe("the CLI", () => {
  const script = fileURLToPath(new URL("../discord-announce.ts", import.meta.url));
  const run = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, DISCORD_WEBHOOK_URL: undefined, ...env },
    });

  // The post path builds the payload in memory from $RELEASE_JSON and reads no file, so no file
  // content flows into the request (CodeQL js/file-access-to-http).
  const release = (over: object = {}) => JSON.stringify({ ...fixture(), ...over });
  const webhook = "https://discord.com/api/webhooks/1/secret-token";

  it("post --dry-run builds the payload from $RELEASE_JSON, prints it and posts nothing", () => {
    const res = run(["post", "--dry-run"], {
      RELEASE_JSON: release(),
      DISCORD_WEBHOOK_URL: webhook,
    });
    expect(res.status, res.stderr).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload).toEqual(embedOf(fixture()).payload);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(res.stdout + res.stderr).not.toContain("secret-token");
  });

  it("post announces nothing for a pre-release or a draft, and says why", () => {
    for (const [over, why] of [
      [{ isPrerelease: true }, "is a pre-release"],
      [{ isDraft: true }, "is a draft"],
    ] as const) {
      const res = run(["post"], { RELEASE_JSON: release(over), DISCORD_WEBHOOK_URL: webhook });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain(`::notice::no announcement: v0.1.25 ${why}`);
    }
  });

  it("post exits 0 with a notice while DISCORD_WEBHOOK_URL is unset", () => {
    for (const env of [{}, { DISCORD_WEBHOOK_URL: "" }]) {
      const res = run(["post"], { RELEASE_JSON: release(), ...env });
      expect(res.status).toBe(0);
      expect(res.stdout + res.stderr).toContain("::notice::DISCORD_WEBHOOK_URL is not set");
    }
  });

  it("post fails without $RELEASE_JSON, and takes no payload or release file", () => {
    expect(run(["post", "--dry-run"]).stderr).toContain("RELEASE_JSON");
    const dir = tempDir("vimma-discord-");
    const file = join(dir, "payload.json");
    writeFileSync(file, JSON.stringify(embedOf(fixture()).payload));
    expect(run(["post", "--payload", file, "--dry-run"]).status).toBe(1);
    expect(run(["build", "--release", file]).status).toBe(1);
  });
});

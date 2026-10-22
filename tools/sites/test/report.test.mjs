import { describe, expect, it } from "vitest";
import { CHECKS } from "../results.mjs";
import { renderHtml, renderMarkdown, summaryLine } from "../report.mjs";

/** @param {string} id @param {string} status @param {string} [reason] */
const c = (id, status, reason) => ({ id, status, ...(reason ? { reason } : {}) });
const allPass = () => CHECKS.map((id) => c(id, id === "shortcuts" ? "info" : "pass"));

/** @returns {any} */
function run() {
  return {
    startedAt: "2026-10-12T10:00:00.000Z",
    finishedAt: "2026-10-12T10:20:00.000Z",
    network: "local",
    build: "/x/dist/bin/vimma",
    commit: "abc1234",
    harnessError: null,
    sites: [
      {
        id: "wikipedia",
        name: "Wikipedia",
        url: "https://en.wikipedia.org/wiki/Vim_(text_editor)",
        status: "ok",
        checks: allPass().map((x) =>
          x.id === "shortcuts" ? { ...x, reason: "site handles: none", details: { keys: [] } } : x,
        ),
        loadMs: 812,
        latency: { j: 31, f: 74, yy: 22, follow: 640 },
        screenshots: [{ label: "load", file: "wikipedia-1-load.png" }],
        durationMs: 30_000,
      },
      {
        id: "github-repo",
        name: "GitHub <repo>",
        url: "https://github.com/neovim/neovim",
        status: "fail",
        checks: allPass().map((x) =>
          x.id === "hints"
            ? c("hints", "fail", "no label <b>")
            : x.id === "shortcuts"
              ? { ...x, reason: "site handles: s, t", details: { keys: ["s", "t"] } }
              : x,
        ),
        loadMs: 1500,
        latency: { j: 40 },
        screenshots: [],
        durationMs: 40_000,
      },
      {
        id: "reddit",
        name: "Reddit",
        url: "https://www.reddit.com/r/vim/",
        status: "blocked",
        block: { kind: "bot-check", reason: "Reddit block" },
        checks: CHECKS.map((id) => c(id, "skip", "blocked (bot check): Reddit block")),
        latency: {},
        screenshots: [{ label: "load", file: "reddit-1-load.png" }],
        durationMs: 9000,
      },
    ],
  };
}

describe("summaryLine", () => {
  it("counts sites by status, with the bot checks named as such", () => {
    expect(summaryLine(run())).toBe(
      "3 sites: 1 ok, 1 fail, 1 blocked (bot check), 0 consent, 0 error.",
    );
  });
});

describe("renderMarkdown", () => {
  const md = renderMarkdown(run());

  it("has a header with the date and network, and the summary", () => {
    expect(md).toContain("## Site compatibility, 2026-10-12 (local network)");
    expect(md).toContain("3 sites: 1 ok, 1 fail, 1 blocked (bot check), 0 consent, 0 error.");
  });

  it("has one column per check and one row per site, in run order", () => {
    const lines = md.split("\n");
    const header = lines.find((l) => l.startsWith("| Site |")) ?? "";
    for (const id of CHECKS) expect(header).toContain(`| ${id} `);
    expect(header).toContain("| Load ms | j ms | f ms |");
    const rows = lines.filter((l) => /^\| \[/.test(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(
      /^\| \[Wikipedia\]\(https:\/\/en\.wikipedia\.org\/wiki\/Vim_\(text_editor\)\) \| ok \|/,
    );
    expect(rows[0]).toMatch(/\| 812 \| 31 \| 74 \|$/);
  });

  it("marks pass, fail, skip and info, and shows blocked sites as such", () => {
    const rows = md.split("\n").filter((l) => /^\| \[/.test(l));
    expect(rows[1]).toContain("| fail |");
    expect(rows[1]).toContain("✗");
    expect(rows[2]).toContain("| blocked (bot check) |");
    expect(rows[2]).toMatch(/\| – \| – \|/);
    expect(md).toContain("✓ pass · ✗ fail · – skipped · i info");
  });

  it("lists the failures with their reasons, and the shortcut conflicts", () => {
    expect(md).toContain("- **GitHub \\<repo\\>**, hints: no label \\<b\\>");
    expect(md).toContain("- GitHub \\<repo\\>: s, t");
    expect(md).toContain("- Reddit: blocked (bot check), Reddit block");
  });

  it("escapes pipes in names and reasons so the table holds", () => {
    const r = run();
    r.sites[0].name = "A | B";
    expect(renderMarkdown(r)).toContain("[A \\| B]");
  });
});

describe("renderHtml", () => {
  const html = renderHtml(run());

  it("is a complete document with a title and colour tokens for both themes", () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>Site compatibility</title>");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("escapes page-controlled text", () => {
    expect(html).toContain("GitHub &lt;repo&gt;");
    expect(html).toContain("no label &lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("links the screenshots relative to the report", () => {
    expect(html).toContain('href="screenshots/wikipedia-1-load.png"');
  });

  it("puts each check's reason in its cell's title", () => {
    expect(html).toMatch(/title="hints: no label &lt;b&gt;"/);
  });
});

describe("retried sites (decision 11)", () => {
  it("lists each retried site with both outcomes", () => {
    const r = run();
    r.sites[0].retry = { status: "blocked", block: { kind: "bot-check", reason: "Cloudflare" } };
    const md = renderMarkdown(r);
    expect(md).toContain("### Retried");
    expect(md).toMatch(/- Wikipedia: blocked \(bot check\), then ok on the retry/);
    expect(renderHtml(r)).toContain("retried: blocked (bot check) at first");
  });

  it("has no section when nothing was retried", () => {
    expect(renderMarkdown(run())).not.toContain("### Retried");
  });
});

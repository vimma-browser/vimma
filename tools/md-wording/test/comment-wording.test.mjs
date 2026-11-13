import { describe, expect, test } from "vitest";
import { commentStyle, findCommentWording } from "../comment-wording.mjs";

/**
 * @param {string} src
 * @param {"slash" | "hash"} [style]
 */
const phrases = (src, style = "slash") =>
  findCommentWording(src, style).map((f) => f.phrase.toLowerCase());

describe("findCommentWording", () => {
  test.each([
    ["// Review of #177 (M2): the code the client printed.", "review of #177"],
    ["/** Security review of #182 (finding 3): no hidden folder. */", "security review of #182"],
    [
      "/**\n * a quarantine folder (decision 31 b; security review of #182, finding",
      "security review of #182",
    ],
    [
      "/** How long a download counts (security review, finding 2). */",
      "security review, finding 2",
    ],
    ['// 31; user: "agent should be able to download etc."', 'user: "'],
    ["/// Follow CLAUDE.md exactly.", "claude.md"],
    ["// Vim's scroll keys (user decision 2026-10-10) next to Vimium's.", "user decision"],
    ["// Spec: decision 30 (user, 2026-10-13): pages in the agent workspace", "(user,"],
    ["  foo(); // review of #38: a reconnect loop", "review of #38"],
    ["/* the coordinator assumed it */", "coordinator"],
    ["/** config.toml was read (review of PR #151). */", "review of pr #151"],
    ['  test("neither dialect", () => {}); // (review, PR #151)', "review, pr #151"],
    ['// The user (2026-10-12): "it should be possible"', "user (2026-"],
  ])("flags %j", (src, phrase) => {
    expect(phrases(src)).toEqual([phrase]);
  });

  test("hash comments in shell, YAML and Python", () => {
    expect(phrases("# Security review of #182: keep it", "hash")).toEqual([
      "security review of #182",
    ]);
    expect(phrases("run: echo hi # follow CLAUDE.md", "hash")).toEqual(["claude.md"]);
  });

  test("a phrase broken across comment lines is found, on the line it starts", () => {
    const src = ["const a = 1;", "// Routing was a", "// user", "// decision in October.", "f();"];
    expect(findCommentWording(src.join("\n"), "slash")).toEqual([
      { line: 3, phrase: "user decision" },
    ]);
  });

  test("a block comment's lines without a leading star are comment text", () => {
    const src = ["/*", "  Review of #9 says why.", "*/", "let x;"].join("\n");
    expect(findCommentWording(src, "slash")).toEqual([{ line: 2, phrase: "Review of #9" }]);
  });

  test("code and strings outside comments are not scanned", () => {
    const src = [
      'const why = "Review of #177";',
      "const url = `https://user:pw@${host}:8443/`;",
      'const reasons = { user: "the user denied this request in Vimma" };',
      "const re = /CLAUDE\\.md/;",
      "#private = 1;",
    ].join("\n");
    expect(findCommentWording(src, "slash")).toEqual([]);
    expect(findCommentWording('run: grep "user decision" x', "hash")).toEqual([]);
  });

  test("product wording about the person using Vimma is not process wording", () => {
    const src = [
      "// Every call waits for the user's answer in Vimma, or a grant the user gave.",
      "// A user requests a page with `o`; the user's call, default no.",
    ].join("\n");
    expect(findCommentWording(src, "slash")).toEqual([]);
  });

  test("a marker with a reason exempts its comment block, and only that block", () => {
    const src = [
      '// No "review of #N" in a comment.',
      "// process-wording: this comment states the rule and quotes the banned phrase",
      "const x = 1;",
      "// Review of #4 says so.",
    ].join("\n");
    expect(findCommentWording(src, "slash")).toEqual([{ line: 4, phrase: "Review of #4" }]);
  });

  test("a marker without a reason exempts nothing", () => {
    expect(phrases("// Review of #4. process-wording:")).toEqual(["review of #4"]);
  });
});

describe("commentStyle", () => {
  test.each([
    ["src/browser/base/content/vimma/host/VimmaHost.sys.mjs", "slash"],
    ["tools/arch-lint/arch-lint.ts", "slash"],
    ["tools/vimma-ctl/src/client.rs", "slash"],
    ["src/browser/themes/shared/vimma/statusbar.css", "slash"],
    ["tests/browser/browser_vimma_control.js", "slash"],
    ["tools/lane/lane.sh", "hash"],
    [".github/workflows/ci.yml", "hash"],
    ["tools/upstream/autopilot.py", "hash"],
    ["tools/vimma-ctl/Cargo.toml", "hash"],
    ["docs/guide.md", null],
    ["tests/contract/control/v2/auth.valid.json", null],
  ])("%s is %s", (path, style) => {
    expect(commentStyle(path)).toBe(style);
  });
});

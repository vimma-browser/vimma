import { describe, expect, test } from "vitest";
import { findProcessWording } from "../process-wording.mjs";

/** @param {string} md */
const phrases = (md) => findProcessWording(md).map((f) => f.phrase.toLowerCase());

describe("findProcessWording", () => {
  test.each([
    ["User request: make sure routing works.", "user request"],
    ["Toolbar root (user decision, 2026-10-10).", "user decision"],
    ["The user's decision was to keep it.", "user's decision"],
    ["the user asked for the window itself", "user asked"],
    ["and the user said it should", "user said"],
    ["a user report showed", "user report"],
    ["The user wants instant reload on by default.", "user wants"],
    ["the user chose Swap in place", "user chose"],
    ["the maintainer decided against it", "maintainer decided"],
    ["which the coordinator had assumed", "coordinator"],
    ["## Handover: the stale baseline", "handover"],
    ["(handover for sub-PR 2)", "handover"],
    ["**Flagged for the user:** the rule", "flagged for the user"],
    ["It is what you asked for, and", "you asked for"],
    ["accepted without asking the user", "asking the user"],
    ["(First draft, before the answer.)", "first draft"],
    ["see https://claude.ai/code/session_01Abc for the run", "claude.ai/code/session"],
    ["## The user's words", "user's words"],
    ["## Decided questions (user, 2026-10-11)", "(user,"],
    ["recommendation taken (user: 'deliver that spec')", "(user:"],
    ["- **Decision** (the maintainer): keep it", "(the maintainer)"],
    ["   Answered 2026-10-12: recommendation taken.", "answered 2026-"],
    ["## Review of #38 (2026-10-09)", "review of #38"],
    ["## Security review of #38", "security review of #38"],
    ["- Config shape (review of PR #21): per-site overrides", "review of pr #21"],
    ["a quarantine folder (security review, finding 2)", "security review, finding 2"],
    ["kept (review, PR #151)", "review, pr #151"],
    ["- **Review round 1 (2026-10-09):** the wraps", "review round"],
    ["Review round (PR #31): 15 new tests.", "review round"],
    ["### Follow-up (PR #148 review, screenshots)", "pr #148 review"],
    ["TDD as CLAUDE.md: each test is written first", "claude.md"],
    ["added by the maintainer at merge time (CLAUDE.md), not in the PR", "claude.md"],
    ["kept, as AGENTS.md says, for one release", "agents.md"],
  ])("flags %j", (md, phrase) => {
    expect(phrases(md)).toEqual([phrase]);
  });

  test("a phrase broken across two lines is found, on the line it starts", () => {
    const md = ["# Spec", "", "Routing was a", "user", "request in October."].join("\n");
    expect(findProcessWording(md)).toEqual([{ line: 4, phrase: "user request" }]);
  });

  test("product wording about the person using Vimma is not process wording", () => {
    const md = [
      "Every call waits for the user's answer in Vimma, or runs under a grant the user gave.",
      "Restart restores the previous session; Claude Code starts `vimma-ctl mcp`.",
      "The release job publishes after the first draft release is rehearsed.",
      "The page asked for the whole screen. A user requests a page with `o`.",
      "`mergeWithDefaults(user, order)` merges; it is answered by `id` (the user's choice).",
      "Every PR gets a review; a security review checks #38's socket. Reviewed 2026-10-09.",
      "The `CLAUDE_CODE_OAUTH_TOKEN` secret; `claude.yml` answers `@claude`.",
    ].join("\n");
    expect(findProcessWording(md)).toEqual([]);
  });

  test("a marker with a reason exempts its paragraph, and only that paragraph", () => {
    const md = [
      'No "user request" or "the coordinator" in a spec.',
      "<!-- process-wording: this paragraph states the rule and quotes the banned phrases -->",
      "",
      "The coordinator accepted it.",
    ].join("\n");
    expect(findProcessWording(md)).toEqual([{ line: 4, phrase: "coordinator" }]);
  });

  test("a CLAUDE.md pointer is exempt only with a marker that gives the reason", () => {
    const pointer = "Coding agents follow [CLAUDE.md](CLAUDE.md).";
    expect(phrases(pointer)).toEqual(["claude.md", "claude.md"]);
    const marked = `${pointer} <!-- process-wording: points coding agents at their rules -->`;
    expect(phrases(marked)).toEqual([]);
  });

  test("a marker without a reason exempts nothing", () => {
    const md = "The coordinator accepted it. <!-- process-wording: -->";
    expect(phrases(md)).toEqual(["coordinator"]);
  });
});

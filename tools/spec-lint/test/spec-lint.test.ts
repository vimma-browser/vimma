import { describe, expect, test } from "vitest";
import {
  adrStatusErrors,
  decisionErrors,
  findDecisions,
  hasReason,
  parseSpec,
  specErrors,
} from "../spec-lint.mjs";

/**
 * A spec with the header the template asks for.
 * @param {string} status
 * @param {string} [rest]
 */
const spec = (status, rest = "") =>
  [
    "# Spec: x",
    "",
    `Status: ${status} · Area: \`x.mjs\` · ADR: none`,
    "",
    "Issue: [#241](https://github.com/vimma-browser/vimma/issues/241)",
    "",
    "## Summary",
    "",
    "Text.",
    rest,
  ].join("\n");

describe("parseSpec", () => {
  test("reads the status word, its note and the issues of the header", () => {
    const md = spec("accepted (sub-PR 1 implemented; sub-PR 2: #9)").replace(
      "Issue: [#241](https://github.com/vimma-browser/vimma/issues/241)",
      "Issues: [#241](https://github.com/vimma-browser/vimma/issues/241), #242 and #243",
    );
    expect(parseSpec(md)).toEqual({ status: "accepted", issues: [241, 242, 243] });
  });

  test("a status line wrapped over two lines still gives its first word", () => {
    expect(parseSpec("# Spec: x\n\nStatus: implemented, including\nmore · Area: x\n").status).toBe(
      "implemented",
    );
  });

  test("an Issues line wrapped over several lines gives every issue", () => {
    const md =
      "# Spec: x\n\nStatus: draft\n\nIssues: [#1](u/1), [#2](u/2),\n[#3](u/3)\n\nText #4.\n";
    expect(parseSpec(md).issues).toEqual([1, 2, 3]);
  });

  test("an issue named after the header is not the spec's issue", () => {
    const md = "# Spec: x\n\nStatus: draft\n\n## Design\n\nIssue: #5 tracks the rest.\n";
    expect(parseSpec(md).issues).toEqual([]);
  });

  test("no status line gives null", () => {
    expect(parseSpec("# Spec: x\n\n## Summary\n").status).toBeNull();
  });
});

describe("specErrors", () => {
  test.each(["draft", "accepted", "implemented"])("%s is a valid status", (status) => {
    expect(specErrors(spec(status))).toEqual([]);
  });

  test.each([
    "done",
    "in progress (sub-PR 1 built)",
    "sub-PR 1 implemented (#157); sub-PRs 2 and 3 open",
    "Draft",
    "draft | accepted | implemented",
    "implementedish",
  ])("%j is not", (status) => {
    expect(specErrors(spec(status))).toEqual([
      expect.stringMatching(/^status: .*draft, accepted or implemented/),
    ]);
  });

  test("a note after the word, in parentheses or after a comma or semicolon, is allowed", () => {
    for (const s of ["implemented (core)", "implemented, including x", "implemented; see y"])
      expect(specErrors(spec(s))).toEqual([]);
  });

  test("a spec without a status line fails", () => {
    expect(specErrors("# Spec: x\n\n## Summary\n")).toEqual([
      expect.stringMatching(/^status: no `Status:` line/),
    ]);
  });

  test("a draft or accepted spec must name its issue; an implemented one need not", () => {
    const noIssue = (status) =>
      spec(status).replace(
        "Issue: [#241](https://github.com/vimma-browser/vimma/issues/241)\n",
        "",
      );
    expect(specErrors(noIssue("draft"))).toEqual([expect.stringMatching(/^issue: /)]);
    expect(specErrors(noIssue("accepted"))).toEqual([expect.stringMatching(/^issue: /)]);
    expect(specErrors(noIssue("implemented"))).toEqual([]);
  });
});

describe("adrStatusErrors", () => {
  const adr = (status) => `# ADR-099: X\n\n- Status: ${status}\n- Date: 2026-10-14\n\n## Context\n`;

  test.each([
    "Proposed",
    "Accepted",
    "Accepted (2026-10-09, after the spike)",
    "Accepted; amended by [ADR-012](012-x.md)",
    "Superseded by [ADR-013](013-x.md) (reason)",
    "Deprecated",
    "Rejected",
  ])("%j is valid", (status) => {
    expect(adrStatusErrors(adr(status))).toEqual([]);
  });

  test.each(["accepted", "Done", "In review"])("%j is not", (status) => {
    expect(adrStatusErrors(adr(status))).toEqual([expect.stringMatching(/^status: /)]);
  });

  test("an ADR without a status line fails", () => {
    expect(adrStatusErrors("# ADR-099: X\n\n## Context\n")).toEqual([
      expect.stringMatching(/^status: no `- Status:` line/),
    ]);
  });
});

describe("hasReason", () => {
  test.each([
    "Vimma does X, because Y.",
    "It is cached so that a reload is instant.",
    "The pref defaults off, so a fresh profile never sees it.",
    "Kept, since Firefox already ships it.",
    "Reason: the hello is strict.",
    "For the same reason as decision 2.",
    "It is split in order to keep each PR small.",
  ])("%j gives one", (text) => {
    expect(hasReason(text)).toBe(true);
  });

  test.each([
    "Vimma does X.",
    "It also covers Y.",
    "Keys: `ctrl+b u`. Rejected: `T`.",
    "A sinceless and reasonless word: becauses.",
  ])("%j does not", (text) => {
    expect(hasReason(text)).toBe(false);
  });
});

describe("findDecisions", () => {
  test("numbered items with a bold title in Design and in Decisions sections", () => {
    const md = [
      "## Behaviour",
      "",
      "1. **Not a decision.** Behaviour is a list too.",
      "",
      "## Design",
      "",
      "Data flow, prose.",
      "",
      "1. **First.** Line one",
      "   continues here, because of Y.",
      "   - a nested bullet",
      "",
      "   A second paragraph of the same decision.",
      "2. **Second.** Short.",
      "",
      "A paragraph after the list ends it.",
      "",
      "3. not bold, so a plain list item",
      "",
      "### Decisions",
      "",
      "10. **Tenth.** Under a sub-heading.",
      "",
      "## Tests",
      "",
      "1. **Not a decision either.**",
    ].join("\n");
    const found = findDecisions(md);
    expect(found.map((d) => [d.number, d.title, d.line])).toEqual([
      [1, "First.", 9],
      [2, "Second.", 14],
      [10, "Tenth.", 22],
    ]);
    expect(found[0]?.text).toContain("because of Y");
    expect(found[0]?.text).toContain("A second paragraph");
    expect(found[1]?.text).not.toContain("A paragraph after the list");
  });

  test("a top-level Decisions section counts as well", () => {
    const md = "## Decisions\n\n1. **Only.** Text.\n";
    expect(findDecisions(md).map((d) => d.title)).toEqual(["Only."]);
  });

  test("a title in bold code keeps its text", () => {
    const md = "## Design\n\n1. **`vimma-ctl mcp`**, a subcommand.\n";
    expect(findDecisions(md).map((d) => d.title)).toEqual(["`vimma-ctl mcp`"]);
  });
});

describe("decisionErrors", () => {
  const design = (...items) => ["", "## Design", "", ...items, ""].join("\n");

  test("a draft or accepted spec's decision without a reason fails", () => {
    const md = spec("draft", design("1. **Keys: `ctrl+b u`.** It runs `toggle_toolbar`."));
    expect(decisionErrors("x.md", md, [])).toEqual({
      errors: [expect.stringMatching(/^x\.md:\d+: decision 1 "Keys: `ctrl\+b u`\." has no reason/)],
      used: [],
    });
  });

  test("a decision with a reason passes", () => {
    const md = spec("accepted", design("1. **Keys.** `ctrl+b u`, because `u` is free."));
    expect(decisionErrors("x.md", md, [])).toEqual({ errors: [], used: [] });
  });

  test("an implemented spec is frozen history and is not checked", () => {
    const md = spec("implemented", design("1. **Keys.** `ctrl+b u`."));
    expect(decisionErrors("x.md", md, [])).toEqual({ errors: [], used: [] });
  });

  test("a decision on the baseline passes and is reported as used", () => {
    const md = spec("draft", design("1. **Keys.** `ctrl+b u`."));
    expect(decisionErrors("x.md", md, ["Keys."])).toEqual({ errors: [], used: ["Keys."] });
  });
});

describe("baseline", () => {
  test("an entry that is no longer needed is an error, so the baseline only shrinks", async () => {
    const { staleBaseline } = await import("../spec-lint.mjs");
    expect(
      staleBaseline({ "x.md": ["Keys.", "Gone."], "y.md": ["Any."] }, { "x.md": ["Keys."] }),
    ).toEqual([
      expect.stringMatching(/^x\.md: baseline entry "Gone\." /),
      expect.stringMatching(/^y\.md: baseline entry "Any\." /),
    ]);
  });
});

import { describe, expect, test } from "vitest";
import { driftFindings, renderReport } from "../spec-status.mjs";

/**
 * @param {number} number
 * @param {"open" | "closed"} state
 * @param {string[]} [labels]
 */
const issue = (number, state, labels = []) => [number, { state, labels, pullRequest: false }];

describe("driftFindings", () => {
  test("nothing to report when every status matches its issues", () => {
    const issues = new Map([
      issue(1, "open", ["spec:draft"]),
      issue(2, "open", ["spec:accepted"]),
      issue(3, "closed"),
      issue(4, "open"),
    ]);
    const specs = [
      { file: "a.md", status: "draft", issues: [1] },
      { file: "b.md", status: "accepted", issues: [2, 3] },
      { file: "c.md", status: "implemented", issues: [3] },
      { file: "d.md", status: "implemented", issues: [] },
      { file: "e.md", status: "accepted", issues: [4] },
    ];
    expect(driftFindings(specs, issues)).toEqual([]);
  });

  test("a draft or accepted spec whose issues are all closed", () => {
    const issues = new Map([issue(1, "closed"), issue(2, "closed")]);
    expect(driftFindings([{ file: "a.md", status: "accepted", issues: [1, 2] }], issues)).toEqual([
      {
        file: "a.md",
        message: expect.stringMatching(/accepted, but #1 and #2 are closed/),
      },
    ]);
  });

  test("a spec on hold: its closed issues are labelled on-hold, so it is not reported", () => {
    const issues = new Map([issue(1, "closed", ["on-hold", "spec:draft"]), issue(2, "closed")]);
    expect(
      driftFindings(
        [
          { file: "a.md", status: "draft", issues: [1] },
          { file: "b.md", status: "accepted", issues: [1, 2] },
        ],
        issues,
      ),
    ).toEqual([]);
  });

  test("an implemented spec with an open issue", () => {
    const issues = new Map([issue(1, "closed"), issue(2, "open")]);
    expect(
      driftFindings([{ file: "a.md", status: "implemented", issues: [1, 2] }], issues),
    ).toEqual([{ file: "a.md", message: expect.stringMatching(/implemented, but #2 is open/) }]);
  });

  test("an open issue whose spec label does not match the spec's status", () => {
    const issues = new Map([issue(1, "open", ["planned", "spec:draft"])]);
    expect(driftFindings([{ file: "a.md", status: "accepted", issues: [1] }], issues)).toEqual([
      {
        file: "a.md",
        message: expect.stringMatching(/#1 is labelled spec:draft; the spec is accepted/),
      },
    ]);
  });

  test("a linked number that is no issue (missing, or a pull request)", () => {
    const issues = new Map([[2, { state: "closed", labels: [], pullRequest: true }]]);
    const found = driftFindings([{ file: "a.md", status: "draft", issues: [1, 2] }], issues);
    expect(found).toEqual([
      { file: "a.md", message: expect.stringMatching(/#1 is not an issue/) },
      { file: "a.md", message: expect.stringMatching(/#2 is not an issue/) },
    ]);
  });
});

describe("renderReport", () => {
  test("lists each finding with a link to its spec, and says how to clear it", () => {
    const md = renderReport([{ file: "a.md", message: "accepted, but #1 is closed" }], {
      repo: "vimma-browser/vimma",
      sha: "abc123",
    });
    expect(md).toContain(
      "- [`docs/specs/a.md`](https://github.com/vimma-browser/vimma/blob/abc123/docs/specs/a.md): accepted, but #1 is closed",
    );
    expect(md).toMatch(/docs\/specs\/README\.md/);
  });

  test("an empty report says so", () => {
    expect(renderReport([], { repo: "vimma-browser/vimma", sha: "abc" })).toMatch(
      /match their issues/,
    );
  });
});

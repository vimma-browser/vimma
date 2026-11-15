/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { BOT, mergeReady, markerSha } from "../merge-ready.mjs";
import { autoMergeMarker } from "../autopilot-body.mjs";

const head = "a".repeat(40);
const pr = {
  number: 7,
  title: "upstream: firefox 159.0.2",
  user: { login: BOT },
  draft: false,
  head: { sha: head },
  body: `Opened by the upstream autopilot.\n\n${autoMergeMarker(head)}\n`,
  auto_merge: null,
};
/** @param {string} name @param {object} [over] */
const run = (name, over = {}) => ({
  name,
  event: "pull_request",
  head_sha: head,
  status: "completed",
  conclusion: "success",
  ...over,
});
/** @param {string} name @param {object} [over] */
const check = (name, over = {}) => ({ name, status: "completed", conclusion: "success", ...over });
const runs = [
  run("CI"),
  run("e2e"),
  run("pkgbuild"),
  run("Dependabot auto-merge", { conclusion: "skipped" }),
];
const checks = [check("mochitest (artifact build, macOS)"), check("vimma-ctl on macOS")];
const green = { pr, runs, checks, head };

// Spec upstream-bump-automation, Behaviour 5 (since changed): the bump merges itself only once
// every check on its head is green, not only the ruleset's required ones.
describe("merge-ready: every check on the bump's head", () => {
  it("is ready when every run and check finished green or skipped", () => {
    expect(mergeReady(green)).toEqual({ ready: true, reason: "every check is green" });
  });

  it("waits while a pull request run is not finished", () => {
    expect(
      mergeReady({
        ...green,
        runs: [...runs, run("macos", { status: "in_progress", conclusion: null })],
      }),
    ).toEqual({
      ready: false,
      reason: "waiting for macos",
    });
  });

  // A check outside the PR workflows (code scanning's analysis, a Copilot session) can finish
  // after the last workflow run, and no workflow_run wakes the gate again: a pending one is left
  // to the ruleset, which requires code scanning; a failed one still refuses.
  it("does not wait for a pending check outside the pull request runs", () => {
    const pending = check("CodeQL", { status: "in_progress", conclusion: null });
    expect(mergeReady({ ...green, checks: [...checks, pending] }).ready).toBe(true);
  });

  it("refuses a failed, cancelled, timed-out or unapproved run or check", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
      expect(
        mergeReady({ ...green, runs: [...runs, run("flatpak", { conclusion })] }),
        conclusion,
      ).toEqual({
        ready: false,
        reason: `flatpak: ${conclusion}`,
      });
      expect(
        mergeReady({
          ...green,
          checks: [check("mochitest (artifact build, macOS)", { conclusion })],
        }).reason,
      ).toBe(`mochitest (artifact build, macOS): ${conclusion}`);
    }
  });

  it("ignores runs of other events and other commits", () => {
    const other = [
      run("CI", { event: "push", conclusion: "failure" }),
      run("CI", { head_sha: "b".repeat(40), conclusion: "failure" }),
    ];
    expect(mergeReady({ ...green, runs: [...runs, ...other] }).ready).toBe(true);
    expect(mergeReady({ ...green, runs: other }).reason).toBe("no pull request run on the head");
  });

  it("only for the App's own non-draft PR at the head the autopilot allowed", () => {
    const off = (/** @type {object} */ over) =>
      mergeReady({ ...green, pr: { ...pr, ...over } }).reason;
    expect(mergeReady({ ...green, pr: null }).reason).toBe("no open pull request");
    expect(off({ user: { login: "someone" } })).toBe("not opened by the upstream App");
    expect(off({ draft: true })).toBe("a draft");
    expect(off({ head: { sha: "b".repeat(40) } })).toBe("the head moved");
    expect(off({ body: "no marker" })).toBe("the autopilot did not allow auto-merge for this head");
    expect(off({ body: autoMergeMarker("b".repeat(40)) })).toBe(
      "the autopilot did not allow auto-merge for this head",
    );
    expect(off({ auto_merge: { merge_method: "squash" } })).toBe("auto-merge is already on");
  });
});

describe("the auto-merge marker", () => {
  it("round-trips a full commit id and nothing else", () => {
    expect(markerSha(autoMergeMarker(head))).toBe(head);
    expect(markerSha("<!-- upstream-auto-merge: abc -->")).toBe(null);
    expect(markerSha("")).toBe(null);
    expect(() => autoMergeMarker("abc")).toThrow();
  });
});

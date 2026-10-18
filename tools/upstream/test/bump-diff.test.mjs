import { describe, expect, it } from "vitest";
import { checkBumpDiff } from "../bump-diff.mjs";
import { CFR, SB_LISTS } from "../upstream-prefs.mjs";

// Spec upstream-bump-automation, decision 8: the diff a bump may auto-merge with, line by line.
const OURS = "src/browser/branding/vimma/pref/firefox-branding.js";
const surfer = (/** @type {string} */ v, extra = {}) =>
  JSON.stringify({ name: "Vimma", version: { product: "firefox", version: v }, ...extra }, null, 2);
const base = surfer("158.0");
const head = surfer("158.0.1");
const surferHunk = [
  "diff --git a/surfer.json b/surfer.json",
  "index 1111111..2222222 100644",
  "--- a/surfer.json",
  "+++ b/surfer.json",
  "@@ -8 +8 @@",
  '-    "version": "158.0"',
  '+    "version": "158.0.1"',
].join("\n");
/** @param {string} name @param {string} from @param {string} to */
const prefHunk = (name, from, to) =>
  [
    `diff --git a/${OURS} b/${OURS}`,
    "index 3333333..4444444 100644",
    `--- a/${OURS}`,
    `+++ b/${OURS}`,
    "@@ -86 +86 @@",
    `-pref("${name}", ${JSON.stringify(from)});`,
    `+pref("${name}", ${JSON.stringify(to)});`,
  ].join("\n");

describe("bump-diff", () => {
  it("accepts a surfer.json version bump", () => {
    expect(checkBumpDiff({ diff: surferHunk, baseSurfer: base, headSurfer: head })).toEqual({
      ok: true,
      reason: "only the version and copied prefs change",
    });
  });

  it("accepts a bump with refreshed pref lines", () => {
    const diff = [
      surferHunk,
      prefHunk(CFR, "{}", '{"a":1}'),
      prefHunk(SB_LISTS[1] ?? "", "a", "b"),
    ].join("\n");
    expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head }).ok).toBe(true);
  });

  it("refuses another surfer.json key", () => {
    const r = checkBumpDiff({
      diff: surferHunk,
      baseSurfer: base,
      headSurfer: surfer("158.0.1", { binaryName: "x" }),
    });
    expect(r).toEqual({ ok: false, reason: "surfer.json changes more than version.version" });
  });

  it("refuses a diff without the version bump", () => {
    expect(
      checkBumpDiff({ diff: prefHunk(CFR, "a", "b"), baseSurfer: base, headSurfer: base }),
    ).toEqual({ ok: false, reason: "surfer.json is not changed" });
  });

  it("refuses another file", () => {
    const diff = `${surferHunk}\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b`;
    expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head })).toEqual({
      ok: false,
      reason: "changes README.md",
    });
  });

  it("refuses another line in firefox-branding.js", () => {
    const diff = `${surferHunk}\n${prefHunk("browser.startup.homepage", "a", "b")}`;
    expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head })).toEqual({
      ok: false,
      reason: `changes a line of ${OURS} that is not a copied pref`,
    });
    const tail = `${surferHunk}\n${prefHunk(CFR, "a", "b")}\n+pref("x", 1);`;
    expect(checkBumpDiff({ diff: tail, baseSurfer: base, headSurfer: head }).ok).toBe(false);
  });

  it("refuses a re-exported patch", () => {
    const p = "src/browser/base/content/browser-js.patch";
    const diff = `${surferHunk}\ndiff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-@@ -1,3 +1,4 @@\n+@@ -2,3 +2,4 @@`;
    expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head })).toEqual({
      ok: false,
      reason: `changes ${p}`,
    });
  });

  it("refuses a new, deleted, renamed or mode-changed file", () => {
    for (const extra of [
      "new file mode 100644",
      "deleted file mode 100644",
      "old mode 100644",
      "rename from a",
      "Binary files a/x and b/x differ",
    ]) {
      const diff = surferHunk.replace("index 1111111..2222222 100644", extra);
      expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head }).ok, extra).toBe(false);
    }
  });

  it("refuses a file header it does not recognise instead of folding it into the last file", () => {
    for (const header of [
      "diff --git a/tools/evil x.mjs b/tools/evil x.mjs",
      'diff --git "a/tools/\\303\\244.sh" "b/tools/\\303\\244.sh"',
    ]) {
      const diff = `${surferHunk}\n${header}\nnew file mode 100755\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+anything`;
      expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head }).ok, header).toBe(false);
    }
  });

  it("refuses a line inside a hunk that is not an added or removed line", () => {
    const diff = `${surferHunk}\n context line`;
    expect(checkBumpDiff({ diff, baseSurfer: base, headSurfer: head }).ok).toBe(false);
  });
});

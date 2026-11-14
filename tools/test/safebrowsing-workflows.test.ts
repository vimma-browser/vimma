import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Spec m0-safebrowsing-key: builds that ship get the Google Safe Browsing key from a temp file
// that is deleted afterwards; PR builds never see it.
/** @param {string} name */
const workflow = (name) =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

/**
 * @param {string} text a workflow
 * @param {string} id a job id
 * @returns {string} that job's YAML block
 */
function job(text, id) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  return "";
}

/** @param {string} block */
function checkKeyFileSteps(block) {
  // Written by a shell builtin into a mode-600 file, never echoed, deleted whatever happens.
  expect(block).toContain("SAFEBROWSING_API_KEY: ${{ secrets.SAFEBROWSING_API_KEY }}");
  expect(block).toContain(`(umask 077 && printf '%s' "$SAFEBROWSING_API_KEY" > "$keyfile")`);
  expect(block).toContain('echo "VIMMA_SAFEBROWSING_KEYFILE=$keyfile" >> "$GITHUB_ENV"');
  expect(block).not.toMatch(/echo[^\n]*\$\{?SAFEBROWSING_API_KEY/);
  expect(block).toMatch(
    /- name: Delete the Safe Browsing key file\n\s+if: always\(\)\n\s+run: rm -f "\$RUNNER_TEMP\/vimma-safebrowsing.key"/,
  );
}

describe("Safe Browsing key in CI", () => {
  it("the nightly build compiles the key in", () => {
    const block = job(workflow("nightly.yml"), "build");
    checkKeyFileSteps(block);
    // browser_vimma_safebrowsing.js then fails a nightly that lost its key.
    expect(block).toContain('VIMMA_EXPECT_SAFEBROWSING_KEY: "1"');
  });

  it("the release build compiles the key in, and no other release job sees it", () => {
    const text = workflow("release.yml");
    const block = job(text, "build");
    checkKeyFileSteps(block);
    // No mochitests here: the smoke check fails a release built without the key.
    // Fails closed: a missing or moved AppConstants, or one without the key constant, fails too.
    expect(block).toContain('[ -f "$appconstants" ] || {');
    expect(block).toContain(`grep -q 'MOZ_GOOGLE_SAFEBROWSING_API_KEY' "$appconstants"`);
    expect(block).toContain(`grep -q '"no-google-safebrowsing-api-key"' "$appconstants"`);
    for (const id of ["package", "sign", "publish", "failure"]) {
      expect(job(text, id), id).not.toContain("SAFEBROWSING");
    }
  });

  it("a manual nightly runs only from main, and the key is scrubbed from what goes public", () => {
    const block = job(workflow("nightly.yml"), "build");
    expect(block).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    );
    const redact = block.indexOf("- name: Redact the Safe Browsing key from the log");
    expect(redact, "redaction step").toBeGreaterThan(-1);
    expect(block.indexOf("- name: Upload log"), "upload after redaction").toBeGreaterThan(redact);
    // The failure issue is written by the `report` job, which has no secret and reads only the
    // log the build job uploaded after redacting it.
    const report = job(workflow("nightly.yml"), "report");
    expect(report).toContain("- name: Open or update the failure issue");
    expect(report).toContain("name: nightly-log");
    expect(report).not.toContain("secrets.");
    expect(block).toContain('sed -i "s|${SB_KEY}|[redacted]|g" "$LOG"');
  });

  it("PR builds never get it", () => {
    expect(workflow("e2e.yml")).not.toContain("secrets.SAFEBROWSING_API_KEY");
  });
});

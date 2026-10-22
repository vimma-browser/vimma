import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_REGEXP, pkgbuild, srcinfo } from "../package.mjs";

// release.yml's gates (spec m6-packaging; docs/runbook.md, "Release packages"). It starts only
// by workflow_dispatch: release-please.yml's release-build job starts it for the draft release it
// just created, and the maintainer re-runs it by hand. A workflow_dispatch run executes the
// release.yml of the branch it was started on, so every job refuses anything but a run from
// main. That guard stops accidental runs; what no other branch can obtain is the signature's
// identity, release.yml at refs/heads/main.
const text = readFileSync(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

/** @returns {Map<string, string>} job id -> its YAML block */
function jobs() {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (let i = 0; i < parts.length; i += 2) map.set(parts[i] ?? "", parts[i + 1] ?? "");
  return map;
}

/**
 * The `on:` block of a workflow.
 * @param {string} file
 */
const triggersOf = (file) => file.slice(file.indexOf("\non:\n"), file.indexOf("\npermissions:"));

/**
 * The `run:` script of the step called `name` in `block`, unindented.
 * @param {string} block
 * @param {string} name
 */
function runOf(block, name) {
  const start = block.indexOf(`- name: ${name}\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = block.slice(start + 1);
  const end = rest.search(/\n {6}- (?:name|uses):/);
  const step = end === -1 ? rest : rest.slice(0, end);
  const lines = step.slice(step.indexOf("run: |\n") + 8).split("\n");
  // the next step's comment lines are not part of this run
  while (lines.length > 0 && /^ {6}#|^\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.map((l) => l.replace(/^ {10}/, "")).join("\n");
}

/** @param {string} block */
function condition(block) {
  const match = /^ {4}if: (>-\n(?: {6}.*\n)+|.*\n)/m.exec(block);
  return (match?.[1] ?? "").replace(/^>-\n/, "").replace(/\s+/g, " ").trim();
}

const NOTES_STEP = "Add the update steps and the third-party notice to the release notes";

describe("release.yml", () => {
  const all = jobs();

  it("has the jobs the spec lists", () => {
    expect([...all.keys()]).toEqual([
      "build",
      "package",
      "sign",
      "publish",
      "macos-build",
      "macos-smoke",
      "macos-sign",
      "macos-publish",
      "macos-tap",
      "failure",
    ]);
  });

  it.each([...jobs().keys()])("job %s runs only when enabled, here, from main", (id) => {
    const cond = condition(all.get(id) ?? "");
    expect(cond).toContain(
      "vars.RELEASE_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' && " +
        "github.ref == 'refs/heads/main'",
    );
    expect(cond).not.toContain("event_name");
  });

  it("only the sign jobs mint an OIDC token, only the publish jobs write contents", () => {
    for (const [id, block] of all) {
      expect(block.includes("id-token: write"), id).toBe(["sign", "macos-sign"].includes(id));
      expect(block.includes("contents: write"), id).toBe(["publish", "macos-publish"].includes(id));
      expect(block.includes("actions: write"), id).toBe(id === "macos-tap");
    }
    expect(text).toMatch(/^permissions: \{\}$/m);
  });

  it("has no pull_request, pull_request_target or push trigger", () => {
    expect(triggersOf(text)).not.toMatch(/pull_request|push:/);
  });

  // Publishing the draft must not build it again: the assets are already on it.
  it("starts only by workflow_dispatch with a tag, so publishing a release rebuilds nothing", () => {
    expect(triggersOf(text)).toMatch(
      /^\non:\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}.*\n)+ {6}replace_published:\n(?: {8}.*\n)+$/,
    );
    expect(text).not.toContain("github.event.release");
    expect(text).toMatch(/^ {2}TAG: \$\{\{ inputs\.tag \}\}$/m);
  });

  // Every signature names release.yml at refs/heads/main, whatever the tag points to, so the
  // build refuses a tag whose commit is not on main before anything else runs.
  it("builds only a vX.Y.Z tag whose commit is on main", () => {
    const build = all.get("build") ?? "";
    const check = runOf(build, "The tag is on main");
    expect(check).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/compare/$sha...refs/heads/main" --jq .status',
    );
    expect(check).toMatch(/ahead\|identical\) ;;/);
    expect(build.indexOf("- name: Check the tag's form")).toBeLessThan(
      build.indexOf("- name: The tag is on main"),
    );
    expect(build.indexOf("- name: The tag is on main")).toBeLessThan(
      build.indexOf("uses: actions/checkout@"),
    );
    // the token is the step's, never the job's, so npm, Surfer and mach never see it
    const head = build.slice(0, build.indexOf("\n    steps:\n"));
    expect(head).not.toMatch(/GH_TOKEN/);
    expect(build.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(1);
  });

  // The tag is resolved to one commit once, checked, and that commit is what every job checks
  // out and publish re-checks: moving the tag during the two-hour build cannot swap the source.
  it("builds, packages and publishes the one commit it checked", () => {
    const build = all.get("build") ?? "";
    const check = runOf(build, "The tag is on main");
    expect(check).toContain(
      'sha=$(gh api "repos/$GITHUB_REPOSITORY/commits/refs/tags/$TAG" --jq .sha)',
    );
    expect(check).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/compare/$sha...refs/heads/main" --jq .status',
    );
    expect(check).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    expect(build).toMatch(/^ {4}outputs:\n {6}sha: \$\{\{ steps\.tag\.outputs\.sha \}\}$/m);
    expect(build).toContain("ref: ${{ steps.tag.outputs.sha }}");
    expect(all.get("package")).toContain("ref: ${{ needs.build.outputs.sha }}");
    expect(text).not.toContain("ref: refs/tags/");
    const publish = all.get("publish") ?? "";
    expect(publish).toMatch(/^ {4}needs: \[build, package, sign\]$/m);
    expect(publish).toContain("SHA: ${{ needs.build.outputs.sha }}");
    expect(runOf(publish, "Upload to the GitHub Release")).toContain(
      '[ "$(gh api "repos/$GITHUB_REPOSITORY/commits/refs/tags/$TAG" --jq .sha)" = "$SHA" ]',
    );
  });

  // Builds are not bit-for-bit reproducible: new files under a published release would no longer
  // match the PKGBUILD the AUR has or the SHA256SUMS users saved. Only a draft gets uploads,
  // unless the run says replace_published.
  it("uploads only to a draft unless told to replace a published release", () => {
    expect(triggersOf(text)).toMatch(
      / {6}replace_published:\n(?: {8}.*\n)*? {8}type: boolean\n(?: {8}.*\n)*? {8}default: false\n/,
    );
    const publish = all.get("publish") ?? "";
    expect(publish).toContain("REPLACE_PUBLISHED: ${{ inputs.replace_published }}");
    const upload = runOf(publish, "Upload to the GitHub Release");
    expect(upload).toContain('if [ "$draft" != true ] && [ "$REPLACE_PUBLISHED" != true ]; then');
    expect(upload.indexOf("REPLACE_PUBLISHED")).toBeLessThan(upload.indexOf("gh release upload"));
  });

  // The AUR is public at once: it gets a package only after the maintainer publishes (aur.yml).
  it("never pushes to the AUR", () => {
    expect(text).not.toMatch(/aur\.archlinux\.org|AUR_SSH_KEY|git push/);
  });

  // gh release edit resends the tag of a draft (#311); the job checks the draft is still on it.
  it("uploads to the release by its tag and leaves the draft on that tag", () => {
    const publish = all.get("publish") ?? "";
    const notes = runOf(publish, NOTES_STEP);
    expect(notes).toContain(
      'gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --notes-file notes.md',
    );
    expect(notes).toMatch(
      /gh release view "\$TAG" --repo "\$GITHUB_REPOSITORY" --json tagName --jq \.tagName\)" = "\$TAG" \]/,
    );
    expect(publish).not.toMatch(/tag_name|--draft|--tag|--method/);
    // its only API call reads the tag's commit
    expect(publish.match(/gh api/g)).toHaveLength(1);
  });

  /**
   * Runs the publish job's notes step against a stub `gh` that keeps the release body in a file,
   * with `dist/notes/` as tools/package/package.mjs writes it.
   * @param {string} body the release notes before the step
   * @param {number} [runs] how many times the step runs, as re-runs of the job do
   */
  const editNotes = (body, runs = 1) => {
    const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
    try {
      const work = join(dir, "work");
      execFileSync("mkdir", ["-p", join(dir, "bin"), join(work, "dist/notes")]);
      writeFileSync(join(work, "dist/notes/updating.md"), "### Updating\n\nsteps\n");
      writeFileSync(join(work, "dist/notes/third-party.md"), "### Third-party notice\n\nnotice\n");
      const stored = join(dir, "body");
      const edits = join(dir, "edits");
      writeFileSync(stored, body);
      writeFileSync(edits, "");
      // gh release view <tag> --repo <r> --json body|tagName --jq …; gh release edit … --notes-file f
      writeFileSync(
        join(dir, "bin", "gh"),
        `#!/bin/sh
case "$2 $6 $7" in
  "view --json body") cat "${stored}"; echo ;;
  "view --json tagName") echo "$TAG" ;;
  "edit --notes-file "*) cp "$7" "${stored}"; echo "$3" >> "${edits}" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
      const script = runOf(all.get("publish") ?? "", NOTES_STEP);
      for (let i = 0; i < runs; i++) {
        execFileSync("bash", ["-e", "-c", script], {
          cwd: work,
          encoding: "utf8",
          stdio: "pipe",
          env: {
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
            HOME: dir,
            TAG: "v0.1.7",
            GITHUB_REPOSITORY: "vimma-browser/vimma",
          },
        });
      }
      return {
        body: readFileSync(stored, "utf8"),
        edits: readFileSync(edits, "utf8").split("\n").filter(Boolean),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const changelog = "## [0.1.7](https://example.invalid) (2026-10-20)\n\n### Features\n\n* x";

  // Vimma 0.1.6 on a Mac shows the Linux tarball command and links to these notes (#410).
  it("the notes start with the update steps and end with the third-party notice", () => {
    const { body, edits } = editNotes(changelog);
    expect(edits).toEqual(["v0.1.7"]);
    expect(body).toBe(
      `### Updating\n\nsteps\n\n${changelog}\n\n### Third-party notice\n\nnotice\n`,
    );
  });

  it("a re-run adds neither part again and does not edit the release", () => {
    const once = editNotes(changelog).body;
    const { body, edits } = editNotes(changelog, 2);
    expect(body).toBe(once);
    expect(edits).toEqual(["v0.1.7"]);
  });

  // a release whose notes an older release.yml already gave the third-party notice
  it("notes with only the third-party notice get the update steps alone", () => {
    const { body } = editNotes(`${changelog}\n\n### Third-party notice\n\nnotice`);
    expect(body.match(/^### Updating$/gm)).toHaveLength(1);
    expect(body.match(/^### Third-party notice$/gm)).toHaveLength(1);
    expect(body.startsWith("### Updating\n")).toBe(true);
  });

  // Spec macos-build, decisions 12 and 13: the macOS .dmg joins the release through jobs of its
  // own, which no Linux job waits for, so a macOS failure cannot hold back a Linux release.
  describe("the macOS jobs", () => {
    const MACOS = ["macos-build", "macos-smoke", "macos-sign", "macos-publish", "macos-tap"];

    it.each(MACOS)("%s also needs MACOS_RELEASE_ENABLED", (id) => {
      expect(condition(all.get(id) ?? "")).toContain("vars.MACOS_RELEASE_ENABLED == 'true'");
    });

    it("no Linux job needs a macOS job", () => {
      for (const id of ["build", "package", "sign", "publish"]) {
        const needs = /^ {4}needs: (.*)$/m.exec(all.get(id) ?? "")?.[1] ?? "";
        expect(needs, id).not.toContain("macos");
      }
    });

    it("macos-build stops at the same measured limit as macos.yml's build", () => {
      const limit = (/** @type {string} */ block) =>
        /^ {4}timeout-minutes: (\d+)$/m.exec(block)?.[1];
      const weekly = readFileSync(
        new URL("../../../.github/workflows/macos.yml", import.meta.url),
        "utf8",
      );
      expect(limit(all.get("macos-build") ?? "")).toBe(limit(weekly));
      expect(limit(weekly)).toBeDefined();
    });

    it("macos-build checks the tag like build, then cross-builds with the key", () => {
      const block = all.get("macos-build") ?? "";
      expect(runOf(block, "Check the tag's form")).toBe(
        runOf(all.get("build") ?? "", "Check the tag's form"),
      );
      expect(runOf(block, "The tag is on main")).toBe(
        runOf(all.get("build") ?? "", "The tag is on main"),
      );
      expect(block.indexOf("- name: The tag is on main")).toBeLessThan(
        block.indexOf("uses: actions/checkout@"),
      );
      expect(block).toContain("ref: ${{ steps.tag.outputs.sha }}");
      expect(block).toMatch(/^ {4}outputs:\n {6}sha: \$\{\{ steps\.tag\.outputs\.sha \}\}$/m);
      expect(block).toMatch(/^ {4}environment: build$/m);
      expect(block).toMatch(/^ {10}SURFER_PLATFORM: darwin$/m);
      // as macos.yml: the runner's rustc has only the host's standard library
      expect(block).toMatch(/^ {8}run: rustup target add aarch64-apple-darwin$/m);
      expect(block.indexOf("rustup target add")).toBeLessThan(block.indexOf("surfer build"));
      const pack = runOf(block, "Package, ad hoc sign and checksum the dmg");
      expect(pack).toContain("tools/package/macos-dmg.sh");
      expect(pack).toContain('dmg="vimma-${TAG#v}-macos-aarch64.dmg"');
      // the Homebrew cask pins the dmg's SHA-256 and is listed beside it (spec macos-homebrew)
      expect(pack).toContain(
        'node tools/package/cask.mjs --tag "$TAG" --dmg "release-macos/$dmg" --out release-macos/vimma.rb',
      );
      expect(pack).toContain('sha256sum "$dmg" vimma.rb > SHA256SUMS-macos');
      expect(block.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(1);
    });

    it("macos-smoke runs the dmg on a hosted Mac and ties its version line to the tag", () => {
      const block = all.get("macos-smoke") ?? "";
      expect(block).toMatch(/^ {4}needs: macos-build$/m);
      expect(block).toMatch(/^ {4}runs-on: macos-15$/m);
      expect(block).toContain("ref: ${{ needs.macos-build.outputs.sha }}");
      expect(block).toContain("shasum -a 256 -c SHA256SUMS-macos");
      expect(block).toContain("codesign --verify --deep --strict");
      expect(block).toContain('case "$expected" in "Vimma ${TAG#v} · Firefox "*) ;;');
      expect(block).toContain("--screenshot");
      // Vimma's icon and bundle identifier, as macos.yml's smoke checks them
      expect(block).toContain('tools/package/macos-app-check.sh "$APP"');
    });

    // Spec macos-homebrew, decision 14: the repacked dmg keeps Vimma's window art and icon.
    it("macos-smoke checks the mounted dmg's window art and volume icon", () => {
      const mount = runOf(all.get("macos-smoke") ?? "", "Mount the dmg and copy the app out");
      const check = mount.indexOf('tools/package/macos-dmg-check.sh "$RUNNER_TEMP/vimma-dmg"');
      expect(check).toBeGreaterThan(mount.indexOf("hdiutil attach"));
      expect(check).toBeLessThan(mount.indexOf("hdiutil detach"));
    });

    // Spec macos-homebrew, decision 9: Homebrew lints the cask and installs the release's dmg
    // through it before anything is signed.
    it("macos-smoke checks the cask with brew and installs the dmg through it", () => {
      const check = runOf(all.get("macos-smoke") ?? "", "The Homebrew cask installs the dmg");
      expect(check).toContain(
        'tools/package/cask-check.sh release-macos/vimma.rb "release-macos/vimma-${TAG#v}-macos-aarch64.dmg"',
      );
    });

    it("macos-sign signs the dmg and its checksums, and runs no repository code", () => {
      const block = all.get("macos-sign") ?? "";
      expect(block).toMatch(/^ {4}needs: \[macos-build, macos-smoke\]$/m);
      expect(condition(block)).toContain("vars.SIGNING_ENABLED == 'true'");
      expect(block).not.toContain("actions/checkout@");
      expect(block).toMatch(
        /for f in dist\/vimma-\*-macos-aarch64\.dmg dist\/vimma\.rb dist\/SHA256SUMS-macos; do/,
      );
    });

    // A Linux release is often published before the slower macOS build ends. Adding the macOS
    // files to it changes nothing users or the AUR already have; replacing them needs the flag.
    it("macos-publish adds only the macOS files, and replaces them only when told", () => {
      const block = all.get("macos-publish") ?? "";
      expect(block).toMatch(/^ {4}needs: \[macos-build, macos-smoke, macos-sign\]$/m);
      expect(block).toContain("SHA: ${{ needs.macos-build.outputs.sha }}");
      expect(block).toContain("REPLACE_PUBLISHED: ${{ inputs.replace_published }}");
      expect(block).not.toContain("actions/checkout@");
      const upload = runOf(block, "Add the dmg to the GitHub Release");
      expect(upload).toContain(
        '[ "$(gh api "repos/$GITHUB_REPOSITORY/commits/refs/tags/$TAG" --jq .sha)" = "$SHA" ]',
      );
      expect(upload).toContain('if [ "$draft" != true ] && [ "$REPLACE_PUBLISHED" != true ]; then');
      expect(upload).toMatch(
        /gh release upload "\$TAG" dist\/vimma-\*-macos-aarch64\.dmg\* dist\/vimma\.rb\* dist\/SHA256SUMS-macos\* --clobber/,
      );
      expect(upload).toContain(
        'select(test("-macos-aarch64\\\\.dmg|^vimma\\\\.rb|^SHA256SUMS-macos"))',
      );
      expect(upload.indexOf("REPLACE_PUBLISHED")).toBeLessThan(upload.indexOf("gh release upload"));
      expect(block).not.toMatch(/gh release edit|--notes/);
    });

    // homebrew.yml reads only a published release; publishing usually comes before the macOS
    // files, and that run finds no cask. GITHUB_TOKEN may dispatch a workflow, so macos-tap starts
    // homebrew.yml again once the files are on a published release.
    it("macos-tap starts homebrew.yml on main once the cask is on a published release", () => {
      const block = all.get("macos-tap") ?? "";
      expect(block).toMatch(/^ {4}needs: macos-publish$/m);
      expect(block).toMatch(/^ {4}permissions:\n {6}actions: write(?: #.*)?\n {4}[a-z]/m);
      expect(block).not.toMatch(/actions\/checkout|setup-node|node /);
      const start = runOf(block, "Start homebrew.yml for a published release");
      expect(start).toContain(
        'curl -fsSL -o /dev/null "https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/vimma.rb"',
      );
      expect(start).toContain(
        'gh api --method POST "repos/$GITHUB_REPOSITORY/actions/workflows/homebrew.yml/dispatches" \\',
      );
      expect(start).toContain('-f ref=main -f "inputs[tag]=$TAG"');
      // homebrew.yml has no release trigger (a tag must not reach its key): a draft published
      // after its macOS files is started by hand, from main
      expect(start).toContain("gh workflow run homebrew.yml -f tag=$TAG");
      expect(start).not.toMatch(/publishing it starts/);
    });

    // Spec macos-homebrew, decision 16: the macOS update manifest needs the .dmg on a published
    // release, which, like the cask, usually comes after the release is published.
    it("macos-tap starts the macOS update manifest once the .dmg is on a published release", () => {
      const block = all.get("macos-tap") ?? "";
      const step = block.slice(
        block.indexOf("- name: Start update-publish.yml for the macOS manifest"),
      );
      expect(step).toMatch(/^ {8}if: vars\.UPDATES_ENABLED == 'true'$/m);
      const start = runOf(block, "Start update-publish.yml for the macOS manifest");
      expect(start).toContain(
        'if curl -fsSIL --proto =https -o /dev/null "https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/vimma-${TAG#v}-macos-aarch64.dmg"; then',
      );
      expect(start).toContain(
        'gh api --method POST "repos/$GITHUB_REPOSITORY/actions/workflows/update-publish.yml/dispatches" \\',
      );
      expect(start).toContain('-f ref=main -f "inputs[tag]=$TAG" -f "inputs[target]=macos"');
    });

    it("a macOS failure opens the release-failure issue too", () => {
      const needs = /^ {4}needs:\n((?: {6}- .*\n)+)/m.exec(all.get("failure") ?? "")?.[1] ?? "";
      expect(
        needs
          .split("\n")
          .filter(Boolean)
          .map((n) => n.replace(/^ {6}- /, "")),
      ).toEqual([
        "build",
        "package",
        "sign",
        "publish",
        "macos-build",
        "macos-smoke",
        "macos-sign",
        "macos-publish",
        "macos-tap",
      ]);
    });
  });

  it("the failure issue tells how to re-run the same tag", () => {
    expect(all.get("failure")).toContain("gh workflow run release.yml -f tag=$TAG");
  });

  // Arch users install from the release with only the PKGBUILD (spec m6-packaging, "Arch Linux
  // without the AUR"): it is an asset like the others, so SHA256SUMS and a cosign bundle cover it.
  it("signs and uploads the PKGBUILD and SRCINFO with the other assets", () => {
    const sign = all.get("sign") ?? "";
    const publish = all.get("publish") ?? "";
    expect(sign).toMatch(
      /for f in dist\/vimma\* dist\/PKGBUILD dist\/SRCINFO dist\/SHA256SUMS; do/,
    );
    expect(publish).toMatch(
      /gh release upload "\$TAG" dist\/vimma\* dist\/PKGBUILD\* dist\/SRCINFO\* dist\/SHA256SUMS\* /,
    );
  });

  it("builds and installs the release PKGBUILD on Arch Linux before anything is signed", () => {
    const pkg = all.get("package") ?? "";
    expect(pkg).toContain("tools/package/arch-smoke.sh");
  });

  // The host serves on ARCH_SMOKE_PORT; the container must rewrite the PKGBUILD to the same port.
  it("passes the smoke test's port into its container", () => {
    const script = readFileSync(new URL("../arch-smoke.sh", import.meta.url), "utf8");
    expect(script).toContain('docker run --rm --network host -e ARCH_SMOKE_PORT="$PORT"');
    expect(script).not.toMatch(/-e PORT=/);
  });
});

// aur.yml: pushes vimma-bin to the AUR, which is public at once, so only for a published
// release. Its only source is the published release's own files.
describe("aur.yml", () => {
  const file = readFileSync(new URL("../../../.github/workflows/aur.yml", import.meta.url), "utf8");
  const all = new Map();
  {
    const body = file.slice(file.indexOf("\njobs:\n") + 7);
    const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) all.set(parts[i] ?? "", parts[i + 1] ?? "");
  }
  /** @param {string} id */
  const job = (id) => /** @type {string} */ (all.get(id) ?? "");

  it("has the aur job and its failure report", () => {
    expect([...all.keys()]).toEqual(["aur", "failure"]);
    expect(job("failure")).toMatch(/^ {4}needs: aur$/m);
  });

  it("runs when a release is published, or by hand with a tag; never for a draft", () => {
    const on = triggersOf(file);
    expect(on).toMatch(/^ {2}release:\n {4}types: \[published\]\n/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n/m);
    expect(on).not.toMatch(/pull_request|push:|created|prereleased/);
    expect(file).toMatch(/^permissions: \{\}$/m);
  });

  it.each(["aur", "failure"])(
    "job %s runs only when enabled, here, for a release or main",
    (id) => {
      expect(condition(job(id))).toContain(
        "vars.RELEASE_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' && " +
          "(github.event_name == 'release' || github.ref == 'refs/heads/main')",
      );
    },
  );

  // releases/download/<tag>/ serves a published release's assets only: a draft's are a 404, so
  // the job cannot push a draft's PKGBUILD even when started by hand for its tag.
  it("takes the PKGBUILD from the published release only, with no GitHub token", () => {
    const aur = job("aur");
    expect(aur).toMatch(/^ {4}permissions: \{\}$/m);
    expect(aur).not.toMatch(/github\.token|GH_TOKEN|gh release|gh api|actions\/checkout/);
    const fetch = runOf(aur, "Download the published release's PKGBUILD");
    expect(fetch).toContain('base="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG"');
    expect(fetch).toMatch(/curl -fsSL/);
    expect(fetch).toMatch(/grep -E ' {2}\(PKGBUILD\|SRCINFO\)\$' SHA256SUMS/);
    expect(fetch).toContain("sha256sum -c -");
    // a signed SHA256SUMS is not bound to its tag: the PKGBUILD must be this release's version
    expect(fetch).toContain('grep -qx "pkgver=${TAG#v}" PKGBUILD');
  });

  // An environment limited to main and v* tags holds the AUR key, so a workflow on another
  // branch cannot read it.
  it("takes the AUR key from the aur environment", () => {
    expect(job("aur")).toMatch(/^ {4}environment: aur$/m);
    expect(job("failure")).not.toContain("environment:");
  });

  it("checks the release's signature against the documented identity when signing is on", () => {
    const aur = job("aur");
    expect(aur).toContain(`--certificate-identity-regexp '${IDENTITY_REGEXP}'`);
    expect(aur).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
    expect(aur).toMatch(/if: env\.AUR_KEY_SET == 'true' && vars\.SIGNING_ENABLED == 'true'/);
  });

  it("checks the tag's form before anything is fetched", () => {
    const aur = job("aur");
    expect(aur).toContain("grep -Eqx 'v[0-9]+\\.[0-9]+\\.[0-9]+'");
    expect(aur.indexOf("Check the tag's form")).toBeLessThan(aur.indexOf("curl -fsSL"));
  });

  it("the AUR key reaches only the push step", () => {
    expect(file.match(/secrets\.AUR_SSH_KEY/g)).toHaveLength(2);
    expect(job("aur")).toMatch(/^ {6}AUR_KEY_SET: \$\{\{ secrets\.AUR_SSH_KEY != '' \}\}$/m);
    const push = job("aur").slice(job("aur").indexOf("- name: Push vimma-bin"));
    expect(push).toMatch(/^ {10}AUR_SSH_KEY: \$\{\{ secrets\.AUR_SSH_KEY \}\}$/m);
  });

  it("pushes only the PKGBUILD and .SRCINFO to the AUR, removing the old source files", () => {
    const aur = job("aur");
    expect(aur).toContain("cp aur-files/PKGBUILD aur-files/.SRCINFO aur/");
    expect(aur).toContain(
      "git rm -q --ignore-unmatch vimma.desktop vimma-vimma.desktop vimma-open",
    );
    expect(aur).toContain("git add PKGBUILD .SRCINFO\n");
  });

  describe("the AUR variant step", () => {
    const input = {
      version: "0.1.2",
      maintainer: "A Maintainer <a@example.org>",
      repo: "vimma-browser/vimma",
      tarballSha256: "0".repeat(64),
      desktop: "[Desktop Entry]\nName=Vimma\n",
      desktopId: "vimma-vimma",
      launcher: '#!/bin/sh\nexec vimma "$@"\n',
    };
    /** @type {"pkgbuild-release"} */
    const release = "pkgbuild-release";
    /** @param {string} pkg */
    const variant = (pkg) => {
      const dir = mkdtempSync(join(tmpdir(), "aur-variant-"));
      try {
        writeFileSync(join(dir, "PKGBUILD"), pkg);
        writeFileSync(join(dir, "SRCINFO"), srcinfo({ ...input, installSource: release }));
        execFileSync("bash", ["-e", "-c", runOf(job("aur"), "Make the AUR variant")], {
          cwd: dir,
          stdio: "pipe",
        });
        return {
          pkgbuild: readFileSync(join(dir, "aur-files/PKGBUILD"), "utf8"),
          srcinfo: readFileSync(join(dir, "aur-files/.SRCINFO"), "utf8"),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("turns the release's PKGBUILD into the one package.mjs writes for the AUR", () => {
      const out = variant(pkgbuild({ ...input, installSource: release }));
      expect(out.pkgbuild).toBe(pkgbuild({ ...input, installSource: "aur" }));
      expect(out.srcinfo).toBe(srcinfo({ ...input, installSource: "aur" }));
    });

    it("fails on a PKGBUILD without exactly one install-source line", () => {
      const aurAlready = pkgbuild({ ...input, installSource: "aur" });
      expect(() => variant(aurAlready)).toThrow();
      const twice = pkgbuild({ ...input, installSource: release }).replace(
        "pkgrel=1\n",
        "pkgrel=1\n# vimma-package=pkgbuild-release\n",
      );
      expect(() => variant(twice)).toThrow();
    });
  });

  it("the failure issue tells how to re-run the AUR push", () => {
    expect(job("failure")).toContain("gh workflow run aur.yml -f tag=$TAG");
    expect(job("failure")).toMatch(/^ {6}issues: write/m);
  });
});

// homebrew.yml: pushes the Homebrew cask to vimma-browser/homebrew-tap, which Homebrew users read
// at once, so only for a published release, as aur.yml does for the AUR (spec macos-homebrew,
// decisions 9 and 10). Its only source is the published release's own files.
describe("homebrew.yml", () => {
  const file = readFileSync(
    new URL("../../../.github/workflows/homebrew.yml", import.meta.url),
    "utf8",
  );
  const all = new Map();
  {
    const body = file.slice(file.indexOf("\njobs:\n") + 7);
    const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) all.set(parts[i] ?? "", parts[i + 1] ?? "");
  }
  /** @param {string} id */
  const job = (id) => /** @type {string} */ (all.get(id) ?? "");
  const FETCH = "Download the published release's cask";

  it("has the homebrew job and its failure report", () => {
    expect([...all.keys()]).toEqual(["homebrew", "failure"]);
    expect(job("failure")).toMatch(/^ {4}needs: homebrew$/m);
  });

  // A release event's ref is its tag, and anyone with write access can create a tag on an
  // unmerged commit with an edited copy of this file: only main may reach the homebrew
  // environment's key (docs/security.md, B6 and B11).
  it("runs only by dispatch with a tag, never for a release event or a tag ref", () => {
    const on = triggersOf(file);
    expect(on).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n/m);
    expect(on).not.toMatch(
      /release:|pull_request|push:|schedule:|workflow_run:|repository_dispatch/,
    );
    expect(file).not.toMatch(/github\.event\.release|GITHUB_EVENT_NAME|event_name/);
    expect(file).toMatch(/^env:\n {2}TAG: \$\{\{ inputs\.tag \}\}$/m);
    expect(file).toMatch(/^permissions: \{\}$/m);
  });

  it.each(["homebrew", "failure"])(
    "job %s runs only when the macOS release is enabled, here, from main",
    (id) => {
      const cond = condition(job(id));
      expect(cond).toContain(
        "vars.RELEASE_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' && " +
          "github.ref == 'refs/heads/main'",
      );
      expect(cond).not.toMatch(/refs\/tags|event_name/);
      expect(cond).toContain("vars.MACOS_RELEASE_ENABLED == 'true'");
    },
  );

  // releases/download/<tag>/ serves a published release's assets only: a draft's are a 404, so
  // the job cannot push a draft's cask even when started by hand for its tag.
  it("takes the cask from the published release only, with no GitHub token", () => {
    const brew = job("homebrew");
    expect(brew).toMatch(/^ {4}permissions: \{\}$/m);
    expect(brew).not.toMatch(/github\.token|GH_TOKEN|gh release|gh api|actions\/checkout|node /);
    const fetch = runOf(brew, FETCH);
    expect(fetch).toContain('base="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG"');
    expect(fetch).toMatch(/curl -fsSL/);
    expect(fetch).toContain("for f in SHA256SUMS-macos SHA256SUMS-macos.sigstore.json; do");
    expect(fetch).toMatch(/grep -E ' {2}vimma\\\.rb\$' SHA256SUMS-macos/);
    expect(fetch).toContain("sha256sum -c -");
    // a signed SHA256SUMS-macos is not bound to its tag: the cask must be this release's version
    expect(fetch).toContain(`grep -qx "  version \\"\${TAG#v}\\"" vimma.rb`);
  });

  /**
   * Runs the download step against a stub `curl` that serves `files` (name -> content) and 404s
   * the rest.
   * @param {Record<string, string>} files
   */
  const fetchWith = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "homebrew-fetch-"));
    try {
      const served = join(dir, "served");
      execFileSync("mkdir", ["-p", served, join(dir, "bin"), join(dir, "work")]);
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(served, name), content);
      }
      // curl -fsSL -o <file> <url>: copies the served file named by the URL's last segment
      writeFileSync(
        join(dir, "bin", "curl"),
        `#!/bin/sh\nout=$3; name=\${4##*/}\n[ -f "${served}/$name" ] || exit 22\ncp "${served}/$name" "$out"\n`,
        { mode: 0o755 },
      );
      const output = join(dir, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-e", "-c", runOf(job("homebrew"), FETCH)], {
        cwd: join(dir, "work"),
        encoding: "utf8",
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          HOME: dir,
          TAG: "v0.1.6",
          GITHUB_REPOSITORY: "vimma-browser/vimma",
          GITHUB_OUTPUT: output,
        },
      });
      return { ...result, outputs: readFileSync(output, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const rb = 'cask "vimma" do\n  version "0.1.6"\nend\n';
  const sums = `${createHash("sha256").update(rb).digest("hex")}  vimma.rb\n`;

  it("the download step accepts the release's cask listed in SHA256SUMS-macos", () => {
    const result = fetchWith({ "vimma.rb": rb, "SHA256SUMS-macos": sums });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.outputs).toBe("ready=true\n");
  });

  // release.yml's macos-tap dispatches this only once the cask is on the published release.
  it("a release without the cask is an error", () => {
    const result = fetchWith({});
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.outputs).toBe("");
  });

  it.each([
    [
      "a cask that does not match its checksum",
      { "vimma.rb": `${rb}#\n`, "SHA256SUMS-macos": sums },
    ],
    [
      "a cask of another version",
      {
        "vimma.rb": rb.replace("0.1.6", "0.1.5"),
        "SHA256SUMS-macos": `${createHash("sha256").update(rb.replace("0.1.6", "0.1.5")).digest("hex")}  vimma.rb\n`,
      },
    ],
    [
      "a SHA256SUMS-macos without the cask",
      { "vimma.rb": rb, "SHA256SUMS-macos": `${"0".repeat(64)}  vimma-0.1.6-macos-aarch64.dmg\n` },
    ],
    ["a missing SHA256SUMS-macos", { "vimma.rb": rb }],
  ])("the download step refuses %s", (_, files) => {
    const result = fetchWith(files);
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe("");
  });

  // An environment limited to main and v* tags holds the tap's deploy key, so a workflow on
  // another branch cannot read it.
  it("takes the tap key from the homebrew environment", () => {
    expect(job("homebrew")).toMatch(/^ {4}environment: homebrew$/m);
    expect(job("failure")).not.toContain("environment:");
  });

  it("checks SHA256SUMS-macos's signature against the documented identity when signing is on", () => {
    const brew = job("homebrew");
    expect(brew).toContain(`--certificate-identity-regexp '${IDENTITY_REGEXP}'`);
    expect(brew).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
    expect(brew).toContain("cosign verify-blob --bundle SHA256SUMS-macos.sigstore.json");
    expect(brew).toMatch(
      /if: steps\.cask\.outputs\.ready == 'true' && vars\.SIGNING_ENABLED == 'true'/,
    );
  });

  it("checks the tag's form before anything is fetched", () => {
    const brew = job("homebrew");
    expect(brew).toContain("grep -Eqx 'v[0-9]+\\.[0-9]+\\.[0-9]+'");
    expect(brew.indexOf("Check the tag's form")).toBeLessThan(brew.indexOf("curl -fsSL"));
  });

  it("the tap key reaches only the push step", () => {
    expect(file.match(/secrets\.HOMEBREW_TAP_SSH_KEY/g)).toHaveLength(2);
    expect(job("homebrew")).toMatch(
      /^ {6}KEY_SET: \$\{\{ secrets\.HOMEBREW_TAP_SSH_KEY != '' \}\}$/m,
    );
    const push = job("homebrew").slice(job("homebrew").indexOf("- name: Push Casks/vimma.rb"));
    expect(push).toMatch(/^ {10}HOMEBREW_TAP_SSH_KEY: \$\{\{ secrets\.HOMEBREW_TAP_SSH_KEY \}\}$/m);
  });

  // github.com's Ed25519 host key, as GitHub publishes it (api.github.com/meta, ssh_keys; the
  // fingerprint SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU in GitHub's documentation).
  it("pushes Casks/vimma.rb to the tap over SSH with github.com's pinned host key", () => {
    const push = runOf(job("homebrew"), "Push Casks/vimma.rb");
    expect(job("homebrew")).toContain(
      "GITHUB_HOST_KEY: github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    );
    expect(push).toContain("-o StrictHostKeyChecking=yes");
    expect(push).toContain("git clone git@github.com:vimma-browser/homebrew-tap.git tap");
    expect(push).toContain("cp vimma.rb tap/Casks/vimma.rb");
    expect(push).toContain("git add Casks/vimma.rb\n");
    expect(push).toContain('commit -m "vimma ${TAG#v}"');
    expect(push).toContain("git push origin HEAD:main");
    expect(push).not.toMatch(/--force|-f origin|\+HEAD/);
  });

  describe("the push step", () => {
    /**
     * Runs the push step against a bare repository standing in for the tap: `git clone` of the
     * tap's URL is redirected to it.
     * @param {string | null} tapCask the tap's Casks/vimma.rb before the push, null for none
     * @param {string} tag
     */
    const push = (tapCask, tag) => {
      const dir = mkdtempSync(join(tmpdir(), "homebrew-push-"));
      try {
        const bare = join(dir, "tap.git");
        const git = (/** @type {string[]} */ ...args) =>
          execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
        git("init", "-q", "--bare", "-b", "main", bare);
        git("clone", "-q", bare, "seed");
        const seed = join(dir, "seed");
        writeFileSync(join(seed, "README.md"), "tap\n");
        if (tapCask !== null) {
          execFileSync("mkdir", ["-p", join(seed, "Casks")]);
          writeFileSync(join(seed, "Casks/vimma.rb"), tapCask);
        }
        const id = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
        execFileSync("git", ["add", "-A"], { cwd: seed });
        execFileSync("git", [...id, "commit", "-qm", "seed"], { cwd: seed });
        execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: seed });
        const work = join(dir, "work");
        execFileSync("mkdir", ["-p", work]);
        writeFileSync(
          join(work, "vimma.rb"),
          `cask "vimma" do\n  version "${tag.slice(1)}"\nend\n`,
        );
        const gitconfig = join(dir, "gitconfig");
        writeFileSync(
          gitconfig,
          `[url "${bare}"]\n\tinsteadOf = git@github.com:vimma-browser/homebrew-tap.git\n`,
        );
        const result = spawnSync(
          "bash",
          ["-e", "-c", runOf(job("homebrew"), "Push Casks/vimma.rb")],
          {
            cwd: work,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: dir,
              GIT_CONFIG_GLOBAL: gitconfig,
              TAG: tag,
              HOMEBREW_TAP_SSH_KEY: "not a key",
              GITHUB_HOST_KEY: "github.com ssh-ed25519 AAAA",
              MAINTAINER: "A Maintainer <a@example.org>",
            },
          },
        );
        const log = git("--git-dir", bare, "log", "--format=%s", "main");
        const now = git("--git-dir", bare, "show", "main:Casks/vimma.rb");
        return { ...result, log, now };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("commits the cask as vimma X.Y.Z", () => {
      const result = push(null, "v0.1.6");
      expect(result.stderr).not.toMatch(/error|fatal/i);
      expect(result.status).toBe(0);
      expect(result.log).toBe("vimma 0.1.6\nseed\n");
      expect(result.now).toContain('version "0.1.6"');
    });

    it("pushes nothing when the tap already has this cask", () => {
      const result = push('cask "vimma" do\n  version "0.1.6"\nend\n', "v0.1.6");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::notice::");
      expect(result.log).toBe("seed\n");
    });

    // A re-run for an older release, after a newer one reached the tap, must not take users back.
    it("never replaces a newer cask with an older one", () => {
      const result = push('cask "vimma" do\n  version "0.1.10"\nend\n', "v0.1.9");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::notice::");
      expect(result.log).toBe("seed\n");
      expect(result.now).toContain('version "0.1.10"');
    });
  });

  it("the failure issue tells how to re-run the tap push", () => {
    expect(job("failure")).toContain("gh workflow run homebrew.yml -f tag=$TAG");
    expect(job("failure")).toMatch(/^ {6}issues: write/m);
  });

  it("every action is pinned by a full commit SHA", () => {
    const uses = [...file.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});

// release-please's bumps and the release gate (spec release-versioning).
describe("release-please-config.json", () => {
  /** @param {string} path */
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const config = json("../../../release-please-config.json");
  const manifest = json("../../../.release-please-manifest.json");
  const surfer = json("../../../surfer.json");

  // Every release bumps the patch, breaking changes too; the move to 0.2.0 or 1.0.0 is the
  // maintainer's, by a Release-As footer (runbook "Releases").
  it("bumps only the patch, whatever the commits say", () => {
    expect(config.versioning).toBe("always-bump-patch");
    expect(config.packages["."].versioning).toBeUndefined();
  });

  it("has no pre-1.0 bump rules that always-bump-patch would silently override", () => {
    expect(config["bump-minor-pre-major"]).toBeUndefined();
    expect(config["bump-patch-for-minor-pre-major"]).toBeUndefined();
  });

  it("pins no version for every release", () => {
    expect(config["release-as"]).toBeUndefined();
    expect(config.packages["."]["release-as"]).toBeUndefined();
  });

  // release.yml builds and uploads to the draft; publishing it is the maintainer's click, and
  // aur.yml's trigger. A release created published would be public before its assets exist.
  it("creates every release as a draft, with its tag", () => {
    expect(config.draft).toBe(true);
    expect(config["force-tag-creation"]).toBe(true);
    expect(config.prerelease).toBeUndefined();
  });

  it("keeps the manifest at surfer.json's displayVersion", () => {
    expect(manifest["."]).toBe(surfer.brands.vimma.release.displayVersion);
  });
});

// `vimma --version` prints `Vimma <vimma> · Firefox <firefox>` (spec firefox-versions): every smoke
// check takes the expected line from tools/release/version-line.mjs, never its own copy of it.
describe("--version smoke checks", () => {
  /** @param {string} name */
  const workflow = (name) =>
    readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");
  /**
   * The `run:` block of the step called `name`.
   * @param {string} file
   * @param {string} name
   */
  const step = (file, name) => {
    const start = file.indexOf(`- name: ${name}\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = file.slice(start + 1);
    const end = rest.search(/\n {6}- (?:name|uses):/);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("nightly and release smoke checks compare --version with versionLine", () => {
    const nightly = workflow("nightly.yml");
    const release = workflow("release.yml");
    const checks = [
      step(nightly, "Smoke check"),
      step(release, "Smoke check"),
      step(release, "Smoke test the .deb and the AppImage"),
    ];
    for (const check of checks) {
      expect(check).toContain("node tools/release/version-line.mjs");
      expect(check).toMatch(/--version/);
    }
    // the .deb and the AppImage are each compared with the line
    expect(checks[2]?.match(/= "\$line" \]/g)).toHaveLength(2);
    for (const file of [nightly, release]) expect(file).not.toContain("Vimma Vimma");
  });

  // docs/specs/m6a-updater.md §3: the install types the update check gives the built packages.
  it("the .deb and AppImage smoke test checks each install type, and the tarball's lack of one", () => {
    const smoke = step(workflow("release.yml"), "Smoke test the .deb and the AppImage");
    expect(smoke).toContain("type=$(node tools/package/install-type.mjs /usr/lib/vimma)\n");
    expect(smoke).toContain('[ "$type" = deb ] || {');
    expect(smoke).toMatch(/--appimage-extract/);
    expect(smoke).toContain(
      'type=$(env -u APPIMAGE node tools/package/install-type.mjs "$RUNNER_TEMP/squashfs-root/usr/lib/vimma")\n',
    );
    expect(smoke).toContain('[ "$type" = appimage ] || {');
    expect(smoke).toContain('listing=$(tar -tJf "./dist/vimma-$v-linux-x86_64.tar.xz")\n');
    expect(smoke).toContain('case "$listing" in *is-packaged-app*) echo');
  });

  it("the release smoke check also ties the line to the tag", () => {
    expect(step(workflow("release.yml"), "Smoke check")).toContain('"Vimma ${TAG#v} · Firefox "');
  });
});

// release-please.yml's post-steps (spec firefox-versions, decisions 7 and 8): the release PR's
// CHANGELOG.md heading and the GitHub Release's title name the Firefox version. They hold write
// tokens on every push to main, so their scopes and inputs are pinned here.
describe("release-please.yml", () => {
  const file = readFileSync(
    new URL("../../../.github/workflows/release-please.yml", import.meta.url),
    "utf8",
  );
  const all = new Map();
  {
    const body = file.slice(file.indexOf("\njobs:\n") + 7);
    const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) all.set(parts[i] ?? "", parts[i + 1] ?? "");
  }
  /** @param {string} id */
  const job = (id) => /** @type {string} */ (all.get(id) ?? "");
  /** @param {string} id job id -> its `permissions:` entries, comments dropped */
  const permissions = (id) => {
    const match = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(job(id));
    return (match?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean);
  };

  it("has the release-please job, the two Firefox post-steps and the release build start", () => {
    expect([...all.keys()]).toEqual([
      "release-please",
      "firefox-notes",
      "release-title",
      "release-build",
      "security-release",
    ]);
    expect(job("security-release")).toMatch(/^ {4}needs: \[release-please, firefox-notes\]$/m);
    expect(job("release-build")).toMatch(/^ {4}needs: release-please$/m);
    expect(job("firefox-notes")).toMatch(/^ {4}needs: release-please$/m);
    expect(job("release-title")).toMatch(/^ {4}needs: release-please$/m);
  });

  it("release-please.yml grants nothing by default and each job only what it needs", () => {
    expect(file).toMatch(/^permissions: \{\}$/m);
    expect(permissions("release-please")).toEqual([
      "contents: write",
      "pull-requests: write",
      "issues: write",
    ]);
    expect(permissions("firefox-notes")).toEqual(["contents: read", "pull-requests: read"]);
    expect(permissions("release-title")).toEqual(["contents: write"]);
    expect(permissions("release-build")).toEqual(["actions: write"]);
    // reads and writes go through RELEASE_PLEASE_TOKEN; GITHUB_TOKEN only checks out main
    expect(permissions("security-release")).toEqual(["contents: read"]);
  });

  // Spec firefox-versions, decisions 11 to 15; docs/security.md G9 and G10.
  it("security-release runs only on a push to main of vimma-browser/vimma", () => {
    const release = job("security-release");
    expect(condition(release)).toBe(
      "github.repository == 'vimma-browser/vimma' && github.event_name == 'push' && " +
        "github.ref == 'refs/heads/main' && vars.AUTO_SECURITY_RELEASE == 'true'",
    );
    // decide() checks the same again from the step's environment
    expect(release).toContain("AUTO_SECURITY_RELEASE: ${{ vars.AUTO_SECURITY_RELEASE }}");
    expect(release).toContain("run: node tools/release/security-release.mjs");
    // main's code runs, never the release branch's
    expect(release).not.toMatch(/^ {10}ref:/m);
    expect(release).not.toMatch(/gh pr merge|--admin/);
  });

  // GITHUB_TOKEN's events start no workflow, except workflow_dispatch: the draft's build starts
  // without RELEASE_PLEASE_TOKEN, and runs release.yml from main, the identity users verify.
  it("release-build starts release.yml on main for the tag release-please just created", () => {
    const start = job("release-build");
    expect(condition(start)).toBe(
      "needs.release-please.outputs.release_created == 'true' && vars.RELEASE_ENABLED == 'true'",
    );
    expect(start).toContain("TAG: ${{ needs.release-please.outputs.tag_name }}");
    expect(start).toContain("GH_TOKEN: ${{ github.token }}");
    expect(start).toContain("grep -Eqx 'v[0-9]+\\.[0-9]+\\.[0-9]+'");
    expect(start).toContain(
      'gh api --method POST "repos/$GITHUB_REPOSITORY/actions/workflows/release.yml/dispatches" \\',
    );
    expect(start).toContain('-f ref=main -f "inputs[tag]=$TAG"');
    // it runs no repository code
    expect(start).not.toMatch(/actions\/checkout|setup-node|node /);
  });

  it("only release-title holds contents: write from GITHUB_TOKEN besides release-please", () => {
    for (const [id, block] of all) {
      expect(block.includes("contents: write"), id).toBe(
        id === "release-please" || id === "release-title",
      );
    }
  });

  it("no job runs on pull_request or pull_request_target", () => {
    const on = file.slice(file.indexOf("\non:\n"), file.indexOf("\npermissions:"));
    expect(on).not.toMatch(/pull_request/);
    expect(on).toMatch(/^ {2}push:\n {4}branches: \[main\]\n/m);
  });

  it("every action is pinned by a full commit SHA", () => {
    const uses = [...file.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(3);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("no checkout keeps a token in .git/config", () => {
    for (const id of ["firefox-notes", "release-title", "security-release"]) {
      const checkouts = job(id).split("uses: actions/checkout@").slice(1);
      expect(checkouts, id).toHaveLength(1);
      expect(checkouts[0], id).toMatch(
        /^\S+ # v[\d.]+\n {8}with:\n(?: {10}.*\n)*? {10}persist-credentials: false\n/,
      );
    }
  });

  it("RELEASE_PLEASE_TOKEN reaches only release-please, the changelog push and the auto-merge", () => {
    const release = job("security-release");
    expect(release.match(/secrets\.RELEASE_PLEASE_TOKEN/g)).toHaveLength(1);
    expect(release).toMatch(/^ {10}RELEASE_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}$/m);
    expect(job("release-title")).not.toContain("RELEASE_PLEASE_TOKEN");
    expect(job("release-build")).not.toContain("RELEASE_PLEASE_TOKEN");
    const notes = job("firefox-notes");
    expect(notes.match(/secrets\.RELEASE_PLEASE_TOKEN/g)).toHaveLength(1);
    // as an env var of the step, never in a `with:` or the checkout
    expect(notes).toMatch(/^ {10}PUSH_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}$/m);
    expect(notes).toMatch(/GH_TOKEN="\$PUSH_TOKEN" gh api --method PUT /);
  });

  it("firefox-notes reads the release branch as data and does nothing without the token", () => {
    const notes = job("firefox-notes");
    // main's code runs; the release branch's files come through the contents API only
    expect(notes).not.toMatch(/^ {10}ref:/m);
    expect(notes).toContain("BRANCH: release-please--branches--main");
    expect(notes).toContain("node tools/release/firefox-notes.mjs");
    expect(notes).toMatch(/if \[ -z "\$PUSH_TOKEN" \]; then\n\s+echo "::notice::/);
    expect(notes).toContain("chore(release): firefox $firefox in the changelog heading");
    // the push names the blob it replaces, so a force-push by release-please in between fails it
    expect(notes).toContain("sha: $sha");
  });

  it("release-title runs only when a release was created and titles it with versionLine", () => {
    const title = job("release-title");
    expect(condition(title)).toBe("needs.release-please.outputs.release_created == 'true'");
    expect(title).toContain("ref: refs/tags/${{ needs.release-please.outputs.tag_name }}");
    expect(title).toContain("node tools/release/version-line.mjs");
    expect(title).toContain("node tools/release/firefox-notes.mjs");
    expect(title).toContain('"Vimma ${TAG#v} · Firefox "');
    expect(title).toMatch(
      /gh api --method PATCH "repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_ID"/,
    );
    // Edits the name and the body, and resends the tag it verified: a PATCH to a draft release
    // that leaves out tag_name detaches the draft from its tag (tag_name becomes untagged-...),
    // and publishing it then creates a new tag on the default branch. The draft flag stays as
    // release-please set it.
    expect(title).toMatch(
      /if \[ "\$\(jq -r \.tag_name "\$dir\/release\.json"\)" != "\$TAG" \]; then/,
    );
    expect(title).toContain(
      'jq -n --arg tag "$TAG" --arg name "$title" --rawfile body "$dir/new.md"',
    );
    expect(title).toContain("{tag_name: $tag, name: $name, body: $body}");
    // and no other tag_name anywhere in the job
    expect(title).not.toMatch(/tag_name: (?!\$tag\b)/);
    // and fails when GitHub's answer names another tag
    expect(title).toContain('[ "$(jq -r .tag_name "$dir/edited.json")" = "$TAG" ] || exit 1');
    expect(title).not.toMatch(
      /\bdraft\s*:\s*(?:true|false|\$)|make_latest|target_commitish|gh release (?:create|delete|upload|edit)/,
    );
    expect(job("release-please")).toMatch(
      /^ {6}release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}$/m,
    );
  });
});

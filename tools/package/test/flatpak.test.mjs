import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load } from "js-yaml";
import { installTypeFrom } from "../../../packages/vimma-core/src/updates.mjs";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  APP_ID,
  FINISH_ARGS,
  RUNTIME_VERSION,
  flatpakDesktopEntry,
  flatpakLauncher,
  flatpakManifest,
  metainfo,
  writeFlatpak,
} from "../flatpak.mjs";
import { IDENTITY_REGEXP, checkDesktopEntry } from "../package.mjs";

// Spec flatpak: the Flatpak manifest built from the release tarball, as Flathub would build it,
// and the CI that builds and runs it (flatpak.yml, tools/package/flatpak-smoke.sh).

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const surfer = JSON.parse(readFileSync(join(repo, "surfer.json"), "utf8"));
const SHA = "a".repeat(64);
const brandDir = join(repo, "configs/branding/vimma");

/** @param {Partial<Parameters<typeof flatpakManifest>[0]>} [over] */
const manifest = (over = {}) =>
  flatpakManifest({ version: "0.1.6", source: { url: true, sha256: SHA }, ...over });

/** @param {ReturnType<typeof flatpakManifest>} m */
const vimmaModule = (m) => {
  const mod = m.modules.find((x) => x.name === "vimma");
  if (!mod) throw new Error("no vimma module");
  return mod;
};

describe("Flatpak manifest", () => {
  it("names the app surfer.json's appId and runs on the Freedesktop 25.08 runtime", () => {
    expect(APP_ID).toBe(surfer.appId);
    const m = manifest();
    expect(m.id).toBe("dev.vimma.browser");
    expect(m.runtime).toBe("org.freedesktop.Platform");
    expect(m["runtime-version"]).toBe("25.08");
    expect(RUNTIME_VERSION).toBe("25.08");
    expect(m.sdk).toBe("org.freedesktop.Sdk");
    expect(m.command).toBe("vimma");
    // org.mozilla.firefox.BaseApp is end-of-life outside Mozilla's own apps; nothing builds on it.
    expect(JSON.stringify(m)).not.toMatch(/BaseApp/);
  });

  it("takes the release tarball from the tag's download URL, pinned by SHA-256", () => {
    const src = vimmaModule(manifest()).sources[0];
    expect(src).toEqual({
      type: "archive",
      url: "https://github.com/vimma-browser/vimma/releases/download/v0.1.6/vimma-0.1.6-linux-x86_64.tar.xz",
      sha256: SHA,
      dest: "vimma",
    });
  });

  it("takes a local tarball by file name for a test build", () => {
    const m = manifest({ source: { path: "vimma-stub.tar.xz", sha256: SHA } });
    expect(vimmaModule(m).sources[0]).toEqual({
      type: "archive",
      path: "vimma-stub.tar.xz",
      sha256: SHA,
      dest: "vimma",
    });
  });

  it.each([
    ["a version that is not SemVer", { version: "0.1" }],
    ["a version with a shell character", { version: "0.1.6;id" }],
    ["an upper-case SHA-256", { source: { url: true, sha256: "A".repeat(64) } }],
    ["a short SHA-256", { source: { url: true, sha256: "a".repeat(63) } }],
    ["a path outside the manifest's directory", { source: { path: "../x.tar.xz", sha256: SHA } }],
    ["an absolute path", { source: { path: "/tmp/x.tar.xz", sha256: SHA } }],
  ])("refuses %s", (_name, over) => {
    expect(() => manifest(/** @type {any} */ (over))).toThrow();
  });

  it("grants Firefox's Flatpak permissions and the Omarchy theme read-only, never the home", () => {
    const args = manifest()["finish-args"];
    expect(args).toEqual(FINISH_ARGS);
    expect(args).toEqual([
      "--share=ipc",
      "--share=network",
      "--socket=wayland",
      "--socket=fallback-x11",
      "--socket=pulseaudio",
      "--socket=pcsc",
      "--socket=cups",
      "--device=all",
      "--env=DICPATH=/usr/share/hunspell",
      "--filesystem=xdg-download",
      "--filesystem=xdg-config/gtk-3.0:ro",
      "--filesystem=/run/.heim_org.h5l.kcm-socket",
      "--filesystem=/run/udev:ro",
      "--filesystem=xdg-run/speech-dispatcher:ro",
      "--filesystem=~/.local/state/omarchy:ro",
      "--talk-name=org.freedesktop.FileManager1",
      "--talk-name=org.a11y.Bus",
      "--talk-name=org.gtk.vfs.*",
      "--system-talk-name=org.freedesktop.NetworkManager",
      "--own-name=org.mozilla.vimma.*",
      "--own-name=org.mpris.MediaPlayer2.firefox.*",
    ]);
    for (const a of args) {
      expect(a).not.toMatch(
        /^--filesystem=(home|host|~\/?$|~\/\.config|xdg-data)|--allow=devel|:create/,
      );
      if (a.startsWith("--filesystem=xdg-config"))
        expect(a).toBe("--filesystem=xdg-config/gtk-3.0:ro");
    }
  });

  it("installs Vimma in /app/lib/vimma with the flatpak marker, the launcher and its files", () => {
    const mod = vimmaModule(manifest());
    expect(mod.buildsystem).toBe("simple");
    const script = mod["build-commands"].join("\n");
    expect(script).toContain("cp -a vimma /app/lib/vimma");
    expect(script).toContain("printf 'vimma-package=flatpak\\n' > /app/lib/vimma/is-packaged-app");
    expect(script).toContain("install -Dm755 vimma.sh /app/bin/vimma");
    expect(script).toContain(
      "install -Dm644 dev.vimma.browser.desktop /app/share/applications/dev.vimma.browser.desktop",
    );
    expect(script).toContain(
      "install -Dm644 dev.vimma.browser.metainfo.xml /app/share/metainfo/dev.vimma.browser.metainfo.xml",
    );
    expect(script).toContain(
      "install -Dm644 dev.vimma.browser.png /app/share/icons/hicolor/512x512/apps/dev.vimma.browser.png",
    );
    for (const size of [16, 32, 48, 64, 128]) {
      expect(script).toContain(
        `install -Dm644 vimma/browser/chrome/icons/default/default${size}.png ` +
          `/app/share/icons/hicolor/${size}x${size}/apps/dev.vimma.browser.png`,
      );
    }
    expect(mod.sources.slice(1)).toEqual([
      { type: "file", path: "vimma.sh" },
      { type: "file", path: "dev.vimma.browser.desktop" },
      { type: "file", path: "dev.vimma.browser.metainfo.xml" },
      { type: "file", path: "dev.vimma.browser.png" },
    ]);
  });

  it("puts no input into a build command, so none can change what the build runs", () => {
    const a = vimmaModule(manifest({ version: "9.8.7" }))["build-commands"];
    const b = vimmaModule(manifest({ source: { path: "x.tar.xz", sha256: "b".repeat(64) } }))[
      "build-commands"
    ];
    expect(a).toEqual(b);
  });
});

describe("Flatpak desktop entry and launcher", () => {
  const entry = flatpakDesktopEntry();

  it("passes the desktop file checks and names the app id for its icon and window class", () => {
    expect(checkDesktopEntry(entry)).toEqual([]);
    expect(entry).toMatch(/^Exec=vimma %u$/m);
    expect(entry).toMatch(/^Icon=dev\.vimma\.browser$/m);
    expect(entry).toMatch(/^StartupWMClass=dev\.vimma\.browser$/m);
    expect(entry).toMatch(/^Exec=vimma --new-window %u$/m);
    // vimma-open walks /proc to the opening app, which the sandbox's PID namespace hides.
    expect(entry).not.toContain("vimma-open");
  });

  it("starts Vimma with the app id as its window name and a temp dir in the app's cache", () => {
    const sh = flatpakLauncher();
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('exec /app/lib/vimma/vimma --name dev.vimma.browser "$@"\n');
    expect(sh).toContain('export TMPDIR="$XDG_CACHE_HOME/tmp"');
    expect(spawnSync("sh", ["-n", "-c", sh]).status).toBe(0);
  });
});

describe("Flatpak metainfo", () => {
  const xml = metainfo({ version: "0.1.6", date: "2026-10-19" });

  it("describes the app for AppStream with its licence, developer, launchable and release", () => {
    expect(xml).toContain('<component type="desktop-application">');
    expect(xml).toContain("<id>dev.vimma.browser</id>");
    expect(xml).toContain("<metadata_license>CC0-1.0</metadata_license>");
    expect(xml).toContain("<project_license>MPL-2.0</project_license>");
    expect(xml).toContain('<developer id="dev.vimma">');
    expect(xml).toContain('<launchable type="desktop-id">dev.vimma.browser.desktop</launchable>');
    expect(xml).toContain('<url type="homepage">https://vimma.dev/</url>');
    expect(xml).toContain('<release version="0.1.6" date="2026-10-19"');
    expect(xml).toContain('<content_rating type="oars-1.1"');
  });

  it.each(["2026-1-19", "19.10.2026", "2026-10-19T00:00"])("refuses the date %j", (date) => {
    expect(() => metainfo({ version: "0.1.6", date })).toThrow();
  });

  const appstream = spawnSync("appstreamcli", ["--version"]).status === 0;
  it.skipIf(!appstream)("passes appstreamcli validate", () => {
    const dir = tempDir("vimma-metainfo-");
    const file = join(dir, "dev.vimma.browser.metainfo.xml");
    writeFileSync(file, xml);
    const r = spawnSync("appstreamcli", ["validate", "--no-net", "--explain", file], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr, r.stdout).not.toMatch(/^E:|^W:/m);
    expect(r.status).toBe(0);
  });
});

describe("writeFlatpak", () => {
  it("writes the manifest and every file it names next to it", () => {
    const out = tempDir("vimma-flatpak-");
    const tarball = join(out, "in.tar.xz");
    writeFileSync(tarball, "stub");
    const files = writeFlatpak({
      out: join(out, "fp"),
      version: "0.1.6",
      date: "2026-10-19",
      tarball,
      brandDir,
    });
    const m = JSON.parse(readFileSync(join(out, "fp", "dev.vimma.browser.json"), "utf8"));
    expect(files.map((f) => f.slice(out.length + 4)).sort()).toEqual(
      [
        "dev.vimma.browser.json",
        "dev.vimma.browser.desktop",
        "dev.vimma.browser.metainfo.xml",
        "dev.vimma.browser.png",
        "vimma.sh",
        "vimma-0.1.6-linux-x86_64.tar.xz",
      ].sort(),
    );
    for (const src of vimmaModule(m).sources) {
      expect(existsSync(join(out, "fp", src.path ?? "")), src.path).toBe(true);
    }
    expect(vimmaModule(m).sources[0].sha256).toBe(
      createHash("sha256").update("stub").digest("hex"),
    );
    expect(readFileSync(join(out, "fp", "dev.vimma.browser.png"))).toEqual(
      readFileSync(join(brandDir, "logo512.png")),
    );
  });

  it("names the release URL when given a SHA-256 instead of a tarball", () => {
    const out = tempDir("vimma-flatpak-");
    writeFlatpak({ out, version: "0.1.6", date: "2026-10-19", sha256: SHA, brandDir });
    const m = JSON.parse(readFileSync(join(out, "dev.vimma.browser.json"), "utf8"));
    expect(vimmaModule(m).sources[0].url).toMatch(/\/releases\/download\/v0\.1\.6\//);
    expect(existsSync(join(out, "vimma-0.1.6-linux-x86_64.tar.xz"))).toBe(false);
  });
});

describe("install type of the Flatpak", () => {
  it("is a package the update check knows only by its tool, never the tarball's unpack", () => {
    const type = installTypeFrom({
      packaged: true,
      marker: "vimma-package=flatpak\n",
      appImage: null,
    });
    expect(type).toBe("packaged");
  });
});

describe("flatpak-smoke.sh", () => {
  const script = readFileSync(join(repo, "tools/package/flatpak-smoke.sh"), "utf8");

  it("is valid bash", () => {
    expect(spawnSync("bash", ["-n", join(repo, "tools/package/flatpak-smoke.sh")]).status).toBe(0);
  });

  it("pins the Fedora image by digest and the runtime and SDK by commit", () => {
    expect(script).toMatch(/^IMAGE=fedora@sha256:[0-9a-f]{64}$/m);
    expect(script).toMatch(/^PLATFORM_COMMIT=[0-9a-f]{64}$/m);
    expect(script).toMatch(/^SDK_COMMIT=[0-9a-f]{64}$/m);
    expect(script).toContain('flatpak update -y --noninteractive --commit="$PLATFORM_COMMIT"');
    expect(script).toContain('flatpak update -y --noninteractive --commit="$SDK_COMMIT"');
    expect(script).toContain("org.freedesktop.Platform//$RUNTIME");
    expect(script).toMatch(new RegExp(`^RUNTIME=${RUNTIME_VERSION.replace(".", "\\.")}$`, "m"));
    expect(script).toContain("--no-related");
  });

  it("compares the version line on stdout alone and checks the marker and desktop file", () => {
    expect(script).toContain("version=$(flatpak run dev.vimma.browser --version 2> /dev/null)");
    expect(script).toContain('[ "$version" = "$expected" ]');
    expect(script).toContain("vimma-package=flatpak");
    expect(script).toContain("desktop-file-validate");
    expect(script).toContain("appstreamcli validate");
  });

  it("refuses its inside half outside the container, since it installs system-wide", () => {
    const r = spawnSync("bash", [join(repo, "tools/package/flatpak-smoke.sh"), "--inside"], {
      encoding: "utf8",
      env: { ...process.env, VIMMA_FLATPAK_CONTAINER: "" },
    });
    expect(r.status).not.toBe(0);
  });
});

describe("flatpak.yml", () => {
  const text = readFileSync(join(repo, ".github/workflows/flatpak.yml"), "utf8");
  /** @type {any} */
  const wf = load(text, { schema: CORE_SCHEMA });
  const on = wf.on;

  it("runs on pull requests that touch packaging, on a published release, and by hand", () => {
    expect(Object.keys(on).sort()).toEqual(["pull_request", "release", "workflow_dispatch"]);
    expect(on.pull_request.paths).toEqual(
      expect.arrayContaining(["tools/package/**", "surfer.json", ".github/workflows/flatpak.yml"]),
    );
    expect(on.release.types).toEqual(["published"]);
    expect(on.workflow_dispatch.inputs.tag.required).toBe(true);
  });

  it("holds no secret and only reads the repository", () => {
    expect(wf.permissions).toEqual({});
    expect(text).not.toMatch(/secrets\.|environment:|GITHUB_TOKEN|github\.token/);
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(/** @type {any} */ (job).permissions, id).toEqual({ contents: "read" });
      expect(/** @type {any} */ (job)["runs-on"], id).toBe("ubuntu-24.04");
    }
  });

  it("builds a stub tarball on pull requests", () => {
    const stub = wf.jobs.stub;
    expect(stub.if).toBe("github.event_name == 'pull_request'");
    expect(stub.steps.map((/** @type {any} */ s) => s.run).filter(Boolean)).toContain(
      "tools/package/flatpak-smoke.sh --stub",
    );
  });

  it("builds a published release from its download URL, checked against SHA256SUMS", () => {
    const job = wf.jobs.release;
    expect(job.if).toContain("vars.RELEASE_ENABLED == 'true'");
    expect(job.if).toContain("github.repository == 'vimma-browser/vimma'");
    expect(job.if).toContain("github.event_name == 'release' || github.ref == 'refs/heads/main'");
    const run = job.steps.map((/** @type {any} */ s) => s.run ?? "").join("\n");
    expect(run).toContain("https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG");
    expect(run).toMatch(/grep -Eqx 'v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+'/);
    expect(run).toContain(
      "line=$(awk -v f=\"$file\" '$2 == f && $1 ~ /^[0-9a-f]{64}$/' SHA256SUMS)",
    );
    expect(run).toContain('case "$expected" in "Vimma ${TAG#v} · Firefox "*)');
    expect(run).toContain('tools/package/flatpak-smoke.sh --release "$TAG" "$sha" "$expected"');
  });

  it("checks the release's signature against the documented identity when signing is on", () => {
    const steps = wf.jobs.release.steps;
    const verify = steps.find((/** @type {any} */ s) => /cosign verify-blob/.test(s.run ?? ""));
    expect(verify.if).toBe("vars.SIGNING_ENABLED == 'true'");
    expect(verify.run).toContain(`--certificate-identity-regexp '${IDENTITY_REGEXP}'`);
    expect(verify.run).toContain(
      "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
    );
  });

  it("passes event values to run: through env only", () => {
    for (const job of Object.values(wf.jobs)) {
      for (const step of /** @type {any} */ (job).steps) {
        expect(step.run ?? "", step.name).not.toMatch(/\$\{\{/);
      }
    }
  });

  it("every action is pinned by a full commit SHA", () => {
    const uses = [...text.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});

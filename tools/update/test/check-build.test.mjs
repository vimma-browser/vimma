// docs/specs/m6a-updater.md "Delivery", sub-PR 2's done criteria, as a check a release or
// nightly job can run on the package before it signs anything: a VIMMA_UPDATES=1 build asks
// updates.vimma.dev, accepts MARs for its channel only, and its updater embeds Vimma's update
// certificates and none of Mozilla's. Fixtures stand in for an unpacked tarball.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { checkBuild } from "../check-build.mjs";

const SCRIPT = new URL("../check-build.mjs", import.meta.url).pathname;
const URL_LINE =
  "URL=https://updates.vimma.dev/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml";

/**
 * @param {{ url?: string | null, channel?: string, updater?: string[], pref?: string }} [o]
 *   updater: the certificate names whose bytes the fake updater binary carries
 */
function fixture(o = {}) {
  const root = tempDir("vimma-check-build-");
  const certs = join(root, "certs");
  const mozilla = join(root, "mozilla");
  const install = join(root, "vimma");
  for (const d of [certs, mozilla, join(install, "defaults/pref")])
    mkdirSync(d, { recursive: true });
  /** @type {Record<string, Buffer>} */
  const bytes = {
    "primary.der": Buffer.from("vimma-primary-certificate-bytes"),
    "secondary.der": Buffer.from("vimma-primary-certificate-bytes"),
    "dep1.der": Buffer.from("mozilla-dep1-test-certificate"),
    "dep2.der": Buffer.from("mozilla-dep2-test-certificate"),
    "release_primary.der": Buffer.from("mozilla-release-primary-cert"),
  };
  writeFileSync(join(certs, "primary.der"), bytes["primary.der"]);
  writeFileSync(join(certs, "secondary.der"), bytes["secondary.der"]);
  for (const f of ["dep1.der", "dep2.der", "release_primary.der"]) {
    writeFileSync(join(mozilla, f), bytes[f]);
  }
  const url = o.url === undefined ? URL_LINE : o.url;
  writeFileSync(
    join(install, "application.ini"),
    `[App]\nVendor=Vimma\nName=Vimma\n${url === null ? "" : `\n[AppUpdate]\n${url}\n`}`,
  );
  writeFileSync(
    join(install, "update-settings.ini"),
    `[Settings]\nACCEPTED_MAR_CHANNEL_IDS=${o.channel ?? "vimma"}\n`,
  );
  writeFileSync(
    join(install, "defaults/pref/channel-prefs.js"),
    o.pref ?? 'pref("app.update.channel", "vimma");\n',
  );
  const parts = (o.updater ?? ["primary.der"]).map((f) => bytes[f]);
  writeFileSync(join(install, "updater"), Buffer.concat([Buffer.from("\x7fELF"), ...parts]));
  return { install, certs, mozilla };
}

describe("check-build: an updater-enabled package", () => {
  it("passes a package that asks updates.vimma.dev and embeds Vimma's certificate only", () => {
    expect(checkBuild(fixture())).toEqual([]);
  });

  it("fails without the [AppUpdate] URL or with another host", () => {
    expect(checkBuild(fixture({ url: null })).join("\n")).toMatch(/AppUpdate/);
    const aus = URL_LINE.replace("updates.vimma.dev", "aus5.mozilla.org");
    expect(checkBuild(fixture({ url: aus })).join("\n")).toMatch(/aus5\.mozilla\.org/);
  });

  it("fails on another MAR channel or update channel", () => {
    expect(checkBuild(fixture({ channel: "vimma,release" })).join("\n")).toMatch(
      /ACCEPTED_MAR_CHANNEL_IDS/,
    );
    expect(
      checkBuild(fixture({ pref: 'pref("app.update.channel", "release");\n' })).join("\n"),
    ).toMatch(/app\.update\.channel/);
  });

  it("fails when the updater lacks Vimma's certificate or carries one of Mozilla's", () => {
    expect(checkBuild(fixture({ updater: [] })).join("\n")).toMatch(/primary\.der/);
    expect(checkBuild(fixture({ updater: ["primary.der", "dep1.der"] })).join("\n")).toMatch(
      /dep1\.der/,
    );
    expect(
      checkBuild(fixture({ updater: ["primary.der", "release_primary.der"] })).join("\n"),
    ).toMatch(/release_primary\.der/);
  });

  it("CLI: exit 0 with a summary, 1 with every problem listed", () => {
    const ok = fixture();
    const args = (/** @type {typeof ok} */ f) => [
      SCRIPT,
      f.install,
      "--certs",
      f.certs,
      "--mozilla-certs",
      f.mozilla,
    ];
    expect(execFileSync(process.execPath, args(ok), { encoding: "utf8" })).toContain("ok");
    const bad = fixture({ url: null, updater: ["dep1.der"] });
    let err = "";
    try {
      execFileSync(process.execPath, args(bad), { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      err = String(/** @type {{ stderr: string }} */ (e).stderr);
    }
    expect(err).toMatch(/AppUpdate/);
    expect(err).toMatch(/dep1\.der/);
  });
});

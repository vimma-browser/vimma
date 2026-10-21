// docs/specs/m6a-updater.md §3 and decision 19: the AppImage replaces its own file after a
// verified manifest offers a newer build. Pure rules: whether and where to replace, and whether a
// download matches what the signed manifest says. The host does the download and the rename.
import { describe, test, expect } from "vitest";
import {
  APPIMAGE_DOWNLOAD_PREFIX,
  appImagePartPath,
  appImagePlan,
  downloadProblem,
  ownAppImage,
  stagedSteps,
} from "../src/appimage-update.mjs";
import { RELEASES_URL } from "../src/updates.mjs";

const H = (/** @type {string} */ c) => c.repeat(128);
const URL = `${RELEASES_URL}/download/v0.3.1/vimma-0.3.1-x86_64.AppImage`;

/** @param {Partial<import("../src/updates.mjs").Offer>} [o] */
const offer = (o = {}) => ({
  appVersion: "158.0.1",
  buildId: "20261028031500",
  displayVersion: "0.3.1",
  detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
  urgent: false,
  advisories: [],
  assets: { appimage: { size: 111966712, sha512: H("b"), url: URL } },
  ...o,
});

const base = {
  installType: /** @type {const} */ ("appimage"),
  marker: "vimma-package=appimage\n",
  appImage: "/home/u/Apps/vimma-0.1.0-x86_64.AppImage",
  appDir: "/tmp/.mount_vimmaAb12Cd",
  greDir: "/tmp/.mount_vimmaAb12Cd/usr/lib/vimma",
  offer: offer(),
  automation: false,
  forced: false,
};

describe("appImagePlan (decision 19: replace $APPIMAGE after a verified offer)", () => {
  test("an AppImage build with an offer: download next to the file, then rename over it", () => {
    expect(appImagePlan(base)).toEqual({
      ok: true,
      target: "/home/u/Apps/vimma-0.1.0-x86_64.AppImage",
      part: "/home/u/Apps/.vimma-update-20261028031500.AppImage.part",
      url: URL,
      size: 111966712,
      sha512: H("b"),
    });
  });

  test("the part file sits in the AppImage's own directory, so the rename never crosses a disk", () => {
    expect(appImagePartPath("/V.AppImage", "20261028031500")).toBe(
      "/.vimma-update-20261028031500.AppImage.part",
    );
    expect(appImagePartPath("/a b/c/V.AppImage", "1")).toBe("/a b/c/.vimma-update-1.AppImage.part");
  });

  test("not an AppImage install: nothing to replace", () => {
    for (const installType of /** @type {const} */ (["tarball", "deb", "aur", "source"])) {
      expect(appImagePlan({ ...base, installType })).toMatchObject({ ok: false });
    }
  });

  test("no offer, or an offer whose manifest names no AppImage: nothing to replace", () => {
    expect(appImagePlan({ ...base, offer: null })).toMatchObject({ ok: false });
    expect(appImagePlan({ ...base, offer: offer({ assets: {} }) })).toEqual({
      ok: false,
      why: "the update manifest names no AppImage",
    });
    // A result saved by a version that did not keep the URL.
    const noUrl = { size: 1, sha512: H("b") };
    expect(appImagePlan({ ...base, offer: offer({ assets: { appimage: noUrl } }) })).toEqual({
      ok: false,
      why: "the update manifest names no AppImage",
    });
  });

  // Decision 34: $APPIMAGE is inherited by every program an AppImage starts, so a tarball Vimma
  // started from another AppImage sees it too and must never overwrite that file.
  test("without the AppDir's own appimage marker, $APPIMAGE is never replaced", () => {
    for (const marker of [null, "", "vimma-package=deb\n", "vimma-package=appimagex\n"]) {
      expect(appImagePlan({ ...base, marker })).toEqual({
        ok: false,
        why: "this Vimma is not an AppImage build (no vimma-package=appimage marker)",
      });
    }
  });

  test("a Vimma that does not run from $APPDIR is not the AppImage $APPIMAGE names", () => {
    const why = "this Vimma does not run from the AppImage's mount ($APPDIR)";
    expect(appImagePlan({ ...base, appDir: null })).toEqual({ ok: false, why });
    expect(appImagePlan({ ...base, appDir: "/tmp/.mount_other" })).toEqual({ ok: false, why });
    // A prefix of the path is not its parent.
    expect(appImagePlan({ ...base, appDir: "/tmp/.mount_vimmaAb" })).toEqual({ ok: false, why });
  });

  test.each([
    [null],
    [""],
    ["relative/V.AppImage"],
    ["/home/u/../u/V.AppImage"],
    ["/home/u/./V.AppImage"],
    ["/home//u/V.AppImage"],
    ["/home/u/"],
    ["/home/u/V.AppImage\n"],
    ["/"],
  ])("$APPIMAGE %j is not a plain absolute file path: refused", (appImage) => {
    expect(appImagePlan({ ...base, appImage })).toEqual({
      ok: false,
      why: "$APPIMAGE is not an absolute file path",
    });
  });

  // A leaked manifest key alone cannot make an AppImage install fetch a file from anywhere: it
  // also needs a release asset on the project's GitHub releases.
  test.each([
    ["another host", "https://example.com/vimma-0.3.1-x86_64.AppImage"],
    ["another repository", "https://github.com/someone/vimma/releases/download/v0.3.1/x"],
    ["a prefix trick", "https://github.com/vimma-browser/vimma/releases/download.evil.com/x"],
    ["a path that climbs out", `${RELEASES_URL}/download/../../other/x`],
    ["a query", `${RELEASES_URL}/download/v0.3.1/x?y`],
    ["plain http", URL.replace("https:", "http:")],
  ])("a download from %s is refused outside automation", (_name, url) => {
    const o = offer({ assets: { appimage: { size: 1, sha512: H("b"), url } } });
    expect(appImagePlan({ ...base, offer: o })).toEqual({
      ok: false,
      why: "the AppImage's URL is not a release download of vimma-browser/vimma",
    });
  });

  test("the project's release downloads, the nightly tag's included, are allowed", () => {
    expect(APPIMAGE_DOWNLOAD_PREFIX).toBe(
      "https://github.com/vimma-browser/vimma/releases/download/",
    );
    const nightly = `${RELEASES_URL}/download/nightly/vimma-nightly-20261028-x86_64.AppImage`;
    const o = offer({ assets: { appimage: { size: 1, sha512: H("b"), url: nightly } } });
    expect(appImagePlan({ ...base, offer: o })).toMatchObject({ ok: true, url: nightly });
  });

  test("in automation a local https test host may serve it, and the install type may be set", () => {
    const local = "https://example.com/browser/file_vimma_update_appimage.sjs?file";
    const o = offer({ assets: { appimage: { size: 1, sha512: H("b"), url: local } } });
    expect(appImagePlan({ ...base, offer: o, automation: true })).toMatchObject({ ok: true });
    expect(
      appImagePlan({
        ...base,
        offer: offer({ assets: { appimage: { size: 1, sha512: H("b"), url: "http://x/y" } } }),
        automation: true,
      }),
    ).toMatchObject({ ok: false });
    // A test sets the install type: no marker and no $APPDIR to check.
    expect(appImagePlan({ ...base, marker: null, appDir: null, forced: true })).toMatchObject({
      ok: true,
    });
  });
});

describe("downloadProblem (the file must be the one the signed manifest describes)", () => {
  const expected = { size: 5, sha512: H("b") };

  test("the signed size and SHA-512: no problem", () => {
    expect(downloadProblem(expected, { size: 5, sha512: H("b") })).toBeNull();
  });

  test("another size or hash: refused, with the reason", () => {
    expect(downloadProblem(expected, { size: 4, sha512: H("b") })).toBe(
      "the AppImage has 4 bytes, the signed manifest says 5",
    );
    expect(downloadProblem(expected, { size: 5, sha512: H("c") })).toBe(
      "the AppImage's SHA-512 does not match the signed manifest",
    );
  });

  test("the hash is compared as lower-case hex, never loosely", () => {
    expect(downloadProblem(expected, { size: 5, sha512: H("B") })).not.toBeNull();
    expect(downloadProblem(expected, { size: 5, sha512: "" })).not.toBeNull();
  });
});

describe("stagedSteps (what :update and about:vimma say once the file is replaced)", () => {
  test("names the version and the restart; no command to run", () => {
    expect(stagedSteps(offer())).toEqual({
      text: "Vimma replaced its AppImage with 0.3.1. Restart Vimma to run it; the file keeps its name.",
      commands: [],
      link: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
    });
  });
});

describe("ownAppImage (the AppImage a restart starts again, spec §5)", () => {
  const where = {
    installType: base.installType,
    marker: base.marker,
    appImage: base.appImage,
    appDir: base.appDir,
    greDir: base.greDir,
    forced: false,
  };

  test("this Vimma is the AppImage $APPIMAGE names: that file", () => {
    expect(ownAppImage(where)).toBe("/home/u/Apps/vimma-0.1.0-x86_64.AppImage");
  });

  test("$APPIMAGE inherited from another AppImage is never started (decision 34)", () => {
    expect(ownAppImage({ ...where, marker: null })).toBeNull();
    expect(ownAppImage({ ...where, marker: "vimma-package=deb\n" })).toBeNull();
    expect(ownAppImage({ ...where, greDir: "/opt/vimma" })).toBeNull();
    expect(ownAppImage({ ...where, appDir: null })).toBeNull();
    expect(ownAppImage({ ...where, installType: "tarball" })).toBeNull();
  });

  test("a $APPIMAGE that is not an absolute file path: none", () => {
    for (const appImage of [null, "", "vimma.AppImage", "/a/../b.AppImage", "/a/\nb"]) {
      expect(ownAppImage({ ...where, appImage })).toBeNull();
    }
  });

  test("a test's forced install type skips the marker, as for the replacement", () => {
    expect(ownAppImage({ ...where, marker: null, appDir: null, forced: true })).toBe(
      where.appImage,
    );
  });
});

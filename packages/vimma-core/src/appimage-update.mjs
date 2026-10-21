/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The AppImage replaces its own file (docs/specs/m6a-updater.md §3, decisions 19 and 34): after a
 * verified manifest offers a newer build, Vimma downloads the new AppImage next to the running
 * one, checks its size and SHA-512 against the signed manifest and renames it over `$APPIMAGE`.
 * The running process keeps its mounted image; the next start runs the new one. Pure rules: the
 * host does the download, the hash and the rename.
 */

import { RELEASES_URL } from "./updates.mjs";

/** @import { InstallType, Offer } from "./updates.mjs" */

/**
 * The only place an AppImage is downloaded from outside automation: a leaked manifest key alone
 * then cannot point installs at a file of its own, it also needs a release asset in the project.
 */
export const APPIMAGE_DOWNLOAD_PREFIX = `${RELEASES_URL}/download/`;

const MARKER = /^vimma-package=appimage\s*$/m;
const SHA512_HEX = /^[0-9a-f]{128}$/;

/**
 * Where the download is written before it is checked: a hidden file in the AppImage's own
 * directory, so the rename that replaces the file never crosses a file system.
 * @param {string} target  `$APPIMAGE`
 * @param {string} buildId
 */
export function appImagePartPath(target, buildId) {
  const dir = target.slice(0, target.lastIndexOf("/"));
  return `${dir}/.vimma-update-${buildId}.AppImage.part`;
}

/**
 * An absolute path with no empty, `.` or `..` segment and no control character, naming a file.
 * @param {string | null} path
 */
function plainFilePath(path) {
  if (!path || !path.startsWith("/") || path.endsWith("/")) return false;
  if ([...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  return path
    .slice(1)
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * A download URL the AppImage may come from: one of the project's release downloads (path
 * segments only, no query or fragment), or in automation any https URL (a local test host).
 * @param {string} url
 * @param {boolean} automation
 */
function allowedUrl(url, automation) {
  if (automation) return url.startsWith("https://");
  if (!url.startsWith(APPIMAGE_DOWNLOAD_PREFIX)) return false;
  const rest = url.slice(APPIMAGE_DOWNLOAD_PREFIX.length);
  return /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+$/.test(rest) && !/(^|\/)\.\.?(\/|$)/.test(rest);
}

/**
 * Whether this install may replace `$APPIMAGE` with the offered build, and where.
 * @param {{ installType: InstallType, marker: string | null, appImage: string | null,
 *   appDir: string | null, greDir: string, offer: Offer | null, automation: boolean,
 *   forced: boolean }} input
 *   `marker`: the `is-packaged-app` file's text in the GRE directory; `appImage`, `appDir`: the
 *   environment's `$APPIMAGE` and `$APPDIR`; `forced`: a test set the install type
 * @returns {{ ok: true, target: string, part: string, url: string, size: number,
 *   sha512: string } | { ok: false, why: string }}
 */
export function appImagePlan({
  installType,
  marker,
  appImage,
  appDir,
  greDir,
  offer,
  automation,
  forced,
}) {
  if (installType !== "appimage") return { ok: false, why: "not an AppImage install" };
  if (!offer) return { ok: false, why: "no update is offered" };
  // `$APPIMAGE` is inherited by every program an AppImage starts: only the AppDir's own marker
  // and a GRE directory inside `$APPDIR` show that this Vimma is the AppImage it names.
  if (!forced) {
    if (marker === null || !MARKER.test(marker)) {
      return {
        ok: false,
        why: "this Vimma is not an AppImage build (no vimma-package=appimage marker)",
      };
    }
    if (!appDir || !greDir.startsWith(`${appDir.replace(/\/+$/, "")}/`)) {
      return { ok: false, why: "this Vimma does not run from the AppImage's mount ($APPDIR)" };
    }
  }
  if (!plainFilePath(appImage)) return { ok: false, why: "$APPIMAGE is not an absolute file path" };
  const target = /** @type {string} */ (appImage);
  const asset = offer.assets?.appimage;
  if (!asset || typeof asset.url !== "string") {
    return { ok: false, why: "the update manifest names no AppImage" };
  }
  if (!allowedUrl(asset.url, automation)) {
    return {
      ok: false,
      why: "the AppImage's URL is not a release download of vimma-browser/vimma",
    };
  }
  return {
    ok: true,
    target,
    part: appImagePartPath(target, offer.buildId),
    url: asset.url,
    size: asset.size,
    sha512: asset.sha512,
  };
}

/**
 * Why a downloaded file is not the one the signed manifest describes, or null when it is.
 * @param {{ size: number, sha512: string }} expected  from the signed manifest
 * @param {{ size: number, sha512: string }} got  the file on disk, its SHA-512 as hex
 */
export function downloadProblem(expected, got) {
  if (got.size !== expected.size) {
    return `the AppImage has ${got.size} bytes, the signed manifest says ${expected.size}`;
  }
  if (!SHA512_HEX.test(got.sha512) || got.sha512 !== expected.sha512) {
    return "the AppImage's SHA-512 does not match the signed manifest";
  }
  return null;
}

/**
 * What `:update` and about:vimma show once the file is replaced.
 * @param {Offer} offer
 * @returns {{ text: string, commands: string[], link: string }}
 */
export function stagedSteps(offer) {
  return {
    text:
      `Vimma replaced its AppImage with ${offer.displayVersion}. ` +
      "Restart Vimma to run it; the file keeps its name.",
    commands: [],
    link: offer.detailsUrl,
  };
}

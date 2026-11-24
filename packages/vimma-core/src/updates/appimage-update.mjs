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

import { RELEASES_URL, appImageOwnership as ownership } from "./updates.mjs";

/** @import { AppImageWhere, InstallType, Offer } from "./updates.mjs" */

/**
 * The only place an AppImage is downloaded from outside automation: a leaked manifest key alone
 * then cannot point installs at a file of its own, it also needs a release asset in the project.
 */
export const APPIMAGE_DOWNLOAD_PREFIX = `${RELEASES_URL}/download/`;

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
 * `$APPIMAGE` when this Vimma is the AppImage it names, else null: the file `:restart` starts
 * again (spec §5), so a replaced AppImage restarts into its new version.
 * @param {AppImageWhere} input
 */
export function ownAppImage(input) {
  const own = ownership(input);
  return own.ok ? own.path : null;
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
  const own = ownership({ installType, marker, appImage, appDir, greDir, forced });
  if (!own.ok) return own;
  const target = own.path;
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
 * What `:update` and about:vimma show once the update is in place: the AppImage's replaced file,
 * or a tarball's update that Firefox's updater downloaded and staged (m6a-updater §5).
 * @param {Offer} offer
 * @param {InstallType} [installType]
 * @returns {{ text: string, commands: string[], link: string }}
 */
// Stryker disable next-line StringLiteral: every install type other than "tarball" gets the AppImage text
export function stagedSteps(offer, installType = "appimage") {
  const v = offer.displayVersion;
  return {
    text:
      installType === "tarball"
        ? `Vimma ${v} is downloaded and applies at the next start: restart Vimma (:restart) to use it.`
        : `Vimma replaced its AppImage with ${v}. Restart Vimma to run it; the file keeps its name.`,
    commands: [],
    link: offer.detailsUrl,
  };
}

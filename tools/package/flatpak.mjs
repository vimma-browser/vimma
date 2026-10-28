#!/usr/bin/env node
/**
 * The Flatpak of Vimma (spec flatpak): a flatpak-builder manifest that repackages the release
 * tarball, as Flathub builds it, and the files it names (launcher, desktop file, AppStream
 * metainfo, the 512 px icon). flatpak.yml builds it with tools/package/flatpak-smoke.sh; the Flathub
 * submission (docs/runbook.md, "Flatpak") commits the same files to Flathub's repository.
 *
 * Usage:
 *   node tools/package/flatpak.mjs --out <dir> --version X.Y.Z --date YYYY-MM-DD
 *     (--sha256 <hex> | --tarball <file>)
 * With --sha256 the manifest downloads the release tarball of vX.Y.Z from GitHub; with
 * --tarball it is copied next to the manifest and named by file.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "../repo.mjs";
import { desktopEntry, sha256File } from "./package.mjs";

const SURFER = JSON.parse(readFileSync(new URL("../../surfer.json", import.meta.url), "utf8"));

/** The Flatpak app id: surfer.json's appId, the macOS bundle identifier too. */
export const APP_ID = /** @type {string} */ (SURFER.appId);
if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$/.test(APP_ID)) {
  throw new Error(`surfer.json appId is not a Flatpak app id: ${String(APP_ID)}`);
}

/**
 * The Freedesktop runtime branch. Mozilla's Firefox Flatpak builds on the same one
 * (python/mozbuild/mozbuild/repackaging/flatpak.py FREEDESKTOP_VERSION, Firefox 158.0).
 */
export const RUNTIME_VERSION = "25.08";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The sandbox's permissions: those of Mozilla's Firefox Flatpak (flatpak.py, `build-finish`,
 * Firefox 158.0) without `--allow=devel` and `--persist=.mozilla`, with the D-Bus names Vimma
 * owns (org.mozilla.<name>, widget/gtk/DBusService.cpp and toolkit/components/remote/
 * nsDBusRemoteServer.cpp; MPRIS, widget/gtk/MPRISServiceHandler.h), and Omarchy's state
 * directory read-only so the theme follows Omarchy's (spec flatpak, decision 5).
 */
export const FINISH_ARGS = Object.freeze([
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

/** The files the manifest names beside the tarball, each in the manifest's directory. */
const FILES = {
  launcher: "vimma.sh",
  desktop: `${APP_ID}.desktop`,
  metainfo: `${APP_ID}.metainfo.xml`,
  icon: `${APP_ID}.png`,
};

/** Sizes of the PNG icons in the tarball's browser/chrome/icons/default/ (spec m0-branding). */
const TARBALL_ICON_SIZES = [16, 32, 48, 64, 128];

/** @param {string} version */
const tarballName = (version) => `vimma-${version}-linux-x86_64.tar.xz`;

/**
 * @typedef {{ url: true, sha256: string } | { path: string, sha256: string }} TarballSource
 *   `url`: the GitHub release download of the version; `path`: a file next to the manifest
 */

/**
 * The flatpak-builder manifest. Build commands are fixed strings, so no input reaches a shell.
 * @param {{ version: string, source: TarballSource }} input
 */
export function flatpakManifest({ version, source }) {
  if (!SEMVER.test(version)) throw new Error(`version is not SemVer: ${JSON.stringify(version)}`);
  if (!SHA256.test(source.sha256)) {
    throw new Error(`sha256 must be 64 lower-case hex digits: ${JSON.stringify(source.sha256)}`);
  }
  /** @type {{ type: string, url?: string, path?: string, sha256: string, dest: string }} */
  let archive;
  if ("path" in source) {
    if (!FILE_NAME.test(source.path)) {
      throw new Error(`tarball path must be a file name: ${JSON.stringify(source.path)}`);
    }
    archive = { type: "archive", path: source.path, sha256: source.sha256, dest: "vimma" };
  } else {
    archive = {
      type: "archive",
      url: `https://github.com/${REPO}/releases/download/v${version}/${tarballName(version)}`,
      sha256: source.sha256,
      dest: "vimma",
    };
  }
  const icons = TARBALL_ICON_SIZES.map(
    (size) =>
      `install -Dm644 vimma/browser/chrome/icons/default/default${size}.png ` +
      `/app/share/icons/hicolor/${size}x${size}/apps/${APP_ID}.png`,
  );
  return {
    id: APP_ID,
    runtime: "org.freedesktop.Platform",
    "runtime-version": RUNTIME_VERSION,
    sdk: "org.freedesktop.Sdk",
    command: "vimma",
    "finish-args": [...FINISH_ARGS],
    modules: [
      {
        name: "vimma",
        buildsystem: "simple",
        "build-commands": [
          "mkdir -p /app/lib",
          "cp -a vimma /app/lib/vimma",
          // The install type the update check reads (spec m6a-updater, section 3); Firefox's
          // own updater already stands aside inside Flatpak (isPackagedApp).
          "printf 'vimma-package=flatpak\\n' > /app/lib/vimma/is-packaged-app",
          `install -Dm755 ${FILES.launcher} /app/bin/vimma`,
          `install -Dm644 ${FILES.desktop} /app/share/applications/${FILES.desktop}`,
          `install -Dm644 ${FILES.metainfo} /app/share/metainfo/${FILES.metainfo}`,
          `install -Dm644 ${FILES.icon} /app/share/icons/hicolor/512x512/apps/${FILES.icon}`,
          ...icons,
        ],
        sources: [
          archive,
          { type: "file", path: FILES.launcher },
          { type: "file", path: FILES.desktop },
          { type: "file", path: FILES.metainfo },
          { type: "file", path: FILES.icon },
        ],
      },
    ],
  };
}

/**
 * The desktop file: the other packages' entry with the app id as its icon and window class, and
 * `vimma` in place of vimma-open, whose walk up /proc to the app that opened a link cannot see
 * past the sandbox's PID namespace (spec flatpak, decision 6).
 */
export function flatpakDesktopEntry() {
  return desktopEntry({ wmClass: APP_ID })
    .replace(/^Exec=vimma-open %u$/m, "Exec=vimma %u")
    .replace(/^Icon=vimma$/m, `Icon=${APP_ID}`);
}

/**
 * /app/bin/vimma. `--name` sets GTK's program name, so the Wayland app_id and the X11 class are
 * the app id that names the desktop file, as Mozilla's launcher does
 * (browser/installer/linux/app/flatpak/files/bin/firefox.in, Firefox 158.0).
 */
export function flatpakLauncher() {
  return [
    "#!/bin/sh",
    "# Vimma's Flatpak entry point (spec flatpak).",
    "# Temporary files in the app's own cache, which the sandbox keeps, not a shared /tmp.",
    'export TMPDIR="$XDG_CACHE_HOME/tmp"',
    'mkdir -p "$TMPDIR"',
    `exec /app/lib/vimma/vimma --name ${APP_ID} "$@"`,
    "",
  ].join("\n");
}

/**
 * The AppStream metainfo Flathub requires.
 * @param {{ version: string, date: string }} input  date: the release's, YYYY-MM-DD
 */
export function metainfo({ version, date }) {
  if (!SEMVER.test(version)) throw new Error(`version is not SemVer: ${JSON.stringify(version)}`);
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`date must be YYYY-MM-DD: ${JSON.stringify(date)}`);
  }
  const site = `https://github.com/${REPO}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Vimma's AppStream metainfo (spec flatpak); written by tools/package/flatpak.mjs. -->
<component type="desktop-application">
  <id>${APP_ID}</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MPL-2.0</project_license>
  <name>Vimma</name>
  <summary>Keyboard-first web browser built on Firefox</summary>
  <developer id="dev.vimma">
    <name>Vimma</name>
  </developer>
  <description>
    <p>
      Vimma is a web browser built on Firefox for people who prefer the keyboard. Pages open in
      Normal mode, where keys move, follow links and switch tabs as in Neovim, and a tmux-style
      prefix key reaches windows, splits and workspaces.
    </p>
    <ul>
      <li>Modes from Neovim: Normal, Insert, Visual and a command line</li>
      <li>Link hints for following links and focusing fields from the keyboard</li>
      <li>Workspaces, each with its own cookies and logins</li>
      <li>A status bar that shows the mode, the workspace and the page</li>
      <li>Colours that follow the Omarchy theme</li>
    </ul>
  </description>
  <launchable type="desktop-id">${APP_ID}.desktop</launchable>
  <url type="homepage">https://vimma.dev/</url>
  <url type="bugtracker">${site}/issues</url>
  <url type="vcs-browser">${site}</url>
  <categories>
    <category>Network</category>
    <category>WebBrowser</category>
  </categories>
  <keywords>
    <keyword>browser</keyword>
    <keyword>vim</keyword>
    <keyword>keyboard</keyword>
  </keywords>
  <provides>
    <binary>vimma</binary>
  </provides>
  <supports>
    <control>keyboard</control>
    <control>pointing</control>
  </supports>
  <content_rating type="oars-1.1" />
  <releases>
    <release version="${version}" date="${date}">
      <url type="details">${site}/releases/tag/v${version}</url>
    </release>
  </releases>
</component>
`;
}

/**
 * @param {string} path
 * @param {string} text
 * @param {number} [mode]
 */
function write(path, text, mode = 0o644) {
  writeFileSync(path, text, { mode });
}

/**
 * The manifest `<APP_ID>.json` and every file it names, in `out`.
 * @param {{ out: string, version: string, date: string, brandDir: string,
 *   tarball?: string, sha256?: string }} options  `tarball`: a local file, copied in;
 *   else `sha256` of the release download
 * @returns {string[]} the files written
 */
export function writeFlatpak(options) {
  const { out, version } = options;
  mkdirSync(out, { recursive: true });
  /** @type {string[]} */
  const files = [];
  /** @type {TarballSource} */
  let source;
  if (options.tarball) {
    const name = tarballName(version);
    copyFileSync(options.tarball, join(out, name));
    files.push(join(out, name));
    source = { path: name, sha256: sha256File(options.tarball) };
  } else {
    source = { url: true, sha256: options.sha256 ?? "" };
  }
  const manifest = flatpakManifest({ version, source });
  const meta = metainfo({ version, date: options.date });
  const add = (/** @type {string} */ name, /** @type {string} */ text, mode = 0o644) => {
    write(join(out, name), text, mode);
    files.push(join(out, name));
  };
  add(`${APP_ID}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  add(FILES.launcher, flatpakLauncher(), 0o755);
  add(FILES.desktop, flatpakDesktopEntry());
  add(FILES.metainfo, meta);
  // logo.svg only wraps a PNG, behind a licence comment that hides its type from AppStream's
  // icon reader, so the 512 px rendering goes in as it is.
  copyFileSync(join(options.brandDir, "logo512.png"), join(out, FILES.icon));
  files.push(join(out, FILES.icon));
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      version: { type: "string" },
      date: { type: "string" },
      sha256: { type: "string" },
      tarball: { type: "string" },
    },
  });
  if (!values.out || !values.version || !values.date || !values.sha256 === !values.tarball) {
    console.error(
      "usage: flatpak.mjs --out <dir> --version X.Y.Z --date YYYY-MM-DD (--sha256 <hex> | --tarball <file>)",
    );
    process.exit(2);
  }
  const files = writeFlatpak({
    out: values.out,
    version: values.version,
    date: values.date,
    sha256: values.sha256,
    tarball: values.tarball,
    brandDir: fileURLToPath(new URL("../../configs/branding/vimma/", import.meta.url)),
  });
  for (const file of files) console.log(file);
}

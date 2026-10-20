#!/usr/bin/env node
/**
 * Release packages from a `./mach package` tarball (spec m6-packaging): the release tarball, the
 * AppImage, the .deb, the vimma-bin PKGBUILD + SRCINFO (a release asset, and an AUR variant in
 * aur/), and SHA256SUMS.
 *
 * Usage:
 *   node tools/package/package.mjs --tarball <vimma-*.linux-x86_64.tar.xz> --out <dir>
 *     --maintainer "Name <email>" [--tag vX.Y.Z] [--repo vimma-browser/vimma] [--sbom <file>]
 *     [--appimagetool <path> --runtime <path>] [--no-deb]
 * Without --appimagetool no AppImage is built (its AppDir still is, in the work dir).
 * The version is surfer.json brands.vimma.release.displayVersion; --tag must be exactly v<that>.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "../repo.mjs";
import { PKGBUILD_INSTALL_COMMAND } from "../../packages/vimma-core/src/updates.mjs";

/** SemVer with an optional pre-release, as version-files.mjs accepts (plan §7). */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const APP = "vimma";
const DESCRIPTION =
  "Keyboard-first web browser built on Firefox, with Neovim-style modes and a tmux-style prefix keymap";

/**
 * vimma-open, the desktop entry's launcher: it names the app that opened a link for `[[routes]]`
 * rules (spec workspace-routing). Installed as `vimma-open` next to the `vimma` binary.
 */
export const LAUNCHER = fileURLToPath(new URL("vimma-open.sh", import.meta.url));
const LAUNCHER_NAME = `${APP}-open`;

/** GNU LGPL 2.1 text (gnu.org/licenses/old-licenses/lgpl-2.1.txt), for the AppImage runtime. */
const LGPL_TEXT = fileURLToPath(new URL("notices/LGPL-2.1.txt", import.meta.url));

/** hicolor sizes we ship, all rendered into configs/branding/vimma/ (spec m0-branding). */
export const ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512];

/**
 * Mozilla's desktop-file MIME list (python/mozbuild/mozbuild/repackaging/desktop_file.py) without
 * x-scheme-handler/chrome and x-scheme-handler/mailto: a browser grabbing mail links surprises.
 */
const MIME_TYPES = [
  "application/json",
  "application/pdf",
  "application/rdf+xml",
  "application/rss+xml",
  "application/x-xpinstall",
  "application/xhtml+xml",
  "application/xml",
  "audio/flac",
  "audio/ogg",
  "audio/webm",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "text/html",
  "text/xml",
  "video/ogg",
  "video/webm",
  "x-scheme-handler/http",
  "x-scheme-handler/https",
];

const DESKTOP_ACTIONS = [
  ["new-window", "New Window", `${APP} --new-window %u`],
  ["new-private-window", "New Private Window", `${APP} --private-window %u`],
  ["open-profile-manager", "Open the Profile Manager", `${APP} --ProfileManager`],
];

/**
 * Libraries Firefox's binaries link against (t64 names first: Ubuntu 24.04, Debian 13). The
 * package job's smoke install checks the list resolves.
 */
const DEB_DEPENDS = [
  "libc6 (>= 2.31)",
  "libasound2t64 | libasound2",
  "libatk1.0-0t64 | libatk1.0-0",
  "libcairo-gobject2",
  "libcairo2",
  "libdbus-1-3",
  "libfontconfig1",
  "libfreetype6",
  "libgdk-pixbuf-2.0-0",
  "libglib2.0-0t64 | libglib2.0-0",
  "libgtk-3-0t64 | libgtk-3-0",
  "libpango-1.0-0",
  "libpangocairo-1.0-0",
  "libx11-6",
  "libx11-xcb1",
  "libxcb-shm0",
  "libxcb1",
  "libxcomposite1",
  "libxcursor1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxi6",
  "libxrandr2",
  "libxrender1",
  "libxtst6",
];

/** @typedef {{ version?: { version?: unknown }, brands?: Record<string, { release?: { displayVersion?: unknown } }> }} SurferConfig */

/**
 * The release version: surfer.json brands.vimma.release.displayVersion (release-please bumps it).
 * @param {SurferConfig} config
 * @param {string} [tag] the release tag; must be exactly `v<version>`
 * @returns {string}
 */
export function releaseVersion(config, tag) {
  const version = config.brands?.vimma?.release?.displayVersion;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(
      `surfer.json brands.vimma.release.displayVersion is not SemVer: ${String(version)}`,
    );
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(
      `tag ${tag} does not match surfer.json's version ${version} (want v${version})`,
    );
  }
  return version;
}

/** @param {string} version SemVer; a pre-release sorts before its release with `~` in dpkg */
export const debVersion = (version) => version.replace("-", "~");

/**
 * The AUR gets releases only: release.yml accepts vX.Y.Z tags only, and a pre-release would need
 * a pkgver without its hyphen but a download URL with it.
 * @param {string} version
 */
function aurVersion(version) {
  if (version.includes("-")) throw new Error(`AUR: ${version} is a pre-release; releases only`);
  return version;
}

/**
 * cosign keyless identity of a genuine release signature: release.yml of this repo, run from
 * main. release.yml starts only by workflow_dispatch on main (release-please.yml's release-build
 * job, or a manual re-run), and v0.1.1, the first signed release, was signed the same way, so no
 * other ref is accepted. docs/runbook.md, docs/guide.md and aur.yml use it.
 */
export const IDENTITY_REGEXP =
  "^https://github\\.com/vimma-browser/vimma/\\.github/workflows/release\\.yml@refs/heads/main$";

/** The AppImage runtime release fetch-appimagetool.sh pins (its single source). */
export const RUNTIME_RELEASE = (() => {
  const script = readFileSync(new URL("fetch-appimagetool.sh", import.meta.url), "utf8");
  const release = /^RUNTIME_RELEASE=(\S+)$/m.exec(script)?.[1];
  if (!release) throw new Error("fetch-appimagetool.sh: no RUNTIME_RELEASE=");
  return release;
})();
const RUNTIME_SOURCE = `https://github.com/AppImage/type2-runtime/tree/${RUNTIME_RELEASE}`;

/** usr/share/doc/vimma/APPIMAGE-RUNTIME-NOTICE.txt in the AppImage (LGPL-2.1 section 6). */
export function runtimeNotice() {
  return `The first part of this AppImage file is the AppImage type-2 runtime, unmodified, from
type2-runtime ${RUNTIME_RELEASE} (MIT): ${RUNTIME_SOURCE}

The runtime is statically linked with:
  - libfuse 3.15.0 (GNU LGPL-2.1-or-later; full text in LGPL-2.1.txt next to this file),
    with the patch in that repository's patches/libfuse/
  - squashfuse 0.5.2 (BSD-2-Clause), musl libc (MIT), zstd (BSD-3-Clause)

Source: the complete corresponding source of the runtime and the scripts that build it are at
the URL above (scripts/common/install-dependencies.sh names and checksums the libfuse and
squashfuse sources it builds). Vimma passes no changes to them.

You may modify libfuse and relink the runtime, or replace the runtime altogether: run
  ./vimma-<version>-x86_64.AppImage --appimage-extract
to unpack the application into squashfs-root/, then build a new AppImage from that directory
with appimagetool --runtime-file <your runtime> squashfs-root <new>.AppImage, or run
squashfs-root/AppRun directly. Vimma itself is MPL-2.0; see about:license for its other
components.
`;
}

/** Appended to the GitHub Release notes by release.yml's publish job. */
export function thirdPartyNotes() {
  return `### Third-party notice

The AppImage starts with the unmodified AppImage type-2 runtime ${RUNTIME_RELEASE} (MIT), which
statically links libfuse 3.15.0 under the LGPL-2.1-or-later. Its source:
${RUNTIME_SOURCE}. The licence text and how to relink or replace the runtime are in
\`usr/share/doc/vimma/\` inside the AppImage (\`--appimage-extract\`). Vimma is MPL-2.0; the
CycloneDX SBOM lists the other components.
`;
}

/**
 * The update steps release.yml puts at the top of the release notes. Vimma 0.1.6 on a Mac shows
 * the Linux tarball command in its update notice; the notes are the one page it links to.
 * @param {string} version
 * @param {string} repo
 */
export function updatingNotes(version, repo) {
  return `### Updating

- **macOS:** \`brew upgrade --cask vimma\`, or download \`${APP}-${version}-macos-aarch64.dmg\`
  below and drag Vimma over the copy in Applications.
- **Linux:** \`:update\` shows the command for how you installed Vimma; the user guide's
  [Updates](https://github.com/${repo}/blob/main/docs/guide.md#updates) section lists them all.
`;
}

/** @param {string} version */
export function artifactNames(version) {
  return {
    tarball: `${APP}-${version}-linux-x86_64.tar.xz`,
    appimage: `${APP}-${version}-x86_64.AppImage`,
    deb: `${APP}_${debVersion(version)}_amd64.deb`,
    sbom: `${APP}-${version}.cdx.json`,
    // Not `.SRCINFO`: GitHub renames an asset whose name starts with a period
    // (docs.github.com, REST "Upload a release asset"), so SHA256SUMS would name a missing file.
    pkgbuild: "PKGBUILD",
    srcinfo: "SRCINFO",
    checksums: "SHA256SUMS",
  };
}

/**
 * INI as Firefox writes application.ini: `[Section]`, `Key=Value`, `#` and `;` comments.
 * @param {string} text
 * @returns {Record<string, Record<string, string>>}
 */
export function parseIni(text) {
  /** @type {Record<string, Record<string, string>>} */
  const ini = {};
  /** @type {Record<string, string> | undefined} */
  let section;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      section = ini[header[1]] ??= {};
    } else if (section && line.includes("=")) {
      const at = line.indexOf("=");
      section[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return ini;
}

/**
 * @param {string} appDir the packaged app dir (the tarball's vimma/)
 * @returns {{ name: string, remotingName: string }}
 */
export function readAppIni(appDir) {
  const app = parseIni(readFileSync(join(appDir, "application.ini"), "utf8")).App ?? {};
  if (!app.Name || !app.RemotingName) {
    throw new Error(`${appDir}/application.ini has no [App] Name or RemotingName`);
  }
  return { name: app.Name, remotingName: app.RemotingName };
}

/**
 * The vimma.desktop file shared by the AppImage, the .deb and the AUR package.
 * @param {{ wmClass: string }} options wmClass: application.ini RemotingName (also Wayland app_id)
 * @returns {string}
 */
export function desktopEntry({ wmClass }) {
  const lines = [
    "[Desktop Entry]",
    "Version=1.5",
    "Type=Application",
    "Name=Vimma",
    "GenericName=Web Browser",
    "Comment=Browse the web from the keyboard",
    // vimma-open walks /proc to the app that opened the link (spec workspace-routing).
    `Exec=${LAUNCHER_NAME} %u`,
    `Icon=${APP}`,
    "Terminal=false",
    "StartupNotify=true",
    `StartupWMClass=${wmClass}`,
    "Categories=Network;WebBrowser;",
    `MimeType=${MIME_TYPES.join(";")};`,
    "Keywords=Internet;WWW;Browser;Web;Explorer;vim;",
    `Actions=${DESKTOP_ACTIONS.map(([id]) => id).join(";")};`,
  ];
  for (const [id, name, exec] of DESKTOP_ACTIONS) {
    lines.push("", `[Desktop Action ${id}]`, `Name=${name}`, `Exec=${exec}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Structural checks for when desktop-file-validate is not installed.
 * @param {string} text
 * @returns {string[]} problems, empty when fine
 */
export function checkDesktopEntry(text) {
  const errors = [];
  /** @type {Map<string, Map<string, string>>} */
  const groups = new Map();
  /** @type {Map<string, string> | undefined} */
  let group;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      if (groups.has(header[1])) errors.push(`duplicate group [${header[1]}]`);
      group = new Map();
      groups.set(header[1], group);
    } else if (!group) {
      errors.push(`line before the first group: ${line}`);
    } else if (!/^[A-Za-z0-9-]+(\[[^\]]+\])?=/.test(line)) {
      errors.push(`not a key=value line: ${line}`);
    } else {
      const at = line.indexOf("=");
      group.set(line.slice(0, at), line.slice(at + 1));
    }
  }
  if ([...groups.keys()][0] !== "Desktop Entry") errors.push("first group is not [Desktop Entry]");
  const entry = groups.get("Desktop Entry") ?? new Map();
  for (const key of ["Type", "Name", "Exec", "Icon"]) {
    if (!entry.get(key)) errors.push(`[Desktop Entry] has no ${key}`);
  }
  for (const key of ["Categories", "MimeType", "Keywords", "Actions"]) {
    const value = entry.get(key);
    if (value !== undefined && !value.endsWith(";")) errors.push(`${key} does not end with ;`);
  }
  for (const action of (entry.get("Actions") ?? "").split(";").filter(Boolean)) {
    const actionGroup = groups.get(`Desktop Action ${action}`);
    if (!actionGroup) errors.push(`action ${action} has no [Desktop Action ${action}] group`);
    else if (!actionGroup.get("Name")) errors.push(`action ${action} has no Name`);
  }
  return errors;
}

/** The AppImage entry point. */
export function appRun() {
  return [
    "#!/bin/sh",
    "# Vimma AppImage entry point (spec m6-packaging).",
    'HERE="$(dirname "$(readlink -f "$0")")"',
    "# The image is mounted at a new path on every start; Firefox keys dedicated profiles by",
    "# install path, so without this every launch would open a fresh profile.",
    "export MOZ_LEGACY_PROFILES=1",
    '# "Make default browser" and remoting record the .AppImage, not the temporary mount.',
    "# Set only when the AppImage runtime started us ($APPIMAGE), never to an empty value.",
    'if [ -n "${APPIMAGE:-}" ]; then export MOZ_APP_LAUNCHER="$APPIMAGE"; fi',
    "# One link (the desktop entry's %u) through vimma-open, which names the app that opened it",
    "# (spec workspace-routing); anything else, such as a desktop action's flag, straight to vimma.",
    'if [ "$#" -eq 1 ]; then',
    '  case "$1" in',
    `    -*) ;;`,
    `    *) exec "$HERE/usr/lib/${APP}/${LAUNCHER_NAME}" "$1" ;;`,
    "  esac",
    "fi",
    `exec "$HERE/usr/lib/${APP}/${APP}" "$@"`,
    "",
  ].join("\n");
}

/** @param {string} maintainer */
function checkMaintainer(maintainer) {
  if (!/^[^<>\n]+ <[^<>\s]+@[^<>\s]+>$/.test(maintainer)) {
    throw new Error(`maintainer must be "Name <email>", got: ${JSON.stringify(maintainer)}`);
  }
}

/**
 * @param {{ version: string, maintainer: string, installedKiB: number }} options
 * @returns {string} DEBIAN/control
 */
export function debControl({ version, maintainer, installedKiB }) {
  checkMaintainer(maintainer);
  return [
    `Package: ${APP}`,
    `Version: ${debVersion(version)}`,
    "Architecture: amd64",
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${installedKiB}`,
    `Depends: ${DEB_DEPENDS.join(", ")}`,
    "Recommends: libpulse0",
    "Provides: gnome-www-browser, www-browser",
    "Section: web",
    "Priority: optional",
    "Homepage: https://github.com/vimma-browser/vimma",
    `Description: ${DESCRIPTION}`,
    " Vimma is a Firefox fork driven from the keyboard: a modal page layer, a",
    " prefix keymap, workspaces as containers and an always-visible status bar.",
    "",
  ].join("\n");
}

const POSTINST = `#!/bin/sh
set -e
# Priority 40, below Firefox's 100: Vimma never becomes the default browser by itself.
if [ "$1" = "configure" ] || [ "$1" = "abort-upgrade" ] || [ "$1" = "abort-remove" ]; then
  update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/bin/${APP} 40
  update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/bin/${APP} 40
fi
`;

const PRERM = `#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "deconfigure" ]; then
  update-alternatives --remove x-www-browser /usr/bin/${APP}
  update-alternatives --remove gnome-www-browser /usr/bin/${APP}
fi
`;

const COPYRIGHT = `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Vimma
Source: https://github.com/vimma-browser/vimma

Files: *
Copyright: Vimma contributors; Mozilla Foundation and contributors (Firefox)
License: MPL-2.0
 Third-party components and their licences are listed in about:license and in
 the release's CycloneDX SBOM (vimma-<version>.cdx.json).

License: MPL-2.0
 This Source Code Form is subject to the terms of the Mozilla Public License,
 v. 2.0. If a copy of the MPL was not distributed with this file, You can
 obtain one at https://mozilla.org/MPL/2.0/.
`;

/**
 * How the package was installed, written to /opt/vimma/is-packaged-app as `vimma-package=<it>`
 * so the updater can show the matching hint (spec m6a-updater, section 3): `pkgbuild-release`
 * for the PKGBUILD downloaded from the release, `aur` for the copy pushed to the AUR. The .deb
 * and the AppImage carry `deb` and `appimage` (packageMarker); the tarball carries none.
 * @typedef {"pkgbuild-release" | "aur"} InstallSource
 */
const INSTALL_SOURCES = ["pkgbuild-release", "aur"];

/**
 * The file Firefox tests for to treat an install as owned by a package manager
 * (widget/gtk/WidgetUtilsGtk.cpp IsPackagedAppFileExists; Mozilla's own .deb writes it,
 * python/mozbuild/mozbuild/repackaging/deb.py). Its content is Vimma's.
 */
export const PACKAGED_APP_FILE = "is-packaged-app";

/**
 * The marker's content for a package type, the line the PKGBUILD's package() also writes.
 * @param {"deb" | "appimage" | InstallSource} type
 */
export function packageMarker(type) {
  return `vimma-package=${type}\n`;
}

/**
 * The one command that installs or updates Vimma on Arch Linux from the latest release. Its
 * source is vimma-core, so the update check's pkgbuild-release hint is the same text.
 */
export { PKGBUILD_INSTALL_COMMAND };

/**
 * @typedef {{ version: string, maintainer: string, repo: string, tarballSha256: string,
 *   desktop: string, desktopId: string, launcher: string, installSource: InstallSource }} AurInput
 */

const AUR_DEPENDS = [
  "alsa-lib",
  "dbus",
  "gtk3",
  "hicolor-icon-theme",
  "libxt",
  "mime-types",
  "ttf-font",
];
const AUR_OPTDEPENDS = [
  "ffmpeg: H.264, AAC and MP3 playback",
  "libpulse: PulseAudio audio (also via pipewire-pulse)",
  "networkmanager: location detection via available Wi-Fi networks",
];

/**
 * `repo` and `desktopId` go into double-quoted shell words that makepkg runs (as root when
 * pacman installs), so only the characters a GitHub `owner/name` and a desktop file ID use pass.
 * @param {AurInput} input
 */
function checkShellWords(input) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.repo)) {
    throw new Error(`repo must be owner/name, got: ${JSON.stringify(input.repo)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(input.desktopId)) {
    throw new Error(`desktop id must be [A-Za-z0-9._-]+, got: ${JSON.stringify(input.desktopId)}`);
  }
}

/** @param {AurInput} input */
function aurSource(input) {
  checkShellWords(input);
  const v = aurVersion(input.version);
  const url = `https://github.com/${input.repo}/releases/download/v${v}/${APP}-${v}-linux-x86_64.tar.xz`;
  return { file: `${APP}-${v}-linux-x86_64.tar.xz`, url };
}

/**
 * `content` as a quoted here-document writing `target`: nothing in it is expanded, and it must
 * end with a newline and contain no line equal to the delimiter, which would end it early.
 * @param {string} target
 * @param {string} delimiter
 * @param {string} content
 */
function heredoc(target, delimiter, content) {
  if (!content.endsWith("\n")) throw new Error(`${delimiter}: content must end with a newline`);
  if (content.split("\n").includes(delimiter)) {
    throw new Error(`content has a line ${delimiter}, which would end its here-document`);
  }
  return `  cat > "${target}" <<'${delimiter}'\n${content}${delimiter}\n`;
}

/**
 * The vimma-bin PKGBUILD, installing the release tarball to /opt/vimma. Its only source is the
 * tarball; the desktop file and vimma-open are written inline, so the PKGBUILD alone installs
 * Vimma (spec m6-packaging, "Arch Linux without the AUR").
 * @param {AurInput} input
 * @returns {string}
 */
export function pkgbuild(input) {
  checkMaintainer(input.maintainer);
  checkShellWords(input);
  if (!INSTALL_SOURCES.includes(input.installSource)) {
    throw new Error(`unknown install source: ${String(input.installSource)}`);
  }
  /** @param {string[]} items */
  const list = (items) => items.map((s) => `'${s}'`).join(" ");
  const desktopPath = `$pkgdir/usr/share/applications/${input.desktopId}.desktop`;
  const launcherPath = `$pkgdir/opt/${APP}/${LAUNCHER_NAME}`;
  return `# Maintainer: ${input.maintainer}
# Generated by tools/package/package.mjs in ${input.repo} (spec m6-packaging); edit it there.
# Install or update from the latest release (it builds in ~/.cache/vimma-build):
#   ${PKGBUILD_INSTALL_COMMAND}
pkgname=${APP}-bin
pkgver=${aurVersion(input.version)}
pkgrel=1
pkgdesc="${DESCRIPTION}"
arch=('x86_64')
url="https://github.com/${input.repo}"
license=('MPL-2.0')
depends=(${list(AUR_DEPENDS)})
optdepends=(${AUR_OPTDEPENDS.map((s) => `'${s}'`).join("\n            ")})
provides=('${APP}')
conflicts=('${APP}')
options=('!strip' '!debug')
source=("${APP}-\${pkgver}-linux-x86_64.tar.xz::https://github.com/${input.repo}/releases/download/v\${pkgver}/${APP}-\${pkgver}-linux-x86_64.tar.xz")
sha256sums=('${input.tarballSha256}')

package() {
  install -d "$pkgdir/opt" "$pkgdir/usr/bin" "$pkgdir/usr/share/applications"
  cp -a "$srcdir/${APP}" "$pkgdir/opt/${APP}"
  ln -s /opt/${APP}/${APP} "$pkgdir/usr/bin/${APP}"
  # Tells Vimma how it was installed (spec m6a-updater, section 3).
  printf '%s\\n' 'vimma-package=${input.installSource}' > "$pkgdir/opt/${APP}/${PACKAGED_APP_FILE}"
${heredoc(launcherPath, "VIMMA_OPEN_EOF", input.launcher)}  chmod 755 "${launcherPath}"
  ln -s /opt/${APP}/${LAUNCHER_NAME} "$pkgdir/usr/bin/${LAUNCHER_NAME}"
${heredoc(desktopPath, "VIMMA_DESKTOP_EOF", input.desktop)}  chmod 644 "${desktopPath}"
  local size
  for size in 16 32 48 64 128; do
    install -Dm644 "$srcdir/${APP}/browser/chrome/icons/default/default\${size}.png" \\
      "$pkgdir/usr/share/icons/hicolor/\${size}x\${size}/apps/${APP}.png"
  done
}
`;
}

/**
 * .SRCINFO for the PKGBUILD above, in makepkg --printsrcinfo's order and format.
 * @param {AurInput} input
 * @returns {string}
 */
export function srcinfo(input) {
  const { file, url } = aurSource(input);
  const fields = [
    ["pkgdesc", DESCRIPTION],
    ["pkgver", aurVersion(input.version)],
    ["pkgrel", "1"],
    ["url", `https://github.com/${input.repo}`],
    ["arch", "x86_64"],
    ["license", "MPL-2.0"],
    ...AUR_DEPENDS.map((d) => ["depends", d]),
    ...AUR_OPTDEPENDS.map((d) => ["optdepends", d]),
    ["provides", APP],
    ["conflicts", APP],
    ["options", "!strip"],
    ["options", "!debug"],
    ["source", `${file}::${url}`],
    ["sha256sums", input.tarballSha256],
  ];
  const body = fields.map(([key, value]) => `\t${key} = ${value}`).join("\n");
  return `pkgbase = ${APP}-bin\n${body}\n\npkgname = ${APP}-bin\n`;
}

/** @param {string} path */
export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * @param {string[]} files
 * @returns {string} `sha256sum` output for the files, by base name, sorted
 */
export function sha256sums(files) {
  return files
    .map((file) => `${sha256File(file)}  ${basename(file)}\n`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
    .join("");
}

/**
 * @param {string} path
 * @param {string} content
 * @param {number} mode
 */
function writeFile(path, content, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

/**
 * @param {string} from
 * @param {string} to
 */
function installFile(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  copyFileSync(from, to);
  chmodSync(to, 0o644);
}

/** @param {string} to  where vimma-open goes, executable */
function installLauncher(to) {
  installFile(LAUNCHER, to);
  chmodSync(to, 0o755);
}

/**
 * `cp -a` keeps modes and symlinks of the packaged app exactly as mach made them.
 * @param {string} appDir
 * @param {string} to
 */
function copyApp(appDir, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  execFileSync("cp", ["-a", appDir, to]);
}

/**
 * hicolor icons and the desktop file under <root>/usr/share.
 * @param {string} root
 * @param {string} brandDir
 * @param {string} desktop
 * @param {string} desktopId
 */
function installShare(root, brandDir, desktop, desktopId) {
  writeFile(join(root, `usr/share/applications/${desktopId}.desktop`), desktop);
  for (const size of ICON_SIZES) {
    installFile(
      join(brandDir, `logo${size}.png`),
      join(root, `usr/share/icons/hicolor/${size}x${size}/apps/${APP}.png`),
    );
  }
  installFile(
    join(brandDir, "logo.svg"),
    join(root, `usr/share/icons/hicolor/scalable/apps/${APP}.svg`),
  );
}

/**
 * Installed-Size in KiB, as dpkg-gencontrol counts it: each file rounded up, symlinks as 1.
 * @param {string} dir
 * @returns {number}
 */
function installedKiB(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += installedKiB(path);
    else if (entry.isSymbolicLink()) total += 1;
    else total += Math.ceil(lstatSync(path).size / 1024);
  }
  return total;
}

/**
 * @typedef {{
 *   tarball: string, outDir: string, config: SurferConfig, maintainer: string, repo: string,
 *   brandDir: string, tag?: string, sbom?: string, appimagetool?: string, runtime?: string,
 *   buildDeb?: boolean, workDir?: string,
 * }} PackageOptions
 */

/**
 * @typedef {{ version: string, files: string[], appDir: string, debRoot: string, aurDir: string }}
 *   PackageResult
 */

/**
 * Every release file from one `./mach package` tarball; see the file comment. The AppDir and the
 * deb root are built in `workDir`, which stays; without one they are built in a temp dir that is
 * removed before this returns or throws, and `appDir`/`debRoot` no longer exist.
 * @param {PackageOptions} options
 * @returns {PackageResult}
 */
export function packageRelease(options) {
  if (options.workDir) return packageIn(options.workDir, options);
  const work = mkdtempSync(join(tmpdir(), "vimma-package-"));
  try {
    return packageIn(work, options);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * @param {string} work scratch dir for the extracted tarball, the AppDir and the deb root
 * @param {PackageOptions} options
 * @returns {PackageResult}
 */
function packageIn(work, options) {
  const version = releaseVersion(options.config, options.tag);
  checkMaintainer(options.maintainer);
  const names = artifactNames(version);
  const out = options.outDir;
  mkdirSync(out, { recursive: true });

  const extract = join(work, "extract");
  rmSync(extract, { recursive: true, force: true });
  mkdirSync(extract, { recursive: true });
  execFileSync("tar", ["-xJf", options.tarball, "-C", extract]);
  const app = join(extract, APP);
  if (!existsSync(join(app, APP))) {
    throw new Error(`${options.tarball} has no ${APP}/${APP}: not a ./mach package tarball?`);
  }
  const ini = readAppIni(app);
  if (ini.name !== "Vimma") {
    throw new Error(`${options.tarball}: application.ini has Name=${ini.name}, want Vimma`);
  }
  // Unmarked is what makes an install a tarball for the update check; a marker here would also
  // be copied into every package below, under the wrong type.
  if (existsSync(join(app, PACKAGED_APP_FILE))) {
    throw new Error(`${options.tarball} has ${APP}/${PACKAGED_APP_FILE}: the tarball carries none`);
  }
  const desktop = desktopEntry({ wmClass: ini.remotingName });
  // Desktop file ID = RemotingName (X11 WM_CLASS, Wayland app_id, MPRIS), so shells match the
  // window to it without guessing (spec m6-packaging, Settled).
  const desktopId = ini.remotingName;
  const problems = checkDesktopEntry(desktop);
  if (problems.length) throw new Error(`desktop file: ${problems.join("; ")}`);

  /** @type {string[]} */
  const files = [];
  const tarball = join(out, names.tarball);
  copyFileSync(options.tarball, tarball);
  chmodSync(tarball, 0o644);
  files.push(tarball);

  // AppImage
  const appDir = join(work, "AppDir");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true, mode: 0o755 });
  copyApp(app, join(appDir, `usr/lib/${APP}`));
  installLauncher(join(appDir, `usr/lib/${APP}/${LAUNCHER_NAME}`));
  writeFile(join(appDir, `usr/lib/${APP}/${PACKAGED_APP_FILE}`), packageMarker("appimage"));
  installShare(appDir, options.brandDir, desktop, desktopId);
  writeFile(join(appDir, "AppRun"), appRun(), 0o755);
  writeFile(join(appDir, `${desktopId}.desktop`), desktop);
  installFile(LGPL_TEXT, join(appDir, `usr/share/doc/${APP}/LGPL-2.1.txt`));
  writeFile(join(appDir, `usr/share/doc/${APP}/APPIMAGE-RUNTIME-NOTICE.txt`), runtimeNotice());
  installFile(join(options.brandDir, "logo256.png"), join(appDir, `${APP}.png`));
  if (options.appimagetool) {
    if (!options.runtime) throw new Error("--appimagetool needs --runtime (the pinned runtime)");
    const appimage = join(out, names.appimage);
    execFileSync(
      options.appimagetool,
      ["--no-appstream", "--runtime-file", options.runtime, appDir, appimage],
      { env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" }, stdio: "inherit" },
    );
    chmodSync(appimage, 0o755);
    files.push(appimage);
  }

  // .deb
  const debRoot = join(work, "deb");
  rmSync(debRoot, { recursive: true, force: true });
  mkdirSync(debRoot, { recursive: true, mode: 0o755 });
  copyApp(app, join(debRoot, `usr/lib/${APP}`));
  installShare(debRoot, options.brandDir, desktop, desktopId);
  mkdirSync(join(debRoot, "usr/bin"), { recursive: true, mode: 0o755 });
  symlinkSync(`../lib/${APP}/${APP}`, join(debRoot, `usr/bin/${APP}`));
  installLauncher(join(debRoot, `usr/lib/${APP}/${LAUNCHER_NAME}`));
  writeFile(join(debRoot, `usr/lib/${APP}/${PACKAGED_APP_FILE}`), packageMarker("deb"));
  symlinkSync(`../lib/${APP}/${LAUNCHER_NAME}`, join(debRoot, `usr/bin/${LAUNCHER_NAME}`));
  writeFile(join(debRoot, `usr/share/doc/${APP}/copyright`), COPYRIGHT);
  const size = installedKiB(debRoot);
  mkdirSync(join(debRoot, "DEBIAN"), { mode: 0o755 });
  chmodSync(join(debRoot, "DEBIAN"), 0o755);
  writeFile(
    join(debRoot, "DEBIAN/control"),
    debControl({ version, maintainer: options.maintainer, installedKiB: size }),
  );
  writeFile(join(debRoot, "DEBIAN/postinst"), POSTINST, 0o755);
  writeFile(join(debRoot, "DEBIAN/prerm"), PRERM, 0o755);
  if (options.buildDeb !== false) {
    const deb = join(out, names.deb);
    execFileSync("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", debRoot, deb], {
      stdio: "inherit",
    });
    files.push(deb);
  }

  if (options.sbom) {
    const sbom = join(out, names.sbom);
    if (options.sbom !== sbom) copyFileSync(options.sbom, sbom);
    files.push(sbom);
  }

  // vimma-bin (releases only): the PKGBUILD and SRCINFO are release assets; aur/ holds the
  // variant release.yml pushes to the AUR, which differs only in its install source.
  const aurDir = join(out, "aur");
  rmSync(aurDir, { recursive: true, force: true });
  if (!version.includes("-")) {
    /** @type {Omit<AurInput, "installSource">} */
    const aur = {
      version,
      maintainer: options.maintainer,
      repo: options.repo,
      tarballSha256: sha256File(tarball),
      desktop,
      desktopId,
      launcher: readFileSync(LAUNCHER, "utf8"),
    };
    const info = srcinfo({ ...aur, installSource: "pkgbuild-release" });
    writeFile(join(out, names.pkgbuild), pkgbuild({ ...aur, installSource: "pkgbuild-release" }));
    writeFile(join(out, names.srcinfo), info);
    files.push(join(out, names.pkgbuild), join(out, names.srcinfo));
    writeFile(join(aurDir, "PKGBUILD"), pkgbuild({ ...aur, installSource: "aur" }));
    writeFile(join(aurDir, ".SRCINFO"), info);
  }

  // Not assets either: release.yml puts them at the top and the end of the release notes.
  writeFile(join(out, "notes/updating.md"), updatingNotes(version, options.repo));
  writeFile(join(out, "notes/third-party.md"), thirdPartyNotes());

  writeFile(join(out, names.checksums), sha256sums(files));
  return { version, files: [...files, join(out, names.checksums)], appDir, debRoot, aurDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      tarball: { type: "string" },
      out: { type: "string" },
      maintainer: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string", default: REPO },
      sbom: { type: "string" },
      appimagetool: { type: "string" },
      runtime: { type: "string" },
      "no-deb": { type: "boolean", default: false },
    },
  });
  if (!values.tarball || !values.out || !values.maintainer) {
    console.error("usage: package.mjs --tarball <file> --out <dir> --maintainer 'Name <email>' …");
    process.exit(2);
  }
  const root = new URL("../../", import.meta.url);
  const result = packageRelease({
    tarball: values.tarball,
    outDir: values.out,
    maintainer: values.maintainer,
    tag: values.tag,
    repo: values.repo ?? REPO,
    sbom: values.sbom,
    appimagetool: values.appimagetool,
    runtime: values.runtime,
    buildDeb: !values["no-deb"],
    config: JSON.parse(readFileSync(new URL("surfer.json", root), "utf8")),
    brandDir: fileURLToPath(new URL("configs/branding/vimma/", root)),
  });
  console.log(`package: Vimma ${result.version}`);
  for (const file of result.files) console.log(`  ${file}`);
  console.log(`  ${result.aurDir}/ (the AUR's PKGBUILD and .SRCINFO)`);
}

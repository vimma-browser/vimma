#!/usr/bin/env node
// Spec macos-homebrew, decisions 12 and 13: the macOS app, document and fallback icons, generated
// from configs/branding/vimma/logo-mac.png (byte-identical to the Linux logo.png) and committed
// beside it: Surfer's branding step copies the top-level files of configs/branding/vimma/ over
// Firefox's unofficial branding. Not src/, whose license check reads every file for an MPL header.
//
//   Assets.car     the app icon macOS draws: actool compiles the Icon Composer source
//                  configs/macos/AppIcon.icon with the mark as its one layer
//   firefox.icns   CFBundleIconFile, for tools that do not read Assets.car: the mark, as on Linux
//                  (actool's own AppIcon.icns stops at 256 px)
//   document.icns  the icon of HTML and other documents Vimma opens: the mark on a page
//   disk.icns      the mounted dmg's volume icon: the mark, the same file as firefox.icns
//   background.png the mounted dmg's window: the brand background and an arrow from the app to
//                  the Applications link, laid out by DMG_LAYOUT (the dsstore beside it is
//                  Finder's, written by tools/package/macos-dsstore.sh)
//
// Needs macOS with Xcode (actool is not in the Command Line Tools); macos.yml runs it with
// `--check`, which regenerates the files and fails if the committed ones differ.
//
//   node tools/package/macos-icons.mjs            write the files into configs/branding/vimma
//   node tools/package/macos-icons.mjs --out DIR  write them into DIR instead
//   node tools/package/macos-icons.mjs --check    regenerate and compare with the committed files
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const MARK = join(repo, "configs/branding/vimma/logo-mac.png");
const ICON_SOURCE = join(repo, "configs/macos/AppIcon.icon");
const BRANDING = join(repo, "configs/branding/vimma");
export const FILES = ["Assets.car", "firefox.icns", "document.icns", "disk.icns", "background.png"];
// The green of the mark in logo.png.
const MARK_GREEN = "#1afa80";
/**
 * The mounted dmg's Finder window, in points: its size, which background.png fills at 144 dpi,
 * and where the app and the Applications link (named " ") sit, by the centre of their icons.
 * tools/package/macos-dsstore.sh lays the window out to match.
 */
export const DMG_LAYOUT = {
  window: { width: 640, height: 400 },
  iconSize: 128,
  icons: { "Vimma.app": [180, 190], " ": [460, 190] },
};
// Firefox's minimum for aarch64 (build/moz.configure/toolchain.configure).
const MINIMUM_MACOS = "11.0";
// iconutil's names and the pixel size of each.
const ICONSET = [16, 32, 128, 256, 512].flatMap((s) => [
  [`icon_${s}x${s}.png`, s],
  [`icon_${s}x${s}@2x.png`, s * 2],
]);

/**
 * @param {string} cmd
 * @param {string[]} args
 */
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" });

/**
 * A document page in the brand's colours with a folded corner, as an SVG on a 1024 canvas.
 * @param {string} background the brand background, #rrggbb
 */
export function pageSvg(background) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <path d="M232 64H632L824 256V912Q824 960 776 960H248Q200 960 200 912V96Q200 64 232 64Z"
    fill="${background}" stroke="#3b4261" stroke-width="12" stroke-linejoin="round"/>
  <path d="M632 64V216Q632 256 672 256H824Z" fill="#3b4261"/>
</svg>`;
}

/**
 * The dmg window's background at twice DMG_LAYOUT's size, as an SVG: the brand background and an
 * arrow from the app to the Applications link, in the mark's green.
 * @param {string} background the brand background, #rrggbb
 * @param {string} accent the arrow, #rrggbb
 */
export function dmgBackgroundSvg(background, accent) {
  const { window, iconSize, icons } = DMG_LAYOUT;
  const [[appX, y], [linkX]] = Object.values(icons).map(([x, y]) => [x * 2, y * 2]);
  // from beside the app's icon to beside the link's, with a gap of a fifth of an icon
  const gap = iconSize + iconSize / 2.5;
  const [from, to] = [appX + gap, linkX - gap];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${window.width * 2}" height="${window.height * 2}">
  <rect width="100%" height="100%" fill="${background}"/>
  <g fill="none" stroke="${accent}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${from} ${y}H${to}"/>
    <path d="M${to - 36} ${y - 36}L${to} ${y}L${to - 36} ${y + 36}"/>
  </g>
</svg>`;
}

/**
 * An .icns with every size iconutil knows, up to 1024 px, from one square image.
 * @param {any} sharp
 * @param {Buffer} image
 * @param {string} file
 * @param {string} iconset
 */
async function icns(sharp, image, file, iconset) {
  mkdirSync(iconset);
  for (const [name, size] of ICONSET) {
    await sharp(image)
      .resize(Number(size), Number(size))
      .png()
      .toFile(join(iconset, String(name)));
  }
  run("iconutil", ["--convert", "icns", "--output", file, iconset]);
}

/**
 * @param {string} out
 * @param {string} work
 */
async function generate(out, work) {
  const surfer = JSON.parse(readFileSync(join(repo, "surfer.json"), "utf8"));
  const { default: sharp } = await import("sharp");

  // actool reads the Icon Composer bundle with its layer image beside icon.json.
  const icon = join(work, "AppIcon.icon");
  mkdirSync(join(icon, "Assets"), { recursive: true });
  copyFileSync(join(ICON_SOURCE, "icon.json"), join(icon, "icon.json"));
  copyFileSync(MARK, join(icon, "Assets/vimma-mark.png"));
  const compiled = join(work, "compiled");
  mkdirSync(compiled);
  process.stdout.write(
    run("xcrun", [
      "actool",
      icon,
      "--compile",
      compiled,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      MINIMUM_MACOS,
      "--app-icon",
      "AppIcon",
      "--include-all-app-icons",
      "--output-partial-info-plist",
      join(work, "partial.plist"),
      "--errors",
      "--warnings",
      "--output-format",
      "human-readable-text",
    ]),
  );
  copyFileSync(join(compiled, "Assets.car"), join(out, "Assets.car"));
  await icns(sharp, readFileSync(MARK), join(out, "firefox.icns"), join(work, "firefox.iconset"));

  const page = await sharp(Buffer.from(pageSvg(surfer.brands.vimma.backgroundColor)))
    .composite([
      { input: await sharp(MARK).resize(560, 560).png().toBuffer(), top: 300, left: 232 },
    ])
    .png()
    .toBuffer();
  await icns(sharp, page, join(out, "document.icns"), join(work, "document.iconset"));

  // The dmg's volume icon is the mark, as firefox.icns, so the mounted volume shows Vimma's logo.
  copyFileSync(join(out, "firefox.icns"), join(out, "disk.icns"));
  await dmgBackground(sharp, join(out, "background.png"));
}

/**
 * Writes the dmg window's background.png. 144 dpi: Finder draws it at half its pixel size, so it
 * fills the window on a Retina display.
 * @param {any} sharp
 * @param {string} file
 */
export async function dmgBackground(sharp, file) {
  const surfer = JSON.parse(readFileSync(join(repo, "surfer.json"), "utf8"));
  await sharp(Buffer.from(dmgBackgroundSvg(surfer.brands.vimma.backgroundColor, MARK_GREEN)))
    .withMetadata({ density: 144 })
    .png()
    .toFile(file);
}

/**
 * What --check compares for Assets.car, from its `assetutil --info`: every asset without the
 * header, which records when and with which tools the catalog was compiled, and without the
 * flattened fallback images' names and digests, which actool generates afresh on every run
 * (a UUID in the name, different bytes). Their sizes and the layer image they are drawn from
 * are compared.
 * @param {Array<Record<string, unknown>>} info
 */
export function catalogSummary(info) {
  const assets = info
    .slice(1)
    .map(({ RenditionName, SHA1Digest, ...asset }) =>
      asset.AssetType === "Icon Image" ? asset : { RenditionName, SHA1Digest, ...asset },
    );
  return JSON.stringify(assets, null, 1);
}

/** @param {string} car */
const catalog = (car) => catalogSummary(JSON.parse(run("assetutil", ["--info", car])));

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const outIndex = argv.indexOf("--out");
  if (process.platform !== "darwin") throw new Error("macos-icons.mjs needs macOS with Xcode");
  const work = mkdtempSync(join(tmpdir(), "vimma-icons-"));
  try {
    const out = check ? join(work, "out") : outIndex >= 0 ? argv[outIndex + 1] : BRANDING;
    mkdirSync(out, { recursive: true });
    await generate(out, work);
    if (!check) return;
    const drift = FILES.filter((name) => {
      const [fresh, committed] = [join(out, name), join(BRANDING, name)];
      return name.endsWith(".car")
        ? catalog(fresh) !== catalog(committed)
        : !readFileSync(fresh).equals(readFileSync(committed));
    });
    if (drift.length) {
      console.error(
        `::error::${drift.join(", ")} differ from what macos-icons.mjs generates; ` +
          "run it on a Mac with Xcode and commit the files",
      );
      process.exitCode = 1;
    } else {
      console.log(`${FILES.join(", ")} match their sources`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

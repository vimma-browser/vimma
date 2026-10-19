#!/usr/bin/env node
// Spec macos-homebrew, decisions 12 and 13: the macOS app, document and fallback icons, generated
// from configs/branding/vimma/logo-mac.png (byte-identical to the Linux logo.png) and committed to
// src/browser/branding/vimma/, which Surfer links over Firefox's unofficial branding.
//
//   Assets.car     the app icon macOS draws: actool compiles the Icon Composer source
//                  configs/branding/vimma/macos/AppIcon.icon with the mark as its one layer
//   firefox.icns   CFBundleIconFile, for systems that do not read Assets.car (actool's AppIcon.icns)
//   document.icns  the icon of HTML and other documents Vimma opens: the mark on a page
//
// Needs macOS with Xcode (actool is not in the Command Line Tools); macos.yml runs it with
// `--check`, which regenerates the files and fails if the committed ones differ.
//
//   node tools/package/macos-icons.mjs            write the files into src/browser/branding/vimma
//   node tools/package/macos-icons.mjs --out DIR  write them into DIR instead
//   node tools/package/macos-icons.mjs --check    regenerate and compare with the committed files
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const MARK = join(repo, "configs/branding/vimma/logo-mac.png");
const ICON_SOURCE = join(repo, "configs/branding/vimma/macos/AppIcon.icon");
const BRANDING = join(repo, "src/browser/branding/vimma");
export const FILES = ["Assets.car", "firefox.icns", "document.icns"];
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
  copyFileSync(join(compiled, "AppIcon.icns"), join(out, "firefox.icns"));

  const page = await sharp(Buffer.from(pageSvg(surfer.brands.vimma.backgroundColor)))
    .composite([
      { input: await sharp(MARK).resize(560, 560).png().toBuffer(), top: 300, left: 232 },
    ])
    .png()
    .toBuffer();
  const iconset = join(work, "document.iconset");
  mkdirSync(iconset);
  for (const [name, size] of ICONSET) {
    await sharp(page)
      .resize(Number(size), Number(size))
      .png()
      .toFile(join(iconset, String(name)));
  }
  run("iconutil", ["--convert", "icns", "--output", join(out, "document.icns"), iconset]);
}

/**
 * What --check compares for Assets.car: `assetutil --info` without the header, which records
 * when and with which tools the catalog was compiled.
 * @param {string} car
 */
export function catalogSummary(car) {
  const [, ...assets] = JSON.parse(run("assetutil", ["--info", car]));
  return JSON.stringify(assets, null, 1);
}

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
        ? catalogSummary(fresh) !== catalogSummary(committed)
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

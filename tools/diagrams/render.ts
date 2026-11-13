#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Renders ARCHITECTURE.md's two pictures from their D2 sources in docs/assets/diagrams/, each as
// a light and a dark SVG that a <picture> element picks between (issue #943).
//
// D2 is a build tool here, never shipped: a release binary pinned by version and SHA-256 below,
// downloaded once into the user's cache (~/.cache/vimma/d2/<version>/) and checked before it is
// unpacked. Layout is ELK, which D2 bundles and which is free (TALA is a paid engine), or D2's
// own grid where a source places its boxes by hand (system.d2).
//
// Each SVG starts with a comment holding the SHA-256 of what it was drawn from (the D2 version,
// the source and the palette), so --check finds an SVG that fell behind its source without D2:
// CI runs it in `npm run lint` and its own step of ci.yml.
//
//   node tools/diagrams/render.ts           render every diagram (downloads D2 on first use)
//   node tools/diagrams/render.ts --check   fail when an SVG is missing or stale
//
// VIMMA_D2=<path> uses a d2 binary of the pinned version instead of the download.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The pinned D2 release; the sums are those of the release's SHA256SUMS file. */
export const D2 = {
  version: "v0.9.0",
  assets: {
    "linux-amd64": { sha256: "5669ddc46b99e942cc96078f4a4e36d5e62103348f4c05179ede27802fdd87a9" },
    "linux-arm64": { sha256: "ac2c028697199479acb321db1e3d68caee9f2ba492ed73caa3cd13f3829bf913" },
    "macos-amd64": { sha256: "cad39576a480d6bb02ea142fef1726647914b0d2da51ccc9b30b660a2b1babf0" },
    "macos-arm64": { sha256: "eaf6c0c143e56dd9fa97bfb6df25ea9c1ebce40245f056a0768cf1a6c15d3064" },
  } as Record<string, { sha256: string } | undefined>,
};

export interface Diagram {
  name: string;
  /** the D2 source, relative to the repository */
  source: string;
}

export const DIAGRAMS: readonly Diagram[] = [
  { name: "system", source: "docs/assets/diagrams/system.d2" },
  { name: "modules", source: "docs/assets/diagrams/modules.d2" },
];

/**
 * D2's flags for every render: ELK's spacing set tighter than its defaults, so that a picture
 * fits GitHub's 760-pixel column at close to its own size and its text stays readable.
 */
export const D2_ARGS: readonly string[] = [
  "--omit-version",
  "--elk-nodeNodeBetweenLayers=40",
  "--elk-edgeNodeBetweenLayers=20",
  "--elk-padding=[top=40,left=20,bottom=20,right=20]",
];

export type Variant = "light" | "dark";

interface Palette {
  /** D2's base theme, which sets what the overrides leave alone */
  themeId: number;
  /** D2's theme colour codes, so unstyled text and edges match too */
  overrides: Record<string, string>;
  /** the colours the sources use as ${name} */
  vars: Record<string, string>;
}

// GitHub's own colours (Primer's light and dark themes), so a picture sits on the page like part
// of it: the canvas is the page's background, text and lines its foreground and muted greys.
export const PALETTES: Record<Variant, Palette> = {
  light: {
    themeId: 0,
    overrides: {
      N1: "#1f2328",
      N2: "#59636e",
      N3: "#818b98",
      N4: "#d1d9e0",
      N5: "#e6eaef",
      N6: "#f6f8fa",
      N7: "#ffffff",
      B1: "#0969da",
      B2: "#0969da",
      B3: "#54aeff",
      B4: "#b6e3ff",
      B5: "#ddf4ff",
      B6: "#f6f8fa",
      AA2: "#0969da",
      AA4: "#b6e3ff",
      AA5: "#ddf4ff",
      AB4: "#b6e3ff",
      AB5: "#ddf4ff",
    },
    vars: {
      bg: "#ffffff",
      text: "#1f2328",
      muted: "#59636e",
      line: "#59636e",
      box: "#f6f8fa",
      "box-line": "#818b98",
      accent: "#0969da",
      "accent-fill": "#ddf4ff",
      cycle: "#bc4c00",
      "cycle-fill": "#fff1e5",
      "core-fill": "#dafbe1",
      "core-line": "#1a7f37",
      "zone-app": "#f6f8fa",
      "zone-page": "#fff8c5",
      "zone-page-line": "#9a6700",
      "zone-local": "#ffffff",
      "zone-net": "#ffffff",
    },
  },
  dark: {
    themeId: 200,
    overrides: {
      N1: "#f0f6fc",
      N2: "#9198a1",
      N3: "#656c76",
      N4: "#3d444d",
      N5: "#2f3742",
      N6: "#151b23",
      N7: "#0d1117",
      B1: "#4493f8",
      B2: "#4493f8",
      B3: "#1f6feb",
      B4: "#1e4273",
      B5: "#0d2847",
      B6: "#151b23",
      AA2: "#4493f8",
      AA4: "#1e4273",
      AA5: "#0d2847",
      AB4: "#1e4273",
      AB5: "#0d2847",
    },
    vars: {
      bg: "#0d1117",
      text: "#f0f6fc",
      muted: "#9198a1",
      line: "#9198a1",
      box: "#151b23",
      "box-line": "#656c76",
      accent: "#4493f8",
      "accent-fill": "#0d2847",
      cycle: "#f0883e",
      "cycle-fill": "#2e1a0c",
      "core-fill": "#0f2d1a",
      "core-line": "#3fb950",
      "zone-app": "#151b23",
      "zone-page": "#272115",
      "zone-page-line": "#d29922",
      "zone-local": "#0d1117",
      "zone-net": "#0d1117",
    },
  },
};

/** The release asset for a platform, as Node names it (`process.platform`, `process.arch`). */
export function d2Asset(
  platform: string,
  arch: string,
): { name: string; sha256: string; url: string } {
  const os = { linux: "linux", darwin: "macos" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  const key = `${os}-${cpu}`;
  const pinned = os && cpu ? D2.assets[key] : undefined;
  if (!pinned) throw new Error(`no pinned D2 for ${platform}-${arch}`);
  const name = `d2-${D2.version}-${key}.tar.gz`;
  return {
    name,
    sha256: pinned.sha256,
    url: `https://github.com/terrastruct/d2/releases/download/${D2.version}/${name}`,
  };
}

export function verifyChecksum(bytes: Uint8Array, sha256: string): void {
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`D2 download checksum mismatch: got ${got}, want ${sha256}`);
}

/** The source as D2 reads it: the palette appended as vars, with the layout settings. */
export function composeSource(source: string, palette: Palette): string {
  const quote = (o: Record<string, string>, indent: string) =>
    Object.entries(o).map(([k, v]) => `${indent}${k}: "${v}"`);
  return [
    source.endsWith("\n") ? source : `${source}\n`,
    "# Appended by tools/diagrams/render.ts: the palette and the layout.",
    "vars: {",
    ...quote(palette.vars, "  "),
    "  d2-config: {",
    "    layout-engine: elk",
    `    theme-id: ${palette.themeId}`,
    "    pad: 16",
    "    theme-overrides: {",
    ...quote(palette.overrides, "      "),
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** What an SVG records: the hash of the D2 version, its flags and the composed source. */
export function sourceHash(source: string, variant: Variant): string {
  return createHash("sha256")
    .update(`d2 ${D2.version} ${D2_ARGS.join(" ")}\n${composeSource(source, PALETTES[variant])}`)
    .digest("hex");
}

const STAMP = /^<!-- Rendered by tools\/diagrams\/render\.ts from source sha256:([0-9a-f]{64})\b/m;

export function stamp(svg: string, hash: string): string {
  const comment =
    `<!-- Rendered by tools/diagrams/render.ts from source sha256:${hash}; ` +
    "regenerate with npm run diagrams, do not edit. -->";
  const decl = /^<\?xml[^>]*\?>/.exec(svg)?.[0] ?? "";
  const body = svg.slice(decl.length).replace(/\s+$/, "");
  return `${decl ? `${decl}\n` : ""}${comment}\n${body}\n`;
}

export function readStamp(svg: string): string | null {
  return STAMP.exec(svg)?.[1] ?? null;
}

const svgPath = (d: Diagram, variant: Variant) =>
  join(dirname(d.source), `${d.name}-${variant}.svg`);

/** What is stale or missing, as messages; empty when every SVG matches its source. */
export function checkDiagrams(root: string, diagrams: readonly Diagram[]): string[] {
  const errors: string[] = [];
  for (const d of diagrams) {
    const source = readFileSync(join(root, d.source), "utf8");
    for (const variant of ["light", "dark"] as const) {
      const svg = svgPath(d, variant);
      if (!existsSync(join(root, svg))) {
        errors.push(`${svg} is missing: run npm run diagrams`);
        continue;
      }
      const recorded = readStamp(readFileSync(join(root, svg), "utf8"));
      if (recorded !== sourceHash(source, variant))
        errors.push(`${svg} was rendered from another ${d.source}: run npm run diagrams`);
    }
  }
  return errors;
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "vimma", "d2", D2.version);
}

/** A d2 binary of the pinned version: VIMMA_D2, the cached one, or a verified download. */
async function d2Binary(): Promise<string> {
  const version = (bin: string) => execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  const override = process.env.VIMMA_D2;
  if (override) {
    if (version(override) !== D2.version)
      throw new Error(`VIMMA_D2 is ${version(override)}, the pin is ${D2.version}`);
    return override;
  }
  const dir = cacheDir();
  const bin = join(dir, `d2-${D2.version}`, "bin", "d2");
  if (existsSync(bin)) return bin;
  const asset = d2Asset(process.platform, process.arch);
  console.log(`Downloading ${asset.url}`);
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`${asset.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyChecksum(bytes, asset.sha256);
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(dir, "download-"));
  try {
    writeFileSync(join(tmp, asset.name), bytes);
    execFileSync("tar", ["-xzf", join(tmp, asset.name), "-C", dir]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (version(bin) !== D2.version) throw new Error(`${bin} does not report ${D2.version}`);
  return bin;
}

async function render(): Promise<void> {
  const bin = await d2Binary();
  const tmp = mkdtempSync(join(cacheDir(), "render-"));
  try {
    for (const d of DIAGRAMS) {
      const source = readFileSync(join(ROOT, d.source), "utf8");
      for (const variant of ["light", "dark"] as const) {
        const input = join(tmp, `${d.name}-${variant}.d2`);
        const output = join(tmp, `${d.name}-${variant}.svg`);
        writeFileSync(input, composeSource(source, PALETTES[variant]));
        execFileSync(bin, [...D2_ARGS, input, output], { stdio: ["ignore", "ignore", "inherit"] });
        const svg = stamp(readFileSync(output, "utf8"), sourceHash(source, variant));
        writeFileSync(join(ROOT, svgPath(d, variant)), svg);
        console.log(`Rendered ${svgPath(d, variant)}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const errors = checkDiagrams(ROOT, DIAGRAMS);
    if (errors.length) {
      for (const e of errors) console.error(e);
      console.error(`\nDiagrams: ${errors.length} SVG(s) behind their source.`);
      process.exit(1);
    }
    console.log("Diagrams: every SVG matches its D2 source.");
    return;
  }
  await render();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

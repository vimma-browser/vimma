#!/usr/bin/env node
/**
 * Licence check of our Rust crates (ADR-011): every package `cargo metadata` resolves for each
 * manifest in CRATE_MANIFESTS (dependencies of every kind and platform, and the crate itself)
 * must carry a licence expression satisfied by license-check.ts's ALLOWED, or a reviewed
 * exception in cargo-exceptions.json keyed by exact name@version. Usage:
 *   node tools/license-check/cargo-license-check.ts [--metadata file.json] [--exceptions f.json]
 * Without --metadata it runs `cargo metadata --locked` on each manifest.
 * Exit 0 clean, 1 on violations or unused exceptions, 2 on bad input or a failing cargo.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLOWED, spdxAllowed } from "./license-check.ts";

export const CRATE_MANIFESTS = ["tools/vimma-ctl/Cargo.toml"];

export interface Exception {
  license: string | null;
  reason: string;
}
export interface Violation {
  name: string;
  version: string;
  license: string | null;
}
export interface Metadata {
  packages: Array<{ name: string; version: string; license?: string | null }>;
}

/** Cargo still accepts the pre-SPDX `MIT/Apache-2.0`, which means OR. */
export function normaliseCargoLicense(license: string | null | undefined) {
  if (typeof license !== "string") return null;
  return license.replace(/\s*\/\s*/g, " OR ");
}

export function checkCargoMetadata(
  metadata: Metadata,
  {
    allow = ALLOWED,
    exceptions = {},
  }: { allow?: Set<string>; exceptions?: Record<string, Exception> } = {},
): { violations: Violation[]; unusedExceptions: string[] } {
  const violations: Violation[] = [];
  const used = new Set();
  for (const { name, version, license: raw } of metadata.packages) {
    const license = raw ?? null;
    if (spdxAllowed(normaliseCargoLicense(license), allow)) continue;
    const key = `${name}@${version}`;
    if (exceptions[key] && exceptions[key].license === license) {
      used.add(key);
      continue;
    }
    violations.push({ name, version, license });
  }
  const unusedExceptions = Object.keys(exceptions).filter((key) => !used.has(key));
  return { violations, unusedExceptions };
}

function cargoMetadata(manifest: string): Metadata {
  const out = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.status !== 0) {
    throw new Error(`cargo metadata ${manifest} failed: ${out.stderr || out.error}`);
  }
  return JSON.parse(out.stdout);
}

function main(argv: string[]) {
  let metadataPath: string | null = null;
  let exceptionsPath = fileURLToPath(new URL("cargo-exceptions.json", import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--metadata") metadataPath = argv[++i] ?? "";
    else if (argv[i] === "--exceptions") exceptionsPath = argv[++i] ?? "";
  }
  const merged: Metadata = { packages: [] };
  let exceptions: Record<string, Exception> = {};
  try {
    const sources = metadataPath
      ? [JSON.parse(readFileSync(metadataPath, "utf8"))]
      : CRATE_MANIFESTS.map(cargoMetadata);
    const seen = new Set();
    for (const { packages } of sources) {
      for (const p of packages) {
        const key = `${p.name}@${p.version}`;
        if (!seen.has(key)) merged.packages.push(p);
        seen.add(key);
      }
    }
    if (existsSync(exceptionsPath)) {
      exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8")).exceptions ?? {};
    }
  } catch (err) {
    console.error(`cargo-license-check: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  const { violations, unusedExceptions } = checkCargoMetadata(merged, { exceptions });
  for (const v of violations) {
    console.error(
      `cargo-license-check: ${v.name}@${v.version} has licence ${v.license ?? "(none)"}`,
    );
  }
  for (const key of unusedExceptions) {
    console.error(`cargo-license-check: exception ${key} matches nothing; remove it`);
  }
  if (violations.length || unusedExceptions.length) {
    console.error(
      `Allowed: ${[...ALLOWED].join(", ")}. Add a reviewed exception to ${exceptionsPath}.`,
    );
    return 1;
  }
  console.log(`cargo-license-check: ${merged.packages.length} crate(s), all allowed`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

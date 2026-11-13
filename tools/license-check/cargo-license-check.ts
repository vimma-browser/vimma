#!/usr/bin/env node
/**
 * Licence check of our Rust crates (ADR-011): every package `cargo metadata` resolves for each
 * manifest in CRATE_MANIFESTS (dependencies of every kind and platform, and the crate itself)
 * must carry a licence expression satisfied by license-check.mjs's ALLOWED, or a reviewed
 * exception in cargo-exceptions.json keyed by exact name@version. Usage:
 *   node tools/license-check/cargo-license-check.mjs [--metadata file.json] [--exceptions f.json]
 * Without --metadata it runs `cargo metadata --locked` on each manifest.
 * Exit 0 clean, 1 on violations or unused exceptions, 2 on bad input or a failing cargo.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLOWED, spdxAllowed } from "./license-check.mjs";

export const CRATE_MANIFESTS = ["tools/vimma-ctl/Cargo.toml"];

/**
 * @typedef {{ license: string | null, reason: string }} Exception
 * @typedef {{ name: string, version: string, license: string | null }} Violation
 * @typedef {{ packages: Array<{ name: string, version: string, license?: string | null }> }} Metadata
 */

/**
 * Cargo still accepts the pre-SPDX `MIT/Apache-2.0`, which means OR.
 * @param {string | null | undefined} license
 */
export function normaliseCargoLicense(license) {
  if (typeof license !== "string") return null;
  return license.replace(/\s*\/\s*/g, " OR ");
}

/**
 * @param {Metadata} metadata
 * @param {{ allow?: Set<string>, exceptions?: Record<string, Exception> }} [options]
 * @returns {{ violations: Violation[], unusedExceptions: string[] }}
 */
export function checkCargoMetadata(metadata, { allow = ALLOWED, exceptions = {} } = {}) {
  /** @type {Violation[]} */
  const violations = [];
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

/** @param {string} manifest @returns {Metadata} */
function cargoMetadata(manifest) {
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

/** @param {string[]} argv */
function main(argv) {
  /** @type {string | null} */
  let metadataPath = null;
  let exceptionsPath = fileURLToPath(new URL("cargo-exceptions.json", import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--metadata") metadataPath = argv[++i] ?? "";
    else if (argv[i] === "--exceptions") exceptionsPath = argv[++i] ?? "";
  }
  /** @type {Metadata} */
  const merged = { packages: [] };
  /** @type {Record<string, Exception>} */
  let exceptions = {};
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

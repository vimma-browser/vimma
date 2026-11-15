#!/usr/bin/env node
/**
 * Validates a CycloneDX SBOM against the official 1.6 JSON schema vendored in
 * tools/package/vendor/cyclonedx-1.6.2/ (spec m6-packaging). release.yml runs it on every SBOM.
 * Usage: node tools/package/validate-sbom.mjs <file.cdx.json>   Exit 0 valid, 1 invalid.
 */
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VENDOR = new URL("vendor/cyclonedx-1.6.2/", import.meta.url);
/** @param {string} name */
const schema = (name) => JSON.parse(readFileSync(new URL(name, VENDOR), "utf8"));

/** @returns {import("ajv").ValidateFunction} the bom-1.6 validator */
export function cyclonedxValidator() {
  // strict off: the official schema uses keywords ajv's strict mode rejects (e.g. "meta:enum").
  // Formats are not checked (ajv-formats is not a dependency); the structure and enums are.
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(schema("spdx.schema.json"), "spdx.schema.json");
  ajv.addSchema(schema("jsf-0.82.schema.json"), "jsf-0.82.schema.json");
  return ajv.compile(schema("bom-1.6.schema.json"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: validate-sbom.mjs <file.cdx.json>");
    process.exit(2);
  }
  const validate = cyclonedxValidator();
  if (validate(JSON.parse(readFileSync(file, "utf8")))) {
    console.log(`${file}: valid CycloneDX 1.6`);
  } else {
    for (const error of validate.errors ?? []) {
      console.error(`${error.instancePath || "/"}: ${error.message}`);
    }
    process.exit(1);
  }
}

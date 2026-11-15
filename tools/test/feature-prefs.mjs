// Readers for the vimma.feature.* rule (docs/specs/firefox-versions.md, decision 16), kept apart
// from the test so the parsing has its own cases.
import { readdirSync } from "node:fs";
import { defined } from "./defined.ts";

// pref(), sticky_pref() and lockPref() are the forms a Firefox prefs file accepts
// (modules/libpref/parser); the value is kept as written so a quoted "false" or a 0 fails too.
const DEFINITION =
  /^\s*(?:pref|sticky_pref|lockPref)\s*\(\s*["'](vimma\.feature\.[^"']+)["']\s*,\s*([^)]*?)\s*\)/;

/** @param {string} text @returns {{ name: string, value: string, line: number }[]} */
export function featurePrefDefaults(text) {
  return text.split("\n").flatMap((source, i) => {
    const m = DEFINITION.exec(source);
    return m ? [{ name: defined(m[1]), value: defined(m[2]), line: i + 1 }] : [];
  });
}

// A read with a true fallback turns the feature on in any profile or build where the default
// is missing, which bypasses the default-off rule.
const TRUE_FALLBACK = /getBoolPref\(\s*["'](vimma\.feature\.[^"']+)["']\s*,\s*true\b/g;

/** @param {string} text @returns {string[]} */
export function featurePrefFallbacks(text) {
  return [...text.matchAll(TRUE_FALLBACK)].map((m) => defined(m[1]));
}

/** @param {URL} dir @returns {URL[]} every .js and .mjs file under dir */
export function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.m?js$/.test(e.name))
    .map((e) => new URL(`file://${e.parentPath}/${e.name}`));
}

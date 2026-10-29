// Regenerates packages/vimma-core/defaults.toml, docs/bindings.md and docs/bindings.json (which
// vimma.dev mirrors: docs/specs/site-keys-mirror.md) from vimma-core.
import { writeFileSync } from "node:fs";
import {
  FIREFOX_SHORTCUTS,
  MAC_KEYS,
  bindingTable,
  bindingsJson,
  compileKeymap,
  formatDefaultsToml,
  keyLegend,
} from "../packages/vimma-core/src/index.mjs";

const root = new URL("../", import.meta.url);
writeFileSync(new URL("packages/vimma-core/defaults.toml", root), formatDefaultsToml());

const keymap = compileKeymap();
const rows = bindingTable(keymap);
/** @param {string} s */
const cell = (s) => s.replaceAll("|", "\\|");
const lines = [
  "# Default bindings",
  "",
  "Generated from `packages/vimma-core/src/actions.mjs` and `defaults.mjs` by `npm run gen-docs`; do not edit.",
  "",
  `Keys as you press them, with the default keys filled in (\`${keyLegend(keymap)}\`).`,
  "A `[mode]` after a key means it works only in that mode. In `config.toml` the same bindings",
  "are written in notation: `ctrl+b b` is `prefix+b`; a leader binding you add, `<leader>n`,",
  "shows as `space n` ([guide](guide.md#configtoml)).",
];
let group = "";
for (const r of rows) {
  if (r.group !== group) {
    lines.push(
      "",
      `## ${r.group}`,
      "",
      "| Action | Config name | Bindings |",
      "| --- | --- | --- |",
    );
    group = r.group;
  }
  const keys = r.bindings.length ? r.bindings.map((b) => `\`${cell(b)}\``).join(", ") : "—";
  lines.push(`| ${cell(r.description)} | \`${r.name}\` | ${keys} |`);
}
// docs/specs/macos-build.md decision 29: the defaults macOS has instead of Linux's alt keys.
const macKeymap = compileKeymap({}, { mac: true });
lines.push(
  "",
  "## On macOS",
  "",
  "Option types characters on a Mac, so the defaults that are `alt` chords on Linux are Firefox's",
  "macOS keys there (`meta` is `cmd`). Every other binding is the same on both.",
  "",
  "| Action | Config name | Bindings on macOS |",
  "| --- | --- | --- |",
);
for (const r of bindingTable(macKeymap)) {
  if (!(r.name in MAC_KEYS)) continue;
  const keys = r.bindings.map((b) => `\`${cell(b)}\``).join(", ");
  lines.push(`| ${cell(r.description)} | \`${r.name}\` | ${keys} |`);
}
// docs/specs/firefox-keys.md: every key Firefox handles in a window, and what it is in Vimma.
lines.push(
  "",
  "## Firefox's shortcuts",
  "",
  "Every key Firefox handles in a Linux browser window, and what it does in Vimma. Most are",
  "Vimma bindings with Firefox's meaning (above, rebindable by name); **page first** means a",
  "page that uses the key itself (`ctrl+s` in an editor) gets it first, as in Firefox. Keys",
  "Vimma does not bind stay Firefox's, unless `[firefox] disable` in config.toml lists them",
  "([guide](guide.md#firefoxs-own-shortcuts)); the field's and the platform's own keys are",
  "unchanged.",
  "",
  "| Key | Firefox | In Vimma |",
  "| --- | --- | --- |",
);
/** @param {(typeof FIREFOX_SHORTCUTS)[number]} r */
const fate = (r) => {
  if (r.action) {
    const where = r.modes === "normal" ? " (normal mode)" : "";
    return `\`${r.action}\`${where}${r.first === "P" ? ", page first" : ""}`;
  }
  if (r.fate === "a") return "Vimma's own key";
  if (r.fate === "d") return "unchanged";
  return r.conditional ? "unbound (only in some builds)" : "unbound";
};
for (const r of FIREFOX_SHORTCUTS) {
  const does = r.when === "fullscreen" ? `${r.does} (in full screen)` : r.does;
  lines.push(`| \`${cell(r.chord)}\` | ${cell(does)} | ${fate(r)} |`);
}
writeFileSync(new URL("docs/bindings.md", root), lines.join("\n") + "\n");
writeFileSync(
  new URL("docs/bindings.json", root),
  JSON.stringify(bindingsJson(keymap), null, 2) + "\n",
);
console.log("wrote packages/vimma-core/defaults.toml, docs/bindings.md, docs/bindings.json");

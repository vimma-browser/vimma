// Copies packages/vimma-core/src into the chrome tree (git-ignored; see m0-key-capture spec).
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";

const root = new URL("../", import.meta.url);
const from = new URL("packages/vimma-core/src/", root);
const to = new URL("src/browser/base/content/vimma/core/", root);
// `surfer import` symlinks each file here; drop links left behind by renamed or removed modules.
const linked = new URL("engine/browser/base/content/vimma/core/", root);

rmSync(to, { recursive: true, force: true });
// What jar.mn packs (core/**/*.mjs), plus the vendored .d.mts types so `npm run typecheck` of
// chrome code that imports theme.mjs or config.mjs sees the same types as packages/ (jar.mn
// does not pack them). Vendored LICENSE/README stay in packages/ (the .mjs files carry their
// own licence headers).
/** @param {string} p */
const wanted = (p) =>
  !p.endsWith(".test.mjs") &&
  (statSync(p).isDirectory() || p.endsWith(".mjs") || p.endsWith(".d.mts"));
cpSync(from, to, { recursive: true, filter: wanted });
if (existsSync(linked)) {
  for (const f of readdirSync(linked)) {
    if (!existsSync(new URL(f, to))) rmSync(new URL(f, linked), { recursive: true });
  }
}
console.log(`sync-core: ${readdirSync(to).length} entries -> ${to.pathname}`);

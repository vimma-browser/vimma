// Copies packages/vimma-core/src into the chrome tree (git-ignored; see m0-key-capture spec).
//
// The package groups its modules in folders by area (agent/, keys/, workspaces/, …; #937); the
// copy is flat, core/<name>.mjs, so browser code and mochitests import `../core/<name>.mjs` and
// chrome://browser/content/vimma/core/<name>.mjs whichever folder the module lives in, and a move
// inside the package touches nothing under src/ or tests/. That needs module names to be unique
// across folders (coreLayout refuses two of the same name) and each module's relative imports
// rewritten for the flat copy (rewriteSpecifiers); test/sync-core.test.ts checks both, and that
// the copy differs from the package in nothing else. vendor/ keeps its own folder.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where each file of the package lands in core/: a module at the top, whatever its folder; a
 * vendored file at its own path. Throws on two modules that would land on the same name.
 * @param {readonly string[]} files  paths relative to packages/vimma-core/src, with `/`
 * @returns {Map<string, string>}  source path -> path in core/
 */
export function coreLayout(files) {
  /** @type {Map<string, string>} */
  const layout = new Map();
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const file of files) {
    const to = file.startsWith("vendor/") ? file : posix.basename(file);
    const other = owner.get(to);
    if (other !== undefined) {
      throw new Error(`sync-core: ${other} and ${file} both become core/${to}; rename one`);
    }
    owner.set(to, file);
    layout.set(file, to);
  }
  return layout;
}

/** A relative module path in quotes: an import, a re-export, or a type imported in JSDoc. */
const SPECIFIER = /(["'])(\.\.?\/[^"'\s]*?\.m?js)\1/g;

/**
 * A module's text with each relative module path pointed at the file's place in core/. Throws on
 * a relative path that names no file of the package, which would break in the copy.
 * @param {string} text
 * @param {string} file  the module's path relative to packages/vimma-core/src
 * @param {Map<string, string>} layout  from coreLayout
 * @returns {string}
 */
export function rewriteSpecifiers(text, file, layout) {
  const from = layout.get(file) ?? file;
  return text.replace(SPECIFIER, (_all, quote, spec) => {
    const target = posix.join(posix.dirname(file), spec);
    const to = layout.get(target);
    if (to === undefined) {
      throw new Error(`sync-core: ${file}: "${spec}" names ${target}, not a file of the package`);
    }
    const path = posix.relative(posix.dirname(from), to);
    return `${quote}${path.startsWith(".") ? path : `./${path}`}${quote}`;
  });
}

/**
 * What jar.mn packs (core/**\/*.mjs), plus the vendored .d.mts types so `npm run typecheck` of
 * chrome code that imports theme.mjs or config.mjs sees the same types as packages/ (jar.mn does
 * not pack them). Vendored LICENSE/README stay in packages/ (the .mjs files carry their own
 * licence headers).
 * @param {string} path
 */
const wanted = (path) => !path.endsWith(".test.mjs") && /\.(mjs|d\.mts)$/.test(path);

/**
 * The flat copy of the package at `from`, without writing it: each file's path in core/ and its
 * text. The promo recorder serves modules from it too.
 * @param {string} from  packages/vimma-core/src
 * @returns {Map<string, string>}  path in core/ -> text
 */
export function flatCore(from) {
  const files = readdirSync(from, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(from, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter(wanted)
    .sort();
  const layout = coreLayout(files);
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [file, dest] of layout) {
    const text = readFileSync(join(from, file), "utf8");
    // Vendored files keep their folder, so their own imports hold; upstream's text stays byte for
    // byte what vendor-smol-toml.ts generated.
    out.set(dest, file.startsWith("vendor/") ? text : rewriteSpecifiers(text, file, layout));
  }
  return out;
}

/**
 * Replaces `to` with the flat copy of the package at `from`.
 * @param {string} from  packages/vimma-core/src
 * @param {string} to  the chrome tree's core/
 * @returns {string[]}  the files written, relative to `to`
 */
export function syncCore(from, to) {
  const core = flatCore(from);
  rmSync(to, { recursive: true, force: true });
  for (const [dest, text] of core) {
    mkdirSync(dirname(join(to, dest)), { recursive: true });
    writeFileSync(join(to, dest), text);
  }
  return [...core.keys()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const to = join(root, "src/browser/base/content/vimma/core");
  syncCore(join(root, "packages/vimma-core/src"), to);
  // `surfer import` symlinks each file here; drop links left behind by renamed or removed modules.
  const linked = join(root, "engine/browser/base/content/vimma/core");
  if (existsSync(linked)) {
    for (const f of readdirSync(linked)) {
      if (!existsSync(join(to, f))) rmSync(join(linked, f), { recursive: true });
    }
  }
  console.log(`sync-core: ${readdirSync(to).length} entries -> ${to}/`);
}

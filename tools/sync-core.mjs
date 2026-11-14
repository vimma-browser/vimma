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

/**
 * A relative module path where a module is imported: after `from` (an import, an export-from, a
 * JSDoc `@import`), after a bare `import`, or as the argument of `import(` (a dynamic import, or
 * a type in JSDoc). Groups: the text before the quote, the quote, the path.
 */
const IMPORT_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"'\s]+?\.m?js)\2/g;

/**
 * Any quoted relative path, in any quotes, imported or not: a module, a query string, a data file,
 * a path without an extension.
 */
const QUOTED_PATH = /(["'`])(\.\.?\/[^"'`\n]*)\1/g;

/** A string on one line: its quote, its text, and its closing quote ("" when the line ends first). */
const STRING_ON_LINE = /(["'`])(?:\\.|(?!\1).)*?(\1|$)/g;

/** `import(`, whose argument must be a plain string so that the rewrite can see it. */
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const PLAIN_ARGUMENT = /^\s*(["'])[^"'`\n]*\1\s*\)/;

/**
 * A module's text with each relative import pointed at the file's place in core/. Only import
 * positions are rewritten, so text that merely looks like a path, in a string or a comment, is
 * never changed: an import's words inside a string opened earlier on the same line are text too.
 * Throws, with the file and line, on what the copy could get wrong: an import of a file the
 * package does not have, a quoted relative path anywhere else (a string, a comment, `new URL`,
 * a data file), and a dynamic import of anything but a plain string. The check and the rewrite
 * use the same set of import positions, so they cannot disagree.
 *
 * Limits: a string is read on its own line, so an apostrophe earlier on an import's line (a
 * comment saying "don't") makes the import look like text and the sync fails, loudly; and a
 * string or template literal that spans lines is not seen from its later lines, so an import's
 * words on such a later line would be taken for an import. No module has either today.
 * @param {string} text
 * @param {string} file  the module's path relative to packages/vimma-core/src
 * @param {Map<string, string>} layout  from coreLayout
 * @returns {string}
 */
export function rewriteSpecifiers(text, file, layout) {
  /** @param {number} offset */
  const where = (offset) => `sync-core: ${file}:${text.slice(0, offset).split("\n").length}:`;
  for (const m of text.matchAll(DYNAMIC_IMPORT)) {
    if (!PLAIN_ARGUMENT.test(text.slice(m.index + m[0].length))) {
      throw new Error(
        `${where(m.index)} a dynamic import() of something other than a plain string, which ` +
          "the flat copy cannot rewrite",
      );
    }
  }
  /** @param {number} at  true when `at` sits inside a string opened earlier on its line */
  const inString = (at) => {
    const line = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
    return [...line.matchAll(STRING_ON_LINE)].some((q) => q[2] === "");
  };
  /** Offsets of the quotes that open an import's path. */
  const imports = new Set();
  for (const m of text.matchAll(IMPORT_SPECIFIER)) {
    if (!inString(m.index)) imports.add(m.index + (m[1] ?? "").length);
  }
  for (const m of text.matchAll(QUOTED_PATH)) {
    if (!imports.has(m.index)) {
      throw new Error(
        `${where(m.index)} ${m[0]} is a relative path but not an import; the flat copy would ` +
          "break it, so reword it or import it",
      );
    }
  }
  const from = layout.get(file) ?? file;
  return text.replace(IMPORT_SPECIFIER, (all, before, quote, spec, offset) => {
    // Not an import (inside a string): the check above has already refused its path.
    if (!imports.has(offset + before.length)) return all;
    const target = posix.join(posix.dirname(file), spec);
    const to = layout.get(target);
    if (to === undefined) {
      throw new Error(`${where(offset)} "${spec}" names ${target}, not a file of the package`);
    }
    const path = posix.relative(posix.dirname(from), to);
    return `${before}${quote}${path.startsWith(".") ? path : `./${path}`}${quote}`;
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

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The import layering of src/browser/base/content/vimma/ (ADR-026), checked by
// `npm run layering` (part of `npm run lint`) and by its own step in ci.yml. Each folder has a
// layer (layers.ts); a module may import its own folder and any folder of a lower layer, never
// one of its own layer or a higher one, eagerly or lazily, with no exception: layers.ts lists
// none, and an entry there fails the check (ADR-026, decision 5). No two modules may import each
// other eagerly, at any distance. A restricted module (the agent gate) may be imported only by
// the modules layers.ts lists for it, whatever their layer; no module may hand it on (export it,
// return it, pass it, store it, take a method of it uncalled: handOnsOf), and no Firefox patch
// may name it or build a Vimma URL from parts, so a new caller is a reviewed change. Where a rule
// could list forms to refuse, it lists instead the one form the tree uses and refuses the rest:
// ChromeUtils only as ChromeUtils.<name>, the loader only called directly, a lazy getter object
// only a fresh const, the gate only by its exact URL, jar.mn and vimma/moz.build only as they
// are, only the file types the check reads (ADR-026, "Limits of the check"). Tabs and line
// breaks, a query, a fragment, `.` or `..` segments, `%` escapes or the case of a URL's scheme
// and host do not hide an import; a string that names content/vimma/ without resolving is an
// error, and so is one that reaches a Vimma file through resource:// (ALIAS_ROOTS).
//
// eslint's no-restricted-imports cannot do this: it sees `import` declarations only, and most of
// these edges are chrome:// URLs passed to ChromeUtils.importESModule or to a lazy getter map.
// So each module is parsed and every string that names a Vimma module is an edge:
//
//   eager  an `import` or `export … from` declaration, a page's `<script src>`, or
//          ChromeUtils.importESModule run while the module evaluates (outside any function, in
//          a function called on the spot, a static block or a static field).
//   lazy   anything else: a defineESModuleGetters map, importESModule inside a function,
//          import(), an actor's esModuleURI, a worker's URL. Loaded on first use.
//
// A string naming vimma.js, the root window script, is not an edge outside a load position: no
// module can import a classic script.
//
// A specifier where a module is loaded must be a fixed string, so that no import escapes the
// check; a string holding only part of a Vimma URL is refused too. Type-only references
// (`@import`, `import("…")` in JSDoc) are comments and never load a module, so they are not
// edges. ADR-026, "Limits of the check", lists what it does not see. The files come from `git ls-files`, so vimma/core/ (a git-ignored copy
// that sync-core makes) is not read; imports of it are always allowed, as layer 0.
//
// Every edge outside core/ must also name a module that exists: one git tracks and jar.mn
// packages. A mistyped chrome:// URL (the parent actor's, which vimma.js passes in) fails here.
//
//   node tools/layering/layering.ts

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Reference } from "eslint-scope";
import * as espree from "espree";
import { EXCEPTIONS, LAYERS, RESTRICTED } from "./layers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VIMMA = "src/browser/base/content/vimma/";
const URL_PREFIX = "chrome://browser/content/vimma/";
const LAYERS_FILE = "tools/layering/layers.ts";
const ADR = "ADR-026";
/** The folder of the files at the top of vimma/ (vimma.js). */
export const ROOT_FOLDER = "(root)";

export interface Edge {
  /** the importing module, relative to vimma/ */
  from: string;
  /** the imported module (or, for a URL prefix, its folder with a trailing slash) */
  to: string;
  kind: "eager" | "lazy";
  line: number;
}

/**
 * An import that crosses the layering upwards. layers.ts lists none and exceptionErrors refuses
 * one there; layerErrors and the module diagram still take a list, which their tests fill.
 */
export interface Exception {
  from: string;
  to: string;
  kind: "eager" | "lazy";
  /** why the import cannot be avoided today */
  reason: string;
  /** "stays": ADR-026 keeps it; "goes": a follow-up removes it */
  fate: "stays" | "goes";
  /** the issue that tracks its removal, for one that goes */
  issue?: number;
}

/**
 * A module only the listed modules may import, whatever their layer: the layers say which
 * folders may reach it, this says which modules do.
 */
export interface Restricted {
  /** the modules that import it today, relative to vimma/ */
  importers: string[];
  /** what adding an importer takes, for the error */
  review: string;
}

/** What one file imports, and what in it could not be read. */
export interface Scan {
  edges: Edge[];
  /** `file:line: message`, for a specifier the check cannot resolve */
  problems: string[];
  /** Where a module hands a restricted one on (handOnsOf). */
  handOns?: HandOn[];
  /**
   * Strings that name a restricted module's file (escapes decoded, control characters
   * dropped): restrictedErrors fails them in a module the list does not hold, so that a URL
   * built in a way the check cannot read still shows.
   */
  names?: Mention[];
}

/** A string in a module or a page that names a restricted module's file. */
export interface Mention {
  from: string;
  to: string;
  line: number;
  /** whether the string is the module's exact URL or a plain relative path to it */
  exact?: boolean;
}

/**
 * Text reduced to its letters and digits, in lower case: a file name searched in it cannot be
 * hidden by an escape, a control character, markup or punctuation between its letters.
 */
export const lettersOnly = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A place where a module lets a restricted module, or one of its methods, out of its own hands:
 * an export of it, or any use other than calling it, reading a getter or keeping a local alias.
 */
export interface HandOn {
  /** the module that hands it on, relative to vimma/ */
  from: string;
  /** the restricted module */
  to: string;
  line: number;
  /** what it does, as the error says it: "re-exports", "hands on", … */
  how: string;
  /**
   * For a member read without a call: the member's name ("" when computed). restrictedErrors
   * lets a getter of the restricted module's exported object pass; what it returns is left to
   * review, as what a call returns is.
   */
  member?: string;
}

interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** The URL prefixes that name a file of vimma/: its chrome:// URL and its source path URL. */
const PREFIXES = [URL_PREFIX, "moz-src:///browser/base/content/vimma/"];

/**
 * Other URLs that reach the same files. browser.manifest maps chrome://browser/content/ to
 * chrome/browser/content/browser/ of the app's omni.ja, which resource:/// and resource://app/
 * name too, and resource://gre/ reaches it in an unpackaged build. The module loader accepts
 * resource:// and keys each module by its URL, so one of these loads a second copy of the
 * module, with its own state: for the agent gate, its own questions and grants. A string with
 * `content/browser/vimma` in its path, whatever its root, is refused (ALIAS).
 */
const ALIAS_ROOTS = [
  "resource:///chrome/browser/content/browser/vimma/",
  "resource://app/chrome/browser/content/browser/vimma/",
  "resource://gre/browser/chrome/browser/content/browser/vimma/",
];

const NOT_FIXED = "an import specifier is not a fixed string";
const PARTIAL = "a string names part of a Vimma module URL, not a module or a folder";
const UNRESOLVED =
  "a string names content/vimma/ but no Vimma module or folder the check can resolve";
const ALIAS =
  "names a Vimma module through a resource:// URL, which loads a second copy of it with its own state; name it by its chrome:// URL";
const LOADER =
  "the module loader is named other than in a direct ChromeUtils.importESModule(…) or defineESModuleGetters(…) call, so the check cannot read what it loads";
const MAP =
  'a getters map must be an object literal of key: "URL" entries with fixed keys, so that the check can read each one';
const SECOND =
  "names a restricted module by another URL than its own chrome:// URL or a plain relative path, which loads a second copy of it with its own state";
const OPTIONS =
  "loads a Vimma module with an options argument, which can load it and everything it imports, the gate included, a second time in another global";
/** What every allow-list error ends with: the lists are the tree's forms, widened on review. */
const WIDEN =
  "widening this allow-list is a change to tools/layering/layering.ts that needs a fresh security review (ADR-026)";
const WORKER_GATE = "loads a restricted module in a worker, a second copy of it with its own state";
/** The constructors whose first argument is a script URL loaded in a worker. */
const WORKERS = new Set(["Worker", "ChromeWorker", "SharedWorker"]);
/** The two loader functions whose specifiers the check reads, only where called directly. */
const LOADERS = new Set(["importESModule", "defineESModuleGetters"]);
const CHROMEUTILS =
  "ChromeUtils is used other than as ChromeUtils.<name>, so the check cannot see which of its functions runs";
const NOT_MODULE = "loads a Vimma file that is not a module (.mjs or .js)";

type Resolved = { to: string } | "partial" | "unresolved" | "alias" | null;

/** Each `%XX` escape decoded: Firefox reads an escaped path as the file it names. */
const unescape = (text: string) =>
  text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * A URL as Firefox reads it (net_FilterURIString, by way of nsStandardURL::SetSpecWithEncoding):
 * tab, CR and LF dropped anywhere, and bytes up to 0x20 dropped at either end.
 */
const clean = (spec: string) => {
  const text = spec.replace(/[\t\r\n]/g, "");
  let start = 0;
  let end = text.length;
  while (start < end && isControl(text, start)) start++;
  while (end > start && isControl(text, end - 1)) end--;
  return text.slice(start, end);
};

/** Whether the character at `i` is a control character or a space (code 0x20 or below). */
const isControl = (text: string, i: number) => text.charCodeAt(i) <= 0x20;

/** A path's `.` and `..` segments resolved, as a URL parser does; `//` stays. */
function removeDots(path: string): string {
  const out: string[] = [];
  const segments = path.split("/");
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "." || seg === "..") {
      if (seg === ".." && out.length > 1) out.pop();
      if (last) out.push("");
    } else out.push(seg);
  });
  return out.join("/");
}

/**
 * The URL a specifier loads, as Firefox keys the module (scheme and host in lower case, dot
 * segments resolved, nothing decoded, query and fragment kept). A relative specifier is
 * resolved against the importer's chrome:// URL; anything else that is no URL gives null.
 */
function loadedUrl(spec: string, file: string, relative: boolean): string | null {
  let url = clean(spec);
  if (relative && (url.startsWith("./") || url.startsWith("../")))
    url = `${URL_PREFIX}${posix.dirname(file) === "." ? "" : `${posix.dirname(file)}/`}${url}`;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)([\s\S]*)$/i.exec(url);
  if (!m) return null;
  const [, scheme = "", host = "", path = "", rest = ""] = m;
  return `${scheme.toLowerCase()}${host.toLowerCase()}${removeDots(path)}${rest}`;
}

/**
 * A specifier as the module loader keys it, near enough to compare: without a query or a
 * fragment (the same file), the scheme and host in lower case, escapes decoded and `.` and `..`
 * segments resolved. A string that is no URL keeps its dots, for posix.join to resolve.
 */
function canonical(spec: string): string {
  const bare = unescape(clean(spec).replace(/[?#][\s\S]*$/, ""));
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/i.exec(bare);
  if (!m) return bare;
  const [, scheme = "", host = "", path = ""] = m;
  return `${scheme.toLowerCase()}${host.toLowerCase()}${path && posix.normalize(path)}`;
}

/**
 * A canonical URL's path under vimma/, and whether it reaches it through another root than a
 * Vimma prefix (ALIAS_ROOTS); null for a URL outside vimma/.
 */
function vimmaPath(canon: string): { path: string; alias: boolean } | null {
  for (const prefix of PREFIXES)
    if (canon.startsWith(prefix)) return { path: canon.slice(prefix.length), alias: false };
  // Any string, with a scheme or not: a root can be joined to such a tail at run time.
  const m = /(?:^|\/)content\/browser\/vimma(\/|$)/i.exec(canon);
  if (!m) return null;
  return { path: canon.slice(m.index + m[0].length), alias: true };
}

/**
 * What a specifier names: a Vimma module or folder (relative to vimma/), "partial" for a URL
 * cut short before its folder, "alias" for one reached through a resource:// URL (ALIAS_ROOTS),
 * or null for anything else (a Firefox module, a page, a data file). A path ending inside a
 * folder without a file extension names that folder: a base the importer appends a module name
 * to. A relative specifier counts only where a module is imported; elsewhere a string like
 * "./x.mjs" is just text.
 */
function resolveSpec(spec: string, file: string, relativeAllowed: boolean): Resolved {
  const canon = canonical(spec);
  const named = vimmaPath(canon);
  if (named?.alias) return "alias";
  let path = named ? named.path : null;
  if (path === null && relativeAllowed && (canon.startsWith("./") || canon.startsWith("../")))
    path = posix.join(posix.dirname(file), canon);
  if (path === null) return /content\/vimma\//i.test(canon) ? "unresolved" : null;
  if (path !== "") path = posix.normalize(path);
  if (path === ".." || path.startsWith("../")) return null;
  if (/\.m?js$/.test(path)) return { to: path };
  const slash = path.indexOf("/");
  if (slash < 0) return "partial";
  if (/\.[a-z0-9]+$/i.test(path.slice(slash + 1))) return null;
  return { to: path.slice(0, slash + 1) };
}

/** Every root a URL to a file of vimma/ starts with. */
const ROOTS = [...PREFIXES, ...ALIAS_ROOTS];

/**
 * Whether a path is vimma.js, the one classic script at the top of vimma/, which browser.xhtml
 * loads with `<script src>`. No module can import it, so a string that names it outside a load
 * position is not an edge; passed to `importESModule` or `import()`, it still is one. Any other
 * top-level name, a second script included, stays an edge until it is named here.
 */
const isRootScript = (path: string) => path === "vimma.js";

/** The value of a string literal, or of a template literal without `${}`; else null. */
function fixedString(node: AstNode): string | null {
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  const quasis = node["quasis"];
  const expressions = node["expressions"];
  if (node.type === "TemplateLiteral" && Array.isArray(expressions) && !expressions.length) {
    const head: unknown = Array.isArray(quasis) ? quasis[0] : undefined;
    return isNode(head) ? ((head["value"] as { cooked?: string }).cooked ?? null) : null;
  }
  return null;
}

/**
 * The fixed text a computed string starts with ("" when it starts with a name or a call): the
 * head of a template literal, or the left end of a `+` chain.
 */
function leadingText(node: AstNode): string {
  const fixed = fixedString(node);
  if (fixed !== null) return fixed;
  if (node.type === "TemplateLiteral") {
    const quasis = node["quasis"];
    const head: unknown = Array.isArray(quasis) ? quasis[0] : undefined;
    return isNode(head) ? ((head["value"] as { cooked?: string }).cooked ?? "") : "";
  }
  const left = node["left"];
  if (node.type === "BinaryExpression" && node["operator"] === "+" && isNode(left))
    return leadingText(left);
  return "";
}

const isFunction = (n: AstNode) =>
  n.type === "FunctionExpression" ||
  n.type === "ArrowFunctionExpression" ||
  n.type === "FunctionDeclaration";

/**
 * Every edge from one module to another Vimma module, in source order, and every specifier it
 * cannot read. An import that runs while the module evaluates is eager: a declaration, and
 * ChromeUtils.importESModule outside any function, in a function called on the spot, in a
 * static block or in a static field. Anything that runs later is lazy.
 * @param source  the module's text
 * @param file  its path relative to vimma/ (`host/VimmaHost.sys.mjs`, `vimma.js`)
 * @param watched  the restricted modules whose hand-ons to report (Scan.handOns)
 */
export function scanModule(
  source: string,
  file: string,
  watched: ReadonlySet<string> = WATCHED,
): Scan {
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: file.endsWith(".js") ? "script" : "module",
    loc: true,
    range: true,
  }) as unknown as AstNode;
  const edges: Edge[] = [];
  const problems: string[] = [];
  const names: Mention[] = [];
  const bases = [...watched].map((m) => [m, lettersOnly(posix.basename(m))] as const);
  /** Scope references, made once, when a worker's URL is a name. */
  let refs: Map<unknown, Reference> | undefined;
  /** Nodes already read by the form that holds them. */
  const done = new Set<AstNode>();
  const lineOf = (node: AstNode) => node.loc?.start.line ?? 0;
  const problem = (node: AstNode, message: string) => {
    const text = `${file}:${lineOf(node)}: ${message}`;
    if (!problems.includes(text)) problems.push(text);
  };
  /**
   * A string in any position: a module URL in it is a lazy reference. The root window script's
   * URL is not: it is text, as a page's URL is (isRootScript).
   */
  const reference = (spec: string, node: AstNode) => {
    const r = resolveSpec(spec, file, false);
    if (r === "partial") problem(node, PARTIAL);
    else if (r === "unresolved") problem(node, UNRESOLVED);
    else if (r === "alias") problem(node, ALIAS);
    else if (r && !isRootScript(r.to)) {
      exact(spec, r.to, false, node);
      edges.push({ from: file, to: r.to, kind: "lazy", line: lineOf(node) });
    }
  };
  /** A restricted module must be named by the URL that loads the one copy of it. */
  const exact = (spec: string, to: string, relative: boolean, node: AstNode) => {
    if (watched.has(to) && loadedUrl(spec, file, relative) !== URL_PREFIX + to)
      problem(node, SECOND);
  };
  /** A specifier where a module is loaded: it must be a fixed string. */
  const specifier = (
    node: AstNode,
    kind: Edge["kind"],
    relative: boolean,
    at: AstNode,
  ): string | null => {
    done.add(node);
    const spec = fixedString(node);
    if (spec === null) {
      // Whatever it starts with: resource://gre/modules/../ reaches Vimma's files too.
      problem(node, NOT_FIXED);
      return null;
    }
    mention(spec, node);
    const r = resolveSpec(spec, file, relative);
    // A Vimma file of another type (a .sh, a .png) would load unread.
    const canon = canonical(spec);
    const inside =
      vimmaPath(canon) !== null ||
      (relative && (canon.startsWith("./") || canon.startsWith("../")));
    // Case-sensitive, as git and the jar are: `x.MJS` is not a module the check reads.
    if (r === null && inside && /\.[a-z0-9]+$/i.test(canon) && !/\.m?js$/.test(canon))
      problem(node, NOT_MODULE);
    if (r === "partial") problem(node, PARTIAL);
    else if (r === "unresolved") problem(node, UNRESOLVED);
    else if (r === "alias") problem(node, ALIAS);
    else if (r) {
      exact(spec, r.to, relative, node);
      edges.push({ from: file, to: r.to, kind, line: lineOf(at) });
      return r.to;
    }
    return null;
  };
  /** A string that names a restricted module's file, for restrictedErrors (Scan.names). */
  const mention = (text: string, node: AstNode) => {
    const letters = lettersOnly(unescape(text));
    for (const [to, base] of bases)
      if (letters.includes(base))
        names.push({
          from: file,
          to,
          line: lineOf(node),
          exact: loadedUrl(text, file, true) === URL_PREFIX + to,
        });
  };

  const walk = (node: AstNode, lazy: boolean, invoked = false): void => {
    if (done.has(node)) return;
    let inner = lazy || (isFunction(node) && !invoked);
    const source = node["source"];
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isNode(source)
    ) {
      const to = specifier(source, "eager", true, node);
      // Import attributes (`with { … }`) are options too: they change how the module loads.
      if (to && ((node["attributes"] as unknown[] | undefined) ?? []).length)
        problem(source, OPTIONS);
    } else if (node.type === "ImportExpression" && isNode(source)) {
      const to = specifier(source, "lazy", true, node);
      if (to && isNode(node["options"])) problem(source, OPTIONS);
    } else if (node.type === "CallExpression") {
      const callee = node["callee"];
      const args = Array.isArray(node["arguments"]) ? (node["arguments"] as unknown[]) : [];
      const method =
        isNode(callee) && callee.type === "MemberExpression" && isNode(callee["property"])
          ? callee["property"]["name"]
          : null;
      const [first, second] = args;
      // The direct call is the one place the loader's name is read; see the Identifier branch.
      const direct =
        typeof method === "string" &&
        LOADERS.has(method) &&
        isNode(callee) &&
        !callee["computed"] &&
        isNode(callee["property"]);
      if (direct && isNode(callee) && isNode(callee["property"])) done.add(callee["property"]);
      if (direct && method === "importESModule" && isNode(first)) {
        const to = specifier(first, lazy ? "lazy" : "eager", false, first);
        if (to && args.length > 1) problem(first, OPTIONS);
      } else if (direct && method === "defineESModuleGetters" && isNode(second)) {
        const loaded: string[] = [];
        if (second.type !== "ObjectExpression") specifier(second, "lazy", false, second);
        else
          for (const prop of (second["properties"] as unknown[]) ?? []) {
            const plain =
              isNode(prop) &&
              prop.type === "Property" &&
              prop["kind"] === "init" &&
              !prop["method"] &&
              isNode(prop["key"]) &&
              keyName(prop["key"], Boolean(prop["computed"])) !== null;
            if (!plain) problem(isNode(prop) ? prop : second, MAP);
            if (isNode(prop) && isNode(prop["value"])) {
              const to = specifier(prop["value"], "lazy", false, prop["value"]);
              if (to) loaded.push(to);
            }
          }
        if (args.length > 2 && loaded.length) problem(second, OPTIONS);
      }
      // A function called on the spot runs now, as its caller does.
      if (isNode(callee) && isFunction(callee)) {
        walk(callee, lazy, true);
      }
    } else if (
      node.type === "NewExpression" &&
      isNode(node["callee"]) &&
      // `new ChromeWorker(…)`, and `new globalThis.ChromeWorker(…)` alike.
      WORKERS.has(
        String(
          node["callee"].type === "MemberExpression" &&
            !node["callee"]["computed"] &&
            isNode(node["callee"]["property"])
            ? node["callee"]["property"]["name"]
            : node["callee"]["name"],
        ),
      ) &&
      isNode(((node["arguments"] as unknown[]) ?? [])[0])
    ) {
      // A worker's script URL is a load position (decision 2): a fixed string, or a name whose
      // one declaration is a `const` with one (`new ChromeWorker(WORKER_URL)`), whose string the
      // walk reads as an edge where it is declared.
      const first = ((node["arguments"] as unknown[]) ?? [])[0];
      let to: string | null = null;
      if (isNode(first) && first.type === "Identifier") {
        done.add(first);
        refs ??= scopeRefs(ast, file);
        const spec = constString(first, refs);
        if (spec === null) problem(first, NOT_FIXED);
        else {
          const r = resolveSpec(spec, file, true);
          to = typeof r === "object" && r !== null ? r.to : null;
        }
      } else if (isNode(first)) to = specifier(first, "lazy", true, first);
      // A worker has its own global: the gate there is a second copy with its own state.
      if (to && watched.has(to) && isNode(first)) problem(first, WORKER_GATE);
    } else if (node.type === "Identifier" && LOADERS.has(String(node["name"]))) {
      // Aliased, bound, called through .call or a comma, or destructured: not a load the check
      // can read.
      problem(node, LOADER);
    } else if (node.type === "Literal" && isNode(node) && node["regex"]) {
      const pattern = (node["regex"] as { pattern?: string }).pattern ?? "";
      if (LOADERS.has(pattern)) problem(node, LOADER);
      mention(pattern, node);
    } else if (node.type === "Literal" && typeof node["value"] === "string") {
      if (LOADERS.has(node["value"])) problem(node, LOADER);
      mention(node["value"], node);
      reference(node["value"], node);
    } else if (node.type === "TemplateLiteral") {
      const fixed = fixedString(node);
      if (fixed !== null && LOADERS.has(fixed)) problem(node, LOADER);
      for (const q of (node["quasis"] as unknown[]) ?? []) {
        const cooked = isNode(q) ? (q["value"] as { cooked?: string }).cooked : undefined;
        if (typeof cooked !== "string") continue;
        mention(cooked, node);
        if (fixed === null && resolveSpec(cooked, file, false) === "alias") problem(node, ALIAS);
      }
      if (fixed !== null) reference(fixed, node);
      else {
        const r = resolveSpec(leadingText(node), file, false);
        if (r === "unresolved") problem(node, UNRESOLVED);
        else if (r === "alias") problem(node, ALIAS);
        else if (r === "partial" || (r && !r.to.endsWith("/"))) problem(node, PARTIAL);
        else if (r) edges.push({ from: file, to: r.to, kind: "lazy", line: lineOf(node) });
      }
    } else if (node.type === "PropertyDefinition" && !node["static"]) {
      // An instance field's initialiser runs when the class is constructed.
      inner = true;
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) walk(child, inner);
      } else if (isNode(value)) walk(value, inner);
    }
    done.add(node);
  };
  walk(ast, false);
  for (const node of chromeUtilsMisuse(ast)) problem(node, CHROMEUTILS);
  problems.sort((a, b) => lineNumber(a) - lineNumber(b));
  return { edges, problems, handOns: handOnsOf(ast, file, watched), names };
}

/** The line number in a `file:line: message` problem. */
const lineNumber = (problem: string) => Number(/:(\d+): /.exec(problem)?.[1] ?? 0);

/**
 * Every use of `ChromeUtils` other than `ChromeUtils.<name>`: as a value, an argument, a spread,
 * a destructuring source, an `in` operand, a computed member, or a name a module declares. Only
 * the direct form lets the check see which function runs, and so which loader.
 */
function chromeUtilsMisuse(ast: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const visit = (node: AstNode, parent: AstNode | null, key: string): void => {
    if (node.type === "Identifier" && node["name"] === "ChromeUtils") {
      const named =
        parent !== null &&
        ((parent.type === "MemberExpression" && key === "property" && !parent["computed"]) ||
          (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type) &&
            key === "key" &&
            !parent["computed"]));
      const direct = parent?.type === "MemberExpression" && key === "object" && !parent["computed"];
      if (!named && !direct) out.push(node);
      return;
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child, node, k);
      } else if (isNode(value)) visit(value, node, k);
    }
  };
  visit(ast, null, "");
  return out;
}

/** The restricted modules, whose hand-ons a scan looks for. */
const WATCHED: ReadonlySet<string> = new Set(Object.keys(RESTRICTED));

/**
 * What a local name holds of a restricted module: its export (the gate itself), its namespace
 * (`import * as`, the result of importESModule), or a lazy getter object some of whose keys
 * load it (defineESModuleGetters), each key with the module it loads.
 */
type Hold =
  | { kind: "value"; to: string }
  | { kind: "ns"; to: string }
  | { kind: "lazy"; keys: Map<string, string> };

/** The name of a non-computed key, or of a computed one that is a fixed string; else null. */
function keyName(node: AstNode, computed: boolean): string | null {
  if (!computed && node.type === "Identifier") return String(node["name"]);
  if (node.type === "Literal") return String(node["value"]);
  return computed ? fixedString(node) : null;
}

/** Node keys whose identifiers are names being bound, not read. */
const BINDING_KEYS: Record<string, string[]> = {
  VariableDeclarator: ["id"],
  FunctionDeclaration: ["id", "params"],
  FunctionExpression: ["id", "params"],
  ArrowFunctionExpression: ["params"],
  ClassDeclaration: ["id"],
  ClassExpression: ["id"],
  CatchClause: ["param"],
  AssignmentExpression: ["left"],
};

/**
 * Every hand-on of a restricted module (Scan.handOns). Each name that holds the module, or its
 * namespace, or a lazy getter object that loads it, is followed through local aliases (by name,
 * across the whole module: a shadowing name only adds errors, it never hides one). Each read of
 * such a name must be a call of one of its members (`AgentGate.request(…)`), a member read
 * (`AgentGate.waiting`: allowed when it is a getter, restrictedErrors decides), a local alias
 * (a declaration, or an assignment to a declared name), or the lazy object passed to Firefox's
 * own ChromeUtils.defineESModuleGetters or defineLazyGetter. Anything else lets it out: an
 * export, a return, an argument, an element, a field, a property, a store, also on an
 * undeclared name; and so does one name given two different holds. A function
 * that calls the module is a caller, not a hand-on: what it does for its own caller is the
 * security review's to judge.
 */
/**
 * Scopes as the language defines them: for each name read or written, the reference that says
 * which declaration, if any, it resolves to. A name no scope declares is a property of the
 * shared global.
 */
function scopeRefs(ast: AstNode, file: string): Map<unknown, Reference> {
  const scopes = analyze(ast as unknown as Parameters<typeof analyze>[0], {
    ecmaVersion: 2022,
    sourceType: file.endsWith(".js") ? "script" : "module",
  });
  const refs = new Map<unknown, Reference>();
  for (const scope of scopes.scopes)
    for (const ref of scope.references) refs.set(ref.identifier, ref);
  return refs;
}

/** The fixed string a name holds when its one declaration is a `const` with one; else null. */
function constString(id: AstNode, refs: Map<unknown, Reference>): string | null {
  const variable = refs.get(id)?.resolved;
  const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (def?.type !== "Variable" || (def.parent as { kind?: string } | null)?.kind !== "const")
    return null;
  const init = (def.node as unknown as AstNode)["init"];
  return isNode(init) ? fixedString(init) : null;
}

function handOnsOf(ast: AstNode, file: string, watched: ReadonlySet<string>): HandOn[] {
  const out: HandOn[] = [];
  if (!watched.size) return out;
  const refs = scopeRefs(ast, file);
  /** Whether a name, read or written here, resolves to a declaration in scope. */
  const local = (id: AstNode) => Boolean(refs.get(id)?.resolved);
  /**
   * Whether a name is a fresh object of this module's own: one `const X = {}` or
   * `const X = Object.create(null)`, the only form a lazy getter object takes.
   */
  const ownObject = (id: AstNode) => {
    const variable = refs.get(id)?.resolved;
    const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
    if (def?.type !== "Variable" || (def.parent as { kind?: string } | null)?.kind !== "const")
      return false;
    const init = (def.node as unknown as AstNode)["init"];
    if (!isNode(init)) return false;
    if (init.type === "ObjectExpression")
      return ((init["properties"] as unknown[]) ?? []).length === 0;
    const callee = init["callee"];
    const args = (init["arguments"] as unknown[]) ?? [];
    return (
      init.type === "CallExpression" &&
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      isNode(callee["object"]) &&
      callee["object"]["name"] === "Object" &&
      isNode(callee["property"]) &&
      callee["property"]["name"] === "create" &&
      args.length === 1 &&
      isNode(args[0]) &&
      args[0].type === "Literal" &&
      args[0]["value"] === null
    );
  };
  const add = (node: AstNode, to: string, how: string, member?: string) =>
    out.push({
      from: file,
      to,
      line: node.loc?.start.line ?? 0,
      how,
      ...(member === undefined ? {} : { member }),
    });
  /** The restricted module a fixed specifier names, or null. */
  const target = (node: unknown, relative: boolean): string | null => {
    const spec = isNode(node) ? fixedString(node) : null;
    const r = spec === null ? null : resolveSpec(spec, file, relative);
    return typeof r === "object" && r !== null && watched.has(r.to) ? r.to : null;
  };

  // Every node with its parent, and every identifier that is read rather than bound.
  const parents = new Map<AstNode, AstNode>();
  const reads = new Set<AstNode>();
  const nodes: AstNode[] = [];
  const visit = (node: AstNode, parent: AstNode | null, binding: boolean): void => {
    if (parent) parents.set(node, parent);
    nodes.push(node);
    if (node.type === "Identifier") {
      if (!binding) reads.add(node);
      return;
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      // Names that are not references: a member's or a key's name, an import's or an export's
      // outer name, a label.
      if (k === "property" && node.type === "MemberExpression" && !node["computed"]) continue;
      if (
        k === "key" &&
        !node["computed"] &&
        ["Property", "MethodDefinition", "PropertyDefinition"].includes(node.type)
      )
        continue;
      if (k === "label" || k === "meta") continue;
      if (node.type.startsWith("Import") && node.type !== "ImportExpression" && k !== "source")
        continue;
      if (node.type === "ExportSpecifier" && k === "exported") continue;
      // `export { X } from "…"` names the other module's X, not a local one.
      if (node.type === "ExportNamedDeclaration" && k === "specifiers" && node["source"]) continue;
      // A member on the left of an assignment is read, not bound: `AgentGate.request = f`.
      let bind = node.type === "MemberExpression" ? false : binding;
      if (BINDING_KEYS[node.type]?.includes(k)) bind = true;
      // A default value or a computed key inside a pattern is an expression again.
      if (node.type === "AssignmentPattern" && k === "right") bind = false;
      if (node.type === "Property" && k === "key") bind = false;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child, node, bind);
      } else if (isNode(value)) visit(value, node, bind);
    }
  };
  visit(ast, null, false);

  /** The parent of an expression, past a ChainExpression around it. */
  const up = (node: AstNode): { expr: AstNode; parent: AstNode | undefined } => {
    let expr = node;
    let parent = parents.get(expr);
    while (parent?.type === "ChainExpression") {
      expr = parent;
      parent = parents.get(expr);
    }
    return { expr, parent };
  };
  const isImportESModule = (node: AstNode) => {
    const callee = node["callee"];
    return (
      node.type === "CallExpression" &&
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      isNode(callee["property"]) &&
      callee["property"]["name"] === "importESModule"
    );
  };
  /** Firefox's ChromeUtils call that defines getters on its first argument. */
  const isDefine = (node: AstNode | undefined) => {
    const callee = node?.["callee"];
    if (node?.type !== "CallExpression" || !isNode(callee) || callee.type !== "MemberExpression")
      return false;
    const object = callee["object"];
    const property = callee["property"];
    // Firefox's own ChromeUtils only: a module may not declare one of its own.
    return (
      isNode(object) &&
      object.type === "Identifier" &&
      object["name"] === "ChromeUtils" &&
      !local(object) &&
      !callee["computed"] &&
      isNode(property) &&
      ["defineESModuleGetters", "defineLazyGetter"].includes(String(property["name"]))
    );
  };

  // A lazy getter object must be a name the module declares, since globalThis and other
  // outside objects are shared with every system module.

  // The names that hold a restricted module, then their aliases until nothing changes.
  const holders = new Map<string, Hold>();
  /** Names given a second, different hold, with where: a use cannot be read against both. */
  const conflicts = new Map<string, { at: AstNode; to: string }>();
  const hold = (name: string, h: Hold, at: AstNode) => {
    const had = holders.get(name);
    if (h.kind === "lazy" && had?.kind === "lazy") {
      const before = had.keys.size;
      for (const [k, v] of h.keys) had.keys.set(k, v);
      return had.keys.size !== before;
    }
    if (had) {
      const same =
        had.kind !== "lazy" && h.kind !== "lazy" && had.kind === h.kind && had.to === h.to;
      if (!same && !conflicts.has(name))
        conflicts.set(name, { at, to: h.kind === "lazy" ? ([...h.keys.values()][0] ?? "") : h.to });
      return false;
    }
    holders.set(name, h);
    return true;
  };
  for (const node of nodes) {
    if (node.type === "ImportDeclaration") {
      const to = target(node["source"], true);
      if (to)
        for (const sp of (node["specifiers"] as unknown[]) ?? [])
          if (isNode(sp) && isNode(sp["local"]))
            hold(
              String(sp["local"]["name"]),
              {
                kind: sp.type === "ImportNamespaceSpecifier" ? "ns" : "value",
                to,
              },
              sp,
            );
    } else if (
      node.type === "CallExpression" &&
      isNode(node["callee"]) &&
      isNode(node["callee"]["property"]) &&
      node["callee"]["property"]["name"] === "defineESModuleGetters"
    ) {
      const [on, map] = (node["arguments"] as unknown[]) ?? [];
      if (!isNode(map) || map.type !== "ObjectExpression") continue;
      const keys = new Map<string, string>();
      for (const prop of (map["properties"] as unknown[]) ?? []) {
        if (!isNode(prop) || !isNode(prop["value"])) continue;
        const to = target(prop["value"], false);
        if (!to) continue;
        const key = isNode(prop["key"]) ? keyName(prop["key"], Boolean(prop["computed"])) : null;
        if (key === null) add(prop, to, "hands on");
        else keys.set(key, to);
      }
      if (!keys.size) continue;
      if (isNode(on) && on.type === "Identifier" && ownObject(on))
        hold(String(on["name"]), { kind: "lazy", keys }, node);
      else
        for (const to of new Set(keys.values()))
          add(node, to, "defines a getter outside a fresh `const X = {}` of the module's own for");
    }
  }

  /** What an expression holds of a restricted module, or null. */
  const holdOf = (node: AstNode): Hold | null => {
    if (node.type === "Identifier") return holders.get(String(node["name"])) ?? null;
    if (node.type === "ChainExpression" && isNode(node["expression"]))
      return holdOf(node["expression"]);
    if (isImportESModule(node)) {
      const to = target(((node["arguments"] as unknown[]) ?? [])[0], false);
      return to ? { kind: "ns", to } : null;
    }
    // An assignment's value is its right side: `(gate ??= …)` is the gate.
    if (
      node.type === "AssignmentExpression" &&
      ["=", "||=", "&&=", "??="].includes(String(node["operator"])) &&
      isNode(node["right"])
    )
      return holdOf(node["right"]);
    if (node.type === "AwaitExpression" && isNode(node["argument"])) {
      const arg = node["argument"];
      const to = arg.type === "ImportExpression" ? target(arg["source"], true) : null;
      return to ? { kind: "ns", to } : null;
    }
    if (node.type === "MemberExpression" && isNode(node["object"]) && isNode(node["property"])) {
      const outer = holdOf(node["object"]);
      if (!outer || outer.kind === "value") return null;
      if (outer.kind === "ns") return { kind: "value", to: outer.to };
      const key = keyName(node["property"], Boolean(node["computed"]));
      // A computed key the check cannot read may be any of the object's getters.
      const to = key === null ? [...outer.keys.values()][0] : outer.keys.get(key);
      return to ? { kind: "value", to } : null;
    }
    return null;
  };
  /** The names a pattern binds from a value that holds `h`. */
  const bindPattern = (pattern: AstNode, h: Hold, at: AstNode): boolean => {
    if (pattern.type === "Identifier") return hold(String(pattern["name"]), h, at);
    if (pattern.type !== "ObjectPattern" || h.kind === "value") return false;
    let changed = false;
    for (const prop of (pattern["properties"] as unknown[]) ?? []) {
      if (!isNode(prop)) continue;
      if (prop.type === "RestElement" && isNode(prop["argument"])) {
        changed = bindPattern(prop["argument"], h, at) || changed;
        continue;
      }
      const value = prop["value"];
      if (!isNode(value) || !isNode(prop["key"])) continue;
      const key = keyName(prop["key"], Boolean(prop["computed"]));
      // A computed key the check cannot read may be any of the lazy object's getters.
      const to = h.kind === "ns" ? h.to : key === null ? [...h.keys.values()][0] : h.keys.get(key);
      const inner = value.type === "AssignmentPattern" ? value["left"] : value;
      if (to && isNode(inner)) changed = bindPattern(inner, { kind: "value", to }, at) || changed;
    }
    return changed;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      const init = node.type === "VariableDeclarator" ? node["init"] : node["right"];
      const id = node.type === "VariableDeclarator" ? node["id"] : node["left"];
      if (
        (node.type === "VariableDeclarator" || node.type === "AssignmentExpression") &&
        isNode(init) &&
        isNode(id)
      ) {
        // An assignment makes an alias only of a name the module declares; any other is a
        // store on the shared global (`vimmaLeak = AgentGate`), which check() reports.
        const alias = node.type === "VariableDeclarator" || (id.type === "Identifier" && local(id));
        const h = alias ? holdOf(init) : null;
        if (h) changed = bindPattern(id, h, node) || changed;
      }
    }
  }
  for (const { at, to } of conflicts.values())
    add(at, to, "gives a name a second, different hold of");

  const toOf = (h: Hold) => (h.kind === "lazy" ? [...new Set(h.keys.values())] : [h.to]);
  /**
   * Checks a destructuring pattern that takes apart a value holding `h`, at any depth: under
   * the gate itself each key is a member read (a getter passes, a method fails); under its
   * namespace or a lazy object each key that may be the gate is checked again; a name is an
   * alias, whose own uses are checked; any other pattern lets it out.
   */
  const checkPattern = (pattern: AstNode, h: Hold): void => {
    if (pattern.type === "Identifier") return;
    if (pattern.type === "AssignmentPattern" && isNode(pattern["left"]))
      return checkPattern(pattern["left"], h);
    if (pattern.type !== "ObjectPattern") {
      for (const to of toOf(h)) add(pattern, to, "hands on");
      return;
    }
    for (const prop of (pattern["properties"] as unknown[]) ?? []) {
      if (!isNode(prop)) continue;
      if (prop.type === "RestElement") {
        if (h.kind === "value") add(prop, h.to, "hands on");
        continue;
      }
      const key = isNode(prop["key"]) ? keyName(prop["key"], Boolean(prop["computed"])) : null;
      const value = prop["value"];
      if (h.kind === "value") {
        if (key === null) add(prop, h.to, "takes a member, uncalled, of", "");
        else add(prop, h.to, `takes the method ${key}, uncalled, of`, key);
        continue;
      }
      const to = h.kind === "ns" ? h.to : key === null ? [...h.keys.values()][0] : h.keys.get(key);
      if (to && isNode(value)) checkPattern(value, { kind: "value", to });
    }
  };
  /** Checks where an expression that holds `h` goes (see the function's comment). */
  const check = (node: AstNode, h: Hold): void => {
    const { expr, parent } = up(node);
    if (!parent) return;
    if (parent.type === "MemberExpression" && parent["object"] === expr) {
      if (h.kind !== "value") {
        const inner = holdOf(parent);
        if (inner) check(parent, inner);
        return;
      }
      const call = up(parent).parent;
      const called =
        (call?.type === "CallExpression" || call?.type === "NewExpression") &&
        call["callee"] === up(parent).expr;
      if (called) return;
      const property = parent["property"];
      const key = isNode(property) ? keyName(property, Boolean(parent["computed"])) : null;
      const { expr: member, parent: user } = up(parent);
      if (
        (user?.type === "AssignmentExpression" && user["left"] === member) ||
        user?.type === "UpdateExpression" ||
        (user?.type === "UnaryExpression" && user["operator"] === "delete")
      ) {
        add(parent, h.to, `changes the member ${key ?? "(computed)"} of`);
        return;
      }
      add(
        parent,
        h.to,
        key ? `takes the method ${key}, uncalled, of` : "takes a member, uncalled, of",
        key ?? "",
      );
      return;
    }
    if (
      (parent.type === "CallExpression" || parent.type === "NewExpression") &&
      parent["callee"] === expr
    )
      return;
    if (parent.type === "VariableDeclarator" && parent["init"] === expr && isNode(parent["id"])) {
      checkPattern(parent["id"], h);
      return;
    }
    if (
      parent.type === "AssignmentExpression" &&
      parent["right"] === expr &&
      isNode(parent["left"]) &&
      parent["left"].type === "Identifier" &&
      local(parent["left"])
    ) {
      // The alias is fine; the assignment's own value goes on, unless it is thrown away.
      const { expr: assignment, parent: user } = up(parent);
      const list = user?.type === "SequenceExpression" ? (user["expressions"] as unknown[]) : [];
      const discarded =
        user?.type === "ExpressionStatement" ||
        (user?.type === "ForStatement" && user["update"] === assignment) ||
        (list.length > 0 && list[list.length - 1] !== assignment);
      if (!discarded) check(assignment, h);
      return;
    }
    if (
      h.kind === "lazy" &&
      isDefine(parent) &&
      ((parent["arguments"] as unknown[]) ?? [])[0] === expr
    )
      return;
    const passed =
      h.kind === "lazy" &&
      (parent.type === "CallExpression" || parent.type === "NewExpression") &&
      ((parent["arguments"] as unknown[]) ?? []).includes(expr);
    const how =
      parent.type === "ExportSpecifier" || parent.type === "ExportDefaultDeclaration"
        ? "re-exports"
        : passed
          ? "passes to another function (keep other getters on a second lazy object) the lazy object of"
          : "hands on";
    for (const to of toOf(h)) add(expr, to, how);
  };

  for (const node of nodes) {
    if (node.type === "Identifier" && !reads.has(node)) continue;
    if (node.type === "ImportExpression") {
      const to = target(node["source"], true);
      if (!to) continue;
      const { expr, parent } = up(node);
      if (parent?.type === "AwaitExpression") check(parent, { kind: "ns", to });
      else add(expr, to, "hands on");
      continue;
    }
    if (node.type !== "Identifier" && !isImportESModule(node)) continue;
    const h = holdOf(node);
    if (h) check(node, h);
  }

  // An export … from a restricted module, and an exported name that holds one.
  for (const node of (ast["body"] as unknown[]) ?? []) {
    if (!isNode(node)) continue;
    if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;
    const from = target(node["source"], true);
    if (from) {
      add(node, from, "re-exports");
      continue;
    }
    const declaration = node["declaration"];
    if (!isNode(declaration)) continue;
    const names: string[] = [];
    const collect = (n: unknown): void => {
      if (!isNode(n)) return;
      if (n.type === "Identifier") names.push(String(n["name"]));
      else if (n.type === "ObjectPattern")
        for (const p of (n["properties"] as unknown[]) ?? [])
          collect(isNode(p) ? (p.type === "RestElement" ? p["argument"] : p["value"]) : null);
      else if (n.type === "ArrayPattern")
        for (const e of (n["elements"] as unknown[]) ?? []) collect(e);
      else if (n.type === "AssignmentPattern") collect(n["left"]);
      else if (n.type === "RestElement") collect(n["argument"]);
    };
    if (declaration.type === "VariableDeclaration")
      for (const d of (declaration["declarations"] as unknown[]) ?? [])
        collect(isNode(d) ? d["id"] : null);
    else collect(declaration["id"]);
    for (const name of names) {
      const h = holders.get(name);
      if (h) for (const to of toOf(h)) add(node, to, "re-exports");
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The getters of a module's exported object literals (`export const G = { get waiting() … }`):
 * restrictedErrors lets a holder of the module read one of them without a call. What a getter
 * returns is not followed (ADR-026, "Limits of the check").
 * @param source  the restricted module's text
 * @param file  its path relative to vimma/
 */
export function getterNames(source: string, file: string): Set<string> {
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: file.endsWith(".js") ? "script" : "module",
  }) as unknown as AstNode;
  const names = new Set<string>();
  for (const node of (ast["body"] as unknown[]) ?? []) {
    const declaration =
      isNode(node) && node.type === "ExportNamedDeclaration" ? node["declaration"] : null;
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue;
    for (const d of (declaration["declarations"] as unknown[]) ?? []) {
      const init = isNode(d) ? d["init"] : null;
      if (!isNode(init) || init.type !== "ObjectExpression") continue;
      for (const prop of (init["properties"] as unknown[]) ?? [])
        if (isNode(prop) && prop["kind"] === "get" && isNode(prop["key"])) {
          const key = keyName(prop["key"], Boolean(prop["computed"]));
          if (key !== null) names.add(key);
        }
    }
  }
  return names;
}

/**
 * Every edge from one module to another Vimma module, in source order: `scanModule` without
 * its problems. tools/diagrams draws the module graph from it, so the picture and this check
 * read the same edges.
 */
export function importsOf(source: string, file: string): Edge[] {
  return scanModule(source, file).edges;
}

/** A page's character references decoded: `vimm&#97;` is `vimma` to the parser. */
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);?/gi, (_, ref: string) => {
    const r = ref.toLowerCase();
    if (r.startsWith("#"))
      return codePoint(r.startsWith("#x") ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10));
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[r] ?? "";
  });

/** A character by its code, U+FFFD for none or one past U+10FFFF, as a parser reads it. */
const codePoint = (code: number) =>
  String.fromCodePoint(Number.isFinite(code) && code > 0 && code <= 0x10ffff ? code : 0xfffd);

/** The five named references a page may use; the check refuses any other (ENTITY). */
const NAMED = new Set(["amp", "quot", "apos", "lt", "gt"]);
const ENTITY =
  "a page may use only the character references &amp; &quot; &apos; &lt; &gt; and numeric ones, which the check decodes";
const INLINE = "an inline <script> is not read; load the code from a module file";
const RISKY =
  "an on… event attribute, srcdoc or <base> changes what a page runs or loads in a way the check does not read";

/** The elements Vimma's pages use today; any other fails (PAGE). */
const PAGE_TAGS = new Set(
  "a body button code div dl footer h1 h2 head header hr html input kbd label li link main meta p pre script section span title ul".split(
    " ",
  ),
);
/** The Content-Security-Policy values the pages carry today (about.html adds connect-src). */
const PAGE_CSPS = new Set([
  "default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; img-src chrome:; object-src 'none'",
  "default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; connect-src chrome:; img-src chrome:; object-src 'none'",
]);
/** The stylesheets the pages link today. */
const PAGE_STYLESHEETS = new Set(
  ["logo", "about", "setup", "start"].map((n) => `chrome://browser/skin/vimma/${n}.css`),
);
/** Attributes that make an element load a URL. */
const URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "data",
  "action",
  "formaction",
  "srcset",
  "poster",
  "background",
  "xlink:href",
]);

/**
 * The modules a page under vimma/ loads (`<script type="module" src>`), as eager edges, the
 * lines that name a restricted module's file (Scan.names), and every part of the page outside
 * the allow-lists of what the pages use today: the elements (PAGE_TAGS); a script only
 * `type="module"` with the `src` of a Vimma module the check reads, and no inline code; a link
 * only to one of today's stylesheets; a meta only a charset, the colour scheme or one of
 * today's Content-Security-Policy values, which a page with a script must carry; an `<a href>`
 * only to an about: page or a fragment; no other element with a URL attribute; no `on…`
 * attribute or `srcdoc`; no named character reference but the five. The page is read whole, as
 * its parser reads it (a value across lines is one URL), and every search moves forward only,
 * so a page is read in linear time.
 * @param html  the page's text
 * @param file  its path relative to vimma/
 */
export function htmlImports(
  html: string,
  file: string,
  watched: ReadonlySet<string> = WATCHED,
): Scan {
  const edges: Edge[] = [];
  const found = new Set<string>();
  const problems: string[] = [];
  const names: Mention[] = [];
  const starts = [0];
  for (let i = html.indexOf("\n"); i >= 0; i = html.indexOf("\n", i + 1)) starts.push(i + 1);
  /** The line of an offset in the page. */
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const problem = (offset: number, message: string) => {
    const text = `${file}:${lineAt(offset)}: ${message}`;
    if (!found.has(text)) {
      found.add(text);
      problems.push(text);
    }
  };
  const page = (offset: number, detail: string) => problem(offset, `${detail}; ${WIDEN}`);
  for (const m of html.matchAll(/&([a-z][a-z0-9]*)/gi))
    if (!NAMED.has((m[1] ?? "").toLowerCase())) problem(m.index, ENTITY);

  // The file-name rule reads the whole page, `%` escapes and references decoded.
  const bases = [...watched].map((m) => [m, lettersOnly(posix.basename(m))] as const);
  html.split("\n").forEach((raw, i) => {
    const letters = lettersOnly(unescape(decodeEntities(raw)));
    for (const [to, base] of bases)
      if (letters.includes(base)) names.push({ from: file, to, line: i + 1 });
  });
  const whole = lettersOnly(unescape(decodeEntities(html)));
  for (const [to, base] of bases)
    if (whole.includes(base) && !names.some((n) => n.to === to))
      names.push({ from: file, to, line: 1 });

  // Tags, each with its attributes, read by hand: each step moves forward, and an unclosed
  // quote ends the page instead of being searched again from every later attribute.
  /** Where each Content-Security-Policy meta and the first script or stylesheet stand. */
  const policies: number[] = [];
  let firstLoad = -1;
  for (let lt = html.indexOf("<"); lt >= 0; lt = html.indexOf("<", lt + 1)) {
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(lt + 1, lt + 65))?.[0]?.toLowerCase();
    if (!tag) continue;
    const attrs = new Map<string, string>();
    let pos = lt + 1 + tag.length;
    let ended = false;
    while (pos < html.length) {
      while (pos < html.length && /[\s/]/.test(html[pos] ?? "")) pos++;
      if (pos >= html.length || html[pos] === ">") break;
      let end = pos;
      while (end < html.length && !/[\s/>=]/.test(html[end] ?? "")) end++;
      const name = html.slice(pos, end).toLowerCase();
      pos = end;
      while (pos < html.length && /\s/.test(html[pos] ?? "")) pos++;
      let value = "";
      if (html[pos] === "=") {
        pos++;
        while (pos < html.length && /\s/.test(html[pos] ?? "")) pos++;
        const quote = html[pos];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, pos + 1);
          value = html.slice(pos + 1, close < 0 ? html.length : close);
          if (close < 0) ended = true;
          pos = close < 0 ? html.length : close + 1;
        } else {
          let stop = pos;
          while (stop < html.length && !/[\s>]/.test(html[stop] ?? "")) stop++;
          value = html.slice(pos, stop);
          pos = stop;
        }
      }
      // The parser keeps the first copy of an attribute; the check refuses a second.
      if (name && attrs.has(name)) page(lt, `<${tag}> repeats the attribute ${name}`);
      else if (name) attrs.set(name, clean(decodeEntities(value)));
    }
    for (const name of attrs.keys()) if (/^on/.test(name) || name === "srcdoc") problem(lt, RISKY);
    if (tag === "base") problem(lt, RISKY);
    if (!PAGE_TAGS.has(tag)) page(lt, `<${tag}> is not an element the pages use today`);
    else if (tag === "script") {
      if (firstLoad < 0) firstLoad = lt;
      const src = attrs.get("src") ?? "";
      const r = resolveSpec(src, file, true);
      const keys = [...attrs.keys()].sort().join(" ");
      if (r === "alias") problem(lt, ALIAS);
      else if (
        keys === "src type" &&
        attrs.get("type") === "module" &&
        typeof r === "object" &&
        r !== null &&
        /\.m?js$/.test(r.to)
      )
        edges.push({ from: file, to: r.to, kind: "eager", line: lineAt(lt) });
      else page(lt, `<script> takes only type="module" and the src of a Vimma module`);
    } else if (tag === "link") {
      if (firstLoad < 0) firstLoad = lt;
      const keys = [...attrs.keys()].sort().join(" ");
      if (
        keys !== "href rel" ||
        attrs.get("rel") !== "stylesheet" ||
        !PAGE_STYLESHEETS.has(attrs.get("href") ?? "")
      )
        page(lt, `<link> takes only rel="stylesheet" and a stylesheet the pages use today`);
    } else if (tag === "meta") {
      const keys = [...attrs.keys()].sort().join(" ");
      const ok =
        (keys === "charset" && attrs.get("charset") === "utf-8") ||
        (keys === "content name" &&
          attrs.get("name") === "color-scheme" &&
          attrs.get("content") === "dark light") ||
        (keys === "content http-equiv" &&
          attrs.get("http-equiv") === "Content-Security-Policy" &&
          PAGE_CSPS.has(attrs.get("content") ?? ""));
      if (keys === "content http-equiv") policies.push(lt);
      if (!ok)
        page(
          lt,
          "<meta> is none of the forms the pages use today (a charset, the colour scheme, or one of today's Content-Security-Policy values)",
        );
    } else if (tag === "a") {
      const href = attrs.get("href");
      if (href !== undefined && !/^(about:|#)/.test(href))
        page(lt, "<a href> may name only an about: page or a fragment");
    } else {
      const loads = [...attrs.keys()].find((a) => URL_ATTRIBUTES.has(a));
      if (loads) page(lt, `<${tag}> may not load a URL (${loads})`);
    }
    if (ended) break;
    lt = Math.max(lt, pos - 1);
  }
  // A meta policy governs only what loads after it.
  // A meta policy governs only what loads after it, and Firefox applies one only in the head
  // (HTMLMetaElement): before `</head>` and before `<body>`.
  const lowered = html.toLowerCase();
  const heads = [lowered.indexOf("</head"), lowered.indexOf("<body")].filter((i) => i >= 0);
  const headEnd = heads.length ? Math.min(...heads) : html.length;
  const policy = policies[0] ?? 0;
  if (firstLoad >= 0 && (policies.length !== 1 || policy > firstLoad || policy > headEnd))
    page(
      0,
      "a page with a script or a stylesheet carries exactly one of today's Content-Security-Policy values, in its head, before the first of them",
    );

  const lower = html.toLowerCase();
  // Inline scripts: each search starts where the last one ended.
  for (let at = lower.indexOf("<script"); at >= 0;) {
    if (!/[\s>/]/.test(lower[at + 7] ?? "")) {
      at = lower.indexOf("<script", at + 7);
      continue;
    }
    const open = lower.indexOf(">", at);
    if (open < 0) break;
    const close = lower.indexOf("</script", open);
    const body = html.slice(open + 1, close < 0 ? html.length : close);
    if (body.trim()) problem(at, INLINE);
    if (close < 0) break;
    at = lower.indexOf("<script", close + 8);
  }
  problems.sort((a, b) => lineNumber(a) - lineNumber(b));
  return { edges, problems, names };
}

/**
 * Where jar.mn packages a module somewhere other than its source path. The check reads a
 * module's folder from its chrome:// URL, which is right only while the two agree.
 * @param jar  jar.mn's text
 */
export function jarErrors(jar: string): string[] {
  const errors: string[] = [];
  /** A file that runs code: a module, a script or a page. */
  const runs = (path: string) => /\.(m?js|x?html?)$/i.test(path);
  const LINE = (n: number) =>
    `jar.mn:${n}: not one of the line forms jar.mn has today (a "# " comment, the browser.jar: header, an entry, an .svg override); ${WIDEN}`;
  let headers = 0;
  jar.split("\n").forEach((text, i) => {
    const n = i + 1;
    // jar_maker runs the preprocessor first: `#include`, `#ifdef`, `#filter` and the like are
    // directives, so a comment is `#` and a space, or `#` alone.
    if (text.trim() === "" || /^#( .*)?$/.test(text)) return;
    if (text === "browser.jar:") {
      if (++headers > 1) errors.push(LINE(n));
      return;
    }
    // A manifest line could override a module's or a page's URL with another file, or map a
    // new chrome or resource root onto Vimma's files: either loads code the check never reads,
    // or a second copy. Only what the tree has may stand: one .svg image over another, both
    // outside Vimma's content.
    const manifest = /^%\s*(\S+)\s*(.*)$/.exec(text);
    if (manifest) {
      const [, directive = "", rest = ""] = manifest;
      const urls = rest.split(/\s+/).filter(Boolean);
      const image = (url: string) => {
        const canon = canonical(url);
        return (
          /\.svg$/i.test(canon) && vimmaPath(canon) === null && !/content\/vimma(\/|$)/i.test(canon)
        );
      };
      if (directive !== "override" || urls.length !== 2 || !urls.every(image))
        errors.push(
          `jar.mn:${n}: a manifest line here may only override one .svg image with another, outside content/vimma/: no line may swap, re-root or register a Vimma module; ${WIDEN}`,
        );
      return;
    }
    // A preprocessed line packages a file the preprocessor rewrites first.
    if (/^\s*\*/.test(text)) {
      errors.push(
        `jar.mn:${n}: a preprocessed (*) line is not read by the check; package Vimma's files as they are; ${WIDEN}`,
      );
      return;
    }
    const line = /^ +(\S+) +\((\S+)\)$/.exec(text);
    if (!headers || !line) {
      errors.push(LINE(n));
      return;
    }
    const [, target = "", from = ""] = line;
    // `content/browser/vimma/../evil/e.mjs (../evil/e.mjs)` would look like its own path.
    if ([target, from].some((p) => p.split("/").some((seg) => seg === "." || seg === ".."))) {
      errors.push(
        `jar.mn:${n}: a "." or ".." segment in a jar.mn path can package a file from outside vimma/; ${WIDEN}`,
      );
      return;
    }
    const inside = target.startsWith("content/browser/vimma/");
    const url = inside ? target.slice("content/browser/vimma/".length) : "";
    const moved = from.includes("*")
      ? !inside || !from.startsWith(`${url}/`)
      : inside && /\.m?js$/.test(url) && from !== url;
    // A file of vimma/ (a relative source) or anything that runs is packaged only as itself.
    const misplaced =
      !from.includes("*") &&
      (runs(target) || runs(from) || !from.startsWith("/")) &&
      (!inside || from !== url);
    if (moved && inside)
      errors.push(
        `jar.mn:${n}: content/browser/vimma/${url} is packaged from ${from}; a module's URL must be its source path`,
      );
    else if (moved || misplaced)
      errors.push(
        `jar.mn:${n}: a script or page may be packaged only from vimma/, under its own path in content/browser/vimma/; ${WIDEN}`,
      );
    else if (!inside && !target.startsWith("skin/classic/browser/vimma/")) errors.push(LINE(n));
  });
  return errors;
}

/**
 * The modules jar.mn packages, by their path under vimma/. A wildcard line (core/**) adds none:
 * the folders it packages are not checked by name.
 * @param jar  jar.mn's text
 */
export function jarModules(jar: string): Set<string> {
  const modules = new Set<string>();
  for (const text of jar.split("\n")) {
    const m = /^\s*content\/browser\/vimma\/(\S+)\s+\((\S+)\)/.exec(text);
    if (m && !m[2]?.includes("*") && m[1]) modules.add(m[1]);
  }
  return modules;
}

/**
 * Edges to a module that does not exist: one git does not track, or one jar.mn does not package,
 * so a mistyped URL fails here instead of at run time (a missing parent actor drops every page
 * report without an error in a release). core/ is skipped (a git-ignored copy sync-core makes,
 * packaged by a wildcard), and so is a folder prefix, which names no file.
 * @param edges  every edge of the tree
 * @param tracked  the modules git tracks, relative to vimma/
 * @param packaged  the modules jar.mn packages (jarModules)
 */
export function danglingEdges(
  edges: Edge[],
  tracked: Set<string>,
  packaged: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const e of edges) {
    if (e.to.endsWith("/") || folderOf(e.to) === "core") continue;
    if (!tracked.has(e.to))
      errors.push(
        `${e.from}:${e.line}: names ${e.to}, which is not a module git tracks under vimma/`,
      );
    else if (!packaged.has(e.to))
      errors.push(`${e.from}:${e.line}: names ${e.to}, which jar.mn does not package`);
  }
  return errors;
}

/**
 * Every listed exception: the last one went with #936, and ADR-026 (decision 5) admits no new
 * one. A higher folder is reached through a topic, a callback or an interface object instead.
 */
export function exceptionErrors(exceptions: Exception[]): string[] {
  return exceptions.map(
    (x) =>
      `exception ${key(x)}: ${ADR} allows no upward import; reach the higher folder through a topic, a callback or an interface object (decision 4)`,
  );
}

/**
 * Imports of a restricted module by a module its list does not hold, eager or lazy; listed
 * importers that no longer import it, so that the list stays exactly the callers reviewed; and
 * every place a module hands it on (Scan.handOns), but for reading a getter of it.
 * A module or page the list does not hold may not name the module's file in any string either
 * (Scan.names), once per line that is not already an import of it.
 * @param data  each restricted module's getters (getterNames), which a holder may read
 * @param names  the strings that name a restricted module's file (Scan.names)
 */
export function restrictedErrors(
  edges: Edge[],
  restricted: Record<string, Restricted>,
  handOns: HandOn[] = [],
  data: Record<string, ReadonlySet<string>> = {},
  names: Mention[] = [],
): string[] {
  const errors: string[] = [];
  for (const [module, { importers, review }] of Object.entries(restricted)) {
    const allowed = new Set(importers);
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.to !== module) continue;
      seen.add(e.from);
      if (!allowed.has(e.from))
        errors.push(
          `${e.from}:${e.line}: imports ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import: ${review}, then a line there`,
        );
    }
    for (const h of handOns) {
      if (h.to !== module) continue;
      if (h.member !== undefined && data[module]?.has(h.member)) continue;
      errors.push(
        `${h.from}:${h.line}: ${h.how} ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may hold and none may hand on: ${review}`,
      );
    }
    const imported = new Set(
      edges.filter((e) => e.to === module).map((e) => `${e.from}:${e.line}`),
    );
    const named = new Set<string>();
    for (const n of names) {
      const at = `${n.from}:${n.line}`;
      if (n.to !== module || n.from === module || named.has(at)) continue;
      if (allowed.has(n.from)) {
        // A listed module names it only to load it, by the URL of the one copy.
        if (n.exact) continue;
        named.add(at);
        errors.push(
          `${at}: names the file of ${module} other than by its exact chrome:// URL or a plain relative path: ${review}`,
        );
        continue;
      }
      if (imported.has(at)) continue;
      named.add(at);
      errors.push(
        `${at}: names the file of ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import: ${review}, then a line there`,
      );
    }
    for (const from of importers)
      if (!seen.has(from))
        errors.push(
          `stale importer: ${from} no longer imports ${module}; remove it from RESTRICTED in ${LAYERS_FILE}`,
        );
  }
  return errors;
}

/** The added lines of today's build-file patches that name Vimma's folder (patchErrors). */
const BUILD_LINES = new Set([
  '    "content/vimma",',
  '    "content/vimma/licence/list.html",',
  '    "content/vimma/licence/body.html",',
  '    "content/vimma/licence/product-name.html",',
]);

/**
 * A patch line as the code in it reads: JavaScript escapes (`\x47`, `\u0047`, `\u{47}`) and
 * character references decoded, and tabs and line breaks, escaped or not, dropped, as a URL
 * parser drops them.
 */
function decodeEscapes(line: string): string {
  return decodeEntities(line)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&[a-z][a-z0-9]*;/gi, "")
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a, b, c) =>
      codePoint(parseInt(String(a ?? b ?? c), 16)),
    )
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => codePoint(parseInt(octal, 8)))
    .replace(/\\[tnr]|[\t\r\n]/g, "")
    .replace(/\\/g, "");
}

/**
 * Firefox patches (the .patch files under src/) load Vimma modules by chrome:// URL from
 * Firefox's own files, which the module scan does not read; a patch is text in many languages,
 * so each added line is read as text. It fails when it names a restricted module, by any URL
 * that reaches its file (an escaped one, one with `..`, a resource:// one) or by its file name
 * alone (`base + "AgentGate.sys.mjs"`); no patch is on a restricted module's list. It fails too
 * when it holds a piece of a Vimma URL that names no file: a folder, or a URL cut short by `${`
 * or a closing quote (`"chrome://browser/content/" + …`), since a URL built from parts hides
 * which module it loads.
 */
export function patchErrors(
  patches: { file: string; text: string }[],
  restricted: Record<string, Restricted>,
): string[] {
  const errors: string[] = [];
  const files = Object.keys(restricted).map((m) => [m, lettersOnly(posix.basename(m))] as const);
  for (const { file, text } of patches) {
    /** The Firefox file the hunk changes, from its `+++ b/…` header. */
    let changed = "";
    text.split("\n").forEach((line, i) => {
      const header = /^\+\+\+ (?:b\/)?(\S+)/.exec(line);
      if (header) changed = header[1] ?? "";
      if (!line.startsWith("+") || line.startsWith("+++")) return;
      const named = new Set<string>();
      const pieces: string[] = [];
      const decoded = decodeEscapes(line);
      // A build file (moz.build, jar.mn, a manifest) that names Vimma's folder could package or
      // export its files under another URL; only the lines browser/base/moz.build adds today
      // may (the folder in DIRS, the licence pages in the about:license inputs).
      if (
        /(^|\/)(moz\.build|[^/]*\.mozbuild|[^/]*\.mn|[^/]*\.manifest)$/.test(changed) &&
        lettersOnly(decoded).includes("contentvimma") &&
        !(changed === "browser/base/moz.build" && BUILD_LINES.has(line.slice(1)))
      )
        errors.push(
          `${file}:${i + 1}: names Vimma's folder (content/vimma) in a build file; ${WIDEN}`,
        );
      // The lookbehind starts a scheme only at its first letter, so a long run of letters is
      // read once, not once per letter.
      for (const [url] of decoded.matchAll(
        /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`$,);]*/gi,
      )) {
        const canon = canonical(url);
        const v = vimmaPath(canon);
        const path = v && v.path !== "" ? posix.normalize(v.path) : (v?.path ?? null);
        if (path !== null && restricted[path]) named.add(path);
        else if (
          path !== null ? !/\.[a-z0-9]+$/i.test(path) : ROOTS.some((r) => r.startsWith(canon))
        )
          pieces.push(url);
      }
      if (
        /\bglobal\s*:/.test(decoded) &&
        [...decoded.matchAll(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`$,);]*/gi)].some(
          ([url]) => vimmaPath(canonical(url)) !== null,
        )
      )
        errors.push(`${file}:${i + 1}: ${OPTIONS}`);
      const lower = unescape(decoded).toLowerCase();
      const letters = lettersOnly(lower);
      for (const [module, base] of files) if (letters.includes(base)) named.add(module);
      if (/content\/browser\/vimma/i.test(lower))
        errors.push(
          `${file}:${i + 1}: maps or names Vimma's packaged files by their path (content/browser/vimma); only vimma/jar.mn packages them`,
        );
      for (const module of named)
        errors.push(
          `${file}:${i + 1}: names ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import, and a Firefox patch is none of them: ${restricted[module]?.review ?? ""}`,
        );
      for (const piece of pieces)
        errors.push(
          `${file}:${i + 1}: builds a Vimma URL from parts (${piece}); a Firefox patch names each Vimma module by its whole chrome:// URL, so that the check can read it`,
        );
    });
  }
  return errors;
}

/** The folder a path relative to vimma/ belongs to. */
export function folderOf(path: string): string {
  const slash = path.indexOf("/");
  return slash < 0 ? ROOT_FOLDER : path.slice(0, slash);
}

const key = (e: { from: string; to: string; kind: string }) => `${e.from} -> ${e.to} (${e.kind})`;

/**
 * What breaks the layering: imports of the same or a higher layer that no exception lists,
 * folders without a layer, and exceptions that are stale or give no reason.
 * @param edges  every edge of the tree
 * @param layers  each folder's layer, 0 at the bottom
 * @param exceptions  the upward imports that stay
 */
export function layerErrors(
  edges: Edge[],
  layers: Record<string, number>,
  exceptions: Exception[],
): string[] {
  const errors: string[] = [];
  const unranked = new Set<string>();
  const excepted = new Set(exceptions.map(key));
  const used = new Set<string>();
  const present = new Set<string>();
  for (const e of edges) {
    for (const path of [e.from, e.to]) {
      const folder = folderOf(path);
      if (layers[folder] === undefined && !unranked.has(folder)) {
        unranked.add(folder);
        errors.push(
          `${path}: the folder ${folder}/ has no layer: add it to LAYERS (${LAYERS_FILE}) and ${ADR}`,
        );
      }
    }
    present.add(key(e));
    const a = folderOf(e.from);
    const b = folderOf(e.to);
    const ra = layers[a];
    const rb = layers[b];
    if (a === b || ra === undefined || rb === undefined || rb < ra) continue;
    if (excepted.has(key(e))) {
      used.add(key(e));
      continue;
    }
    errors.push(
      `${e.from}:${e.line} imports ${e.to} (${e.kind}): ${a} (layer ${ra}) may not import ${b} (layer ${rb})`,
    );
  }
  for (const x of exceptions) {
    const k = key(x);
    if (!x.reason.trim()) errors.push(`exception ${k} gives no reason`);
    else if (!present.has(k))
      errors.push(`stale exception: ${k} is no longer imported; remove it from ${LAYERS_FILE}`);
    else if (!used.has(k))
      errors.push(`stale exception: ${k} is allowed by the layers; remove it from ${LAYERS_FILE}`);
  }
  return errors;
}

/**
 * Eager import cycles: modules that load each other, at any distance. Each strongly connected
 * group of the eager graph is reported once, as its shortest loop through the group's first
 * module in sort order.
 */
export function eagerCycles(edges: Edge[]): string[] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "eager") continue;
    const list = next.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    next.set(e.from, list);
    if (!next.has(e.to)) next.set(e.to, []);
  }
  // Tarjan's strongly connected components.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    for (let w = stack.pop(); w !== undefined; w = w === v ? undefined : stack.pop()) {
      onStack.delete(w);
      group.push(w);
    }
    if (group.length > 1 || (next.get(v) ?? []).includes(v)) groups.push(group);
  };
  for (const v of [...next.keys()].sort()) if (!index.has(v)) visit(v);

  return groups
    .map((group) => {
      const members = new Set(group);
      const start = [...group].sort()[0] ?? "";
      // Breadth first from `start` until an edge leads back to it, inside the group.
      const parent = new Map<string, string>();
      const queue = [start];
      let last: string | null = null;
      while (queue.length && last === null) {
        const v = queue.shift() ?? "";
        for (const w of [...(next.get(v) ?? [])].sort()) {
          if (!members.has(w)) continue;
          if (w === start) {
            last = v;
            break;
          }
          if (!parent.has(w)) {
            parent.set(w, v);
            queue.push(w);
          }
        }
      }
      const path: string[] = [];
      for (let v = last; v !== null && v !== start; v = parent.get(v) ?? null) path.unshift(v);
      return `eager import cycle: ${[start, ...path, start].join(" -> ")}`;
    })
    .sort();
}

/** Every module and page of vimma/ that git tracks, relative to vimma/. */
export function trackedFiles(root: string): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", `${VIMMA}*.mjs`, `${VIMMA}*.js`, `${VIMMA}*.html`],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((f) => f.slice(VIMMA.length));
}

/**
 * Why a file's bytes are not what the check reads them as, if they are not: a byte order mark
 * (a parser would decode UTF-16, or skip it), a NUL byte, or bytes that are not UTF-8. The
 * check reads every file as UTF-8, so a file must be exactly that.
 * @param bytes  the file's contents
 * @param label  the file, for the error
 */
export function encodingErrors(bytes: Uint8Array, label: string): string[] {
  const why =
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
      ? "starts with a byte order mark"
      : bytes.includes(0)
        ? "holds a NUL byte"
        : (() => {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              return null;
            } catch {
              return "is not valid UTF-8";
            }
          })();
  return why === null
    ? []
    : [
        `${label}: ${why}; the check reads UTF-8 without a byte order mark, as Firefox reads these files only then`,
      ];
}

/** Encoding problems of the files the tree check has read (readText). */
let encodingProblems: string[] = [];

/** The one way the tree check reads a file: as UTF-8, with its encoding checked. */
function readText(path: string, label: string): string {
  const bytes = readFileSync(path);
  const problems = encodingErrors(bytes, label);
  encodingProblems.push(...problems);
  // A file whose bytes are not what the check reads them as is reported, not parsed: the
  // parser's own error would hide the reason.
  return problems.length ? "" : bytes.toString("utf8");
}

/** Every edge of the tree, and every specifier in it that cannot be read. */
export function treeScan(root: string): Scan {
  const scans = trackedFiles(root).map((f) => {
    const text = readText(join(root, VIMMA, f), `vimma/${f}`);
    return f.endsWith(".html") ? htmlImports(text, f) : scanModule(text, f);
  });
  return {
    edges: scans.flatMap((s) => s.edges),
    problems: scans.flatMap((s) => s.problems),
    handOns: scans.flatMap((s) => s.handOns ?? []),
    names: scans.flatMap((s) => s.names ?? []),
  };
}

/** The Firefox patches git tracks under src/, with their text. */
function trackedPatches(root: string): { file: string; text: string }[] {
  return execFileSync("git", ["ls-files", "-z", "--", "src/**/*.patch"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ file, text: readText(join(root, file), file) }));
}

/** The files git tracks under a folder of the repository, relative to the repository. */
function gitFiles(root: string, folder: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", folder], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** Everything `npm run layering` checks in the tree at `root`, and the edges it read. */
export function treeErrors(root: string): { edges: Edge[]; errors: string[] } {
  encodingProblems = [];
  const { edges, problems, handOns = [], names = [] } = treeScan(root);
  const data = Object.fromEntries(
    Object.keys(RESTRICTED).map((m) => {
      const path = join(root, VIMMA, m);
      return [
        m,
        existsSync(path) ? getterNames(readText(path, `vimma/${m}`), m) : new Set<string>(),
      ];
    }),
  );
  const jar = readText(join(root, VIMMA, "jar.mn"), "vimma/jar.mn");
  const vimmaFiles = gitFiles(root, VIMMA).map((f) => f.slice(VIMMA.length));
  const mozBuild = join(root, VIMMA, "moz.build");
  const core = gitFiles(root, "packages/vimma-core/src/").filter((f) => /\.m?js$/.test(f));
  const errors = [
    ...problems,
    ...fileTypeErrors(vimmaFiles),
    ...(existsSync(mozBuild) ? mozBuildErrors(readText(mozBuild, "vimma/moz.build")) : []),
    ...core.flatMap((f) => coreErrors(readText(join(root, f), f), f)),
    ...jarErrors(jar),
    ...danglingEdges(edges, new Set(trackedFiles(root)), jarModules(jar)),
    ...exceptionErrors(EXCEPTIONS),
    ...layerErrors(edges, LAYERS, EXCEPTIONS),
    ...restrictedErrors(edges, RESTRICTED, handOns, data, names),
    ...patchErrors(trackedPatches(root), RESTRICTED),
    ...eagerCycles(edges),
    ...missingReadmes(root).map(
      (d) => `vimma/${d}/ has no README.md: say what it owns and what it may import (${ADR})`,
    ),
    // Last, after every read above.
    ...encodingProblems,
  ];
  return { edges, errors };
}

/**
 * The file types under vimma/: those the check reads (modules, scripts, pages) and those that
 * cannot carry code it would miss (docs, the build files it reads itself, images, the theme
 * hook's shell script, which no module can import as one: NOT_MODULE). A new type needs a
 * reader first, so that no page or script hides in a format the check skips.
 */
const FILE_TYPES = new Set(["mjs", "js", "html", "md", "mn", "build", "png", "sh"]);

/**
 * Files under vimma/ of a type the check does not know (FILE_TYPES).
 * @param files  every file git tracks under vimma/, relative to it
 */
export function fileTypeErrors(files: string[]): string[] {
  /** Lower case only, as the scan's own patterns are; a build file only where the build reads it. */
  const known = (f: string) => {
    const ext = /\.([a-z0-9]+)$/.exec(f)?.[1];
    if (ext === undefined || !FILE_TYPES.has(ext)) return false;
    if (ext === "mn") return f === "jar.mn";
    if (ext === "build") return f === "moz.build";
    return true;
  };
  return files
    .filter((f) => !known(f))
    .map((f) => `vimma/${f}: a file type the check does not read; ${WIDEN}`);
}

/** A plain string in vimma/moz.build: no quote, bracket, `#`, `;` or backslash inside. */
const MOZ_STRING = '"[^"\\[\\]#;\\\\]*"';
const MOZ_NAME = "(?:JAR_MANIFESTS|BROWSER_CHROME_MANIFESTS)";

/**
 * Lines of vimma/moz.build outside the shape it has today. EXTRA_JS_MODULES, MOZ_SRC_FILES,
 * GENERATED_FILES or any other statement could ship a Vimma module under resource:// or
 * moz-src:// as well, a second copy with its own state; and Python can hide one statement in
 * another. So the file is matched line by line: a comment (`#` and a space, or `#` alone), a
 * blank line, `NAME += ["…"]`, or `NAME += [` then lines of one plain string and a comma, then
 * `]`, with NAME JAR_MANIFESTS or BROWSER_CHROME_MANIFESTS.
 * @param text  vimma/moz.build's text
 */
export function mozBuildErrors(text: string): string[] {
  const oneLine = new RegExp(`^${MOZ_NAME} \\+= \\[${MOZ_STRING}\\]$`);
  const open = new RegExp(`^${MOZ_NAME} \\+= \\[$`);
  const item = new RegExp(`^ +${MOZ_STRING},$`);
  const errors: string[] = [];
  const fail = (n: number) =>
    errors.push(
      `vimma/moz.build:${n}: not one of the statement forms vimma/moz.build has today (JAR_MANIFESTS or BROWSER_CHROME_MANIFESTS += a list of plain strings); ${WIDEN}`,
    );
  let inList = false;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (inList) {
      if (line === "]") inList = false;
      else if (!item.test(line)) fail(i + 1);
    } else if (open.test(line)) inList = true;
    else if (!(line === "" || /^#( .*)?$/.test(line) || oneLine.test(line))) fail(i + 1);
  });
  if (inList) fail(lines.length);
  return errors;
}

/**
 * What vimma-core must not do, since the layering check does not read core/ (a copy made at
 * build time): reach a loader or Firefox through `import()`, `globalThis`, `eval` or
 * `Function`, or name a restricted module's file. eslint's purity rules (ADR-005) refuse
 * Firefox's URLs in `import` declarations and Firefox's globals by name; these close the
 * reflective ways around them.
 * @param source  a vimma-core source file's text
 * @param file  its path, for the error
 */
export function coreErrors(source: string, file: string): string[] {
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    loc: true,
  }) as unknown as AstNode;
  const lines = new Set<number>();
  const bases = Object.keys(RESTRICTED).map((m) => lettersOnly(posix.basename(m)));
  const visit = (node: AstNode, parent: AstNode | null, key: string): void => {
    const name = node.type === "Identifier" ? String(node["name"]) : null;
    const named =
      parent !== null &&
      ((parent.type === "MemberExpression" && key === "property" && !parent["computed"]) ||
        (parent.type === "Property" && key === "key" && !parent["computed"]));
    const text =
      node.type === "Literal"
        ? typeof node["value"] === "string"
          ? node["value"]
          : ((node["regex"] as { pattern?: string } | undefined)?.pattern ?? "")
        : node.type === "TemplateElement"
          ? ((node["value"] as { cooked?: string }).cooked ?? "")
          : "";
    if (
      node.type === "ImportExpression" ||
      (name !== null && !named && ["globalThis", "eval", "Function"].includes(name)) ||
      bases.some((b) => text && lettersOnly(text).includes(b))
    )
      lines.add(node.loc?.start.line ?? 0);
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child, node, k);
      } else if (isNode(value)) visit(value, node, k);
    }
  };
  visit(ast, null, "");
  return [...lines]
    .sort((a, b) => a - b)
    .map(
      (n) =>
        `${file}:${n}: vimma-core may not use import(), globalThis, eval or Function, nor name a restricted module's file: the layering check does not read core/`,
    );
}

/** Folders of vimma/ that git tracks and that have no README.md. */
export function missingReadmes(root: string): string[] {
  const files = execFileSync("git", ["ls-files", "-z", "--", VIMMA], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((f) => f.slice(VIMMA.length));
  const folders = [...new Set(files.filter((f) => f.includes("/")).map(folderOf))].sort();
  return folders.filter((d) => !existsSync(join(root, VIMMA, d, "README.md")));
}

function main(): void {
  const { edges, errors } = treeErrors(ROOT);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(
      `\nLayering: ${errors.length} problem(s). The rules: docs/adr/026-module-layering.md.`,
    );
    process.exit(1);
  }
  console.log(
    `Layering: ${edges.length} imports follow ${ADR}, no exception, no eager cycle, restricted modules imported only by their listed callers.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

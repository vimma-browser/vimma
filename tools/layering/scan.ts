/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The module scan (docs/security/12-agents-mcp.md section 12, "Load positions"): every place a
// module of vimma/ loads another, eager or lazy, and every string that names the gate's file.

import { posix } from "node:path";
import type { Reference } from "eslint-scope";
import * as espree from "espree";
import { constString, handOnsOf, keyName, scopeRefs, WATCHED } from "./hand-ons.ts";
import { CHROMEUTILS, chromeUtilsMisuse, LOADER, LOADERS } from "./loader.ts";
import {
  type AstNode,
  type Edge,
  fixedString,
  isNode,
  lettersOnly,
  lineNumber,
  type Mention,
  type Scan,
  URL_PREFIX,
} from "./model.ts";
import { canonical, loadedUrl, resolveSpec, unescape, vimmaPath } from "./urls.ts";

const NOT_FIXED = "an import specifier is not a fixed string";
const PARTIAL = "a string names part of a Vimma module URL, not a module or a folder";
const UNRESOLVED =
  "a string names content/vimma/ but no Vimma module or folder the check can resolve";
export const ALIAS =
  "names a Vimma module through a resource:// URL, which loads a second copy of it with its own state; name it by its chrome:// URL";
const MAP =
  'a getters map must be an object literal of key: "URL" entries with fixed keys, so that the check can read each one';
const SECOND =
  "names a restricted module by another URL than its own chrome:// URL or a plain relative path, which loads a second copy of it with its own state";
export const OPTIONS =
  "loads a Vimma module with an options argument, which can load it and everything it imports, the gate included, a second time in another global";
const WORKER_GATE = "loads a restricted module in a worker, a second copy of it with its own state";
/** The constructors whose first argument is a script URL loaded in a worker. */
const WORKERS = new Set(["Worker", "ChromeWorker", "SharedWorker"]);
const NOT_MODULE = "loads a Vimma file that is not a module (.mjs or .js)";

/**
 * Whether a path is vimma.js, the one classic script at the top of vimma/, which browser.xhtml
 * loads with `<script src>`. No module can import it, so a string that names it outside a load
 * position is not an edge; passed to `importESModule` or `import()`, it still is one. Any other
 * top-level name, a second script included, stays an edge until it is named here.
 */
const isRootScript = (path: string) => path === "vimma.js";

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

/**
 * Every edge from one module to another Vimma module, in source order: `scanModule` without
 * its problems. tools/diagrams draws the module graph from it, so the picture and this check
 * read the same edges.
 */
export function importsOf(source: string, file: string): Edge[] {
  return scanModule(source, file).edges;
}

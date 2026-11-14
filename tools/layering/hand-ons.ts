/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hand-ons (docs/security/12-agents.md section 12): where a module that holds a restricted module,
// the agent gate, lets it out of its own hands, so that a new caller is always a reviewed change.

import { analyze, type Reference } from "eslint-scope";
import * as espree from "espree";
import { RESTRICTED } from "./layers.ts";
import { type AstNode, fixedString, type HandOn, isNode } from "./model.ts";
import { resolveSpec } from "./urls.ts";

/** The restricted modules, whose hand-ons a scan looks for. */
export const WATCHED: ReadonlySet<string> = new Set(Object.keys(RESTRICTED));

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
export function keyName(node: AstNode, computed: boolean): string | null {
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
export function scopeRefs(ast: AstNode, file: string): Map<unknown, Reference> {
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
export function constString(id: AstNode, refs: Map<unknown, Reference>): string | null {
  const variable = refs.get(id)?.resolved;
  const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (def?.type !== "Variable" || (def.parent as { kind?: string } | null)?.kind !== "const")
    return null;
  const init = (def.node as unknown as AstNode)["init"];
  return isNode(init) ? fixedString(init) : null;
}

export function handOnsOf(ast: AstNode, file: string, watched: ReadonlySet<string>): HandOn[] {
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

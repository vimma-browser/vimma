/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// vimma-core (docs/security/12-agents-mcp.md section 12): core/ is a copy the scan does not read,
// so its sources may reach no loader by reflection and may not name a restricted module's file.

import { posix } from "node:path";
import * as espree from "espree";
import { RESTRICTED } from "./layers.ts";
import { type AstNode, isNode, lettersOnly } from "./model.ts";

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

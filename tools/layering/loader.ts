/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The loader rule (docs/security/12-agents-mcp.md section 12): ChromeUtils only as
// ChromeUtils.<name>, and either loader only called directly, since only that form shows the check
// which function loads what.

import { type AstNode, isNode } from "./model.ts";

export const LOADER =
  "the module loader is named other than in a direct ChromeUtils.importESModule(…) or defineESModuleGetters(…) call, so the check cannot read what it loads";
/** The two loader functions whose specifiers the check reads, only where called directly. */
export const LOADERS = new Set(["importESModule", "defineESModuleGetters"]);
export const CHROMEUTILS =
  "ChromeUtils is used other than as ChromeUtils.<name>, so the check cannot see which of its functions runs";

/**
 * Every use of `ChromeUtils` other than `ChromeUtils.<name>`: as a value, an argument, a spread,
 * a destructuring source, an `in` operand, a computed member, or a name a module declares. Only
 * the direct form lets the check see which function runs, and so which loader.
 */
export function chromeUtilsMisuse(ast: AstNode): AstNode[] {
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

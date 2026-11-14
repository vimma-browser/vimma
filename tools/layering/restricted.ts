/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Who may reach a restricted module (docs/security/12-agents-mcp.md section 12): import it, name
// its file or hold it. Only the modules RESTRICTED in layers.ts lists, each by the one URL of the
// one copy.

import { type Edge, type HandOn, LAYERS_FILE, type Mention, type Restricted } from "./model.ts";

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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What every part of the layering check shares (layering.ts runs it): the paths, the records a
// scan returns, and the end of every allow-list error, so that each module reports alike.

export const VIMMA = "src/browser/base/content/vimma/";
export const URL_PREFIX = "chrome://browser/content/vimma/";
export const LAYERS_FILE = "tools/layering/layers.ts";
export const ADR = "ADR-026";
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

export interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

export const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
/** What every allow-list error ends with: the lists are the tree's forms, widened on review. */
export const WIDEN =
  "widening this allow-list is a change to tools/layering/ that needs a fresh security review (ADR-026)";

/** The value of a string literal, or of a template literal without `${}`; else null. */
export function fixedString(node: AstNode): string | null {
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  const quasis = node["quasis"];
  const expressions = node["expressions"];
  if (node.type === "TemplateLiteral" && Array.isArray(expressions) && !expressions.length) {
    const head: unknown = Array.isArray(quasis) ? quasis[0] : undefined;
    return isNode(head) ? ((head["value"] as { cooked?: string }).cooked ?? null) : null;
  }
  return null;
}

/** The line number in a `file:line: message` problem. */
export const lineNumber = (problem: string) => Number(/:(\d+): /.exec(problem)?.[1] ?? 0);

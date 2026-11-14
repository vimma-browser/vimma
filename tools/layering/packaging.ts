/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Packaging and file types (docs/security/12-agents-mcp.md section 12): jar.mn and vimma/moz.build
// as they are today, the file types under vimma/, and that every edge names a tracked, packaged
// module.

import { folderOf } from "./layer-rules.ts";
import { type Edge, WIDEN } from "./model.ts";
import { canonical, vimmaPath } from "./urls.ts";

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

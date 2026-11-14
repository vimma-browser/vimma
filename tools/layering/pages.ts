/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pages (docs/security/12-agents-mcp.md section 12): what a page under vimma/ loads, read whole,
// and only the elements, URLs and policies the pages use today, so that no page loads code the
// check skips.

import { posix } from "node:path";
import { WATCHED } from "./hand-ons.ts";
import { type Edge, lettersOnly, lineNumber, type Mention, type Scan, WIDEN } from "./model.ts";
import { ALIAS } from "./scan.ts";
import { clean, resolveSpec, unescape } from "./urls.ts";

/** A page's character references decoded: `vimm&#97;` is `vimma` to the parser. */
export const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);?/gi, (_, ref: string) => {
    const r = ref.toLowerCase();
    if (r.startsWith("#"))
      return codePoint(r.startsWith("#x") ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10));
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[r] ?? "";
  });

/** A character by its code, U+FFFD for none or one past U+10FFFF, as a parser reads it. */
export const codePoint = (code: number) =>
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

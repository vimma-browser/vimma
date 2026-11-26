/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The links `gy` copies (docs/specs/copy-link-url.md decision 2), for VimmaChild: the link
// around a caret, the links a selection is inside or overlaps, the links of a focused block,
// and in the PDF viewer the link annotations drawn over the selection (decision 8). The reply is
// bounded here and checked again in the parent (core link-urls.mjs).

import { LINK_URL_MAX, LINK_URLS_MAX, isScriptUrl } from "../core/link-urls.mjs";
import { isPdfJsPrincipal } from "./pdf-view.mjs";

/** @import { LinkUrlsReply } from "../core/link-urls.mjs" */

const XLINK = "http://www.w3.org/1999/xlink";
/** Every element a link can be: HTML a and area, SVG a. `link` in a head is not one. */
const LINKS = "a[href], area[href], a[*|href]";
/** At most this many links are taken from one range or block before the URLs are capped. */
const SCAN_LIMIT = 5000;
/** At most this many links under a range's common ancestor are tested, inside it or not. */
const TEST_LIMIT = 50000;

/**
 * The link `node` is in, crossing out of shadow roots to their hosts, or null.
 * @param {Node | null} node
 * @returns {Element | null}
 */
export function linkAround(node) {
  let el = node && (node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement);
  if (!el && node?.parentNode) el = /** @type {ShadowRoot} */ (node.parentNode).host ?? null;
  while (el) {
    const link = el.closest(LINKS);
    if (link) return link;
    el = /** @type {ShadowRoot} */ (el.getRootNode()).host ?? null;
  }
  return null;
}

/**
 * Whether point (a, ao) is before point (b, bo) in the document; false when they are in
 * different trees.
 * @param {Document} doc
 * @param {Node} a
 * @param {number} ao
 * @param {Node} b
 * @param {number} bo
 */
function before(doc, a, ao, b, bo) {
  try {
    const r = doc.createRange();
    r.setStart(a, ao);
    return r.comparePoint(b, bo) > 0;
  } catch {
    return false;
  }
}

/**
 * The links `range` is inside or overlaps, in document order: the one around it, then each one
 * whose contents share at least a point of text or an element with it (decision 2). A link that
 * only touches an end of the range is not one.
 * @param {Document} doc
 * @param {Range} range
 * @returns {Element[]}
 */
function linksOfRange(doc, range) {
  const around = linkAround(range.commonAncestorContainer);
  if (range.collapsed) return around ? [around] : [];
  const out = around ? [around] : [];
  const common = range.commonAncestorContainer;
  const root = /** @type {Element | Document | DocumentFragment} */ (
    common.nodeType === 1 || common.nodeType === 9 || common.nodeType === 11
      ? common
      : common.parentNode
  );
  if (!root?.querySelectorAll) return out;
  let tested = 0;
  for (const link of root.querySelectorAll(LINKS)) {
    // Links outside the range count only toward the wider limit, so a selection low on a page
    // of many links still finds its own.
    if (++tested > TEST_LIMIT || out.length >= SCAN_LIMIT) break;
    if (link === around || !range.intersectsNode(link)) continue;
    const inner = doc.createRange();
    inner.selectNodeContents(link);
    const overlaps =
      before(doc, range.startContainer, range.startOffset, inner.endContainer, inner.endOffset) &&
      before(doc, inner.startContainer, inner.startOffset, range.endContainer, range.endOffset);
    if (overlaps) out.push(link);
  }
  return out;
}

/**
 * The selection's links: in the PDF viewer, the link annotations over it; elsewhere, those
 * of its first range.
 * @param {Window} win
 * @param {Selection} sel
 * @returns {Element[]}
 */
export function linksOfSelection(win, sel) {
  if (!sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const doc = win.document;
  if (isPdfJsPrincipal(doc.nodePrincipal)) return pdfLinksOver(doc, range);
  return linksOfRange(doc, range);
}

/**
 * The one link around the selection, for normal mode (decision 14): the link that holds the
 * whole selection; in the PDF viewer, the link annotation over it when there is exactly one.
 * Only one, because a page can make a selection by itself, and normal mode copies what the
 * user can see is a single link, never a list the page chose.
 * @param {Window} win
 * @param {Selection} sel
 * @returns {Element | null}
 */
export function linkAroundSelection(win, sel) {
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const doc = win.document;
  if (isPdfJsPrincipal(doc.nodePrincipal)) {
    const over = pdfLinksOver(doc, range);
    return over.length === 1 ? (over[0] ?? null) : null;
  }
  return linkAround(range.commonAncestorContainer);
}

/**
 * A focused block's links: the link around it when it is in one, else every link inside it
 * (decision 3).
 * @param {Element} el
 * @returns {Element[]}
 */
export function linksOfBlock(el) {
  const around = linkAround(el);
  if (around) return [around];
  return [...el.querySelectorAll(LINKS)].slice(0, SCAN_LIMIT);
}

/**
 * The element with focus in `doc`, through open and closed shadow roots, if it is a link or in
 * one (after a find, or Tab).
 * @param {Document} doc
 * @returns {Element | null}
 */
export function focusedLink(doc) {
  let el = doc.activeElement;
  while (el?.openOrClosedShadowRoot?.activeElement) el = el.openOrClosedShadowRoot.activeElement;
  if (!el || el === doc.body || el === doc.documentElement) return null;
  return linkAround(el);
}

/**
 * pdf.js draws each link as an `<a>` in a `section.linkAnnotation` of the annotation layer,
 * beside the text layer the selection is in (Research, "PDF links"): the links are those whose
 * box meets one of the selection's boxes, or the caret's, in the annotation layer's order.
 * @param {Document} doc
 * @param {Range} range
 * @returns {Element[]}
 */
function pdfLinksOver(doc, range) {
  const boxes = [...range.getClientRects()];
  if (!boxes.length) boxes.push(range.getBoundingClientRect());
  /** @type {Element[]} */
  const out = [];
  for (const link of doc.querySelectorAll(".annotationLayer .linkAnnotation > a[href]")) {
    const r = link.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const meets = boxes.some(
      (b) => b.left <= r.right && b.right >= r.left && b.top < r.bottom && b.bottom > r.top,
    );
    if (meets) out.push(link);
    if (out.length >= SCAN_LIMIT) break;
  }
  return out;
}

/**
 * A link's resolved, absolute URL: an HTML link's `href` (resolved by the document, base
 * included), an SVG link's attribute resolved against its base.
 * @param {Element} link
 * @returns {string | null}
 */
function urlOf(link) {
  const href = /** @type {HTMLAnchorElement} */ (link).href;
  if (typeof href === "string") return href;
  const raw = link.getAttribute("href") ?? link.getAttributeNS(XLINK, "href");
  if (raw === null) return null;
  return URL.parse(raw, link.baseURI)?.href ?? null;
}

/**
 * The reply for `links`: their URLs, each once, in order, at most LINK_URLS_MAX of at most
 * LINK_URL_MAX characters, with no `javascript:` URL, and how many were left out for being
 * a script or too long (decisions 3, 5 and 6).
 * @param {Element[]} links
 * @returns {LinkUrlsReply}
 */
export function linkUrls(links) {
  /** @type {Set<string>} */
  const urls = new Set();
  let scripts = 0;
  let long = 0;
  for (const link of links) {
    if (urls.size >= LINK_URLS_MAX) break;
    const url = urlOf(link);
    if (!url) continue;
    if (url.length > LINK_URL_MAX) long++;
    else if (isScriptUrl(url)) scripts++;
    else urls.add(url);
  }
  return { urls: [...urls], scripts, long };
}

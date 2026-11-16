/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live grep's matching, off the page's thread (docs/specs/live-grep.md decision 14). One
// ChromeWorker per content process (actors/grep-matcher.mjs), holding the text of each frame
// being searched by key. A regular expression that backtracks without end cannot freeze a
// page: grep-matcher.mjs terminates this worker when a query's time budget runs out.

import { CLOSED_MATCH_CAPS, GREP_CAPS, grepText, parseQuery } from "../core/grep.mjs";

/**
 * The worker's global, a DedicatedWorkerGlobalScope (which the DOM library does not declare).
 * @typedef {{ onmessage: ((event: MessageEvent) => void) | null, postMessage(message: unknown): void }} WorkerScope
 */
const scope = /** @type {WorkerScope} */ (globalThis);
/** @type {Map<string, string>} each frame's text, by key */
const texts = new Map();

/** @param {MessageEvent} event */
scope.onmessage = (event) => {
  const data = event.data;
  if (typeof data?.key !== "string") return;
  if (data.type === "text" && typeof data.text === "string") {
    texts.set(data.key, data.text);
    return;
  }
  if (data.type === "forget") {
    texts.delete(data.key);
    return;
  }
  if (data.type !== "query" || typeof data.query !== "string") return;
  const query = parseQuery(data.query);
  // `firstPerLine`: recently closed titles and URLs, one a line (core closedSearchText).
  const caps = data.firstPerLine
    ? CLOSED_MATCH_CAPS
    : data.all
      ? { ...GREP_CAPS, listed: GREP_CAPS.counted }
      : GREP_CAPS;
  const text = texts.get(data.key) ?? "";
  const reply = query ? grepText(text, query, caps) : { count: 0, matches: [] };
  scope.postMessage({ id: data.id, reply });
};

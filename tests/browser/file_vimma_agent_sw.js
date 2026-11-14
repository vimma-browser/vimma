/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_mcp_agent_pages.js: answers file_vimma_agent_sw_page.html from the
// worker, so the document has no HTTP response (no http-on-examine-response).

/** The worker's global: this file runs as a service worker. */
const worker = /** @type {typeof self & ServiceWorkerGlobalScope} */ (self);
worker.addEventListener("install", () => worker.skipWaiting());
worker.addEventListener("activate", (e) =>
  // An activate event is an ExtendableEvent.
  /** @type {ExtendableEvent} */ (e).waitUntil(worker.clients.claim()),
);
worker.addEventListener("fetch", (event) => {
  // A fetch event is a FetchEvent.
  const e = /** @type {FetchEvent} */ (event);
  if (e.request.url.includes("file_vimma_agent_sw_page.html")) {
    e.respondWith(
      new Response("<!doctype html><title>from the worker</title><body>worker page</body>", {
        headers: { "Content-Type": "text/html" },
      }),
    );
  }
});

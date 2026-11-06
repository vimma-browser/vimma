/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A search engine's suggestion endpoint for browser_vimma_urlbar_suggestions.js: answers
// `?q=<terms>` with six suggestions in the OpenSearch JSON format Firefox reads.

function handleRequest(request, response) {
  const query = decodeURIComponent(
    (request.queryString.match(/(?:^|&)q=([^&]*)/)?.[1] ?? "").replace(/\+/g, " "),
  );
  response.setHeader("Content-Type", "application/json", false);
  response.write(
    JSON.stringify([
      query,
      ["one", "two", "three", "four", "five", "six"].map((s) => `${query} ${s}`),
    ]),
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A POST search engine for browser_vimma_search.js (docs/specs/search-engines.md decision 5):
// answers with the method and the body it received, as plain text.

const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream",
);

/** @param {nsIHttpRequest} request @param {nsIHttpResponse} response */
function handleRequest(request, response) {
  const stream = new BinaryInputStream(request.bodyInputStream);
  const body = stream.available() ? stream.readBytes(stream.available()) : "";
  response.setHeader("Content-Type", "text/plain", false);
  response.write(`${request.method} ${body}`);
}

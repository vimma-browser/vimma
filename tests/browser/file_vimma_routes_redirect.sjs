/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_workspace_routes.js: a server redirect (302 Found) to the URL in the
// query string, so that a load of an unrouted site ends on a routed one (decision 9).
/** @param {nsIHttpRequest} request @param {nsIHttpResponse} response */
function handleRequest(request, response) {
  response.setStatusLine(request.httpVersion, 302, "Found");
  response.setHeader("Location", decodeURIComponent(request.queryString), false);
}

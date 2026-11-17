/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For browser_vimma_mcp_userinfo.js: a redirect to the untitled fixture on another site, whose
// URL holds no user name (#1209).
/** @param {nsIHttpRequest} request @param {nsIHttpResponse} response */
function handleRequest(request, response) {
  const dir = request.path.replace(/[^/]*$/, "");
  response.setStatusLine(request.httpVersion, 302, "Found");
  response.setHeader("Location", `https://example.org${dir}file_vimma_agent_untitled.html`, false);
}

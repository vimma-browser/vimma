/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_mcp_submit.js: a form's destination that answers 303 See Other, as
// sign-ins and checkouts do after a POST.
function handleRequest(request, response) {
  response.setStatusLine(request.httpVersion, 303, "See Other");
  response.setHeader("Location", "file_vimma_agent_page.html?redirected", false);
}

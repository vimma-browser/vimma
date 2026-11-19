/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_workspace_extension_tabs.js: an extension's sign-in page. `?signin`
// answers with a session cookie, as a sign-in does; `?whoami` answers with the cookies the
// request carried, as the API an extension then calls from its background does.
/** @param {nsIHttpRequest} request @param {nsIHttpResponse} response */
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  if (request.queryString === "whoami") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write(request.hasHeader("Cookie") ? request.getHeader("Cookie") : "");
    return;
  }
  if (request.queryString === "signin") {
    response.setHeader("Set-Cookie", "session=signed-in; Path=/; Secure; SameSite=None", false);
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write("<!doctype html><meta charset=utf-8><title>sign in</title><p>signed in");
}

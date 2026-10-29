/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_agent_coop.js: a page sent with the Cross-Origin-Opener-Policy
// named in its query (`?same-origin`, `?same-origin-allow-popups`), or none (`?none`); with
// `&cached` the response may be kept in the HTTP cache for an hour. Many sites send one (search
// engines, sign-in pages, web apps).
const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>COOP page</title>
  </head>
  <body>
    <h1>A page with an opener policy</h1>
    <button type="button" onclick="document.title = 'clicked'">Ready</button>
  </body>
</html>`;

function handleRequest(request, response) {
  const [policy, cached] = request.queryString.split("&");
  response.setHeader("Cache-Control", cached ? "max-age=3600" : "no-store", false);
  response.setHeader("Content-Type", "text/html;charset=utf-8", false);
  if (policy && policy !== "none") {
    response.setHeader("Cross-Origin-Opener-Policy", policy, false);
  }
  response.write(PAGE);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_mcp_waits.js: `?page` is a page whose DOMContentLoaded comes at once
// and whose load event waits for an image that answers after 5 s; `?wait=<ms>` answers after
// that many milliseconds (at most 5 s), for a fetch the page starts.
const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Slow page</title>
  </head>
  <body>
    <h1>A page whose image takes 5 s</h1>
    <img src="file_vimma_agent_slow.sjs?wait=5000" alt="" />
    <button type="button" onclick="document.title = 'clicked'">Ready</button>
  </body>
</html>`;

/** Timers kept alive until they fire: a collected nsITimer never fires. */
const timers = new Set();

function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  const query = request.queryString;
  if (query === "page") {
    response.setHeader("Content-Type", "text/html;charset=utf-8", false);
    response.write(PAGE);
    return;
  }
  const ms = Math.min(Number(/^wait=(\d+)$/.exec(query)?.[1]) || 0, 5000);
  response.processAsync();
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timers.add(timer);
  timer.init(
    () => {
      timers.delete(timer);
      response.setHeader("Content-Type", "text/plain", false);
      response.write("done");
      response.finish();
    },
    ms,
    Ci.nsITimer.TYPE_ONE_SHOT,
  );
}

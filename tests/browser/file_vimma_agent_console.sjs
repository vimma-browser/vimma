/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A response with the status the query names; `slow` holds it, so the page can abort it.
function handleRequest(request, response) {
  const query = new URLSearchParams(request.queryString);
  const status = Number(query.get("status")) || 200;
  if (query.get("slow")) {
    response.processAsync();
    const timer = Components.classes["@mozilla.org/timer;1"].createInstance(
      Components.interfaces.nsITimer,
    );
    timer.initWithCallback(
      () => {
        response.setStatusLine("1.1", status, "Status");
        response.write("late");
        response.finish();
      },
      3000,
      Components.interfaces.nsITimer.TYPE_ONE_SHOT,
    );
    return;
  }
  response.setStatusLine("1.1", status, "Status");
  response.setHeader("Content-Type", "text/plain", false);
  response.write(`status ${status}`);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_downloads.js. `?hold&name=<file>` answers a 20000-byte attachment,
// sends half of it and keeps the rest until `?release` is requested; `?now&name=<file>` sends a
// small attachment at once; `?short&name=<file>` promises 20000 bytes and sends half, so the
// download fails; `?release` lets every held download finish.
const SIZE = 20000;
const HALF = "a".repeat(SIZE / 2);

/** Timers kept alive until they fire: a collected nsITimer never fires. */
const timers = new Set();

function attachment(response, name, length) {
  response.setHeader("Cache-Control", "no-store", false);
  response.setHeader("Content-Type", "application/octet-stream", false);
  response.setHeader("Content-Disposition", `attachment; filename="${name}"`, false);
  response.setHeader("Content-Length", String(length), false);
}

function handleRequest(request, response) {
  const query = new URLSearchParams(request.queryString);
  const name = query.get("name") || "file.bin";
  if (query.has("release")) {
    setState("vimma-downloads-release", "1");
    response.setHeader("Content-Type", "text/plain", false);
    response.write("released");
    return;
  }
  if (query.has("now")) {
    attachment(response, name, 5);
    response.write("hello");
    return;
  }
  if (query.has("short")) {
    // Fewer bytes than the length promised: the download fails. Asynchronous, so httpd.js
    // keeps the promised Content-Length instead of counting the body.
    response.processAsync();
    attachment(response, name, SIZE);
    response.write(HALF);
    response.finish();
    return;
  }
  setState("vimma-downloads-release", "");
  response.processAsync();
  attachment(response, name, SIZE);
  response.write(HALF);
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timers.add(timer);
  timer.init(
    () => {
      if (getState("vimma-downloads-release") !== "1") return;
      timer.cancel();
      timers.delete(timer);
      response.write(HALF);
      response.finish();
    },
    100,
    Ci.nsITimer.TYPE_REPEATING_SLACK,
  );
}

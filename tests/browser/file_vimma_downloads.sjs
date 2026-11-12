/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fixture for browser_vimma_downloads.js. `?hold&name=<file>` answers a 20000-byte attachment,
// sends half of it and keeps the rest until `?release` is requested; `?now&name=<file>` sends a
// small attachment at once; `?short&run=<id>&name=<file>` promises 20000 bytes and sends half,
// so the download fails, the first time for each run and name, and sends all of it after;
// `?release` lets every held download finish. A held download can be resumed: its answer carries
// an ETag, and a `Range` request gets the rest at once. The server's state outlives one run of
// the test file (`--repeat` runs it again in the same harness), hence the run id.
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
  const shortKey = `vimma-downloads-short-${query.get("run")}-${name}`;
  if (query.has("short") && getState(shortKey) !== "1") {
    setState(shortKey, "1");
    // Fewer bytes than the length promised: the download fails. Asynchronous, so httpd.js
    // keeps the promised Content-Length instead of counting the body.
    response.processAsync();
    attachment(response, name, SIZE);
    response.write(HALF);
    response.finish();
    return;
  }
  if (query.has("short")) {
    attachment(response, name, SIZE);
    response.write(HALF + HALF);
    return;
  }
  const range = request.hasHeader("Range") && /^bytes=(\d+)-$/.exec(request.getHeader("Range"));
  if (range) {
    const from = Number(range[1]);
    response.setStatusLine(request.httpVersion, 206, "Partial Content");
    attachment(response, name, SIZE - from);
    response.setHeader("ETag", '"vimma-held"', false);
    response.setHeader("Accept-Ranges", "bytes", false);
    response.setHeader("Content-Range", `bytes ${from}-${SIZE - 1}/${SIZE}`, false);
    response.write("a".repeat(SIZE - from));
    return;
  }
  setState("vimma-downloads-release", "");
  response.processAsync();
  attachment(response, name, SIZE);
  response.setHeader("ETag", '"vimma-held"', false);
  response.setHeader("Accept-Ranges", "bytes", false);
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

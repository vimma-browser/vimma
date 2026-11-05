/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The update host for browser_vimma_update_check.js (docs/specs/m6a-updater.md): POST ?set
// stores the manifest to serve (an empty body answers 404); GET ?log returns every manifest
// request so far (its query, its headers, whether it carried a Cookie header); GET ?reset clears
// both. ?redirect=http|host answers 302 to http:// or another host; ?big a 1 MiB body with its
// length, ?bigstream 4 MiB with none.

const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream",
);

const MANIFEST = "vimma-update-manifest";
const LOG = "vimma-update-log";

function handleRequest(request, response) {
  // Firefox's checker adds force=1 to a check started by hand (browser_vimma_update_verify.js).
  const query = request.queryString.replace(/&force=1$/, "");
  response.setHeader("Cache-Control", "no-cache", false);
  if (query === "set") {
    const stream = new BinaryInputStream(request.bodyInputStream);
    const body = stream.available() ? stream.readBytes(stream.available()) : "";
    setSharedState(MANIFEST, body);
    response.write("ok");
    return;
  }
  if (query === "log") {
    response.setHeader("Content-Type", "application/json", false);
    response.write(getSharedState(LOG) || "[]");
    return;
  }
  if (query === "reset") {
    setSharedState(MANIFEST, "");
    setSharedState(LOG, "[]");
    response.write("ok");
    return;
  }
  const headers = {};
  const names = request.headers;
  while (names.hasMoreElements()) {
    const name = names.getNext().QueryInterface(Ci.nsISupportsString).data;
    headers[name.toLowerCase()] = request.getHeader(name);
  }
  const log = JSON.parse(getSharedState(LOG) || "[]");
  log.push({
    query,
    cookie: request.hasHeader("Cookie"),
    referer: request.hasHeader("Referer"),
    headers,
  });
  setSharedState(LOG, JSON.stringify(log));
  if (query.startsWith("redirect=")) {
    const path = request.path;
    const to =
      query === "redirect=http" ? `http://example.com${path}` : `https://example.org${path}`;
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", `${to}?landed`, false);
    return;
  }
  if (query === "big") {
    const chunk = "x".repeat(1024 * 1024);
    response.setHeader("Content-Type", "text/xml", false);
    response.setHeader("Content-Length", String(chunk.length), false);
    response.write(chunk);
    return;
  }
  if (query === "bigstream") {
    // No Content-Length: only counting the bytes read stops it.
    response.processAsync();
    response.setHeader("Content-Type", "text/xml", false);
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    const step = () => {
      try {
        response.write(chunk);
      } catch {
        timer.cancel();
        return;
      }
      if (++sent >= 64) {
        timer.cancel();
        response.finish();
      }
    };
    timer.initWithCallback(step, 10, Ci.nsITimer.TYPE_REPEATING_SLACK);
    return;
  }
  const body = getSharedState(MANIFEST);
  if (!body) {
    response.setStatusLine(request.httpVersion, 404, "Not Found");
    return;
  }
  response.setHeader("Content-Type", "text/xml", false);
  response.write(body);
}

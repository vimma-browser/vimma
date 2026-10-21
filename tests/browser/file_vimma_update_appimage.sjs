/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The release download for browser_vimma_update_appimage.js (docs/specs/m6a-updater.md,
// decision 19): POST ?set stores the AppImage's bytes; GET ?file serves them (?redirect answers
// 302 to ?file, as GitHub's release downloads do); GET ?log returns every download request so far
// (its query and whether it carried a Cookie or Referer header); GET ?reset clears both.

const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream",
);

const FILE = "vimma-update-appimage";
const LOG = "vimma-update-appimage-log";

function handleRequest(request, response) {
  const query = request.queryString;
  response.setHeader("Cache-Control", "no-cache", false);
  if (query === "set") {
    const stream = new BinaryInputStream(request.bodyInputStream);
    setSharedState(FILE, stream.available() ? stream.readBytes(stream.available()) : "");
    response.write("ok");
    return;
  }
  if (query === "log") {
    response.setHeader("Content-Type", "application/json", false);
    response.write(getSharedState(LOG) || "[]");
    return;
  }
  if (query === "reset") {
    setSharedState(FILE, "");
    setSharedState(LOG, "[]");
    response.write("ok");
    return;
  }
  const log = JSON.parse(getSharedState(LOG) || "[]");
  log.push({ query, cookie: request.hasHeader("Cookie"), referer: request.hasHeader("Referer") });
  setSharedState(LOG, JSON.stringify(log));
  if (query === "redirect") {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", `https://example.com${request.path}?file`, false);
    return;
  }
  const body = getSharedState(FILE);
  response.setHeader("Content-Type", "application/octet-stream", false);
  response.setHeader("Content-Length", String(body.length), false);
  response.write(body);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A page that keeps loading for 30 s (browser_vimma_browser_keys.js: Esc stops it). The doctype
// comes 500 ms before the first element, so a test always meets the document the page has
// already created but not yet given a root element: the window in which #587 flaked.

let first;
let timer;

function handleRequest(request, response) {
  response.processAsync();
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write("<!doctype html>");
  first = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  first.initWithCallback(
    () => response.write("<title>slow</title><p>loading for a while"),
    500,
    Ci.nsITimer.TYPE_ONE_SHOT,
  );
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(() => response.finish(), 30000, Ci.nsITimer.TYPE_ONE_SHOT);
}

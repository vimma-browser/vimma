/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AMO's search API for browser_vimma_setup.js: one curated entry, so the page offers a real
// install without reaching addons.mozilla.org.

function handleRequest(request, response) {
  response.setHeader("Content-Type", "application/json", false);
  response.write(
    JSON.stringify({
      results: [
        {
          type: "extension",
          guid: "uBlock0@raymondhill.net",
          slug: "ublock-origin",
          name: { "en-US": "uBlock Origin" },
          authors: [{ name: "Raymond Hill" }],
          summary: { "en-US": "A content blocker." },
          average_daily_users: 1000,
          current_version: {
            file: { url: "https://addons.mozilla.org/f/ublock.xpi", hash: "sha256:00" },
          },
        },
      ],
    }),
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `fetch` the bench gives the loop for a real provider. Node's own fetch gives up on a
// response whose headers take more than five minutes (undici's headersTimeout), which a large
// local model on a CPU reaches while it reads a long prompt; this one waits as long as the run's
// time limit, enforced by the loop's abort signal. Like the browser's request (B11), it follows
// no redirect and sends no cookies.

import http from "node:http";
import https from "node:https";

/** @type {import("../../packages/vimma-core/src/agent-providers.mjs").Fetch} */
export function httpFetch(url, init) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      { method: init.method ?? "GET", headers: init.headers ?? {}, signal: init.signal },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new Error(`the endpoint redirected (${status}); requests follow no redirect`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ ok: status >= 200 && status < 300, status, text: async () => body }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Downloads for browser_vimma_mcp_downloads.js (docs/specs/vimma-mcp.md decision 31): an
// attachment with a chosen name, type and body.
//   ?name=a.pdf&type=application/pdf&body=text|elf|zipexe|zip&bytes=N&stream=1
// `bytes` pads the body to N bytes; `stream=1` sends it in 64 KiB pieces without a
// Content-Length, so the size is unknown until it ends.

const ELF = [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0];

/** A stored zip holding these names (empty files). @param {string[]} names */
function zip(names) {
  /** @type {number[]} */
  const out = [];
  /** @param {number} n */
  const u16 = (n) => out.push(n & 0xff, (n >> 8) & 0xff);
  /** @param {number} n */
  const u32 = (n) => out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  /** @type {number[]} */
  const offsets = [];
  for (const name of names) {
    offsets.push(out.length);
    u32(0x04034b50);
    u16(10);
    for (let i = 0; i < 4; i++) u16(0);
    u32(0);
    u32(0);
    u32(0);
    u16(name.length);
    u16(0);
    for (const c of name) out.push(c.charCodeAt(0));
  }
  const cd = out.length;
  names.forEach((name, i) => {
    u32(0x02014b50);
    u16(20);
    u16(10);
    for (let k = 0; k < 4; k++) u16(0);
    u32(0);
    u32(0);
    u32(0);
    u16(name.length);
    for (let k = 0; k < 4; k++) u16(0);
    u32(0);
    u32(offsets[i]);
    for (const c of name) out.push(c.charCodeAt(0));
  });
  const size = out.length - cd;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(names.length);
  u16(names.length);
  u32(size);
  u32(cd);
  u16(0);
  return out;
}

/** @param {string} kind @returns {number[]} */
function body(kind) {
  switch (kind) {
    case "elf":
      return ELF;
    case "zipexe":
      return zip(["README.txt", "bin/tool.exe"]);
    case "zip":
      return zip(["README.txt", "docs/a.pdf"]);
    default:
      return [..."agent download\n"].map((c) => c.charCodeAt(0));
  }
}

/** @param {nsIHttpRequest} request @param {nsIHttpResponse} response */
function handleRequest(request, response) {
  const q = new URLSearchParams(request.queryString);
  const name = q.get("name") || "vimma-agent-test.bin";
  const bytes = body(q.get("body") || "text");
  const total = Math.max(bytes.length, Number(q.get("bytes") || 0));
  response.setHeader("Content-Type", q.get("type") || "application/octet-stream", false);
  response.setHeader("Content-Disposition", `attachment; filename="${name}"`, false);
  response.setHeader("Cache-Control", "no-store", false);
  const head = String.fromCharCode(...bytes);
  if (q.get("stream") !== "1") {
    response.setHeader("Content-Length", String(total), false);
    response.write(head);
    const piece = "\0".repeat(65536);
    let left = total - bytes.length;
    while (left > 0) {
      response.write(left >= piece.length ? piece : piece.slice(0, left));
      left -= piece.length;
    }
    return;
  }
  // No Content-Length: the size is unknown until the connection closes.
  response.processAsync();
  response.write(head);
  let left = total - bytes.length;
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  const piece = "\0".repeat(65536);
  const next = () => {
    if (left <= 0) {
      response.finish();
      return;
    }
    try {
      response.write(left >= piece.length ? piece : piece.slice(0, left));
    } catch {
      response.finish();
      return;
    }
    left -= piece.length;
    timer.initWithCallback(next, 20, Ci.nsITimer.TYPE_ONE_SHOT);
  };
  next();
}

// Fixture pages for scenarios: `open "fixture:<name>"` loads tests/e2e/fixtures/<name> from a
// local HTTP server, so the page runs in a web content process under the default sandbox (a
// file: URL would go to the file process, which may read any file and hides sandbox problems).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const NAME = /^[\w-][\w.-]*$/;
/** A fragment the page may read (`fixture:cookie.html#work`); the server never sees it. */
const FRAGMENT = /^#[\w.=-]*$/;
const TYPES = /** @type {Record<string, string>} */ ({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
});

/**
 * @param {string} url a scenario's `open` value: `fixture:<name>[#fragment]` or a URL
 * @param {string | null} base the page server's base URL (with a trailing slash)
 * @returns {string}
 */
export function fixtureUrl(url, base) {
  if (!url.startsWith("fixture:")) return url;
  const rest = url.slice("fixture:".length);
  const hash = rest.indexOf("#");
  const name = hash < 0 ? rest : rest.slice(0, hash);
  const fragment = hash < 0 ? "" : rest.slice(hash);
  if (!NAME.test(name) || name.includes("..") || (fragment && !FRAGMENT.test(fragment))) {
    throw new Error(`bad fixture name in ${JSON.stringify(url)}: one file in tests/e2e/fixtures/`);
  }
  if (!base) throw new Error(`${url} needs the fixture page server, which is not running`);
  return `${base}${name}${fragment}`;
}

/**
 * A typed text with each `fixture:<name>[#fragment]` in it mapped onto the server; a name ends
 * at a space or `]`, so a fake agent CLI's `[[open fixture:shop.html]]` works.
 * @param {string} text
 * @param {string | null} base
 * @returns {string}
 */
export function fixtureText(text, base) {
  return text.replace(/fixture:[^\s\]]*/g, (url) => fixtureUrl(url, base));
}

/**
 * Serve the plain files of `dir` (no subdirectories) on 127.0.0.1 at an ephemeral port.
 * @param {string} dir
 * @returns {Promise<{ base: string, close: () => Promise<void> }>}
 */
export async function startPageServer(dir) {
  const server = createServer((req, res) => {
    let name = "";
    try {
      name = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(1));
    } catch {
      // malformed escape: 404 below
    }
    const path = join(dir, name);
    if (!NAME.test(name) || name.includes("..") || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(name)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(path).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

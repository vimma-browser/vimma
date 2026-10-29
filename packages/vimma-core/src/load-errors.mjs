/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's error pages, as an agent's open or step names them (issue #643): a load that ended on
// one is an error the model reads in Vimma's fixed words, so that it stops instead of opening the
// same address again. vimma-ctl has the same list (tools/vimma-ctl/src/mcp.rs, `LOAD_ERRORS`).

/**
 * The `e=` codes of Firefox's error pages that come of a top-level load (nsDocShell.cpp,
 * `DisplayLoadError`), each with what it means; `other` stands for any code not here, so a code
 * Firefox adds later never reaches the model as page text.
 */
export const LOAD_ERRORS = Object.freeze({
  dnsNotFound: "the server was not found",
  connectionFailure: "the server refused the connection",
  netTimeout: "the server took too long to answer",
  netReset: "the connection was reset",
  netInterrupt: "the connection was interrupted",
  netOffline: "the browser is offline",
  networkProtocolError: "the server broke the network protocol",
  redirectLoop: "the page redirects in a loop",
  serverError: "the server answered with an error",
  httpErrorPage: "the server answered with an error",
  malformedURI: "the address is not valid",
  unknownProtocolFound: "the address uses a protocol the browser does not handle",
  deniedPortAccess: "the address uses a port the browser blocks",
  proxyConnectFailure: "the proxy server refused the connection",
  proxyResolveFailure: "the proxy server was not found",
  contentEncodingError: "the page's content encoding is broken",
  corruptedContentErrorv2: "the page's content is corrupted",
  unsafeContentType: "the page's content type is unsafe",
  invalidHeaderValue: "the server sent an invalid header",
  notCached: "the page is no longer in the cache",
  fileNotFound: "the file was not found",
  fileAccessDenied: "the file cannot be read",
  nssBadCert: "the site's certificate is not trusted",
  nssFailure2: "the secure connection failed",
  sslv3Used: "the site uses an insecure protocol",
  weakCryptoUsed: "the site uses weak encryption",
  inadequateSecurityError: "the site's security is inadequate",
  clientSocketMisconfiguration: "the secure connection failed",
  httpsOnly: "the site has no https version and the browser loads only https",
  basicHttpAuthDisabled: "the site asks for a login the browser does not send over http",
  blockedByPolicy: "an enterprise policy blocks the page",
  blockedByCOOP: "the page's opener policy blocked it",
  blockedByCOEP: "the page's embedder policy blocked it",
  cspBlocked: "the page's content security policy blocked it",
  xfoBlocked: "the page does not allow being framed",
  deceptiveBlocked: "the site is reported as deceptive",
  malwareBlocked: "the site is reported as malware",
  unwantedBlocked: "the site is reported to serve unwanted software",
  harmfulBlocked: "the site is reported as harmful",
  addonBlocked: "an add-on blocked the page",
  other: "an error Vimma does not name",
});

/**
 * A load error in Vimma's words, as the model reads it (mcp.rs, `error_page`).
 * @param {string} code  a LOAD_ERRORS code
 */
export function errorPageText(code) {
  return `Firefox showed its error page, ${/** @type {Record<string, string>} */ (LOAD_ERRORS)[code]} (${code})`;
}

/** The error pages a load ends on: `about:<page>?e=<code>&u=<url>`. */
const ERROR_PAGES = /^about:(neterror|certerror|blocked|httpsonlyerror)(?:[?#]|$)/;

/**
 * Firefox's error for a top document's URI: a LOAD_ERRORS code, `other` for an error page whose
 * code is not one, or null for a page that is not an error page.
 * @param {string} documentUri
 * @returns {string | null}
 */
export function loadErrorOf(documentUri) {
  const page = ERROR_PAGES.exec(documentUri)?.[1];
  if (!page) return null;
  if (page === "httpsonlyerror") return "httpsOnly";
  const query = documentUri.slice(`about:${page}`.length).replace(/^\?/, "").replace(/#.*$/s, "");
  const code = new URLSearchParams(query).get("e") ?? "";
  return Object.hasOwn(LOAD_ERRORS, code) && code !== "other" ? code : "other";
}

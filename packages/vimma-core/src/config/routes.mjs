/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Workspace routing rules (spec: docs/specs/workspace-routing.md, docs/specs/app-routes.md):
 * `[[routes]]` tables in config.toml say which workspace a URL opens in, by domain, URL prefix
 * or the programs that opened the link. Rules without `app` win in file order; the rules with
 * `app` above the first of them that matches compete by the nearest program named. Pure: the
 * host passes URLs as strings and the program names as parseAppList returns them.
 */
import { closest } from "../keys/actions.mjs";

/**
 * @typedef {object} RouteDomain
 * @property {string} host  ASCII (punycode), lower case, no trailing dot; IPv6 without brackets
 * @property {boolean} sub  `*.host`: subdomains only
 * @property {boolean} ip   an IP literal: matches only itself
 */

/**
 * @typedef {object} Route
 * @property {number} index        1-based place in the file
 * @property {string} workspace
 * @property {RouteDomain} [domain]
 * @property {string} [url]        a prefix of `URL.href`
 * @property {string} [app]        the application token
 */

/** @typedef {{ path: (string | number)[], message: string, suggestion?: string }} RouteProblem */

const KEYS = ["domain", "url", "app", "workspace"];
const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const DOMAIN = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// 64, so that macOS bundle identifiers fit (app-routes, decision 2).
const APP = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
/** At most this many names per link (app-routes, decision 2). */
export const MAX_APPS = 8;
const MAX_NAME = 32;
const BAD_DOMAIN =
  'must be a hostname like "github.com" or "*.corp.example", without scheme, port or path';

/**
 * Whether `s` may be an application name: a lower-case token, never a path or anything a shell
 * would read. Both the launcher and the host check it.
 * @param {unknown} s
 */
export function isAppToken(s) {
  return typeof s === "string" && APP.test(s);
}

/**
 * The program names a link carries (`-vimma-from`, `VIMMA_FROM`: comma-separated, nearest
 * first), as matching uses them: lower-cased tokens only, consecutive duplicates collapsed, at
 * most MAX_APPS. The value is an untrusted hint, so whatever is not a token is dropped.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseAppList(raw) {
  if (typeof raw !== "string") return [];
  /** @type {string[]} */
  const names = [];
  for (const part of raw.split(",")) {
    const name = part.toLowerCase();
    if (!isAppToken(name) || names[names.length - 1] === name) continue;
    names.push(name);
    if (names.length === MAX_APPS) break;
  }
  return names;
}

/** @param {unknown} v */
function typeName(v) {
  if (Array.isArray(v)) return "an array";
  if (typeof v === "bigint") return "an integer";
  if (typeof v === "number") return "a float";
  if (v !== null && typeof v === "object") return v instanceof Date ? "a date" : "a table";
  return typeof v === "string" ? "a string" : "a boolean";
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isTable = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** @param {string} s */
const hasControl = (s) =>
  [...s].some((ch) => /** @type {number} */ (ch.codePointAt(0)) < 0x20 || ch === "\x7f");

/**
 * The URL parser's ASCII hostname for `host`, or null.
 * @param {string} host
 */
function asciiHost(host) {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
}

/**
 * A `domain` value as matching compares it, or null when it is not one.
 * @param {string} text
 * @returns {RouteDomain | null}
 */
function parseDomain(text) {
  let s = text.trim().toLowerCase().replace(/\.$/, "");
  const sub = s.startsWith("*.");
  if (sub) s = s.slice(2);
  if (!s || /[/?#@*\s\\%]/.test(s)) return null;
  if (IPV4.test(s)) return sub || asciiHost(s) !== s ? null : { host: s, sub: false, ip: true };
  const v6 = s.replace(/^\[(.*)\]$/, "$1");
  if (v6.includes(":")) {
    if (sub) return null;
    const h = asciiHost(`[${v6}]`);
    return h ? { host: h.slice(1, -1), sub: false, ip: true } : null;
  }
  const ascii = asciiHost(s);
  // The parser reads some names as IPv4 (`0x7f.1`); a domain rule must stay a name.
  if (!ascii || IPV4.test(ascii) || !DOMAIN.test(ascii)) return null;
  return { host: ascii, sub, ip: false };
}

/**
 * What the user probably meant by a `domain` that is not a hostname.
 * @param {string} text
 */
function domainSuggestion(text) {
  const host = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d*$/, "");
  return host !== text && parseDomain(host) ? host : undefined;
}

/**
 * A `url` value as matching compares it (`URL.href`), or null.
 * @param {string} text
 */
function parseUrlPrefix(text) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text.trim())) return null;
  try {
    const href = new URL(text.trim()).href;
    return /^javascript:/i.test(href) ? null : href;
  } catch {
    return null;
  }
}

/**
 * Every problem of a `routes` value (the parsed `[[routes]]` array), paths relative to it.
 * @param {unknown} value
 * @returns {RouteProblem[]}
 */
export function validateRoutes(value) {
  /** @type {RouteProblem[]} */
  const problems = [];
  if (!Array.isArray(value)) {
    return [{ path: [], message: `expected [[routes]] tables, got ${typeName(value)}` }];
  }
  value.forEach((rule, i) => {
    if (!isTable(rule)) {
      problems.push({ path: [i], message: `expected a table, got ${typeName(rule)}` });
      return;
    }
    const before = problems.length;
    for (const [key, v] of Object.entries(rule)) {
      const path = [i, key];
      if (!KEYS.includes(key)) {
        const suggestion = closest(key, KEYS);
        problems.push({
          path,
          message: `unknown key "${key}"`,
          ...(suggestion ? { suggestion } : {}),
        });
      } else if (typeof v !== "string") {
        problems.push({ path, message: `expected a string, got ${typeName(v)}` });
      } else if (key === "domain" && !parseDomain(v)) {
        const suggestion = domainSuggestion(v);
        problems.push({ path, message: BAD_DOMAIN, ...(suggestion ? { suggestion } : {}) });
      } else if (key === "url" && !parseUrlPrefix(v)) {
        problems.push({
          path,
          message: 'must be a URL like "file:///home/me/work/" or "about:preferences"',
        });
      } else if (key === "app" && !isAppToken(v.toLowerCase())) {
        problems.push({
          path,
          message:
            "must be an application name: letters, digits and . _ + - (as `vimma-open` reports it)",
        });
      } else if (key === "workspace") {
        const length = [...v].length;
        if (length < 1 || length > MAX_NAME) {
          problems.push({ path, message: `workspace name must be 1 to ${MAX_NAME} characters` });
        } else if (hasControl(v)) {
          problems.push({ path, message: "workspace name must not contain control characters" });
        }
      }
    }
    if (problems.length > before) return;
    if (!("domain" in rule || "url" in rule || "app" in rule)) {
      problems.push({ path: [i], message: 'a rule needs domain, url or app (and "workspace")' });
    } else if ("domain" in rule && "url" in rule) {
      problems.push({ path: [i, "url"], message: "use domain or url, not both" });
    } else if (!("workspace" in rule)) {
      problems.push({ path: [i], message: 'missing "workspace"' });
    }
  });
  return problems;
}

/**
 * The rules of a valid `routes` value, as matching uses them.
 * @param {readonly Record<string, string>[]} value  validated by validateRoutes
 * @returns {Route[]}
 */
export function resolveRoutes(value) {
  return value.map((rule, i) => {
    /** @type {Route} */
    const route = { index: i + 1, workspace: rule.workspace ?? "" };
    if (rule.domain !== undefined)
      route.domain = /** @type {RouteDomain} */ (parseDomain(rule.domain));
    if (rule.url !== undefined) route.url = /** @type {string} */ (parseUrlPrefix(rule.url));
    if (rule.app !== undefined) route.app = rule.app.toLowerCase();
    return route;
  });
}

/**
 * @param {URL} u
 * @param {RouteDomain} d
 */
function domainHit(u, d) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  if (d.ip) return host === d.host;
  if (IPV4.test(host) || host.includes(":")) return false;
  return d.sub ? host.endsWith(`.${d.host}`) : host === d.host || host.endsWith(`.${d.host}`);
}

/**
 * `href` starts with `prefix` on a boundary: the prefix ends in "/", or what follows it is the
 * end, "/", "?" or "#" (`/app` is not `/apples`).
 * @param {string} href
 * @param {string} prefix
 */
function urlHit(href, prefix) {
  if (!href.startsWith(prefix)) return false;
  if (prefix.endsWith("/") || href.length === prefix.length) return true;
  return "/?#".includes(/** @type {string} */ (href[prefix.length]));
}

/**
 * @param {Route} r
 * @param {URL | null} u
 */
function keysHit(r, u) {
  if (r.domain && !(u && domainHit(u, r.domain))) return false;
  if (r.url !== undefined && !(u && urlHit(u.href, r.url))) return false;
  return true;
}

/**
 * Whether a rule's workspace can take a link: it exists (when `workspaces` is given) and is not
 * one to pass over (`skip`: the agent workspace for a link from another program).
 * @param {Route} r
 * @param {{ workspaces?: readonly string[], skip?: readonly string[] }} options
 */
function usable(r, { workspaces, skip = [] }) {
  return (!workspaces || workspaces.includes(r.workspace)) && !skip.includes(r.workspace);
}

/**
 * The rule for `url` opened by the programs `apps` (nearest first, from parseAppList; empty:
 * none known), or null (app-routes, decision 3). The first matching rule without `app`, N, wins
 * unless a matching rule with `app` sits above it: among those, the one naming the nearest
 * program wins, the earlier on a tie. Rules below N never apply. A rule whose workspace is not
 * in `workspaces`, or is in `skip`, is passed over. When a rule with `app` names a skipped
 * workspace (an agent CLI's rule) and that program is among `apps`, every name is dropped, so
 * no rule with `app` applies, wherever that rule sits (decision 5).
 * @param {readonly Route[]} routes
 * @param {{ url: string, apps?: readonly string[] }} what
 * @param {{ workspaces?: readonly string[], skip?: readonly string[] }} [options]
 * @returns {Route | null}
 */
export function matchRoute(routes, { url, apps = [] }, options = {}) {
  if (!routes.length) return null;
  /** @type {URL | null} */
  let u;
  try {
    u = new URL(url);
  } catch {
    u = null;
  }
  const skip = options.skip ?? [];
  let names = apps.filter((a) => isAppToken(a));
  if (
    routes.some((r) => r.app !== undefined && skip.includes(r.workspace) && names.includes(r.app))
  ) {
    names = [];
  }
  /** @type {Route | null} */
  let best = null;
  let bestAt = Infinity;
  for (const r of routes) {
    if (!usable(r, options) || !keysHit(r, u)) continue;
    if (r.app === undefined) return best ?? r;
    const at = names.indexOf(r.app);
    if (at >= 0 && at < bestAt) {
      best = r;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Whether every URL `inner` matches, `outer` matches too (both domains).
 * @param {RouteDomain} outer
 * @param {RouteDomain} inner
 */
function domainCovers(outer, inner) {
  if (outer.ip || inner.ip) return outer.ip && inner.ip && outer.host === inner.host;
  const below = inner.host.endsWith(`.${outer.host}`);
  if (outer.sub) return below || (inner.sub && inner.host === outer.host);
  return below || inner.host === outer.host;
}

/**
 * Whether every URL rule `i` matches, rule `j` matches too, by `domain` and `url` alone.
 * @param {Route} j
 * @param {Route} i
 */
function covers(j, i) {
  if (!j.domain && j.url === undefined) return true;
  if (j.domain) {
    if (i.domain) return domainCovers(j.domain, i.domain);
    if (i.url === undefined) return false;
    try {
      return domainHit(new URL(i.url), j.domain);
    } catch {
      return false;
    }
  }
  return i.url !== undefined && urlHit(i.url, /** @type {string} */ (j.url));
}

/**
 * An earlier rule that wins over `routes[i]` wherever `routes[i]` applies, or null, for
 * about:vimma's `shadowed by rule N` (app-routes, decision 15). It has no `app` or the same
 * `app`, covers the rule's domain or URL, and is not passed over (`workspaces`, `skip`). A rule
 * with `app` never shadows one without, which also applies to what the user types.
 * @param {readonly Route[]} routes
 * @param {number} i  0-based
 * @param {{ workspaces?: readonly string[], skip?: readonly string[] }} [options]
 * @returns {Route | null}
 */
export function shadowedBy(routes, i, options = {}) {
  const rule = routes[i];
  if (!rule) return null;
  for (const j of routes.slice(0, i)) {
    if (!usable(j, options)) continue;
    if (j.app !== undefined && j.app !== rule.app) continue;
    if (covers(j, rule)) return j;
  }
  return null;
}

/**
 * `[routing] default_workspace` for a link from another program that no rule matched, when its
 * workspace exists and is not passed over (app-routes, decision 16); else null.
 * @param {string | null} name
 * @param {{ workspaces: readonly string[], skip?: readonly string[] }} options
 * @returns {string | null}
 */
export function defaultWorkspaceFor(name, { workspaces, skip = [] }) {
  return name !== null && workspaces.includes(name) && !skip.includes(name) ? name : null;
}

/**
 * What a rule matches, for `:route` and about:vimma: `app discord, domain youtube.com`.
 * @param {Route} route
 */
export function describeRoute(route) {
  const parts = [];
  if (route.app !== undefined) parts.push(`app ${route.app}`);
  if (route.domain) {
    const d = route.domain;
    const host = d.ip && d.host.includes(":") ? `[${d.host}]` : d.host;
    parts.push(`domain ${d.sub ? "*." : ""}${host}`);
  }
  if (route.url !== undefined) parts.push(`url ${route.url}`);
  return parts.join(", ");
}

/**
 * The `domain` `:route add` writes for a page: its host without a leading `www.`; null for a
 * page that is not http(s).
 * @param {string} url
 * @returns {string | null}
 */
export function routeDomainFor(url) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  return host.startsWith("www.") ? host.slice(4) : host;
}

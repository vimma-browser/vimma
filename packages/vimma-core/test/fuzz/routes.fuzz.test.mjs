// Fuzzing workspace routing (routes.mjs): `[[routes]]` rules and the URLs they match. A rule
// that matched a host outside its domain would open that site with the workspace's cookies.
// Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  describeRoute,
  isAppToken,
  matchRoute,
  MAX_APPS,
  parseAppList,
  resolveRoutes,
  routeDomainFor,
  validateRoutes,
} from "../../src/routes.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.mjs";

const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,8}[a-z0-9])?$/);
/** A rule's domain: ASCII names, IDN names, a single label. */
const ruleDomain = fc.oneof(
  { weight: 3, arbitrary: fc.array(label, { minLength: 1, maxLength: 3 }).map((l) => l.join(".")) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "github.com",
      "google.com",
      "corp.example",
      "bücher.de",
      "xn--bcher-kva.de",
      "com",
      "co.uk",
    ),
  },
);

/**
 * Hosts that must never count as inside `domain`: lookalike names around it, and characters
 * from other scripts that IDNA does not map back to ASCII.
 * @param {string} domain
 */
const CONFUSABLES = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", i: "і", g: "ɡ" };
const evilAround = (/** @type {string} */ domain) =>
  fc.oneof(
    label.map((l) => `${l}-${domain}`),
    label.map((l) => `${l}${domain}`),
    label.map((l) => `${domain}.${l}`),
    label.map((l) => `${domain}${l}`),
    label.map((l) => `${domain}-${l}.com`),
    fc.constant(`${domain.replace(/\./g, "-")}.com`),
    fc.nat().map((n) => {
      const chars = [...domain];
      const at = chars.findIndex((c, i) => i >= n % chars.length && c in CONFUSABLES);
      const i = at >= 0 ? at : chars.findIndex((c) => c in CONFUSABLES);
      if (i < 0) return `x${domain}`;
      chars[i] = CONFUSABLES[/** @type {keyof typeof CONFUSABLES} */ (chars[i])];
      return chars.join("");
    }),
  );

/**
 * URLs whose real host is `evil`, dressed up with `domain` where a careless matcher looks:
 * userinfo, path, query, fragment, backslashes, percent-encoding, ports.
 * @param {string} domain
 * @param {string} evil
 */
const disguises = (domain, evil) => [
  `https://${evil}/`,
  `https://${domain}@${evil}/`,
  `https://${domain}:443@${evil}/`,
  `https://user:${domain}@${evil}/`,
  `https://${evil}/${domain}`,
  `https://${evil}/?${domain}`,
  `https://${evil}/#${domain}`,
  `https://${evil}\\@${domain}/`,
  `https://${evil}#@${domain}`,
  `https://${evil}?@${domain}`,
  `https://${evil}:8080/.${domain}`,
  `https://${domain}%2e${evil}/`,
  `https://${domain}%40${evil}/`,
  `http://${evil}./`,
  `HTTPS://${evil.toUpperCase()}/`,
  `https://${domain}.${evil}/`,
  `https://${domain}。${evil}/`, // ideographic full stop: IDNA makes it a dot
  `https://[::1]/${domain}`,
  `https://127.0.0.1/${domain}`,
  `ftp://${domain}/`,
  `javascript://${domain}/%0aalert(1)`,
  `file://${domain}/etc/passwd`,
];

/**
 * The real host's labels end with the domain's labels (the oracle, from the URL parser).
 * @param {string} url
 * @param {string} host  the rule's host as resolved (ASCII)
 * @param {boolean} sub  `*.` rules: strictly below
 */
function inside(url, host, sub) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const have = u.hostname.toLowerCase().replace(/\.$/, "").split(".");
  const want = host.split(".");
  if (have.length < want.length + (sub ? 1 : 0)) return false;
  return want.every((l, i) => have[have.length - want.length + i] === l);
}

describe("routing rule fuzzing", () => {
  test(
    "a domain rule never matches a URL whose host is outside its domain",
    () =>
      fuzz(
        "routes-never-outside",
        fc.property(
          ruleDomain.chain((d) => fc.tuple(fc.constant(d), fc.boolean(), evilAround(d))),
          ([domain, sub, evil]) => {
            const rule = { domain: `${sub ? "*." : ""}${domain}`, workspace: "w" };
            fc.pre(validateRoutes([rule]).length === 0);
            const [route] = resolveRoutes([rule]);
            const host = /** @type {NonNullable<typeof route>} */ (route).domain?.host ?? "";
            for (const url of disguises(domain, evil)) {
              const hit = matchRoute([/** @type {any} */ (route)], { url }) !== null;
              expect(hit, `${url} against ${sub ? "*." : ""}${domain}`).toBe(
                inside(url, host, sub),
              );
            }
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "a domain rule matches its own host and subdomains, however written",
    () =>
      fuzz(
        "routes-matches-inside",
        fc.property(ruleDomain, fc.array(label, { maxLength: 3 }), (domain, subs) => {
          fc.pre(validateRoutes([{ domain, workspace: "w" }]).length === 0);
          const [route] = resolveRoutes([{ domain, workspace: "w" }]);
          const host = [...subs, domain].join(".");
          // Labels the URL parser refuses (`xn--0`) are no host at all.
          fc.pre(URL.canParse(`https://${host}/`));
          for (const url of [
            `https://${host}/`,
            `http://${host.toUpperCase()}./x?y#z`,
            `https://user:pw@${host}:8443/`,
          ]) {
            expect(matchRoute([/** @type {any} */ (route)], { url }), url).not.toBeNull();
          }
        }),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "matchRoute never throws, for any URL text, app and rules that validate",
    () =>
      fuzz(
        "routes-match-no-throw",
        fc.property(
          fc.array(
            fc.record(
              {
                domain: fc.oneof(ruleDomain, nastyString),
                url: fc.oneof(
                  fc.constantFrom("https://a.com/x", "file:///home/", "about:config"),
                  nastyString,
                ),
                app: fc.oneof(fc.constantFrom("discord", "slack"), nastyString),
                workspace: fc.oneof(fc.constantFrom("w", ...PROTO_NAMES), nastyString),
              },
              { requiredKeys: ["workspace"] },
            ),
            { maxLength: 4 },
          ),
          fc.oneof(nastyString, fc.webUrl({ withQueryParameters: true, withFragments: true })),
          fc.option(fc.oneof(nastyString, fc.constantFrom("discord", ...PROTO_NAMES)), {
            nil: null,
          }),
          (rules, url, app) => {
            const valid = rules.filter((r) => validateRoutes([r]).length === 0);
            const routes = within(1000, () => resolveRoutes(valid));
            const apps = app === null ? [] : [app];
            const hit = within(1000, () =>
              matchRoute(routes, { url, apps }, { workspaces: ["w"] }),
            );
            if (hit) {
              expect(hit.workspace).toBe("w");
              if (hit.app !== undefined) expect(isAppToken(app) && hit.app === app).toBe(true);
            }
            for (const r of routes) {
              expect(typeof describeRoute(r)).toBe("string");
              if (r.domain) expect(r.domain.host).toMatch(/^[a-z0-9_.:-]+$/);
            }
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "validateRoutes never throws and accepts only what resolveRoutes can resolve",
    () =>
      fuzz(
        "routes-validate",
        fc.property(
          fc.oneof(
            fc.array(
              fc.dictionary(
                fc.oneof(fc.constantFrom("domain", "url", "app", "workspace"), nastyString),
                fc.oneof(nastyString, fc.jsonValue({ maxDepth: 1 })),
              ),
            ),
            fc.jsonValue({ maxDepth: 2 }),
          ),
          (value) => {
            const problems = within(1000, () => validateRoutes(value));
            for (const p of problems) {
              expect(Array.isArray(p.path)).toBe(true);
              expect(typeof p.message).toBe("string");
            }
            if (problems.length === 0 && Array.isArray(value)) {
              const routes = resolveRoutes(/** @type {any} */ (value));
              for (const r of routes) {
                if ("domain" in r) expect(r.domain).not.toBeNull();
                if ("url" in r) expect(r.url).not.toBeNull();
              }
            }
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "parseAppList returns only tokens, at most eight, never two equal neighbours",
    () =>
      fuzz(
        "routes-app-list",
        fc.property(
          fc.oneof(
            nastyString,
            fc
              .array(fc.oneof(fc.constantFrom("zsh", "herdr", "Ghostty", "", "a b"), nastyString))
              .map((a) => a.join(",")),
          ),
          (raw) => {
            const names = within(1000, () => parseAppList(raw));
            expect(names.length).toBeLessThanOrEqual(MAX_APPS);
            names.forEach((n, i) => {
              expect(isAppToken(n)).toBe(true);
              if (i > 0) expect(n).not.toBe(names[i - 1]);
            });
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "routeDomainFor never throws and gives a domain rule that matches the page",
    () =>
      fuzz(
        "routes-domain-for",
        fc.property(fc.oneof(fc.webUrl(), nastyString), (url) => {
          const domain = routeDomainFor(url);
          if (domain === null) return;
          if (validateRoutes([{ domain, workspace: "w" }]).length) return;
          const [route] = resolveRoutes([{ domain, workspace: "w" }]);
          expect(matchRoute([/** @type {any} */ (route)], { url })).not.toBeNull();
        }),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "very long rules and URLs are checked in bounded time",
    () => {
      const long = "a.".repeat(512 * 1024);
      const rules = [
        { domain: `${long}com`, workspace: "w" },
        { domain: `*.${"x".repeat(1024 * 1024)}`, workspace: "w" },
        { domain: `[${":".repeat(1024 * 1024)}g]`, workspace: "w" },
        { url: `https://a.com/${"%".repeat(1024 * 1024)}`, workspace: "w" },
        { app: "a".repeat(1024 * 1024), workspace: "w" },
        { domain: `https://${long}`, workspace: "w" },
      ];
      const ok = within(5000, () => rules.filter((r) => validateRoutes([r]).length === 0));
      const routes = resolveRoutes([{ domain: "github.com", workspace: "w" }, ...ok]);
      within(5000, () =>
        matchRoute(routes, { url: `https://${long}github.com/${"/".repeat(1 << 20)}` }),
      );
    },
    FUZZ_TIMEOUT,
  );
});

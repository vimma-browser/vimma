// Fuzzing config.toml: smol-toml's parse, Vimma's schema validation, migrations and the line
// locator (config.mjs, toml.mjs). Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  CONTAINER_COLORS,
  CONTAINER_ICONS,
  MAX_WORKSPACE_NAME,
  appendRouteText,
  migrate,
  parseConfig,
  reloadConfig,
} from "../../src/config.mjs";
import { formatPath, parsePath, parseToml } from "../../src/toml.mjs";
import { PALETTE_KEYS } from "../../src/theme.mjs";
import { INSERT_SITE_MODES } from "../../src/editable.mjs";
import { PANES_MAX_LIMIT } from "../../src/panes.mjs";
import { resolveDownloadDir } from "../../src/agent-downloads.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.mjs";
import { configText } from "./toml-arb.mjs";

/** @param {import("../../src/config.mjs").ParseResult} r */
function expectWellFormed(r) {
  expect(Array.isArray(r.errors)).toBe(true);
  expect(r.config === null).toBe(r.errors.length > 0);
  expect(r.keymap === null).toBe(r.errors.length > 0);
  for (const e of r.errors) {
    expect(typeof e.path).toBe("string");
    expect(typeof e.message).toBe("string");
    if (e.line !== undefined) expect(Number.isInteger(e.line) && e.line >= 1).toBe(true);
  }
}

const HEX6 = /^#[0-9a-f]{6}$/;

/**
 * Everything an accepted config may contain, checked independently of config.mjs: what the
 * schema allows and nothing else (no function, no prototype object, no stray type).
 * @param {import("../../src/config.mjs").ResolvedConfig} c
 */
function expectInSchema(c) {
  for (const w of c.workspaces) {
    expect(typeof w.name).toBe("string");
    expect([...w.name].length).toBeGreaterThanOrEqual(1);
    expect([...w.name].length).toBeLessThanOrEqual(MAX_WORKSPACE_NAME);
    expect(CONTAINER_COLORS, `colour ${String(w.color)}`).toContain(w.color);
    expect(CONTAINER_ICONS, `icon ${String(w.icon)}`).toContain(w.icon);
    expect(typeof w.autofill).toBe("boolean");
    if (w.home !== undefined) expect(w.home).toMatch(/^(?:https?:\/\/|about:)\S+$/);
  }
  expect(["omarchy", "file"]).toContain(c.theme.source);
  expect(typeof c.theme.font).toBe("string");
  expect(c.theme.font).not.toMatch(/["';{}\\<>]/);
  expect(
    [...c.theme.font].some(
      (ch) => /** @type {number} */ (ch.codePointAt(0)) < 0x20 || ch === "\x7f",
    ),
  ).toBe(false);
  for (const [k, v] of Object.entries(c.theme.colors)) {
    expect(PALETTE_KEYS).toContain(k);
    if (k === "mode") expect(["dark", "light"]).toContain(v);
    else expect(v).toMatch(HEX6);
  }
  expect(Number.isInteger(c.panes.max) && c.panes.max >= 1 && c.panes.max <= PANES_MAX_LIMIT).toBe(
    true,
  );
  for (const s of c.sites) expect(INSERT_SITE_MODES).toContain(s.insert);
  for (const r of c.routes) {
    expect(typeof r.workspace).toBe("string");
    if (r.domain) expect(r.domain.host).toMatch(/^[a-z0-9_.:-]+$/);
    if (r.url !== undefined) expect(r.url).not.toMatch(/^javascript:/i);
  }
  expect(c.firefox.disable === "all" || Array.isArray(c.firefox.disable)).toBe(true);
  expect(typeof c.insertEditing).toBe("boolean");
}

/**
 * Values for a schema-checked field: mostly valid ones, so that whole documents often pass and
 * reach the in-schema checks, then near misses, prototype member names and random text.
 * @param {string[]} valid
 * @param {string[]} [near]
 */
const fieldValue = (valid, near = []) =>
  fc.oneof(
    { weight: 40, arbitrary: fc.constantFrom(...valid).map((v) => JSON.stringify(v)) },
    ...(near.length
      ? [{ weight: 2, arbitrary: fc.constantFrom(...near).map((v) => JSON.stringify(v)) }]
      : []),
    { weight: 2, arbitrary: fc.constantFrom(...PROTO_NAMES).map((v) => JSON.stringify(v)) },
    { weight: 1, arbitrary: nastyString.map((v) => JSON.stringify(v)) },
    { weight: 1, arbitrary: fc.constantFrom("1", "true", "[]", "{}", "1.5", '["a"]') },
  );
/** @param {string[]} valid @param {fc.Arbitrary<string>} other */
const mostly = (valid, other) =>
  fc.oneof({ weight: 20, arbitrary: fc.constantFrom(...valid) }, { weight: 1, arbitrary: other });

/** Documents shaped like a real config.toml, with fuzzed values: they often validate. */
const schemaDoc = fc
  .record({
    ws: fc.array(
      fc.record({
        name: mostly(
          ["work", "home", "café"],
          fc.oneof(fc.constantFrom(...PROTO_NAMES), nastyString),
        ),
        color: fieldValue([...CONTAINER_COLORS, "turquoise", "toolbar"], ["Red", "grey"]),
        icon: fieldValue(CONTAINER_ICONS, ["Circle"]),
        home: fieldValue(
          ["https://example.com", "about:blank"],
          ["javascript:alert(1)", "http://a b"],
        ),
        autofill: mostly(["true", "false"], fc.constant('"yes"')),
      }),
      { maxLength: 3 },
    ),
    source: fieldValue(["omarchy", "file"]),
    font: fieldValue(["Caskaydia Mono", "monospace", "A, B, serif"], ["a;}body{x", "x\\", "a\nb"]),
    colorKey: mostly(
      PALETTE_KEYS.filter((k) => k !== "mode"),
      fc.constantFrom(...PROTO_NAMES),
    ),
    colorVal: fieldValue(["#7aa2f7", "#FFF", "#abcdef"], ["#12345", "red", "dark", "#fff;"]),
    panes: mostly(["1", "16", "2", "4"], fc.constantFrom("17", "0", "-3", "4.0", '"2"')),
    site: mostly(
      ["github.com", "[::1]", "a.b.example.", "127.0.0.1"],
      fc.oneof(fc.constantFrom("*.x.com", ...PROTO_NAMES), nastyString),
    ),
    insert: fieldValue(INSERT_SITE_MODES),
    domain: fieldValue(
      ["github.com", "*.corp.example", "bücher.de", "[::1]"],
      ["evil.com/github.com", "a@b.com"],
    ),
    workspace: fieldValue(["work", "home"]),
    disable: mostly(
      ['"all"', '["ctrl+w"]', "[]"],
      fc.constantFrom('["constructor"]', "[1]", '"none"'),
    ),
    leader: fieldValue(["space", "ctrl+b", "alt+x"], ["constructor", "ctrl+", "<C-a>"]),
  })
  .map((d) =>
    [
      "schema = 2",
      ...d.ws.flatMap((w) => [
        `[workspaces.${JSON.stringify(w.name)}]`,
        `color = ${w.color}`,
        `icon = ${w.icon}`,
        `home = ${w.home}`,
        `autofill = ${w.autofill}`,
      ]),
      "[theme]",
      `source = ${d.source}`,
      `font = ${d.font}`,
      "[theme.colors]",
      `${JSON.stringify(d.colorKey)} = ${d.colorVal}`,
      "[panes]",
      `max = ${d.panes}`,
      `[sites.${JSON.stringify(d.site)}]`,
      `insert = ${d.insert}`,
      "[modal]",
      `leader = ${d.leader}`,
      "[firefox]",
      `disable = ${d.disable}`,
      "[[routes]]",
      `domain = ${d.domain}`,
      `workspace = ${d.workspace}`,
      "",
    ].join("\n"),
  );

describe("config.toml fuzzing", () => {
  test(
    "parseConfig never throws, on any text, and its result is well-formed",
    () =>
      fuzz(
        "config-no-throw",
        fc.property(configText, (text) => {
          expectWellFormed(within(2000, () => parseConfig(text)));
        }),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "an accepted config holds only what the schema allows",
    () =>
      fuzz(
        "config-in-schema",
        fc.property(schemaDoc, (text) => {
          const r = within(2000, () => parseConfig(text));
          expectWellFormed(r);
          if (r.config) expectInSchema(r.config);
        }),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  // Regression (found by the fuzzer, seed 20261010): `color = "constructor"` passed the
  // `v in COLOR_ALIASES` check and the workspace's colour became the Object function.
  test("a workspace colour named after an Object member is an error, not a value", () => {
    for (const name of PROTO_NAMES) {
      const r = parseConfig(`[workspaces.w]\ncolor = ${JSON.stringify(name)}\n`);
      expect(r.config, name).toBeNull();
      expect(r.errors[0]?.path).toBe("workspaces.w.color");
    }
  });

  test(
    "a rejected text keeps the active config, the very same object",
    () => {
      const active = reloadConfig(null, "schema = 2\n").active;
      fuzz(
        "config-keeps-last-good",
        fc.property(configText, (text) => {
          const r = reloadConfig(active, text);
          if (r.kept) expect(r.active).toBe(active);
          else expect(r.errors).toEqual([]);
        }),
        { weight: 5 },
      );
    },
    FUZZ_TIMEOUT,
  );

  // docs/specs/vimma-mcp.md (M7 fuzzing): any [mcp] values; an accepted one is in its bounds.
  /**
   * @param {number | string} minutes
   * @param {number | string} max
   * @param {number | string} chars
   * @param {string} name
   */
  function checkMcpBounds(minutes, max, chars, name) {
    const text = [
      "schema = 2",
      "[mcp]",
      `grant_minutes = ${minutes}`,
      `grant_max_minutes = ${max}`,
      `max_read_chars = ${chars}`,
      `workspace = ${JSON.stringify(name)}`,
      "",
    ].join("\n");
    const r = within(2000, () => parseConfig(text));
    expectWellFormed(r);
    if (!r.config) return;
    const m = r.config.mcp;
    expect(m.grantMaxMinutes >= 1 && m.grantMaxMinutes <= 1440).toBe(true);
    expect(m.grantMinutes >= 0 && m.grantMinutes <= m.grantMaxMinutes).toBe(true);
    expect(m.maxReadChars >= 1000 && m.maxReadChars <= 500000).toBe(true);
    expect(m.workspace).toBe(name);
    expect(m.workspace).not.toBe("private");
    expect([...m.workspace].length).toBeGreaterThan(0);
  }

  // grant_minutes 0 is valid, the default since docs/specs/mcp-session-grants.md S1: a bare `a`
  // then grants the whole connection. The nightly fuzz run found this case (issue #625).
  test("[mcp] grant_minutes 0 is accepted and within its bounds", () => {
    checkMcpBounds(0, 1, 1000, "agent");
    checkMcpBounds(0, 1, 1000, "__proto__");
  });

  test(
    "[mcp] values are refused or within their bounds",
    () =>
      fuzz(
        "config-mcp-bounds",
        fc.property(
          fc.oneof(fc.integer({ min: -5, max: 2000 }), fc.constantFrom(0, "true", '"x"', "1.5")),
          fc.oneof(fc.integer({ min: -5, max: 2000 }), fc.constantFrom("0", '"10"')),
          fc.oneof(fc.integer({ min: 0, max: 600000 }), fc.constantFrom("false")),
          fc.oneof(nastyString, fc.constantFrom("agent", "private", "", ...PROTO_NAMES)),
          checkMcpBounds,
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  // docs/specs/vimma-mcp.md decision 31 b: an accepted download_dir is never home, / or the
  // Downloads folder itself, however it is spelt; download_max_mb stays in 1..4096.
  test(
    "[mcp] download_dir and download_max_mb are refused or a quarantine folder in bounds",
    () =>
      fuzz(
        "config-mcp-downloads",
        fc.property(
          fc.oneof(
            nastyString,
            fc
              .array(fc.constantFrom("~", "/", ".", "..", "Downloads", "downloads", "x", ""), {
                maxLength: 6,
              })
              .map((p) => p.join("/")),
          ),
          fc.oneof(fc.integer({ min: -5, max: 5000 }), fc.constantFrom('"9"', "1.5")),
          (dir, mb) => {
            const text = [
              "schema = 2",
              "[mcp]",
              `download_dir = ${JSON.stringify(dir)}`,
              `download_max_mb = ${mb}`,
              "",
            ].join("\n");
            const r = within(2000, () => parseConfig(text));
            expectWellFormed(r);
            if (!r.config) return;
            const m = r.config.mcp;
            expect(m.downloadMaxMb >= 1 && m.downloadMaxMb <= 4096).toBe(true);
            const home = "/home/u";
            const path = resolveDownloadDir(m.downloadDir, home);
            expect(["/", home, `${home}/Downloads`]).not.toContain(path);
            expect(path.toLowerCase()).not.toBe(`${home}/downloads`);
          },
        ),
        { weight: 3 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "migrations never change their input",
    () =>
      fuzz(
        "config-migrate-pure",
        fc.property(
          fc.dictionary(nastyString, fc.jsonValue({ maxDepth: 2 })),
          fc.nat(2),
          (raw, from) => {
            const before = structuredClone(raw);
            migrate(Object.freeze(raw), from);
            expect(raw).toEqual(before);
          },
        ),
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "parsePath(formatPath(path)) is path, for any keys and indices",
    () =>
      fuzz(
        "config-path-round-trip",
        fc.property(
          fc.array(fc.oneof(nastyString, fc.nat({ max: 1e6 })), { minLength: 1, maxLength: 6 }),
          (path) => {
            expect(parsePath(formatPath(path))).toEqual(path);
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    ":route add writes the domain and workspace as given, or refuses (security.md F4)",
    () =>
      fuzz(
        "config-route-add",
        fc.property(
          fc.oneof(fc.constantFrom("github.com", "*.corp.example"), nastyString),
          fc.oneof(fc.constantFrom("work", ...PROTO_NAMES), nastyString),
          fc.constantFrom("schema = 2\n", "schema = 2\n[workspaces.work]\n", ""),
          (domain, workspace, before) => {
            const out = appendRouteText(before, { domain, workspace });
            if (!("append" in out)) return;
            const r = parseConfig(before + out.append);
            expect(r.errors).toEqual([]);
            const route = r.config?.routes.at(-1);
            expect(route?.workspace).toBe(workspace);
            // One rule added, nothing else: the text cannot have smuggled in a second key.
            expect(r.config?.routes.length).toBe(1);
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "huge and deeply nested files are refused or read in bounded time",
    () => {
      const cases = {
        "deep arrays": `a = ${"[".repeat(5000)}${"]".repeat(5000)}`,
        "deep arrays at the parser's limit": `a = ${"[".repeat(999)}${"]".repeat(999)}`,
        "deep inline tables": `a = ${"{ b = ".repeat(2000)}1${" }".repeat(2000)}`,
        // Regression: smol-toml's maxDepth bounds inline values only, so dotted keys and table
        // headers nested without limit; toNumbers overflowed the stack at 20,000 levels and
        // locateKeys took quadratic time and memory (out of memory at 100,000).
        "deep dotted key": `${"a.".repeat(20_000)}b = 1`,
        "deep table header": `[${"a.".repeat(20_000)}b]`,
        "deep table array header": `[[${"a.".repeat(20_000)}b]]`,
        "deep mixed nesting": `[${"a.".repeat(20)}b]\nc.d.e = ${"[{x = ".repeat(10)}1${"}]".repeat(10)}`,
        "a 4 MiB string": `font = "${"x".repeat(4 * 1024 * 1024)}"`,
        "20,000 keys": Array.from({ length: 20_000 }, (_, i) => `k${i} = ${i}`).join("\n"),
        "5,000 routes": `schema = 2\n${'[[routes]]\ndomain = "a.com"\nworkspace = "w"\n'.repeat(5000)}`,
        "5,000 workspaces": Array.from({ length: 5000 }, (_, i) => `[workspaces.w${i}]`).join("\n"),
        "a 1 MiB comment": `# ${"#".repeat(1024 * 1024)}`,
        "unclosed brackets": "a = [".repeat(50_000),
        // Regression: the [sites] IPv6 pattern backtracked quadratically (minutes at 512 KiB).
        "a long IPv6-like site": `schema = 2\n[sites."[${":".repeat(512 * 1024)}g"]\ninsert = "auto"\n`,
        "a long bracketed site": `schema = 2\n[sites."[${"1:".repeat(256 * 1024)}]"]\ninsert = "auto"\n`,
        // Regression (#196): an unknown key or value gets a "did you mean" suggestion, and the
        // edit distance of a megabyte against every known name took seconds under coverage.
        "a long unknown key": `${"k".repeat(1024 * 1024)} = 1`,
        "a long workspace colour": `[workspaces.w]\ncolor = "${"x".repeat(1024 * 1024)}"`,
        "a long workspace icon": `[workspaces.w]\nicon = "${"x".repeat(1024 * 1024)}"`,
        "a long theme source": `[theme]\nsource = "${"x".repeat(1024 * 1024)}"`,
        "a long unbind mode": `[unbind.${"x".repeat(1024 * 1024)}]`,
        "a long route key": `schema = 2\n[[routes]]\n${"x".repeat(1024 * 1024)} = "a"`,
      };
      for (const [name, text] of Object.entries(cases)) {
        const r = within(5000, () => parseConfig(text), name);
        expectWellFormed(r);
        expect(typeof parseToml(text).ok, name).toBe("boolean");
      }
    },
    FUZZ_TIMEOUT,
  );
});

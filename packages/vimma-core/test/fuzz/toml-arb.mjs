/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TOML documents for fuzzing: mostly well-formed, built from the keys Vimma's schemas know,
 * prototype member names and random text, so the validators past the TOML parser see input
 * often enough. A share of documents is then mangled (cut, a byte swapped) for the parser.
 */
import fc from "fast-check";
import { PALETTE_KEYS } from "../../src/theme.mjs";
import { PROTO_NAMES, nastyString } from "./harness.mjs";

const SCHEMA_KEYS = [
  "schema",
  "keys",
  "modal",
  "unbind",
  "workspaces",
  "theme",
  "panes",
  "sites",
  "routes",
  "firefox",
  "color",
  "icon",
  "home",
  "autofill",
  "source",
  "font",
  "colors",
  "max",
  "insert",
  "leader",
  "timeout_ms",
  "hint_chars",
  "insert_editing",
  "disable",
  "enable",
  "domain",
  "url",
  "app",
  "workspace",
  "normal",
  "visual",
  "command",
  "new_tab",
  "close_tab",
  "prev_workspace",
  "work",
  "github.com",
  ...PALETTE_KEYS,
];

/** A key segment: bare, "basic" or 'literal'. */
const keySeg = fc
  .tuple(
    fc.oneof(
      { weight: 6, arbitrary: fc.constantFrom(...SCHEMA_KEYS) },
      { weight: 3, arbitrary: fc.constantFrom(...PROTO_NAMES) },
      { weight: 2, arbitrary: nastyString },
    ),
    fc.constantFrom("bare", "basic", "literal"),
  )
  .map(([k, style]) => {
    if (style === "bare" && /^[A-Za-z0-9_-]+$/.test(k)) return k;
    // A literal string holds no ' and no control character but tab.
    const literalOk = ![...k].some((c) => c === "'" || c === "\x7f" || (c < " " && c !== "\t"));
    if (style === "literal" && literalOk) {
      return `'${k}'`;
    }
    return JSON.stringify(k);
  });
const key = fc.array(keySeg, { minLength: 1, maxLength: 3 }).map((s) => s.join("."));

const scalar = fc.oneof(
  fc.constantFrom(
    '"red"',
    '"cyan"',
    '"turquoise"',
    '"circle"',
    '"omarchy"',
    '"file"',
    '"auto"',
    '"all"',
    '"ctrl+w"',
    '"constructor"',
    '"__proto__"',
    '"https://example.com"',
    '"javascript:alert(1)"',
    '"#7aa2f7"',
    '"#fff"',
    '"dark"',
    '"light"',
    '"ctrl+b"',
    '"<leader>ff"',
    '"github.com"',
    '"*.corp.example"',
    "2",
    "1",
    "0",
    "-1",
    "99999999999999999999",
    "1.0",
    "inf",
    "nan",
    "true",
    "false",
    "1979-05-27T07:32:00Z",
    "0x7f",
  ),
  nastyString.map((s) => JSON.stringify(s)),
  fc.integer().map(String),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .map((n) => (Number.isInteger(n) ? `${n}.0` : String(n))),
  fc.string({ maxLength: 20 }).map((s) => `'''${s.replace(/'''/g, "")}'''`),
  fc.string({ maxLength: 20 }).map((s) => `"""${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"""`),
);

/** @type {fc.LetrecTypedBuilder<{ value: string }>} */
const valueBuilder = (tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 6, arbitrary: scalar },
    {
      weight: 1,
      arbitrary: fc
        .array(tie("value"), { maxLength: 4 })
        .chain((items) =>
          fc.constantFrom(`[${items.join(", ")}]`, `[\n  ${items.join(",\n  ")},\n]`),
        ),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(fc.tuple(key, tie("value")), { maxLength: 3 })
        .map((kvs) => `{ ${kvs.map(([k, v]) => `${k} = ${v}`).join(", ")} }`),
    },
  ),
});
const value = fc.letrec(valueBuilder).value;

const line = fc.oneof(
  { weight: 6, arbitrary: fc.tuple(key, value).map(([k, v]) => `${k} = ${v}`) },
  { weight: 2, arbitrary: key.map((k) => `[${k}]`) },
  { weight: 1, arbitrary: key.map((k) => `[[${k}]]`) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("[[routes]]", "schema = 2", "schema = 1", "[workspaces.work]"),
  },
  { weight: 1, arbitrary: nastyString.map((s) => `# ${s.replace(/[\n\r]/g, "")}`) },
  { weight: 1, arbitrary: fc.constant("") },
);

/** A TOML document: lines, maybe CRLF, maybe a BOM; a share of them mangled. */
export const tomlDoc = fc
  .tuple(
    fc.array(line, { maxLength: 14 }),
    fc.constantFrom("\n", "\r\n"),
    fc.boolean(),
    fc.option(
      fc.tuple(fc.nat(), fc.constantFrom("", "[", "]", '"', "'", "=", "\n", "{", "\\", "\0")),
      {
        freq: 4,
      },
    ),
  )
  .map(([lines, nl, bom, mangle]) => {
    let text = (bom ? "﻿" : "") + lines.join(nl) + nl;
    if (mangle) {
      const [at, ch] = mangle;
      const i = at % (text.length + 1);
      text = text.slice(0, i) + ch + text.slice(i + 1);
    }
    return text;
  });

/** Any text at all, or a TOML document. */
export const configText = fc.oneof(
  { weight: 4, arbitrary: tomlDoc },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 200 }) },
);

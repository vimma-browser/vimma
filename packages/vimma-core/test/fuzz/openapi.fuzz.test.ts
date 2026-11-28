// Fuzzing the agent APIs' converter and reply shaper (docs/specs/agent-apis.md, decisions 10,
// 13 and 14): a description and a reply are files from the network that anyone can publish, so
// neither may make the code throw anything but its own refusal, run past its budget, pollute a
// prototype, put a long or unprintable name into an index, or let the token or a second
// delimiter reach the agent.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../../src/agent/agent.mjs";
import {
  FIND_LIMIT,
  OpenApiError,
  SIGNATURE_CHARS,
  buildIndex,
  findOperations,
  indexDescription,
  operationLine,
  operationSignature,
  selectOperations,
} from "../../src/api/openapi-index.mjs";
import { ApiReplyError, TOKEN_MARK, shapeReply } from "../../src/api/api-reply.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, throwsOnly, within } from "./harness.ts";

const name = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,10}$/) },
  { weight: 2, arbitrary: nastyString },
  { weight: 1, arbitrary: fc.constantFrom(...PROTO_NAMES) },
);
const ref = fc.oneof(
  name.map((n) => `#/components/schemas/${n}`),
  name.map((n) => `#/components/parameters/${n}`),
  fc.constantFrom(
    "#/components/schemas/A",
    "#/components/schemas/B",
    "#/",
    "#",
    "",
    "#/paths",
    "#/components/schemas/A/properties/next",
    "#/components/schemas/__proto__/x",
    "https://evil.example/schema.json",
    "#/components/schemas/a~1b~0",
  ),
);
const leaf = fc.oneof(
  nastyString,
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constantFrom("string", "integer", "object", "array", "null", "application/json"),
);

/** A schema: real keywords, references (cycles included), and junk in any place. */
const { schema } = fc.letrec((tie) => ({
  schema: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.record({ $ref: ref }),
    fc.record(
      {
        type: fc.oneof(
          fc.constantFrom("string", "integer", "object", "array", "boolean"),
          fc.array(fc.constantFrom("string", "null", "object"), { maxLength: 3 }),
          leaf,
        ),
        format: nastyString,
        nullable: fc.boolean(),
        description: nastyString,
        enum: fc.array(leaf, { maxLength: 30 }),
        required: fc.oneof(fc.array(name, { maxLength: 4 }), leaf),
        properties: fc.oneof(fc.dictionary(name, tie("schema"), { maxKeys: 5 }), leaf),
        items: tie("schema"),
        allOf: fc.array(tie("schema"), { maxLength: 3 }),
        oneOf: fc.array(tie("schema"), { maxLength: 3 }),
        anyOf: fc.oneof(fc.array(tie("schema"), { maxLength: 3 }), leaf),
      },
      { requiredKeys: [] },
    ),
  ),
}));

const parameter = fc.oneof(
  fc.record({ $ref: ref }),
  fc.record(
    {
      name,
      in: fc.oneof(fc.constantFrom("path", "query", "header", "cookie"), leaf),
      required: fc.oneof(fc.boolean(), leaf),
      description: nastyString,
      schema,
    },
    { requiredKeys: [] },
  ),
  leaf,
);

const mediaKey = fc.oneof(
  fc.constantFrom(
    "application/json",
    "application/x-www-form-urlencoded",
    "application/vnd.api+json; charset=utf-8",
    "multipart/form-data",
    "application/octet-stream",
    "APPLICATION/JSON",
  ),
  nastyString,
);

const operation = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record(
      {
        operationId: fc.oneof(name, fc.constantFrom("dup", "get-a", "")),
        summary: nastyString,
        description: fc.oneof(nastyString, fc.constant(`<p>${"word ".repeat(50)}</p>`)),
        tags: fc.oneof(fc.array(fc.oneof(name, leaf), { maxLength: 4 }), leaf),
        parameters: fc.oneof(fc.array(parameter, { maxLength: 6 }), leaf),
        requestBody: fc.oneof(
          fc.record({ $ref: ref }),
          fc.record(
            {
              required: fc.oneof(fc.boolean(), leaf),
              content: fc.oneof(
                fc.dictionary(mediaKey, fc.record({ schema }), { maxKeys: 3 }),
                leaf,
              ),
            },
            { requiredKeys: [] },
          ),
          leaf,
        ),
      },
      { requiredKeys: [] },
    ),
  },
  { weight: 1, arbitrary: leaf },
);

const pathKey = fc.oneof(
  fc
    .array(
      fc.oneof(
        name,
        name.map((n) => `{${n}}`),
        fc.constantFrom("..", ".", "", "{", "}"),
      ),
      {
        maxLength: 4,
      },
    )
    .map((segs) => `/${segs.join("/")}`),
  nastyString,
  fc.constantFrom(...PROTO_NAMES),
);

const pathItem = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record(
      {
        parameters: fc.oneof(fc.array(parameter, { maxLength: 3 }), leaf),
        get: operation,
        post: operation,
        put: operation,
        delete: operation,
        patch: operation,
        head: operation,
        trace: operation,
        $ref: fc.constantFrom("#/components/pathItems/P", "#/paths", "#"),
      },
      { requiredKeys: [] },
    ),
  },
  { weight: 1, arbitrary: leaf },
);

/** A description: mostly well formed, with hostile values in every place. */
const description = fc.record(
  {
    openapi: fc.oneof(
      { weight: 6, arbitrary: fc.constantFrom("3.0.0", "3.0.3", "3.1.0", "3.1.1") },
      { weight: 1, arbitrary: leaf },
    ),
    swagger: fc.constantFrom("2.0"),
    info: fc.record({ title: nastyString, version: nastyString }, { requiredKeys: [] }),
    servers: fc.oneof(
      fc.array(fc.oneof(fc.record({ url: fc.oneof(nastyString, fc.webUrl()) }), leaf), {
        maxLength: 3,
      }),
      leaf,
    ),
    paths: fc.oneof(
      { weight: 8, arbitrary: fc.dictionary(pathKey, pathItem, { maxKeys: 8 }) },
      { weight: 1, arbitrary: leaf },
    ),
    components: fc.record(
      {
        schemas: fc
          .dictionary(fc.oneof(name, fc.constantFrom("A", "B", "a/b~")), schema, { maxKeys: 5 })
          .map((s) => ({
            ...s,
            // A cycle through properties and one of bare references, in every description.
            A: {
              type: "object",
              properties: {
                next: { $ref: "#/components/schemas/A" },
                b: { $ref: "#/components/schemas/B" },
              },
            },
            B: { $ref: "#/components/schemas/A/properties/b" },
          })),
        parameters: fc.dictionary(name, parameter, { maxKeys: 3 }),
        pathItems: fc.record({ P: pathItem }),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: ["openapi", "paths"] },
);

const PRINTABLE = /^[\x21-\x7e]+$/;

/** What every index must hold, whatever the description. */
function expectSoundIndex(index: ReturnType<typeof buildIndex>, query: string) {
  expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  const seen = new Set<string>();
  for (const o of index.operations) {
    expect(o.id).toMatch(PRINTABLE);
    expect(o.id.length).toBeLessThanOrEqual(100);
    expect(seen.has(o.id)).toBe(false);
    seen.add(o.id);
    expect(o.path.startsWith("/")).toBe(true);
    expect(o.path).toMatch(PRINTABLE);
    expect(o.path.split("/")).not.toContain("..");
    expect([...o.summary].length).toBeLessThanOrEqual(80);
    expect(o.summary).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    for (const t of o.tags) expect(t).toMatch(/^[\x20-\x7e]{1,40}$/);
    for (const p of o.params) {
      expect(p.name).toMatch(PRINTABLE);
      expect(p.name.length).toBeLessThanOrEqual(64);
      expect(["path", "query"]).toContain(p.in);
    }
    for (const f of o.body?.fields ?? []) expect(f.name).toMatch(PRINTABLE);
    expect(o.signature.length).toBeLessThanOrEqual(SIGNATURE_CHARS);
    expect((operationSignature(index, o.id) ?? "").length).toBeLessThanOrEqual(SIGNATURE_CHARS);
    expect(operationLine(o)).not.toContain("\n");
  }
  expect(findOperations(index, query).length).toBeLessThanOrEqual(FIND_LIMIT);
  expect(selectOperations(index, [query]).operations.length).toBeLessThanOrEqual(
    index.operations.length,
  );
}

describe("OpenAPI converter fuzzing", () => {
  test(
    "no description makes the converter throw or run past its budget",
    () =>
      fuzz(
        "openapi-index-object",
        fc.property(description, nastyString, (doc, query) => {
          let index: ReturnType<typeof buildIndex> | undefined;
          throwsOnly(() => {
            index = within(500, () => buildIndex(doc), "buildIndex");
          }, OpenApiError);
          if (index) expectSoundIndex(index, query);
        }),
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "no text makes indexDescription throw anything but its refusal",
    () =>
      fuzz(
        "openapi-index-text",
        fc.property(
          fc.oneof(
            { weight: 3, arbitrary: description.map((d) => JSON.stringify(d)) },
            { weight: 1, arbitrary: fc.json() },
            { weight: 1, arbitrary: nastyString },
            {
              weight: 1,
              arbitrary: fc
                .integer({ min: 1, max: 50_000 })
                .map(
                  (n) =>
                    `{"openapi":"3.0.0","paths":{"/a":{"get":{"parameters":${"[".repeat(n)}${"]".repeat(n)}}}}}`,
                ),
            },
          ),
          (text) => {
            let index: ReturnType<typeof buildIndex> | undefined;
            throwsOnly(() => {
              index = within(500, () => indexDescription(text), "indexDescription");
            }, OpenApiError);
            if (index) expectSoundIndex(index, text.slice(0, 40));
          },
        ),
      ),
    FUZZ_TIMEOUT,
  );
});

const token = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_]{8,40}$/),
  fc.constantFrom("ghp_abcdefghijklmnopqrstuvwxyz0123", "sk_test_123456789"),
);

describe("API reply fuzzing", () => {
  test(
    "no reply makes the shaper throw, leak the token or add a delimiter",
    () =>
      fuzz(
        "api-reply",
        fc.property(
          token,
          fc.oneof(fc.json(), nastyString, fc.string({ unit: "binary", maxLength: 300 })),
          fc.array(fc.oneof(name, fc.constantFrom(UNTRUSTED_OPEN, UNTRUSTED_CLOSE, "[token]")), {
            maxLength: 6,
          }),
          fc.option(
            fc.array(fc.oneof(name, fc.constantFrom("a.b", "items.number", "__proto__.x")), {
              maxLength: 5,
            }),
          ),
          fc.constantFrom(
            "application/json",
            "text/plain",
            "text/html",
            "application/problem+json",
            "image/png",
            "",
          ),
          fc.integer({ min: 1000, max: 3000 }),
          (secret, base, inserts, fields, contentType, maxChars) => {
            // The token and delimiters spliced into the text at places the inserts choose.
            let text = base;
            for (const [i, part] of inserts.entries()) {
              const at = (i * 7919) % (text.length + 1);
              text = `${text.slice(0, at)}${i % 2 ? secret : part}${text.slice(at)}`;
            }
            let out: ReturnType<typeof shapeReply> | undefined;
            throwsOnly(() => {
              out = within(500, () =>
                shapeReply({
                  method: "GET",
                  url: "https://api.example/x",
                  status: 200,
                  contentType,
                  text,
                  fields,
                  maxChars,
                  token: secret,
                }),
              );
            }, ApiReplyError);
            if (!out) return;
            expect(out.body).not.toContain(secret);
            expect(out.header).not.toContain(secret);
            expect(out.header).not.toContain("\n");
            expect(out.body.split(UNTRUSTED_OPEN)).toHaveLength(2);
            expect(out.body.split(UNTRUSTED_CLOSE)).toHaveLength(2);
            const inner = out.body.slice(UNTRUSTED_OPEN.length + 1, -(UNTRUSTED_CLOSE.length + 1));
            // The cap, plus the zero-width spaces that break look-alike delimiters.
            expect(inner.replaceAll("​", "").length).toBeLessThanOrEqual(maxChars);
            expect(TOKEN_MARK).not.toContain(secret);
          },
        ),
      ),
    FUZZ_TIMEOUT,
  );
});

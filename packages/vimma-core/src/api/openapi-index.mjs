/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The converter of agent APIs (docs/specs/agent-apis.md, decisions 10, 12 and 14): a service's
 * OpenAPI 3.0 or 3.1 description in, a compact operation index out, and the search
 * vimma_api_find runs over it.
 *
 * A description is a file from the network that anyone can publish or mirror with one line
 * changed, so nothing in it is trusted:
 * - it is read only through own properties (`own`), so `__proto__` or `constructor` are ordinary
 *   keys, and nothing from it is ever used as a key to assign;
 * - every walk is bounded: references are followed MAX_REF_HOPS times in a row and schemas
 *   rendered SCHEMA_LEVELS deep, with a character budget, so a cycle or a deep nest ends;
 * - ids, tags, paths and parameter names are kept only when printable and short, so a line of a
 *   result cannot carry a paragraph of instructions; summaries and descriptions are one line,
 *   cut, without controls or markup, and reach the agent inside the untrusted-content delimiters
 *   (the caller's job).
 *
 * The index is plain JSON-able data, since it is built in a worker, posted back and cached on
 * disk (decision 9); `INDEX_VERSION` keys that cache. `only` and `read_ops` are the user's and
 * change without a new download, so they apply to a built index (`selectOperations`, `isRead`)
 * rather than being built in.
 */

/** Bumped whenever the index's shape or content changes, so a cached index is built again. */
export const INDEX_VERSION = 1;
/** The longest description text read (GitHub's, the largest measured, is 14.28 MB). */
export const MAX_DESCRIPTION_CHARS = 32 * 1024 * 1024;
/** Operations kept from one description (GitHub's has 1,281); the rest are left out. */
export const MAX_OPERATIONS = 5000;
/** Lines one search returns (behaviour 10). */
export const FIND_LIMIT = 8;
/** Characters of an operation's summary (behaviour 10). */
export const SUMMARY_CHARS = 80;
/** The longest signature of one operation (behaviour 10). */
export const SIGNATURE_CHARS = 6000;
/** How deep a body's schema is shown in a signature (behaviour 10). */
export const SCHEMA_LEVELS = 3;

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const MAX_ID = 100;
const MAX_NAME = 64;
const MAX_TAG = 40;
const MAX_TAGS = 10;
const MAX_PATH = 512;
const MAX_PARAMS = 100;
const MAX_FIELDS = 200;
const MAX_ENUM = 20;
const MAX_ENUM_VALUE = 40;
const MAX_DESCRIPTION = 120;
const MAX_SERVERS = 10;
const MAX_SERVER = 300;
const MAX_REF_HOPS = 8;
const MAX_REF = 512;
const MAX_ALTERNATIVES = 8;
const MAX_MERGED = 16;
/** Names listed in one line before "+N more". */
const LINE_NAMES = 20;
const MAX_QUERY = 200;
const MAX_QUERY_WORDS = 10;

/** Printable ASCII without spaces: operation ids, parameter and field names. */
const NAME = /^[\x21-\x7e]+$/;
/** Printable ASCII with spaces: tags. */
const TAG = /^[\x20-\x7e]+$/;
/** What a path may hold: printable ASCII without space, `?`, `#` or a backslash. */
const PATH_CHARS = /^\/[\x21-\x22\x24-\x3e\x40-\x5b\x5d-\x7e]*$/;
/** Controls, format characters (bidi overrides), line separators and lone surrogates. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
const MARKUP = /<[^<>]{0,200}>/g;

/** A description the converter refuses, with a message for the user or the agent. */
export class OpenApiError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "OpenApiError";
  }
}

/**
 * @typedef {{ name: string, in: "path" | "query", required: boolean, type: string }} Param
 * @typedef {{ name: string, required: boolean }} Field
 * @typedef {{ media: "json" | "form" | "other", contentType: string, required: boolean,
 *   fields: Field[] }} Body
 * @typedef {{ id: string, method: string, path: string, summary: string, tags: string[],
 *   params: Param[], body: Body | null, signature: string }} Operation
 * @typedef {{ version: number, openapi: string, title: string, servers: string[],
 *   operations: Operation[], dropped: number, truncated: boolean }} ApiIndex
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `obj[key]` when `obj` is a plain object that has `key` as its own property: never a value
 * from a prototype.
 * @param {unknown} obj @param {string} key
 */
const own = (obj, key) => (isObj(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** @param {unknown} v @param {number} max @param {RegExp} re */
const short = (v, max, re) =>
  typeof v === "string" && v.length <= max && v.length > 0 && re.test(v);

/** @param {string} s @param {number} max  cut to `max` code points, ending with … when cut */
function cut(s, max) {
  const chars = Array.from(s.length > max * 2 + 2 ? s.slice(0, max * 2 + 2) : s);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

/**
 * Text from the description as one line of at most `max` characters: markup, controls and
 * format characters removed, whitespace collapsed. Only the head of a long string is read.
 * @param {unknown} v @param {number} max
 */
function oneLine(v, max) {
  if (typeof v !== "string") return "";
  const head = v.length > max * 8 + 400 ? v.slice(0, max * 8 + 400) : v;
  const flat = head.replace(MARKUP, " ").replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  return cut(flat, max);
}

/**
 * The first sentence of a description, for an operation without a summary.
 * @param {unknown} v
 */
function firstSentence(v) {
  const line = oneLine(v, SUMMARY_CHARS * 2);
  const end = line.search(/[.!?](\s|$)/);
  return cut(end >= 0 ? line.slice(0, end + 1) : line, SUMMARY_CHARS);
}

/**
 * `s` cut to at most `max` UTF-16 units ending with …, never splitting a surrogate pair.
 * @param {string} s @param {number} max
 */
function cutUnits(s, max) {
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/**
 * The node a local reference names, following references to references at most MAX_REF_HOPS
 * times; `null` for a reference that does not resolve (remote, malformed, missing, a loop).
 * A node that is not a reference is returned as it is.
 * @param {unknown} root @param {unknown} node
 */
function deref(root, node) {
  let at = node;
  for (let hop = 0; hop <= MAX_REF_HOPS; hop++) {
    const ref = own(at, "$ref");
    if (ref === undefined) return at;
    if (typeof ref !== "string" || ref.length > MAX_REF || !ref.startsWith("#/")) return null;
    /** @type {unknown} */
    let target = root;
    for (const raw of ref.slice(2).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      target = Array.isArray(target) ? undefined : own(target, key);
      if (target === undefined) return null;
    }
    at = target;
  }
  return null;
}

/**
 * The last part of a reference, as a short name for "unresolved reference".
 * @param {unknown} node
 */
function refName(node) {
  const ref = own(node, "$ref");
  const last = typeof ref === "string" ? ref.slice(0, MAX_REF).split("/").pop() : "";
  return short(last, MAX_NAME, NAME) ? last : "?";
}

/**
 * A path's template parameter names, or `null` when the path is not a plain template: it must
 * start with `/`, hold only printable ASCII without space, `?`, `#` or `\`, no `.` or `..`
 * segment, and braces only around a valid name, each name once.
 * @param {string} path
 */
function pathTemplate(path) {
  if (path.length > MAX_PATH || !PATH_CHARS.test(path)) return null;
  /** @type {string[]} */
  const names = [];
  for (const segment of path.slice(1).split("/")) {
    if (segment === "." || segment === "..") return null;
    const rest = segment.replace(/\{([^{}]*)\}/g, (_, name) => {
      names.push(name);
      return "";
    });
    if (rest.includes("{") || rest.includes("}")) return null;
  }
  for (const [i, name] of names.entries()) {
    if (!short(name, MAX_NAME, NAME) || names.indexOf(name) !== i) return null;
  }
  return names;
}

/**
 * A schema's type in a few words: `string (date-time)`, `string | null`, `array of string`,
 * `string | integer`, `object`.
 * @param {unknown} root @param {unknown} node @param {number} [depth]
 * @returns {string}
 */
function typeOf(root, node, depth = 0) {
  const schema = deref(root, node);
  if (schema === null) return `(unresolved reference ${refName(node)})`;
  if (!isObj(schema)) return "any";
  const alternatives = own(schema, "oneOf") ?? own(schema, "anyOf");
  if (Array.isArray(alternatives) && alternatives.length > 0 && depth < 2) {
    /** @type {string[]} */
    const kinds = alternatives.slice(0, MAX_ALTERNATIVES).map((a) => typeOf(root, a, depth + 1));
    const more = alternatives.length > MAX_ALTERNATIVES ? " | …" : "";
    return [...new Set(kinds)].join(" | ") + more;
  }
  const raw = own(schema, "type");
  const types = (Array.isArray(raw) ? raw.slice(0, MAX_ALTERNATIVES) : [raw]).filter((t) =>
    short(t, 20, /^[a-z]+$/),
  );
  if (own(schema, "nullable") === true && !types.includes("null")) types.push("null");
  if (types.length === 0) {
    if (isObj(own(schema, "properties")) || Array.isArray(own(schema, "allOf")))
      types.push("object");
    else if (own(schema, "items") !== undefined) types.push("array");
  }
  if (types.length === 0) return "any";
  const format = own(schema, "format");
  return types
    .map((/** @type {string} */ t) => {
      if (t === "array" && depth < 2)
        return `array of ${typeOf(root, own(schema, "items"), depth + 1)}`;
      if (short(format, 20, /^[\w.-]+$/) && t !== "null") return `${t} (${format})`;
      return t;
    })
    .join(" | ");
}

/**
 * A schema's allowed values as `, one of: a, b, c`, or "".
 * @param {unknown} root @param {unknown} node
 */
function enumOf(root, node) {
  const values = own(deref(root, node), "enum");
  if (!Array.isArray(values) || values.length === 0) return "";
  const shown = values
    .slice(0, MAX_ENUM)
    .map((v) => (v === null || typeof v !== "object" ? oneLine(String(v), MAX_ENUM_VALUE) : "…"))
    .map((v) => (v === "" ? '""' : v));
  const more = values.length > MAX_ENUM ? `, +${values.length - MAX_ENUM} more` : "";
  return `, one of: ${shown.join(", ")}${more}`;
}

/**
 * A schema's properties with whether each is required, merged from its `allOf` members (at most
 * MAX_MERGED schemas, so a shared or nested allOf cannot multiply the work).
 * @param {unknown} root @param {unknown} node
 * @returns {{ name: string, schema: unknown, required: boolean }[]}
 */
function propertiesOf(root, node) {
  /** @type {Map<string, { name: string, schema: unknown, required: boolean }>} */
  const out = new Map();
  /** @type {Set<string>} */
  const required = new Set();
  const queue = [node];
  for (let visited = 0; queue.length > 0 && visited < MAX_MERGED; visited++) {
    const schema = deref(root, queue.shift());
    if (!isObj(schema)) continue;
    const req = own(schema, "required");
    if (Array.isArray(req)) {
      for (const r of req.slice(0, MAX_FIELDS)) if (typeof r === "string") required.add(r);
    }
    const props = own(schema, "properties");
    if (isObj(props)) {
      for (const name of Object.keys(props)) {
        if (out.size >= MAX_FIELDS) break;
        if (!short(name, MAX_NAME, NAME) || out.has(name)) continue;
        out.set(name, { name, schema: props[name], required: false });
      }
    }
    const all = own(schema, "allOf");
    if (Array.isArray(all)) queue.push(...all.slice(0, MAX_MERGED));
  }
  return [...out.values()].map((p) => ({ ...p, required: required.has(p.name) }));
}

/**
 * Appends a schema's properties as indented lines, `level` deep, while `lines` stays within the
 * signature's budget. Properties of an array's items are shown under the array.
 * @param {unknown} root @param {unknown} node @param {number} level @param {string[]} lines
 * @param {{ chars: number }} used
 */
function renderProperties(root, node, level, lines, used) {
  if (level > SCHEMA_LEVELS) return;
  let schema = deref(root, node);
  for (let i = 0; i < 2 && isObj(schema) && own(schema, "items") !== undefined; i++) {
    schema = deref(root, own(schema, "items"));
  }
  for (const p of propertiesOf(root, schema)) {
    if (used.chars > SIGNATURE_CHARS) return;
    const description = oneLine(own(deref(root, p.schema), "description"), MAX_DESCRIPTION);
    const line =
      `${"  ".repeat(level)}${p.name}${p.required ? "*" : ""} ${typeOf(root, p.schema)}` +
      `${enumOf(root, p.schema)}${description ? ` — ${description}` : ""}`;
    lines.push(line);
    used.chars += line.length + 1;
    renderProperties(root, p.schema, level + 1, lines, used);
  }
}

/**
 * An operation's parameters, path-level ones first and an operation's own replacing them by
 * name and place; `null` when a parameter the operation needs could never be sent (a path
 * parameter or a required one whose name is not printable and short).
 * @param {unknown} root @param {unknown} itemParams @param {unknown} opParams
 * @param {string[]} template
 */
function paramsOf(root, itemParams, opParams, template) {
  /** @type {Map<string, Param & { schema: unknown, description: string }>} */
  const byKey = new Map();
  for (const list of [itemParams, opParams]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list.slice(0, MAX_PARAMS * 2)) {
      const p = deref(root, raw);
      if (!isObj(p)) continue;
      const place = own(p, "in");
      if (place !== "path" && place !== "query" && place !== "header" && place !== "cookie") {
        continue;
      }
      const name = own(p, "name");
      const required = place === "path" || own(p, "required") === true;
      if (!short(name, MAX_NAME, NAME)) {
        if (required) return null;
        continue;
      }
      // The agent sets no header (decision 8): header and cookie parameters are Vimma's.
      if (place === "header" || place === "cookie") continue;
      if (place === "path" && !template.includes(/** @type {string} */ (name))) continue;
      const schema = own(p, "schema");
      byKey.set(`${place} ${name}`, {
        name: /** @type {string} */ (name),
        in: place,
        required,
        type: typeOf(root, schema),
        schema,
        description: oneLine(own(p, "description"), MAX_DESCRIPTION),
      });
    }
  }
  // A template name the operation does not declare is still a parameter it needs.
  for (const name of template) {
    if (!byKey.has(`path ${name}`)) {
      byKey.set(`path ${name}`, {
        name,
        in: "path",
        required: true,
        type: "string",
        schema: undefined,
        description: "",
      });
    }
  }
  const all = [...byKey.values()];
  const path = all.filter((p) => p.in === "path");
  const query = all.filter((p) => p.in === "query");
  if (query.length > MAX_PARAMS - path.length) {
    if (query.slice(MAX_PARAMS - path.length).some((p) => p.required)) return null;
    query.length = Math.max(0, MAX_PARAMS - path.length);
  }
  return [...path, ...query];
}

/** The media type part of a content key, in lower case. */
const mediaOf = (/** @type {string} */ key) => (key.split(";")[0] ?? "").trim().toLowerCase();

/**
 * An operation's request body: the JSON or form content it takes, or `other` for a body Vimma
 * does not send (file uploads, XML only); `null` without one.
 * @param {unknown} root @param {unknown} raw
 * @returns {{ body: Body, schema: unknown } | null}
 */
function bodyOf(root, raw) {
  const body = deref(root, raw);
  if (!isObj(body)) return null;
  const content = own(body, "content");
  if (!isObj(content)) return null;
  const keys = Object.keys(content).slice(0, 50);
  if (keys.length === 0) return null;
  const json = keys.find((k) => /^application\/(?:[\w.+-]*\+)?json$/.test(mediaOf(k)));
  const form = keys.find((k) => mediaOf(k) === "application/x-www-form-urlencoded");
  const key = json ?? form ?? /** @type {string} */ (keys[0]);
  const media = json ? "json" : form ? "form" : "other";
  const contentType = mediaOf(key);
  const schema = own(own(content, key), "schema");
  return {
    body: {
      media,
      contentType: short(contentType, 100, NAME) ? contentType : "unknown",
      required: own(body, "required") === true,
      fields:
        media === "other"
          ? []
          : propertiesOf(root, schema).map(({ name, required }) => ({ name, required })),
    },
    schema,
  };
}

/**
 * The detail of an operation's signature: its parameters with type, whether required (`*`),
 * allowed values and description, and its body's schema SCHEMA_LEVELS deep. At most
 * SIGNATURE_CHARS characters.
 * @param {unknown} root
 * @param {(Param & { schema: unknown, description: string })[]} params
 * @param {{ body: Body, schema: unknown } | null} body
 */
function detailOf(root, params, body) {
  /** @type {string[]} */
  const lines = [];
  const used = { chars: 0 };
  for (const [place, title] of /** @type {const} */ ([
    ["path", "Path parameters:"],
    ["query", "Query parameters:"],
  ])) {
    const list = params.filter((p) => p.in === place);
    if (list.length === 0) continue;
    lines.push(title);
    for (const p of list) {
      if (used.chars > SIGNATURE_CHARS) break;
      const line =
        `  ${p.name}${p.required ? "*" : ""} ${p.type}${enumOf(root, p.schema)}` +
        `${p.description ? ` — ${p.description}` : ""}`;
      lines.push(line);
      used.chars += line.length + 1;
    }
  }
  if (body) {
    const { media, contentType, required } = body.body;
    if (media === "other") {
      lines.push(`Body: ${contentType}, not supported`);
    } else {
      lines.push(`Body (${contentType}${required ? ", required" : ""}):`);
      const props = propertiesOf(root, body.schema);
      if (props.length === 0) lines.push(`  ${typeOf(root, body.schema)}`);
      renderProperties(root, body.schema, 1, lines, used);
    }
  }
  return cutUnits(lines.join("\n"), SIGNATURE_CHARS);
}

/**
 * A made id for an operation without a usable one: its method and path, braces dropped and other
 * characters made `-`, such as `get-repos-owner-repo`.
 * @param {string} method @param {string} path
 */
function madeId(method, path) {
  const tail = path
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9._]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${method}${tail ? `-${tail}` : ""}`.slice(0, MAX_ID - 8);
}

/**
 * The index of a parsed description.
 * @param {unknown} doc  the description, as JSON.parse returns it
 * @returns {ApiIndex}
 * @throws {OpenApiError} when it is not an OpenAPI 3.0 or 3.1 description with an operation
 */
export function buildIndex(doc) {
  if (!isObj(doc)) throw new OpenApiError("The description is not an OpenAPI description.");
  if (own(doc, "swagger") !== undefined) {
    throw new OpenApiError(
      "The description is Swagger 2.0. Vimma reads OpenAPI 3.0 and 3.1 descriptions only: use " +
        "the service's OpenAPI 3 description.",
    );
  }
  const version = own(doc, "openapi");
  if (typeof version !== "string" || !/^3\.[01]\.\d{1,3}(?:-[\w.]{1,20})?$/.test(version)) {
    const named = short(version, 20, /^[\w.-]+$/) ? `OpenAPI ${version}` : "not OpenAPI 3";
    throw new OpenApiError(
      `The description is ${named}. Vimma reads OpenAPI 3.0 and 3.1 descriptions only.`,
    );
  }
  const paths = own(doc, "paths");
  if (!isObj(paths)) throw new OpenApiError("The description has no paths.");

  /** @type {{ method: string, path: string, declared: unknown, op: Omit<Operation, "id"> }[]} */
  const found = [];
  let dropped = 0;
  let truncated = false;
  walk: for (const path of Object.keys(paths)) {
    const item = deref(doc, paths[path]);
    if (!isObj(item)) continue;
    const template = pathTemplate(path);
    for (const method of METHODS) {
      const op = own(item, method);
      if (!isObj(op)) continue;
      if (found.length >= MAX_OPERATIONS) {
        truncated = true;
        break walk;
      }
      const params =
        template && paramsOf(doc, own(item, "parameters"), own(op, "parameters"), template);
      if (!template || !params) {
        dropped++;
        continue;
      }
      // XMLHttpRequest sends no body with GET or HEAD, and Stripe declares an empty one on each.
      const body =
        method === "get" || method === "head" ? null : bodyOf(doc, own(op, "requestBody"));
      const rawTags = own(op, "tags");
      const tags = Array.isArray(rawTags)
        ? [
            ...new Set(
              rawTags.slice(0, 50).filter((t) => short(t, MAX_TAG, TAG) && t.trim() === t),
            ),
          ].slice(0, MAX_TAGS)
        : [];
      found.push({
        method,
        path,
        declared: own(op, "operationId"),
        op: {
          method: method.toUpperCase(),
          path,
          summary:
            oneLine(own(op, "summary"), SUMMARY_CHARS) || firstSentence(own(op, "description")),
          tags,
          params: params.map(({ name, in: place, required, type }) => ({
            name,
            in: place,
            required,
            type,
          })),
          body: body ? body.body : null,
          signature: detailOf(doc, params, body),
        },
      });
    }
  }
  if (found.length === 0) throw new OpenApiError("The description has no operations.");

  // Declared ids first, the first operation keeping a repeated one; then made ids for the rest,
  // numbered past any id already taken.
  /** @type {Set<string>} */
  const taken = new Set();
  const ids = found.map(({ declared }) => {
    if (!short(declared, MAX_ID, NAME) || taken.has(/** @type {string} */ (declared))) return null;
    taken.add(/** @type {string} */ (declared));
    return /** @type {string} */ (declared);
  });
  /** @type {Map<string, number>} */
  const next = new Map();
  const operations = found.map(({ method, path, op }, i) => {
    let id = ids[i] ?? null;
    if (id === null) {
      const base = madeId(method, path);
      let n = next.get(base) ?? 1;
      id = n === 1 ? base : `${base}-${n}`;
      while (taken.has(id)) id = `${base}-${++n}`;
      next.set(base, n + 1);
      taken.add(id);
    }
    return { id, ...op };
  });

  const rawServers = own(doc, "servers");
  const servers = Array.isArray(rawServers)
    ? rawServers
        .slice(0, 50)
        .map((s) => own(s, "url"))
        .filter((u) => short(u, MAX_SERVER, NAME) && /^https?:\/\/[^/?#]/i.test(String(u)))
        .slice(0, MAX_SERVERS)
    : [];
  return {
    version: INDEX_VERSION,
    openapi: version,
    title: oneLine(own(own(doc, "info"), "title"), SUMMARY_CHARS),
    servers: /** @type {string[]} */ (servers),
    operations,
    dropped,
    truncated,
  };
}

/**
 * The index of a description's text: JSON only (decision 10).
 * @param {string} text
 * @returns {ApiIndex}
 * @throws {OpenApiError} for YAML, text that is not JSON, a description over the size limit, or
 *   one buildIndex refuses
 */
export function indexDescription(text) {
  if (typeof text !== "string") throw new OpenApiError("The description is not text.");
  if (text.length > MAX_DESCRIPTION_CHARS) {
    throw new OpenApiError(
      `The description is larger than ${MAX_DESCRIPTION_CHARS / 1024 / 1024} MiB.`,
    );
  }
  const first = text.search(/\S/);
  if (first >= 0 && text[first] !== "{" && text[first] !== "[") {
    throw new OpenApiError(
      "The description is not JSON. Vimma reads OpenAPI descriptions as JSON only; YAML is " +
        "not supported: use the service's JSON description.",
    );
  }
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // A syntax error, or JSON nested deeper than the engine parses.
    throw new OpenApiError("The description is not valid JSON.");
  }
  return buildIndex(doc);
}

/**
 * The index with only the operations `only` keeps (behaviour 3): those with a tag equal to one
 * of its strings, or whose path starts with one that starts with `/`. Empty or unset keeps all.
 * @param {ApiIndex} index @param {readonly string[] | undefined} only
 * @returns {ApiIndex}
 */
export function selectOperations(index, only) {
  if (!only || only.length === 0) return index;
  const prefixes = only.filter((s) => s.startsWith("/"));
  const operations = index.operations.filter(
    (o) => o.tags.some((t) => only.includes(t)) || prefixes.some((p) => o.path.startsWith(p)),
  );
  return { ...index, operations };
}

/**
 * Whether an operation is a read: its method is GET or HEAD, or `read_ops` names it (decision
 * 24). Everything else is a write, which asks every time.
 * @param {Pick<Operation, "id" | "method">} op @param {readonly string[]} [readOps]
 */
export function isRead(op, readOps = []) {
  return op.method === "GET" || op.method === "HEAD" || readOps.includes(op.id);
}

/**
 * Names as `a, b*, c`, `*` marking a required one, cut at LINE_NAMES with a count.
 * @param {{ name: string, required: boolean }[]} list
 */
function names(list) {
  const shown = list.slice(0, LINE_NAMES).map((p) => `${p.name}${p.required ? "*" : ""}`);
  const more = list.length > LINE_NAMES ? `, +${list.length - LINE_NAMES} more` : "";
  return shown.join(", ") + more;
}

/**
 * One operation as vimma_api_find lists it (behaviour 10): its id, method and path, summary,
 * `read` or `write`, its query parameters and its body's top-level fields, `*` marking a
 * required one, each part two spaces apart.
 * @param {Operation} op @param {readonly string[]} [readOps]
 */
export function operationLine(op, readOps = []) {
  const parts = [op.id, `${op.method} ${op.path}`];
  if (op.summary) parts.push(op.summary);
  parts.push(isRead(op, readOps) ? "read" : "write");
  const query = op.params.filter((p) => p.in === "query");
  if (query.length > 0) parts.push(`query: ${names(query)}`);
  if (op.body?.media === "other") parts.push(`body: ${op.body.contentType}, not supported`);
  else if (op.body && op.body.fields.length > 0) parts.push(`body: ${names(op.body.fields)}`);
  else if (op.body) parts.push(`body: ${op.body.contentType}`);
  return parts.join("  ");
}

/**
 * The lowercase words of a text, camelCase split: `PostCustomers` gives `post` and `customers`.
 * @param {string} s
 */
const words = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * How well `word` matches one of `tokens`: 2 exact, 1 a stem of the other, else 0.
 * @param {string} word @param {string[]} tokens
 */
function match(word, tokens) {
  let best = 0;
  for (const t of tokens) {
    if (t === word) return 2;
    const [a, b] = t.length < word.length ? [t, word] : [word, t];
    if (a.length >= 3 && b.startsWith(a) && b.length - a.length <= 2) best = 1;
  }
  return best;
}

/**
 * The operations that best match `query`, at most FIND_LIMIT lines (behaviour 10; decision 12):
 * plain word matching over ids, tags, paths and summaries, so the same index and query always
 * give the same lines. Ranked by how many of the query's words match, then by where (an id or a
 * tag counts more than the path, the path more than the summary), then the shorter path, then
 * the description's order.
 * @param {ApiIndex} index @param {string} query
 * @param {{ readOps?: readonly string[] }} [options]
 * @returns {string[]}
 */
export function findOperations(index, query, { readOps = [] } = {}) {
  if (typeof query !== "string") return [];
  const wanted = [...new Set(words(query.slice(0, MAX_QUERY)))].slice(0, MAX_QUERY_WORDS);
  if (wanted.length === 0) return [];
  const ranked = [];
  for (const [order, op] of index.operations.entries()) {
    /** @type {[string[], number][]} */
    const fields = [
      [words(op.id), 4],
      [op.tags.flatMap(words), 3],
      [words(op.path), 2],
      [words(op.summary), 1],
    ];
    let matched = 0;
    let score = 0;
    for (const word of wanted) {
      let best = 0;
      for (const [tokens, weight] of fields) best = Math.max(best, match(word, tokens) * weight);
      if (best > 0) matched++;
      score += best;
    }
    if (matched > 0) ranked.push({ op, matched, score, depth: op.path.split("/").length, order });
  }
  ranked.sort(
    (a, b) => b.matched - a.matched || b.score - a.score || a.depth - b.depth || a.order - b.order,
  );
  return ranked.slice(0, FIND_LIMIT).map(({ op }) => operationLine(op, readOps));
}

/**
 * One operation's whole signature (behaviour 10): its line's head, its summary, and its
 * parameters and body as `detailOf` gives them, at most SIGNATURE_CHARS characters; `null`
 * when the index holds no operation with exactly this id.
 * @param {ApiIndex} index @param {string} id
 * @param {{ readOps?: readonly string[] }} [options]
 */
export function operationSignature(index, id, { readOps = [] } = {}) {
  const op = index.operations.find((o) => o.id === id);
  if (!op) return null;
  const head = `${op.id}  ${op.method} ${op.path}  ${isRead(op, readOps) ? "read" : "write"}`;
  return cutUnits([head, op.summary, op.signature].filter(Boolean).join("\n"), SIGNATURE_CHARS);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Control protocol, versions 1 and 2: validator for every message and the discovery file
 * (docs/specs/m0-control-protocol-and-vimma-ctl.md, fixtures in tests/contract/control/v1/;
 * protocol 2's roles and agent commands: docs/specs/vimma-mcp.md, decisions 2 and 4, fixtures in
 * tests/contract/control/v2/). Pure: the browser-side server and the tests share it.
 */

import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "./agent.mjs";
import { parseKey } from "./keys.mjs";
import { MODES } from "./modes.mjs";

/** Protocol 1: what a hello without a role speaks (the `full` role). */
export const CONTROL_PROTOCOL = 1;
/** Protocol 2 adds the hello's `role` and the agent commands (vimma-mcp decision 2). */
export const LATEST_PROTOCOL = 2;
export const PROTOCOLS = Object.freeze([1, 2]);
/** `agent`: only the agent commands, confined and confirmed. `full`: v1's commands. */
export const ROLES = Object.freeze(["agent", "full"]);
/** Longest accepted line in bytes (UTF-8), excluding the newline (spec m0-control-server). */
export const MAX_LINE_LENGTH = 1024 * 1024;
export const CONTROL_COMMANDS = Object.freeze(["send-keys", "state", "open", "reload-theme"]);
export const RESERVED_COMMANDS = Object.freeze(["list-tabs", "screenshot", "reload-config"]);
/**
 * The agent role's commands (protocol 2; vimma-mcp decision 4). No other role runs them.
 * `agent-cancel` withdraws one of the connection's waiting questions (decision 17, MCP's
 * `notifications/cancelled`). `agent-keys` runs Vimma's own page keys in an agent tab, and
 * `agent-show` brings the agent workspace to the front with one agent tab selected
 * (docs/specs/mcp-drive.md D2, D8, D19). `agent-elements` lists an agent tab's buttons, fields
 * and links with hint labels (docs/specs/mcp-forms.md F2).
 */
export const AGENT_COMMANDS = Object.freeze([
  "agent-hello",
  "agent-tabs",
  "agent-read",
  "agent-open",
  "agent-close",
  "agent-ping",
  "agent-cancel",
  "agent-keys",
  "agent-show",
  "agent-elements",
]);
/**
 * Why an agent request was `denied` (vimma-mcp decision 4). `in-use`: the user is typing in that
 * tab, or a key sequence or hint mode is under way there (mcp-drive D13).
 */
export const DENY_REASONS = Object.freeze([
  "user",
  "timeout",
  "busy",
  "muted",
  "changed",
  "cancelled",
  "in-use",
]);
/** Why `agent-keys` stopped before its last step (mcp-drive D13, D15, D18). */
export const KEYS_STOPS = Object.freeze(["changed", "in-use", "timeout", "denied"]);
/** `agent-keys`'s keys, in code points (mcp-drive D15). */
export const MAX_AGENT_KEYS = 512;
export const ERROR_CODES = Object.freeze([
  "bad-request",
  "unauthorized",
  "unsupported-protocol",
  "unknown-command",
  "invalid-args",
  "not-implemented",
  "failed",
  "internal",
  "busy",
  "role-off",
  "denied",
]);

const MAX_ID = 2 ** 53 - 1;
const MAX_CHORDS = 256;
const MAX_URL = 65536;
const URL_SCHEMES = ["http", "https", "file", "about"];
/** `agent-read`'s most text, whatever `[mcp] max_read_chars` says (vimma-mcp decision 26). */
export const MAX_READ_CHARS = 500000;
const TAB_ID = /^[1-9][0-9]{0,15}$/;
/**
 * Whether code point `cp` may not appear in a label shown in the question (a client's name):
 * control characters (C0, DEL, C1), and bidirectional marks, overrides and isolates, which
 * could make it read as something else.
 * @param {number} cp
 */
const unprintable = (cp) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x200e ||
  cp === 0x200f ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);
const KINDS = ["hello", "challenge", "auth", "welcome", "request", "response", "discovery"];
/** Prefix of the challenge's HMAC message, so the proof is good for nothing else. */
export const CHALLENGE_CONTEXT = "vimma-server\0";

/**
 * @typedef {"hello" | "challenge" | "auth" | "welcome" | "request" | "response" | "discovery"} MessageKind
 * @typedef {{ kind?: MessageKind, command?: string }} ValidateOptions
 * @typedef {{ valid: boolean, errors: string[] }} Validation
 * @typedef {Record<string, unknown>} Obj
 */

/** @param {unknown} v @returns {v is Obj} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v @param {number} min @param {number} max */
const isInt = (v, min, max) =>
  Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max;
/** @param {unknown} v */
const isToken = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/**
 * @param {Obj} obj
 * @param {readonly string[]} allowed
 * @param {string[]} errors
 * @param {string} [prefix]
 */
function noExtraFields(obj, allowed, errors, prefix = "") {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`unknown field "${prefix}${key}"`);
  }
}

/** @param {Obj} m @param {string[]} errors */
function checkProtocol(m, errors) {
  if (!isInt(m.protocol, 1, MAX_ID)) errors.push("protocol must be an integer >= 1");
}

/** From protocol 2 a hello and a welcome name the connection's role. @param {Obj} m */
const hasRoles = (m) => isInt(m.protocol, 2, MAX_ID);

/** @param {Obj} m @param {string[]} errors */
function checkRole(m, errors) {
  if (!ROLES.includes(/** @type {any} */ (m.role))) errors.push('role must be "agent" or "full"');
}

/**
 * The handshake (spec m0-control-protocol-and-vimma-ctl): hello {nonce} → challenge {proof} →
 * auth {token} → welcome. The token is sent only after the server proved it knows it.
 * @param {Obj} m @param {string[]} errors
 */
function checkHello(m, errors) {
  const roles = hasRoles(m);
  noExtraFields(
    m,
    roles ? ["type", "protocol", "nonce", "role"] : ["type", "protocol", "nonce"],
    errors,
  );
  checkProtocol(m, errors);
  if (roles) checkRole(m, errors);
  if (!isToken(m.nonce)) errors.push("nonce must be 64 lowercase hex characters");
}

/**
 * proof = HMAC-SHA256(key: the token, message: CHALLENGE_CONTEXT + the hello's nonce), ASCII.
 * @param {Obj} m @param {string[]} errors
 */
function checkChallenge(m, errors) {
  checkProtocol(m, errors);
  if (!isToken(m.proof)) errors.push("proof must be 64 lowercase hex characters");
}

/** @param {Obj} m @param {string[]} errors */
function checkAuth(m, errors) {
  noExtraFields(m, ["type", "token", "code"], errors);
  if (!isToken(m.token)) errors.push("token must be 64 lowercase hex characters");
  // The code a full client printed, shown in Vimma's question (docs/specs/vimma-mcp.md 29 C).
  if ("code" in m && (typeof m.code !== "string" || !AUTH_CODE.test(m.code))) {
    errors.push("code must be 4 characters of 2-9 and A-Z without I and O");
  }
}

/** auth's optional code (docs/specs/vimma-mcp.md decision 29 C; security.md S13). */
export const AUTH_CODE = /^[2-9A-HJ-NP-Z]{4}$/;

/** @param {Obj} m @param {string[]} errors */
function checkWelcome(m, errors) {
  checkProtocol(m, errors);
  if (typeof m.app !== "string") errors.push("app must be a string");
  if (typeof m.version !== "string") errors.push("version must be a string");
  if (hasRoles(m)) checkRole(m, errors);
}

/** @param {Obj} m @param {string[]} errors */
function checkDiscovery(m, errors) {
  checkProtocol(m, errors);
  if (!isInt(m.port, 1, 65535)) errors.push("port must be an integer from 1 to 65535");
  if (!isToken(m.token)) errors.push("token must be 64 lowercase hex characters");
  if (!isInt(m.pid, 1, MAX_ID)) errors.push("pid must be an integer >= 1");
  if (hasRoles(m) || "roles" in m) {
    const { roles } = m;
    const ok =
      Array.isArray(roles) &&
      roles.length >= 1 &&
      roles.every((r) => ROLES.includes(r)) &&
      new Set(roles).size === roles.length;
    if (!ok) errors.push('roles must be a list of "agent" and "full", each once');
  }
}

/** @param {Obj} args @param {string[]} errors */
function checkSendKeysArgs(args, errors) {
  noExtraFields(args, ["keys"], errors, "args.");
  if (typeof args.keys !== "string") {
    errors.push("keys must be a string");
    return;
  }
  const chords = args.keys.split(/\s+/).filter(Boolean);
  if (chords.length < 1 || chords.length > MAX_CHORDS) {
    errors.push(`keys must contain 1 to ${MAX_CHORDS} chords`);
    return;
  }
  for (const chord of chords) {
    try {
      parseKey(chord);
    } catch {
      errors.push(`keys: "${chord}" is not a chord`);
    }
  }
}

/** @param {Obj} args @param {string[]} errors */
function checkOpenArgs(args, errors) {
  noExtraFields(args, ["url", "where"], errors, "args.");
  const { url } = args;
  if (typeof url !== "string") errors.push("url must be a string");
  else if (url.length > MAX_URL) errors.push(`url must be at most ${MAX_URL} characters`);
  else if ([...url].some((c) => c <= " " || c === "\u007f")) {
    errors.push("url must not contain control characters or spaces");
  } else {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1];
    if (!scheme) errors.push("url must be an absolute URL");
    else if (!URL_SCHEMES.includes(scheme.toLowerCase())) {
      errors.push("url scheme must be http, https, file or about");
    }
  }
  if ("where" in args && args.where !== "tab" && args.where !== "current") {
    errors.push('where must be "tab" or "current"');
  }
}

/**
 * A label of 1 to `max` printable characters (code points).
 * @param {unknown} v @param {number} max
 */
const isLabel = (v, max) =>
  typeof v === "string" &&
  v.length > 0 &&
  [...v].length <= max &&
  ![...v].some((c) => unprintable(/** @type {number} */ (c.codePointAt(0))));

/** @param {Obj} args @param {string[]} errors */
function checkTabArg(args, errors) {
  if (typeof args.tab !== "string" || !TAB_ID.test(args.tab)) {
    errors.push("tab must be a tab id (digits)");
  }
}

/** @param {Obj} args @param {string[]} errors */
function checkAgentHelloArgs(args, errors) {
  noExtraFields(args, ["client", "via"], errors, "args.");
  const { client } = args;
  if (!isObject(client)) errors.push("client must be an object");
  else {
    noExtraFields(client, ["name", "version"], errors, "args.client.");
    if (!isLabel(client.name, 64)) errors.push("client.name must be 1 to 64 printable characters");
    if ("version" in client && !isLabel(client.version, 64)) {
      errors.push("client.version must be 1 to 64 printable characters");
    }
  }
  if ("via" in args && !isLabel(args.via, 32))
    errors.push("via must be 1 to 32 printable characters");
}

/** @param {Obj} args @param {string[]} errors */
function checkAgentReadArgs(args, errors) {
  noExtraFields(args, ["tab", "format", "max_chars"], errors, "args.");
  checkTabArg(args, errors);
  if ("format" in args && args.format !== "markdown" && args.format !== "text") {
    errors.push('format must be "markdown" or "text"');
  }
  if ("max_chars" in args && !isInt(args.max_chars, 1, MAX_READ_CHARS)) {
    errors.push(`max_chars must be an integer from 1 to ${MAX_READ_CHARS}`);
  }
}

/**
 * An agent loads only http and https (vimma-mcp decision 4): no local files, privileged pages
 * or script URLs through the browser.
 * @param {Obj} args @param {string[]} errors
 */
function checkAgentOpenArgs(args, errors) {
  noExtraFields(args, ["url", "tab"], errors, "args.");
  const { url } = args;
  if (typeof url !== "string") errors.push("url must be a string");
  else if (url.length > MAX_URL) errors.push(`url must be at most ${MAX_URL} characters`);
  else if ([...url].some((c) => c <= " " || c === "\u007f")) {
    errors.push("url must not contain control characters or spaces");
  } else if (!/^https?:/i.test(url)) errors.push("url scheme must be http or https");
  if ("tab" in args) checkTabArg(args, errors);
}

/** C0 but the tab, DEL and C1: the keys are one line, with tabs or spaces between keys. */
// eslint-disable-next-line no-control-regex -- the control characters are what it refuses
const KEYS_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/**
 * `agent-keys` (mcp-drive D15): which keys run is the browser's parse (core agent-keys.mjs);
 * this checks only their size and characters.
 * @param {Obj} args @param {string[]} errors
 */
function checkAgentKeysArgs(args, errors) {
  noExtraFields(args, ["tab", "keys"], errors, "args.");
  checkTabArg(args, errors);
  const { keys } = args;
  if (typeof keys !== "string" || !keys || [...keys].length > MAX_AGENT_KEYS) {
    errors.push(`keys must be a string of 1 to ${MAX_AGENT_KEYS} characters`);
  } else if (KEYS_CONTROL.test(keys)) errors.push("keys must not contain control characters");
}

/** @param {Obj} m @param {string[]} errors */
function checkRequest(m, errors) {
  noExtraFields(m, ["type", "id", "command", "args"], errors);
  if (!isInt(m.id, 1, MAX_ID)) errors.push("id must be an integer from 1 to 2^53-1");
  const { command, args } = m;
  const all = [...CONTROL_COMMANDS, ...RESERVED_COMMANDS, ...AGENT_COMMANDS];
  const known = typeof command === "string" && all.includes(command);
  if (!known) errors.push(`command must be one of ${all.join(", ")}`);
  if (!isObject(args)) {
    errors.push("args must be an object");
    return;
  }
  if (command === "send-keys") checkSendKeysArgs(args, errors);
  else if (command === "open") checkOpenArgs(args, errors);
  else if (command === "agent-hello") checkAgentHelloArgs(args, errors);
  else if (command === "agent-read") checkAgentReadArgs(args, errors);
  else if (command === "agent-open") checkAgentOpenArgs(args, errors);
  else if (command === "agent-keys") checkAgentKeysArgs(args, errors);
  else if (command === "agent-close" || command === "agent-show" || command === "agent-elements") {
    // A show names its tab only, never a workspace (mcp-drive D2); a list takes no selector.
    noExtraFields(args, ["tab"], errors, "args.");
    checkTabArg(args, errors);
  } else if (command === "agent-cancel") {
    noExtraFields(args, ["id"], errors, "args.");
    if (!isInt(args.id, 1, MAX_ID)) errors.push("id must be an integer from 1 to 2^53-1");
  } else if (
    ["state", "reload-theme", "agent-tabs", "agent-ping"].includes(/** @type {string} */ (command))
  ) {
    noExtraFields(args, [], errors, "args.");
  }
}

/**
 * Fields of `result` that must be strings, booleans, or strings or null.
 * @param {Obj} result @param {string} prefix
 * @param {{ strings?: string[], flags?: string[], nullable?: string[] }} shape
 * @param {string[]} errors
 */
function checkFields(result, prefix, { strings = [], flags = [], nullable = [] }, errors) {
  for (const key of strings) {
    if (typeof result[key] !== "string") errors.push(`${prefix}.${key} must be a string`);
  }
  for (const key of flags) {
    if (typeof result[key] !== "boolean") errors.push(`${prefix}.${key} must be a boolean`);
  }
  for (const key of nullable) {
    if (result[key] !== null && typeof result[key] !== "string") {
      errors.push(`${prefix}.${key} must be a string or null`);
    }
  }
}

/**
 * A list of the page's (`f`'s links, `vimma_elements`' elements): one string inside the
 * untrusted-content delimiters, each exactly once (security.md M21, M31).
 * @param {unknown} list
 */
const insideDelimiters = (list) =>
  typeof list === "string" &&
  list.startsWith(`${UNTRUSTED_OPEN}\n`) &&
  list.endsWith(`\n${UNTRUSTED_CLOSE}`) &&
  list.split(UNTRUSTED_OPEN).length === 2 &&
  list.split(UNTRUSTED_CLOSE).length === 2;

/** @param {unknown} n */
const isCount = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * `agent-elements`' result (mcp-forms F2, F5): the page, its element list inside the
 * untrusted-content delimiters, and how many elements were left out (security.md M31).
 * @param {Obj} result @param {string[]} errors
 */
function checkElementsResult(result, errors) {
  noExtraFields(result, ["url", "title", "elements", "dropped"], errors, "result.");
  checkFields(result, "result", { strings: ["url", "title"] }, errors);
  if (!insideDelimiters(result.elements)) {
    errors.push("result.elements must be inside the untrusted-content delimiters");
  }
  if (!isCount(result.dropped)) errors.push("result.dropped must be a non-negative integer");
}

/**
 * `agent-keys`'s result (mcp-drive D16): the page after the steps, each step, why it stopped,
 * the last find's outcome, and `f`'s link list (D12) inside the untrusted-content delimiters
 * with how many links were left out (security.md M21).
 * @param {Obj} result @param {string[]} errors
 */
function checkKeysResult(result, errors) {
  noExtraFields(
    result,
    ["url", "title", "loading", "scroll", "steps", "stopped", "find", "links", "dropped"],
    errors,
    "result.",
  );
  checkFields(result, "result", { strings: ["url", "title"], flags: ["loading"] }, errors);
  const y = isObject(result.scroll) ? result.scroll.y : undefined;
  if (typeof y !== "number" || !(y >= 0 && y <= 1)) {
    errors.push("result.scroll.y must be a number from 0 to 1");
  }
  if (!Array.isArray(result.steps)) errors.push("result.steps must be an array");
  else {
    result.steps.forEach((step, i) => {
      if (!isObject(step)) {
        errors.push(`result.steps[${i}] must be an object`);
        return;
      }
      noExtraFields(step, ["keys", "action", "ok", "note"], errors, `result.steps[${i}].`);
      checkFields(
        step,
        `result.steps[${i}]`,
        { strings: ["keys", "action"], flags: ["ok"] },
        errors,
      );
      if ("note" in step && typeof step.note !== "string") {
        errors.push(`result.steps[${i}].note must be a string`);
      }
    });
  }
  if ("stopped" in result && !KEYS_STOPS.includes(/** @type {any} */ (result.stopped))) {
    errors.push(`result.stopped must be one of ${KEYS_STOPS.join(", ")}`);
  }
  if ("links" in result !== "dropped" in result) {
    errors.push("result.links and result.dropped come together");
  } else if ("links" in result) {
    if (!insideDelimiters(result.links)) {
      errors.push("result.links must be inside the untrusted-content delimiters");
    }
    if (!isCount(result.dropped)) errors.push("result.dropped must be a non-negative integer");
  }
  if ("find" in result) {
    if (!isObject(result.find)) errors.push("result.find must be an object");
    else {
      const shape = { strings: ["query"], flags: ["found", "wrapped"] };
      checkFields(result.find, "result.find", shape, errors);
    }
  }
}

/** @param {Obj} result @param {string | undefined} command @param {string[]} errors */
function checkAgentResult(result, command, errors) {
  if (command === "agent-hello") {
    checkFields(result, "result", { strings: ["workspace"], flags: ["exists"] }, errors);
  } else if (command === "agent-tabs") {
    if (!Array.isArray(result.tabs)) {
      errors.push("result.tabs must be an array");
      return;
    }
    result.tabs.forEach((tab, i) => {
      if (!isObject(tab)) errors.push(`result.tabs[${i}] must be an object`);
      else {
        const shape = { strings: ["id", "url", "title"], flags: ["loading"] };
        checkFields(tab, `result.tabs[${i}]`, shape, errors);
      }
    });
  } else if (command === "agent-read") {
    const shape = {
      strings: ["url", "title", "text"],
      flags: ["truncated", "background"],
      nullable: ["selection", "language"],
    };
    checkFields(result, "result", shape, errors);
  } else if (command === "agent-open") {
    checkFields(result, "result", { strings: ["tab"] }, errors);
  } else if (command === "agent-close" && result.closed !== true) {
    errors.push("result.closed must be true");
  } else if (command === "agent-show") {
    noExtraFields(result, ["shown"], errors, "result.");
    if (result.shown !== true) errors.push("result.shown must be true");
  } else if (command === "agent-cancel") {
    checkFields(result, "result", { flags: ["cancelled"] }, errors);
  } else if (command === "agent-keys") {
    checkKeysResult(result, errors);
  } else if (command === "agent-elements") {
    checkElementsResult(result, errors);
  }
}

/** @param {Obj} result @param {string[]} errors */
function checkStateResult(result, errors) {
  if (typeof result.mode !== "string" || !MODES.includes(/** @type {any} */ (result.mode))) {
    errors.push(`result.mode must be one of ${MODES.join(", ")}`);
  }
  for (const key of ["pending", "workspace"]) {
    if (result[key] !== null && typeof result[key] !== "string") {
      errors.push(`result.${key} must be a string or null`);
    }
  }
  // A private window's state (docs/specs/private-workspace.md decision 8d): no url or title.
  if ("private" in result && typeof result.private !== "boolean") {
    errors.push("result.private must be a boolean");
  }
  const hidden = result.private === true;
  if (!Array.isArray(result.tabs)) {
    errors.push("result.tabs must be an array");
  } else {
    let selected = 0;
    result.tabs.forEach((tab, i) => {
      if (!isObject(tab)) {
        errors.push(`result.tabs[${i}] must be an object`);
        return;
      }
      if (typeof tab.id !== "string") errors.push(`result.tabs[${i}].id must be a string`);
      for (const key of ["url", "title"]) {
        if (hidden && tab[key] !== null) {
          errors.push(`result.tabs[${i}].${key} must be null in a private window`);
        } else if (!hidden && typeof tab[key] !== "string") {
          errors.push(`result.tabs[${i}].${key} must be a string`);
        }
      }
      if (typeof tab.selected !== "boolean") {
        errors.push(`result.tabs[${i}].selected must be a boolean`);
      } else if (tab.selected) selected++;
    });
    if (selected > 1) errors.push("result.tabs must have at most one selected tab");
  }
  if (!("panes" in result)) errors.push("result.panes must be present (null before split view)");
}

/** @param {unknown} result @param {string | undefined} command @param {string[]} errors */
function checkResult(result, command, errors) {
  if (!isObject(result)) {
    errors.push("result must be an object");
    return;
  }
  if (command === "send-keys" && !isInt(result.sent, 0, MAX_ID)) {
    errors.push("result.sent must be an integer >= 0");
  } else if (command === "open" && typeof result.tab !== "string") {
    errors.push("result.tab must be a string");
  } else if (command === "reload-theme" && typeof result.changed !== "boolean") {
    errors.push("result.changed must be a boolean");
  } else if (command === "state") {
    checkStateResult(result, errors);
  } else if (AGENT_COMMANDS.includes(/** @type {string} */ (command))) {
    checkAgentResult(result, command, errors);
  }
}

/** @param {Obj} m @param {string | undefined} command @param {string[]} errors */
function checkResponse(m, command, errors) {
  noExtraFields(m, ["type", "id", "ok", "result", "error"], errors);
  if (m.id !== null && !isInt(m.id, 1, MAX_ID)) {
    errors.push("id must be an integer from 1 to 2^53-1 or null");
  }
  if (typeof m.ok !== "boolean") {
    errors.push("ok must be a boolean");
    return;
  }
  if (m.ok) {
    if (!("result" in m) || "error" in m) {
      errors.push("ok: true needs result and no error");
      return;
    }
    checkResult(m.result, command, errors);
    return;
  }
  if (!("error" in m) || "result" in m) {
    errors.push("ok: false needs error and no result");
    return;
  }
  const { error } = m;
  if (!isObject(error)) {
    errors.push("error must be an object");
    return;
  }
  noExtraFields(error, ["code", "message", "reason"], errors, "error.");
  if (typeof error.code !== "string" || !ERROR_CODES.includes(error.code)) {
    errors.push(`error.code must be one of ${ERROR_CODES.join(", ")}`);
  }
  if (typeof error.message !== "string") errors.push("error.message must be a string");
  // A denial says why (protocol 2); nothing else carries a reason.
  if (error.code === "denied") {
    if (!DENY_REASONS.includes(/** @type {any} */ (error.reason))) {
      errors.push(`error.reason must be one of ${DENY_REASONS.join(", ")}`);
    }
  } else if ("reason" in error) errors.push("error.reason is only for denied");
}

/**
 * A value for an error message, without calling anything on it: an object from JSON.parse can
 * carry a `toString` that is not a function, and String() would throw.
 * @param {unknown} v
 */
function describe(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || typeof v !== "object") return String(v);
  return Array.isArray(v) ? "(an array)" : "(an object)";
}

/**
 * Validate one decoded protocol message (or the discovery file, `kind: "discovery"`).
 * Without `kind`, it is taken from the message's `type`. For responses, `command` names the
 * request's command so the result shape can be checked; without it only the envelope is.
 * @param {unknown} message
 * @param {ValidateOptions} [options]
 * @returns {Validation}
 */
export function validateMessage(message, { kind, command } = {}) {
  /** @type {string[]} */
  const errors = [];
  if (!isObject(message)) {
    errors.push("message must be a JSON object");
    return { valid: false, errors };
  }
  if (kind !== undefined && !KINDS.includes(kind)) {
    errors.push(`unknown message kind "${kind}"`);
    return { valid: false, errors };
  }
  if (kind === "discovery") {
    checkDiscovery(message, errors);
    return { valid: errors.length === 0, errors };
  }
  const effective = kind ?? message.type;
  if (kind !== undefined && message.type !== kind) {
    errors.push(`type must be "${kind}"`);
  }
  switch (effective) {
    case "hello":
      checkHello(message, errors);
      break;
    case "challenge":
      checkChallenge(message, errors);
      break;
    case "auth":
      checkAuth(message, errors);
      break;
    case "welcome":
      checkWelcome(message, errors);
      break;
    case "request":
      checkRequest(message, errors);
      break;
    case "response":
      checkResponse(message, command, errors);
      break;
    default:
      errors.push(`unknown message type ${describe(effective)}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The server's framing (spec m0-control-server): bytes in, lines out. `\n` ends a line, one
 * `\r` before it is dropped, and a line over `max` bytes (`\r` not counted) is an overflow,
 * after which no more lines come out. A partial line is kept for the next push, at most
 * `max + 1` bytes of it. Pure, so the fuzzer can drive it (docs/specs/m7-fuzzing.md).
 */
export class LineFramer {
  /** @param {number} [max] */
  constructor(max = MAX_LINE_LENGTH) {
    this.max = max;
    /** @type {Uint8Array[]} the partial line, as pushed */
    this.chunks = [];
    this.length = 0;
    this.overflow = false;
  }

  /**
   * @param {Uint8Array} bytes  kept by reference until its partial line completes
   * @returns {Uint8Array[]} the lines `bytes` completed, in order, without their line ends
   */
  push(bytes) {
    /** @type {Uint8Array[]} */
    const lines = [];
    let start = 0;
    while (!this.overflow && start < bytes.length) {
      const nl = bytes.indexOf(0x0a, start);
      const end = nl === -1 ? bytes.length : nl;
      this.chunks.push(bytes.subarray(start, end));
      this.length += end - start;
      // One byte over the limit may be the \r of a \r\n.
      if (this.length > this.max + 1) {
        this.overflow = true;
        break;
      }
      if (nl === -1) break;
      let line = new Uint8Array(this.length);
      let at = 0;
      for (const c of this.chunks) {
        line.set(c, at);
        at += c.length;
      }
      this.chunks = [];
      this.length = 0;
      start = nl + 1;
      if (line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length > this.max) {
        this.overflow = true;
        break;
      }
      lines.push(line);
    }
    if (this.overflow) {
      this.chunks = [];
      this.length = 0;
    }
    return lines;
  }
}

/**
 * Compare two tokens in time that depends only on their lengths, not on where they differ.
 * Empty or non-string tokens are never equal.
 * @param {string} a
 * @param {string} b
 */
export function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

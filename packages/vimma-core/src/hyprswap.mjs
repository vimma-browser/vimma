/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The private workspace swapped in place on Hyprland (docs/specs/private-swap.md, ADR-017).
 * Pure: finding the sockets, the closed command set in both of Hyprland's dispatch dialects,
 * the reply and event parsers, the plan for "show X in Y's place", and Hyprland's events for the
 * pair (privatepair.mjs). The host does the I/O (host/hypr/HyprIpc.sys.mjs,
 * host/private-swap.mjs).
 *
 * With a Lua config, Hyprland runs `dispatch X` as Lua in the compositor, so a command is code.
 * The encoder takes no free text: only window addresses, workspace ids, a workspace name from a
 * strict character set, integers and the constant PARK. Anything else refuses (decision 4).
 */

import { pairStep as neutralStep, parkedWindow } from "./privatepair.mjs";

/** Where the window not in use waits: a special workspace, hidden unless toggled. */
export const PARK = "special:vimma";
/** The JSON client list. */
export const QUERY_CLIENTS = "j/clients";
/** The active workspace, where a stranded window is brought back to. */
export const QUERY_ACTIVE_WORKSPACE = "j/activeworkspace";
/** The JSON version, also the first half of the probe. */
export const QUERY_VERSION = "j/version";
/** The Lua dialect's no-op: `ok` with a Lua config, an error with a legacy one. */
export const PROBE_LUA = "dispatch hl.dsp.no_op()";

/** @typedef {"lua" | "legacy"} Dialect */
/** @typedef {number | { name: string } | typeof PARK} HyprWorkspace */

/**
 * @typedef {{ verb: "move", window: string, workspace: HyprWorkspace }
 *   | { verb: "focus", window: string }
 *   | { verb: "swap", window: string, other: string }
 *   | { verb: "fullscreen", window: string, internal: number, client: number }
 *   | { verb: "float", window: string, on: boolean }
 *   | { verb: "resize", window: string, x: number, y: number }
 *   | { verb: "position", window: string, x: number, y: number }
 *   | { verb: "noop" }} Command
 */

/**
 * A window as the swap needs it: never its title (decision 8).
 * @typedef {object} Client
 * @property {string} address
 * @property {number} pid
 * @property {{ id: number, name: string }} workspace
 * @property {boolean} floating
 * @property {number} fullscreen        0 none, 1 maximized, 2 fullscreen, 3 both
 * @property {number} fullscreenClient  what the client was told
 * @property {boolean} grouped
 * @property {boolean} pinned
 * @property {[number, number]} at
 * @property {[number, number]} size
 */

const SIGNATURE = /^[A-Za-z0-9_]{1,128}$/;
const ADDRESS = /^0x[0-9a-f]{1,16}$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const NONCE = /^vimma-[0-9a-f]{32}$/;
const MAX_WORKSPACE = 2147483647;
const MAX_COORD = 1e9;

/** @param {unknown} a @returns {a is string} */
export const isAddress = (a) => typeof a === "string" && ADDRESS.test(a);

/**
 * The instance's request and event sockets, or null when the environment does not name one
 * properly (decision 3): no other location, no override.
 * @param {{ signature: string | undefined, runtimeDir: string | undefined }} env
 * @returns {{ request: string, events: string } | null}
 */
export function hyprSockets({ signature, runtimeDir }) {
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return null;
  if (typeof runtimeDir !== "string" || !runtimeDir.startsWith("/")) return null;
  if (runtimeDir.split("/").some((part) => part === "." || part === "..")) return null;
  // Trailing slashes trimmed without a regex (a `/+$` pattern backtracks on many slashes).
  let end = runtimeDir.length;
  while (end > 1 && runtimeDir[end - 1] === "/") end--;
  const dir = `${runtimeDir.slice(0, end)}/hypr/${signature}`;
  return { request: `${dir}/.socket.sock`, events: `${dir}/.socket2.sock` };
}

/**
 * The dialect from the replies to QUERY_VERSION and PROBE_LUA.
 * @param {string} versionReply
 * @param {string} probeReply
 * @returns {{ dialect: Dialect, version: string } | { error: string }}
 */
export function detectDialect(versionReply, probeReply) {
  let info;
  try {
    info = JSON.parse(versionReply);
  } catch {
    info = null;
  }
  if (!info || typeof info !== "object" || Array.isArray(info) || typeof info.version !== "string")
    return { error: "no version reply" };
  const version = /^\d+(?:\.\d+){0,3}$/.test(info.version) ? info.version : "unknown";
  const probe = probeReply.trim();
  // A legacy config rejects the Lua no-op by name; any other reply is neither dialect.
  if (probe === "ok") return { dialect: "lua", version };
  if (probe.startsWith("Invalid dispatcher")) return { dialect: "legacy", version };
  return { error: "neither dialect" };
}

/**
 * A batch's replies, in command order.
 * @param {string} text
 */
export const splitReplies = (text) => text.split("\n\n\n");

/**
 * Whether every command of a batch of `count` succeeded. Hyprland runs the rest of a batch
 * after a failure (it is not a transaction), so each reply is checked.
 * @param {string} text
 * @param {number} count
 */
export function repliesOk(text, count) {
  const replies = splitReplies(text);
  return replies.length === count && replies.every((r) => r.trim() === "ok");
}

/** @param {unknown} v @returns {v is number} */
const isInt = (v) => Number.isSafeInteger(v);
/** @param {unknown} v */
const isCoord = (v) => isInt(v) && Math.abs(/** @type {number} */ (v)) < MAX_COORD;
/** @param {unknown} v */
const isSize = (v) => isCoord(v) && /** @type {number} */ (v) >= 1;
/** @param {unknown} v */
const isFullscreen = (v) => isInt(v) && /** @type {number} */ (v) >= 0 && v <= 3;

/**
 * A workspace reference the encoder takes, as Lua and legacy text; null when it is not one.
 * @param {unknown} ws
 * @returns {{ lua: string, legacy: string } | null}
 */
function workspaceText(ws) {
  if (ws === PARK) return { lua: `"${PARK}"`, legacy: PARK };
  if (isInt(ws) && ws >= 1 && ws <= MAX_WORKSPACE) return { lua: `${ws}`, legacy: `${ws}` };
  if (ws && typeof ws === "object" && "name" in ws) {
    const { name } = /** @type {{ name: unknown }} */ (ws);
    if (typeof name === "string" && NAME.test(name)) {
      return { lua: `"name:${name}"`, legacy: `name:${name}` };
    }
  }
  return null;
}

/**
 * Where a window's slot is, as the encoder takes it: a numbered workspace by id, a named one
 * by name. Null for a special workspace (the user's scratchpad) or a name outside the safe set:
 * that switch is shown as a window instead.
 * @param {{ id: number, name: string } | null | undefined} ws
 * @returns {HyprWorkspace | null}
 */
export function workspaceTarget(ws) {
  if (!ws) return null;
  if (isInt(ws.id) && ws.id >= 1 && ws.id <= MAX_WORKSPACE) return ws.id;
  if (typeof ws.name === "string" && NAME.test(ws.name)) return { name: ws.name };
  return null;
}

/**
 * One command as request text, in `dialect`; the legacy verbs that act on the focused window
 * focus it first. Null when anything is not in the closed set (decision 4).
 * @param {Dialect} dialect
 * @param {Command} cmd
 * @returns {string[] | null}
 */
export function encodeCommand(dialect, cmd) {
  if (dialect !== "lua" && dialect !== "legacy") return null;
  if (!cmd || typeof cmd !== "object") return null;
  const lua = dialect === "lua";
  if (cmd.verb === "noop") return lua ? [PROBE_LUA] : null;
  if (!isAddress(cmd.window)) return null;
  const w = `address:${cmd.window}`;
  const target = `window = "${w}"`;
  switch (cmd.verb) {
    case "move": {
      const ws = workspaceText(cmd.workspace);
      if (!ws) return null;
      return lua
        ? [`dispatch hl.dsp.window.move({ workspace = ${ws.lua}, follow = false, ${target} })`]
        : [`dispatch movetoworkspacesilent ${ws.legacy},${w}`];
    }
    case "focus":
      return [lua ? `dispatch hl.dsp.focus({ ${target} })` : `dispatch focuswindow ${w}`];
    case "swap":
      if (!isAddress(cmd.other)) return null;
      return lua
        ? [`dispatch hl.dsp.window.swap({ ${target}, other = "address:${cmd.other}" })`]
        : [`dispatch focuswindow ${w}`, `dispatch swapwindow address:${cmd.other}`];
    case "fullscreen": {
      const { internal, client } = cmd;
      if (!isFullscreen(internal) || !isFullscreen(client)) return null;
      return lua
        ? [
            "dispatch hl.dsp.window.fullscreen_state(" +
              `{ internal = ${internal}, client = ${client}, ${target} })`,
          ]
        : [`dispatch focuswindow ${w}`, `dispatch fullscreenstate ${internal} ${client}`];
    }
    case "float":
      if (typeof cmd.on !== "boolean") return null;
      return lua
        ? [
            `dispatch hl.dsp.window.float({ action = "${cmd.on ? "enable" : "disable"}", ${target} })`,
          ]
        : [`dispatch ${cmd.on ? "setfloating" : "settiled"} ${w}`];
    case "resize":
      if (!isSize(cmd.x) || !isSize(cmd.y)) return null;
      return lua
        ? [`dispatch hl.dsp.window.resize({ x = ${cmd.x}, y = ${cmd.y}, ${target} })`]
        : [`dispatch resizewindowpixel exact ${cmd.x} ${cmd.y},${w}`];
    case "position":
      if (!isCoord(cmd.x) || !isCoord(cmd.y)) return null;
      return lua
        ? [`dispatch hl.dsp.window.move({ x = ${cmd.x}, y = ${cmd.y}, ${target} })`]
        : [`dispatch movewindowpixel exact ${cmd.x} ${cmd.y},${w}`];
    default:
      return null;
  }
}

/**
 * Commands as one request: `[[BATCH]]a;b`, one round trip. Null when any command is refused.
 * @param {Dialect} dialect
 * @param {readonly Command[]} commands
 * @returns {{ text: string, count: number } | null}
 */
export function encodeBatch(dialect, commands) {
  if (!commands.length) return null;
  /** @type {string[]} */
  const parts = [];
  for (const cmd of commands) {
    const encoded = encodeCommand(dialect, cmd);
    if (!encoded) return null;
    parts.push(...encoded);
  }
  return { text: `[[BATCH]]${parts.join(";")}`, count: parts.length };
}

const A = "0x[0-9a-f]{1,16}";
const INT = "-?(?:0|[1-9][0-9]{0,8})";
const POS = "[1-9][0-9]{0,8}";
const ID = "[1-9][0-9]{0,9}";
const NM = "[A-Za-z0-9_.-]{1,64}";
const W = `window = "address:${A}"`;
/** The shape of every command the encoder makes (decision 4); a second check before sending. */
const COMMAND = new RegExp(
  "^dispatch (?:" +
    [
      `hl\\.dsp\\.window\\.move\\(\\{ workspace = (?:${ID}|"name:${NM}"|"${PARK}"), follow = false, ${W} \\}\\)`,
      `hl\\.dsp\\.focus\\(\\{ ${W} \\}\\)`,
      `hl\\.dsp\\.window\\.swap\\(\\{ ${W}, other = "address:${A}" \\}\\)`,
      `hl\\.dsp\\.window\\.fullscreen_state\\(\\{ internal = [0-3], client = [0-3], ${W} \\}\\)`,
      `hl\\.dsp\\.window\\.float\\(\\{ action = "(?:enable|disable)", ${W} \\}\\)`,
      `hl\\.dsp\\.window\\.resize\\(\\{ x = ${POS}, y = ${POS}, ${W} \\}\\)`,
      `hl\\.dsp\\.window\\.move\\(\\{ x = ${INT}, y = ${INT}, ${W} \\}\\)`,
      "hl\\.dsp\\.no_op\\(\\)",
      `movetoworkspacesilent (?:${ID}|name:${NM}|${PARK}),address:${A}`,
      `(?:focuswindow|swapwindow|setfloating|settiled) address:${A}`,
      "fullscreenstate [0-3] [0-3]",
      `(?:resizewindowpixel exact ${POS} ${POS}|movewindowpixel exact ${INT} ${INT}),address:${A}`,
    ].join("|") +
    ")$",
);

/**
 * Whether `text` is a request Vimma may send: one of the two queries, or commands of the
 * closed set, alone or as a batch. HyprIpc refuses anything else.
 * @param {string} text
 */
export function isAllowedRequest(text) {
  if (text === QUERY_CLIENTS || text === QUERY_VERSION || text === QUERY_ACTIVE_WORKSPACE)
    return true;
  const body = text.startsWith("[[BATCH]]") ? text.slice("[[BATCH]]".length) : text;
  return body !== "" && body.split(";").every((c) => COMMAND.test(c));
}

/** @param {unknown} v @returns {v is [number, number]} */
const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number");

/**
 * `j/clients` as the swap's records. Titles are dropped here (decision 8); malformed entries
 * are skipped.
 * @param {string} json
 * @returns {Client[]}
 */
export function parseClients(json) {
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  /** @type {Client[]} */
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || !isAddress(c.address) || !isInt(c.pid)) continue;
    const ws = c.workspace;
    if (!ws || !isInt(ws.id) || typeof ws.name !== "string") continue;
    if (!isPair(c.at) || !isPair(c.size)) continue;
    out.push({
      address: c.address,
      pid: c.pid,
      workspace: { id: ws.id, name: ws.name },
      floating: c.floating === true,
      fullscreen: isInt(c.fullscreen) ? c.fullscreen : 0,
      fullscreenClient: isInt(c.fullscreenClient) ? c.fullscreenClient : 0,
      grouped: Array.isArray(c.grouped) && c.grouped.length > 0,
      pinned: c.pinned === true,
      at: [c.at[0], c.at[1]],
      size: [c.size[0], c.size[1]],
    });
  }
  return out;
}

/**
 * The fallback when no title event came: the address of our process's window titled `nonce`.
 * Titles are compared and dropped, never kept.
 * @param {string} json  `j/clients`
 * @param {string} nonce
 * @param {number} pid
 * @returns {string | null}
 */
export function findNonce(json, nonce, pid) {
  if (!isNonceTitle(nonce)) return null;
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const hit = list.find((c) => c?.title === nonce && c?.pid === pid && isAddress(c?.address));
  return hit ? hit.address : null;
}

/** @param {unknown} t */
export const isNonceTitle = (t) => typeof t === "string" && NONCE.test(t);

/**
 * The title a window carries for a moment so Hyprland's event names its address: random,
 * saying nothing about the window (decision 5).
 * @param {Uint8Array} bytes  16 random bytes
 */
export function nonceTitle(bytes) {
  if (bytes.length !== 16) throw new Error("a nonce takes 16 bytes");
  return `vimma-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * @typedef {{ type: "nonce", address: string, nonce: string }
 *   | { type: "close", address: string }
 *   | { type: "open", address: string }
 *   | { type: "move", address: string, workspace: string }} HyprEvent
 */

/** @param {string} hex  an event's address, without 0x */
const eventAddress = (hex) => {
  const a = `0x${hex}`;
  return isAddress(a) ? a : null;
};

/**
 * One `.socket2.sock` line. A title is compared with the pending nonces and dropped; no other
 * title leaves this function (decision 8).
 * @param {string} line
 * @param {ReadonlySet<string>} nonces
 * @returns {HyprEvent | null}
 */
export function parseEvent(line, nonces) {
  const at = line.indexOf(">>");
  if (at < 0) return null;
  const name = line.slice(0, at);
  const data = line.slice(at + 2);
  const comma = data.indexOf(",");
  const head = comma < 0 ? data : data.slice(0, comma);
  const rest = comma < 0 ? null : data.slice(comma + 1);
  const address = eventAddress(head);
  if (!address) return null;
  switch (name) {
    case "windowtitlev2":
      return rest !== null && nonces.has(rest) ? { type: "nonce", address, nonce: rest } : null;
    case "closewindow":
      return { type: "close", address };
    case "openwindow": {
      // ADDR,WORKSPACE,CLASS,TITLE: a window can open with its nonce already set.
      const parts = rest === null ? [] : rest.split(",");
      const title = parts.length >= 3 ? parts.slice(2).join(",") : null;
      if (title !== null && nonces.has(title)) return { type: "nonce", address, nonce: title };
      return { type: "open", address };
    }
    case "movewindowv2": {
      if (rest === null) return null;
      const c = rest.indexOf(",");
      return c < 0 ? null : { type: "move", address, workspace: rest.slice(c + 1) };
    }
    default:
      return null;
  }
}

/**
 * `j/activeworkspace` as a target the encoder takes, or null.
 * @param {string} json
 * @returns {HyprWorkspace | null}
 */
export function parseActiveWorkspace(json) {
  try {
    const ws = JSON.parse(json);
    return ws && typeof ws === "object" ? workspaceTarget(ws) : null;
  } catch {
    return null;
  }
}

/**
 * After a swap could not be done: whichever window is in PARK comes out, to the other window's
 * workspace, else the active one, else workspace 1, and the window to show is focused. A window
 * is never left in special:vimma.
 * @param {Client | undefined} show
 * @param {Client | undefined} place
 * @param {HyprWorkspace | null} active  from parseActiveWorkspace
 * @returns {Command[]}
 */
export function planRescue(show, place, active) {
  const stuck = [show, place].find((c) => c?.workspace.name === PARK);
  const other = stuck === show ? place : show;
  const otherWs = other && other.workspace.name !== PARK ? workspaceTarget(other.workspace) : null;
  /** @type {Command[]} */
  const commands = [];
  if (stuck) {
    commands.push({ verb: "move", window: stuck.address, workspace: otherWs ?? active ?? 1 });
  }
  const focus = show?.address ?? stuck?.address ?? null;
  if (focus) commands.push({ verb: "focus", window: focus });
  return commands;
}

/**
 * @typedef {{ kind: "swap" | "plain", parks: boolean, commands: Command[] }
 *   | { kind: "refuse", reason: string }} ShowPlan
 */

/**
 * Show `show` exactly where `place` is, and park `place` (Design: the mechanism). A tiled slot:
 * move in, swap, park, focus; the other tiles keep their boxes. A floating one: exact size and
 * position. Fullscreen is unset first and set again on the shown window. A grouped or pinned
 * slot is not swapped: the window is moved there and focused, nothing parked (decision 6).
 * @param {Dialect} dialect
 * @param {Client} show
 * @param {Client} place
 * @returns {ShowPlan}
 */
export function planShow(dialect, show, place) {
  /** @param {string} reason @returns {ShowPlan} */
  const refuse = (reason) => ({ kind: "refuse", reason });
  if (!isAddress(show.address) || !isAddress(place.address)) return refuse("bad address");
  if (show.address === place.address) return refuse("the same window");
  const ws = workspaceTarget(place.workspace);
  if (ws === null) return refuse("the window is on a workspace Vimma does not move to");
  for (const v of [
    show.fullscreen,
    show.fullscreenClient,
    place.fullscreen,
    place.fullscreenClient,
  ])
    if (!isFullscreen(v)) return refuse("bad fullscreen state");
  const X = show.address;
  const Y = place.address;
  const moveIn =
    show.workspace.id === place.workspace.id ? [] : [{ verb: "move", window: X, workspace: ws }];
  /** @type {Command[]} */
  let commands;
  /** @type {"swap" | "plain"} */
  let kind = "swap";
  if (place.grouped || place.pinned) {
    kind = "plain";
    commands = [.../** @type {Command[]} */ (moveIn), { verb: "focus", window: X }];
  } else {
    commands = [];
    if (place.fullscreen) commands.push({ verb: "fullscreen", window: Y, internal: 0, client: 0 });
    if (show.fullscreen) commands.push({ verb: "fullscreen", window: X, internal: 0, client: 0 });
    if (place.floating) {
      commands.push(.../** @type {Command[]} */ (moveIn));
      if (!show.floating) commands.push({ verb: "float", window: X, on: true });
      commands.push(
        { verb: "resize", window: X, x: place.size[0], y: place.size[1] },
        { verb: "position", window: X, x: place.at[0], y: place.at[1] },
      );
    } else {
      if (show.floating) commands.push({ verb: "float", window: X, on: false });
      commands.push(.../** @type {Command[]} */ (moveIn), { verb: "swap", window: X, other: Y });
    }
    commands.push({ verb: "move", window: Y, workspace: PARK }, { verb: "focus", window: X });
    if (place.fullscreen) {
      commands.push({
        verb: "fullscreen",
        window: X,
        internal: place.fullscreen,
        client: place.fullscreenClient,
      });
    }
  }
  if (!encodeBatch(dialect, commands)) return refuse("a value outside the command set");
  return { kind, parks: kind === "swap", commands };
}

/**
 * The normal window private was entered from and the private window shown in its place; at most
 * one of them is parked. In memory only (decision 8). Window identifiers are Hyprland addresses.
 * @typedef {import("./privatepair.mjs").Pair} Pair
 */

/** @typedef {import("./privatepair.mjs").ShowOp} ShowOp */

/**
 * Hyprland's pair events: core's backend-neutral ones (privatepair.mjs), and `moved` for a
 * movewindowv2 event, which ends the pair only when the parked window left special:vimma.
 * @typedef {import("./privatepair.mjs").PairEvent
 *   | { type: "moved", window: string, workspace: string }} PairEvent
 */

export { parkedWindow };

/**
 * The pair's state machine (decisions 6, 7), privatepair.mjs's, for Hyprland's events.
 * @param {Pair} pair
 * @param {PairEvent} event
 * @returns {{ state: Pair, ops: ShowOp[] }}
 */
export function pairStep(pair, event) {
  if (event.type !== "moved") return neutralStep(pair, event);
  if (event.workspace === PARK) return { state: pair, ops: [] };
  return neutralStep(pair, { type: "unparked", window: event.window });
}

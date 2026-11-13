import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  PARK,
  PROBE_LUA,
  QUERY_ACTIVE_WORKSPACE,
  QUERY_CLIENTS,
  QUERY_VERSION,
  detectDialect,
  encodeBatch,
  encodeCommand,
  findNonce,
  hyprSockets,
  isAddress,
  isAllowedRequest,
  isNonceTitle,
  nonceTitle,
  pairStep,
  parkedWindow,
  parseActiveWorkspace,
  parseClients,
  parseEvent,
  planRescue,
  planShow,
  repliesOk,
  splitReplies,
  workspaceTarget,
} from "../src/hyprswap.mjs";
/** @import { Client, Command, ShowPlan } from "../src/hyprswap.mjs" */

// docs/specs/private-swap.md decisions 3, 4, 5, 6, 7 and 9; ADR-017.

const A = "0x571e4538c0b0";
const B = "0x571e44830ae0";

/**
 * A client record as parseClients returns it.
 * @param {Partial<Client>} [over]
 * @returns {Client}
 */
function client(over = {}) {
  return {
    address: A,
    pid: 4242,
    workspace: { id: 3, name: "3" },
    floating: false,
    fullscreen: 0,
    fullscreenClient: 0,
    grouped: false,
    pinned: false,
    at: [12, 43],
    size: [621, 745],
    ...over,
  };
}

/**
 * A plan's commands; throws on a refusal, which has none.
 * @param {ShowPlan} plan
 */
function commandsOf(plan) {
  if (plan.kind === "refuse") throw new Error(`refused: ${plan.reason}`);
  return plan.commands;
}

/** Every character a command may hold (decision 4). */
const SAFE = /^[A-Za-z0-9_.:,{}()= "-]*$/;

describe("finding Hyprland (decision 3)", () => {
  const signature = "efb50993780079460b0cbed1363e2166a2de1d9f_1790951252_538312960";
  test("the instance's two sockets under $XDG_RUNTIME_DIR/hypr/<signature>/", () => {
    expect(hyprSockets({ signature, runtimeDir: "/run/user/1000" })).toEqual({
      request: `/run/user/1000/hypr/${signature}/.socket.sock`,
      events: `/run/user/1000/hypr/${signature}/.socket2.sock`,
    });
    expect(hyprSockets({ signature, runtimeDir: "/run/user/1000/" })?.request).toBe(
      `/run/user/1000/hypr/${signature}/.socket.sock`,
    );
    expect(hyprSockets({ signature, runtimeDir: `/run${"/".repeat(50000)}` })?.request).toBe(
      `/run/hypr/${signature}/.socket.sock`,
    );
  });

  test.each([
    ["", "/run/user/1000"],
    ["../../etc", "/run/user/1000"],
    ["a/b", "/run/user/1000"],
    ["x".repeat(129), "/run/user/1000"],
    ["sig with space", "/run/user/1000"],
    [signature, ""],
    [signature, "run/user/1000"],
    [signature, "/run/../tmp"],
    [undefined, "/run/user/1000"],
  ])("refuses signature %j with runtime dir %j", (sig, dir) => {
    expect(hyprSockets({ signature: /** @type {any} */ (sig), runtimeDir: dir })).toBeNull();
  });
});

describe("the dialect probe (decision 3)", () => {
  const version = JSON.stringify({ version: "0.56.2", tag: "v0.56.2" });
  test("ok to hl.dsp.no_op() is the Lua dialect", () => {
    expect(PROBE_LUA).toBe("dispatch hl.dsp.no_op()");
    expect(QUERY_VERSION).toBe("j/version");
    expect(detectDialect(version, "ok")).toEqual({ dialect: "lua", version: "0.56.2" });
  });
  test("a version but an error to the Lua probe is the legacy dialect", () => {
    expect(detectDialect(version, "Invalid dispatcher")).toEqual({
      dialect: "legacy",
      version: "0.56.2",
    });
  });
  test("a probe reply that is neither dialect's is no Hyprland", () => {
    expect(detectDialect(version, "error: nope")).toEqual({ error: "neither dialect" });
    expect(detectDialect(version, "")).toEqual({ error: "neither dialect" });
    expect(detectDialect(version, 'Invalid dispatcher, requested "hl.dsp.no_op()"')).toEqual({
      dialect: "legacy",
      version: "0.56.2",
    });
  });
  test("no JSON version is no Hyprland, whatever the probe says", () => {
    expect(detectDialect("error", "ok")).toEqual({ error: "no version reply" });
    expect(detectDialect("[]", "ok")).toEqual({ error: "no version reply" });
    expect(detectDialect('{"version": 3}', "ok")).toEqual({ error: "no version reply" });
  });
  test("a version that is not a plain dotted number is not quoted", () => {
    expect(detectDialect(JSON.stringify({ version: "0.56<b>" }), "ok")).toEqual({
      dialect: "lua",
      version: "unknown",
    });
  });
});

describe("batch replies", () => {
  test("split on the blank lines Hyprland joins them with", () => {
    expect(splitReplies("ok\n\n\nok\n\n\nok")).toEqual(["ok", "ok", "ok"]);
    expect(splitReplies("ok")).toEqual(["ok"]);
  });
  test("every reply ok, and as many as commands", () => {
    expect(repliesOk("ok\n\n\nok", 2)).toBe(true);
    expect(repliesOk("ok\n\n\nerror: return hl.dispatch(x):1: …", 2)).toBe(false);
    expect(repliesOk("ok\n\n\nwarning: hl.window.swap: target window not found", 2)).toBe(false);
    expect(repliesOk("ok", 2)).toBe(false);
    expect(repliesOk("ok\n", 1)).toBe(true);
  });
});

describe("the encoder (decision 4)", () => {
  const lua = (/** @type {Command} */ c) => encodeCommand("lua", c);
  const legacy = (/** @type {Command} */ c) => encodeCommand("legacy", c);

  test("every verb in the Lua dialect", () => {
    expect(lua({ verb: "move", window: A, workspace: 3 })).toEqual([
      `dispatch hl.dsp.window.move({ workspace = 3, follow = false, window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "move", window: A, workspace: { name: "web" } })).toEqual([
      `dispatch hl.dsp.window.move({ workspace = "name:web", follow = false, window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "move", window: A, workspace: PARK })).toEqual([
      `dispatch hl.dsp.window.move({ workspace = "special:vimma", follow = false, window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "focus", window: A })).toEqual([
      `dispatch hl.dsp.focus({ window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "swap", window: A, other: B })).toEqual([
      `dispatch hl.dsp.window.swap({ window = "address:${A}", other = "address:${B}" })`,
    ]);
    expect(lua({ verb: "fullscreen", window: A, internal: 2, client: 1 })).toEqual([
      `dispatch hl.dsp.window.fullscreen_state({ internal = 2, client = 1, window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "float", window: A, on: true })).toEqual([
      `dispatch hl.dsp.window.float({ action = "enable", window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "float", window: A, on: false })).toEqual([
      `dispatch hl.dsp.window.float({ action = "disable", window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "resize", window: A, x: 621, y: 745 })).toEqual([
      `dispatch hl.dsp.window.resize({ x = 621, y = 745, window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "position", window: A, x: -1920, y: 43 })).toEqual([
      `dispatch hl.dsp.window.move({ x = -1920, y = 43, window = "address:${A}" })`,
    ]);
    expect(lua({ verb: "noop" })).toEqual(["dispatch hl.dsp.no_op()"]);
  });

  test("every verb in the legacy dialect; the ones that act on the focused window focus first", () => {
    expect(legacy({ verb: "move", window: A, workspace: 3 })).toEqual([
      `dispatch movetoworkspacesilent 3,address:${A}`,
    ]);
    expect(legacy({ verb: "move", window: A, workspace: { name: "web" } })).toEqual([
      `dispatch movetoworkspacesilent name:web,address:${A}`,
    ]);
    expect(legacy({ verb: "move", window: A, workspace: PARK })).toEqual([
      `dispatch movetoworkspacesilent special:vimma,address:${A}`,
    ]);
    expect(legacy({ verb: "focus", window: A })).toEqual([`dispatch focuswindow address:${A}`]);
    expect(legacy({ verb: "swap", window: A, other: B })).toEqual([
      `dispatch focuswindow address:${A}`,
      `dispatch swapwindow address:${B}`,
    ]);
    expect(legacy({ verb: "fullscreen", window: A, internal: 0, client: 0 })).toEqual([
      `dispatch focuswindow address:${A}`,
      "dispatch fullscreenstate 0 0",
    ]);
    expect(legacy({ verb: "float", window: A, on: true })).toEqual([
      `dispatch setfloating address:${A}`,
    ]);
    expect(legacy({ verb: "float", window: A, on: false })).toEqual([
      `dispatch settiled address:${A}`,
    ]);
    expect(legacy({ verb: "resize", window: A, x: 621, y: 745 })).toEqual([
      `dispatch resizewindowpixel exact 621 745,address:${A}`,
    ]);
    expect(legacy({ verb: "position", window: A, x: 12, y: 43 })).toEqual([
      `dispatch movewindowpixel exact 12 43,address:${A}`,
    ]);
    expect(legacy({ verb: "noop" })).toBeNull();
  });

  test.each([
    [{ verb: "focus", window: "0x" }],
    [{ verb: "focus", window: "0xABC" }],
    [{ verb: "focus", window: `${A}"` }],
    [{ verb: "focus", window: "0x12345678901234567" }],
    [{ verb: "focus", window: 12 }],
    [{ verb: "swap", window: A, other: "title:Vimma" }],
    [{ verb: "move", window: A, workspace: -1 }],
    [{ verb: "move", window: A, workspace: 0 }],
    [{ verb: "move", window: A, workspace: 1.5 }],
    [{ verb: "move", window: A, workspace: "3" }],
    [{ verb: "move", window: A, workspace: "+1" }],
    [{ verb: "move", window: A, workspace: "e+1" }],
    [{ verb: "move", window: A, workspace: "special:scratchpad" }],
    [{ verb: "move", window: A, workspace: { name: 'a" })' } }],
    [{ verb: "move", window: A, workspace: { name: "special:x" } }],
    [{ verb: "move", window: A, workspace: { name: "a]b" } }],
    [{ verb: "move", window: A, workspace: { name: "" } }],
    [{ verb: "move", window: A, workspace: { name: "x".repeat(65) } }],
    [{ verb: "fullscreen", window: A, internal: 4, client: 0 }],
    [{ verb: "fullscreen", window: A, internal: 0, client: -1 }],
    [{ verb: "resize", window: A, x: 0, y: 10 }],
    [{ verb: "resize", window: A, x: 10, y: Number.NaN }],
    [{ verb: "position", window: A, x: 1e20, y: 0 }],
    [{ verb: "position", window: A, x: "1", y: 0 }],
    [{ verb: "float", window: A, on: "yes" }],
    [{ verb: "exec", window: A }],
    [null],
  ])("refuses %j", (cmd) => {
    expect(encodeCommand("lua", /** @type {any} */ (cmd))).toBeNull();
    expect(encodeCommand("legacy", /** @type {any} */ (cmd))).toBeNull();
  });

  test("an unknown dialect encodes nothing", () => {
    expect(encodeCommand(/** @type {any} */ ("sway"), { verb: "focus", window: A })).toBeNull();
  });

  test("a batch joins the commands; one with a refused command is refused whole", () => {
    expect(
      encodeBatch("lua", [
        { verb: "focus", window: A },
        { verb: "swap", window: A, other: B },
      ]),
    ).toEqual({
      text:
        `[[BATCH]]dispatch hl.dsp.focus({ window = "address:${A}" });` +
        `dispatch hl.dsp.window.swap({ window = "address:${A}", other = "address:${B}" })`,
      count: 2,
    });
    expect(encodeBatch("legacy", [{ verb: "swap", window: A, other: B }])?.count).toBe(2);
    expect(
      encodeBatch("lua", [
        { verb: "focus", window: A },
        { verb: "focus", window: "nope" },
      ]),
    ).toBeNull();
    expect(encodeBatch("lua", [])).toBeNull();
  });

  test("the whitelist accepts what the encoder makes and the queries, nothing else", () => {
    expect(isAllowedRequest(QUERY_CLIENTS)).toBe(true);
    expect(isAllowedRequest(QUERY_VERSION)).toBe(true);
    expect(isAllowedRequest(QUERY_ACTIVE_WORKSPACE)).toBe(true);
    expect(isAllowedRequest(PROBE_LUA)).toBe(true);
    const batch = encodeBatch("lua", [
      { verb: "move", window: A, workspace: PARK },
      { verb: "focus", window: B },
    ]);
    expect(isAllowedRequest(batch?.text ?? "")).toBe(true);
    expect(isAllowedRequest(`dispatch movetoworkspacesilent 3,address:${A}`)).toBe(true);
    for (const bad of [
      'dispatch hl.dsp.exec_cmd("kitty")',
      "dispatch exec kitty",
      "j/clients;dispatch exec x",
      `dispatch hl.dsp.focus({ window = "address:${A}" }) hl.exec_cmd("x")`,
      `dispatch hl.dsp.focus({ window = "title:Vimma" })`,
      "[[BATCH]]",
      "keyword general:layout master",
      "",
      `dispatch hl.dsp.focus({ window = "address:${A}" })\n`,
    ]) {
      expect(isAllowedRequest(bad), bad).toBe(false);
    }
  });
});

describe("workspaceTarget: where a window's slot is", () => {
  test("a numbered workspace by id, a named one by name", () => {
    expect(workspaceTarget({ id: 3, name: "3" })).toBe(3);
    expect(workspaceTarget({ id: -1337, name: "web" })).toEqual({ name: "web" });
  });
  test("a special workspace, or a name outside the safe set, has none", () => {
    expect(workspaceTarget({ id: -98, name: "special:scratchpad" })).toBeNull();
    expect(workspaceTarget({ id: -1337, name: 'a"b' })).toBeNull();
    expect(workspaceTarget({ id: 0, name: "" })).toBeNull();
    expect(workspaceTarget(/** @type {any} */ (null))).toBeNull();
  });
});

describe("parseActiveWorkspace", () => {
  test("the active workspace's id when it is a numbered one, else null", () => {
    expect(QUERY_ACTIVE_WORKSPACE).toBe("j/activeworkspace");
    expect(parseActiveWorkspace(JSON.stringify({ id: 4, name: "4", monitor: "eDP-1" }))).toBe(4);
    expect(parseActiveWorkspace(JSON.stringify({ id: -1337, name: "web" }))).toEqual({
      name: "web",
    });
    expect(parseActiveWorkspace(JSON.stringify({ id: -98, name: "special:x" }))).toBeNull();
    expect(parseActiveWorkspace("nope")).toBeNull();
    expect(parseActiveWorkspace("null")).toBeNull();
  });
});

// The normal window must never stay in special:vimma.
describe("planRescue: whatever is stuck in special:vimma comes out", () => {
  const normal = client({ workspace: { id: -98, name: PARK } });
  test("to the other window's workspace", () => {
    const priv = client({ address: B, workspace: { id: 5, name: "5" } });
    expect(planRescue(normal, priv, null)).toEqual([
      { verb: "move", window: A, workspace: 5 },
      { verb: "focus", window: A },
    ]);
  });
  test("to the active workspace when the other is on a special workspace (a scratchpad)", () => {
    const priv = client({ address: B, workspace: { id: -97, name: "special:scratchpad" } });
    expect(planRescue(normal, priv, 2)).toEqual([
      { verb: "move", window: A, workspace: 2 },
      { verb: "focus", window: A },
    ]);
    expect(planRescue(normal, priv, { name: "web" })[0]).toEqual({
      verb: "move",
      window: A,
      workspace: { name: "web" },
    });
  });
  test("to workspace 1 when nothing else is known; the other window may be gone", () => {
    expect(planRescue(normal, undefined, null)).toEqual([
      { verb: "move", window: A, workspace: 1 },
      { verb: "focus", window: A },
    ]);
  });
  test("the slot window stuck instead: it comes out, and the shown one keeps the focus", () => {
    const shown = client({ address: B, workspace: { id: 3, name: "3" } });
    expect(planRescue(shown, normal, null)).toEqual([
      { verb: "move", window: A, workspace: 3 },
      { verb: "focus", window: B },
    ]);
  });
  test("nothing stuck: just the focus", () => {
    expect(planRescue(client(), undefined, null)).toEqual([{ verb: "focus", window: A }]);
    expect(planRescue(undefined, undefined, null)).toEqual([]);
  });
});

describe("the clients parser (decision 5, 8)", () => {
  const raw = [
    {
      address: A,
      mapped: true,
      hidden: false,
      at: [12, 43],
      size: [621, 745],
      workspace: { id: 3, name: "3" },
      floating: false,
      pseudo: false,
      monitor: 0,
      class: "vimma-vimma",
      title: "Secret page — Vimma",
      initialClass: "vimma-vimma",
      initialTitle: "Vimma",
      pid: 4242,
      xwayland: false,
      pinned: false,
      fullscreen: 2,
      fullscreenClient: 2,
      grouped: [],
      tags: [],
      swallowing: "0x0",
      focusHistoryID: 0,
      inhibitingIdle: false,
      xdgTag: "",
      xdgDescription: "",
      stableId: "1",
    },
    { address: "bad", pid: 1, workspace: { id: 1, name: "1" }, at: [0, 0], size: [1, 1] },
    {
      address: B,
      pid: 7,
      workspace: { id: -1337, name: "web" },
      at: [0, 0],
      size: [10, 10],
      floating: true,
      grouped: [B, A],
      pinned: true,
    },
  ];
  test("keeps the swap's fields and never a title", () => {
    const records = parseClients(JSON.stringify(raw));
    expect(records).toEqual([
      client({ fullscreen: 2, fullscreenClient: 2 }),
      client({
        address: B,
        pid: 7,
        workspace: { id: -1337, name: "web" },
        at: [0, 0],
        size: [10, 10],
        floating: true,
        grouped: true,
        pinned: true,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("Secret");
    expect(JSON.stringify(records)).not.toContain("Title");
  });
  test("malformed replies are no clients", () => {
    expect(parseClients("error")).toEqual([]);
    expect(parseClients("{}")).toEqual([]);
    expect(parseClients(JSON.stringify([null, 3, { address: A }]))).toEqual([]);
  });
  test("findNonce: the address of the window with our nonce title and our pid", () => {
    const nonce = `vimma-${"ab".repeat(16)}`;
    const json = JSON.stringify([
      { ...raw[0], title: nonce, pid: 99 },
      { ...raw[0], address: B, title: nonce, pid: 4242 },
    ]);
    expect(findNonce(json, nonce, 4242)).toBe(B);
    expect(findNonce(json, nonce, 1)).toBeNull();
    expect(findNonce("nope", nonce, 4242)).toBeNull();
    expect(findNonce(json, "Vimma", 4242)).toBeNull();
  });
});

describe("the nonce title (decision 5)", () => {
  test("vimma- and 32 hex digits from 16 random bytes", () => {
    const t = nonceTitle(new Uint8Array(16).map((_, i) => i * 17));
    expect(t).toBe("vimma-00112233445566778899aabbccddeeff");
    expect(isNonceTitle(t)).toBe(true);
    expect(isNonceTitle("vimma-00")).toBe(false);
    expect(isNonceTitle(`Vimma ${t}`)).toBe(false);
    expect(() => nonceTitle(new Uint8Array(4))).toThrow();
  });
});

describe("the event parser (decision 5, 8)", () => {
  const nonce = `vimma-${"cd".repeat(16)}`;
  const pending = new Set([nonce]);
  test("windowtitlev2 matches only a pending nonce, and keeps no other title", () => {
    expect(parseEvent(`windowtitlev2>>${A.slice(2)},${nonce}`, pending)).toEqual({
      type: "nonce",
      address: A,
      nonce,
    });
    expect(parseEvent(`windowtitlev2>>${A.slice(2)},Bank — Vimma Private Browsing`, pending)).toBe(
      null,
    );
    expect(parseEvent(`windowtitlev2>>${A.slice(2)},${nonce}x`, pending)).toBeNull();
  });
  test("close, move and open events; Hyprland's addresses come without 0x", () => {
    expect(parseEvent(`closewindow>>${A.slice(2)}`, pending)).toEqual({
      type: "close",
      address: A,
    });
    expect(parseEvent(`movewindowv2>>${A.slice(2)},-98,special:vimma`, pending)).toEqual({
      type: "move",
      address: A,
      workspace: "special:vimma",
    });
    expect(parseEvent(`movewindowv2>>${A.slice(2)},3,a,b`, pending)).toEqual({
      type: "move",
      address: A,
      workspace: "a,b",
    });
    expect(parseEvent(`openwindow>>${A.slice(2)},3,vimma-vimma,${nonce}`, pending)).toEqual({
      type: "nonce",
      address: A,
      nonce,
    });
    expect(parseEvent(`openwindow>>${A.slice(2)},3,vimma-vimma,Secret`, pending)).toEqual({
      type: "open",
      address: A,
    });
  });
  test("malformed or other lines are ignored", () => {
    for (const line of [
      "",
      "garbage",
      "closewindow>>zz",
      "movewindowv2>>abc",
      "windowtitlev2>>",
      "activewindow>>vimma-vimma,Secret",
      `closewindow>>${"1".repeat(17)}`,
    ]) {
      expect(parseEvent(line, pending), line).toBeNull();
    }
  });
});

describe("planShow: show X in Y's place (Design: the mechanism)", () => {
  const normal = client();
  const priv = client({ address: B, workspace: { id: -98, name: PARK }, at: [0, 0], size: [9, 9] });

  test("tiled: move in, swap, park, focus", () => {
    expect(planShow("lua", priv, normal)).toEqual({
      kind: "swap",
      parks: true,
      commands: [
        { verb: "move", window: B, workspace: 3 },
        { verb: "swap", window: B, other: A },
        { verb: "move", window: A, workspace: PARK },
        { verb: "focus", window: B },
      ],
    });
  });

  test("already on the slot's workspace (a new window): no first move", () => {
    const fresh = client({ address: B, at: [647, 43] });
    expect(planShow("lua", fresh, normal)).toMatchObject({
      commands: [
        { verb: "swap", window: B, other: A },
        { verb: "move", window: A, workspace: PARK },
        { verb: "focus", window: B },
      ],
    });
  });

  test.each([
    [1, 0],
    [2, 2],
    [2, 1],
  ])("fullscreen %i (client %i): unset on the slot window, set on the shown one", (fs, fc_) => {
    const plan = planShow("lua", priv, client({ fullscreen: fs, fullscreenClient: fc_ }));
    expect(plan).toMatchObject({ kind: "swap" });
    const cmds = commandsOf(plan);
    expect(cmds[0]).toEqual({ verb: "fullscreen", window: A, internal: 0, client: 0 });
    expect(cmds.at(-1)).toEqual({ verb: "fullscreen", window: B, internal: fs, client: fc_ });
  });

  test("a fullscreen window coming back is unset before it moves", () => {
    const plan = planShow("lua", { ...priv, fullscreen: 1, fullscreenClient: 1 }, normal);
    expect(commandsOf(plan)[0]).toEqual({
      verb: "fullscreen",
      window: B,
      internal: 0,
      client: 0,
    });
  });

  test("a floating window shown in a tile is tiled first", () => {
    const plan = planShow("lua", { ...priv, floating: true }, normal);
    expect(commandsOf(plan)[0]).toEqual({ verb: "float", window: B, on: false });
  });

  test("a floating slot: float, exact size and position, park; no swap", () => {
    const slot = client({ floating: true, at: [100, 120], size: [500, 300] });
    expect(planShow("lua", priv, slot)).toEqual({
      kind: "swap",
      parks: true,
      commands: [
        { verb: "move", window: B, workspace: 3 },
        { verb: "float", window: B, on: true },
        { verb: "resize", window: B, x: 500, y: 300 },
        { verb: "position", window: B, x: 100, y: 120 },
        { verb: "move", window: A, workspace: PARK },
        { verb: "focus", window: B },
      ],
    });
    const floatingAlready = planShow("lua", { ...priv, floating: true }, slot);
    expect(commandsOf(floatingAlready)).not.toContainEqual({
      verb: "float",
      window: B,
      on: true,
    });
  });

  test.each([["grouped"], ["pinned"]])("a %s slot: no swap, moved there and focused", (k) => {
    expect(planShow("lua", priv, client({ [k]: true }))).toEqual({
      kind: "plain",
      parks: false,
      commands: [
        { verb: "move", window: B, workspace: 3 },
        { verb: "focus", window: B },
      ],
    });
  });

  test("a named workspace slot moves by name", () => {
    const plan = planShow("lua", priv, client({ workspace: { id: -1337, name: "web" } }));
    expect(commandsOf(plan)[0]).toEqual({
      verb: "move",
      window: B,
      workspace: { name: "web" },
    });
  });

  test.each([
    ["a special workspace slot", priv, client({ workspace: { id: -98, name: "special:x" } })],
    ["a bad address", { ...priv, address: "zz" }, normal],
    ["the same window", normal, normal],
    ["a bad geometry", priv, client({ floating: true, size: [0, 0] })],
    ["a bad fullscreen", priv, client({ fullscreen: 7 })],
  ])("refuses %s", (_what, show, place) => {
    expect(planShow("lua", show, place)).toMatchObject({ kind: "refuse" });
  });

  test("the legacy dialect plans the same and encodes with focus first", () => {
    const plan = planShow("legacy", priv, normal);
    expect(plan.kind).toBe("swap");
    expect(encodeBatch("legacy", commandsOf(plan))?.text).toBe(
      `[[BATCH]]dispatch movetoworkspacesilent 3,address:${B};` +
        `dispatch focuswindow address:${B};dispatch swapwindow address:${A};` +
        `dispatch movetoworkspacesilent special:vimma,address:${A};` +
        `dispatch focuswindow address:${B}`,
    );
  });

  test("property: every planned batch is whitelisted and safe, or the plan refuses", () => {
    const addr = fc.oneof(
      fc.constantFrom(A, B, "0x1", "0xffffffffffffffff"),
      fc.string({ maxLength: 20 }),
    );
    const ws = fc.oneof(
      fc.record({ id: fc.integer({ min: -2000, max: 2000 }), name: fc.string({ maxLength: 70 }) }),
      fc.record({
        id: fc.integer({ min: 1, max: 99 }),
        name: fc.constantFrom("1", "2", "web", "special:vimma", 'x";hl.exec_cmd("y")'),
      }),
    );
    const int = fc.oneof(fc.integer({ min: -5000, max: 5000 }), fc.double());
    const rec = fc.record({
      address: addr,
      pid: fc.integer(),
      workspace: ws,
      floating: fc.boolean(),
      fullscreen: fc.integer({ min: -1, max: 4 }),
      fullscreenClient: fc.integer({ min: -1, max: 4 }),
      grouped: fc.boolean(),
      pinned: fc.boolean(),
      at: fc.tuple(int, int),
      size: fc.tuple(int, int),
    });
    fc.assert(
      fc.property(fc.constantFrom("lua", "legacy"), rec, rec, (dialect, show, place) => {
        const plan = planShow(dialect, show, place);
        if (plan.kind === "refuse") return true;
        const batch = encodeBatch(dialect, plan.commands);
        if (!batch) return false;
        const commands = batch.text.replace(/^\[\[BATCH\]\]/, "").split(";");
        return isAllowedRequest(batch.text) && commands.every((c) => SAFE.test(c));
      }),
      { numRuns: 2000 },
    );
  });

  test("property: valid windows always plan, and the plan is whitelisted", () => {
    const hex = fc.integer({ min: 1, max: 0xffffffffff }).map((n) => `0x${n.toString(16)}`);
    const coord = fc.integer({ min: -4000, max: 4000 });
    const size = fc.integer({ min: 1, max: 8000 });
    const rec = (/** @type {fc.Arbitrary<{ id: number, name: string }>} */ ws) =>
      fc.record({
        address: hex,
        pid: fc.nat(),
        workspace: ws,
        floating: fc.boolean(),
        fullscreen: fc.integer({ min: 0, max: 3 }),
        fullscreenClient: fc.integer({ min: 0, max: 3 }),
        grouped: fc.boolean(),
        pinned: fc.boolean(),
        at: fc.tuple(coord, coord),
        size: fc.tuple(size, size),
      });
    const slotWs = fc.oneof(
      fc.integer({ min: 1, max: 99 }).map((id) => ({ id, name: String(id) })),
      fc.stringMatching(/^[a-z0-9_.-]{1,20}$/).map((name) => ({ id: -1337, name })),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("lua", "legacy"),
        rec(fc.constant({ id: -98, name: PARK })),
        rec(slotWs),
        (dialect, show, place) => {
          if (show.address === place.address) return true;
          const plan = planShow(dialect, show, place);
          if (plan.kind === "refuse") return false;
          const batch = encodeBatch(dialect, plan.commands);
          return !!batch && isAllowedRequest(batch.text);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("the pair (decisions 6, 7)", () => {
  const N = "0x1";
  const N2 = "0x2";
  const P = "0x3";
  const P2 = "0x4";

  test("entering parks the normal window and shows private in its place", () => {
    expect(pairStep(null, { type: "enter", normal: N, private: P })).toEqual({
      state: { normal: N, private: P, parked: "normal" },
      ops: [{ show: P, place: N }],
    });
  });

  test("leaving shows the normal window in the private one's place, and back", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    const left = pairStep(shown, { type: "leave" });
    expect(left).toEqual({
      state: { normal: N, private: P, parked: "private" },
      ops: [{ show: N, place: P }],
    });
    expect(pairStep(left.state, { type: "enter", normal: N, private: P })).toEqual({
      state: shown,
      ops: [{ show: P, place: N }],
    });
    expect(parkedWindow(shown)).toBe(N);
    expect(parkedWindow(left.state)).toBe(P);
    expect(parkedWindow(null)).toBeNull();
  });

  test("leaving with nothing parked does nothing", () => {
    expect(pairStep(null, { type: "leave" })).toEqual({ state: null, ops: [] });
    const left = { normal: N, private: P, parked: /** @type {const} */ ("private") };
    expect(pairStep(left, { type: "leave" })).toEqual({ state: left, ops: [] });
  });

  test("entering again while shown changes nothing", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "enter", normal: N, private: P })).toEqual({
      state: shown,
      ops: [],
    });
  });

  test("entering from a second normal window swaps the parked one back first", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "enter", normal: N2, private: P })).toEqual({
      state: { normal: N2, private: P, parked: "normal" },
      ops: [
        { show: N, place: P },
        { show: P, place: N2 },
      ],
    });
    const left = { normal: N, private: P, parked: /** @type {const} */ ("private") };
    expect(pairStep(left, { type: "enter", normal: N2, private: P })).toEqual({
      state: { normal: N2, private: P, parked: "normal" },
      ops: [{ show: P, place: N2 }],
    });
  });

  test("a new private window while one is parked: the new one takes the slot", () => {
    const left = { normal: N, private: P, parked: /** @type {const} */ ("private") };
    expect(pairStep(left, { type: "enter", normal: N, private: P2 })).toEqual({
      state: { normal: N, private: P2, parked: "normal" },
      ops: [{ show: P2, place: N }],
    });
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "enter", normal: N, private: P2 }).ops).toEqual([
      { show: N, place: P },
      { show: P2, place: N },
    ]);
  });

  test("the slot window closing shows the parked one in its place; never stranded", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "closing", window: P })).toEqual({
      state: null,
      ops: [{ show: N, place: P }],
    });
    const left = { normal: N, private: P, parked: /** @type {const} */ ("private") };
    expect(pairStep(left, { type: "closing", window: N })).toEqual({
      state: null,
      ops: [{ show: P, place: N }],
    });
  });

  test("the parked window closing (ctrl+b shift+d while away) just forgets the pair", () => {
    const left = { normal: N, private: P, parked: /** @type {const} */ ("private") };
    expect(pairStep(left, { type: "closing", window: P })).toEqual({ state: null, ops: [] });
    expect(pairStep(left, { type: "closing", window: "0x9" })).toEqual({ state: left, ops: [] });
    expect(pairStep(null, { type: "closing", window: P })).toEqual({ state: null, ops: [] });
  });

  test("the parked window activated (a link from another app) comes back in place", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "activated", window: N })).toEqual({
      state: { normal: N, private: P, parked: "private" },
      ops: [{ show: N, place: P }],
    });
    expect(pairStep(shown, { type: "activated", window: P })).toEqual({ state: shown, ops: [] });
    expect(pairStep(null, { type: "activated", window: N })).toEqual({ state: null, ops: [] });
  });

  test("the user moving the parked window out forgets the pair; no fight", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "moved", window: N, workspace: "2" })).toEqual({
      state: null,
      ops: [],
    });
    expect(pairStep(shown, { type: "moved", window: N, workspace: PARK })).toEqual({
      state: shown,
      ops: [],
    });
    expect(pairStep(shown, { type: "moved", window: P, workspace: "2" })).toEqual({
      state: shown,
      ops: [],
    });
  });

  test("a failure forgets the pair", () => {
    const shown = { normal: N, private: P, parked: /** @type {const} */ ("normal") };
    expect(pairStep(shown, { type: "failed" })).toEqual({ state: null, ops: [] });
  });

  test("isAddress", () => {
    expect(isAddress(A)).toBe(true);
    expect(isAddress("0x0")).toBe(true);
    expect(isAddress("571e")).toBe(false);
  });
});

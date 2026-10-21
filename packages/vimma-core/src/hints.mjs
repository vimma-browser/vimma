/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Link hints: label generation, target ordering and the hint-mode key handling.
 * See docs/specs/m1-core-logic.md § Hints.
 */

/** @import { Chord } from "./keys.mjs" */
/** @import { BlockKind } from "./blocks.mjs" */

import { BLOCK_KINDS } from "./blocks.mjs";

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ rect: Rect }} Target */
/** @typedef {"hint.follow" | "hint.follow_new_tab" | "hint.element"} HintAction */
/**
 * @template {Target} [T=Target]
 * @typedef {{ label: string, target: T }} Hint
 */
/**
 * @template {Target} [T=Target]
 * @typedef {{ action: HintAction, chars: string, typed: string, hints: readonly Hint<T>[] }} HintState
 */
/**
 * @template {Target} [T=Target]
 * @typedef {{ kind: "cancel" }
 *   | { kind: "ignored" }
 *   | { kind: "narrow", visible: number }
 *   | { kind: "select", action: HintAction, target: T, label: string }} HintResult
 */

export class HintError extends Error {
  /**
   * @param {"bad-charset" | "bad-count" | "bad-action" | "no-targets"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "HintError";
    this.code = code;
  }
}

/** The home row. No `;`: Nordic and German layouts put other letters there. */
export const DEFAULT_HINT_CHARS = "asdfghjkl";

/** @type {readonly HintAction[]} */
export const HINT_ACTIONS = Object.freeze(["hint.follow", "hint.follow_new_tab", "hint.element"]);

/** @param {string} chars */
function checkChars(chars) {
  const list = [...chars];
  const ok =
    list.length >= 2 &&
    new Set(list).size === list.length &&
    list.every((c) => !/\s/.test(c) && c === c.toLowerCase());
  if (!ok) {
    throw new HintError(
      "bad-charset",
      `hint characters must be at least 2 distinct lowercase characters, got ${JSON.stringify(chars)}`,
    );
  }
  return list;
}

/**
 * The `n` shortest prefix-free labels over `chars`, shortest first, in charset order.
 * @param {number} n
 * @param {string} [chars]
 * @returns {string[]}
 */
export function hintLabels(n, chars = DEFAULT_HINT_CHARS) {
  const list = checkChars(chars);
  if (!Number.isInteger(n) || n < 0) {
    throw new HintError("bad-count", `hint count must be a non-negative integer, got ${n}`);
  }
  const k = list.length;
  if (n <= k) return list.slice(0, n);
  // base: every string of length L - 1, where k^(L-1) < n <= k^L
  let base = [""];
  while (base.length * k < n) base = base.flatMap((p) => list.map((c) => p + c));
  // Extending one base string loses it and gains k labels: extend the fewest, from the end.
  const s = Math.ceil((n - base.length) / (k - 1));
  const kept = base.slice(0, base.length - s);
  const extended = base.slice(base.length - s).flatMap((p) => list.map((c) => p + c));
  return [...kept, ...extended].slice(0, n);
}

/**
 * @param {Target} a
 * @param {Target} b
 */
const byPosition = (a, b) =>
  a.rect.y - b.rect.y ||
  a.rect.x - b.rect.x ||
  a.rect.height - b.rect.height ||
  a.rect.width - b.rect.width;

/**
 * Reading order: rows top to bottom, each left to right. A target joins the current row while
 * its top is above the vertical centre of the row's first target.
 * @template {Target} T
 * @param {readonly T[]} targets
 * @returns {T[]}
 */
export function orderTargets(targets) {
  const sorted = [...targets].sort(byPosition);
  /** @type {T[][]} */
  const rows = [];
  let limit = -Infinity;
  for (const t of sorted) {
    const row = rows[rows.length - 1];
    if (row && t.rect.y < limit) {
      row.push(t);
    } else {
      rows.push([t]);
      limit = t.rect.y + t.rect.height / 2;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.rect.x - b.rect.x || byPosition(a, b)));
}

/**
 * @template {Target} T
 * @param {readonly T[]} targets
 * @param {{ action: string, chars?: string }} options
 * @returns {HintState<T>}
 */
export function startHints(targets, { action, chars = DEFAULT_HINT_CHARS }) {
  if (!(/** @type {readonly string[]} */ (HINT_ACTIONS).includes(action))) {
    throw new HintError("bad-action", `not a hint action: "${action}"`);
  }
  const labels = hintLabels(targets.length, chars);
  if (targets.length === 0) throw new HintError("no-targets", "no hint targets");
  const hints = orderTargets(targets).map((target, i) =>
    Object.freeze({ label: /** @type {string} */ (labels[i]), target }),
  );
  return Object.freeze({
    action: /** @type {HintAction} */ (action),
    chars,
    typed: "",
    hints: Object.freeze(hints),
  });
}

/**
 * The hints still on screen: those whose label starts with what was typed.
 * @template {Target} T
 * @param {HintState<T>} state
 * @returns {Hint<T>[]}
 */
export function visibleHints(state) {
  return state.hints.filter((h) => h.label.startsWith(state.typed));
}

const IGNORED = Object.freeze({ kind: /** @type {const} */ ("ignored") });
const CANCEL = Object.freeze({ kind: /** @type {const} */ ("cancel") });

/**
 * One key in hint mode.
 * @template {Target} T
 * @param {HintState<T>} state
 * @param {Chord} chord
 * @returns {{ state: HintState<T>, result: HintResult<T> }}
 */
export function hintKey(state, chord) {
  if (chord.ctrl || chord.alt || chord.meta) return { state, result: IGNORED };
  if (chord.key === "esc") return { state, result: chord.shift ? IGNORED : CANCEL };
  if (chord.key === "backspace") {
    if (state.typed === "") return { state, result: IGNORED };
    const next = Object.freeze({ ...state, typed: [...state.typed].slice(0, -1).join("") });
    return { state: next, result: narrow(next) };
  }
  // A letter arrives lowercase with shift set (caps lock too); other characters carry shift.
  if ([...chord.key].length !== 1 || !state.chars.includes(chord.key)) {
    return { state, result: IGNORED };
  }
  const next = Object.freeze({ ...state, typed: state.typed + chord.key });
  const visible = visibleHints(next);
  if (visible.length === 0) return { state, result: IGNORED };
  if (visible.length === 1) {
    const hit = /** @type {Hint<T>} */ (visible[0]);
    return {
      state: next,
      result: Object.freeze({
        kind: /** @type {const} */ ("select"),
        action: state.action,
        target: hit.target,
        label: hit.label,
      }),
    };
  }
  return { state: next, result: narrow(next) };
}

/**
 * @param {HintState<any>} state
 * @returns {{ kind: "narrow", visible: number }}
 */
const narrow = (state) => Object.freeze({ kind: "narrow", visible: visibleHints(state).length });

/** Most targets one frame may report (`Vimma:CollectHints`, docs/specs/m1-hints.md). */
export const HINT_REPLY_MAX_TARGETS = 5000;
/** Most subframes one frame may report. */
export const HINT_REPLY_MAX_FRAMES = 64;
/** Longest href a link target may carry (for `F`). */
export const HINT_REPLY_MAX_HREF = 8192;
/** Longest link text a target may carry (an agent's `f`, docs/specs/mcp-drive.md D12). */
export const HINT_REPLY_MAX_TEXT = 512;
/** Coordinates beyond this are not on any screen. */
const MAX_COORD = 1e6;
/** @type {ReadonlySet<string>} */
const TARGET_KINDS = new Set(["link", "input", "click", "block"]);
/** @type {ReadonlySet<string>} */
const BLOCK_KIND_SET = new Set(BLOCK_KINDS);

/** @typedef {"link" | "input" | "click" | "block"} TargetKind */
/**
 * `rect` is where the label goes (for a text block, its first visible line); a block also
 * carries its kind and its whole border box, for the outline (docs/specs/element-focus.md). An
 * agent's collection (docs/specs/mcp-drive.md D12) is of links only, each with its text.
 * @typedef {{ id: number, rect: Rect, kind: TargetKind, href?: string, text?: string, blockKind?: BlockKind, box?: Rect }} ReplyTarget
 */
/** @typedef {{ id: number, rect: Rect }} ReplyFrame */
/** @typedef {{ targets: ReplyTarget[], frames: ReplyFrame[], ms: number }} HintReply */

/** @param {unknown} n */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/** @param {unknown} n */
const isCoord = (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < MAX_COORD;

/**
 * @param {unknown} value
 * @returns {Rect | null}
 */
function parseRect(value) {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = /** @type {Record<string, unknown>} */ (value);
  if (!isCoord(x) || !isCoord(y) || !isCoord(width) || !isCoord(height)) return null;
  const r = /** @type {Rect} */ ({ x, y, width, height });
  return r.width > 0 && r.height > 0 ? r : null;
}

/**
 * A `Vimma:CollectHints` reply from a content process, which may be compromised: a fresh copy
 * with only the known fields, each of its exact type and within the caps, or null if anything
 * is wrong. Never throws. The hint counterpart of `parseDescriptor` (editable.mjs). A
 * collection gets only the kind of target it asked for: text blocks for element focus, never
 * a block for `f` or `F`, so a block is never followed and a link never outlined; an agent's
 * collection (`texts`) only links, with their text.
 * @param {unknown} value
 * @param {{ blocks?: boolean, texts?: boolean }} [options]  the collection asked for text
 *   blocks, or for links with their text (an agent's `f`)
 * @returns {HintReply | null}
 */
export function parseHintReply(value, { blocks = false, texts = false } = {}) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const { targets, frames, ms } = /** @type {Record<string, unknown>} */ (value);
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    if (!Array.isArray(targets) || targets.length > HINT_REPLY_MAX_TARGETS) return null;
    if (!Array.isArray(frames) || frames.length > HINT_REPLY_MAX_FRAMES) return null;
    /** @type {ReplyTarget[]} */
    const outTargets = [];
    const ids = new Set();
    for (const t of [...targets]) {
      if (typeof t !== "object" || t === null) return null;
      const { id, rect, kind, href, text, blockKind, box } =
        /** @type {Record<string, unknown>} */ (t);
      if (!isIndex(id) || ids.has(id)) return null;
      ids.add(id);
      const r = parseRect(rect);
      if (!r || typeof kind !== "string" || !TARGET_KINDS.has(kind)) return null;
      if ((kind === "block") !== blocks) return null;
      if (texts && kind !== "link") return null;
      /** @type {ReplyTarget} */
      const out = {
        id: /** @type {number} */ (id),
        rect: r,
        kind: /** @type {TargetKind} */ (kind),
      };
      if (href !== undefined) {
        if (typeof href !== "string" || href.length > HINT_REPLY_MAX_HREF) return null;
        out.href = href;
      }
      if (texts && text !== undefined) {
        if (typeof text !== "string" || text.length > HINT_REPLY_MAX_TEXT) return null;
        out.text = text;
      }
      if (kind === "block") {
        // A block is clipped by its frame, not by the viewport: its box may start above it.
        const b = parseRect(box);
        if (typeof blockKind !== "string" || !BLOCK_KIND_SET.has(blockKind) || !b) return null;
        if (href !== undefined) return null;
        out.blockKind = /** @type {BlockKind} */ (blockKind);
        out.box = b;
      } else if (blockKind !== undefined || box !== undefined) {
        return null;
      }
      outTargets.push(out);
    }
    /** @type {ReplyFrame[]} */
    const outFrames = [];
    // One entry per frame: a repeated id would have the parent collect one frame many times.
    const frameIds = new Set();
    for (const f of [...frames]) {
      if (typeof f !== "object" || f === null) return null;
      const { id, rect } = /** @type {Record<string, unknown>} */ (f);
      const r = parseRect(rect);
      if (!isIndex(id) || !r || frameIds.has(id)) return null;
      frameIds.add(id);
      outFrames.push({ id: /** @type {number} */ (id), rect: r });
    }
    return { targets: outTargets, frames: outFrames, ms };
  } catch {
    return null;
  }
}

/** Longest text a `Vimma:Block` yank may carry (code units): far past any block's. */
export const BLOCK_REPLY_MAX_TEXT = 1 << 24;

/** The `Vimma:Block` ops that focus a block, and so reply its kind, length and box. */
const BLOCK_MOVES = new Set(["focus", "parent", "child", "next", "prev"]);

/**
 * @typedef {{ kind: BlockKind, length: number, box: Rect }} BlockMoved  a block was focused:
 *   its border box in its frame's CSS pixels, unclipped, and its text's length in characters
 * @typedef {BlockMoved | { box: Rect } | { rect: Rect } | { text: string, unselectable: boolean }
 *   | { unselectable: boolean }} BlockReply
 */

/**
 * A `Vimma:Block` reply (docs/specs/element-focus.md) from a content process, which may be
 * compromised: a fresh copy with only the fields `op` replies, each of its exact type and within
 * the caps, or null. Never throws. `focus`, `parent`, `child`, `next` and `prev` reply the block
 * now focused; `rect` its box; `frame` a subframe's viewport; `yank` the block's text; `select`
 * whether the page marks it unselectable.
 * @param {unknown} value
 * @param {string} op
 * @returns {BlockReply | null}
 */
export function parseBlockReply(value, op) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    if (BLOCK_MOVES.has(op)) {
      const { kind, length, box } = v;
      const b = parseRect(box);
      if (typeof kind !== "string" || !BLOCK_KIND_SET.has(kind) || !b) return null;
      if (!isIndex(length) || /** @type {number} */ (length) > BLOCK_REPLY_MAX_TEXT) return null;
      return {
        kind: /** @type {BlockKind} */ (kind),
        length: /** @type {number} */ (length),
        box: b,
      };
    }
    switch (op) {
      case "rect": {
        const b = parseRect(v.box);
        return b ? { box: b } : null;
      }
      case "frame": {
        const r = parseRect(v.rect);
        return r ? { rect: r } : null;
      }
      case "yank": {
        const { text, unselectable } = v;
        if (typeof text !== "string" || text.length > BLOCK_REPLY_MAX_TEXT) return null;
        if (typeof unselectable !== "boolean") return null;
        return { text, unselectable };
      }
      case "select": {
        const { unselectable } = v;
        return typeof unselectable === "boolean" ? { unselectable } : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

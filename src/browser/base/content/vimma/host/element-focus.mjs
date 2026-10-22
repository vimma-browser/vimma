/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The ELEMENT mode of one window (spec: docs/specs/element-focus.md): the text block a label
// of `hint.element` chose, outlined in chrome while `+`, `-`, `j` and `k` move the focus, until
// `v` selects it in copy mode, `y` copies it, or anything else leaves. The block lives in its
// frame's actor (actors/block.mjs); this module keeps where it is drawn and what the status bar
// says about it. VimmaHost routes the mode's keys and the actor's reports here.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { NO_TEXT, NOTHING_TO_YANK, yankedText } from "./copy-mode.mjs";

/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */
/** @import { HintOverlay } from "../ui/hint-overlay.mjs" */
/** @import { BlockMoved } from "../core/hints.mjs" */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** After "yanked N chars" when the page marks the block unselectable (decision 9). */
export const UNSELECTABLE = " (the page marks it unselectable)";
/** `v` on a block the page marks unselectable: Firefox paints no highlight (decision 9). */
export const NO_HIGHLIGHT = "no highlight: the page marks this block unselectable";

/**
 * @typedef {object} ElementSession
 * @property {any} browser  the <browser> the block is in
 * @property {HintTarget} target  the label's target: its frame, collection and id
 * @property {[{ bc: any, wg: any }, ...{ bc: any, wg: any }[]]} chain  the block's frame,
 *   then each frame around it
 * @property {string} kind
 * @property {number} length
 * @property {number} seq  changes on each focus and move, so the status bar says each; 0 until
 *   the frame has said what the block is
 * @property {boolean} drawing  a redraw is in flight
 * @property {boolean} dirty  the block moved again while it was
 */

/**
 * What ElementFocus needs from VimmaHost.
 * @typedef {object} ElementHost
 * @property {HintOverlay} overlay  the window's hint layer, which draws the outline too
 * @property {(text: string) => void} notify  the window's notice
 * @property {() => void} changed  the mode or the status bar's segment changed
 * @property {(browser: any, mode: "normal" | "visual") => void} setMode  the tab's page mode
 */

/** One window's element focus. */
export class ElementFocus {
  /** @param {ElementHost} host */
  constructor(host) {
    this.host = host;
    /** @type {ElementSession | null} */
    this.session = null;
    /** Focuses so far: each one's `seq` is new. */
    this.seq = 0;
    /** Yanks so far: a reply that comes after a newer yank or focus is dropped. */
    this.yanks = 0;
  }

  /** The <browser> in ELEMENT mode, or null. */
  get browser() {
    return this.session?.browser ?? null;
  }

  /** The status bar's `paragraph · 412 chars`, or null until the frame has said. */
  status() {
    const s = this.session;
    return s?.seq ? { kind: s.kind, length: s.length, seq: s.seq } : null;
  }

  /**
   * A label chose `target`: the frame keeps its block and the outline is drawn. The mode is
   * ELEMENT at once, so keys typed meanwhile are this mode's; the frame takes them in order.
   * @param {any} browser
   * @param {HintTarget} target
   */
  async start(browser, target) {
    this.leave();
    const [frame, ...around] = VimmaActors.frameChain(target.bc);
    if (!frame || frame.wg !== target.wg) return;
    /** @type {ElementSession["chain"]} */
    const chain = [frame, ...around];
    /** @type {ElementSession} */
    const s = {
      browser,
      target,
      chain,
      kind: target.blockKind ?? "block",
      length: 0,
      seq: 0,
      drawing: false,
      dirty: false,
    };
    this.session = s;
    this.host.changed();
    // The frames around it report their scrolls too: one moves the block on screen.
    for (const frame of chain.slice(1)) VimmaActors.blockNotify(frame, target.gen, "track");
    const reply = /** @type {BlockMoved | null} */ (
      await VimmaActors.block(chain[0], target.gen, "focus", { id: target.id })
    );
    if (this.session !== s) return;
    if (!reply) {
      this.leave();
      return;
    }
    s.seq = ++this.seq;
    this.#moved(s, reply);
  }

  /**
   * `+`, `-`, `j`, `k`: the frame moves the focus; where there is no block further it stays.
   * @param {"parent" | "child" | "next" | "prev"} op
   * @param {number} [count]
   */
  async move(op, count) {
    const s = this.#live();
    if (!s) return;
    const reply = /** @type {BlockMoved | null} */ (
      await VimmaActors.block(s.chain[0], s.target.gen, op, count ? { count } : {})
    );
    if (this.session !== s || !reply) return;
    s.seq = ++this.seq;
    this.#moved(s, reply);
  }

  /**
   * `y`: the block's text to the clipboard, and back to normal mode (decision 9).
   */
  async yank() {
    const s = this.#live();
    if (!s) return;
    this.#end(s);
    const turn = ++this.yanks;
    const reply = /** @type {{ text: string, unselectable: boolean } | null} */ (
      await VimmaActors.block(s.chain[0], s.target.gen, "yank")
    );
    this.#release(s);
    // A frame that answers late must not overwrite what the user copied or chose since.
    if (turn !== this.yanks || this.session) return;
    if (!reply?.text) {
      this.host.notify(NOTHING_TO_YANK);
      return;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(reply.text, s.browser.browsingContext?.currentWindowContext);
    this.host.notify(yankedText(reply.text) + (reply.unselectable ? UNSELECTABLE : ""));
  }

  /**
   * `v` / `V`: the frame selects the block and enters copy mode with it (decision 8). The tab
   * is in copy mode before the frame answers, so the next key is a copy-mode key.
   * @param {boolean} line
   */
  async visual(line) {
    const s = this.#live();
    if (!s) return;
    this.#end(s);
    this.host.setMode(s.browser, "visual");
    const reply = /** @type {{ unselectable: boolean } | null} */ (
      await VimmaActors.block(s.chain[0], s.target.gen, "select", { line })
    );
    this.#release(s);
    if (!reply) {
      this.host.setMode(s.browser, "normal");
      this.host.notify(NO_TEXT);
    } else if (reply.unselectable) {
      this.host.notify(NO_HIGHLIGHT);
    }
  }

  /** Leaves ELEMENT mode, if on: the outline goes, nothing is selected. */
  leave() {
    const s = this.session;
    if (!s) return;
    this.#end(s);
    this.#release(s);
  }

  /**
   * A frame of the focused block's chain reported a scroll or resize (`moved`) or that its
   * page went away (`gone`). Only the frames of the chain, with the documents they had, for the
   * collection the block came from, are heard.
   * @param {"moved" | "gone"} what
   * @param {any} bc  the reporting frame
   * @param {any} wg  its WindowGlobalParent
   * @param {unknown} gen
   */
  onReport(what, bc, wg, gen) {
    const s = this.session;
    if (!s || gen !== s.target.gen) return;
    if (!s.chain.some((f) => f.bc === bc && f.wg === wg)) return;
    if (what === "gone") this.leave();
    else this.#redraw(s);
  }

  /**
   * A frame's document went away (VimmaParent): a focus in it or inside it ends.
   * @param {any} wg  the WindowGlobalParent
   */
  onFrameGone(wg) {
    if (this.session?.chain.some((f) => f.wg === wg)) this.leave();
  }

  /** The session, if its frames still show the documents they had; else it ends. */
  #live() {
    const s = this.session;
    if (!s) return null;
    if (s.chain.every((f) => f.bc.currentWindowGlobal === f.wg)) return s;
    this.leave();
    return null;
  }

  /**
   * @param {ElementSession} s
   * @param {BlockMoved} reply
   */
  #moved(s, reply) {
    s.kind = reply.kind;
    s.length = reply.length;
    this.host.changed();
    this.#draw(s, reply.box, s.seq);
  }

  /**
   * Draws the outline where the block's box is in the top frame.
   * @param {ElementSession} s
   * @param {Rect} box  in the block's frame
   * @param {number} seq  the move it is for: a slow answer for an earlier one is not drawn
   */
  async #draw(s, box, seq) {
    const at = await VimmaActors.blockBox(s.chain, s.target.gen, box);
    if (this.session === s && s.seq === seq) this.host.overlay.outline(s.browser, at);
  }

  /**
   * Asks the frame where the block is now and draws it there; reports that come in meanwhile
   * make one more round, not one each.
   * @param {ElementSession} s
   */
  async #redraw(s) {
    if (s.drawing) {
      s.dirty = true;
      return;
    }
    s.drawing = true;
    try {
      do {
        s.dirty = false;
        const reply = /** @type {{ box: Rect } | null} */ (
          await VimmaActors.block(s.chain[0], s.target.gen, "rect")
        );
        if (this.session !== s) return;
        if (!reply) {
          this.#live();
          return;
        }
        await this.#draw(s, reply.box, s.seq);
      } while (s.dirty && this.session === s);
    } finally {
      s.drawing = false;
    }
  }

  /**
   * The mode is over in the parent: no outline, and the status bar says so.
   * @param {ElementSession} s
   */
  #end(s) {
    if (this.session !== s) return;
    this.session = null;
    this.host.overlay.clearOutline();
    this.host.changed();
  }

  /**
   * The frames drop the block and stop reporting.
   * @param {ElementSession} s
   */
  #release(s) {
    for (const frame of s.chain) VimmaActors.blockNotify(frame, s.target.gen, "blur");
  }
}

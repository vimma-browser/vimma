/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the Vimma JSWindowActor pair and sends it commands (spec:
// docs/specs/m1-actor-insert-scroll.md). The host talks to content only through here.

import { HINT_REPLY_MAX_TARGETS, parseBlockReply, parseHintReply } from "../core/hints.mjs";

/** @import { BlockReply } from "../core/hints.mjs" */

// System modules have no timer globals; Firefox's actors import them the same way.
const { clearTimeout, setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);

const NAME = "Vimma";
const BASE = "chrome://browser/content/vimma/actors/";
/** start/StartPage.sys.mjs START_PAGE_URL; a match pattern needs no import for one string. */
const START_PAGE_MATCH = "chrome://browser/content/vimma/start/start.html";

/** @typedef {"down" | "up" | "left" | "right" | "half_down" | "half_up" | "top" | "bottom"} ScrollKind */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/**
 * A hint target in the parent: where to draw it and how to reach its element again.
 * @typedef {object} HintTarget
 * @property {Rect} rect  in the top frame's CSS pixels
 * @property {"link" | "input" | "click" | "block"} kind
 * @property {string} [href]  links only
 * @property {import("../core/blocks.mjs").BlockKind} [blockKind]  text blocks only
 * @property {Rect} [box]  text blocks only: the border box, for the outline
 * @property {number} gen  the collection it came from
 * @property {number} id  the element's index in its frame's collection
 * @property {any} bc  its frame's BrowsingContext
 * @property {any} wg  the frame's WindowGlobalParent at collection time
 */

let registered = false;

/** Hint collections so far; a reply or an activation from an older one is ignored. */
let hintGen = 0;
/**
 * The generation of each tab's last blur (Esc). Per tab, so a content process cannot count the
 * Esc presses of other tabs.
 * @type {WeakMap<object, number>}
 */
const blurGens = new WeakMap();
/** The live collection of each window; another window's `f` must not void it. */
/** @type {WeakMap<object, number>} */
const liveGen = new WeakMap();

/** How long a subframe may take to answer (ms) before its targets are left out. */
const FRAME_TIMEOUT_PREF = "vimma.hints.frameTimeoutMs";
const FRAME_TIMEOUT_DEFAULT = 150;
/** The top frame gets longer: without it there are no hints at all. */
const TOP_TIMEOUT_MS = 2000;

/** At most this many targets in all frames (each frame: core HINT_REPLY_MAX_TARGETS). */
const MAX_HINTS = HINT_REPLY_MAX_TARGETS;
/** At most this deep in frames. */
const MAX_FRAME_DEPTH = 8;
/** Schemes `F` opens; the page's principal must be allowed to load them too. */
const OPENABLE = new Set(["http:", "https:", "file:"]);

const ReferrerInfo = Components.Constructor(
  "@mozilla.org/referrer-info;1",
  "nsIReferrerInfo",
  "init",
);

/**
 * @param {Rect} r
 * @param {{ x: number, y: number }} by
 * @returns {Rect}
 */
function offset(r, by) {
  return { x: r.x + by.x, y: r.y + by.y, width: r.width, height: r.height };
}

/**
 * @param {Rect} a
 * @param {Rect} b
 * @returns {Rect | null}
 */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * The actor of a frame's current document, or null when the document does not match
 * (moz-extension:, data:, view-source:) or the frame is gone.
 * @param {any} bc BrowsingContext
 * @returns {any} JSWindowActorParent
 */
function actorFor(bc) {
  try {
    return bc?.currentWindowGlobal?.getActor(NAME) ?? null;
  } catch {
    return null;
  }
}

/**
 * The browser's focused frame when it is a subframe, then its top frame.
 * @param {any} browser XULBrowserElement
 * @returns {any[]} BrowsingContexts
 */
function framesFor(browser) {
  const top = browser.browsingContext;
  const focused = Services.focus.focusedContentBrowsingContext;
  return focused && focused !== top && focused.top === top ? [focused, top] : [top];
}

export const VimmaActors = {
  /** Registers the actor pair once per process; vimma.js calls this before VimmaHost.init. */
  register() {
    if (registered) return;
    registered = true;
    ChromeUtils.registerWindowActor(NAME, {
      parent: { esModuleURI: `${BASE}VimmaParent.sys.mjs` },
      child: {
        esModuleURI: `${BASE}VimmaChild.sys.mjs`,
        events: {
          focusin: { capture: true },
          focusout: { capture: true },
          focus: { capture: true },
          // Only for an editable document root; a frame never focused has no actor to ask.
          mousedown: { capture: true, createActor: false },
          // A drag and drop's end is no mouse selection (m1-copy-mode).
          dragstart: { capture: true, createActor: false },
        },
      },
      allFrames: true,
      // The start page (start/start.html) loads in the parent process; it needs the actor
      // for normal mode like any page.
      matches: ["http://*/*", "https://*/*", "file:///*", "about:*", START_PAGE_MATCH],
      messageManagerGroups: ["browsers"],
      // The child only reports focus, scrolls its own page and answers about its own text; the
      // parent trusts nothing but a descriptor, which at worst flips that tab's mode, and
      // checks every other reply (core parseHintReply, parseGrepReply).
      safeForUntrustedWebProcess: true,
    });
  },

  /**
   * Whether the browser's page has our actor (else the host keeps it in insert).
   * @param {any} browser XULBrowserElement
   */
  has(browser) {
    return !!actorFor(browser.browsingContext);
  },

  /**
   * Scrolls the focused frame, or the top frame if the focused one has nothing to scroll.
   * @param {any} browser XULBrowserElement
   * @param {ScrollKind} kind
   * @param {number} [count]
   * @param {{ instant?: boolean, top?: boolean }} [options]  `instant`: no smooth scroll;
   *   `top`: the top frame's scroller only, whatever frame has focus (an agent's tab,
   *   docs/specs/mcp-drive.md D8)
   * @returns {Promise<boolean>} whether a frame had something to scroll
   */
  async scroll(browser, kind, count = 1, { instant = false, top = false } = {}) {
    const frames = top ? [browser.browsingContext] : framesFor(browser);
    for (const bc of frames) {
      if (await actorFor(bc)?.sendQuery("Vimma:Scroll", { kind, count, instant })) return true;
    }
    return false;
  },

  /**
   * How far the top frame is scrolled down, from 0 to 1 (docs/specs/mcp-drive.md D16). The
   * page's child answers, so the number is checked here.
   * @param {any} browser XULBrowserElement
   * @returns {Promise<number>}
   */
  async scrollFraction(browser) {
    try {
      const y = await actorFor(browser.browsingContext)?.sendQuery("Vimma:ScrollFraction");
      return typeof y === "number" && Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0;
    } catch {
      return 0;
    }
  },

  /**
   * Runs a text-field command (ctrl+w, ctrl+u, ctrl+h; docs/specs/key-handling-batch.md § 2)
   * in the focused frame, on its focused text field, if any.
   * @param {any} browser XULBrowserElement
   * @param {string} command  one of core INSERT_EDIT_COMMANDS
   */
  edit(browser, command) {
    actorFor(framesFor(browser)[0])?.sendAsyncMessage("Vimma:Edit", { command });
  },

  /**
   * The top frame's selected text, at most `max` characters, or null (an agent's read,
   * docs/specs/vimma-mcp.md decision 4).
   * @param {any} browser XULBrowserElement
   * @param {number} max
   * @returns {Promise<string | null>}
   */
  async selection(browser, max) {
    try {
      const text = await actorFor(browser.browsingContext)?.sendQuery("Vimma:Selection", { max });
      return typeof text === "string" && text ? text : null;
    } catch {
      return null;
    }
  },

  /**
   * Blurs the focused element of the focused frame (Esc in insert). Each blur has a new
   * generation, which the frame's later focus reports carry.
   * @param {any} browser XULBrowserElement
   * @returns {{ windowId: number, gen: number } | null} the document the blur went to and its
   *   generation
   */
  blur(browser) {
    const bc = framesFor(browser)[0];
    const actor = actorFor(bc);
    if (!actor) return null;
    const gen = (blurGens.get(browser) ?? 0) + 1;
    blurGens.set(browser, gen);
    actor.sendAsyncMessage("Vimma:Blur", { gen });
    return { windowId: bc.currentWindowGlobal?.innerWindowId ?? 0, gen };
  },

  /**
   * Test-only: the content-side time of the last collectHints, summed over frames, in ms.
   * @type {number}
   */
  _lastCollectMs: 0,

  /**
   * The hint targets on screen in the browser's page and its frames (m1-hints), in the top
   * frame's CSS pixels. Each frame's child collects its own; frames from other origins are
   * other processes, so the parent merges them, offset by the frame rects their embedder
   * reported and clipped to them. Replies are from content processes and checked like any
   * other message: a malformed one drops that frame.
   * @param {any} browser XULBrowserElement
   * @param {string} action "hint.follow", "hint.follow_new_tab" (links only) or "hint.element"
   *   (text blocks, docs/specs/element-focus.md)
   * @returns {Promise<HintTarget[]>}
   */
  async collectHints(browser, action) {
    const gen = ++hintGen;
    const win = browser.ownerDocument.defaultView;
    liveGen.set(win, gen);
    const live = () => liveGen.get(win) === gen;
    const frameTimeout = Services.prefs.getIntPref(FRAME_TIMEOUT_PREF, FRAME_TIMEOUT_DEFAULT);
    /** Each frame at most once, whatever its embedder reports. */
    const visited = new Set();
    const linksOnly = action === "hint.follow_new_tab";
    const blocks = action === "hint.element";
    /** @type {HintTarget[]} */
    const out = [];
    let ms = 0;
    /**
     * @param {any} bc BrowsingContext
     * @param {Rect} frame the frame's viewport in top-frame pixels, as clipped by its ancestors
     * @param {{ x: number, y: number }} origin the frame's viewport origin in top-frame pixels
     * @param {number} depth
     */
    const visit = async (bc, frame, origin, depth) => {
      if (visited.has(bc.id)) return;
      visited.add(bc.id);
      const wg = bc.currentWindowGlobal;
      /** @type {unknown} */
      let raw;
      /** @type {number | undefined} */
      let timer;
      try {
        // A busy or hung frame (its process spinning) must not hold up the others' labels.
        const late = new Promise((resolve) => {
          timer = setTimeout(resolve, depth === 0 ? TOP_TIMEOUT_MS : frameTimeout, null);
        });
        const query = actorFor(bc)?.sendQuery("Vimma:CollectHints", { gen, linksOnly, blocks });
        raw = await Promise.race([query, late]);
      } catch {
        return; // the frame navigated or its process went away
      } finally {
        clearTimeout(timer);
      }
      // From a content process, which may be compromised: a fresh, checked copy or nothing.
      const reply = parseHintReply(raw, { blocks });
      if (!reply || !live()) return;
      ms += reply.ms;
      for (const t of reply.targets) {
        if (out.length >= MAX_HINTS) break;
        const rect = intersect(offset(t.rect, origin), frame);
        if (!rect) continue;
        /** @type {HintTarget} */
        const target = { gen, bc, wg, id: t.id, kind: t.kind, href: t.href, rect };
        if (t.box) {
          const box = intersect(offset(t.box, origin), frame);
          if (!box) continue;
          target.blockKind = t.blockKind;
          target.box = box;
        }
        out.push(target);
      }
      if (depth >= MAX_FRAME_DEPTH) return;
      const children = reply.frames.map((f) => {
        const child = BrowsingContext.get(f.id);
        // Only a frame this document embeds: a content process names no other.
        if (!child || child.parent !== bc) return null;
        const rect = offset(f.rect, origin);
        const clipped = intersect(rect, frame);
        return clipped && visit(child, clipped, { x: rect.x, y: rect.y }, depth + 1);
      });
      await Promise.all(children);
    };
    const top = browser.browsingContext;
    const all = { x: 0, y: 0, width: Infinity, height: Infinity };
    await visit(top, all, { x: 0, y: 0 }, 0);
    this._lastCollectMs = ms;
    return live() ? out : [];
  },

  /**
   * Follows a target in its own frame: a click, or focus for a text field.
   * @param {HintTarget} target
   */
  activateHint(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return;
    actorFor(target.bc)
      ?.sendQuery("Vimma:ActivateHint", { gen: target.gen, id: target.id })
      .catch(() => {});
  },

  /**
   * Opens a link target in a new background tab next to the browser's, in its container, as
   * the page itself would load it: the page's principal triggers the load, so a page cannot
   * open what it could not link to.
   * @param {any} browser XULBrowserElement
   * @param {HintTarget} target
   * @returns {boolean} whether a tab was opened
   */
  openInBackground(browser, target) {
    const wg = target.bc.currentWindowGlobal;
    if (target.kind !== "link" || !target.href || wg !== target.wg) return false;
    const url = URL.parse(target.href);
    if (!url || !OPENABLE.has(url.protocol)) return false;
    const principal = wg.documentPrincipal;
    try {
      Services.scriptSecurityManager.checkLoadURIWithPrincipal(
        principal,
        url.URI,
        Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL,
      );
    } catch {
      return false;
    }
    const win = browser.ownerDocument.defaultView;
    const tab = win.gBrowser.getTabForBrowser(browser);
    win.openLinkIn(url.href, "tab", {
      inBackground: true,
      relatedToCurrent: true,
      userContextId: tab?.userContextId ?? 0,
      triggeringPrincipal: principal,
      originPrincipal: principal,
      originStoragePrincipal: wg.documentStoragePrincipal,
      triggeringRemoteType: wg.domProcess?.remoteType,
      referrerInfo: new ReferrerInfo(Ci.nsIReferrerInfo.EMPTY, true, wg.documentURI),
    });
    return true;
  },

  /**
   * Drops the window's collection in flight (Esc, tab switch): its reply is ignored.
   * @param {object} win
   */
  cancelHints(win) {
    liveGen.delete(win);
  },

  /**
   * `i`: focuses the text field the user was last in, if its frame still shows the same
   * document and still has it, else the first visible text field in the top frame. Only a frame
   * of this tab is asked, and only the document that reported the field (a frame that has since
   * loaded another page, perhaps from another site, is not).
   * @param {any} browser XULBrowserElement
   * @param {{ frame: any, windowId: number }} [last] the frame (BrowsingContext) and its
   *   document's inner window ID
   */
  async focusInput(browser, last) {
    const top = browser.browsingContext;
    const frame = last?.frame;
    if (
      frame &&
      !frame.isDiscarded &&
      frame.top === top &&
      frame.currentWindowGlobal?.innerWindowId === last.windowId
    ) {
      try {
        if (await actorFor(frame)?.sendQuery("Vimma:FocusLast")) return;
      } catch {
        // The frame navigated or closed while asked: the top frame's first field it is.
      }
    }
    actorFor(top)?.sendAsyncMessage("Vimma:FocusInput");
  },

  /**
   * Focuses the visible text field a count picks in the top frame (`gi`, `3gi`).
   * @param {any} browser XULBrowserElement
   * @param {number} [count]
   * @returns {Promise<boolean>} whether one took focus
   */
  async focusNthInput(browser, count) {
    try {
      return !!(await actorFor(browser.browsingContext)?.sendQuery("Vimma:FocusInput", { count }));
    } catch {
      return false;
    }
  },

  /**
   * The top frame's scroll position (where `/` started, spec m1-find), or null.
   * @param {any} browser XULBrowserElement
   * @returns {Promise<{ x: number, y: number } | null>}
   */
  async scrollPosition(browser) {
    try {
      return (await actorFor(browser.browsingContext)?.sendQuery("Vimma:ScrollPosition")) ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Makes the next find start where Vim's would (spec m1-find): at a selection still on screen,
   * else at the top of the viewport, not at the document's first match.
   * @param {any} browser XULBrowserElement
   */
  findAnchor(browser) {
    actorFor(browser.browsingContext)?.sendAsyncMessage("Vimma:FindAnchor");
  },

  /**
   * Tells every frame of `browser` that a find step starts (a search, `n` or `N`): the finder
   * may focus a text field it matches in again, even one whose focus an earlier step gave back
   * (VimmaChild #focusedByFind, #442). Sent before the step's own Finder messages, on the same
   * channel per frame, so each frame gets it first.
   * @param {any} browser XULBrowserElement
   */
  findStep(browser) {
    for (const bc of browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
      actorFor(bc)?.sendAsyncMessage("Vimma:FindStep");
    }
  },

  /**
   * Tells the frame a find bar closed on that the close is through (VimmaChild #findClosed).
   * Sent after the find bar's close(), so the frame gets it after the finder's own messages.
   * @param {any} bc BrowsingContext the finder sent its close to
   */
  findClosed(bc) {
    actorFor(bc)?.sendAsyncMessage("Vimma:FindClosed");
  },

  /**
   * Scrolls the top frame back to a position from `scrollPosition` (Esc in a find).
   * @param {any} browser XULBrowserElement
   * @param {{ x: number, y: number }} at
   */
  scrollTo(browser, at) {
    actorFor(browser.browsingContext)?.sendAsyncMessage("Vimma:ScrollTo", at);
  },

  /**
   * A browser's frames for live grep (docs/specs/live-grep.md decision 12): its browsing
   * contexts in tree order, skipping those under a hidden embedder, as
   * FinderParent.gatherBrowsingContexts does.
   * At most `max` frames; `cut` says some were left out.
   * @param {any} browser XULBrowserElement
   * @param {number} max
   * @returns {{ frames: any[], cut: boolean }} BrowsingContexts
   */
  grepFrames(browser, max) {
    /** @type {any[]} */
    const out = [];
    let cut = false;
    /** @param {any} bc @param {number} depth */
    const gather = (bc, depth) => {
      if (!bc || bc.isUnderHiddenEmbedderElement || depth > MAX_FRAME_DEPTH) return;
      if (out.length >= max) {
        cut = true;
        return;
      }
      out.push(bc);
      for (const child of bc.children) gather(child, depth + 1);
    };
    gather(browser.browsingContext, 0);
    return { frames: out, cut };
  },

  /**
   * One live grep message (`Vimma:Grep`, `Vimma:GrepPreview`, `Vimma:GrepJump`,
   * `Vimma:GrepEnd`) to a frame's current document. The raw reply, unchecked: the caller
   * parses it (core grep.mjs). Null when the frame has no actor, went away, or did not answer
   * within `ms`.
   * @param {any} bc BrowsingContext
   * @param {string} name
   * @param {object} data
   * @param {number} ms
   * @returns {Promise<unknown>}
   */
  async grepAsk(bc, name, data, ms) {
    /** @type {number | undefined} */
    let timer;
    try {
      const query = actorFor(bc)?.sendQuery(name, data);
      if (!query) return null;
      const late = new Promise((resolve) => {
        timer = setTimeout(resolve, ms, null);
      });
      return await Promise.race([query, late]);
    } catch {
      return null; // the frame navigated or its process went away
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Element focus (docs/specs/element-focus.md): one `Vimma:Block` op in the frame of a block,
   * for the collection `gen`. The reply is from a content process and checked (core
   * parseBlockReply): null for none, a malformed one, or a frame that since shows another
   * document.
   * @param {{ bc: any, wg: any }} frame  the frame and its WindowGlobalParent when the block
   *   was chosen
   * @param {number} gen
   * @param {string} op
   * @param {object} [extra]
   * @returns {Promise<BlockReply | null>}
   */
  async block(frame, gen, op, extra = {}) {
    if (frame.bc.currentWindowGlobal !== frame.wg) return null;
    try {
      const raw = await actorFor(frame.bc)?.sendQuery("Vimma:Block", { ...extra, op, gen });
      return parseBlockReply(raw, op);
    } catch {
      return null; // the frame navigated or its process went away
    }
  },

  /**
   * A `Vimma:Block` op with no reply (`track`, `blur`) to a frame, if it still shows the same
   * document.
   * @param {{ bc: any, wg: any }} frame
   * @param {number} gen
   * @param {"track" | "blur"} op
   */
  blockNotify(frame, gen, op) {
    if (frame.bc.currentWindowGlobal !== frame.wg) return;
    try {
      actorFor(frame.bc)?.sendAsyncMessage("Vimma:Block", { op, gen });
    } catch {
      // the frame went away: nothing to tell
    }
  },

  /**
   * A frame and the frames around it up to the top, each with its WindowGlobalParent now.
   * @param {any} bc BrowsingContext
   * @returns {{ bc: any, wg: any }[]}  the frame first, the top last
   */
  frameChain(bc) {
    /** @type {{ bc: any, wg: any }[]} */
    const out = [];
    for (let c = bc; c && out.length <= MAX_FRAME_DEPTH; c = c.parent) {
      out.push({ bc: c, wg: c.currentWindowGlobal });
    }
    return out;
  },

  /**
   * Where a box in the first frame of `chain` is in the top frame's CSS pixels, clipped to
   * every frame around it, as hint rects are: each frame's embedder is asked for its viewport.
   * Null when it shows in none of them, or a frame did not answer.
   * @param {{ bc: any, wg: any }[]} chain  from frameChain
   * @param {number} gen
   * @param {Rect} box
   * @returns {Promise<Rect | null>}
   */
  async blockBox(chain, gen, box) {
    let origin = { x: 0, y: 0 };
    let clip = /** @type {Rect | null} */ ({ x: 0, y: 0, width: Infinity, height: Infinity });
    for (let i = chain.length - 1; i > 0; i--) {
      const outer = /** @type {{ bc: any, wg: any }} */ (chain[i]);
      const inner = /** @type {{ bc: any, wg: any }} */ (chain[i - 1]);
      const reply = /** @type {{ rect: Rect } | null} */ (
        await this.block(outer, gen, "frame", { id: inner.bc.id })
      );
      if (!reply || !clip) return null;
      const rect = offset(reply.rect, origin);
      clip = intersect(clip, rect);
      origin = { x: rect.x, y: rect.y };
    }
    if (!clip) return null;
    return chain.length > 1 ? intersect(offset(box, origin), clip) : box;
  },

  /**
   * Copy mode (m1-copy-mode) in the focused frame: `enter`, a motion (caret.mjs), `toggle`,
   * a selection op, `yank`, `yank_lines` or `exit`. The reply is from a content process:
   * anything but the expected type counts as a failure (false, or "" for `yank`).
   * @param {any} browser XULBrowserElement
   * @param {string} op
   * @param {number} [count]
   * @param {string} [char]  a find's character (`f x`)
   * @returns {Promise<boolean | string>}
   */
  async caret(browser, op, count, char) {
    /** @type {{ op: string, count?: number, char?: string }} */
    const data = { op };
    if (count !== undefined) data.count = count;
    if (char !== undefined) data.char = char;
    /** @type {unknown} */
    let reply;
    try {
      reply = await actorFor(framesFor(browser)[0])?.sendQuery("Vimma:Caret", data);
    } catch {
      reply = null; // the frame navigated or its process went away
    }
    if (op === "yank" || op === "yank_lines") return typeof reply === "string" ? reply : "";
    return reply === true;
  },
};

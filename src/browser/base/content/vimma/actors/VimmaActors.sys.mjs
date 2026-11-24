/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the Vimma JSWindowActor pair and sends it the host's commands (spec:
// docs/specs/m1-actor-insert-scroll.md). The host talks to content only through here; the agent
// commands of ctl/ send theirs through AgentActors.sys.mjs.

import {
  HINT_AGENT_FRAMES_MS,
  HINT_REPLY_MAX_TARGETS,
  HINT_TOP_TIMEOUT_MS,
  hintCollectReason,
  parseBlockReply,
  parseHintReply,
  parseHoverReply,
} from "../core/hints.mjs";
import { INSERT_ENTER } from "../core/editable.mjs";
import { parseScrollPosition } from "../core/find.mjs";
import { SCROLL_STEP_DEFAULT, scrollStep } from "../core/scroll.mjs";
import { suggestionStep } from "../core/suggestions.mjs";
import { NAME, actorFor } from "./actor-for.mjs";
import { pressKeyLater } from "./enter-key.mjs";
import { forgetMark } from "./submit-marks.mjs";

/** @import { BlockReply } from "../core/hints.mjs" */
/** @import { GrepAsk } from "./grep-page.mjs" */
/** @import { BlockMessage } from "./block.mjs" */

// System modules have no timer globals; Firefox's actors import them the same way.
const { clearTimeout, setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);

const BASE = "chrome://browser/content/vimma/actors/";
/** Cocoa's key bindings run in text fields (docs/specs/page-suggestions.md, Behaviour 3). */
const MAC = /** @type {{ OS?: string }} */ (Services.appinfo).OS === "Darwin";
/** What the parent actor's URL must look like: a system module of host/ (ADR-026). */
const PARENT_URI = /^chrome:\/\/browser\/content\/vimma\/host\/[\w-]+\.sys\.mjs$/;
/** start/StartPage.sys.mjs START_PAGE_URL; a match pattern needs no import for one string. */
const START_PAGE_MATCH = "chrome://browser/content/vimma/start/start.html";

/** @typedef {"down" | "up" | "left" | "right" | "half_down" | "half_up" | "top" | "bottom"} ScrollKind */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/**
 * A hint target in the parent: where to draw it and how to reach its element again.
 * @typedef {object} HintTarget
 * @property {Rect} rect  in the top frame's CSS pixels
 * @property {"link" | "input" | "click" | "block" | "hover"} kind
 * @property {string} [href]  links only
 * @property {string} [text]  an agent's links only: what the link says (mcp-drive D12)
 * @property {import("../core/blocks.mjs").BlockKind} [blockKind]  text blocks only
 * @property {Rect} [box]  text blocks only: the border box, for the outline
 * @property {import("../core/agent-element.mjs").AgentElementInfo} [info]  an agent's
 *   `vimma_elements` only: what the element is (docs/specs/mcp-forms.md F5)
 * @property {{ key: string, method: string, action: string }} [form]  an agent's
 *   `vimma_elements` only: the element's form; `key` tells forms of different frames apart
 * @property {number} gen  the collection it came from
 * @property {number} id  the element's index in its frame's collection
 * @property {CanonicalBrowsingContext} bc  its frame
 * @property {WindowGlobalParent} wg  the frame's document at collection time
 */
/**
 * A frame and its document (WindowGlobalParent) when it was chosen: null when it had none.
 * @typedef {{ bc: CanonicalBrowsingContext, wg: WindowGlobalParent | null }} FrameRef
 */

let registered = false;

/** Hint collections so far; a reply or an activation from an older one is ignored. */
let hintGen = 0;
/**
 * The generation of each tab's last blur (Esc). Per tab, so a content process cannot count the
 * Esc presses of other tabs.
 * @type {WeakMap<MozBrowser, number>}
 */
const blurGens = new WeakMap();

/**
 * The keydowns the parent let through to each document (WindowGlobalParent) since its last
 * blur (insert-focus behaviour 8), which that blur names so the frame can tell the keys it
 * handled before the blur was asked for from those it handled after.
 * @type {WeakMap<WindowGlobalParent, number>}
 */
const keysSent = new WeakMap();
/**
 * The live collection of each window, and of each agent tab (docs/specs/mcp-drive.md D12):
 * another window's `f` must not void a window's, and an agent's `f`, keyed by its tab's
 * <browser>, neither voids the user's hint mode in the same window nor is voided by it.
 * @type {WeakMap<Window | MozBrowser, number>}
 */
const liveGen = new WeakMap();

/**
 * Per browser, how its last collection's top frame ended (hintCollectReason), or "threw" when
 * its query rejected. Only read by tests, to say why a collection was empty (#605).
 * @type {WeakMap<MozBrowser, string>}
 */
const lastReasons = new WeakMap();

/** How long a subframe may take to answer (ms) before its targets are left out. */
const FRAME_TIMEOUT_PREF = "vimma.hints.frameTimeoutMs";
const FRAME_TIMEOUT_DEFAULT = 150;

/** At most this many targets in all frames (each frame: core HINT_REPLY_MAX_TARGETS). */
const MAX_HINTS = HINT_REPLY_MAX_TARGETS;
/** At most this deep in frames. */
const MAX_FRAME_DEPTH = 8;
/** Schemes `gF` opens; the page's principal must be allowed to load them too. */
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
 * `browser` still has focus, and `frame` is still its focused frame: a key pressed later goes
 * where the user typed or nowhere.
 * @param {MozBrowser} browser
 * @param {CanonicalBrowsingContext} frame
 */
function stillFocused(browser, frame) {
  return (
    Services.focus.focusedElement === browser &&
    Services.focus.focusedContentBrowsingContext === frame
  );
}

/**
 * The browser's focused frame when it is a subframe, then its top frame.
 * @param {MozBrowser} browser
 * @returns {CanonicalBrowsingContext[]}
 */
function framesFor(browser) {
  const top = browser.browsingContext;
  if (!top) return [];
  const focused = Services.focus.focusedContentBrowsingContext;
  return focused && focused !== top && focused.top === top ? [focused, top] : [top];
}

/** `[scroll] step` (docs/specs/m1-actor-insert-scroll.md, "Follow-up: scroll step"). */
let step = SCROLL_STEP_DEFAULT;

export const VimmaActors = {
  /**
   * Registers the actor pair once per process; vimma.js calls this before VimmaHost.init.
   * @param {string} parentURI  the parent actor's module, host/VimmaParent.sys.mjs: it lives in
   *   host/, a higher layer that this folder does not name (ADR-026), so vimma.js passes it in
   * @throws {TypeError} unless `parentURI` is a host/ system module's chrome:// URL, before
   *   anything is registered, so a later call with the right one still registers the pair
   */
  register(parentURI) {
    // A wrong URL would register a parent that never loads: page reports dropped, no error.
    if (typeof parentURI !== "string" || !PARENT_URI.test(parentURI)) {
      throw new TypeError(
        `VimmaActors.register: the parent actor must be a host/ module, not ${JSON.stringify(parentURI)}`,
      );
    }
    if (registered) return;
    registered = true;
    ChromeUtils.registerWindowActor(NAME, {
      parent: { esModuleURI: parentURI },
      child: {
        esModuleURI: `${BASE}VimmaChild.sys.mjs`,
        events: {
          focusin: { capture: true },
          focusout: { capture: true },
          focus: { capture: true },
          // Counts the keys that reach the page, for a late Vimma:Blur (insert-focus
          // behaviour 8). Trusted only, from outside the page, which cannot stop them.
          keydown: { capture: true, createActor: false },
          // Only for an editable document root; a frame never focused has no actor to ask.
          mousedown: { capture: true, createActor: false },
          // A drag and drop's end is no mouse selection (m1-copy-mode).
          dragstart: { capture: true, createActor: false },
          // Text the user puts in without a key Vimma sees as one, which makes a field the page
          // focused theirs (docs/specs/mcp-drive.md D13): an IME's composition, a drop from
          // another application, and what an editor gets typed, composed, pasted or dropped.
          compositionstart: { capture: true, createActor: false },
          drop: { capture: true, createActor: false },
          beforeinput: { capture: true, createActor: false },
          // pdf.js's viewer, once it has a document and once its pages are laid out
          // (docs/specs/pdf-mode.md decisions 2 and 20): chrome-only events, which only pdf.js
          // sends. The first lets the viewer take the theme before its pages are drawn.
          documentloaded: {},
          pagesloaded: {},
          // An agent's step still to run when its page is hidden is skipped then, while the
          // child can still tell the parent (issue #1028). The system group: the page cannot
          // stop it.
          pagehide: { mozSystemGroup: true, createActor: false },
          // Whether a wheel has reached the page, and whether the page cancelled it, for the
          // labels after a wheel (m1-hints, issue #1375). The system group runs after the
          // page's listeners; passive, as a listener that may cancel a wheel makes APZ wait
          // for the page before it scrolls.
          wheel: { mozSystemGroup: true, passive: true, createActor: false },
          // macOS only: a suggestion key's keypress, before the focused field runs Cocoa's key
          // binding on it (VimmaChild, "keypress"). The field's handler is in the system
          // group: an <input>'s or <textarea>'s on the field in the bubble phase
          // (TextInputListener), a contenteditable's at capture on the target these listeners
          // are on, added after them (EditorEventListener). So this one is at capture too.
          ...(MAC ? { keypress: { capture: true, mozSystemGroup: true, createActor: false } } : {}),
        },
      },
      allFrames: true,
      // The start page (start/start.html) loads in the parent process; it needs the actor
      // for normal mode like any page. A view-source: page (`gf`, View Page Source) is
      // Firefox's own rendering of a source as inert markup: no page script runs in it, and web
      // content cannot navigate to it (URI_DANGEROUS_TO_LOAD, nsViewSourceHandler.cpp).
      matches: [
        "http://*/*",
        "https://*/*",
        "file:///*",
        "about:*",
        "view-source:*",
        START_PAGE_MATCH,
      ],
      messageManagerGroups: ["browsers"],
      // The child only reports focus, scrolls its own page and answers about its own text; the
      // parent trusts nothing but a descriptor, which at worst flips that tab's mode, and
      // checks every other reply (core parseHintReply, parseGrepReply).
      safeForUntrustedWebProcess: true,
    });
  },

  /**
   * Whether the browser's page has our actor (else the host keeps it in insert).
   * @param {MozBrowser} browser
   */
  has(browser) {
    return !!actorFor(browser.browsingContext);
  },

  /**
   * The j/k/h/l step in CSS pixels, from config.toml's `[scroll] step`; it applies from the next
   * scroll in every tab. A value config.toml could not set keeps the default.
   * @param {number} next
   */
  setScrollStep(next) {
    step = scrollStep(next);
  },

  /**
   * Scrolls the focused frame, or the top frame if the focused one has nothing to scroll.
   * @param {MozBrowser} browser
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
      if (await actorFor(bc)?.sendQuery("Vimma:Scroll", { kind, count, instant, step }))
        return true;
    }
    return false;
  },

  /**
   * Resolves once the page in `browser` has painted since its last resize reached it, or at
   * once when it has no actor (docs/specs/private-swap-macos.md, #773). Nothing comes back but
   * the reply itself, and the caller bounds the wait.
   * @param {MozBrowser} browser
   * @returns {Promise<void>}
   */
  async painted(browser) {
    try {
      await actorFor(browser.browsingContext)?.sendQuery("Vimma:Painted");
    } catch {
      // The page went away or navigated: nothing of it is left to wait for.
    }
  },

  /**
   * How far the top frame is scrolled down, from 0 to 1 (docs/specs/mcp-drive.md D16). The
   * page's child answers, so the number is checked here.
   * @param {MozBrowser} browser
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
   * in the focused frame, on its focused text field, if any. INSERT_ENTER (ctrl+j, ctrl+m) is
   * an Enter pressed here in the parent, which Firefox routes to the page's focused element as
   * it does a keyboard's.
   * @param {MozBrowser} browser
   * @param {string} command  one of core INSERT_EDIT_COMMANDS, or INSERT_ENTER
   * @param {() => boolean} [still]  the caller's own check, made again just before an Enter
   */
  edit(browser, command, still = () => true) {
    if (command === INSERT_ENTER) {
      // The frame focused now: a page that moves focus (into another frame) in the time before
      // the Enter gets none, rather than an Enter where the user did not type.
      const frame = Services.focus.focusedContentBrowsingContext;
      const win = browser.ownerDocument?.defaultView;
      if (!win || !frame) return;
      pressKeyLater(win, "Enter", () => stillFocused(browser, frame) && still());
      return;
    }
    actorFor(framesFor(browser)[0])?.sendAsyncMessage("Vimma:Edit", { command });
  },

  /**
   * ctrl+n or ctrl+p after the page left it alone (docs/specs/page-suggestions.md): asks the
   * focused frame whether its field's suggestion list is open, and if so presses ArrowDown or
   * ArrowUp there, from the parent, so the page gets a trusted key. The frame focused now: one
   * that loses focus before the press gets none.
   * @param {MozBrowser} browser
   * @param {string} actionId  page.suggestion_next or page.suggestion_prev
   * @param {() => boolean} [still]  the caller's own check, made again just before the press
   * @returns {Promise<boolean>} whether a list was open; false means the caller falls back
   */
  async suggestion(browser, actionId, still = () => true) {
    const frame = Services.focus.focusedContentBrowsingContext;
    const win = browser.ownerDocument?.defaultView;
    if (!win || !frame || frame.top !== browser.browsingContext) return false;
    let open = false;
    try {
      // The child answers one boolean; anything else from a compromised process is "no list".
      open = (await actorFor(frame)?.sendQuery("Vimma:SuggestionsOpen")) === true;
    } catch {
      // The frame went away (navigation): no list.
    }
    const step = suggestionStep(actionId, open);
    if (step.kind !== "press") return false;
    pressKeyLater(win, step.key, () => stillFocused(browser, frame) && still());
    return true;
  },

  /**
   * The top frame's selected text, at most `max` characters, or null (an agent's read,
   * docs/specs/vimma-mcp.md decision 4).
   * @param {MozBrowser} browser
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
   * A keydown is on its way to `browser`'s focused frame: chrome left it alone, so Firefox
   * passes it to the page once chrome's handlers are done.
   * @param {MozBrowser} browser
   */
  keySent(browser) {
    const wg = framesFor(browser)[0]?.currentWindowGlobal;
    // A page of the parent process (the start page) has had the key already, in order with
    // the blur: no count, and its blur falls back to a plain one.
    if (wg && !wg.isInProcess) keysSent.set(wg, (keysSent.get(wg) ?? 0) + 1);
  },

  /**
   * Blurs the focused element of the focused frame (Esc in insert). Each blur has a new
   * generation, which the frame's later focus reports carry.
   * @param {MozBrowser} browser
   * @returns {{ windowId: number, gen: number } | null} the document the blur went to and its
   *   generation
   */
  blur(browser) {
    const bc = framesFor(browser)[0];
    // An actor is its document's: a frame with one has a document.
    const wg = bc?.currentWindowGlobal;
    const actor = actorFor(bc);
    if (!wg || !actor) return null;
    const gen = (blurGens.get(browser) ?? 0) + 1;
    blurGens.set(browser, gen);
    const keys = wg.isInProcess ? undefined : (keysSent.get(wg) ?? 0);
    keysSent.delete(wg);
    actor.sendAsyncMessage("Vimma:Blur", { gen, keys });
    return { windowId: wg.innerWindowId, gen };
  },

  /**
   * Test-only: the content-side time of the last collectHints, summed over frames, in ms.
   * @type {number}
   */
  _lastCollectMs: 0,

  /**
   * Test-only: why the last collectHints of this browser's top frame returned what it did.
   * @param {MozBrowser} browser
   * @returns {string}
   */
  lastCollectReason(browser) {
    return lastReasons.get(browser) ?? "never-collected";
  },

  /**
   * The hint targets on screen in the browser's page and its frames (m1-hints), in the top
   * frame's CSS pixels. Each frame's child collects its own; frames from other origins are
   * other processes, so the parent merges them, offset by the frame rects their embedder
   * reported and clipped to them. Replies are from content processes and checked like any
   * other message: a malformed one drops that frame.
   * @param {MozBrowser} browser
   * @param {string} action "hint.follow", "hint.follow_new_tab" or "hint.follow_new_tab_fg"
   *   (links only) or "hint.element"
   *   (text blocks, docs/specs/element-focus.md)
   * @param {{ agent?: boolean, elements?: boolean, hoverToo?: boolean }} [options]  `agent`: an
   *   agent's `f` in its tab (docs/specs/mcp-drive.md D12): links only, each with its text, live
   *   per tab, not per window; `hint.hover` collects what can be hovered (docs/specs/hover.md);
   *   with `elements`, an agent's `vimma_elements`
   *   (docs/specs/mcp-forms.md F2): every kind but blocks, disabled controls too, each
   *   described, kept apart from the user's; with `hoverToo` also what only hovering does
   *   something with (docs/specs/hover.md decision 10)
   * @returns {Promise<HintTarget[]>}
   */
  async collectHints(browser, action, { agent = false, elements = false, hoverToo = false } = {}) {
    const gen = ++hintGen;
    // A <browser>'s document has no view only once its window has closed, where liveGen.set
    // throws: the collection fails, as before the type said so.
    const key = agent ? browser : /** @type {Window} */ (browser.ownerDocument.defaultView);
    liveGen.set(key, gen);
    const live = () => liveGen.get(key) === gen;
    const frameTimeout = Services.prefs.getIntPref(FRAME_TIMEOUT_PREF, FRAME_TIMEOUT_DEFAULT);
    const agentDeadline = Date.now() + HINT_AGENT_FRAMES_MS;
    /** How long the frame at `depth` may take, from now. @param {number} depth */
    const timeoutAt = (depth) => {
      if (agent) return Math.max(0, agentDeadline - Date.now());
      return depth === 0 ? HINT_TOP_TIMEOUT_MS : frameTimeout;
    };
    /** Each frame at most once, whatever its embedder reports. */
    const visited = new Set();
    const linksOnly =
      (agent && !elements) ||
      action === "hint.follow_new_tab" ||
      action === "hint.follow_new_tab_fg" ||
      action === "hint.show_target" ||
      action === "hint.copy_target";
    const blocks = !agent && action === "hint.element";
    const hover = !agent && action === "hint.hover";
    const texts = agent && !elements;
    /** @type {HintTarget[]} */
    const out = [];
    let ms = 0;
    /**
     * @param {CanonicalBrowsingContext} bc
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
      const actor = actorFor(bc);
      const queried = !!actor;
      try {
        // A busy or hung frame (its process spinning) must not hold up the others' labels.
        /** @type {Promise<null>} */
        const late = new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutAt(depth), null);
        });
        const query = actor?.sendQuery("Vimma:CollectHints", {
          gen,
          linksOnly,
          blocks,
          texts,
          elements: agent && elements,
          hover,
          ...(agent && elements && hoverToo ? { hoverToo: true } : {}),
        });
        raw = await Promise.race([query, late]);
      } catch {
        if (depth === 0) lastReasons.set(browser, "threw");
        return; // the frame navigated or its process went away
      } finally {
        clearTimeout(timer);
      }
      // From a content process, which may be compromised: a fresh, checked copy or nothing.
      const reply = parseHintReply(raw, { blocks, texts, elements: agent && elements, hover });
      if (depth === 0) {
        lastReasons.set(browser, hintCollectReason({ queried, raw, reply, live: live() }));
      }
      // A reply came from the actor of `wg`'s document, so there is one.
      if (!reply || !wg || !live()) return;
      ms += reply.ms;
      for (const t of reply.targets) {
        if (out.length >= MAX_HINTS) break;
        const rect = intersect(offset(t.rect, origin), frame);
        if (!rect) continue;
        /** @type {HintTarget} */
        const target = { gen, bc, wg, id: t.id, kind: t.kind, href: t.href, rect };
        if (texts) target.text = t.text ?? "";
        if (t.agent) {
          target.info = t.agent;
          const form = t.agent.form === undefined ? undefined : reply.forms?.[t.agent.form];
          if (form) target.form = { key: `${bc.id}:${t.agent.form}`, ...form };
        }
        if (t.box) {
          const box = intersect(offset(t.box, origin), frame);
          if (!box) continue;
          target.blockKind = t.blockKind;
          target.box = box;
        }
        out.push(target);
      }
      // The frames it names are its document's: once the frame shows another, none of them.
      if (depth >= MAX_FRAME_DEPTH || bc.currentWindowGlobal !== wg) return;
      const children = reply.frames.map((f) => {
        // Only a frame this document embeds: a content process names no other.
        const child = bc.children.find((c) => c.id === f.id);
        if (!child) return null;
        const rect = offset(f.rect, origin);
        const clipped = intersect(rect, frame);
        return clipped && visit(child, clipped, { x: rect.x, y: rect.y }, depth + 1);
      });
      await Promise.all(children);
    };
    // A browser without a frame loader has no context, and visit's first read throws on it: the
    // collection fails, as before the type said so.
    const top = /** @type {CanonicalBrowsingContext} */ (browser.browsingContext);
    const all = { x: 0, y: 0, width: Infinity, height: Infinity };
    await visit(top, all, { x: 0, y: 0 }, 0);
    this._lastCollectMs = ms;
    return live() ? out : [];
  },

  /**
   * A wheel over the page while the labels of collection `gen` show (m1-hints, issue #1337):
   * resolves once the scroll it started has ended, true unless the top frame says that none of
   * its targets moved (VimmaChild `Vimma:HintsMoved`). The reply is from a content process:
   * only `false` keeps the labels, and a frame that gave no answer within HINT_TOP_TIMEOUT_MS,
   * went away or threw counts as moved, so the labels are collected again as before.
   * @param {MozBrowser} browser
   * @param {number} gen  the collection whose labels show
   * @param {{ x: number, y: number, dx: number, dy: number, shift: boolean, other: boolean }}
   *   wheel  its point in the page's CSS pixels, its deltas, whether shift was down, and
   *   whether ctrl, alt or meta was (the child tells from these whether it can scroll)
   * @returns {Promise<boolean>}
   */
  async hintsMoved(browser, gen, wheel) {
    const actor = actorFor(browser.browsingContext);
    if (!actor) return true;
    /** @type {number | undefined} */
    let timer;
    try {
      /** @type {Promise<true>} */
      const late = new Promise((resolve) => {
        timer = setTimeout(resolve, HINT_TOP_TIMEOUT_MS, true);
      });
      const { x, y, dx, dy, shift, other } = wheel;
      const query = actor.sendQuery("Vimma:HintsMoved", { gen, x, y, dx, dy, shift, other });
      return (await Promise.race([query, late])) !== false;
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Follows a target in its own frame: a click, or focus for a text field.
   * @param {HintTarget} target
   */
  activateHint(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return;
    // The user's own step through their hints: a submission it causes is theirs (mcp-forms F16).
    const id = target.bc.top?.browserId;
    if (id) forgetMark(id);
    actorFor(target.bc)
      ?.sendQuery("Vimma:ActivateHint", { gen: target.gen, id: target.id })
      .catch(() => {});
  },

  /**
   * Hovers a target of the user's `gh` collection (docs/specs/hover.md): its frame locks `:hover`
   * on it and sends the pointer's events, trusted, as the user's. HoverOps then has the frames
   * around it lock their `<iframe>` chains (hoverEmbedders, decision 12). Resolves the
   * element's text for the status bar, or null when the frame did not hover it.
   * @param {HintTarget} target
   * @returns {Promise<{ text: string } | null>}
   */
  async hover(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return null;
    const actor = actorFor(target.bc);
    if (!actor) return null;
    /** @type {unknown} */
    let raw;
    try {
      raw = await actor.sendQuery("Vimma:Hover", { op: "hover", gen: target.gen, id: target.id });
    } catch {
      return null; // the frame navigated or its process went away
    }
    // From a content process, which may be compromised: a checked copy, its text cleaned.
    const reply = parseHoverReply(raw);
    if (!reply?.hovered || target.bc.currentWindowGlobal !== target.wg) return null;
    return { text: reply.text };
  },

  /**
   * Ends the hover the user's `gh` began in frame `bc` while it shows document `wg`, and the
   * locks of the frames around it. A frame showing another document by now has no hover of ours.
   * @param {CanonicalBrowsingContext} bc
   * @param {WindowGlobalParent} wg
   */
  releaseHover(bc, wg) {
    if (bc.currentWindowGlobal === wg) {
      actorFor(bc)
        ?.sendQuery("Vimma:Hover", { op: "release" })
        .catch(() => {});
    }
    this.hoverEmbedders(bc, "release");
  },

  /**
   * Has each frame around `bc` lock (or release) its `<iframe>` element's chain for the hover in
   * `bc` (docs/specs/hover.md decision 12).
   * @param {CanonicalBrowsingContext} bc
   * @param {"lock" | "release"} op
   */
  hoverEmbedders(bc, op) {
    for (let child = bc, parent = bc.parent; parent; child = parent, parent = parent.parent) {
      try {
        actorFor(parent)?.sendAsyncMessage("Vimma:HoverEmbedder", { op, frame: child.id });
      } catch {
        // That frame's document went away, and its locks with it.
      }
    }
  },

  /**
   * Opens a link target in a new tab next to the browser's, in its container, as the page
   * itself would load it: the page's principal triggers the load, so a page cannot open what it
   * could not link to. `background` is passed to openLinkIn either way, so
   * browser.tabs.loadInBackground never decides (docs/specs/follow-link-switch.md decision 5). A
   * foreground tab is opened selected rather than selected afterwards: its TabOpen and TabSelect
   * in one task make it a new tab in a split, shown alone beside it, or in the focused pane with
   * `[panes] new_tab = "pane"` (decision 4; docs/specs/new-tab-in-split.md).
   * @param {MozBrowser} browser
   * @param {HintTarget} target
   * @param {{ background: boolean }} options
   * @returns {boolean} whether a tab was opened
   */
  openInNewTab(browser, target, { background }) {
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
    // Its document's view: ownerGlobal reads undefined from this module.
    /** @type {Window | null} */
    const view = browser.ownerDocument.defaultView;
    // A tab's <browser> is in a browser window; once that has closed there is no view, and the
    // read of gBrowser below throws, as before the type said so.
    const win = /** @type {BrowserWindow} */ (view);
    const tab = win.gBrowser.getTabForBrowser(browser);
    win.openLinkIn(url.href, "tab", {
      inBackground: background,
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
   * Loads a link target's href in `browser` itself, as the page would load it: the page's
   * principal triggers the load and no event fires on the link, so no page handler runs (an
   * agent's follow, docs/specs/mcp-drive.md D12). It sends no referrer: the child does not
   * report the page's referrer policy or the link's `rel`, and none is the strictest of them.
   * The caller checked the scheme, the document and checkLoadURIWithPrincipal.
   * @param {MozBrowser} browser
   * @param {HintTarget} target
   * @param {nsIURI} uri  the target's href
   */
  loadLink(browser, target, uri) {
    const wg = target.wg;
    browser.loadURI(uri, {
      triggeringPrincipal: wg.documentPrincipal,
      referrerInfo: new ReferrerInfo(Ci.nsIReferrerInfo.NO_REFERRER, false, wg.documentURI),
    });
  },

  /**
   * Drops the window's collection in flight (Esc, tab switch): its reply is ignored.
   * @param {Window} win
   */
  cancelHints(win) {
    liveGen.delete(win);
  },

  /**
   * `i`: focuses the text field the user was last in, if its frame still shows the same
   * document and still has it, else the first visible text field in the top frame. Only a frame
   * of this tab is asked, and only the document that reported the field (a frame that has since
   * loaded another page, perhaps from another site, is not).
   * @param {MozBrowser} browser
   * @param {{ frame: CanonicalBrowsingContext | null, windowId: number }} [last] the frame and
   *   its document's inner window ID
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
   * @param {MozBrowser} browser
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
   * @param {MozBrowser} browser
   * @returns {Promise<{ x: number, y: number } | null>}
   */
  async scrollPosition(browser) {
    try {
      return parseScrollPosition(
        await actorFor(browser.browsingContext)?.sendQuery("Vimma:ScrollPosition"),
      );
    } catch {
      return null;
    }
  },

  /**
   * Makes the next find start where Vim's would (spec m1-find): at a selection still on screen,
   * else at the top of the viewport, not at the document's first match.
   * @param {MozBrowser} browser
   * @returns {Promise<void>}  resolves once the anchor is set (or could not be)
   */
  async findAnchor(browser) {
    try {
      await actorFor(browser.browsingContext)?.sendQuery("Vimma:FindAnchor");
    } catch {
      // the page went away: its next find starts where Firefox's would
    }
  },

  /**
   * Tells every frame of `browser` that a find step starts (a search, `n` or `N`): the finder
   * may focus a text field it matches in again, even one whose focus an earlier step gave back
   * (VimmaChild #focusedByFind, #442). Sent before the step's own Finder messages, on the same
   * channel per frame, so each frame gets it first.
   * @param {MozBrowser} browser
   */
  findStep(browser) {
    for (const bc of browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
      actorFor(bc)?.sendAsyncMessage("Vimma:FindStep");
    }
  },

  /**
   * Tells the frame a find bar closed on that the close is through (VimmaChild #findClosed).
   * Sent after the find bar's close(), so the frame gets it after the finder's own messages.
   * @param {CanonicalBrowsingContext | null} bc  the frame the finder sent its close to
   */
  findClosed(bc) {
    actorFor(bc)?.sendAsyncMessage("Vimma:FindClosed");
  },

  /**
   * Scrolls the top frame back to a position from `scrollPosition` (Esc in a find).
   * @param {MozBrowser} browser
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
   * @param {MozBrowser} browser
   * @param {number} max
   * @returns {{ frames: CanonicalBrowsingContext[], cut: boolean }}
   */
  grepFrames(browser, max) {
    /** @type {CanonicalBrowsingContext[]} */
    const out = [];
    let cut = false;
    /** @param {CanonicalBrowsingContext | null} bc @param {number} depth */
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
   * @param {CanonicalBrowsingContext} bc
   * @param {string} name
   * @param {GrepAsk} data
   * @param {number} ms
   * @returns {Promise<unknown>}
   */
  async grepAsk(bc, name, data, ms) {
    /** @type {number | undefined} */
    let timer;
    try {
      const query = actorFor(bc)?.sendQuery(name, data);
      if (!query) return null;
      /** @type {Promise<null>} */
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
   * @param {FrameRef} frame  the frame and its document when the block was chosen
   * @param {number} gen
   * @param {string} op
   * @param {Omit<BlockMessage, "op" | "gen">} [extra]  the op's own fields (`id`, `count`, `line`)
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
   * @param {FrameRef} frame
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
   * @param {CanonicalBrowsingContext} bc
   * @returns {FrameRef[]}  the frame first, the top last
   */
  frameChain(bc) {
    /** @type {FrameRef[]} */
    const out = [];
    for (
      let c = /** @type {CanonicalBrowsingContext | null} */ (bc);
      c && out.length <= MAX_FRAME_DEPTH;
      c = c.parent
    ) {
      out.push({ bc: c, wg: c.currentWindowGlobal });
    }
    return out;
  },

  /**
   * Where a box in the first frame of `chain` is in the top frame's CSS pixels, clipped to
   * every frame around it, as hint rects are: each frame's embedder is asked for its viewport.
   * Null when it shows in none of them, or a frame did not answer.
   * @param {FrameRef[]} chain  from frameChain
   * @param {number} gen
   * @param {Rect} box
   * @returns {Promise<Rect | null>}
   */
  async blockBox(chain, gen, box) {
    let origin = { x: 0, y: 0 };
    let clip = /** @type {Rect | null} */ ({ x: 0, y: 0, width: Infinity, height: Infinity });
    for (let i = chain.length - 1; i > 0; i--) {
      const outer = /** @type {FrameRef} */ (chain[i]);
      const inner = /** @type {FrameRef} */ (chain[i - 1]);
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
   * `gy` (docs/specs/copy-link-url.md): the focused frame's link URLs, from copy mode's caret or
   * selection (`caret`) or from the focused link or the selection on screen (`focus`). The reply
   * is from a content process and is returned unchecked, for core linkYank; null when the frame
   * navigated or went away.
   * @param {MozBrowser} browser
   * @param {"caret" | "focus"} from
   * @returns {Promise<unknown>}
   */
  async linkUrls(browser, from) {
    try {
      return await actorFor(framesFor(browser)[0])?.sendQuery("Vimma:LinkUrls", { from });
    } catch {
      return null; // the frame navigated or its process went away
    }
  },

  /**
   * Copy mode (m1-copy-mode) in the focused frame: `enter`, a motion (caret.mjs), `toggle`,
   * a selection op, `yank`, `yank_lines` or `exit`. The reply is from a content process:
   * anything but the expected type counts as a failure (false, or "" for `yank`).
   * @param {MozBrowser} browser
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

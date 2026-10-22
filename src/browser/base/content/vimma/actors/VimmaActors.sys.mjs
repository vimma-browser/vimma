/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the Vimma JSWindowActor pair and sends it commands (spec:
// docs/specs/m1-actor-insert-scroll.md). The host talks to content only through here.

import { HINT_REPLY_MAX_TARGETS, parseBlockReply, parseHintReply } from "../core/hints.mjs";
import { parseActTarget, parseFillTarget } from "../core/agent-act.mjs";

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
 * @property {string} [text]  an agent's links only: what the link says (mcp-drive D12)
 * @property {import("../core/blocks.mjs").BlockKind} [blockKind]  text blocks only
 * @property {Rect} [box]  text blocks only: the border box, for the outline
 * @property {import("../core/agent-element.mjs").AgentElementInfo} [info]  an agent's
 *   `vimma_elements` only: what the element is (docs/specs/mcp-forms.md F5)
 * @property {{ key: string, method: string, action: string }} [form]  an agent's
 *   `vimma_elements` only: the element's form; `key` tells forms of different frames apart
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
/**
 * The live collection of each window, and of each agent tab (docs/specs/mcp-drive.md D12):
 * another window's `f` must not void a window's, and an agent's `f`, keyed by its tab's
 * <browser>, neither voids the user's hint mode in the same window nor is voided by it.
 * @type {WeakMap<object, number>}
 */
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

/**
 * Agent tabs an agent just stepped in (docs/specs/mcp-forms.md F16; security.md M28), by their
 * browserId, which survives a move to another window: the top document of the step, the one
 * submission a question allowed during the running call (its method and destination without
 * query), and the hosts of the submissions stopped since the step began.
 * @type {Map<number, { doc: number, allowed: { method: string, where: string } | null,
 *   blocked: string[] }>}
 */
const submitMarks = new Map();
/** @type {((subject: any) => void) | null} */
let submitObserver = null;

/** A URI's destination as a submission is compared: scheme, host, port and path. @param {any} uri */
const whereOf = (uri) => `${uri.prePath}${uri.filePath}`;

/**
 * Every navigating form submission's request passes here, in the parent, whatever started it
 * (a submit button, `requestSubmit`, a later `submit()`, any frame): in a tab an agent stepped
 * in, while its page is the one of the step, a submission without the user's activation is
 * cancelled unless it is the one the question allowed, to the method and destination it named.
 * The request carries its document's transient user activation, which an agent's click never
 * gives, so a submission with it is the user's, and it ends the mark.
 * @param {any} subject
 */
function onRequest(subject) {
  let channel;
  try {
    channel = subject.QueryInterface(Ci.nsIHttpChannel);
  } catch {
    return;
  }
  const info = channel.loadInfo;
  if (!info?.isFormSubmission) return;
  const top = info.browsingContext?.top;
  const id = top?.browserId;
  const mark = id ? submitMarks.get(id) : undefined;
  if (!mark) return;
  if (top.currentWindowGlobal?.innerWindowId !== mark.doc || info.hasValidUserGestureActivation) {
    forgetMark(id);
    return;
  }
  // A redirect of a submission that was let through (the allowed one, or the user's): its first
  // request was checked here, and the server has already received it.
  if (info.redirectChainIncludingInternalRedirects?.length) return;
  const uri = channel.URI;
  const allowed = mark.allowed;
  if (
    allowed &&
    allowed.method === String(channel.requestMethod).toLowerCase() &&
    allowed.where === whereOf(uri)
  ) {
    mark.allowed = null;
    return;
  }
  channel.cancel(Cr.NS_BINDING_ABORTED);
  let host = "";
  try {
    host = String(uri.asciiHost);
  } catch {
    // no host to name
  }
  if (host && mark.blocked.length < 16) mark.blocked.push(host);
}

/** @param {number} id  a browserId whose mark ends; the observer goes with the last mark */
function forgetMark(id) {
  submitMarks.delete(id);
  if (!submitMarks.size && submitObserver) {
    Services.obs.removeObserver(submitObserver, "http-on-modify-request");
    submitObserver = null;
  }
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
   * @param {{ agent?: boolean, elements?: boolean }} [options]  `agent`: an agent's `f` in its
   *   tab (docs/specs/mcp-drive.md D12): links only, each with its text, live per tab, not per
   *   window; with `elements`, an agent's `vimma_elements` (docs/specs/mcp-forms.md F2): every
   *   kind but blocks, disabled controls too, each described, kept apart from the user's
   * @returns {Promise<HintTarget[]>}
   */
  async collectHints(browser, action, { agent = false, elements = false } = {}) {
    const gen = ++hintGen;
    const key = agent ? browser : browser.ownerDocument.defaultView;
    liveGen.set(key, gen);
    const live = () => liveGen.get(key) === gen;
    const frameTimeout = Services.prefs.getIntPref(FRAME_TIMEOUT_PREF, FRAME_TIMEOUT_DEFAULT);
    /** Each frame at most once, whatever its embedder reports. */
    const visited = new Set();
    const linksOnly = (agent && !elements) || action === "hint.follow_new_tab";
    const blocks = !agent && action === "hint.element";
    const texts = agent && !elements;
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
        const query = actorFor(bc)?.sendQuery("Vimma:CollectHints", {
          gen,
          linksOnly,
          blocks,
          texts,
          elements: agent && elements,
        });
        raw = await Promise.race([query, late]);
      } catch {
        return; // the frame navigated or its process went away
      } finally {
        clearTimeout(timer);
      }
      // From a content process, which may be compromised: a fresh, checked copy or nothing.
      const reply = parseHintReply(raw, { blocks, texts, elements: agent && elements });
      if (!reply || !live()) return;
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
    // The user's own step through their hints: a submission it causes is theirs (mcp-forms F16).
    const id = target.bc.top?.browserId;
    if (id) forgetMark(id);
    actorFor(target.bc)
      ?.sendQuery("Vimma:ActivateHint", { gen: target.gen, id: target.id })
      .catch(() => {});
  },

  /**
   * Whether the element of a target from an agent's `vimma_elements` is still in its document
   * (docs/specs/mcp-forms.md F4): false when its frame shows another document, the page removed
   * or replaced it, or the frame did not answer.
   * @param {HintTarget} target
   * @returns {Promise<boolean>}
   */
  async agentElementAlive(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return false;
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "alive",
        gen: target.gen,
        id: target.id,
      });
      return reply === true;
    } catch {
      return false; // the frame navigated or its process went away
    }
  },

  /**
   * What the element of a target from an agent's `vimma_elements` is now, just before a click
   * (docs/specs/mcp-forms.md F4, F9, F10, F15), checked like any reply from a content process;
   * `{ alive: false }` when it is gone, its frame shows another document or did not answer.
   * @param {HintTarget} target
   * @returns {Promise<import("../core/agent-act.mjs").ActTarget | null>} null: a malformed reply
   */
  async agentInspect(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return { alive: false };
    try {
      const raw = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "inspect",
        gen: target.gen,
        id: target.id,
      });
      return raw === undefined ? { alive: false } : parseActTarget(raw);
    } catch {
      return { alive: false }; // the frame navigated or its process went away
    }
  },

  /**
   * Clicks the element of a target from an agent's `vimma_elements` with the child's `click()`
   * (docs/specs/mcp-forms.md F8; security.md M26), once the child has seen it is still what the
   * user was asked about: a submit only when `submit`, to the method and destination it names,
   * and the same link. The child answers before it clicks, so a dialog the click opens never
   * holds the reply.
   * @param {HintTarget} target
   * @param {{ submit: { method: string, action: string } | null, href: string | null,
   *   until: number }} asked  `until`: ms since the epoch; the child clicks nothing later
   * @returns {Promise<"ok" | "gone" | "changed">}
   */
  async agentActivate(target, { submit, href, until }) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "activate",
        gen: target.gen,
        id: target.id,
        submit,
        href,
        until,
      });
      return reply === "ok" || reply === "changed" ? reply : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * An agent is about to act in the browser's page (docs/specs/mcp-forms.md F16; security.md
   * M28): from now until the user's own activation or another page, a form submission there is
   * cancelled, but for `allowed`, the one the question named, once, during this call. The
   * user's activation from before the step is consumed in every frame first, so that only their
   * input after it counts as theirs.
   * @param {any} browser XULBrowserElement
   * @param {{ method: string, action: string } | null} allowed
   * @returns {Promise<boolean>} false when the page has no document to mark
   */
  async agentMark(browser, allowed) {
    const top = browser.browsingContext;
    const doc = top?.currentWindowGlobal?.innerWindowId ?? 0;
    if (!top || !doc) return false;
    /** @type {any[]} */
    let contexts;
    try {
      contexts = top.getAllBrowsingContextsInSubtree();
    } catch {
      return false;
    }
    await Promise.all(
      contexts.map((bc) =>
        actorFor(bc)
          ?.sendQuery("Vimma:AgentElement", { op: "consume" })
          .catch(() => {}),
      ),
    );
    // Marks of tabs that closed or moved to another page are dropped here.
    for (const [id, mark] of submitMarks) {
      const other = /** @type {any} */ (BrowsingContext).getCurrentTopByBrowserId(id);
      if (other?.currentWindowGlobal?.innerWindowId !== mark.doc) submitMarks.delete(id);
    }
    if (!submitObserver) {
      submitObserver = onRequest;
      Services.obs.addObserver(submitObserver, "http-on-modify-request");
    }
    let where = null;
    if (allowed) {
      try {
        where = whereOf(Services.io.newURI(allowed.action));
      } catch {
        // not a URL: nothing is allowed
      }
    }
    submitMarks.set(top.browserId, {
      doc,
      allowed: allowed && where ? { method: allowed.method, where } : null,
      blocked: [],
    });
    return true;
  },

  /**
   * The agent's call is over: the allowed submission is no longer allowed, and the hosts of the
   * submissions stopped since the mark are returned (the mark stays).
   * @param {any} browser XULBrowserElement
   * @returns {string[]}
   */
  agentSettle(browser) {
    const mark = submitMarks.get(browser.browsingContext?.browserId);
    if (!mark) return [];
    mark.allowed = null;
    const blocked = mark.blocked;
    mark.blocked = [];
    return blocked;
  },

  /**
   * Whether the agent's last click on `target` ran, or was skipped because the page changed
   * the element under the mouse events (docs/specs/mcp-forms.md F8). A frame that went away
   * (the click loaded a page) ran it.
   * @param {HintTarget} target
   * @returns {Promise<"clicked" | "skipped" | "pending">}
   */
  async agentClickOutcome(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return "clicked";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "outcome",
        gen: target.gen,
        id: target.id,
      });
      return reply === "skipped" || reply === "pending" ? reply : "clicked";
    } catch {
      return "clicked";
    }
  },

  /**
   * What the field of a target from an agent's `vimma_elements` is now, for a fill with `value`
   * (docs/specs/mcp-forms.md F4, F6, F12, F13), checked like any reply from a content process;
   * `{ alive: false }` when it is gone, its frame shows another document or did not answer.
   * @param {HintTarget} target @param {string | boolean} value
   * @returns {Promise<import("../core/agent-act.mjs").FillTarget | null>} null: a malformed reply
   */
  async agentInspectFill(target, value) {
    if (target.bc.currentWindowGlobal !== target.wg) return { alive: false };
    try {
      const raw = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "inspect-fill",
        gen: target.gen,
        id: target.id,
        value,
      });
      return raw === undefined ? { alive: false } : parseFillTarget(raw);
    } catch {
      return { alive: false };
    }
  },

  /**
   * Sets the field of a target from an agent's `vimma_elements` to `value` (docs/specs/
   * mcp-forms.md F12; security.md M27), once the child has seen it is still what the user was
   * asked about and not sensitive. The child answers before it sets the field, so a dialog the
   * page opens never holds the reply; `agentFillOutcome` says how it went.
   * @param {HintTarget} target
   * @param {{ value: string | boolean, expect: { field: string, type: string | null },
   *   until: number }} asked  `until`: ms since the epoch; the child sets nothing later
   * @returns {Promise<"ok" | "gone" | "changed">}
   */
  async agentFill(target, { value, expect, until }) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "fill",
        gen: target.gen,
        id: target.id,
        value,
        expect,
        until,
      });
      return reply === "ok" || reply === "changed" ? reply : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * How the agent's last fill of `target`'s field went (docs/specs/mcp-forms.md F12): still to
   * run, the field kept its value, the page put it back, or it was skipped because the field
   * changed. A frame that went away is `gone`.
   * @param {HintTarget} target
   * @returns {Promise<"pending" | "kept" | "reset" | "skipped" | "gone">}
   */
  async agentFillOutcome(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "fill-outcome",
        gen: target.gen,
        id: target.id,
      });
      return ["pending", "kept", "reset", "skipped"].includes(reply) ? reply : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * Submits the form of `target`'s field with its default button (docs/specs/mcp-forms.md F15;
   * security.md M28), once the child has seen that it still goes to the method and destination
   * the question named; the child answers before it submits.
   * @param {HintTarget} target
   * @param {{ submit: { method: string, action: string }, until: number }} asked
   * @returns {Promise<"ok" | "gone" | "changed">}
   */
  async agentSubmit(target, { submit, until }) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "submit",
        gen: target.gen,
        id: target.id,
        submit,
        until,
      });
      return reply === "ok" || reply === "changed" ? reply : "gone";
    } catch {
      return "gone";
    }
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
   * Loads a link target's href in `browser` itself, as the page would load it: the page's
   * principal triggers the load and no event fires on the link, so no page handler runs (an
   * agent's follow, docs/specs/mcp-drive.md D12). It sends no referrer: the child does not
   * report the page's referrer policy or the link's `rel`, and none is the strictest of them.
   * The caller checked the scheme, the document and checkLoadURIWithPrincipal.
   * @param {any} browser XULBrowserElement
   * @param {HintTarget} target
   * @param {any} uri nsIURI of the target's href
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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Child side of the Vimma actor (spec: docs/specs/m1-actor-insert-scroll.md). One per frame,
// including out-of-process iframes: reports focus changes in its own document as an
// EditableDescriptor (vimma-core editable.mjs) and runs scroll, blur and focus-input commands.

import { INSERT_EDIT_COMMANDS, isEditable } from "../core/editable.mjs";
import { inputIndex } from "../core/pageurl.mjs";
import { collectTargets, linkText } from "./hint-collect.mjs";
import { Caret, isCaretMessage } from "./caret.mjs";
import { BlockFocus } from "./block.mjs";
import { GREP_CAPS, parseQuery, previewLines } from "../core/grep.mjs";
import { textOfDocument } from "./text-model.mjs";
import { GrepMatcher } from "./grep-matcher.mjs";

/** @import { EditableDescriptor } from "../core/editable.mjs" */
/** @import { ScrollKind } from "./VimmaActors.sys.mjs" */

/** j/k/h/l step in CSS pixels (Vimium's scrollStepSize). */
const STEP = 60;

/** Focus on these moves into another document, whose own child reports. */
const FRAMES = new Set(["iframe", "frame", "browser"]);

/** Candidates for `i`; isEditable decides. */
const TEXT_FIELDS = "input, textarea, [contenteditable]";

/**
 * The focused element, through open and closed shadow roots.
 * @param {Document} doc
 * @returns {Element | null}
 */
function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el?.openOrClosedShadowRoot?.activeElement) el = el.openOrClosedShadowRoot.activeElement;
  return el;
}

/**
 * @param {Element} el
 * @returns {EditableDescriptor}
 */
function describe(el) {
  const doc = el.ownerDocument;
  /** @type {EditableDescriptor} */
  const d = {
    tagName: el.localName,
    disabled: el.matches(":disabled"),
    role: el.getAttribute("role"),
    ariaReadOnly: el.getAttribute("aria-readonly") === "true",
    ariaDisabled: !!el.closest('[aria-disabled="true"]'),
    designMode: doc.designMode === "on",
    classes: [...el.classList],
  };
  const html = /** @type {HTMLInputElement} */ (el);
  if (el.localName === "input") d.type = html.type;
  if (el.localName === "input" || el.localName === "textarea") d.readOnly = html.readOnly;
  if (typeof html.isContentEditable === "boolean") d.isContentEditable = html.isContentEditable;
  return d;
}

/** Overflow values that lock an axis: a site's modal sets one on <html> or <body>. */
const LOCKED = new Set(["hidden", "clip"]);

/**
 * @param {Element} el
 * @param {boolean} vertical
 */
function overflowOf(el, vertical) {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return (vertical ? style?.overflowY : style?.overflowX) ?? "visible";
}

/**
 * Whether the page itself is scroll-locked on this axis. <body>'s overflow applies to the
 * viewport only while <html>'s is `visible` (CSS Overflow 3, § 3.3).
 * @param {Document} doc
 * @param {boolean} vertical
 */
function documentLocked(doc, vertical) {
  const html = doc.documentElement;
  const root = html ? overflowOf(html, vertical) : "visible";
  if (LOCKED.has(root)) return true;
  return root === "visible" && !!doc.body && LOCKED.has(overflowOf(doc.body, vertical));
}

/**
 * @param {Element} el
 * @param {boolean} vertical
 */
function canScroll(el, vertical) {
  const max = vertical ? el.scrollTopMax : el.scrollLeftMax;
  if (!(max > 0)) return false;
  const doc = el.ownerDocument;
  if (el === doc.scrollingElement) return !documentLocked(doc, vertical);
  const overflow = overflowOf(el, vertical);
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/** At most this many elements are searched for the largest scrollable. */
const SEARCH_LIMIT = 10000;
/** A search that found nothing is not repeated for this long (holding j). */
const SEARCH_BACKOFF_MS = 1000;

/**
 * The parent element, stepping out of a shadow root to its host.
 * @param {Element} el
 * @returns {Element | null}
 */
function parentOf(el) {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return "host" in root ? /** @type {ShadowRoot} */ (root).host : null;
}

/** A find text no page contains (a noncharacter): resets the find buffer without moving. */
const NO_MATCH = "\uffff";
/** nsITypeAheadFind.FIND_INITIAL: a new search, as typing in the find bar starts. */
const FIND_INITIAL = 0;

/**
 * Whether the selection is a range at least partly inside the viewport.
 * @param {Selection} sel
 * @param {Window} win
 */
function selectionOnScreen(sel, win) {
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return r.bottom > 0 && r.top < win.innerHeight;
}

/** nsISelectionController.SELECTION_NORMAL */
const SELECTION_NORMAL = 1;

/** nsISelectionController values for live grep's jump (docs/specs/live-grep.md decision 7). */
const DISPLAY_ATTENTION = 4;
const WHOLE_SELECTION = 2;
const SCROLL_SYNCHRONOUS = 1 << 1;
const SCROLL_VERTICAL_CENTER = 1 << 5;
/** The longest query a frame accepts (the parent sends none longer). */
const GREP_QUERY_MAX = GREP_CAPS.query;
/** Text with something to find: a blank frame is answered without the worker. */
const NOT_BLANK = /\S/;

/** nsISelectionListener reasons (spec m1-copy-mode, mouse selection). */
const MOUSEUP_REASON = 4;
const JS_REASON = 256;

/**
 * @param {unknown} n
 * @returns {n is number}
 */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

export class VimmaChild extends JSWindowActorChild {
  /** @type {WeakRef<Element> | null} the last largest scrollable, reused while it can scroll */
  #largest = null;
  /** The last hint collection (m1-hints): its generation and its elements, by target id. */
  #hints = { gen: -1, els: /** @type {WeakRef<Element>[]} */ ([]) };
  /** When a search for the largest scrollable last found nothing (0: not since focus moved). */
  #emptySearchAt = 0;
  /** Copy mode in this document (m1-copy-mode). */
  #caret = new Caret();
  /** Element focus in this document (docs/specs/element-focus.md). */
  #block = new BlockFocus();
  /**
   * Live grep (docs/specs/live-grep.md decision 14): this document's text model while the
   * picker is open, marked stale by any change to the document until the next query rebuilds it.
   * @type {{ model: ReturnType<typeof textOfDocument>, stale: boolean,
   *   observer: MutationObserver | null }}
   */
  #grep = { model: null, stale: true, observer: null };
  /** This frame's key in the process's matcher, and the newest search generation it saw. */
  #matcher = { key: GrepMatcher.newKey(), gen: -1 };
  /** The document's selection while a listener for mouse selections is on it. */
  /** @type {Selection | null} */
  #watched = null;
  /** A drag and drop started since the last mousedown: its end is no selection gesture. */
  #dragging = false;
  /** @type {WeakRef<Element> | null} the text field that last took focus here, for `i` */
  #lastField = null;
  /** This actor is focusing an element (`i`, a hint): the focus is the user's, not the find's. */
  #focusing = false;
  /**
   * The generation of the last Vimma:Blur (Esc) this document had, echoed in its focus reports
   * so that the parent can tell a report sent before that blur (docs/specs/insert-focus.md).
   */
  #blurGen = 0;
  /** @type {WeakRef<HTMLInputElement> | null} the text field a find focused and we blurred */
  #findMatchField = null;
  /**
   * @type {WeakRef<Element> | null} the text field whose focus the current find step gave back
   * (#442): the finder still names it as its match, but it focuses it only once per step, so a
   * later focus there (the page's script) is not the find's. Vimma:FindStep starts a step.
   */
  #findGaveBack = null;
  /** Tells the parent about a selection the user made with the mouse (spec m1-copy-mode). */
  #selectionListener = {
    QueryInterface: ChromeUtils.generateQI(["nsISelectionListener"]),
    /**
     * @param {Document} _doc
     * @param {Selection} sel
     * @param {number} reason
     */
    notifySelectionChanged: (_doc, sel, reason) => {
      // Firefox ends every mouse selection (drag, double and triple click, shift+click) with a
      // MOUSEUP_REASON notification (nsFrameSelection::SetDragState); a script's has JS_REASON.
      if (!(reason & MOUSEUP_REASON) || reason & JS_REASON) return;
      if (this.#dragging) {
        this.#dragging = false;
        return;
      }
      if (sel.isCollapsed || this.#inEditable()) return;
      this.sendAsyncMessage("Vimma:MouseSelection");
    },
  };

  actorCreated() {
    this.#watchSelection();
  }

  didDestroy() {
    this.#grepEnd();
    this.#block.destroy();
    try {
      this.#watched?.removeSelectionListener(this.#selectionListener);
    } catch {
      // the document is gone with its selection
    }
    this.#watched = null;
  }

  /** Listens to this document's selection (again, if the PresShell replaced it). */
  #watchSelection() {
    const sel = this.contentWindow?.getSelection() ?? null;
    if (!sel || sel === this.#watched) return;
    try {
      this.#watched?.removeSelectionListener(this.#selectionListener);
    } catch {
      // the old selection went away with its PresShell
    }
    sel.addSelectionListener(this.#selectionListener);
    this.#watched = sel;
  }

  /** Whether the focus is in something editable, whose selection is insert mode's. */
  #inEditable() {
    const doc = this.document;
    if (doc.designMode === "on") return true;
    const el = deepActiveElement(doc);
    return !!el && el !== doc.body && isEditable(describe(el)).editable;
  }

  /** @param {Event} event */
  handleEvent(event) {
    const doc = this.document;
    switch (event.type) {
      case "focusin": {
        this.#emptySearchAt = 0;
        // Unretargeted: the element itself, also inside an open or closed shadow root.
        const target = /** @type {Element | null} */ (event.originalTarget);
        if (target && this.#focusedByFind(target)) {
          this.#unfocusFindMatch(/** @type {HTMLInputElement} */ (target));
          return;
        }
        const el = target?.nodeType === 1 ? target : deepActiveElement(doc);
        if (el && !FRAMES.has(el.localName) && isEditable(describe(el)).editable) {
          this.#lastField = new WeakRef(el);
        }
        this.#report(el, "focusin");
        return;
      }
      case "focusout":
        // Focus moving to another element of this document reports its own focusin; checking
        // in between would flicker insert → normal → insert.
        if (/** @type {FocusEvent} */ (event).relatedTarget) return;
        this.#recheck();
        return;
      case "focus": {
        // The window gained focus (a click into this frame, back from a subframe or another
        // tab): the user is back on its focused element, which counts as a focusin. An editable
        // document root (designMode, contenteditable <body>) gets only this event.
        if (event.originalTarget !== this.contentWindow) return;
        this.#emptySearchAt = 0;
        this.#report(deepActiveElement(doc) ?? doc.body, "focusin");
        return;
      }
      case "mousedown": {
        this.#dragging = false;
        this.#watchSelection();
        // A click into an editable root whose window already has focus, or into a field that
        // already has focus (the page put it back after Esc), fires no focus event.
        const el = this.#editableRoot() ?? this.#focusedFieldUnder(event.originalTarget);
        if (el) this.#report(el, "focusin");
        // Any other click is the user's too, though it may move no focus (a toolbar item that
        // prevents its mousedown): what the page focuses after it is not the page's own doing.
        else if (event.isTrusted) this.sendAsyncMessage("Vimma:Click");
        return;
      }
      case "dragstart":
        this.#dragging = true;
    }
  }

  /**
   * Whether Firefox's finder focused `el`, a text field its match is in (#164): when the find
   * bar closes on it (Finder.focusContent) or `n` reaches it while the page has focus
   * (nsTypeAheadFind focuses the field itself). No user input is being handled then, and the
   * finder's last match is in this very field.
   * @param {Element} el
   */
  #focusedByFind(el) {
    if (this.#focusing || this.contentWindow?.windowUtils.isHandlingUserInput) return false;
    return this.#foundEditable() === el && this.#findGaveBack?.deref() !== el;
  }

  /** The text field the finder's last match is in, if this frame has searched. */
  #foundEditable() {
    try {
      // Only a frame that has searched has a Finder; reading it must not create one.
      const finder = /** @type {any} */ (this.manager.getActor("Finder"))._finder;
      return finder?._fastFind?.foundEditable ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Gives back the focus a find put into a text field, and keeps its match highlighted: the
   * tab stays in normal mode, `n` and `N` go on from the match (the finder starts from the
   * field's selection), and no key types into the field.
   * @param {HTMLInputElement} el
   */
  #unfocusFindMatch(el) {
    // Where the find bar's close focuses the field, it then collapses the field's selection
    // (Finder.focusContent): the match is the selection now, before that.
    const { selectionStart: start, selectionEnd: end } = el;
    // After the finder is done: `n` focuses the field in the middle of its search.
    Services.tm.dispatchToMainThread(() => {
      if (!el.isConnected || deepActiveElement(this.document) !== el) return;
      if (el.selectionStart === el.selectionEnd && start !== null && end !== null && start < end) {
        el.setSelectionRange(start, end);
      }
      el.blur();
      // Only from the blur on: until then the step's focus can still reach the field again (the
      // close's Finder.focusContent, and the window's activation when the page gets focus back).
      this.#findGaveBack = new WeakRef(el);
      this.#findMatchField = new WeakRef(el);
      this.#showFindMatch(el);
    });
  }

  /**
   * Draws the match in a blurred text field the way the finder draws one: blurring hides the
   * field's selection, and the finder shows its match as ATTENTION.
   * @param {HTMLInputElement} el
   */
  #showFindMatch(el) {
    const controller = /** @type {any} */ (el).editor?.selectionController;
    controller?.setDisplaySelection(Ci.nsISelectionController.SELECTION_ATTENTION);
    controller?.repaintSelection(Ci.nsISelectionController.SELECTION_NORMAL);
  }

  /**
   * The find bar closed on a match (sent after its close, so after the finder's
   * Finder:FindbarClose). That message's enableSelection sets the match's field back to
   * SELECTION_ON, and it can reach this process after #unfocusFindMatch blurred the field: the
   * two Finder messages are separate IPC messages, and the blur runs in between when the second
   * comes late. Shows the match as the find's again.
   */
  #findClosed() {
    const el = this.#findMatchField?.deref();
    this.#findMatchField = null;
    // Still focused: the blur is yet to run, and shows the match itself.
    if (!el?.isConnected || deepActiveElement(this.document) === el) return;
    if (this.#foundEditable() === el) this.#showFindMatch(el);
  }

  /**
   * Focuses `el` for the user: a find's match in it does not stop its focusin report.
   * @param {HTMLElement} el
   */
  #focus(el) {
    this.#focusing = true;
    try {
      el.focus();
    } finally {
      this.#focusing = false;
    }
  }

  /**
   * The focused document root when it is editable as a whole (designMode, or a contenteditable
   * <body>/<html>), else null.
   * @returns {Element | null}
   */
  #editableRoot() {
    const doc = this.document;
    const el = deepActiveElement(doc) ?? doc.body;
    if (!el || (el !== doc.body && el !== doc.documentElement)) return null;
    const editable = doc.designMode === "on" || /** @type {HTMLElement} */ (el).isContentEditable;
    return editable ? el : null;
  }

  /**
   * The focused element, if it is editable and `target` is in it.
   * @param {EventTarget | null} target
   * @returns {Element | null}
   */
  #focusedFieldUnder(target) {
    const el = deepActiveElement(this.document);
    if (!el || el === this.document.body || !isEditable(describe(el)).editable) return null;
    // The flattened tree: a click in a text field lands in its anonymous editor, which
    // contains() does not see, and in a shadow root, which it does not cross.
    for (let n = /** @type {any} */ (target); n; n = n.flattenedTreeParentNode) {
      if (n === el) return el;
    }
    return null;
  }

  #recheck() {
    // A document that lost focus does not speak for the tab: the one that gained it does.
    if (!this.document.hasFocus()) return;
    this.#report(deepActiveElement(this.document) ?? this.document.body, "recheck");
  }

  /**
   * @param {Element | null} el
   * @param {"focusin" | "recheck"} trigger
   */
  #report(el, trigger) {
    if (!el || FRAMES.has(el.localName)) return;
    // `user`: the focus came from the user's input in this page (a click, Tab, a key the page
    // answered) or from this actor for a Vimma key (`i`, a hint), not from the page's script on
    // its own; after Esc only such a focus enters insert (docs/specs/insert-focus.md).
    const user = this.#focusing || !!this.contentWindow?.windowUtils.isHandlingUserInput;
    this.sendAsyncMessage("Vimma:Focus", {
      descriptor: describe(el),
      trigger,
      user,
      gen: this.#blurGen,
    });
  }

  /** @param {{ name: string, data: any }} msg */
  receiveMessage(msg) {
    switch (msg.name) {
      case "Vimma:Scroll":
        return this.#scroll(msg.data.kind, msg.data.count, msg.data.instant === true);
      case "Vimma:ScrollFraction": {
        // Where an agent tab is scrolled to (docs/specs/mcp-drive.md D16): the element `j`
        // scrolls, as a fraction of how far it can go.
        const el = this.#scrollTarget(true);
        if (!el) return 0;
        const max = el.scrollHeight - el.clientHeight;
        return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
      }
      case "Vimma:Blur": {
        if (isIndex(msg.data?.gen)) this.#blurGen = msg.data.gen;
        const el = deepActiveElement(this.document);
        if (el && el !== this.document.body) /** @type {HTMLElement} */ (el).blur();
        return undefined;
      }
      case "Vimma:FocusInput":
        return this.#focusInput(msg.data?.count);
      case "Vimma:FocusLast":
        return this.#focusLast();
      case "Vimma:Edit": {
        // ctrl+w, ctrl+u, ctrl+h after the page left them alone (key-handling-batch § 2): the
        // editor's own command on the focused text field, so undo works.
        const command = msg.data?.command;
        if (!INSERT_EDIT_COMMANDS.includes(command)) return undefined;
        if (this.document.hasFocus() && this.#inEditable()) this.docShell?.doCommand(command);
        return undefined;
      }
      case "Vimma:ScrollPosition": {
        const win = this.contentWindow;
        return win ? { x: win.scrollX, y: win.scrollY } : null;
      }
      case "Vimma:FindAnchor":
        return this.#findAnchor();
      case "Vimma:FindClosed":
        return this.#findClosed();
      case "Vimma:FindStep":
        this.#findGaveBack = null;
        return undefined;
      case "Vimma:Selection": {
        // An agent's read (docs/specs/vimma-mcp.md, decision 4): the page's selected text, if
        // any, cut at `max` characters; a copy, nothing in the page changes.
        const max = Math.max(0, Math.min(Number(msg.data?.max) || 0, 500000));
        const text = this.contentWindow?.getSelection()?.toString() ?? "";
        // By code point: a cut through a surrogate pair would leave half a character.
        return text ? [...text].slice(0, max).join("") : null;
      }
      case "Vimma:ScrollTo": {
        const x = Number(msg.data?.x);
        const y = Number(msg.data?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this.contentWindow?.scrollTo({ left: x, top: y, behavior: "instant" });
        }
        return undefined;
      }
      case "Vimma:Grep":
        return this.#grepSearch(msg.data);
      case "Vimma:GrepPreview":
        return this.#grepPreview(msg.data);
      case "Vimma:GrepJump":
        return this.#grepJump(msg.data);
      case "Vimma:GrepEnd":
        this.#grepEnd();
        return undefined;
      case "Vimma:CollectHints":
        return this.#collectHints(msg.data);
      case "Vimma:ActivateHint":
        return this.#activateHint(msg.data);
      case "Vimma:Caret": {
        // Only the frame with focus has the user's caret (the parent sends to that one).
        const win = this.contentWindow;
        if (!isCaretMessage(msg.data) || !win || !this.document.hasFocus()) return false;
        return this.#caret.run(win, this.#selCon(), msg.data);
      }
      case "Vimma:Block": {
        // Element focus (docs/specs/element-focus.md): the parent sends to the frame whose
        // block a label chose, and to the frames around it, which only report their scrolls.
        const win = this.contentWindow;
        if (!win) return null;
        return this.#block.run(win, msg.data, {
          take: (gen, id) => {
            if (gen !== this.#hints.gen) return null;
            const el = this.#hints.els[id]?.deref() ?? null;
            this.#hints = { gen: -1, els: [] };
            return el;
          },
          // `v` on a block: copy mode starts with the block selected, as with a mouse selection.
          enterCopyMode: (line) => {
            const selCon = this.#selCon();
            if (this.#caret.run(win, selCon, { op: "enter" }) !== true) return false;
            if (line) this.#caret.run(win, selCon, { op: "line" });
            return true;
          },
          send: (name, data) => this.sendAsyncMessage(name, data),
        });
      }
    }
    return undefined;
  }

  /** The frame's nsISelectionController, got as ViewSourcePageChild gets it. */
  #selCon() {
    return this.docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsISelectionDisplay)
      .QueryInterface(Ci.nsISelectionController);
  }

  /**
   * Where a find starts (spec m1-find): Vim searches from the cursor, so a selection or caret
   * still on screen stays where it is; otherwise the caret goes to the top of the viewport (left
   * alone when an element has focus: Firefox starts there; and in pdf.js, which finds itself).
   * Then the find's typed-text buffer is reset with a search that cannot match: nsITypeAheadFind
   * starts its first search at the first rendered match from the document start (its viewport
   * clip is ignored), and a search that extends the previous text continues from the previous
   * search's start; a non-empty, unrelated buffer makes it start at the caret.
   */
  #findAnchor() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || doc.contentType === "application/pdf") return;
    const sel = win.getSelection();
    const active = deepActiveElement(doc);
    const focused = active && active !== doc.body && active !== doc.documentElement;
    if (sel && !focused && !selectionOnScreen(sel, win)) {
      try {
        const pos = win.scrollY || win.scrollX ? doc.caretPositionFromPoint(1, 1) : null;
        if (pos?.offsetNode) sel.collapse(pos.offsetNode, pos.offset);
        else sel.removeAllRanges();
      } catch {
        // a position that cannot hold the caret (inside a text control): leave the selection
      }
    }
    try {
      // FinderChild's Finder (toolkit/actors/FinderChild.sys.mjs) owns this frame's
      // nsITypeAheadFind; Firefox has no API to start a find at a point.
      const typeahead = this.manager.getActor("Finder")?.finder?._fastFind;
      typeahead?.find(NO_MATCH, false, FIND_INITIAL, true);
    } catch (e) {
      console.error("vimma: find start", e);
    }
  }

  /**
   * The hint targets of this frame (m1-hints). Rects are in this frame's CSS pixels; the parent
   * offsets them by the frame rects the embedding frame's child reports. An agent's collection
   * (`texts`, docs/specs/mcp-drive.md D12) gets each link's text too.
   * @param {{ gen: number, linksOnly: boolean, blocks?: boolean, texts?: boolean }} data
   */
  #collectHints(data) {
    const gen = data?.gen;
    const win = this.contentWindow;
    if (!isIndex(gen) || !win) return null;
    const t0 = ChromeUtils.now();
    const { targets, frames } = collectTargets(win, {
      linksOnly: data.linksOnly === true,
      blocks: data.blocks === true,
    });
    this.#hints = { gen, els: targets.map((t) => new WeakRef(t.el)) };
    const texts = data.texts === true;
    return {
      targets: targets.map((t, id) => ({
        id,
        rect: t.rect,
        kind: t.kind,
        href: t.href,
        text: texts ? linkText(t.el) : undefined,
        blockKind: t.blockKind,
        box: t.box,
      })),
      frames: frames.map((f) => ({ id: f.bc.id, rect: f.rect })),
      ms: ChromeUtils.now() - t0,
    };
  }

  /**
   * Follows a target of the last collection: a text field gets focus (its focusin report enters
   * insert), anything else a click.
   * @param {{ gen: number, id: number }} data
   */
  #activateHint(data) {
    if (!isIndex(data?.gen) || !isIndex(data?.id) || data.gen !== this.#hints.gen) return false;
    const el = this.#hints.els[data.id]?.deref();
    this.#hints = { gen: -1, els: [] };
    if (!el?.isConnected) return false;
    const html = /** @type {HTMLElement} */ (el);
    if (el.localName !== "a" && isEditable(describe(el)).editable) {
      this.#focus(html);
      return true;
    }
    if (el.localName === "select") {
      html.focus();
      try {
        /** @type {HTMLSelectElement} */ (el).showPicker();
      } catch {
        // Without user activation it throws; the select keeps focus and Alt+Down opens it.
      }
      return true;
    }
    // Events created by privileged code are trusted: mousedown and mouseup for pages that act
    // on them (menus, Google's jsaction), then click(), whose activation behaviour follows links.
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: this.contentWindow,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
    };
    const win = /** @type {any} */ (this.contentWindow);
    for (const type of ["mouseover", "mousedown", "mouseup"]) {
      const buttons = type === "mousedown" ? 1 : 0;
      el.dispatchEvent(new win.MouseEvent(type, { ...init, buttons }));
    }
    if (!el.isConnected) return true;
    // SVG elements have no click(): dispatch the click event for them.
    if (typeof html.click === "function") html.click();
    else el.dispatchEvent(new win.MouseEvent("click", init));
    return true;
  }

  /** The text model, rebuilt when the document changed since it was built. */
  #grepModel() {
    const win = this.contentWindow;
    if (!win) return null;
    if (this.#grep.model && !this.#grep.stale) return this.#grep.model;
    if (!this.#grep.observer) {
      const observer = new /** @type {any} */ (win).MutationObserver(() => {
        this.#grep.stale = true;
      });
      observer.observe(this.document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      this.#grep.observer = observer;
    }
    this.#grep.model = textOfDocument(win, GREP_CAPS.modelChars);
    this.#grep.stale = false;
    return this.#grep.model;
  }

  /** Drops the text model when the picker closes: no page text outlives the search. */
  #grepEnd() {
    this.#grep.observer?.disconnect();
    this.#grep = { model: null, stale: true, observer: null };
    // The next search may come from another window, whose generations start again.
    this.#matcher.gen = -1;
    GrepMatcher.drop(this.#matcher.key);
  }

  /**
   * @param {unknown} query
   * @returns {query is string}
   */
  #isQuery(query) {
    return typeof query === "string" && query.length > 0 && query.length <= GREP_QUERY_MAX;
  }

  /**
   * Live grep's query against this document (docs/specs/live-grep.md): its matches with their
   * line of context. The parent checks the reply (core parseGrepReply).
   * @param {{ query: string, gen: number }} data
   */
  async #grepSearch(data) {
    if (!this.#isQuery(data?.query) || !isIndex(data.gen)) return null;
    // An older search that was queued behind a newer one is dropped unrun.
    if (data.gen < this.#matcher.gen) return null;
    this.#matcher.gen = data.gen;
    const parsed = parseQuery(data.query);
    const model = this.#grepModel();
    if (!parsed || !model) return { count: 0, matches: [] };
    if (!NOT_BLANK.test(model.text)) return { count: 0, matches: [], cut: model.cut };
    const result = await GrepMatcher.match(this.#matcher.key, model, data.query, false);
    if (result === "timeout") return { count: 0, matches: [], timedOut: true, cut: model.cut };
    if (!result) return null;
    return { ...result, cut: model.cut };
  }

  /**
   * The lines around a match of the last search, for the preview (decision 6).
   * @param {{ start: number, end: number }} data
   */
  #grepPreview(data) {
    const model = this.#grep.model ?? this.#grepModel();
    if (!model || !isIndex(data?.start) || !isIndex(data?.end)) return null;
    const { start, end } = data;
    if (end < start || end > model.text.length) return null;
    return previewLines(model.text, start, end);
  }

  /**
   * Selects a match and scrolls it to the middle as find does (decision 7). When the document
   * changed since the search, the query runs again and the match with the same ordinal and
   * text is taken, else the nearest one with the same text.
   * @param {{ query: string, start: number, end: number, ordinal: number, text: string }} data
   * @returns {Promise<boolean>} whether a match is selected
   */
  async #grepJump(data) {
    const win = this.contentWindow;
    if (!win || !this.#isQuery(data?.query) || typeof data.text !== "string") return false;
    if (!isIndex(data.start) || !isIndex(data.end) || !isIndex(data.ordinal)) return false;
    const parsed = parseQuery(data.query);
    if (!parsed) return false;
    const fresh = !!this.#grep.model && !this.#grep.stale;
    const model = this.#grepModel();
    if (!model) return false;
    let { start, end } = data;
    if (!fresh || model.text.slice(start, end) !== data.text) {
      const result = await GrepMatcher.match(this.#matcher.key, model, data.query, true);
      if (!result || result === "timeout") return false;
      /** @type {{ start: number, end: number, ordinal: number }[]} */
      const all = result.matches.filter(
        (/** @type {{ start: number, end: number }} */ m) =>
          model.text.slice(m.start, m.end) === data.text,
      );
      const same = all.find((m) => m.ordinal === data.ordinal);
      const near = all.reduce(
        (best, m) =>
          !best || Math.abs(m.ordinal - data.ordinal) < Math.abs(best.ordinal - data.ordinal)
            ? m
            : best,
        /** @type {(typeof all)[number] | null} */ (null),
      );
      const pick = same ?? near;
      if (!pick) return false;
      ({ start, end } = pick);
    }
    const a = model.pointAt(start);
    const b = model.pointAt(end, true);
    if (!a || !b) return false;
    const doc = this.document;
    const range = doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    // Normal mode after the jump: a focused text field would keep the tab in insert.
    const active = deepActiveElement(doc);
    if (active && active !== doc.body && isEditable(describe(active)).editable) {
      /** @type {HTMLElement} */ (active).blur();
    }
    if (this.browsingContext.parent) win.focus();
    const sel = win.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    const selCon = this.docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsISelectionDisplay)
      .QueryInterface(Ci.nsISelectionController);
    selCon.setDisplaySelection(DISPLAY_ATTENTION);
    selCon.repaintSelection(SELECTION_NORMAL);
    // After the next frame: a tab just selected gets its viewport's size first.
    await new Promise((resolve) => {
      const timer = win.setTimeout(resolve, 100);
      win.requestAnimationFrame(() => {
        win.clearTimeout(timer);
        resolve(undefined);
      });
    });
    if (!sel.rangeCount) return false;
    selCon.scrollSelectionIntoView(
      SELECTION_NORMAL,
      WHOLE_SELECTION,
      SCROLL_VERTICAL_CENTER | SCROLL_SYNCHRONOUS,
    );
    return true;
  }

  /**
   * Focuses the text field that last took focus in this document, if it is still in it, visible
   * and editable (`i`, docs/specs/insert-focus.md).
   * @returns {boolean} whether it took focus
   */
  #focusLast() {
    const el = /** @type {HTMLElement | undefined} */ (this.#lastField?.deref());
    if (!el?.isConnected || el.ownerDocument !== this.document) return false;
    if (!isEditable(describe(el)).editable || !el.checkVisibility({ visibilityProperty: true })) {
      return false;
    }
    this.#focus(el);
    return deepActiveElement(this.document) === el;
  }

  /**
   * Focuses the visible text field a count picks (`i`, `gi`: the first; `3gi`: the third,
   * clamped to the last), in document order.
   * @param {number} [count]
   * @returns {boolean} whether one took focus
   */
  #focusInput(count) {
    const fields = [...this.document.querySelectorAll(TEXT_FIELDS)].filter(
      (el) =>
        el.localName !== "select" &&
        isEditable(describe(el)).editable &&
        el.checkVisibility({ visibilityProperty: true }),
    );
    const el = /** @type {HTMLElement | undefined} */ (
      fields[inputIndex(Number(count) || undefined, fields.length)]
    );
    if (el) this.#focus(el);
    return !!el;
  }

  /**
   * @param {boolean} vertical
   * @returns {Element | null}
   */
  #scrollTarget(vertical) {
    const doc = this.document;
    const root = doc.scrollingElement;
    for (let el = deepActiveElement(doc); el && el !== root && el !== doc.body;) {
      if (canScroll(el, vertical)) return el;
      el = parentOf(el);
    }
    if (root && canScroll(root, vertical)) return root;
    // App shells, pdf.js and a locked page's modal scroll an inner element: take the largest
    // visible one. Cached; a search is bounded, and one that found nothing is not repeated
    // until focus moves or a second has passed.
    const last = this.#largest?.deref();
    if (last?.isConnected && canScroll(last, vertical)) return last;
    const now = Date.now();
    if (this.#emptySearchAt && now - this.#emptySearchAt < SEARCH_BACKOFF_MS) return null;
    let best = null;
    let area = 0;
    const all = doc.getElementsByTagName("*");
    for (let i = 0; i < Math.min(all.length, SEARCH_LIMIT); i++) {
      const el = /** @type {Element} */ (all[i]);
      if (!canScroll(el, vertical)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area) [best, area] = [el, r.width * r.height];
    }
    this.#largest = best ? new WeakRef(best) : null;
    this.#emptySearchAt = best ? 0 : now;
    return best;
  }

  /**
   * @param {ScrollKind} kind
   * @param {number} count
   * @param {boolean} [instant]  no smooth scroll: an agent's tab in the background, whose
   *   refresh driver is throttled (docs/specs/mcp-drive.md D8)
   * @returns {boolean} whether this frame had something to scroll
   */
  #scroll(kind, count, instant = false) {
    const vertical = kind !== "left" && kind !== "right";
    const el = this.#scrollTarget(vertical);
    if (!el) return false;
    const behavior =
      !instant && Services.prefs.getBoolPref("general.smoothScroll", true) ? "smooth" : "instant";
    const n = Math.max(1, Number(count) || 1);
    // Whole pixels, so d then u returns to the same place.
    const half = Math.round(el.clientHeight / 2) * n;
    /** @type {Record<ScrollKind, () => void>} */
    const run = {
      down: () => el.scrollBy({ top: STEP * n, behavior }),
      up: () => el.scrollBy({ top: -STEP * n, behavior }),
      right: () => el.scrollBy({ left: STEP * n, behavior }),
      left: () => el.scrollBy({ left: -STEP * n, behavior }),
      half_down: () => el.scrollBy({ top: half, behavior }),
      half_up: () => el.scrollBy({ top: -half, behavior }),
      top: () => el.scrollTo({ top: 0, behavior }),
      bottom: () => el.scrollTo({ top: el.scrollHeight, behavior }),
    };
    run[kind]();
    return true;
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Child side of the Vimma actor (spec: docs/specs/m1-actor-insert-scroll.md). One per frame,
// including out-of-process iframes: reports focus changes in its own document as an
// EditableDescriptor (vimma-core editable.mjs) and runs blur and focus-input commands; scroll
// commands go to its PageScroll (page-scroll.mjs), live grep's to its GrepPage (grep-page.mjs),
// an agent's clicks, fills and reads to its AgentPage (agent-page.mjs).

import { INSERT_EDIT_COMMANDS, isEditable } from "../core/editable.mjs";
import { inputIndex } from "../core/pageurl.mjs";
import { suggestionListOpen } from "../core/suggestions.mjs";
import { HINT_SIZE_WAIT_MS } from "../core/hints.mjs";
import { collectTargets, linkText, viewportSize } from "./hint-collect.mjs";
import { describeAgentElements } from "./agent-fields.mjs";
import { Caret, isCaretMessage } from "./caret.mjs";
import { BlockFocus } from "./block.mjs";
import { PdfView } from "./pdf-view.mjs";
import { PageScroll } from "./page-scroll.mjs";
import { GrepPage } from "./grep-page.mjs";
import { AgentPage } from "./agent-page.mjs";
import { asUserGesture } from "./user-gesture.mjs";
import { dispatchAsPage } from "./page-events.mjs";

/** @import { EditableDescriptor } from "../core/editable.mjs" */

/**
 * A message the parent (host/VimmaParent.sys.mjs) sends this child, by name, with its data as
 * the parent sends it. Each handler still checks what it reads, as before: the types say what
 * is sent, not what has been checked.
 * @typedef {{ name: "Vimma:Scroll", data: { kind: Parameters<PageScroll["scroll"]>[0],
 *     count: number, instant?: boolean, step?: unknown } }
 *   | { name: "Vimma:PdfTheme", data: { css?: unknown } | undefined }
 *   | { name: "Vimma:PdfOp", data: unknown }
 *   | { name: "Vimma:PdfLinkPage", data: { gen?: unknown, id?: unknown } | undefined }
 *   | { name: "Vimma:Blur", data: { gen?: unknown, keys?: unknown } | undefined }
 *   | { name: "Vimma:FocusInput", data: { count?: number } | undefined }
 *   | { name: "Vimma:Edit", data: { command: string } }
 *   | { name: "Vimma:Selection", data: { max?: unknown } | undefined }
 *   | { name: "Vimma:ScrollTo", data: Parameters<PageScroll["scrollTo"]>[0] }
 *   | { name: "Vimma:Grep", data: Parameters<GrepPage["search"]>[0] }
 *   | { name: "Vimma:GrepPreview", data: Parameters<GrepPage["preview"]>[0] }
 *   | { name: "Vimma:GrepJump", data: Parameters<GrepPage["jump"]>[0] }
 *   | { name: "Vimma:CollectHints", data: { gen: number, linksOnly: boolean, blocks?: boolean,
 *       texts?: boolean, elements?: boolean } }
 *   | { name: "Vimma:ActivateHint", data: { gen: number, id: number } }
 *   | { name: "Vimma:AgentElement", data: Parameters<AgentPage["element"]>[0] }
 *   | { name: "Vimma:AgentQuiet", data: Parameters<AgentPage["quiet"]>[0] }
 *   | { name: "Vimma:AgentConsole", data: Parameters<AgentPage["consoleEntries"]>[0] }
 *   | { name: "Vimma:Caret", data: unknown }
 *   | { name: "Vimma:Block", data: BlockMessage }
 *   | { name: "Vimma:PdfZoom" | "Vimma:PdfWhere" | "Vimma:ScrollFraction" | "Vimma:FocusLast"
 *       | "Vimma:SuggestionsOpen" | "Vimma:ScrollPosition" | "Vimma:FindAnchor"
 *       | "Vimma:FindClosed" | "Vimma:FindStep" | "Vimma:GrepEnd" | "Vimma:AgentCards"
 *       | "Vimma:AgentTotal" | "Vimma:AgentSensitiveShown", data?: unknown }} ChildMessage
 */
/** @import { BlockMessage } from "./block.mjs" */
/** @import { PdfOutlineMessage, PdfStateMessage } from "./pdf-view.mjs" */

const lazy = /** @type {Lazy<"setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
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

/** @param {Element} el  its first ARIA role token, lower case, or "" */
const roleOf = (el) => (el.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * A field as core suggestions.mjs reads it (docs/specs/page-suggestions.md decision 4): its
 * role, aria-expanded, and the elements its aria-controls and aria-owns name, looked up in its
 * own tree (a shadow root or the document).
 * @param {Element} el
 * @returns {import("../core/suggestions.mjs").FieldSnapshot}
 */
function fieldSnapshot(el) {
  const root = /** @type {Document | ShadowRoot} */ (el.getRootNode());
  const ids = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16);
  const popups = [];
  for (const id of ids) {
    const p = root.getElementById?.(id);
    if (!p) continue;
    popups.push({
      role: roleOf(p),
      rendered: p.getClientRects().length > 0,
      visible: p.checkVisibility({ visibilityProperty: true }),
      hasOption: !!p.querySelector('[role~="option"]'),
    });
  }
  return { role: roleOf(el), expanded: el.getAttribute("aria-expanded") ?? "", popups };
}

/**
 * The nearest ancestor with role="combobox" (the ARIA 1.1 wrapper), across shadow roots.
 * @param {Element} el
 * @returns {Element | null}
 */
function comboboxAncestor(el) {
  /** @type {Node | null} */
  let node = el.parentNode;
  while (node) {
    if (node.nodeType === 1 && roleOf(/** @type {Element} */ (node)) === "combobox") {
      return /** @type {Element} */ (node);
    }
    node = node.parentNode ?? /** @type {ShadowRoot} */ (node).host ?? null;
  }
  return null;
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

/** @param {EventTarget | null} t @returns {t is Node} */
const isNode = (t) => !!t && "nodeType" in t;

/** How often, in ms, a collection waiting for its page's first size looks again (#sized). */
const SIZE_POLL_MS = 25;

/** Whether the frame has been given a viewport size. @param {Window} win */
function hasSize(win) {
  const { vw, vh } = viewportSize(win);
  return vw > 0 && vh > 0;
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

/** nsISelectionListener reasons (spec m1-copy-mode, mouse selection). */
const MOUSEUP_REASON = 4;
const JS_REASON = 256;

/** How many keydowns a document remembers the focus of, for a late Vimma:Blur (#keys). */
const KEYS_KEPT = 16;

/**
 * @param {unknown} n
 * @returns {n is number}
 */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * Whether `el` is a link or inside one, through shadow roots to their hosts: a press on it
 * passes through the link, whose handling sets the window's link preview.
 * @param {Element} el
 */
function inLink(el) {
  /** @type {Element | null} */
  let n = el;
  while (n) {
    if (n.matches(":any-link")) return true;
    n = n.parentElement ?? /** @type {ShadowRoot | null} */ (n.parentNode)?.host ?? null;
  }
  return false;
}

export class VimmaChild extends JSWindowActorChild {
  /**
   * Test-only (browser_vimma_mcp_fill.js): the name of a page function an agent's form
   * submission calls just before its own check, so that a test can change the form in the one
   * moment a busy page could. Only chrome code in the content process can set it, and it is read
   * only in automation (`Cu.isInAutomation`), never in a release; null otherwise.
   * @type {string | null}
   */
  static _beforeSubmitCheckForTests = null;

  /**
   * Test-only (browser_vimma_mcp_follow.js): how many hint collections in this process wait for
   * their page's first size now (#sized), so that a test can act during the wait.
   */
  static _sizeWaitsForTests = 0;

  /**
   * Test-only (browser_vimma_mcp_follow.js): how often, in ms, a collection waiting for its
   * page's size looks again, instead of SIZE_POLL_MS, so that a test can order two collections.
   * Read only in automation (`Cu.isInAutomation`); null otherwise.
   * @type {number | null}
   */
  static _sizePollMsForTests = null;

  /** Scrolling in this frame (docs/specs/m1-actor-insert-scroll.md). */
  #scroll = new PageScroll(this, () => deepActiveElement(this.document));
  /** The last hint collection (m1-hints): its generation and its elements, by target id. */
  #hints = { gen: -1, els: /** @type {WeakRef<Element>[]} */ ([]) };
  /** The agent's page work in this frame (docs/specs/mcp-forms.md, mcp-checkpoints.md). */
  #agent = new AgentPage(this, {
    onPage: (el) => this.#onPage(el),
    press: (el, still) => this.#press(el, still, { agent: true }),
    beforeSubmitCheck: () => this.#beforeSubmitCheck(),
  });
  /** Copy mode in this document (m1-copy-mode). */
  #caret = new Caret();
  /** Element focus in this document (docs/specs/element-focus.md). */
  #block = new BlockFocus();
  /** @type {PdfView | null} the pdf.js viewer's adapter, in its top document only */
  #pdf = null;
  /**
   * How many `Vimma:PdfOp` messages this actor has received, whether or not they reached the
   * viewer: the state report carries it, so the parent knows which report came after an
   * operation it sent (`state.pdf`, #1006).
   */
  #pdfOps = 0;
  /** Live grep in this frame (docs/specs/live-grep.md): its text model and matcher key. */
  #grep = new GrepPage(this, {
    activeElement: () => deepActiveElement(this.document),
    editable: (el) => isEditable(describe(el)).editable,
    selCon: () => this.#selCon(),
  });
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
   * An agent's press is running (#press): the page's listeners for its trusted click() run as
   * "handling user input" (EventListenerManager::HandleEventInternal pushes it for every trusted
   * click), so a field they focus would read as the user's. It is the page's (issue #1325).
   */
  #agentPress = false;
  /**
   * The generation of the last Vimma:Blur (Esc) this document had, echoed in its focus reports
   * so that the parent can tell a report sent before that blur (docs/specs/insert-focus.md).
   */
  #blurGen = 0;
  /**
   * The trusted keydowns this document had since its last Vimma:Blur, and for the last
   * KEYS_KEPT of them, by their number in that count, the element that had focus when each
   * arrived. The content process handles input before other messages, so a key typed right
   * after Esc can reach the page before Esc's blur does; the blur then must not take the focus
   * that key gave (#850, insert-focus behaviour 8). No key itself is kept.
   * @type {{ count: number, focus: { n: number, el: WeakRef<Element> | null }[] }}
   */
  #keys = { count: 0, focus: [] };
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
    this.#pdf?.destroy();
    this.#pdf = null;
    this.#grep.end();
    this.#block.destroy();
    try {
      this.#watched?.removeSelectionListener(this.#selectionListener);
    } catch {
      // the document is gone with its selection
    }
    this.#watched = null;
  }

  /**
   * The adapter's state or outline message; its timer can fire while the document goes away.
   * @param {PdfStateMessage | PdfOutlineMessage} data
   * @param {string} [name]
   */
  #sendPdf(data, name = "Vimma:PdfState") {
    try {
      this.sendAsyncMessage(name, data);
    } catch {
      // the actor is being destroyed: the next document reports for itself
    }
  }

  /**
   * The theme's token sheet for the viewer (docs/specs/pdf-mode.md decision 20; security.md
   * section 20, V12): the parent answers only the top viewer's current actor.
   */
  #askTheme() {
    this.sendQuery("Vimma:PdfTheme").then(
      (css) => this.#pdf?.setTheme(css),
      () => {
        // the actor went with its document
      },
    );
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

  /**
   * Whether the focused field's suggestion list is open (docs/specs/page-suggestions.md): one
   * boolean, from the page's own attributes and Firefox's autocomplete popup for this frame.
   */
  #suggestionsOpen() {
    const doc = this.document;
    if (!doc?.hasFocus()) return false;
    const el = deepActiveElement(doc);
    let autocompletePopup = false;
    try {
      autocompletePopup = !!this.manager?.getActor("AutoComplete")?.popupOpen;
    } catch {
      // No AutoComplete actor in this frame (a system page): no Firefox popup.
    }
    if (!el || el === doc.body) {
      return suggestionListOpen({ focused: null, combobox: null, autocompletePopup });
    }
    const combo = comboboxAncestor(el);
    return suggestionListOpen({
      focused: fieldSnapshot(el),
      combobox: combo ? fieldSnapshot(combo) : null,
      autocompletePopup,
    });
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
    if (event.type === "pagehide") {
      // Registered for trusted events only; checked again, as a forged one could skip a step.
      if (event.isTrusted) this.#agent.pageHidden();
      return;
    }
    const doc = this.document;
    switch (event.type) {
      case "focusin": {
        this.#scroll.focusMoved();
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
      case "keydown": {
        if (!event.isTrusted) return;
        const el = deepActiveElement(doc);
        const keys = this.#keys;
        keys.focus.push({ n: keys.count++, el: el ? new WeakRef(el) : null });
        if (keys.focus.length > KEYS_KEPT) keys.focus.shift();
        return;
      }
      case "keypress": {
        // macOS only (VimmaActors registers it there alone). The parent marked this keypress:
        // it is a suggestion key's, sent here for the page to have first (VimmaHost,
        // _suggestionKeySent). The page has had the keydown by now; the focused field has not
        // had this keypress. While the field's suggestion list is open, the field does not get
        // it, so Cocoa's moveDown: or moveUp: moves no caret and the parent, whose reply then
        // comes back not prevented, presses the arrow key. With no list open the field keeps
        // its key; so it does when Firefox's own popup has only just opened, since this frame
        // hears of that in a message a key may overtake (AutoComplete:PopupOpened).
        // Stopped, not prevented: a prevented keypress reads as one the page took. And stopped
        // for this target's later listeners too: a contenteditable's editor listens on this
        // same target, the window's parent (HTMLEditor::GetDOMEventTarget), after this actor.
        const e = /** @type {KeyboardEvent & { multipleActionsPrevented: boolean }} */ (event);
        if (!e.isTrusted || !e.multipleActionsPrevented || e.defaultPrevented) return;
        if (this.#suggestionsOpen()) e.stopImmediatePropagation();
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
        this.#scroll.focusMoved();
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
        // Any trusted mousedown is the user's (an agent's is untrusted, #press), though it may
        // move no focus (a toolbar item that prevents its mousedown): what the page focuses after
        // it is not the page's own doing, and a field the page focused is the user's now.
        if (event.isTrusted) this.sendAsyncMessage("Vimma:Click");
        return;
      }
      case "dragstart":
        this.#dragging = true;
        return;
      case "documentloaded":
      case "pagesloaded":
        // Only pdf.js's own events (chrome-only, trusted); PdfView.attach checks the principal.
        if (!event.isTrusted) return;
        if (this.#pdf) this.#pdf.schedule();
        else {
          this.#pdf = PdfView.attach(
            this,
            (state) => this.#sendPdf(state),
            (outline) => this.#sendPdf(outline, "Vimma:PdfOutline"),
            () => this.#pdfOps,
          );
          if (this.#pdf) this.#askTheme();
        }
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
      const finder = this.manager.getActor("Finder")._finder;
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
    const controller = el.editor?.selectionController;
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
    for (let n = isNode(target) ? target : null; n; n = n.flattenedTreeParentNode) {
      if (n === el) return el;
    }
    return null;
  }

  /**
   * Whether keys the page handled after Esc's blur was asked for, but before it arrived, moved
   * the focus (insert-focus behaviour 8). `sent`: the keys the parent let through to this
   * document before it asked; the ones this document counted beyond that came after. Starts
   * the count again from nothing, so that a count that drifted (more keys here than the parent
   * saw) lasts until this blur only; the parent then counts more, and a blur falls back to a
   * plain one.
   * @param {unknown} sent
   * @param {Element | null} el  the focused element now
   */
  #keptByLaterKeys(sent, el) {
    const before = isIndex(sent) ? sent : this.#keys.count;
    const first = this.#keys.focus.find((k) => k.n === before);
    this.#keys = { count: 0, focus: [] };
    return !!first && (first.el?.deref() ?? null) !== el;
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
    const user =
      this.#focusing ||
      (!this.#agentPress && !!this.contentWindow?.windowUtils.isHandlingUserInput);
    this.sendAsyncMessage("Vimma:Focus", {
      descriptor: describe(el),
      trigger,
      user,
      gen: this.#blurGen,
    });
  }

  /** @param {ChildMessage} msg */
  receiveMessage(msg) {
    switch (msg.name) {
      case "Vimma:Scroll":
        // pdf.js's presentation mode shows one page at a time: the scroll keys turn pages.
        if (this.#pdf?.turnPage(msg.data.kind, msg.data.count)) return true;
        return this.#scroll.scroll(
          msg.data.kind,
          msg.data.count,
          msg.data.instant === true,
          msg.data.step,
        );
      case "Vimma:PdfTheme":
        // A theme change (V12): the token sheet again.
        this.#pdf?.setTheme(msg.data?.css);
        return undefined;
      case "Vimma:PdfOp":
        // An operation name and a number (docs/security/20-pdf-viewer.md section 20, V7), checked
        // again by the adapter; only the top-level viewer has one. A report follows each, even when
        // it changed nothing, so the parent hears that it was run (`state.pdf`).
        this.#pdfOps++;
        this.#pdf?.run(msg.data);
        this.#pdf?.schedule();
        return undefined;
      case "Vimma:PdfZoom":
        // The tab's full zoom changed (#1040): a report at the new zoom, which a zoom that keeps
        // the page's layout would not otherwise bring. No data, nothing run in the viewer.
        this.#pdf?.schedule();
        return undefined;
      case "Vimma:PdfWhere":
        // Where the view is, for a mark (docs/specs/pdf-mode.md decision 11).
        return this.#pdf?.position() ?? null;
      case "Vimma:PdfLinkPage": {
        // `F` on an internal link of the last hints (decision 16): the page it goes to.
        const { gen, id } = msg.data ?? {};
        if (!this.#pdf || !isIndex(gen) || !isIndex(id) || gen !== this.#hints.gen) return 0;
        const el = this.#hints.els[id]?.deref();
        const pdf = this.#pdf;
        return el?.isConnected ? new Promise((resolve) => pdf.linkPage(el, resolve)) : 0;
      }
      case "Vimma:ScrollFraction":
        // Where an agent tab is scrolled to (docs/specs/mcp-drive.md D16).
        return this.#scroll.fraction();
      case "Vimma:Blur": {
        if (isIndex(msg.data?.gen)) this.#blurGen = msg.data.gen;
        const el = deepActiveElement(this.document);
        if (this.#keptByLaterKeys(msg.data?.keys, el)) {
          // The focus a later key gave stays, and decides the mode with this blur's gen.
          this.#report(el ?? this.document.body, "focusin");
          return undefined;
        }
        if (el && el !== this.document.body) /** @type {HTMLElement} */ (el).blur();
        return undefined;
      }
      case "Vimma:FocusInput":
        return this.#focusInput(msg.data?.count);
      case "Vimma:FocusLast":
        return this.#focusLast();
      case "Vimma:SuggestionsOpen":
        return this.#suggestionsOpen();
      case "Vimma:Edit": {
        // ctrl+w, ctrl+u, ctrl+h after the page left them alone (key-handling-batch § 2): the
        // editor's own command on the focused text field, so undo works.
        const command = msg.data?.command;
        if (!INSERT_EDIT_COMMANDS.includes(command)) return undefined;
        if (this.document.hasFocus() && this.#inEditable()) this.docShell?.doCommand(command);
        return undefined;
      }
      case "Vimma:ScrollPosition":
        return this.#scroll.position();
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
      case "Vimma:ScrollTo":
        this.#scroll.scrollTo(msg.data);
        return undefined;
      case "Vimma:Grep":
        return this.#grep.search(msg.data);
      case "Vimma:GrepPreview":
        return this.#grep.preview(msg.data);
      case "Vimma:GrepJump":
        return this.#grep.jump(msg.data);
      case "Vimma:GrepEnd":
        this.#grep.end();
        return undefined;
      case "Vimma:CollectHints":
        return this.#collectHints(msg.data);
      case "Vimma:ActivateHint":
        return this.#activateHint(msg.data);
      case "Vimma:AgentElement":
        return this.#agent.element(msg.data);
      case "Vimma:AgentQuiet":
        return this.#agent.quiet(msg.data);
      case "Vimma:AgentConsole":
        return this.#agent.consoleEntries(msg.data);
      case "Vimma:AgentCards":
        return this.#agent.cards();
      case "Vimma:AgentTotal":
        return this.#agent.total();
      case "Vimma:AgentSensitiveShown":
        return this.#agent.sensitiveShown();
      case "Vimma:Caret": {
        // Only the frame with focus has the user's caret (the parent sends to that one).
        const win = this.contentWindow;
        if (!isCaretMessage(msg.data) || !win || !this.document.hasFocus()) return false;
        const selCon = this.#selCon();
        if (!selCon) return false;
        return this.#caret.run(win, selCon, msg.data);
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
            if (!selCon) return false;
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

  /**
   * The frame's nsISelectionController, got as ViewSourcePageChild gets it; null once the frame
   * has lost its docshell.
   */
  #selCon() {
    return (
      this.docShell
        ?.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsISelectionDisplay)
        .QueryInterface(Ci.nsISelectionController) ?? null
    );
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
   * (`texts`, docs/specs/mcp-drive.md D12) gets each link's text too; an agent's
   * `vimma_elements` (`elements`, docs/specs/mcp-forms.md F2-F6) gets every kind, disabled
   * controls included, each described, with the frame's forms, and keeps its elements apart from
   * the user's (F4). A top frame without a size yet is given time to get one first (#sized).
   * @param {{ gen: number, linksOnly: boolean, blocks?: boolean, texts?: boolean,
   *   elements?: boolean }} data
   */
  async #collectHints(data) {
    const gen = data?.gen;
    const win = this.contentWindow;
    if (!isIndex(gen) || !win) return null;
    const elements = data.elements === true;
    const texts = data.texts === true && !elements;
    if (!this.browsingContext?.parent && !hasSize(win)) {
      if (!(await this.#sized(win))) return null;
      // Collections that wait can end out of order. Generations only grow, so a stored newer
      // generation means a newer collection of the same kind answered meanwhile; the elements it
      // stored are the ones the parent acts on, and they stay.
      const stored = elements ? this.#agent.listed : texts ? null : this.#hints;
      if (stored && stored.gen > gen) return null;
    }
    const t0 = ChromeUtils.now();
    const { targets, frames } = collectTargets(win, {
      linksOnly: data.linksOnly === true && !elements,
      blocks: data.blocks === true && !elements,
      disabled: elements,
    });
    // An agent's collection is never followed through the user's targets: the user's targets of
    // this frame stay as they were, and an agent's elements are kept apart.
    if (elements) this.#agent.listed = { gen, els: targets.map((t) => new WeakRef(t.el)) };
    else if (!texts) this.#hints = { gen, els: targets.map((t) => new WeakRef(t.el)) };
    const described = elements ? describeAgentElements(targets.map((t) => t.el)) : null;
    return {
      targets: targets.map((t, id) => ({
        id,
        rect: t.rect,
        kind: t.kind,
        href: t.href,
        text: texts ? linkText(t.el) : undefined,
        blockKind: t.blockKind,
        box: t.box,
        agent: described?.elements[id],
      })),
      frames: frames.map((f) => ({ id: f.bc.id, rect: f.rect })),
      ms: ChromeUtils.now() - t0,
      ...(described ? { forms: described.forms } : {}),
    };
  }

  /**
   * Waits, at most HINT_SIZE_WAIT_MS, for this top frame's viewport to have a size; false when
   * its document went away meanwhile. The parent sends a tab its size after a layout of its
   * <browser>, and on a busy chrome (its refresh driver waiting on a slow compositor) that can
   * come after the page loaded: a fresh hidden tab can be complete at 0 by 0, where no element is
   * on screen, and an agent's `f` there listed no link (#605). Out of time, the page is collected
   * as it is.
   * @param {Window} win
   */
  async #sized(win) {
    const doc = win.document;
    const until = ChromeUtils.now() + HINT_SIZE_WAIT_MS;
    const test = Cu.isInAutomation ? VimmaChild._sizePollMsForTests : null;
    const poll = test ?? SIZE_POLL_MS;
    VimmaChild._sizeWaitsForTests++;
    try {
      while (!hasSize(win) && ChromeUtils.now() < until) {
        // A chrome timer: a hidden tab's page timers are held to one a second.
        await new Promise((resolve) => lazy.setTimeout(resolve, poll));
        try {
          if (!this.manager?.isCurrentGlobal || this.document !== doc) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    } finally {
      VimmaChild._sizeWaitsForTests--;
    }
  }

  /**
   * Whether `el` is still in this frame's document, and that document is still the frame's.
   * Connected alone is not enough: a page can adopt a listed element into another document (a
   * frame of its own), where a click or fill would act outside the frame the parent checked
   * (security.md M25). Nor is this actor's document: once a navigation in this process has
   * replaced the page, the actor keeps the old document until it is destroyed, while its
   * window is no longer current (JSWindowActorChild::GetContentWindow returns null; issue
   * #1028).
   * @param {Element | null | undefined} el
   * @returns {el is Element}
   */
  #onPage(el) {
    try {
      return (
        !!el?.isConnected && el.ownerDocument === this.document && !!this.manager?.isCurrentGlobal
      );
    } catch {
      return false; // the actor was destroyed with its document
    }
  }

  /**
   * The page function an agent's form submission calls just before its check, for a test
   * (`_beforeSubmitCheckForTests`); null outside automation, whoever set it (security.md M28).
   */
  #beforeSubmitCheck() {
    const test = Cu.isInAutomation ? VimmaChild._beforeSubmitCheckForTests : null;
    return test;
  }

  /**
   * Follows a target of the last collection: a text field gets focus (its focusin report enters
   * insert), a select opens its list, anything else a click. Only the parent sends this, for a
   * label the user typed in chrome, so the press is the user's gesture in the page: their
   * transient user activation, as a click would give (user-gesture.mjs; issue #1303). An
   * agent's click reaches #press through AgentPage, never through here (mcp-forms F8).
   * @param {{ gen: number, id: number }} data
   */
  #activateHint(data) {
    if (!isIndex(data?.gen) || !isIndex(data?.id) || data.gen !== this.#hints.gen) return false;
    const el = this.#hints.els[data.id]?.deref();
    this.#hints = { gen: -1, els: [] };
    // Not on a page this process has replaced since the labels were drawn (issue #1028).
    const win = this.contentWindow;
    if (!win || !this.#onPage(el)) return false;
    const html = /** @type {HTMLElement} */ (el);
    // Before the text fields: a select is one for insert mode (core isEditable), and its focus
    // alone left the list closed.
    if (el.localName === "select") {
      const select = /** @type {HTMLSelectElement} */ (el);
      this.#focus(html);
      // A disabled select opens nothing: no activation is given for it.
      if (select.disabled || select.matches(":disabled")) return true;
      try {
        asUserGesture(win, () => select.showPicker());
      } catch {
        // A hidden select, or one the page removed on focus: it keeps focus, and Alt+Down
        // opens it.
      }
      return true;
    }
    if (el.localName !== "a" && isEditable(describe(el)).editable) {
      this.#focus(html);
      return true;
    }
    return asUserGesture(win, () => this.#press(el));
  }

  /**
   * A click as the user's hints and an agent's `vimma_activate` make it: mouseover, mousedown
   * and mouseup, for pages that act on them (menus, Google's jsaction), then click(), whose
   * activation behaviour follows links. The user's hint dispatches the mouse events from this
   * actor, so the page sees them trusted (EventDispatcher::DispatchDOMEvent stamps an event
   * that system code dispatches), as it would a real press. An agent's are dispatched as the
   * page's own script would (page-events.mjs; issue #1321), so they are untrusted: Gecko then
   * neither focuses a link on the mousedown nor shows its URL in the user's window, and the
   * page runs their listeners without "handling user input". click() is called by this actor
   * in both cases, so the page sees a trusted click (mcp-forms F8). Neither gives transient
   * user activation itself: the user's hint wraps the press in asUserGesture, an agent's never.
   * `still`: checked after the mouse events; when false, no click.
   * @param {Element} el @param {() => boolean} [still] @param {{ agent?: boolean }} [opts]
   * @returns {boolean} whether it clicked
   */
  #press(el, still = () => true, { agent = false } = {}) {
    // A page this process has replaced since (#onPage): nothing to press.
    const win = this.contentWindow;
    if (!win || !this.#onPage(el)) return false;
    const html = /** @type {HTMLElement} */ (el);
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
    };
    const events = ["mouseover", "mousedown", "mouseup"].map(
      (type) => new win.MouseEvent(type, { ...init, buttons: type === "mousedown" ? 1 : 0 }),
    );
    if (agent) {
      // Untrusted: they set no link preview, so there is no hover to end, and the user's own
      // hover in their window is left alone.
      dispatchAsPage(el, events);
    } else {
      for (const event of events) el.dispatchEvent(event);
      if (inLink(el)) this.#leaveLink();
    }
    if (!this.#onPage(el) || !still()) return false;
    this.#agentPress = agent;
    try {
      // SVG elements have no click(): dispatch the click event for them.
      if (typeof html.click === "function") html.click();
      else el.dispatchEvent(new win.MouseEvent("click", init));
    } finally {
      this.#agentPress = false;
    }
    return true;
  }

  /**
   * Ends the link hover #press began on a link: its trusted mouseover, and the focus its trusted
   * mousedown gives the link (Element::PostHandleEventForLinks), each put the link's URL in the
   * window's link preview (Element::GetEventTargetParentForLinks), where it stayed until another
   * document loaded, since no pointer leaves the link (#1309). This is what a mouseout does there
   * (nsDocShell::OnLeaveLink), without one: the page sees the pointer stay on the element, so a
   * menu that opened on the hover stays open. Only after a press in a link: the call clears
   * whatever the window shows, the user's own hover included. The user's hints only: an agent's
   * press sends untrusted events, which never set the preview (page-events.mjs, #1321).
   */
  #leaveLink() {
    try {
      this.docShell?.treeOwner
        ?.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebBrowserChrome)
        .setLinkStatus("");
    } catch {
      // A frame being torn down has no tree owner left; nothing shows its link then.
    }
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
}

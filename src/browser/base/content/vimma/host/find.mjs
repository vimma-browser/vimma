/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `/`, `?`, `n`, `N` over Firefox's own find bar and finder (spec: docs/specs/m1-find.md).
// The find bar is the input: it already searches frames (cross-origin too), shadow DOM and
// pdf.js, and counts matches. This module adds Vim's Enter (accept) and Esc (cancel, back to
// where the search started), `?`, smartcase for n/N and pdf.js, and the status bar's state.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { isCaseSensitive } from "../core/find.mjs";

/** @import { FindStatus } from "../core/find.mjs" */

/** nsITypeAheadFind.FIND_NOTFOUND */
const FIND_NOTFOUND = 1;
/** How long Enter waits for the incremental find's result before closing anyway. */
const ACCEPT_WAIT_MS = 1000;

/**
 * The slice of Firefox's finder (toolkit/modules/FinderParent.sys.mjs) we drive.
 * @typedef {{
 *   caseSensitive: boolean,
 *   addResultListener(l: object): void,
 *   removeResultListener(l: object): void,
 *   findAgain(query: string, backward: boolean, linksOnly: boolean, outline: boolean): void,
 *   requestMatchesCount(query: string, args: object): void,
 *   removeSelection(keepHighlight?: boolean): void,
 * }} Finder
 * @typedef {Element & {
 *   finder: Finder,
 *   currentURI: { spec: string },
 *   documentContentType: string,
 *   browsingContext: object,
 *   focus(): void,
 * }} Browser
 * @typedef {Element & {
 *   hidden: boolean,
 *   FIND_NORMAL: number,
 *   _findField: HTMLInputElement,
 *   _typeAheadCaseSensitive: number,
 *   open(mode: number): boolean,
 *   close(noAnim?: boolean): void,
 *   onFindAgainCommand(previous: boolean): void,
 * }} FindBar
 * @typedef {{
 *   getTabForBrowser(b: Browser): Element | null,
 *   getFindBar(tab: Element): Promise<FindBar | null>,
 *   getCachedFindBar(tab: Element): FindBar | undefined,
 *   selectedBrowser: Browser,
 * }} TabBrowser
 */

/**
 * @typedef {object} Session  a `/` or `?` being typed
 * @property {Browser} browser
 * @property {boolean} backward
 * @property {FindBar | null} findbar   null while Firefox creates it (one frame)
 * @property {string} buffer   keys typed before the find bar had focus
 * @property {"accept" | null} queued   Enter pressed before the find bar had focus
 * @property {string | null} accepting   Enter pressed: the query whose result we wait for
 * @property {number} timer   gives up waiting for that result
 * @property {Promise<{ x: number, y: number } | null>} mark   where the search started
 * @property {() => void} onClose
 */

/** @typedef {FindStatus & { uri: string }} Entry */

/** @param {KeyboardEvent} e */
const plain = (e) => !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;

/** pdf.js takes the find bar's events itself (PdfJsParent); the finder does not reach it. */
const isPdf = (/** @type {Browser} */ b) => b.documentContentType === "application/pdf";

export class Find {
  /**
   * @param {Window} win
   * @param {() => void} onChange  the host re-reads `status()` (the status bar)
   */
  constructor(win, onChange) {
    this.win = win;
    this.onChange = onChange;
    /** @type {Session | null} */
    this.session = null;
    /** @type {{ query: string, backward: boolean } | null} Vim's last search pattern */
    this.last = null;
    /** @type {WeakMap<Browser, Entry>} the status per tab */
    this.entries = new WeakMap();
    /** @type {WeakMap<Browser, object>} our finder result listener per tab */
    this.listeners = new WeakMap();
    /** @type {WeakSet<Browser>} tabs whose finder results we show */
    this.active = new WeakSet();
    this.suppressFocus = false;
    this.onFindEvent = (/** @type {Event} */ e) =>
      this.#onFindEvent(/** @type {CustomEvent} */ (e));
    win.addEventListener("find", this.onFindEvent, true);
    win.addEventListener("findagain", this.onFindEvent, true);
  }

  destroy() {
    this.win.removeEventListener("find", this.onFindEvent, true);
    this.win.removeEventListener("findagain", this.onFindEvent, true);
    for (const b of /** @type {Browser[]} */ (this.#gBrowser().browsers ?? [])) {
      const l = this.listeners.get(b);
      if (l) b.finder.removeResultListener(l);
    }
    this.session = null;
  }

  /** @returns {TabBrowser & { browsers?: Browser[] }} */
  #gBrowser() {
    return /** @type {any} */ (this.win).gBrowser;
  }

  /** Whether keys go to a search being typed: the status bar says `command`, as Vim. */
  get typing() {
    const s = this.session;
    if (!s) return false;
    return !s.findbar || this.win.document.activeElement === s.findbar._findField;
  }

  /**
   * What the status bar shows for `browser`: the search being typed, else the last one in this
   * page, if any.
   * @param {Browser} browser
   * @returns {FindStatus | null}
   */
  status(browser) {
    const s = this.session;
    const entry = this.entries.get(browser);
    if (s?.browser === browser) {
      const query = s.findbar ? s.findbar._findField.value : s.buffer;
      const known = this.#known(browser, query);
      if (known) return { ...known, query, backward: s.backward };
      return { query, backward: s.backward };
    }
    if (!entry || entry.uri !== browser.currentURI?.spec) return null;
    return entry;
  }

  /**
   * `/` or `?`: opens the find bar for the tab and remembers where the page was.
   * @param {Browser} browser
   * @param {boolean} backward
   */
  start(browser, backward) {
    // A tab closed mid-find takes its find bar without a findbarclose event.
    if (this.session && !this.session.browser.isConnected) this.#closedElsewhere(this.session);
    if (this.session) return;
    const gBrowser = this.#gBrowser();
    const tab = gBrowser.getTabForBrowser(browser);
    if (!tab) return;
    this.#watch(browser);
    this.active.add(browser);
    /** @type {Session} */
    const session = {
      browser,
      backward,
      findbar: null,
      buffer: "",
      queued: null,
      accepting: null,
      timer: 0,
      mark: VimmaActors.scrollPosition(browser),
      onClose: () => this.#closedElsewhere(session),
    };
    // Before the first search: it starts where Vim's would, not at the document's first match.
    VimmaActors.findAnchor(browser);
    this.session = session;
    this.onChange();
    gBrowser.getFindBar(tab).then((findbar) => {
      if (this.session !== session) return;
      if (!findbar) {
        this.session = null;
        this.onChange();
        return;
      }
      session.findbar = findbar;
      findbar.addEventListener("findbarclose", session.onClose);
      // open(), not startFind(): Vim's `/` starts empty, and startFind's prefill with the page's
      // selection arrives later and takes focus back into the bar (after Enter, in pdf.js).
      findbar.open(findbar.FIND_NORMAL);
      const field = findbar._findField;
      field.focus();
      // Keys typed while the bar was created come first.
      field.value = session.buffer;
      if (session.buffer) field.dispatchEvent(new /** @type {any} */ (this.win).Event("input"));
      if (session.queued === "accept") this.accept();
      this.onChange();
    });
  }

  /**
   * Enter, Esc and the keys typed while the find bar is being created. Returns whether the key
   * was ours (consumed).
   * @param {KeyboardEvent} e
   */
  onKeyDown(e) {
    const s = this.session;
    if (!s) return false;
    if (!s.findbar) {
      // One frame while Firefox creates the find bar: the keys belong to the search, as in Vim.
      if (e.key === "Escape") this.cancel();
      else if (e.key === "Enter") s.queued = "accept";
      else if (e.key === "Backspace") s.buffer = s.buffer.slice(0, -1);
      else if (!e.ctrlKey && !e.altKey && !e.metaKey && [...e.key].length === 1) s.buffer += e.key;
      else return false;
      consume(e);
      this.onChange();
      return true;
    }
    if (this.win.document.activeElement !== s.findbar._findField || !plain(e)) return false;
    if (e.key === "Enter") this.accept();
    else if (e.key === "Escape") this.cancel();
    else return false;
    consume(e);
    return true;
  }

  /**
   * Enter: stay on the match, back to the page. `?` searches forward as it is typed, as the
   * find bar does, and Enter steps back once: the last match before where the search started.
   */
  accept() {
    const s = this.session;
    if (!s?.findbar || s.accepting !== null) return;
    const query = s.findbar._findField.value;
    if (!query) {
      this.cancel();
      return;
    }
    this.last = { query, backward: s.backward };
    if (isPdf(s.browser)) {
      // pdf.js debounces a typed search and closing the bar drops it: search now, as the bar's
      // own Enter does (a "findagain" event, which pdf.js runs at once for a new query).
      s.findbar.onFindAgainCommand(s.backward);
      this.#finish(s, query, false);
      return;
    }
    const known = this.#known(s.browser, query);
    if (known) {
      this.#finish(s, query, known.notFound ?? false);
      return;
    }
    // The incremental find's result is on its way. Close once it is in: Firefox reopens the
    // find bar when a search fails, and a failed search goes back to where it started (Vim).
    s.accepting = query;
    s.timer = this.win.setTimeout(() => this.#finish(s, query, false), ACCEPT_WAIT_MS);
  }

  /**
   * The finished search's result, if the finder has given it: this query's, or a failed
   * shorter one it extends (the find bar does not search again until the text changes back).
   * @param {Browser} browser
   * @param {string} query
   * @returns {Entry | null}
   */
  #known(browser, query) {
    const entry = this.entries.get(browser);
    if (!entry) return null;
    if (entry.query === query) return entry;
    return entry.notFound && entry.query && query.startsWith(entry.query) ? entry : null;
  }

  /**
   * @param {Session} s
   * @param {string} query
   * @param {boolean} notFound
   */
  #finish(s, query, notFound) {
    if (this.session !== s || !s.findbar) return;
    this.win.clearTimeout(s.timer);
    this.session = null;
    s.findbar.removeEventListener("findbarclose", s.onClose);
    if (notFound) {
      this.entries.set(s.browser, {
        query,
        backward: s.backward,
        notFound: true,
        uri: s.browser.currentURI?.spec ?? "",
      });
      this.#close(s);
    } else {
      // close() makes the finder forget the frame of the match, so n and N would search again
      // from the top frame's selection, forward only (FinderParent.doFind).
      const finder = /** @type {any} */ (s.browser.finder);
      const frame = finder._lastFoundBrowsingContext;
      s.findbar.close();
      if (frame && !finder._lastFoundBrowsingContext) finder._lastFoundBrowsingContext = frame;
      // close() sent Finder:FocusContent to this frame (FinderParent.sendMessageToContext).
      VimmaActors.findClosed(frame ?? s.browser.browsingContext);
      // close() focuses the page only while focus is in the find bar (shouldFocusContent); an
      // Enter typed before it took focus, or pdf.js's own close, can leave it in chrome.
      if (this.win.document.activeElement !== s.browser) s.browser.focus();
      // pdf.js has searched already (accept).
      if (s.backward && !isPdf(s.browser)) this.#findAgain(s.browser, query, true);
      // Closing stops a count still running; the status bar wants it.
      else if (!isPdf(s.browser) && !this.entries.get(s.browser)?.total) {
        s.browser.finder.requestMatchesCount(query, { linksOnly: false });
      }
    }
    this.onChange();
  }

  /**
   * Closes the find bar back to where the search started: no match selected, the page
   * scrolled back, focus on the page as it was.
   * @param {Session} s
   */
  #close(s) {
    const findbar = /** @type {FindBar} */ (s.findbar);
    // Before close(): it forgets the frame that holds the match.
    s.browser.finder.removeSelection();
    // close() would focus the matched link.
    this.suppressFocus = true;
    try {
      findbar.close();
    } finally {
      this.suppressFocus = false;
    }
    s.browser.focus();
    this.#restore(s.browser, s.mark);
  }

  /** Esc: close the find bar, unselect the match, scroll back to where the search started. */
  cancel() {
    const s = this.session;
    if (!s) return;
    this.win.clearTimeout(s.timer);
    this.session = null;
    this.active.delete(s.browser);
    this.entries.delete(s.browser);
    if (s.findbar) {
      s.findbar.removeEventListener("findbarclose", s.onClose);
      this.#close(s);
    }
    this.onChange();
  }

  /**
   * `n` (`reverse` false) and `N`: the last search again, in its direction or against it.
   * Nothing when it found nothing in this page (no find bar popping up, as Firefox's F3 does).
   * @param {Browser} browser
   * @param {boolean} reverse
   */
  again(browser, reverse) {
    if (this.session) return;
    // Firefox's own find bar (ctrl+f) is open, or was the only search: its query, as Firefox's
    // ctrl+g and F3 ran (docs/specs/firefox-keys.md). Vimma's `/` closes the bar when it ends.
    const tab = this.#gBrowser().getTabForBrowser(browser);
    const findbar = tab ? this.#gBrowser().getCachedFindBar(tab) : undefined;
    if (findbar?._findField.value && (!findbar.hidden || !this.last)) {
      findbar.onFindAgainCommand(reverse);
      return;
    }
    if (!this.last) return;
    const { query, backward } = this.last;
    const known = this.#known(browser, query);
    if (known?.notFound && known.uri === browser.currentURI?.spec) {
      this.onChange();
      return;
    }
    this.#watch(browser);
    this.active.add(browser);
    this.#findAgain(browser, query, backward !== reverse);
  }

  /**
   * @param {Browser} browser
   * @param {string} query
   * @param {boolean} backward
   */
  #findAgain(browser, query, backward) {
    const gBrowser = this.#gBrowser();
    const tab = gBrowser.getTabForBrowser(browser);
    const findbar = tab && gBrowser.getCachedFindBar(tab);
    if (findbar && isPdf(browser)) {
      findbar._findField.value = query;
      findbar.onFindAgainCommand(backward);
      return;
    }
    browser.finder.caseSensitive = isCaseSensitive(query);
    browser.finder.findAgain(query, backward, false, false);
  }

  /**
   * @param {Browser} browser
   * @param {Session["mark"]} mark
   */
  async #restore(browser, mark) {
    const at = await mark;
    if (at) VimmaActors.scrollTo(browser, at);
    // n after Esc searches from where the page is again.
    VimmaActors.findAnchor(browser);
  }

  /**
   * The find bar closed by other means (its close button, ctrl+f, a tab closing).
   * @param {Session} session
   */
  #closedElsewhere(session) {
    if (this.session !== session) return;
    this.session = null;
    this.onChange();
  }

  /**
   * The find bar's own events: pdf.js gets smartcase (the bar sends it `caseSensitive: true`
   * in its "auto" mode, PdfJsParent forwards that as is).
   * @param {CustomEvent} e
   */
  #onFindEvent(e) {
    const findbar = /** @type {FindBar} */ (e.target);
    const detail = e.detail;
    if (detail && findbar._typeAheadCaseSensitive === 2) {
      detail.caseSensitive = isCaseSensitive(String(detail.query ?? ""));
    }
  }

  /** @param {Browser} browser */
  #watch(browser) {
    if (this.listeners.has(browser)) return;
    const listener = {
      onFindResult: (/** @type {any} */ data) => this.#onResult(browser, data),
      onMatchesCountResult: (/** @type {any} */ r) => this.#onCount(browser, r),
      onHighlightFinished() {},
      onCurrentSelection() {},
      shouldFocusContent: () => !this.suppressFocus,
    };
    browser.finder.addResultListener(listener);
    this.listeners.set(browser, listener);
  }

  /** @param {Browser} browser */
  #backward(browser) {
    if (this.session?.browser === browser) return this.session.backward;
    return this.last?.backward ?? false;
  }

  /**
   * @param {Browser} browser
   * @param {{ result: number, searchString: string }} data
   */
  #onResult(browser, data) {
    if (!this.active.has(browser)) return;
    const query = String(data.searchString ?? "");
    const notFound = data.result === FIND_NOTFOUND;
    const old = this.entries.get(browser);
    this.entries.set(browser, {
      query,
      backward: this.#backward(browser),
      notFound,
      current: old?.query === query && !notFound ? (old.current ?? 0) : 0,
      total: old?.query === query && !notFound ? (old.total ?? 0) : 0,
      uri: browser.currentURI?.spec ?? "",
    });
    const s = this.session;
    const waiting = s?.browser === browser ? s.accepting : null;
    if (waiting !== null && (waiting === query || (notFound && waiting.startsWith(query)))) {
      // After the other listeners: the find bar reopens itself on a failure it is told of.
      const session = /** @type {Session} */ (s);
      Promise.resolve().then(() => this.#finish(session, waiting, notFound));
    }
    this.onChange();
  }

  /**
   * @param {Browser} browser
   * @param {{ searchString: string, current: number, total: number, limit: number }} r
   */
  #onCount(browser, r) {
    const query = String(r.searchString ?? "");
    const entry = this.entries.get(browser);
    // Only for the search the finder last answered; a count of 0 also comes for a count that
    // another search interrupted, so it never turns a match into "not found".
    if (!this.active.has(browser) || entry?.query !== query || !r.total) return;
    this.entries.set(browser, { ...entry, current: r.current, total: r.total, limit: r.limit });
    this.onChange();
  }
}

/** @param {Event} e */
function consume(e) {
  e.preventDefault();
  e.stopPropagation();
}

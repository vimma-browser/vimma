/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live grep (docs/specs/live-grep.md): one session per window. It sends the query to every frame
// of every loaded tab in scope (`Vimma:Grep`), checks each reply (core parseGrepReply), merges
// them in tab order (core grepRows) and renders them in the picker (ui/grep.mjs); it asks the
// selected result's frame for the preview, jumps on Enter, and keeps the grep list for ]q / [q.
// The scope (decision 10) reaches other windows only on the same side of the private line, so
// the private workspace (its own window) and normal windows never see each other's pages
// (decision 13). Recently closed tabs and windows have no page text; their titles and URLs are
// matched in a worker of this process, as a page's text is in its own.

import {
  GREP_CAPS,
  closedPreview,
  closedRows,
  closedSearchText,
  grepCountText,
  grepHost,
  grepListText,
  grepPickerKey,
  grepRows,
  grepScopeText,
  holdReplies,
  openGrepPicker,
  parseGrepReply,
  parsePreviewReply,
  parseQuery,
  pruneGrepList,
  setGrepRows,
  stepGrepList,
} from "../core/grep.mjs";
import { PRIVATE_NAME } from "../core/privatews.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { GrepMatcher } from "../actors/grep-matcher.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { pickerWorkspaces, tabById } from "./goto.mjs";
import { isPrivateBrowsing, isPrivateWorkspace } from "./private-ops.mjs";
import { reopenClosed, windowsFrom } from "./tab-search.mjs";
import { GrepPicker } from "../ui/grep.mjs";

/** @import { GrepClosedEntry, GrepClosedRow, GrepFrame, GrepList, GrepMatchRow, GrepPickerState, GrepRow, GrepTab } from "../core/grep.mjs" */
/** @import { GrepInfo } from "../ui/grep.mjs" */

const { clearTimeout, setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);
const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

/** Decision 14: the debounce after a keystroke, tabs asked at a time, a frame's time to answer. */
const DEBOUNCE_MS = 80;
const PREVIEW_DEBOUNCE_MS = 40;
const CONCURRENT_TABS = 8;
const FRAME_TIMEOUT_MS = 2000;
const MAX_TABS = 200;

export const GONE_TEXT = "match no longer on the page";
export const NO_LIST_TEXT = "grep: no results to step through";
export const CLOSED_GONE_TEXT = "no longer in recently closed";
/** A tab's title as rows, the preview title and an option's name take it; pages set any length. */
const TITLE_MAX = 300;

/**
 * @typedef {object} GrepHost
 * @property {(text: string) => void} notice
 * @property {() => void} emit  the mode may have changed (the picker opened or closed)
 */

/**
 * @param {Window} win
 * @returns {any} gBrowser
 */
const gBrowserOf = (win) => /** @type {any} */ (win).gBrowser;

/**
 * The windows a scope searches (decision 10): this one, and for `windows` and `closed` every
 * other browser window on the same side of the private line, most recently used first, as tab
 * search lists them. A private window never reaches a normal one, nor the other way (L1).
 * @param {Window} win
 * @param {GrepPickerState["scope"]} scope
 * @returns {Window[]}
 */
function scopeWindows(win, scope) {
  if (scope !== "windows" && scope !== "closed") return [win];
  const priv = isPrivateBrowsing(win);
  return windowsFrom(win).filter((w) => isPrivateBrowsing(w) === priv);
}

/**
 * The URL of a closed tab's saved state: its current history entry.
 * @param {any} state
 */
function closedUrl(state) {
  const entries = state?.entries ?? [];
  const entry = entries[(state?.index ?? entries.length) - 1] ?? entries.at(-1);
  return { url: String(entry?.url ?? ""), title: String(entry?.title ?? "") };
}

/**
 * Recently closed tabs of the scope's windows and, from a normal window, recently closed
 * windows (Firefox keeps no closed private window, SessionStore.sys.mjs `#maybeSaveClosedWindow`
 * callers). SessionStore keeps a closed tab's history entries, not its text.
 * @param {Window} win
 * @param {Window[]} windows  the scope's, this one first
 * @returns {GrepClosedEntry[]}
 */
function closedEntries(win, windows) {
  const defs = WorkspaceStore.definitions.workspaces;
  const agentId = WorkspaceStore.agent?.id ?? null;
  const priv = isPrivateWorkspace(win);
  /** @param {number} ucid */
  const owner = (ucid) => (ucid ? defs.find((d) => d.userContextId === ucid) : undefined);
  /** @type {GrepClosedEntry[]} */
  const out = [];
  windows.forEach((w, i) => {
    /** @type {any[]} */
    let data;
    try {
      data = lazy.SessionStore.getClosedTabDataForWindow(w);
    } catch {
      // SessionStore throws for a window it does not track yet (one that has only just
      // opened, SessionStore.sys.mjs `#getWindowDataForClosedTabs`); it has nothing closed.
      return;
    }
    for (const c of data) {
      const ws = owner(c.state?.userContextId ?? 0);
      const { url, title } = closedUrl(c.state);
      out.push({
        closedId: c.closedId,
        closedWindow: false,
        title: String(c.title ?? title),
        url,
        closedAt: c.closedAt ?? 0,
        window: i + 1,
        workspace: priv ? PRIVATE_NAME : (ws?.name ?? ""),
        agent: !!ws && ws.id === agentId,
        tabs: [],
      });
    }
  });
  if (isPrivateBrowsing(win)) return out;
  /** @type {any[]} */
  const closedWindows = lazy.SessionStore.getClosedWindowData();
  for (const w of closedWindows) {
    const tabs = (w.tabs ?? []).map((/** @type {any} */ t) => {
      const ws = owner(t.userContextId ?? 0);
      return {
        ...closedUrl(t),
        workspace: ws?.name ?? "",
        agent: !!ws && ws.id === agentId,
      };
    });
    out.push({
      closedId: w.closedId,
      closedWindow: true,
      title: String(w.title ?? ""),
      url: "",
      closedAt: w.closedAt ?? 0,
      window: 0,
      workspace: "",
      agent: false,
      tabs,
    });
  }
  return out;
}

/**
 * Resolves once the tab switch in progress is done (Firefox's TabSwitchDone), so the page has
 * its viewport's size before the match is scrolled to its middle; after a second at most.
 * @param {Window} win
 * @returns {Promise<void>}
 */
function switchDone(win) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 1000);
    function done() {
      clearTimeout(timer);
      win.removeEventListener("TabSwitchDone", done);
      resolve();
    }
    win.addEventListener("TabSwitchDone", done);
  });
}

/** @type {GrepInfo} */
const IDLE = Object.freeze({
  count: 0,
  literal: false,
  timedOut: false,
  busy: false,
  cut: false,
  tooLong: false,
});

export class GrepSession {
  /**
   * @param {Window} win
   * @param {GrepHost} host
   */
  constructor(win, host) {
    this.win = win;
    this.host = host;
    this.ui = new GrepPicker(win);
    /** @type {GrepPickerState | null} */
    this.state = null;
    /** @type {GrepInfo} */
    this.info = { ...IDLE };
    /** The generation of the newest search; replies for an older one are dropped. */
    this.gen = 0;
    /** @type {number | undefined} */
    this.timer = undefined;
    /** @type {number | undefined} */
    this.previewTimer = undefined;
    /** @type {Map<string, { bc: any, wg: any }>} each searched frame, by `${tabId}:${key}` */
    this.frames = new Map();
    /** @type {Map<string, Window>} the window of each tab in the last scope, by tab id */
    this.windowOf = new Map();
    /** @type {GrepList | null} the last jump's results (decision 8) */
    this.list = null;
    /** @type {Map<string, Window>} the windows the grep list's tabs are in, by tab id */
    this.listWindows = new Map();
    /** @type {Set<Window>} windows whose TabClose prunes the grep list */
    this.watched = new Set();
    /** The matcher key of this session's recently closed text: a newer query replaces the
     * older one, and closing the picker drops it (L5, L6). */
    this.closedKey = `closed-${GrepMatcher.newKey()}`;
    /** The query `:grep` alone resumes. */
    this.lastQuery = "";
    /** @type {Element | null} focused before open */
    this.opener = null;
    // A closed tab's lines leave the grep list at once, in any window the list reaches (L5).
    // Windows are compared by document: a tab's ownerGlobal is not the same object as the
    // window this session holds.
    this.onTabClose = (/** @type {Event} */ e) => {
      const closed = /** @type {any} */ (e.target);
      const doc = closed.ownerDocument;
      this.prune((id) => {
        const w = this.listWindows.get(id) ?? this.win;
        return w.document !== doc || tabById(w, id) !== closed;
      });
    };
    // A window closing takes its tabs' lines with it; it fires no TabClose for them.
    this.onUnload = (/** @type {Event} */ e) => {
      const doc = e.target;
      const gone = [...this.watched].find((w) => w !== this.win && w.document === doc);
      if (gone) {
        gone.removeEventListener("TabClose", this.onTabClose);
        gone.removeEventListener("unload", this.onUnload);
        this.watched.delete(gone);
      }
      this.prune((id) => this.listWindows.get(id)?.document !== doc);
      for (const [id, w] of this.listWindows) if (w.document === doc) this.listWindows.delete(id);
    };
    this.watch(win);
  }

  /** @param {Window} w */
  watch(w) {
    if (this.watched.has(w)) return;
    this.watched.add(w);
    w.addEventListener("TabClose", this.onTabClose);
    if (w !== this.win) w.addEventListener("unload", this.onUnload);
  }

  /** Stops watching every window but this one. */
  unwatchOthers() {
    for (const w of this.watched) {
      if (w === this.win) continue;
      w.removeEventListener("TabClose", this.onTabClose);
      w.removeEventListener("unload", this.onUnload);
      this.watched.delete(w);
    }
  }

  /** @param {(tabId: string) => boolean} alive */
  prune(alive) {
    if (!this.list) return;
    this.list = pruneGrepList(this.list, alive);
    if (!this.list) this.setList(null);
  }

  /**
   * The grep list and the windows it reaches.
   * @param {GrepList | null} list
   */
  setList(list) {
    this.list = list;
    this.listWindows = new Map();
    for (const row of list?.rows ?? []) {
      const w = this.windowOf.get(row.tabId);
      if (w) this.listWindows.set(row.tabId, w);
    }
    this.unwatchOthers();
    for (const w of new Set(this.listWindows.values())) this.watch(w);
  }

  /**
   * The window a row's tab is in: the grep list's, else the last scope's, else this one.
   * @param {string} tabId
   * @returns {Window}
   */
  windowFor(tabId) {
    const w = this.listWindows.get(tabId) ?? this.windowOf.get(tabId);
    return w && !w.closed ? w : this.win;
  }

  get isOpen() {
    return this.ui.isOpen;
  }

  /**
   * A frame's reply to one message; the test replaces it to hold replies back.
   * @param {any} bc
   * @param {object} data
   * @param {string} [name]
   * @returns {Promise<unknown>}
   */
  ask(bc, data, name = "Vimma:Grep") {
    return VimmaActors.grepAsk(bc, name, data, FRAME_TIMEOUT_MS);
  }

  /**
   * `ctrl+b f g` (empty) and `:grep text` (that query); `:grep` alone resumes (`resume`).
   * @param {string} [text]
   */
  open(text) {
    if (this.isOpen) return;
    this.opener = Services.focus.focusedElement;
    // Frames from earlier searches are kept only while the grep list can go back to them.
    const kept = new Set(
      (this.list?.rows ?? []).map((r) => `${r.tabId}:${r.kind === "match" ? r.frameKey : ""}`),
    );
    for (const key of this.frames.keys()) if (!kept.has(key)) this.frames.delete(key);
    const query = text ?? "";
    this.state = openGrepPicker(query);
    this.info = { ...IDLE };
    this.ui.open();
    this.state = { ...this.state, preview: this.ui.previewShown() };
    this.showScope();
    this.render();
    this.host.emit();
    if (query) this.search();
  }

  /**
   * The scope box (decision 10): which windows, workspaces and tabs the search covers, shown
   * before anything is typed and whenever ctrl+s changes the scope.
   * @param {ReturnType<GrepSession["scopeTabs"]>} [scoped]
   */
  showScope(scoped) {
    if (!this.state) return;
    const { scope } = this.state;
    const { tabs, windows } = scoped ?? this.scopeTabs(scope);
    const closed = scope === "closed" ? closedSearchText(closedEntries(this.win, windows)) : null;
    const counts = closed && {
      tabs: closed.entries.filter((e) => !e.closedWindow).length,
      windows: closed.entries.filter((e) => e.closedWindow).length,
    };
    this.ui.setScope(
      grepScopeText(
        scope,
        tabs.map((t) => t.tab),
        counts,
      ),
    );
  }

  /** `:grep` alone: the last query, re-run (Telescope's resume). */
  resume() {
    this.open(this.lastQuery);
  }

  /**
   * One key (formatKey text) while the picker is open.
   * @param {string} key
   */
  key(key) {
    if (!this.state) return;
    const before = this.state;
    const { state, effect } = grepPickerKey({ ...before, preview: this.ui.previewShown() }, key);
    this.state = state;
    if (effect?.type === "close") {
      this.close();
      return;
    }
    if (effect?.type === "select") {
      this.choose(effect.row);
      return;
    }
    if (effect?.type === "preview") this.ui.scrollPreview(effect.by);
    if (effect?.type === "query" || effect?.type === "scope") {
      // Until the new search answers, the rows on screen are the old query's.
      this.info = { ...this.info, busy: !!this.state.query };
    }
    if (effect?.type === "query") {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.search(), DEBOUNCE_MS);
    }
    if (effect?.type === "scope") {
      clearTimeout(this.timer);
      this.showScope();
      this.search();
    }
    if (state !== before) this.render();
  }

  /** Renders the state, and asks for the preview when the selected result changed. */
  render() {
    if (!this.state || !this.isOpen) return;
    this.ui.render(this.state, this.info);
    const row = this.state.rows[this.state.selected] ?? null;
    const id = row && row.kind !== "unloaded" ? row.id : null;
    if (id === this.ui.previewOf) return;
    clearTimeout(this.previewTimer);
    this.ui.setPreviewTitle(row);
    if (row?.kind === "closed") {
      this.ui.setPreview(row.id, closedPreview(row));
      return;
    }
    if (!row || row.kind !== "match") {
      this.ui.setPreview(null, null);
      return;
    }
    this.previewTimer = setTimeout(() => this.preview(row), PREVIEW_DEBOUNCE_MS);
  }

  /** @param {GrepMatchRow} row */
  async preview(row) {
    const frame = this.frames.get(`${row.tabId}:${row.frameKey}`);
    if (!frame || frame.bc.currentWindowGlobal !== frame.wg) return;
    const raw = await this.ask(frame.bc, { start: row.start, end: row.end }, "Vimma:GrepPreview");
    const current = this.state?.rows[this.state.selected];
    if (!this.isOpen || current?.id !== row.id) return;
    this.ui.setPreview(row.id, parsePreviewReply(raw));
  }

  /**
   * The tabs in the scope, in the order the list shows them (decision 10): window by window,
   * this one first; in each, the current workspace, or every workspace from `window` on.
   * @param {GrepPickerState["scope"]} scope
   * @returns {{ tabs: { tab: GrepTab, browser: any }[], windows: Window[] }}
   */
  scopeTabs(scope) {
    const agentId = WorkspaceStore.agent?.id ?? null;
    const windows = scopeWindows(this.win, scope);
    /** @type {{ tab: GrepTab, browser: any }[]} */
    const out = [];
    this.windowOf = new Map();
    windows.forEach((win, w) => {
      const model = pickerWorkspaces(win);
      const priv = isPrivateWorkspace(win);
      for (const ws of model.workspaces) {
        if (scope === "workspace" && ws.id !== model.active) continue;
        ws.tabs.forEach((id, i) => {
          const tab = /** @type {any} */ (tabById(win, id));
          if (!tab || tab.closing) return;
          const browser = tab.linkedBrowser;
          const loaded =
            !!tab.linkedPanel && !tab.hasAttribute("pending") && !!browser?.browsingContext;
          const url = browser?.currentURI?.spec ?? "";
          this.windowOf.set(id, win);
          out.push({
            browser,
            tab: {
              tabId: id,
              index: i + 1,
              title: String(browser?.contentTitle || tab.label || url).slice(0, TITLE_MAX),
              host: grepHost(url),
              workspace: priv ? PRIVATE_NAME : ws.name,
              agent: ws.id === agentId,
              loaded,
              window: w + 1,
            },
          });
        });
      }
    });
    return { tabs: out.slice(0, MAX_TABS), windows };
  }

  /**
   * Recently closed tabs and windows whose title or URL matches, matched in a worker of this
   * process with a time budget, as page text is in its own (L6).
   * @param {Window[]} windows
   * @param {string} query
   * @returns {Promise<{ rows: GrepClosedRow[], timedOut: boolean }>}
   */
  async searchClosed(windows, query) {
    const closed = closedSearchText(closedEntries(this.win, windows));
    if (!closed.entries.length) return { rows: [], timedOut: false };
    // One key a session: this query replaces the session's older one; close() drops it.
    const reply = await GrepMatcher.match(this.closedKey, { text: closed.text }, query, true, true);
    if (!reply || typeof reply !== "object") return { rows: [], timedOut: reply === "timeout" };
    return { rows: closedRows(closed, reply.matches), timedOut: false };
  }

  /** Runs the current query in the current scope; replies stream into the list. */
  async search() {
    if (!this.state) return;
    const gen = ++this.gen;
    const { query, scope } = this.state;
    const parsed = parseQuery(query);
    const live = () => this.gen === gen && this.isOpen;
    if (query) this.lastQuery = query;
    /** @type {Map<string, (GrepFrame | null)[]>} */
    const slots = new Map();
    // A query no frame would take is not sent (L6); the prompt says why.
    const tooLong = query.length > GREP_CAPS.query;
    const inScope = this.scopeTabs(scope);
    const scoped = parsed && !tooLong ? inScope.tabs : [];
    const tabs = scoped.map((s) => s.tab);
    /** @type {GrepClosedRow[]} */
    let closed = [];
    this.info = {
      ...IDLE,
      literal: !!parsed?.literal,
      busy: !!parsed && !tooLong,
      tooLong,
    };
    /**
     * The replies holding matches, ranked by the list's order: past the row cap the worst
     * ones keep only their counts (core holdReplies), so the parent never holds more than the
     * list can show, and always the best of it.
     * @type {{ rank: number, reply: GrepFrame["reply"], slot: GrepFrame }[]}
     */
    let held = [];
    let heldCount = 0;
    const ranked = [...tabs.filter((t) => !t.agent), ...tabs.filter((t) => t.agent)];
    const tabRank = new Map(ranked.map((t, i) => [t.tabId, i]));
    /** @param {number} rank @param {GrepFrame} slot */
    const hold = (rank, slot) => {
      if (!slot.reply.matches.length) return;
      const worst = held.reduce((m, e) => Math.max(m, e.rank), -1);
      if (heldCount >= GREP_CAPS.rows && rank > worst) {
        slot.reply = { ...slot.reply, matches: [] };
        return;
      }
      held.push({ rank, reply: slot.reply, slot });
      heldCount += slot.reply.matches.length;
      if (heldCount <= GREP_CAPS.rows) return;
      held = holdReplies(held).filter((e) => {
        e.slot.reply = e.reply;
        return e.reply.matches.length > 0;
      });
      heldCount = held.reduce((n, e) => n + e.reply.matches.length, 0);
    };
    let pending = false;
    const update = () => {
      if (!live() || !this.state) return;
      /** @type {Map<string, GrepFrame[]>} */
      const frames = new Map();
      for (const [id, list] of slots) {
        frames.set(id, /** @type {GrepFrame[]} */ (list.filter(Boolean)));
      }
      const { rows, count, tabsWithMatches } = grepRows(tabs, frames, GREP_CAPS, closed);
      this.info = { ...this.info, count };
      this.state = setGrepRows(this.state, rows);
      this.render();
      if (!this.info.busy) {
        const listed = rows.filter((r) => r.kind !== "unloaded").length;
        this.ui.announce(query ? grepCountText(listed, count, tabsWithMatches) : "");
      }
    };
    // Coalesces replies that arrive together into one render.
    const schedule = () => {
      if (pending) return;
      pending = true;
      Services.tm.dispatchToMainThread(() => {
        pending = false;
        update();
      });
    };
    update();
    const queue = scoped.filter((s) => s.tab.loaded);
    const worker = async () => {
      for (let next = queue.shift(); next && live(); next = queue.shift()) {
        const { tab, browser } = next;
        const { frames: bcs, cut } = VimmaActors.grepFrames(browser, GREP_CAPS.frames);
        if (cut) this.info = { ...this.info, cut: true };
        const topSite = bcs[0]?.currentWindowGlobal?.documentPrincipal?.siteOrigin;
        /** @type {(GrepFrame | null)[]} */
        const list = bcs.map(() => null);
        slots.set(tab.tabId, list);
        await Promise.all(
          bcs.map(async (bc, i) => {
            const wg = bc.currentWindowGlobal;
            const key = String(bc.id);
            // Recorded as it is asked, so the frame is told to drop its text at close even
            // if it never answers in time (L5).
            this.frames.set(`${tab.tabId}:${key}`, { bc, wg });
            const raw = await this.ask(bc, { query, gen });
            if (!live()) return;
            if (raw === null) {
              if (wg && !wg.isClosed) this.info = { ...this.info, timedOut: true };
              return;
            }
            const parsedReply = parseGrepReply(raw);
            if (!parsedReply) return;
            if (parsedReply.timedOut) this.info = { ...this.info, timedOut: true };
            if (parsedReply.cut) this.info = { ...this.info, cut: true };
            const principal = wg?.documentPrincipal;
            const host =
              i > 0 && principal && principal.siteOrigin !== topSite
                ? grepHost(wg.documentURI?.spec ?? "")
                : null;
            const slot = { key, host, reply: parsedReply };
            list[i] = slot;
            hold((tabRank.get(tab.tabId) ?? 0) * (GREP_CAPS.frames + 1) + i, slot);
            if (parsedReply.count) schedule();
          }),
        );
      }
    };
    const closedSearch = async () => {
      if (scope !== "closed" || !parsed || tooLong) return;
      const found = await this.searchClosed(inScope.windows, query);
      if (!live()) return;
      closed = found.rows;
      if (found.timedOut) this.info = { ...this.info, timedOut: true };
      if (closed.length) schedule();
    };
    await Promise.all([...Array.from({ length: CONCURRENT_TABS }, worker), closedSearch()]);
    if (!live()) return;
    this.info = { ...this.info, busy: false };
    update();
  }

  /**
   * Enter on a row: closes the picker and goes there (decision 7, 11).
   * @param {GrepRow} row
   */
  async choose(row) {
    const state = this.state;
    this.close({ keepFrames: true });
    if (row.kind === "unloaded") {
      const w = this.windowFor(row.tabId);
      const tab = tabById(w, row.tabId);
      if (w !== this.win) w.focus();
      if (tab) gBrowserOf(w).selectedTab = tab;
      this.endFrames();
      return;
    }
    if (row.kind === "closed") {
      this.endFrames();
      this.reopen(row);
      return;
    }
    const rows = (state?.all ?? []).filter((r) => r.kind === "match");
    this.setList({ query: state?.query ?? "", rows, index: Math.max(0, rows.indexOf(row)) });
    await this.jump(row, state?.query ?? "");
    // Grep opened again while the frame answered: its search now owns the frame map, and
    // pruning it here would leave that search's preview with no frame to ask.
    if (this.isOpen) return;
    this.endFrames();
    // Only the frames the grep list can go back to are kept.
    const kept = new Set(rows.map((r) => `${r.tabId}:${/** @type {GrepMatchRow} */ (r).frameKey}`));
    for (const key of this.frames.keys()) if (!kept.has(key)) this.frames.delete(key);
  }

  /**
   * Enter on a closed row: the tab reopens in this window and is selected (SessionStore's
   * undoCloseTab selects it); a closed window reopens and comes to the front.
   * @param {GrepClosedRow} row
   */
  reopen(row) {
    // Tab search's reopening; a stale id (restored or forgotten since the search) reopens
    // nothing, and says so.
    const reopened = reopenClosed(this.win, row.id);
    if (!reopened) this.host.notice(CLOSED_GONE_TEXT);
    else if (row.closedWindow && typeof reopened.focus === "function") reopened.focus();
  }

  /**
   * Selects the row's tab, in its own window, and asks its frame to select the match.
   * @param {GrepMatchRow} row
   * @param {string} query
   */
  async jump(row, query) {
    const win = this.windowFor(row.tabId);
    const tab = /** @type {any} */ (tabById(win, row.tabId));
    if (!tab) {
      this.host.notice(GONE_TEXT);
      return;
    }
    if (win !== this.win) win.focus();
    const gBrowser = gBrowserOf(win);
    if (gBrowser.selectedTab !== tab) {
      const shown = switchDone(win);
      gBrowser.selectedTab = tab;
      await shown;
    }
    tab.linkedBrowser?.focus();
    const frame = this.frames.get(`${row.tabId}:${row.frameKey}`);
    const bc = frame?.bc;
    // Only the document that was searched: a frame that navigated since gets nothing.
    const inTab =
      bc &&
      !bc.isDiscarded &&
      bc.top === tab.linkedBrowser?.browsingContext &&
      bc.currentWindowGlobal === frame.wg;
    const text = row.context.slice(row.at[0], row.at[1]);
    const data = { query, start: row.start, end: row.end, ordinal: row.ordinal, text };
    const done = inTab ? await this.ask(bc, data, "Vimma:GrepJump") : false;
    if (done !== true) this.host.notice(GONE_TEXT);
  }

  /**
   * `]q` / `[q`: the next or previous result of the grep list (decision 8).
   * @param {1 | -1} dir
   */
  async step(dir) {
    if (!this.list) {
      this.host.notice(NO_LIST_TEXT);
      return;
    }
    const alive = (/** @type {string} */ id) => {
      const tab = /** @type {any} */ (tabById(this.windowFor(id), id));
      return !!tab && !tab.closing;
    };
    const next = stepGrepList(this.list, dir, alive);
    if (!next) {
      this.setList(null);
      this.host.notice(NO_LIST_TEXT);
      return;
    }
    this.list = next;
    const row = /** @type {GrepMatchRow} */ (next.rows[next.index]);
    this.host.notice(grepListText(next));
    await this.jump(row, next.query);
    const frame = this.frames.get(`${row.tabId}:${row.frameKey}`);
    if (frame) await this.ask(frame.bc, {}, "Vimma:GrepEnd");
  }

  /** Tells every searched frame to drop its text model (decision 14). */
  endFrames() {
    for (const { bc } of this.frames.values()) {
      this.ask(bc, {}, "Vimma:GrepEnd").catch(() => {});
    }
  }

  /**
   * Closes the picker; focus returns where it was.
   * @param {{ keepFrames?: boolean, tabChanged?: boolean }} [options]
   */
  close({ keepFrames = false, tabChanged = false } = {}) {
    if (!this.isOpen) return;
    clearTimeout(this.timer);
    clearTimeout(this.previewTimer);
    this.gen++;
    this.ui.close();
    this.state = null;
    GrepMatcher.drop(this.closedKey);
    if (!keepFrames) this.endFrames();
    const opener = this.opener;
    this.opener = null;
    if (!keepFrames) {
      if (tabChanged || !opener?.isConnected) gBrowserOf(this.win).selectedBrowser.focus();
      else /** @type {HTMLElement} */ (opener).focus();
    }
    this.host.emit();
  }

  /** VimmaHost.uninit */
  destroy() {
    this.close();
    this.setList(null);
    this.win.removeEventListener("TabClose", this.onTabClose);
    this.watched.clear();
    this.ui.destroy();
    this.frames.clear();
  }
}

export { GREP_CAPS };

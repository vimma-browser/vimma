/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Split panes in one window (docs/specs/m4-split-panes.md sub-spec 2, ADR-013). Holds the
// window's pane tree (vimma-core panes.mjs) and mirrors it onto ONE Firefox split view:
// planSplit says which tabs join, leave, move, show, hide, (de)activate; layout() gives each
// pane its rectangle. Firefox's wrapper keeps deciding which browsers are live and which tab is
// selected; the tree decides the geometry. The tree shown is the active workspace's; a switch
// parks it under the workspace left and brings back the target's (`swap`, m3-workspaces 2b; M4
// sub-spec 6), and a restore hands every workspace's tree back (`restore`). The pane keys
// (host/pane-ops.mjs, sub-specs 3 and 5) call split / focus / close / zoom / swapPane / resize;
// nothing here binds a key. A split made outside Vimma (Firefox's own split-view commands, an
// extension, a restored Firefox session) is adopted (`adopt`, sub-spec 6): DOM wins for those,
// core wins for everything Vimma does.

import { mergeWithDefaults } from "../core/config.mjs";
import {
  closePane,
  createPanes,
  createRow,
  focus as focusToward,
  focusPane,
  hideView,
  isHidden as isHiddenView,
  layout,
  leaves,
  paneOfTab,
  pickTab,
  showView,
  resize,
  split,
  splitRefusal,
  swap as swapToward,
  toggleZoom,
} from "../core/panes.mjs";
import {
  arrange,
  dwindleDirection,
  layoutRefusal,
  nextLayout,
  repane,
  repaneRefusal,
} from "../core/layouts.mjs";
import { planSplit } from "../core/splitplan.mjs";
import {
  MAX_SPLITS_DEFAULT,
  hiddenSplitRefusal,
  newSplit,
  removeSplitTab,
  splitsFromPanes,
  updateSplit,
} from "../core/splits.mjs";
import {
  applyLayout,
  clearLayout,
  contentArea,
  isHidden,
  loadSheet,
  setHidden,
} from "./layout.mjs";

/**
 * @import { Direction, Panes, ResizeDirection, SplitDirection, SplitRefusal }
 *   from "../core/panes.mjs"
 */
/** @import { SplitPlan } from "../core/splitplan.mjs" */
/** @import { LayoutName } from "../core/layouts.mjs" */
/** @import { NumberedSplit, Splits } from "../core/splits.mjs" */

/**
 * @typedef {Element & { linkedPanel: string, label: string, pinned: boolean, closing?: boolean,
 *   selected: boolean, splitview: Wrapper | null, hidden: boolean,
 *   linkedBrowser: { docShellIsActive: boolean } }} Tab
 * @typedef {Element & { tabs: Tab[], addTabs: (tabs: Tab[]) => void,
 *   unsplitTabs: () => void }} Wrapper
 * @typedef {{ tabs: Tab[], selectedTab: Tab, tabContainer: Element, splitViews: Wrapper[],
 *   addTabSplitView: (tabs: Tab[], options?: object) => Wrapper,
 *   addTrustedTab: (url: string, options?: object) => Tab, unpinTab: (tab: Tab) => void }} TabBrowser
 * @typedef {{ ok: true } | { ok: false, reason: string }} PaneResult
 * @typedef {object} Adoption  how splits made outside Vimma map onto workspaces (WindowWorkspaces)
 * @property {(tab: Tab) => string | undefined} workspaceOf  the tab's workspace id; undefined:
 *   not known yet (a tab the workspaces have not taken in), so the split waits
 * @property {() => string} active  the shown workspace's id
 * @property {() => boolean} busy  a switch or restore is under way: adopt nothing until after it
 * @property {(text: string) => void} notify  the status-bar notice
 */
/**
 * A split of the shown workspace other than the current one (docs/specs/multiple-splits.md
 * decision 16): its tree, its own Firefox wrapper, which Firefox suspends while another tab is
 * selected, and the tabs whose panels carry its geometry.
 * @typedef {{ panes: Panes, wrapper: Wrapper | null, laidOut: Set<Tab> }} Slot
 */

/** The notices for splits made outside Vimma that Vimma undoes (m3-workspaces decision 14). */
export const SPANS_WORKSPACES = "split undone: its tabs are in different workspaces";
/**
 * A second split made by Firefox's own commands in a workspace that has one: Vimma makes further
 * splits from the side panel's marks only (docs/specs/multiple-splits.md decision 5), so the
 * notice names that way.
 */
export const SECOND_SPLIT = "split undone: mark tabs in ctrl+b b for another split";

/** Firefox's split-view events that may mean a split made or changed outside Vimma. */
const SPLIT_EVENTS = ["SplitViewCreated", "SplitViewTabChange", "SplitViewRemoved"];
/** Every window event a PaneView listens to (the split contract test turns them off). */
export const PANE_VIEW_EVENTS = Object.freeze([
  "TabOpen",
  "TabClose",
  "TabSplitViewActivate",
  "TabSelect",
  ...SPLIT_EVENTS,
  "visibilitychange",
]);

/**
 * Whether `text` is the hidden-split refusal (core's `hiddenSplitRefusal`), which the host keeps
 * on screen until the next key (docs/specs/multiple-splits.md decision 4).
 * @param {string} text
 */
export function isHiddenRefusal(text) {
  return /^split S\d is hidden: /.test(text);
}

/**
 * A split's tree without its number, as PaneView keeps trees.
 * @param {NumberedSplit} split
 * @returns {Panes}
 */
function treeOf(split) {
  /** @type {Record<string, unknown>} */
  const tree = { ...split };
  delete tree.number;
  return /** @type {Panes} */ (Object.freeze(tree));
}

/**
 * Whether two trees show different tabs.
 * @param {Panes} a
 * @param {Panes} b
 */
function otherTabs(a, b) {
  const tabs = (/** @type {Panes} */ p) =>
    leaves(p)
      .map((l) => l.tab)
      .sort()
      .join(" ");
  return tabs(a) !== tabs(b);
}

/** Dwindle's area while the content area has no size yet: wide, as most windows are. */
const WIDE = Object.freeze({ x: 0, y: 0, width: 16, height: 9 });

/** Tabs labelled for a11y by us (the third pane on; Firefox labels the first two). */
const LABEL_ATTR = "vimma-pane-label";

/** @param {BrowserWindow} win */
function gBrowserOf(win) {
  return /** @type {{ gBrowser: TabBrowser }} */ (/** @type {unknown} */ (win)).gBrowser;
}

export class PaneView {
  /** @type {BrowserWindow} */
  #win;
  /** @type {Panes | null} null: one pane, the selected tab, no split */
  #panes = null;
  /** @type {number} config `[panes] max`, passed to core */
  #max;
  /**
   * config `[panes] layout`: where `newPane` (a pane without a direction) goes
   * (docs/specs/tiling-layouts.md)
   * @type {"dwindle" | "manual"}
   */
  mode;
  /** @type {number} config `[panes] main_size` as a share: the main-* presets' main pane */
  mainSize;
  /** @type {Wrapper | null} the split view this window's panes live in */
  #wrapper = null;
  /** @type {ResizeObserver | null} */
  #resize = null;
  #reconciling = false;
  #scheduled = false;
  /** @type {Set<Tab>} tabs whose panel carries our geometry */
  #laidOut = new Set();
  /**
   * The current tree's split number (docs/specs/multiple-splits.md): the current tree is the
   * split shown, else the split shown last, kept as a hidden view.
   */
  #number = 1;
  /**
   * The shown workspace's other splits by number, each hidden. Never non-empty without a
   * current tree: when that ends, one of these takes its place.
   * @type {Map<number, Slot>}
   */
  #others = new Map();
  /** Splits of #others that ended on a TabClose: their wrapper and geometry go next reconcile. */
  /** @type {Slot[]} */
  #ended = [];
  /** config `[panes] max_splits` (docs/specs/multiple-splits.md decision 7) */
  maxSplits = MAX_SPLITS_DEFAULT;
  /**
   * @type {Map<string, Slot & { number: number, others: Map<number, Slot> }>}
   */
  #parked = new Map();
  /**
   * The tab whose TabOpen came in this task: its TabSelect is a new foreground tab, not a pick
   * (docs/specs/side-panel-unsplit.md decision 22); cleared in a microtask.
   * @type {Tab | null}
   */
  #opened = null;
  /** Told after every reconcile (WindowWorkspaces saves the window's snapshot, m3 sub-spec 3). */
  /** @type {(() => void) | null} */
  onChange = null;
  /**
   * Whether a tab selected outside the panes may show in the focused pane; WindowWorkspaces
   * allows only the shown workspace's tabs, and none while it switches or restores. Unset: any.
   * @type {((tab: Tab) => boolean) | null}
   */
  accepts = null;
  /**
   * Set by WindowWorkspaces: workspaces for adopting splits made outside Vimma. Unset: the window
   * is one workspace, and a split is adopted when nothing else is split.
   * @type {Adoption | null}
   */
  adoption = null;

  /**
   * @param {BrowserWindow} win
   * @param {{ max?: number }} [options]  `max`: config `[panes] max` (default: the config default)
   */
  constructor(win, { max = mergeWithDefaults({}).panes.max } = {}) {
    const defaults = mergeWithDefaults({}).panes;
    this.#win = win;
    this.#max = max;
    this.mode = defaults.layout;
    this.mainSize = defaults.mainSize;
    loadSheet(win);
    // On the window: this runs before gBrowser exists (vimma.js), and tab events bubble to it.
    win.addEventListener("TabClose", this);
    // A new foreground tab's TabOpen comes just before its TabSelect, in the same task (addTab
    // selects it right away; WindowWorkspaces' #adopt relies on the same order).
    win.addEventListener("TabOpen", this);
    // Firefox re-runs showSplitViewPanels (every member active) whenever the split activates
    // again, e.g. after a TabSelect; reconcile then deactivates the zoomed-away ones again.
    win.addEventListener("TabSplitViewActivate", this);
    // A click or focus in a panel (MozTabpanels), the picker, ctrl+tab, alt+N, an extension:
    // whatever selects a pane's tab moves core's focus there (sub-spec 4).
    win.addEventListener("TabSelect", this);
    // Splits made or changed outside Vimma (sub-spec 6): Firefox's addTabSplitView fires
    // SplitViewCreated; its wrapper fires SplitViewTabChange on any membership change (session
    // restore builds wrappers without SplitViewCreated) and SplitViewRemoved once dissolved.
    for (const type of SPLIT_EVENTS) win.addEventListener(type, this);
    // Tabbrowser's on_visibilitychange (a document listener, so it runs before this window one)
    // wakes every split browser when no async tab switcher exists, and does not look at the
    // event's target: an in-process page (the start page, chrome://) that a zoom or a hidden view
    // just put to sleep bubbles its own visibilitychange up to it, and so does the window being
    // shown again. Putting those panes back to sleep in the same dispatch means no paint sees
    // them awake, and their next visibility update finds no change, so no new event follows.
    win.addEventListener("visibilitychange", this);
  }

  destroy() {
    for (const type of PANE_VIEW_EVENTS) this.#win.removeEventListener(type, this);
    this.#resize?.disconnect();
    this.#resize = null;
  }

  /** @param {Event} e */
  handleEvent(e) {
    if (e.type === "TabOpen") this.#onTabOpen(/** @type {Tab} */ (e.target));
    else if (e.type === "TabClose") this.#onTabClose(/** @type {Tab} */ (e.target));
    else if (e.type === "TabSelect") this.#onTabSelect(/** @type {CustomEvent} */ (e));
    else if (e.type === "visibilitychange") this.#keepAsleep();
    // TabSplitViewDeactivate is not listened to: the old wrapper's arrives late after a rebuild
    // and lists the kept members too (sub-spec 1), so it carries nothing to act on.
    else if (e.type === "TabSplitViewActivate" && !this.#reconciling) this.#schedule();
    // Our own reconcile's come late too (the wrapper's MutationObserver): adopt compares the DOM
    // with the trees, so those find nothing to do.
    else if (SPLIT_EVENTS.includes(e.type) && !this.#reconciling) this.#schedule();
  }

  /** The window's pane tree, null with a single pane (for tests and sub-spec 3). */
  get panes() {
    return this.#panes;
  }

  /**
   * Whether the tree is kept as a hidden view while another tab shows alone
   * (docs/specs/side-panel-unsplit.md decision 20).
   */
  get hidden() {
    return !!this.#panes && isHiddenView(this.#panes);
  }

  /**
   * The shown workspace's splits (core's model, docs/specs/multiple-splits.md decision 1): the
   * current tree with its number, shown unless a hidden view, and every other split, hidden.
   * @returns {Splits}
   */
  get splits() {
    return this.#modelOf(this.#panes, this.#number, this.#others);
  }

  /**
   * The splits parked under workspace `id` by `swap`; none for a workspace without a split.
   * @param {string} id
   * @returns {Splits}
   */
  parkedSplits(id) {
    const p = this.#parked.get(id);
    return p ? this.#modelOf(p.panes, p.number, p.others) : splitsFromPanes(null);
  }

  /**
   * @param {Panes | null} panes
   * @param {number} number
   * @param {Map<number, Slot>} others
   * @returns {Splits}
   */
  #modelOf(panes, number, others) {
    if (!panes) return splitsFromPanes(null);
    const numbered = (/** @type {Panes} */ p, /** @type {number} */ n) =>
      /** @type {NumberedSplit} */ (Object.freeze({ ...showView(p), number: n }));
    const list = [numbered(panes, number), ...[...others].map(([n, s]) => numbered(s.panes, n))];
    list.sort((a, b) => a.number - b.number);
    return Object.freeze({
      splits: Object.freeze(list),
      shown: isHiddenView(panes) ? null : number,
      last: number,
    });
  }

  /**
   * Makes the shown workspace's splits `next` (core's model): the current tree becomes the split
   * shown, else the one shown last. A split that ended loses its wrapper and geometry; a hidden
   * one whose tabs changed loses its wrapper, rebuilt when it shows again. Touches Firefox only
   * for those; the caller reconciles.
   * @param {Splits} next
   */
  #use(next) {
    /** @type {Map<number, Slot>} */
    const slots = new Map(this.#others);
    if (this.#panes) {
      slots.set(this.#number, {
        panes: this.#panes,
        wrapper: this.#wrapper,
        laidOut: this.#laidOut,
      });
    }
    const want = next.shown ?? next.last ?? next.splits[0]?.number ?? null;
    const kept = new Set(next.splits.map((x) => x.number));
    for (const [n, slot] of slots) {
      if (!kept.has(n)) this.#dissolve(slot);
    }
    this.#others = new Map();
    /** @type {Slot | null} */
    let current = null;
    for (const x of next.splits) {
      const tree = treeOf(x);
      const was = slots.get(x.number);
      /** @type {Slot} */
      const slot = {
        panes: tree,
        wrapper: was?.wrapper ?? null,
        laidOut: was?.laidOut ?? new Set(),
      };
      if (x.number === want) {
        current = slot;
        continue;
      }
      if (was && otherTabs(was.panes, tree)) {
        this.#dissolve(slot);
        slot.wrapper = null;
        slot.laidOut = new Set();
      }
      this.#others.set(x.number, slot);
    }
    if (want !== this.#number || !current) {
      this.#resize?.disconnect();
      this.#resize = null;
    }
    this.#panes = current && (next.shown === null ? hideView(current.panes) : current.panes);
    this.#wrapper = current?.wrapper ?? null;
    this.#laidOut = current?.laidOut ?? new Set();
    this.#number = want ?? 1;
  }

  /**
   * A split that is no longer one, or no longer the same: its Firefox wrapper is undone and its
   * panels lose Vimma's geometry. Its tabs stay open.
   * @param {Slot} slot
   */
  #dissolve(slot) {
    const wrapper = this.#wrapperOf(slot);
    if (wrapper?.isConnected) wrapper.unsplitTabs();
    const live = [...slot.laidOut].filter((t) => t.isConnected && !t.closing);
    if (live.length) clearLayout(this.#win, live, { all: false });
  }

  /**
   * A slot's wrapper: the one it kept, else the one its tabs are in.
   * @param {Slot} slot
   * @returns {Wrapper | null}
   */
  #wrapperOf(slot) {
    if (slot.wrapper?.isConnected && slot.wrapper.tabs.length) return slot.wrapper;
    const ids = leaves(slot.panes).map((l) => l.tab);
    return ids.map((id) => this.#tab(id)?.splitview).find(Boolean) ?? null;
  }

  /**
   * The number of the hidden split (not the current one) showing `tabId`, if any.
   * @param {string} tabId
   */
  #otherOf(tabId) {
    for (const [n, slot] of this.#others) if (paneOfTab(slot.panes, tabId)) return n;
    return undefined;
  }

  /**
   * Shows hidden split `number` with focus on `tabId`'s pane (behaviour 2): the current tree is
   * kept among the others, as it was. Returns the tree put away, whose pages then sleep.
   * @param {number} number
   * @param {string} tabId
   * @returns {Panes | null}
   */
  #bring(number, tabId) {
    const slot = /** @type {Slot} */ (this.#others.get(number));
    this.#others.delete(number);
    const away = this.#panes;
    if (away) {
      this.#others.set(this.#number, {
        panes: showView(away),
        wrapper: this.#wrapper,
        laidOut: this.#laidOut,
      });
    }
    const pane = /** @type {string} */ (paneOfTab(slot.panes, tabId));
    this.#panes = focusPane(slot.panes, pane);
    this.#wrapper = slot.wrapper;
    this.#laidOut = slot.laidOut;
    this.#number = number;
    this.#resize?.disconnect();
    this.#resize = null;
    return away;
  }

  /** The refusal of a new pane on a lone tab, naming the split shown last. */
  #hiddenReason() {
    return hiddenSplitRefusal(this.#number);
  }

  /** @param {number} max  config `[panes] max` */
  set max(max) {
    this.#max = max;
  }

  get max() {
    return this.#max;
  }

  /**
   * A workspace switch (m3-workspaces 2b, decision 14): parks the tree shown now under `from`
   * and brings back `to`'s (none: one pane), touching nothing in Firefox. The switch then hides
   * the parked wrapper as a whole and selects `to`'s tab; `reconcile()` after it lays out the
   * tree that came back. A parked tree whose tabs closed meanwhile shrinks on that reconcile.
   * @param {string} from
   * @param {string} to
   */
  swap(from, to) {
    if (from === to) return;
    if (this.#panes) {
      this.#parked.set(from, {
        panes: this.#panes,
        wrapper: this.#wrapper,
        laidOut: this.#laidOut,
        // Every split is parked with its number (multiple-splits behaviour 10).
        number: this.#number,
        others: this.#others,
      });
    } else {
      this.#parked.delete(from);
    }
    const back = this.#parked.get(to);
    this.#parked.delete(to);
    this.#panes = back?.panes ?? null;
    this.#wrapper = back?.wrapper ?? null;
    this.#laidOut = back?.laidOut ?? new Set();
    this.#number = back?.number ?? 1;
    this.#others = back?.others ?? new Map();
    this.#resize?.disconnect();
    this.#resize = null;
  }

  /**
   * The tree parked under workspace `id` by `swap`, or null (none, or one pane).
   * @param {string} id
   * @returns {Panes | null}
   */
  parked(id) {
    return this.#parked.get(id)?.panes ?? null;
  }

  /**
   * A session restore (m3-workspaces sub-spec 3): `trees` replaces every workspace's tree, the
   * one of `active` shown, the others parked. Like `swap`, it touches nothing in Firefox; the
   * caller's `reconcile()` lays it out (SessionStore restored the wrappers; any that differ are
   * rebuilt). A workspace's value is its one tree, or its splits (docs/specs/multiple-splits.md
   * behaviour 10): the shown one current, else the one shown last as a hidden view.
   * @param {Map<string, Panes | Splits>} trees
   * @param {string} active
   */
  restore(trees, active) {
    this.#wrapper = null;
    this.#laidOut = new Set();
    this.#parked = new Map();
    this.#panes = null;
    this.#number = 1;
    this.#others = new Map();
    for (const [id, value] of trees) {
      if (id === active) continue;
      this.#use("splits" in value ? value : splitsFromPanes(value));
      if (this.#panes) {
        this.#parked.set(id, {
          panes: this.#panes,
          wrapper: null,
          laidOut: new Set(),
          number: this.#number,
          others: this.#others,
        });
      }
      this.#panes = null;
      this.#others = new Map();
    }
    const shown = trees.get(active);
    this.#use(shown ? ("splits" in shown ? shown : splitsFromPanes(shown)) : splitsFromPanes(null));
  }

  /**
   * Closes the pane showing `tab`, wherever focus is; its tab stays open (not shown). For a tab
   * leaving the workspace (WindowWorkspaces' moveTab). No pane of `tab`: nothing.
   * @param {Tab} tab
   */
  release(tab) {
    const other = this.#otherOf(tab.linkedPanel);
    if (other !== undefined) {
      this.#use(removeSplitTab(this.splits, tab.linkedPanel));
      return;
    }
    const pane = this.#panes && paneOfTab(this.#panes, tab.linkedPanel);
    if (this.#panes && pane) this.#set(closePane(this.#panes, pane));
  }

  /**
   * Brings splits made outside Vimma into line (sub-spec 6; DOM wins for those). For the shown
   * tree's wrapper: dissolved, the panes close; a tab that left it closes its pane; a tab added
   * to it joins as a pane on the right (core's split, so within `[panes] max`; past it, or of
   * another workspace, reconcile drops it again). Any other wrapper (no tab in a tree): across
   * workspaces, or a second split in a workspace that has one, it is unsplit with a notice
   * (m3-workspaces decision 14; its tabs stay where they are). The shown workspace's split of the
   * selected tab becomes its tree: a row in the wrapper's order, with the share Firefox's splitter
   * left on the first panel, focus on the selected tab. A split of background tabs waits for its
   * selection (TabSplitViewActivate); one of another workspace for that workspace's turn (the
   * switch calls this). Then call reconcile. Idempotent.
   */
  adopt() {
    if (this.#reconciling || this.adoption?.busy()) return;
    this.#reconciling = true;
    try {
      this.#adoptOwn();
      this.#adoptOthers();
    } finally {
      this.#reconciling = false;
    }
  }

  /** Wrapper membership changed outside Vimma for the shown tree. */
  #adoptOwn() {
    let panes = this.#panes;
    if (!panes) return;
    const live = leaves(panes).filter((l) => this.#tab(l.tab));
    const wrapper = this.#currentWrapper();
    if (!wrapper) {
      // Every pane's tab is out of any split: dissolved outside Vimma (Vimma's own leaves
      // rebuild in one task). The focused tab stays selected.
      if (live.length >= 2) this.#panes = null;
      return;
    }
    const inWrapper = new Set(wrapper.tabs.filter((t) => !t.closing).map((t) => t.linkedPanel));
    for (const leaf of live) {
      if (panes && !inWrapper.has(leaf.tab)) {
        panes = leaves(panes).length > 2 ? closePane(panes, leaf.pane) : null;
      }
    }
    const active = this.adoption?.active();
    for (const t of this.#members()) {
      if (!panes || paneOfTab(panes, t.linkedPanel)) continue;
      if (this.adoption && this.adoption.workspaceOf(t) !== active) continue;
      const last = leaves(panes).at(-1);
      if (last) panes = split(panes, last.pane, "vertical", t.linkedPanel, { max: this.#max });
    }
    this.#panes = panes;
  }

  /** Wrappers with no tab in any tree: unsplit, adopt, or leave for later. */
  #adoptOthers() {
    const gBrowser = gBrowserOf(this.#win);
    const slots = [{ panes: this.#panes, others: this.#others }, ...this.#parked.values()];
    const ours = new Set(
      slots
        .flatMap((p) => [p.panes, ...[...p.others.values()].map((s) => s.panes)])
        .flatMap((p) => (p ? leaves(p).map((l) => l.tab) : [])),
    );
    const notify = (/** @type {string} */ text) => this.adoption?.notify(text);
    for (const wrapper of [...(gBrowser.splitViews ?? [])]) {
      const tabs = wrapper.tabs.filter((t) => !t.closing);
      if (!wrapper.isConnected || !tabs.length) continue;
      if (tabs.some((t) => t.linkedPanel && ours.has(t.linkedPanel))) continue;
      const ids = tabs.map((t) => this.adoption?.workspaceOf(t) ?? (this.adoption ? "" : "-"));
      if (ids.includes("")) continue;
      if (new Set(ids).size > 1) {
        wrapper.unsplitTabs();
        notify(SPANS_WORKSPACES);
        continue;
      }
      const ws = /** @type {string} */ (ids[0]);
      const shownHere = !this.adoption || ws === this.adoption.active();
      const hasTree = shownHere ? !!this.#panes : this.#parked.has(ws);
      if (hasTree) {
        wrapper.unsplitTabs();
        notify(SECOND_SPLIT);
        continue;
      }
      const selected = gBrowser.selectedTab;
      if (!shownHere || !tabs.includes(selected) || tabs.some((t) => !t.linkedPanel)) continue;
      this.#panes = createRow(
        tabs.map((t) => t.linkedPanel),
        { ratios: this.#shares(tabs), focus: selected.linkedPanel },
      );
      this.#wrapper = wrapper;
    }
  }

  /**
   * The shares a Firefox split shows: its splitter sizes the first panel (a `width` attribute)
   * and the second takes the rest; it lays out two columns only. Unknown: undefined (equal).
   * @param {Tab[]} tabs
   * @returns {number[] | undefined}
   */
  #shares(tabs) {
    if (tabs.length !== 2) return undefined;
    const doc = this.#win.document;
    const first = Number(doc.getElementById(tabs[0]?.linkedPanel ?? "")?.getAttribute("width"));
    const total = doc.getElementById("tabbrowser-tabpanels")?.getBoundingClientRect().width ?? 0;
    if (!(first > 0) || !(total > first)) return undefined;
    return [first, total - first];
  }

  /**
   * Splits the focused pane: `vertical` puts the new pane right of it, `horizontal` below. The
   * new pane shows `tab` (default: a new tab on the new-tab page) and gets focus. Refused, with
   * core's reason, past `[panes] max` or with no space; a refused split opens no tab.
   * @param {SplitDirection} direction
   * @param {{ tab?: Tab }} [options]
   * @returns {PaneResult}
   */
  split(direction, { tab } = {}) {
    if (this.hidden) return { ok: false, reason: this.#hiddenReason() };
    const gBrowser = gBrowserOf(this.#win);
    const current = this.#panes ?? createPanes(gBrowser.selectedTab.linkedPanel);
    const refusal = /** @type {SplitRefusal | null} */ (
      splitRefusal(current, current.focus, direction, { max: this.#max })
    );
    if (refusal) return { ok: false, reason: refusal.message };
    const fresh =
      tab ??
      gBrowser.addTrustedTab(this.#win.BROWSER_NEW_TAB_URL, {
        inBackground: true,
      });
    this.#set(split(current, current.focus, direction, fresh.linkedPanel, { max: this.#max }));
    return { ok: true };
  }

  /**
   * A pane opened without a direction (`ctrl+b enter`, docs/specs/tiling-layouts.md): with
   * `[panes] layout = "dwindle"` it splits the focused pane along its longer side on screen
   * (side by side when at least as wide as tall), with `"manual"` to the right; then exactly as
   * `split`.
   * @param {{ tab?: Tab }} [options]
   * @returns {PaneResult}
   */
  newPane(options = {}) {
    if (this.hidden) return { ok: false, reason: this.#hiddenReason() };
    const current = this.#panes ?? createPanes(gBrowserOf(this.#win).selectedTab.linkedPanel);
    const direction =
      this.mode === "manual" ? "vertical" : dwindleDirection(current, this.#area() ?? WIDE);
    return this.split(direction, options);
  }

  /**
   * Rearranges the panes into preset `name` (core's `arrange`): the same pages in a new tree,
   * moved, never reloaded; focus stays, a zoom ends. One pane, or no space: refused with why.
   * @param {LayoutName} name
   * @returns {PaneResult}
   */
  arrange(name) {
    if (!this.#panes) return { ok: false, reason: "only one pane" };
    const options = { area: this.#area(), mainSize: this.mainSize };
    const refusal = layoutRefusal(this.#panes, name, options);
    if (refusal) return { ok: false, reason: refusal.message };
    this.#set(arrange(this.#panes, name, options));
    return { ok: true };
  }

  /**
   * Shows `tabs` (reading order) as the panes, replacing the split
   * (docs/specs/m4-side-panel-multiselect.md): arranged as the stored preset, else
   * `[panes] layout`; focus on `focus`. Tabs of the old split that are not listed leave it and
   * stay open; pages move, never reload. When none joins, the panes left keep their shape and
   * sizes, each removed one closed as `close` would (docs/specs/side-panel-unsplit.md decision
   * 15). Past `[panes] max`, or with no space: refused, nothing changes. With `alone`, the new
   * tree is kept as a hidden view and that tab shows by itself (side-panel-unsplit decision 25).
   * With several splits (docs/specs/multiple-splits.md): on a lone tab the tabs make a new split
   * with the lowest free number, refused at `[panes] max_splits` (decision 5); a tab of a hidden
   * split leaves it, which ends it when one pane is left (decision 6).
   * @param {Tab[]} tabs  two or more, each with its panel
   * @param {Tab} focus
   * @param {{ alone?: Tab }} [options]
   * @returns {PaneResult}
   */
  showTabs(tabs, focus, { alone } = {}) {
    const ids = tabs.map((t) => t.linkedPanel);
    const fresh = this.hidden;
    const base = fresh ? null : this.#panes;
    const options = {
      preset: base?.layout,
      mode: this.mode,
      focus: focus.linkedPanel,
      area: this.#area(),
      mainSize: this.mainSize,
      max: this.#max,
    };
    const refusal = repaneRefusal(base, ids, options);
    if (refusal) return { ok: false, reason: refusal.message };
    let next = repane(base, ids, options);
    if (fresh) {
      const made = newSplit(this.splits, ids, { max: this.maxSplits, focus: focus.linkedPanel });
      if (made.refusal) return { ok: false, reason: made.refusal };
      this.#use(updateSplit(made.splits, /** @type {number} */ (made.splits.shown), next));
      next = /** @type {Panes} */ (this.#panes);
    } else if (ids.some((id) => this.#otherOf(id) !== undefined)) {
      let model = this.splits;
      for (const id of ids) if (this.#otherOf(id) !== undefined) model = removeSplitTab(model, id);
      this.#use(model);
    }
    if (!alone) {
      this.#set(showView(next));
      return { ok: true };
    }
    // Select first, unseen by #onTabSelect, then reconcile: the rebuilt wrapper never shows.
    this.#panes = hideView(next);
    this.#reconciling = true;
    try {
      this.#select(alone);
    } finally {
      this.#reconciling = false;
    }
    this.reconcile();
    return { ok: true };
  }

  /**
   * Ends the split and shows `tab` alone, selected (docs/specs/side-panel-unsplit.md): every
   * other pane's tab stays open. Without a split it only selects `tab`.
   * @param {Tab} tab
   * @returns {PaneResult}
   */
  showAlone(tab) {
    if (this.#panes) this.#set(null);
    this.#select(tab);
    return { ok: true };
  }

  /**
   * The preset after the last one applied (tmux's next-layout); the first without one.
   * @returns {PaneResult & { layout?: LayoutName }}
   */
  nextLayout() {
    if (!this.#panes) return { ok: false, reason: "only one pane" };
    const name = nextLayout(this.#panes.layout);
    return { ...this.arrange(name), layout: name };
  }

  /** The content area in px, or undefined while it has no size (dwindle then assumes wide). */
  #area() {
    const area = contentArea(this.#win);
    return area.width > 0 && area.height > 0 ? area : undefined;
  }

  /**
   * Closes the focused pane; its tab stays open (not shown). The last pane cannot close.
   * @returns {PaneResult}
   */
  close() {
    if (!this.#panes) return { ok: false, reason: "cannot close the last pane" };
    this.#set(closePane(this.#panes, this.#panes.focus));
    return { ok: true };
  }

  /**
   * Moves focus to the focused pane's geometric neighbour (core: the most recently used one when
   * several touch), which unzooms; with no neighbour nothing changes, the zoom included.
   * @param {Direction} direction
   * @returns {PaneResult}
   */
  focus(direction) {
    if (!this.#panes) return { ok: true };
    const next = focusToward(this.#panes, direction);
    if (next !== this.#panes) this.#set(next);
    return { ok: true };
  }

  /**
   * Zooms the focused pane to the whole content area, or unzooms.
   * @returns {PaneResult}
   */
  zoom() {
    if (!this.#panes) return { ok: false, reason: "only one pane" };
    this.#set(toggleZoom(this.#panes));
    return { ok: true };
  }

  /**
   * Swaps the focused pane with its geometric neighbour (core `swap`); focus stays with the
   * moved pane, and any zoom ends. No neighbour: nothing changes. (`swap` is the workspace park.)
   * @param {Direction} direction
   * @returns {PaneResult}
   */
  swapPane(direction) {
    if (!this.#panes) return { ok: true };
    const next = swapToward(this.#panes, direction);
    if (next !== this.#panes) this.#set(next);
    return { ok: true };
  }

  /**
   * Grows or shrinks the focused pane by `amount` (a share of its split, e.g. 0.05), clamped at
   * MIN_RATIO by core. Nothing to resize on that axis, or at the clamp: nothing changes.
   * @param {ResizeDirection} direction
   * @param {number} amount
   * @returns {PaneResult}
   */
  resize(direction, amount) {
    if (!this.#panes) return { ok: false, reason: "only one pane" };
    const next = resize(this.#panes, direction, amount);
    if (next !== this.#panes) this.#set(next);
    return { ok: true };
  }

  /**
   * Replaces the tree and mirrors it. One leaf is no split.
   * @param {Panes | null} panes
   */
  #set(panes) {
    const order = panes ? leaves(panes) : [];
    this.#panes = order.length >= 2 ? panes : null;
    this.reconcile();
    // Down to one pane: the split is gone and the pane left shows its tab, selected.
    const last = order.length === 1 && order[0] ? this.#tab(order[0].tab) : null;
    if (last) this.#select(last);
  }

  /** @param {Tab} tab */
  #onTabOpen(tab) {
    this.#opened = tab;
    this.#win.queueMicrotask(() => {
      if (this.#opened === tab) this.#opened = null;
    });
  }

  /** @param {Tab} tab */
  #onTabClose(tab) {
    // A tab of a hidden split (multiple-splits): its pane closes there, as `ctrl+b x` closes it,
    // and a split left with one pane ends once the tab is gone.
    const other = this.#otherOf(tab.linkedPanel);
    if (other !== undefined) {
      const slot = /** @type {Slot} */ (this.#others.get(other));
      if (leaves(slot.panes).length > 2) {
        const pane = /** @type {string} */ (paneOfTab(slot.panes, tab.linkedPanel));
        slot.panes = closePane(slot.panes, pane);
      } else {
        this.#others.delete(other);
        this.#ended.push(slot);
      }
      this.#schedule();
      return;
    }
    const panes = this.#panes;
    const pane = panes && paneOfTab(panes, tab.linkedPanel);
    if (!panes || !pane) return;
    this.#panes = leaves(panes).length > 2 ? closePane(panes, pane) : null;
    // The current split ended with others kept: one takes its place now, so the model, a save
    // or a workspace switch before the reconcile never loses them; the ended one's wrapper and
    // geometry go at the reconcile.
    if (!this.#panes && this.#others.size) {
      this.#ended.push({ panes, wrapper: this.#wrapper, laidOut: this.#laidOut });
      this.#promote();
    }
    // Not while Firefox is removing the tab: once it is gone, in a later task.
    this.#schedule();
  }

  /**
   * The lowest other split becomes the current tree, as the split shown last, hidden, so a
   * workspace with splits always has a current tree (and `]s` a way back). None: nothing.
   */
  #promote() {
    const [first] = [...this.#others.keys()].sort((a, b) => a - b);
    if (first === undefined) return;
    const slot = /** @type {Slot} */ (this.#others.get(first));
    this.#others.delete(first);
    this.#panes = hideView(slot.panes);
    this.#wrapper = slot.wrapper;
    this.#laidOut = slot.laidOut;
    this.#number = first;
    this.#resize?.disconnect();
    this.#resize = null;
  }

  /**
   * A tab was selected from outside Vimma's pane ops (core's `pickTab`,
   * docs/specs/side-panel-unsplit.md decisions 21-23). A pane's tab: focus that pane (core
   * updates the MRU and ends any zoom, as a pane move does), and a hidden view shows again, whole.
   * A new foreground tab (its TabOpen came in this task) the workspace may show, while the view
   * shows: it replaces the focused pane's tab (core's `setPaneTab`), the split rebuilt around it
   * in this same task, so no paint sees Firefox's suspended split; the old tab stays open. Any
   * other tab (a pick: the picker, ctrl+tab, alt+N, ctrl+b n, a click, a pinned tab): it shows
   * alone, as Firefox's split view does, and the tree is kept as a hidden view. Then reconcile.
   * Not from our own selection (the re-entry flag), not for a tab of another workspace or while
   * WindowWorkspaces switches (`accepts`: the switch parks the tree as it is), and not while
   * Firefox picks a successor for a closing tab: the TabClose reconcile settles it.
   * @param {CustomEvent} e
   */
  #onTabSelect(e) {
    const tab = /** @type {Tab} */ (e.target);
    const opened = this.#opened === tab;
    this.#opened = null;
    const panes = this.#panes;
    if (!panes || this.#reconciling) return;
    if (/** @type {Tab | undefined} */ (e.detail?.previousTab)?.closing) return;
    const inTree = !!tab.linkedPanel && paneOfTab(panes, tab.linkedPanel) !== undefined;
    if (!inTree && !tab.pinned && this.accepts && !this.accepts(tab)) return;
    // A tab of a hidden split shows that split whole (multiple-splits behaviour 2): reconcile
    // brings it forward.
    if (tab.linkedPanel && this.#otherOf(tab.linkedPanel) !== undefined) {
      this.reconcile();
      return;
    }
    const { panes: next, change } = pickTab(panes, tab.linkedPanel || "", {
      opened,
      canJoin: this.#canShow(tab),
    });
    if (change === "none") return;
    this.#panes = next;
    this.reconcile();
  }

  /**
   * Whether `tab`, selected outside the panes, may replace the focused pane's tab. A pinned tab
   * cannot join a split (and is in every workspace): Firefox shows it alone, the tree waits.
   * @param {Tab} tab
   */
  #canShow(tab) {
    if (tab.pinned || tab.closing || !tab.linkedPanel) return false;
    return this.accepts?.(tab) ?? true;
  }

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#win.setTimeout(() => {
      this.#scheduled = false;
      this.adopt();
      this.reconcile();
    }, 0);
  }

  /** @param {string} id */
  #tab(id) {
    return gBrowserOf(this.#win).tabs.find((t) => t.linkedPanel === id && !t.closing);
  }

  /** The wrapper's tabs in panel (DOM) order; [] without one. */
  #members() {
    const wrapper = this.#currentWrapper();
    if (!wrapper) return [];
    const panels = this.#win.document.getElementById("tabbrowser-tabpanels");
    const order = new Map([...(panels?.children ?? [])].map((p, i) => [p.id, i]));
    return wrapper.tabs
      .filter((t) => !t.closing)
      .sort((a, b) => (order.get(a.linkedPanel) ?? 0) - (order.get(b.linkedPanel) ?? 0));
  }

  /** @returns {Wrapper | null} */
  #currentWrapper() {
    if (this.#wrapper?.isConnected && this.#wrapper.tabs.length) return this.#wrapper;
    const ids = this.#panes ? leaves(this.#panes).map((l) => l.tab) : [];
    const found = ids.map((id) => this.#tab(id)?.splitview).find(Boolean) ?? null;
    this.#wrapper = found;
    return found;
  }

  /**
   * Makes Firefox match the tree: membership, panel order, visual hiding, docshells, selection,
   * then geometry. Idempotent: with nothing to change it changes nothing.
   */
  reconcile() {
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      for (const slot of this.#ended.splice(0)) this.#dissolve(slot);
      /** @type {Panes | null} */
      let away = null;
      // The selected tab is in a hidden split (picked, or Firefox's successor for a closed tab):
      // that split shows (docs/specs/multiple-splits.md behaviour 2).
      const selected = gBrowserOf(this.#win).selectedTab?.linkedPanel;
      const other = selected ? this.#otherOf(selected) : undefined;
      if (other !== undefined) away = this.#bring(other, /** @type {string} */ (selected));
      this.#reconcile();
      // The current split ended while others are kept: the lowest becomes the one shown last,
      // hidden, so a workspace with splits always has a current tree (and `]s` a way back).
      if (!this.#panes && this.#others.size) {
        this.#promote();
        this.#reconcile();
      } else if (!this.#panes) {
        this.#number = 1;
      }
      if (away) this.#sleep(away);
    } finally {
      this.#reconciling = false;
    }
    this.onChange?.();
  }

  #reconcile() {
    const win = this.#win;
    const gBrowser = gBrowserOf(win);
    // A tree whose tabs are gone (closed outside a TabClose we saw) shrinks first.
    let panes = this.#panes;
    for (const leaf of panes ? leaves(panes) : []) {
      if (!panes || this.#tab(leaf.tab)) continue;
      panes = leaves(panes).length > 2 ? closePane(panes, leaf.pane) : null;
    }
    // A hidden view whose tab got selected some other way (Firefox's successor for a closed tab)
    // shows again, focused there (side-panel-unsplit decision 23).
    const selected = gBrowser.selectedTab;
    const selectedPane = panes && selected && paneOfTab(panes, selected.linkedPanel);
    if (panes && isHiddenView(panes) && selectedPane) {
      panes = focusPane(showView(panes), selectedPane);
    }
    this.#panes = panes;
    const hidden = !!panes && isHiddenView(panes);

    const members = this.#members();
    const managed = new Set([...members, ...this.#laidOut]);
    for (const leaf of panes ? leaves(panes) : []) {
      const t = this.#tab(leaf.tab);
      if (t) managed.add(t);
    }
    const ids = (/** @type {Tab[]} */ tabs) => tabs.map((t) => t.linkedPanel);
    const plan = planSplit(
      { tabs: ids(gBrowser.tabs.filter((t) => !t.closing)), panes },
      {
        members: ids(members),
        active: ids([...managed].filter((t) => t.linkedBrowser?.docShellIsActive)),
        hidden: ids([...managed].filter((t) => isHidden(win, t))),
      },
    );
    // Hidden: another tab shows alone; nothing here may select a pane's tab.
    const focusTab =
      panes && !hidden && this.#tab(leaves(panes).find((l) => l.pane === panes.focus)?.tab ?? "");
    // Select the focused pane's tab before membership changes when it is already a member, so
    // the split never suspends to show a tab that is about to leave; else after joining.
    const memberIds = new Set(ids(members));
    if (focusTab && memberIds.has(focusTab.linkedPanel)) this.#select(focusTab);
    this.#membership(plan, members);
    this.#order(plan);
    if (focusTab) this.#select(focusTab);
    if (hidden) this.#sleep(/** @type {Panes} */ (panes));
    else {
      this.#apply(plan);
      this.#geometry();
    }
    this.#label();
  }

  /**
   * A hidden view's pages stop painting: their docshells go inactive (the one shown alone stays).
   * Firefox's split view suspends the panels; the geometry stays on them for when it comes back.
   * @param {Panes} panes
   */
  #sleep(panes) {
    const tabs = /** @type {Tab[]} */ (
      leaves(panes)
        .map((l) => this.#tab(l.tab))
        .filter((t) => t && !t.selected)
    );
    // Firefox suspends a split when a tab outside it is selected; a wrapper rebuilt while that tab
    // was already selected (the side panel's Enter) missed that TabSelect, so suspend it here
    // the same way (tabbox.js suspendSplitViewPanels: the panels keep their split-view class).
    /** @type {any} */ (gBrowserOf(this.#win)).tabpanels?.suspendSplitViewPanels?.(tabs);
    this.#asleep(tabs);
  }

  /**
   * Makes the tabs' docshells inactive. A tab the async tab switcher is still loading goes
   * through the switcher instead: its panel is hidden now, so it may never paint, and the
   * switcher counts it as pending until its layers come or are cleared, so it would never
   * finish (no TabSwitchDone, the page left active, commandDispatcher locked). Turning its
   * docshell off by hand clears no layers it never had, and clearing layers it has while it is
   * the switcher's loadingTab ends the switch before the selected tab is loaded, leaving that one
   * blank (#605).
   * @param {Tab[]} tabs
   */
  #asleep(tabs) {
    for (const t of tabs) {
      if (!t.linkedBrowser || t.selected) continue;
      if (!this.#unloadLoading(t)) t.linkedBrowser.docShellIsActive = false;
    }
  }

  /**
   * Unloads `t` the switcher's way if the switcher is loading it (AsyncTabSwitcher.sys.mjs): `t`
   * goes to STATE_UNLOADING, as unloadNonRequiredTabs sends a loaded tab, which turns its
   * docshell off and counts it unloaded once it has no layers; a load of `t` still timed then
   * ends as its loadTimeout ends it, whose postActions loads the requested tab and finishes the
   * switch when nothing else is pending. Not while the switcher handles an event of its own: it
   * would put the loadTimeout off to a timer after the state change, and its postActions would
   * then find its loadingTab no longer loading. Returns whether it did.
   * @param {Tab} t
   */
  #unloadLoading(t) {
    const switcher = /** @type {any} */ (gBrowserOf(this.#win))._switcher;
    if (!switcher || switcher._processing) return false;
    if (switcher.tabState?.get(t) !== switcher.STATE_LOADING) return false;
    switcher.setTabState(t, switcher.STATE_UNLOADING);
    if (switcher.loadingTab === t) switcher.handleEvent({ type: "loadTimeout" });
    return true;
  }

  /**
   * Puts back to sleep the panes the current tree keeps inactive, a zoom's zoomed-away panes or
   * a hidden view's, after Firefox woke them; never wakes anything (reconcile does that).
   */
  #keepAsleep() {
    const panes = this.#panes;
    if (!panes || this.#reconciling) return;
    const hidden = isHiddenView(panes);
    for (const leaf of leaves(panes)) {
      if (!hidden && (!panes.zoom || leaf.pane === panes.zoom)) continue;
      const t = this.#tab(leaf.tab);
      if (t?.linkedBrowser?.docShellIsActive) this.#asleep([t]);
    }
  }

  /** @param {Tab} tab */
  #select(tab) {
    const gBrowser = gBrowserOf(this.#win);
    if (gBrowser.selectedTab !== tab) gBrowser.selectedTab = tab;
  }

  /**
   * @param {SplitPlan} plan
   * @param {Tab[]} members
   */
  #membership(plan, members) {
    const gBrowser = gBrowserOf(this.#win);
    const tabs = (/** @type {string[]} */ list) =>
      /** @type {Tab[]} */ (list.map((id) => this.#tab(id)).filter(Boolean));
    const join = tabs(plan.join);
    for (const t of join) if (t.pinned) gBrowser.unpinTab(t);
    if (plan.leave.length) {
      // A rebuild (ADR-013): the wrapper's private #tabs is not updated when one tab leaves a
      // wrapper of three or more. Synchronous, in one task: no paint sees the gap.
      const leaving = new Set(plan.leave);
      const kept = members.filter((t) => !leaving.has(t.linkedPanel));
      this.#currentWrapper()?.unsplitTabs();
      this.#wrapper = null;
      const all = [...kept, ...join];
      if (all.length >= 2) {
        this.#wrapper = gBrowser.addTabSplitView(all, { insertBefore: all[0] });
      }
    } else if (join.length) {
      const wrapper = this.#currentWrapper();
      if (wrapper) wrapper.addTabs(join);
      else {
        const all = [...members, ...join];
        this.#wrapper = gBrowser.addTabSplitView(all, { insertBefore: all[0] });
      }
    }
  }

  /**
   * Puts the panels in reading order (Tab-key order; Firefox orders only panels 0 and 1).
   * @param {SplitPlan} plan
   */
  #order(plan) {
    const doc = this.#win.document;
    const parent = doc.getElementById("tabbrowser-tabpanels");
    if (!parent) return;
    const members = this.#members();
    for (const { tab, before } of plan.order) {
      const panel = doc.getElementById(tab);
      if (!panel) continue;
      const ref = before
        ? doc.getElementById(before)
        : /** @type {Element | null} */ (
            doc.getElementById(members.at(-1)?.linkedPanel ?? "")?.nextElementSibling ?? null
          );
      if (ref === panel || panel.nextElementSibling === ref) continue;
      /** @type {any} */ (parent).moveBefore(panel, ref);
    }
  }

  /** @param {SplitPlan} plan */
  #apply(plan) {
    const win = this.#win;
    for (const id of plan.showVisually) {
      const t = this.#tab(id);
      if (t) setHidden(win, t, false);
    }
    for (const id of plan.hideVisually) {
      const t = this.#tab(id);
      if (t) setHidden(win, t, true);
    }
    for (const id of plan.activate) {
      const t = this.#tab(id);
      if (t?.linkedBrowser) t.linkedBrowser.docShellIsActive = true;
    }
    // Firefox leaves a tab that left a split, or a zoomed-away one, active (sub-spec 1).
    this.#asleep(/** @type {Tab[]} */ (plan.deactivate.map((id) => this.#tab(id)).filter(Boolean)));
  }

  /** Writes each pane's rectangle; also the ResizeObserver's callback. */
  #geometry() {
    const win = this.#win;
    const panes = this.#panes;
    const tabpanels = win.document.getElementById("tabbrowser-tabpanels");
    if (!panes || !tabpanels) {
      // Only what we laid out: a split made outside Vimma is not ours (adopted in sub-spec 6).
      if (this.#laidOut.size) clearLayout(win, [...this.#laidOut]);
      this.#laidOut.clear();
      this.#resize?.disconnect();
      this.#resize = null;
      return;
    }
    const area = contentArea(win);
    /** @type {Map<Tab, import("./layout.mjs").Rect>} */
    const rects = new Map();
    for (const r of layout(panes, area)) {
      const t = this.#tab(r.tab);
      if (t) rects.set(t, r.rect);
    }
    const shown = new Set(leaves(panes).map((l) => l.tab));
    const gone = [...this.#laidOut].filter((t) => !shown.has(t.linkedPanel));
    clearLayout(win, gone, { all: false });
    for (const t of gone) this.#laidOut.delete(t);
    applyLayout(win, rects, area);
    for (const t of rects.keys()) this.#laidOut.add(t);
    if (!this.#resize) {
      const RO = /** @type {typeof ResizeObserver} */ (win.ResizeObserver);
      const observer = new RO(() => {
        if (this.#panes && !this.hidden) this.#geometry();
      });
      observer.observe(tabpanels);
      this.#resize = observer;
    }
  }

  /**
   * Accessible names for the third pane on: Firefox's updateSplitViewAriaLabel names only the
   * first two ("left", "right").
   */
  #label() {
    const order = this.#panes ? leaves(this.#panes) : [];
    const labelled = new Set();
    order.forEach((leaf, i) => {
      const t = this.#tab(leaf.tab);
      if (!t || i < 2) return;
      t.setAttribute("aria-label", `${t.label}, pane ${i + 1} of ${order.length}`);
      t.setAttribute(LABEL_ATTR, "true");
      labelled.add(t);
    });
    for (const t of gBrowserOf(this.#win).tabs) {
      if (t.hasAttribute(LABEL_ATTR) && !labelled.has(t)) {
        t.removeAttribute(LABEL_ATTR);
        t.removeAttribute("aria-label");
      }
    }
  }
}

/** @type {WeakMap<BrowserWindow, PaneView>} */
const views = new WeakMap();

/**
 * The host API (sub-spec 3's keys call it): one PaneView per browser window.
 */
export const PaneViews = Object.freeze({
  /** @param {BrowserWindow} win */
  init(win) {
    if (views.has(win)) return;
    views.set(win, new PaneView(win));
    win.addEventListener("unload", () => PaneViews.uninit(win), { once: true });
  },

  /** @param {BrowserWindow} win */
  uninit(win) {
    views.get(win)?.destroy();
    views.delete(win);
  },

  /**
   * @param {BrowserWindow} win
   * @returns {PaneView | undefined}
   */
  get(win) {
    return views.get(win);
  },
});

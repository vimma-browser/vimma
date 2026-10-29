/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One window's workspaces (docs/specs/m3-workspaces.md, sub-specs 2b and 3): the core model of
// which tab is in which workspace, kept in step with Firefox's tab events, and applied to the
// window with gBrowser.hideTab / showTab so that only the active workspace's tabs are visible.
//
// Persistence (sub-spec 3): tab ids are uuids kept in the tab value `vimma-tab` (a lazy tab has
// no linkedPanel until it is first selected), with the tab's workspace in `vimma-workspace`; the
// window value `vimma-workspaces` holds core's snapshot (order, each workspace's selected tab,
// pane trees, tab labels), written at the end of every task that changed something, never over
// a newer schema (canWrite). SessionStore brackets every restore into the window with
// SSWindowStateBusy / SSWindowStateReady: in between nothing is applied or written, and on Ready
// the model is rebuilt from the live tabs and the (maybe restored) window value.

import { planWorkspaceSwitch } from "../core/switchplan.mjs";
import { canWrite, readSnapshot, toSnapshot } from "../core/snapshot.mjs";
import { closePane, leaves, showView } from "../core/panes.mjs";
import {
  activeWorkspace,
  addWorkspace,
  closeTab,
  createWorkspaces,
  deleteWorkspace,
  findWorkspace,
  lastWorkspace,
  leaveSkipped,
  moveTab,
  nextWorkspace,
  openTab,
  previousWorkspace,
  renameWorkspace,
  setAlternate,
  setWorkspaceContainer,
  selectTab,
  switchWorkspace,
  workspaceOfTab,
} from "../core/workspaces.mjs";
import { getTabLabel, LABEL_EVENT, setTabLabel, TAB_LABEL_KEY } from "../host/tab-labels.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { unpinnedNotice } from "../core/workspacedefs.mjs";
import { CHANGED_TOPIC, WorkspaceStore } from "./WorkspaceStore.sys.mjs";

/** @import { Workspaces, WorkspaceRef, WorkspaceState } from "../core/workspaces.mjs" */
/** @import { Panes, PaneNode } from "../core/panes.mjs" */
/** @import { TabInfo } from "../core/switchplan.mjs" */
/** @import { TabLabels } from "../core/tablabels.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WorkspaceRouter: "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
});

/** The window value holding core's snapshot. */
export const WINDOW_KEY = "vimma-workspaces";
/** The tab value holding a tab's uuid. */
export const TAB_KEY = "vimma-tab";
/** The tab value holding the id of a tab's workspace. */
export const TAB_WORKSPACE_KEY = "vimma-workspace";

/**
 * @typedef {Element & { linkedPanel: string | null, userContextId: number, pinned: boolean,
 *   hidden: boolean, closing?: boolean, selected: boolean,
 *   splitview: (Element & { splitViewId: number, unsplitTabs: () => void }) | null,
 *   linkedBrowser: any }} Tab
 * @typedef {{ tabs: Tab[], visibleTabs: Tab[], selectedTab: Tab, hideTab: (t: Tab) => void,
 *   showTab: (t: Tab) => void, addTrustedTab: (url: string, options?: object) => Tab,
 *   insertBrowser: (t: Tab) => void, getTabForBrowser: (b: unknown) => Tab | null,
 *   addTabsProgressListener: (l: object) => void, removeTabsProgressListener: (l: object) => void,
 *   selectedBrowser: Element & { focus: () => void } }} TabBrowser
 * @typedef {object} WindowWorkspacesOptions
 * @property {() => void} [onChange]  told after the model or visibility changed
 * @property {(text: string) => void} [notify]  a status message (`opened in "work"`)
 */

const TAB_EVENTS = [
  "TabOpen",
  "TabClose",
  "TabSelect",
  "TabPinned",
  "TabUnpinned",
  "SSTabRestored",
  LABEL_EVENT,
];
const SESSION_EVENTS = [
  "SSWindowRestoring",
  "SSWindowStateBusy",
  "SSWindowStateReady",
  "SSWindowClosing",
];

/**
 * SessionStore's notification at the end of a restore into one window, sent on both paths that
 * restore a whole window (#restoreWindowsFeaturesAndTabs, and #initializeWindow's restore of the
 * last closed window), whether or not an SSWindowStateReady went out first.
 */
const WINDOW_RESTORED_TOPIC = "sessionstore-single-window-restored";

/**
 * How long a restore into a window may stay pending without SSWindowStateReady before it is
 * taken as one that never finished, by a timer set at the Busy. SessionStore's brackets end
 * synchronously (#restoreTab) or in a 0 ms timer of the window's that it scheduled before the
 * Busy (#restoreWindowFeatures), and a chrome window's timers are not throttled, so the timer
 * never fires inside a real bracket, however long that bracket's synchronous part takes.
 */
export const STUCK_RESTORE_MS = 5000;

/** Test-only: overrides STUCK_RESTORE_MS, read at each SSWindowStateBusy. */
const STUCK_RESTORE_PREF = "vimma.workspaces.stuckRestoreMs";

/** The bound in effect: STUCK_RESTORE_MS unless the test-only pref says otherwise. */
function stuckRestoreMs() {
  return Services.prefs.getIntPref(STUCK_RESTORE_PREF, STUCK_RESTORE_MS);
}

/**
 * A page loading into `browser` in the parent process before its layout has started: the
 * initial about:blank the load replaces, or the new document while the parser still runs.
 * @param {any} browser
 */
function layoutPending(browser) {
  const doc = browser.contentDocument;
  if (!doc || !browser.webProgress?.isLoadingDocument) return false;
  return doc.isInitialDocument || doc.readyState === "loading";
}

/** A new uuid, without braces. */
function newId() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

/**
 * A pane tree with every leaf's tab renamed by `fn`; a leaf `fn` maps to undefined is closed.
 * Null when fewer than two panes are left (one pane is no split).
 * @param {Panes} panes
 * @param {(tab: string) => string | undefined} fn
 * @returns {Panes | null}
 */
function mapTree(panes, fn) {
  let tree = panes;
  for (const leaf of leaves(panes)) {
    if (fn(leaf.tab) !== undefined) continue;
    if (leaves(tree).length <= 2) return null;
    tree = closePane(tree, leaf.pane);
  }
  /** @type {(n: PaneNode) => PaneNode} */
  const walk = (n) =>
    n.type === "leaf"
      ? { ...n, tab: /** @type {string} */ (fn(n.tab)) }
      : { ...n, children: n.children.map(walk) };
  return leaves(tree).length >= 2 ? { ...tree, root: walk(tree.root) } : null;
}

/**
 * The refusal for a workspace the model does not have.
 * @param {WorkspaceRef} ref
 */
function unknown(ref) {
  const name = "name" in ref ? ref.name : "index" in ref ? String(ref.index) : ref.id;
  return `no workspace "${name}"`;
}

export class WindowWorkspacesImpl {
  /** @type {Window & { gBrowser: TabBrowser, delayedStartupPromise?: Promise<void> }} */
  #win;
  /** @type {Workspaces | null} null until built, and for windows without workspaces */
  #model = null;
  /** Tabs of a container no workspace owns, adopted by the active workspace (decision 1). */
  /** @type {Set<string>} */
  #foreign = new Set();
  /** Each tab's uuid, and back. */
  /** @type {WeakMap<Tab, string>} */
  #ids = new WeakMap();
  /** @type {Map<string, Tab>} */
  #byId = new Map();
  #switching = false;
  /** While `quietly` runs: tabs it opens get no `opened in` notice. */
  #quiet = false;
  /** While moveTab opens the copy: the tab it replaces and the target workspace. */
  /** @type {{ from: string, to: string } | null} */
  #moving = null;
  /** Between SSWindowStateBusy and SSWindowStateReady: a restore is under way. */
  #pending = false;
  /** When the pending restore began (Date.now()). */
  #pendingSince = 0;
  /** The timer that ends a pending restore SessionStore never finishes (STUCK_RESTORE_MS). */
  #stuckTimer = 0;
  /** The bound of the pending restore (stuckRestoreMs at its SSWindowStateBusy). */
  #stuckBound = STUCK_RESTORE_MS;
  /**
   * The last restore that never finished: why the wait ended, after how long, and when.
   * @type {{ reason: string, afterMs: number, at: number } | null}
   */
  #recovered = null;
  /** @type {{ message: string, at: number } | null} the last failed rebuild */
  #lastError = null;
  /** #start got as far as building (a Ready before that builds nothing). */
  #started = false;
  #saveQueued = false;
  /** The window value as last written, to tell our own value from a restored one. */
  #written = "";
  #onChange;
  #notify;
  /**
   * Whether a pinned tab is unpinned (decision 11). The guards for pinned tabs in the tab keys,
   * the side panel and the agent's tab list stay, since windows without workspaces (private
   * windows, popups, containers off) keep them; their tests turn this off to reach them here.
   */
  unpinsPinnedTabs = true;
  /** Resolves once the model is built (or the window has none). */
  ready;

  /**
   * @param {Window} win
   * @param {WindowWorkspacesOptions} [options]
   */
  constructor(win, { onChange = () => {}, notify = () => {} } = {}) {
    this.#win = /** @type {any} */ (win);
    this.#onChange = onChange;
    this.#notify = notify;
    for (const type of [...TAB_EVENTS, ...SESSION_EVENTS]) win.addEventListener(type, this);
    win.addEventListener("focus", this.#onFocus, true);
    Services.obs.addObserver(this.#observer, CHANGED_TOPIC);
    Services.obs.addObserver(this.#windowRestored, WINDOW_RESTORED_TOPIC);
    this.ready = this.#start().catch((e) => console.error("vimma: no workspaces", e));
  }

  destroy() {
    for (const type of [...TAB_EVENTS, ...SESSION_EVENTS]) {
      this.#win.removeEventListener(type, this);
    }
    this.#win.removeEventListener("focus", this.#onFocus, true);
    this.#restoring = null;
    this.#win.clearTimeout(this.#stuckTimer);
    Services.obs.removeObserver(this.#observer, CHANGED_TOPIC);
    Services.obs.removeObserver(this.#windowRestored, WINDOW_RESTORED_TOPIC);
    this.#win.gBrowser?.removeTabsProgressListener(this.#progress);
    const view = PaneViews.get(this.#win);
    if (view) {
      view.onChange = null;
      view.accepts = null;
      view.adoption = null;
    }
    this.#model = null;
  }

  async #start() {
    const win = this.#win;
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win) || win.toolbar?.visible === false) return;
    await WorkspaceStore.init();
    if (win.document.readyState === "loading") {
      await new Promise((r) => win.addEventListener("DOMContentLoaded", r, { once: true }));
    }
    if (win.closed || WorkspaceStore.disabled) return;
    this.#started = true;
    win.gBrowser.addTabsProgressListener(this.#progress);
    const view = PaneViews.get(win);
    if (view) {
      view.onChange = () => this.#scheduleSave();
      // Decision 14: only the shown workspace's tabs go into its panes; another workspace's tab
      // switches (#onSelect), and a switch or restore selects tabs of its own.
      view.accepts = (/** @type {any} */ tab) => {
        const model = this.#model;
        if (!model || this.#switching || this.#pending) return false;
        return workspaceOfTab(model, this.#idOf(tab))?.id === model.active;
      };
      // Splits made outside Vimma (M4 sub-spec 6): adopted into the workspace their tabs are in,
      // unsplit with a notice when those are several (decision 14).
      view.adoption = {
        workspaceOf: (/** @type {any} */ tab) => {
          const model = this.#model;
          return model ? workspaceOfTab(model, this.#idOf(tab))?.id : undefined;
        },
        active: () => /** @type {Workspaces} */ (this.#model).active,
        busy: () => !this.#model || this.#switching || this.#pending,
        notify: (text) => this.#notify(text),
      };
    }
    // A restore under way builds on its SSWindowStateReady, from the restored values.
    if (!this.#pending) this.#reconcile();
  }

  /** The window's model, or null without workspaces. */
  get model() {
    return this.#model;
  }

  /**
   * What about:vimma's report says of this window's model (issue #546): its open unpinned tabs
   * (the model holds them all when it is in step), how long a restore has been pending, the
   * last restore that never finished, and the last failed rebuild.
   */
  health() {
    const now = Date.now();
    const recovered = this.#recovered;
    return {
      live: (this.#gBrowser?.tabs ?? []).filter((t) => this.#live(t) && !t.pinned).length,
      pending: this.#pending,
      pendingMs: this.#pending ? now - this.#pendingSince : null,
      recovered: recovered && {
        reason: recovered.reason,
        afterMs: recovered.afterMs,
        agoMs: now - recovered.at,
      },
      lastError: this.#lastError?.message ?? null,
    };
  }

  /**
   * The model's id of `tab`: its uuid.
   * @param {Tab} tab
   */
  idOf(tab) {
    return this.#idOf(tab);
  }

  /**
   * The open tab with model id `id`, or undefined.
   * @param {string} id
   */
  tabOf(id) {
    return this.#tab(id);
  }

  /**
   * Runs `open`, which opens tabs, with no `opened in` notice for them: an agent's background
   * open, which its question already named (docs/specs/vimma-mcp.md, decision 10).
   * @template T
   * @param {() => T} open
   * @returns {T}
   */
  quietly(open) {
    this.#quiet = true;
    try {
      return open();
    } finally {
      this.#quiet = false;
    }
  }

  /** @param {Tab} tab */
  isForeign(tab) {
    return this.#foreign.has(this.#idOf(tab));
  }

  /** The status bar's workspace segment: the active workspace's name, place and colour. */
  status() {
    const model = this.#model;
    if (!model) return null;
    const w = activeWorkspace(model);
    const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === w.id);
    return {
      name: w.name,
      index: model.workspaces.indexOf(w) + 1,
      ...(def ? { color: def.color } : {}),
    };
  }

  /**
   * Shows workspace `ref`. Returns why not, or null.
   * @param {WorkspaceRef} ref
   * @returns {string | null}
   */
  switchTo(ref) {
    const model = this.#model;
    if (!model) return "no workspaces in this window";
    if (!findWorkspace(model, ref)) return unknown(ref);
    this.#show(model, switchWorkspace(model, ref));
    return null;
  }

  /**
   * Shows `tab`'s workspace with `tab` selected, through the same switch as `switchTo`, so the
   * workspace left becomes the alternate and its split is parked (docs/specs/mcp-drive.md D2).
   * Returns why not, or null.
   * @param {Tab} tab
   * @returns {string | null}
   */
  showTab(tab) {
    const model = this.#model;
    if (!model) return "no workspaces in this window";
    const id = this.#idOf(tab);
    if (tab.closing || this.#foreign.has(id) || !workspaceOfTab(model, id)) {
      return "this tab is in no workspace";
    }
    const next = selectTab(model, id);
    if (next.active === model.active) {
      // The same workspace: a plain selection, which #onSelect records.
      this.#gBrowser.selectedTab = tab;
      return null;
    }
    this.#show(model, next);
    return null;
  }

  /**
   * Moves `tab` to workspace `ref` (decision 6, sub-spec 4b): reopens its URL in the target's
   * container, as Firefox's "Reopen in Container" does (history, form data, scroll and POST
   * data stay behind; the label and mute come along), then closes it. A tab in a split leaves
   * the split first. The window stays in its workspace; one left empty gets its home tab.
   * Returns why not, or null.
   * @param {Tab} tab  the selected tab, or one outside any split
   * @param {WorkspaceRef} ref
   * @param {{ onMoved?: (fresh: Tab) => void }} [opts]  told the reopened tab, before the old
   *   one closes (a tab given to the built-in agent, docs/specs/builtin-agent.md Behaviour 17)
   * @returns {string | null}
   */
  moveTab(tab, ref, { onMoved } = {}) {
    const model = this.#model;
    if (!model) return "no workspaces in this window";
    const target = findWorkspace(model, ref);
    if (!target) return unknown(ref);
    const id = this.#idOf(tab);
    const from = workspaceOfTab(model, id);
    if (!from) return "this tab is in no workspace";
    if (from.id === target.id && !this.#foreign.has(id)) return `already in "${target.name}"`;
    const gBrowser = this.#gBrowser;
    // Every refusal before anything changes: a refused move leaves the split as it was.
    const userContextId = Number(target.container);
    const principal = this.#principalFor(tab, userContextId);
    if (!principal) return "this tab's page cannot be reopened";
    const view = PaneViews.get(this.#win);
    // Out of the split first: closing its pane keeps its tab (pane.close); a split Vimma has
    // not adopted is undone.
    view?.release(/** @type {any} */ (tab));
    if (tab.splitview) tab.splitview.unsplitTabs();
    if (from.id === model.active && from.tabs.length === 1) {
      this.#openHome(from.id, Number(from.container));
    }
    const label = getTabLabel(tab);
    // A lazy (never selected) tab stays lazy: its copy loads on first selection, as Firefox's
    // own adoptTab and session restore keep such tabs.
    const lazyTab = !tab.linkedPanel;
    /** @type {any} */
    let fresh;
    this.#moving = { from: id, to: target.id };
    try {
      fresh = /** @type {any} */ (gBrowser).addTab(tab.linkedBrowser.currentURI.spec, {
        userContextId,
        tabIndex: /** @type {any} */ (tab)._tPos + 1,
        triggeringPrincipal: principal,
        skipAnimation: true,
        ...(lazyTab
          ? { createLazyBrowser: true, lazyTabTitle: /** @type {any} */ (tab).label }
          : {}),
      });
    } finally {
      this.#moving = null;
    }
    if (label) setTabLabel(fresh, label);
    onMoved?.(fresh);
    if (/** @type {any} */ (tab).muted && !fresh.muted) {
      fresh.toggleMuteAudio(/** @type {any} */ (tab).muteReason);
    }
    /** @type {any} */ (gBrowser).removeTab(tab, { animate: false });
    return null;
  }

  /**
   * The principal that loads `tab`'s page in container `userContextId`: its content principal
   * (a lazy tab's, from SessionStore) with the new container, a null principal for an opaque
   * one, the system principal as is (about: and chrome: pages). From tab-context-menu.js's
   * reopenInContainer.
   * @param {Tab} tab
   * @param {number} userContextId
   */
  #principalFor(tab, userContextId) {
    const ssm = /** @type {any} */ (Services.scriptSecurityManager);
    /** @type {any} */
    let principal;
    if (tab.linkedPanel) {
      principal = tab.linkedBrowser.contentPrincipal;
    } else {
      try {
        const state = JSON.parse(lazy.SessionStore.getTabState(tab));
        principal = lazy.E10SUtils.deserializePrincipal(state.triggeringPrincipal_base64);
      } catch {
        return null;
      }
    }
    if (!principal || principal.isNullPrincipal) return ssm.createNullPrincipal({ userContextId });
    if (principal.isContentPrincipal) return ssm.principalWithOA(principal, { userContextId });
    return principal;
  }

  /**
   * The workspaces the cycle and the alternate skip: the agent workspace (docs/specs/vimma-mcp.md,
   * decision 9), reached on purpose through the picker or `:ws agent`.
   * @returns {ReadonlySet<string>}
   */
  #skip() {
    const agent = WorkspaceStore.agent;
    return new Set(agent ? [agent.id] : []);
  }

  /** The same set, for what names the cycle's targets (the side panel's header). */
  get cycleSkip() {
    return this.#skip();
  }

  /** ctrl+b ); wraps, past the agent workspace. */
  next() {
    if (!this.#model) return "no workspaces in this window";
    this.#show(this.#model, nextWorkspace(this.#model, this.#skip()));
    return null;
  }

  /** ctrl+b (; wraps, past the agent workspace. */
  previous() {
    if (!this.#model) return "no workspaces in this window";
    this.#show(this.#model, previousWorkspace(this.#model, this.#skip()));
    return null;
  }

  /**
   * ctrl+^ / ctrl+b ^: back to the workspace shown before this one (Vim's alternate buffer);
   * a second press toggles back.
   */
  last() {
    const model = this.#model;
    if (!model) return "no workspaces in this window";
    const next = lastWorkspace(model, this.#skip());
    if (next === model) return "no previous workspace in this window";
    this.#show(model, next);
    return null;
  }

  /** @param {Event} e */
  handleEvent(e) {
    if (this.#win.closed) return;
    switch (e.type) {
      case "SSWindowRestoring":
      case "SSWindowStateBusy":
        // A whole-window restore sends SSWindowRestoring first, then Busy; once the window's
        // busy count is stuck (#endStuckRestore) it sends only SSWindowRestoring, and ends with
        // sessionstore-single-window-restored, which ends the pending (#windowRestored).
        if (!this.#pending) {
          // Our value as it is now, before the restore replaces it (it may not carry ours).
          this.#save();
          this.#pending = true;
        }
        this.#pendingSince = Date.now();
        this.#win.clearTimeout(this.#stuckTimer);
        this.#stuckBound = stuckRestoreMs();
        this.#stuckTimer = this.#win.setTimeout(
          () => this.#endStuckRestore("no SSWindowStateReady"),
          this.#stuckBound,
        );
        return;
      case "SSWindowStateReady":
        this.#endPending();
        if (this.#started) this.#reconcile();
        return;
      case "SSWindowClosing":
        this.#save();
        return;
      case "TabSelect":
        this.#win.queueMicrotask(() => this.#guardFocus());
        break;
      case "SSTabRestored":
        this.#onLoaded(/** @type {Tab} */ (e.target));
        return;
    }
    // Tab events inside a restore are not applied: the Ready reconcile reads the live tabs. The
    // bound is never checked here: a whole-window restore opens its tabs before it sets the
    // window and tab values, so a rebuild between two of its TabOpens would save over the
    // snapshot the Ready reads. Only the timer ends a restore that never finishes; every real
    // bracket ends synchronously or in a 0 ms timer SessionStore scheduled before its Busy.
    if (!this.#model || this.#pending) return;
    const tab = /** @type {Tab} */ (e.target);
    switch (e.type) {
      case "TabOpen":
      case "TabUnpinned":
        this.#onOpen(tab);
        break;
      case "TabClose":
        this.#onClose(tab);
        break;
      case "TabPinned":
        this.#onClose(tab);
        this.#unpin(tab);
        break;
      case "TabSelect":
        this.#onSelect(tab);
        break;
      case LABEL_EVENT:
        this.#scheduleSave();
    }
  }

  /** The host last hinted about, per tab (spec workspace-routing, decision 5). */
  /** @type {WeakMap<Tab, string>} */
  #hinted = new WeakMap();

  /**
   * Same-tab navigation is never moved to another workspace (spec workspace-routing, decision
   * 5: Zen moved tabs mid-load). When the selected tab's page lands on a site a `[[routes]]`
   * rule sends elsewhere, the notice says so, once per tab and host, and `:route move` moves it.
   * A page #guardFocus kept without focus gets it when its load stops.
   */
  #progress = {
    onStateChange: (
      /** @type {any} */ browser,
      /** @type {any} */ webProgress,
      /** @type {unknown} */ _request,
      /** @type {number} */ flags,
    ) => {
      const { STATE_STOP, STATE_IS_WINDOW } = Ci.nsIWebProgressListener;
      if (!webProgress?.isTopLevel || browser !== this.#restoring) return;
      if ((flags & (STATE_STOP | STATE_IS_WINDOW)) !== (STATE_STOP | STATE_IS_WINDOW)) return;
      // A restore's own load ends before SessionStore calls it restored (SSTabRestored).
      const tab = /** @type {Tab | null} */ (this.#gBrowser.getTabForBrowser(browser));
      if (tab && !lazy.SessionStore.isTabRestoring(tab)) this.#onLoaded(tab);
    },
    onLocationChange: (
      /** @type {any} */ browser,
      /** @type {any} */ webProgress,
      /** @type {unknown} */ _request,
      /** @type {any} */ location,
      /** @type {number} */ flags,
    ) => {
      if (!webProgress?.isTopLevel || !this.#model || this.#pending) return;
      if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
      const tab = /** @type {Tab | null} */ (this.#gBrowser.getTabForBrowser(browser));
      if (tab?.selected) this.#hint(tab, location);
    },
  };

  /**
   * The hint for `tab` (selected) when a rule sends its page to another workspace's container:
   * a page's own navigation, or a link a page opened (never routed: spec workspace-routing,
   * decision 3), once per tab and host.
   * @param {Tab} tab
   * @param {any} [location]  nsIURI, the browser's current one by default
   */
  #hint(tab, location = tab.linkedBrowser?.currentURI) {
    if (tab.pinned || !location) return;
    const hit = lazy.WorkspaceRouter.match(location.spec, null);
    if (!hit || hit.workspace.userContextId === tab.userContextId) {
      this.#hinted.delete(tab);
      return;
    }
    /** @type {string} */
    let host;
    try {
      host = location.host;
    } catch {
      return;
    }
    if (this.#hinted.get(tab) === host) return;
    this.#hinted.set(tab, host);
    this.#notify(`${host} goes to "${hit.workspace.name}" (route ${hit.route.index}): :route move`);
  }

  #endPending() {
    this.#pending = false;
    this.#win.clearTimeout(this.#stuckTimer);
    this.#stuckTimer = 0;
  }

  /**
   * Ends a pending restore SessionStore will never finish, and rebuilds the model from the live
   * tabs. SessionStore's busy count for a window can stay raised for good: its restore of the
   * last closed window into the next one opened (macOS, where the app outlives its windows)
   * raises it with no matching Ready, and a #restoreTab that throws partway never lowers it.
   * Every tab event was dropped from then on, so tab search and the side panel missed each tab
   * opened afterwards (issue #546). No Busy or Ready comes for that window again; its tab events
   * are applied as they come, like any window's outside a restore.
   * @param {string} reason
   */
  #endStuckRestore(reason) {
    if (!this.#pending || this.#win.closed) return;
    const afterMs = Date.now() - this.#pendingSince;
    this.#endPending();
    this.#recovered = { reason, afterMs, at: Date.now() };
    console.warn(
      `vimma: a session restore into this window never finished (${reason}); ` +
        `rebuilding its workspaces after ${afterMs} ms`,
    );
    if (this.#started) this.#reconcile();
  }

  /** Observer: SessionStore finished restoring a window, maybe without SSWindowStateReady. */
  #windowRestored = (/** @type {unknown} */ subject) => {
    if (subject === this.#win) this.#endStuckRestore("restored without SSWindowStateReady");
  };

  /** Observer: the store's definitions changed (a workspace added, renamed or deleted). */
  #observer = () => {
    if (this.#model && !this.#win.closed && !this.#pending) this.#sync();
  };

  get #gBrowser() {
    return this.#win.gBrowser;
  }

  /** @param {Tab} tab */
  #live(tab) {
    return tab.isConnected && !tab.closing;
  }

  /** @param {string} id */
  #tab(id) {
    const tab = this.#byId.get(id);
    return tab && this.#live(tab) ? tab : undefined;
  }

  /**
   * A tab's uuid: the one it has, else its `vimma-tab` value unless another open tab holds it
   * (a duplicated tab copies its values), else a new one. Writes nothing; #save does.
   * @param {Tab} tab
   */
  #idOf(tab) {
    const known = this.#ids.get(tab);
    if (known) return known;
    const value = this.#tabValue(tab, TAB_KEY);
    const id = value && !this.#tab(value) ? value : newId();
    this.#ids.set(tab, id);
    this.#byId.set(id, tab);
    return id;
  }

  /**
   * Re-reads every open tab's uuid after a restore: its tab value wins (SessionStore has just
   * set it), the one we knew comes next, a new one last; a second holder of a uuid gets another.
   */
  #rereadIds() {
    const old = this.#ids;
    this.#ids = new WeakMap();
    this.#byId = new Map();
    const tabs = this.#gBrowser.tabs.filter((t) => this.#live(t));
    /** @param {Tab} tab @param {string} id */
    const take = (tab, id) => {
      this.#ids.set(tab, id);
      this.#byId.set(id, tab);
    };
    for (const t of tabs) {
      const before = old.get(t);
      if (before && before === this.#tabValue(t, TAB_KEY)) take(t, before);
    }
    for (const t of tabs) {
      if (this.#ids.has(t)) continue;
      const value = this.#tabValue(t, TAB_KEY);
      const before = old.get(t);
      if (value && !this.#byId.has(value)) take(t, value);
      else if (before && !this.#byId.has(before)) take(t, before);
      else take(t, newId());
    }
  }

  /** @param {Tab} tab @param {string} key */
  #tabValue(tab, key) {
    try {
      return lazy.SessionStore.getCustomTabValue(tab, key) || "";
    } catch {
      return "";
    }
  }

  /** Workspace definitions with a container, in workspace order. */
  #defs() {
    return WorkspaceStore.definitions.workspaces.filter((d) => d.userContextId !== null);
  }

  /**
   * The workspace that owns a container (decision 1), or undefined.
   * @param {number} userContextId
   * @param {Workspaces | null} [model]  the model to look in (a rebuild's, before it is live)
   */
  #owner(userContextId, model = this.#model) {
    return model?.workspaces.find((w) => w.container === String(userContextId));
  }

  /** The window value; "" when there is none or SessionStore does not track the window yet. */
  #windowValue() {
    try {
      return lazy.SessionStore.getCustomWindowValue(this.#win, WINDOW_KEY) || "";
    } catch {
      return "";
    }
  }

  /**
   * Rebuilds the model (below). A failed rebuild keeps the current model: the live tabs are
   * still the truth and the next restore, or a tab selected meanwhile (#onSelect), repairs
   * what this pass missed. Letting the failure out would leave a half-built model behind
   * (issue #546).
   */
  #reconcile() {
    const foreign = this.#foreign;
    try {
      this.#rebuild();
    } catch (e) {
      this.#foreign = foreign;
      this.#lastError = { message: String(e), at: Date.now() };
      console.error("vimma: the window's workspaces could not be rebuilt; keeping them", e);
    }
  }

  /**
   * Builds the model from the open tabs, which are the truth, and the window value, which
   * supplies each workspace's selected tab, the pane trees and the labels (Reconcile in the
   * spec). Runs at init and after every restore into the window; idempotent. The new model
   * replaces the current one only once it is complete (#show), so a failure partway leaves
   * the current one untouched.
   */
  #rebuild() {
    const defs = this.#defs();
    if (!defs.length) return;
    const gBrowser = this.#gBrowser;
    this.#rereadIds();
    const raw = this.#windowValue();
    const restored = raw !== "" && raw !== this.#written;
    /** @type {{ state: Workspaces, tabLabels: TabLabels } | null} */
    let snapshot = null;
    if (restored && canWrite(raw)) {
      try {
        snapshot = readSnapshot(raw);
      } catch (e) {
        console.warn("vimma: the window's workspaces could not be read", e);
      }
    } else if (restored) {
      console.warn("vimma: this window's workspaces were saved by a newer vimma; left alone");
    }
    const base = snapshot?.state ?? this.#model;
    const known = (/** @type {string | undefined} */ id) =>
      id && defs.some((d) => d.id === id) ? id : undefined;

    const prev = this.#model;
    let model = createWorkspaces(
      defs.map((d) => ({ id: d.id, name: d.name, container: String(d.userContextId) })),
    );
    const routed = WorkspaceStore.defaultUserContextId(this.#win);
    const fallback =
      known(base?.active) ??
      (routed === null ? undefined : this.#owner(routed, model)?.id) ??
      model.active;
    this.#foreign = new Set();
    for (const tab of gBrowser.tabs) {
      if (!this.#live(tab) || tab.pinned) continue;
      const id = this.#idOf(tab);
      const owner = this.#owner(tab.userContextId, model)?.id;
      if (!owner) this.#foreign.add(id);
      const ws =
        owner ??
        known(base ? workspaceOfTab(base, id)?.id : undefined) ??
        known(this.#tabValue(tab, TAB_WORKSPACE_KEY)) ??
        fallback;
      model = openTab(model, id, { workspace: { id: ws }, activate: false });
    }
    // Each workspace's selected tab, then the active workspace: the selected tab's.
    for (const w of base?.workspaces ?? []) {
      const into = w.activeTab ? workspaceOfTab(model, w.activeTab) : undefined;
      if (w.activeTab && into?.id === w.id) model = selectTab(model, w.activeTab);
    }
    const selected = gBrowser.selectedTab;
    const selectedId = selected.pinned ? undefined : this.#ids.get(selected);
    if (selectedId && workspaceOfTab(model, selectedId)) model = selectTab(model, selectedId);
    else model = switchWorkspace(model, { id: fallback });
    // The rebuild's own switches are not the user's: the previous workspace is the saved one.
    model = setAlternate(model, known(base?.alternate));

    let from = prev ?? model;
    if (snapshot) {
      this.#restoreLabels(snapshot.tabLabels);
      if (this.#restorePanes(snapshot.state, model)) from = model;
    }
    this.#model = from;
    this.#show(from, model);
    WorkspaceStore.setActive(this.#win, /** @type {Workspaces} */ (this.#model).active);
  }

  /**
   * A label the snapshot has for a tab that came back without its `vimma.tabLabel` value.
   * @param {TabLabels} labels
   */
  #restoreLabels(labels) {
    for (const [id, label] of Object.entries(labels)) {
      const tab = this.#tab(id);
      if (tab && !this.#tabValue(tab, TAB_LABEL_KEY)) {
        lazy.SessionStore.setCustomTabValue(tab, TAB_LABEL_KEY, label);
      }
    }
  }

  /**
   * Hands the snapshot's pane trees to the window's PaneView, with the panel ids PaneView uses;
   * a lazy member gets its browser (not loaded), as Firefox's split view gives it on
   * activation. Returns whether it did.
   * @param {Workspaces} saved
   * @param {Workspaces} model  the rebuilt model
   */
  #restorePanes(saved, model) {
    const view = PaneViews.get(this.#win);
    if (!view) return false;
    /** @type {Map<string, Panes>} */
    const trees = new Map();
    for (const w of saved.workspaces) {
      const ours = findWorkspace(model, { id: w.id });
      if (!w.panes || !ours) continue;
      const tree = mapTree(w.panes, (id) => {
        const tab = this.#tab(id);
        if (!tab || !ours.tabs.includes(id)) return undefined;
        if (!tab.linkedPanel) this.#gBrowser.insertBrowser(tab);
        return tab.linkedPanel ?? undefined;
      });
      if (tree) trees.set(w.id, tree);
    }
    view.restore(trees, model.active);
    return true;
  }

  /**
   * Puts a tab in the model: in the workspace owning its container, else the active one, marked
   * foreign. A tab joining a workspace that is not shown is hidden (decision 12: no switch).
   * @param {Tab} tab
   * @param {((name: string) => void) | null} [defer]  hide in a microtask instead, unless the
   *   tab got selected meanwhile, and then call this with the workspace's name (TabOpen)
   * @returns {string | null} the name of the workspace it was hidden in, if it was (now)
   */
  #adopt(tab, defer = null) {
    const model = /** @type {Workspaces} */ (this.#model);
    const id = this.#idOf(tab);
    if (workspaceOfTab(model, id)) return null;
    const owner = this.#owner(tab.userContextId);
    const ws = owner ?? activeWorkspace(model);
    if (!owner) this.#foreign.add(id);
    this.#model = openTab(model, id, { workspace: { id: ws.id }, activate: false });
    if (ws.id === model.active || tab.selected) return null;
    if (defer) {
      // A foreground open (addTab selects the tab right after TabOpen, in the same task) is
      // never hidden first nor said to be "opened in": its selection switches to its
      // workspace (spec workspace-routing, decision 4). Microtasks run before any paint.
      this.#win.queueMicrotask(() => {
        const now = this.#model;
        if (!now || this.#win.closed || this.#pending || tab.closing || !tab.isConnected) return;
        if (tab.selected || tab.hidden) return;
        const w = workspaceOfTab(now, id);
        if (!w || w.id === now.active) return;
        if (!this.#gBrowser.visibleTabs.some((/** @type {Tab} */ t) => t !== tab && !t.closing)) {
          return;
        }
        this.#gBrowser.hideTab(tab);
        defer(w.name);
      });
      return null;
    }
    // Firefox's replacement for a closing last tab must stay visible: it is about to be
    // selected, and with it hidden the close would find no tab to select. Its selection then
    // switches to its workspace.
    const others = this.#gBrowser.visibleTabs.filter((t) => t !== tab && !t.closing);
    if (!others.length) return null;
    this.#gBrowser.hideTab(tab);
    return ws.name;
  }

  /** @param {Tab} tab */
  #onOpen(tab) {
    if (tab.pinned) return;
    const moving = this.#moving;
    const model = /** @type {Workspaces} */ (this.#model);
    if (
      moving &&
      this.#owner(tab.userContextId)?.id === moving.to &&
      workspaceOfTab(model, moving.from)?.id !== moving.to
    ) {
      // moveTab's copy: core's moveTab swaps the old id for the new one in the target. (A
      // foreign tab reopened in its own workspace's container is simply adopted.)
      this.#foreign.delete(moving.from);
      this.#model = moveTab(model, moving.from, { id: moving.to }, { newTabId: this.#idOf(tab) });
      if (moving.to !== model.active) this.#gBrowser.hideTab(tab);
    } else {
      // Decision 12: a background open into another workspace never switches; it says where.
      const quiet = this.#quiet;
      this.#adopt(tab, (hiddenIn) => {
        if (!quiet) this.#notify(`opened in "${hiddenIn}"`);
      });
    }
    this.#changed();
  }

  /**
   * Decision 11: `hideTab` refuses pinned tabs, so a tab pinned outside Vimma (an extension, an
   * imported session) would show in every workspace. It is unpinned after the event, since
   * tabbrowser is still inside `pinTab` while `TabPinned` is dispatched; its `TabUnpinned` puts
   * it back in the workspace of its container.
   * @param {Tab} tab
   */
  #unpin(tab) {
    this.#win.queueMicrotask(() => {
      if (!this.unpinsPinnedTabs || !tab.pinned || tab.closing || !tab.isConnected || !this.#model)
        return;
      /** @type {any} */ (this.#gBrowser).unpinTab(tab);
      this.#notify(unpinnedNotice(getTabLabel(tab) || /** @type {any} */ (tab).label || ""));
    });
  }

  /** @param {Tab} tab */
  #onClose(tab) {
    const model = /** @type {Workspaces} */ (this.#model);
    const id = this.#idOf(tab);
    this.#foreign.delete(id);
    if (!workspaceOfTab(model, id)) return;
    this.#model = closeTab(model, id);
    // Pinned tabs are out of the model and never hidden (decision 11).
    if (tab.pinned && tab.hidden) this.#gBrowser.showTab(tab);
    this.#changed();
  }

  /**
   * A tab of another workspace selected (the goto picker, URL-bar switch-to-tab, undo close)
   * switches to that workspace (mapping table, `selectTab`).
   * @param {Tab} tab
   */
  #onSelect(tab) {
    if (!this.#switching) this.#hint(tab);
    let model = /** @type {Workspaces} */ (this.#model);
    const id = this.#idOf(tab);
    if (this.#switching || tab.pinned) return;
    if (!workspaceOfTab(model, id)) {
      // A live tab the model does not know (its TabOpen fell inside a restore bracket, or a
      // rebuild failed): selecting it puts it back, as #sync does for orphans (issue #546).
      this.#adopt(tab);
      this.#changed();
      model = /** @type {Workspaces} */ (this.#model);
      if (!workspaceOfTab(model, id)) return;
    }
    const next = selectTab(model, id);
    if (next.active === model.active) {
      this.#model = next;
      this.#scheduleSave();
      return;
    }
    // Not inside Firefox's own selection (a removeTab picking the next tab, a restore): hiding
    // and selecting from there confuses its tab switcher. Once it is done, if still current.
    this.#win.queueMicrotask(() => {
      const now = this.#model;
      if (!now || this.#win.closed || this.#pending || tab.closing || !tab.selected) return;
      if (!workspaceOfTab(now, id)) return;
      const after = selectTab(now, id);
      if (after.active !== now.active) this.#show(now, after);
      else this.#model = after;
    });
  }

  /** Brings the model in line with the store: new workspaces, renames, deletions. */
  #sync() {
    const before = /** @type {Workspaces} */ (this.#model);
    let model = before;
    const defs = this.#defs();
    /** @type {string[]} */
    let orphans = [];
    /** @type {string[]} */
    const lost = [];
    for (const w of model.workspaces) {
      if (defs.some((d) => d.id === w.id) || model.workspaces.length === 1) continue;
      const { state, closedTabs } = deleteWorkspace(model, { id: w.id });
      model = state;
      orphans = [...orphans, ...closedTabs];
    }
    const agentId = WorkspaceStore.agent?.id;
    for (const d of defs) {
      const w = findWorkspace(model, { id: d.id });
      if (!w) {
        // The agent workspace sorts last (vimma-mcp decision 9): a new one goes before it.
        const before = agentId && agentId !== d.id ? agentId : undefined;
        model = addWorkspace(
          model,
          { id: d.id, name: d.name, container: String(d.userContextId) },
          { activate: false, before },
        );
      } else {
        if (w.name !== d.name) model = renameWorkspace(model, { id: d.id }, d.name);
        const container = String(d.userContextId);
        if (w.container !== container) {
          // Its container was deleted outside Vimma and replaced (WorkspaceStore): its open
          // tabs stay, in the old container, foreign; new tabs open in the new one.
          model = setWorkspaceContainer(model, { id: d.id }, container);
          for (const id of w.tabs) {
            if (String(this.#tab(id)?.userContextId) !== container) this.#foreign.add(id);
          }
          lost.push(d.name);
        }
      }
    }
    this.#model = model;
    for (const name of lost) {
      this.#notify(
        `"${name}" lost its container (deleted outside Vimma); it has a new, empty one, ` +
          "so its sites need a new sign-in",
      );
    }
    // Never close a live tab because its workspace went (Zen's zombies): the active one takes it.
    for (const id of orphans) {
      const tab = this.#tab(id);
      if (tab) this.#adopt(tab);
    }
    if (/** @type {Workspaces} */ (this.#model).active !== before.active) {
      this.#show(before, /** @type {Workspaces} */ (this.#model));
    } else {
      this.#changed();
    }
  }

  /** Firefox's tabs as the switch planner reads them. */
  #tabsState() {
    const gBrowser = this.#gBrowser;
    /** @type {TabInfo[]} */
    const tabs = gBrowser.tabs
      .filter((t) => !t.closing)
      .map((t) => ({
        id: this.#idOf(t),
        hidden: t.hidden,
        pinned: t.pinned,
        group: t.splitview ? String(t.splitview.splitViewId) : null,
      }));
    return { tabs, selected: this.#idOf(gBrowser.selectedTab) };
  }

  /**
   * Applies `next` (from `prev`): the target's tab selected first (Firefox will not hide the
   * selected tab), its tabs shown, every other workspace's hidden, splits as a whole; an empty
   * target gets a start-page tab (or its `home`) in its container.
   * @param {Workspaces} prev
   * @param {Workspaces} next
   */
  #show(prev, next) {
    // Leaving the agent workspace, the alternate stays the one before it (vimma-mcp 9).
    next = leaveSkipped(prev, next, this.#skip());
    const gBrowser = this.#gBrowser;
    const view = PaneViews.get(this.#win);
    this.#model = next;
    this.#switching = true;
    try {
      view?.swap(prev.active, next.active);
      const target = activeWorkspace(next);
      if (!target.activeTab) this.#openHome(target.id, Number(target.container));
      const model = /** @type {Workspaces} */ (this.#model);
      const plan = planWorkspaceSwitch(model, undefined, this.#tabsState());
      const select = plan.select ? this.#tab(plan.select) : undefined;
      if (select && gBrowser.selectedTab !== select) gBrowser.selectedTab = select;
      for (const id of plan.show) {
        const t = this.#tab(id);
        if (t) gBrowser.showTab(t);
      }
      for (const id of plan.hide) {
        const t = this.#tab(id);
        if (t) gBrowser.hideTab(t);
      }
      view?.reconcile();
      if (view?.panes) this.#focusPane();
    } finally {
      this.#switching = false;
    }
    // Splits made outside Vimma that this switch shows, a restore brought back without a tree,
    // or that span workspaces (`plan.unsplit`, decision 14): adopted or undone now (M4 sub-spec 6).
    if (view) {
      view.adopt();
      view.reconcile();
      if (view.panes) this.#focusPane();
    }
    // Before the TabSelect microtask: a key sent in the same task as the switch reaches us too.
    this.#guardFocus();
    const active = /** @type {Workspaces} */ (this.#model).active;
    if (active !== prev.active) WorkspaceStore.setActive(this.#win, active);
    this.#changed();
  }

  /**
   * The selected tab's browser while its page loads in the parent process (the start page) or
   * SessionStore restores one into it, kept without focus until then (#guardFocus).
   * @type {any}
   */
  #restoring = null;

  /** Focus moved: it may have gone into a loading page (#guardFocus), after this event. */
  #onFocus = () => {
    if (!this.#win.closed) this.#win.queueMicrotask(() => this.#guardFocus());
  };

  /**
   * Keeps focus out of the selected tab's page while it loads in the parent process: the start
   * page a switch to an empty workspace opens (issue #388), and every page SessionStore restores
   * there, such as the start page and every lazy tab a workspace switch selects after a restart
   * (issue #140). Until that page's layout starts, Gecko drops every key aimed at it before any
   * listener sees it (PresShell's GetFrameForHandlingEventWith finds no frame for the focused
   * document), so a ctrl+b typed right after the switch was lost. Firefox's tab switch, and
   * #focusPane after ours, focus the page at once; focus goes back to the window instead, where
   * the keys reach VimmaHost, and to the page once it has loaded or restored (#onLoaded). A page
   * in a content process gets every key through the window first, so it keeps its focus.
   */
  #guardFocus() {
    const gBrowser = this.#gBrowser;
    if (this.#win.closed || !gBrowser) return;
    const browser = /** @type {any} */ (gBrowser.selectedBrowser);
    if (this.#win.document.activeElement !== browser || browser.isRemoteBrowser) return;
    if (!lazy.SessionStore.isTabRestoring(gBrowser.selectedTab) && !layoutPending(browser)) return;
    this.#restoring = browser;
    Services.focus.clearFocus(this.#win);
  }

  /**
   * `tab`'s page has loaded or restored: it gets the focus #guardFocus kept from it, unless it
   * is no longer selected or something else has taken focus meanwhile.
   * @param {Tab} tab
   */
  #onLoaded(tab) {
    const browser = tab.linkedBrowser;
    if (!browser || browser !== this.#restoring) return;
    this.#restoring = null;
    const el = this.#win.document.activeElement;
    if (tab.selected && (!el || el === this.#win.document.body)) browser.focus();
  }

  /**
   * After a switch to a split workspace: its focused pane's page gets focus when focus is left
   * nowhere (the body) or in the workspace left's page. A split's browsers are already active,
   * so Firefox's tab switch completes at once and its focus adjustment sees the old page still
   * focused and keeps away; hiding that page then drops focus to the body (M4 sub-spec 6). The
   * URL bar, a tab-modal dialog and other chrome focus are left alone.
   */
  #focusPane() {
    const doc = this.#win.document;
    const browser = this.#gBrowser.selectedBrowser;
    const el = doc.activeElement;
    const lost = !el || el === doc.body || (el.localName === "browser" && el !== browser);
    if (lost && !browser.hasAttribute("tabDialogShowing")) browser.focus();
  }

  /**
   * @param {string} id
   * @param {number} userContextId
   */
  #openHome(id, userContextId) {
    const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === id);
    const url = def?.home ?? /** @type {any} */ (this.#win).BROWSER_NEW_TAB_URL;
    // TabOpen puts it in the model (its container's workspace, active by now).
    this.#gBrowser.addTrustedTab(url, { userContextId, skipAnimation: true });
  }

  /** The model or the visibility changed: tell the host; save at the end of the task. */
  #changed() {
    this.#onChange();
    this.#scheduleSave();
  }

  #scheduleSave() {
    if (this.#saveQueued) return;
    this.#saveQueued = true;
    this.#win.queueMicrotask(() => {
      this.#saveQueued = false;
      this.#save();
    });
  }

  /**
   * The model with PaneView's trees (the shown one and the parked ones) in uuids, each
   * workspace's selected tab being its focused pane's, as core's snapshot requires.
   * @param {Workspaces} model
   * @returns {Workspaces}
   */
  #withPanes(model) {
    const view = PaneViews.get(this.#win);
    if (!view) return model;
    const uuid = (/** @type {string} */ panel) => {
      const tab = this.#gBrowser.tabs.find((t) => t.linkedPanel === panel && this.#live(t));
      return tab ? this.#idOf(tab) : undefined;
    };
    /** @type {WorkspaceState[]} */
    const workspaces = model.workspaces.map((w) => {
      const panes = w.id === model.active ? view.panes : view.parked(w.id);
      const tree =
        panes &&
        mapTree(panes, (p) => {
          const id = uuid(p);
          return id && w.tabs.includes(id) ? id : undefined;
        });
      if (!tree) return w;
      // A hidden view keeps the tab shown alone as the selected one; core's snapshot writes it
      // as `alone` (docs/specs/side-panel-unsplit.md decision 24).
      const alone = tree.hidden && w.activeTab && !leaves(tree).some((l) => l.tab === w.activeTab);
      if (alone) return { ...w, panes: tree };
      const shown = showView(tree);
      const focus = leaves(tree).find((l) => l.pane === tree.focus)?.tab;
      return focus ? { ...w, panes: shown, activeTab: focus } : w;
    });
    return { ...model, workspaces };
  }

  /**
   * Writes the tab values and the window value, unless a restore is under way or the window
   * value was written by a newer vimma (canWrite).
   */
  #save() {
    const model = this.#model;
    if (!model || this.#pending || this.#win.closed) return;
    const SessionStore = lazy.SessionStore;
    /** @type {Record<string, string>} */
    const labels = {};
    for (const w of model.workspaces) {
      for (const id of w.tabs) {
        const tab = this.#tab(id);
        if (!tab) continue;
        if (this.#tabValue(tab, TAB_KEY) !== id) SessionStore.setCustomTabValue(tab, TAB_KEY, id);
        if (this.#tabValue(tab, TAB_WORKSPACE_KEY) !== w.id) {
          SessionStore.setCustomTabValue(tab, TAB_WORKSPACE_KEY, w.id);
        }
        const label = this.#tabValue(tab, TAB_LABEL_KEY);
        if (label) labels[id] = label;
      }
    }
    let existing;
    try {
      existing = SessionStore.getCustomWindowValue(this.#win, WINDOW_KEY);
    } catch {
      // Not tracked by SessionStore yet (before delayed startup): once it is.
      this.#win.delayedStartupPromise?.then(() => this.#scheduleSave());
      return;
    }
    if (!canWrite(existing)) return;
    let snapshot;
    try {
      snapshot = JSON.stringify(toSnapshot(this.#withPanes(model), { tabLabels: labels }));
      readSnapshot(snapshot);
    } catch (e) {
      console.warn("vimma: pane trees left out of the window's snapshot", e);
      snapshot = JSON.stringify(toSnapshot(model, { tabLabels: labels }));
    }
    if (snapshot === existing) return;
    this.#written = snapshot;
    SessionStore.setCustomWindowValue(this.#win, WINDOW_KEY, snapshot);
  }
}

/** @type {WeakMap<Window, WindowWorkspacesImpl>} */
const windows = new WeakMap();

/** One WindowWorkspaces per browser window; VimmaHost starts and stops them. */
export const WindowWorkspaces = Object.freeze({
  /**
   * @param {Window} win
   * @param {WindowWorkspacesOptions} [options]
   */
  init(win, options) {
    if (!windows.has(win)) windows.set(win, new WindowWorkspacesImpl(win, options));
    return /** @type {WindowWorkspacesImpl} */ (windows.get(win));
  },

  /** @param {Window} win */
  uninit(win) {
    windows.get(win)?.destroy();
    windows.delete(win);
  },

  /** @param {Window} win */
  get(win) {
    return windows.get(win);
  },
});

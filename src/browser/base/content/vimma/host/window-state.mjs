/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A window's widgets (help, command line, pickers, prompts, panels, element focus, the agent
// chat), each wired to the host through callbacks. VimmaHost.init builds the state here, then
// adds the listeners and registrations whose order matters. Every picker or prompt added later
// lands in this literal, so it lives apart from key dispatch. It never imports
// VimmaHost.sys.mjs: the host is an argument, as in runners.mjs, and what it needs from the host
// is `WindowHost` and `WindowStateEnv` below. The `:mcp log` picker reads the agent gate, so
// `init` builds it and hands it in: only the modules tools/layering's RESTRICTED lists import
// the gate.

import { HoverOps } from "./hover-ops.mjs";
import { createDispatcher } from "../core/dispatcher.mjs";
import { PageFirstQueue } from "../core/page-first.mjs";
import { CommandLine } from "../ui/cmdline.mjs";
import { HelpOverlay } from "../ui/help-overlay.mjs";
import { HintOverlay } from "../ui/hint-overlay.mjs";
import { Notice } from "../ui/notice.mjs";
import {
  AddonPicker,
  BookmarkPicker,
  DownloadPicker,
  GotoPicker,
  PermissionPicker,
  PopupPicker,
  SplitPicker,
  WorkspacePicker,
} from "../ui/picker.mjs";
import { RenamePrompt } from "../ui/rename-prompt.mjs";
import { focusOpener } from "../ui/toolbar.mjs";
import { SidePanel } from "../ui/side-panel.mjs";
import { BookmarksPanel } from "../ui/bookmarks-panel.mjs";
import { OutlinePanel } from "../ui/pdf-outline.mjs";
import { AgentChatWindow } from "../ui/agent-chat.mjs";
import { AgentPrompt } from "../ui/agent-prompt.mjs";
import { getTabLabel, setTabLabel } from "../workspaces/tab-labels.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { tabAsleep } from "../services/TabSleep.sys.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { DownloadRows, DownloadWatch, downloadPickerKey } from "./download-ops.mjs";
import { HostServices } from "./host-services.mjs";
import { Find } from "./find.mjs";
import { ElementFocus } from "./element-focus.mjs";
import { CHAT_SERVICES, giveSelectedTab } from "./agent-chat-ops.mjs";
import {
  bookmarkContext,
  openUserBookmark,
  pageSeen,
  runBookmarkEffect,
} from "./bookmark-actions.mjs";
import { bookmarkletsSetting, loadTree, observeBookmarks } from "./bookmark-ops.mjs";
import { pickerWorkspaces, selectedTabId, tabById } from "./goto.mjs";
import { goToTab, reopenClosed, tabSearchList } from "./tab-search.mjs";
import { GrepSession } from "./grep.mjs";
import { closeTabById, selectableTabs } from "./tab-ops.mjs";
import { sleepRows } from "./sleep-ops.mjs";
import { firefoxIds } from "./browser-ops.mjs";
import {
  hasPanes,
  showAlone,
  showSplit,
  showTabs,
  shownSplit,
  splitPickerRows,
} from "./pane-ops.mjs";
import { moveTabFromPicker, workspaceNames } from "./workspace-ops.mjs";
import {
  PRIVATE_WORKSPACE_ID,
  isPrivateBrowsing,
  isPrivateWorkspace,
  pickerItemsWithPrivate,
  pickerMove,
  pickerSelect,
  privatePanel,
} from "./private-ops.mjs";
import { AgentUi } from "./agent-ui.mjs";
import { UpdateUi } from "./update-ui.mjs";
import { addonNames, addonOp, addonPickerItems, openAddonById, sayAddon } from "./addon-ops.mjs";
import { sitePermissionItems, sitePermissionKey } from "./permission-ops.mjs";
import { popupPickerItems, popupRefusal, runPopupRow } from "./popup-ops.mjs";
import { PdfOps } from "./pdf-ops.mjs";
import { siteBindCompletions } from "./site-keys-ops.mjs";
import {
  dropOutlineAsk,
  followOutline,
  outlineClosed,
  showOutline,
  showOutlineBeside,
} from "./outline-ops.mjs";

/** @import { Keymap } from "../core/keymap.mjs" */
/** @import { OutlineHost } from "./outline-ops.mjs" */
/** @import { PageMode, VimmaHost, WindowState } from "./VimmaHost.sys.mjs" */

/**
 * What the widgets' callbacks call on the host.
 * @typedef {Pick<typeof VimmaHost, "_onKeyDown" | "_onKeyDownAfter" | "_onKeyPress"
 *   | "_onKeyPressAfter" | "_cancelPending" | "_cancelHints" | "_hintsScrolled" | "_runCommand"
 *   | "_emit" | "_mode" | "baseKeymap">} WindowHost
 */

/**
 * The host's module state the widgets reach: VimmaHost.sys.mjs keeps it, and this module does
 * not import that file.
 * @typedef {object} WindowStateEnv
 * @property {ReadonlySet<string>} runnable  the action ids the host runs (the help's dimmed rows)
 * @property {(browser: MozBrowser, mode: PageMode) => void} setBrowserMode
 * @property {(browser: MozBrowser | null | undefined) => WindowState | undefined} stateOfBrowser
 * @property {OutlineHost} outline  what the PDF outline needs from the host
 * @property {GotoPicker} mcpLog  `:mcp log`, built in `init` beside its gate import
 */

/**
 * A new window's state: its widgets, built and wired, with the slots `init` fills afterwards
 * (Firefox's keys, the tab strip, the toolbar, the status bar) still null.
 * @param {WindowHost} host
 * @param {BrowserWindow} win
 * @param {Keymap} keymap
 * @param {WindowStateEnv} env
 * @returns {WindowState}
 */
export function newWindowState(host, win, keymap, env) {
  /** @type {Map<string, BrowserWindow>} the window of each tab tab search listed (tab-search.mjs) */
  let tabWindows = new Map();
  const hintOverlay = new HintOverlay(win);
  /** @type {WindowState} */
  const state = {
    win,
    keymap,
    onKeyDown: (e) => host._onKeyDown(win, state, e),
    onKeyDownAfter: (e) => host._onKeyDownAfter(state, e),
    onKeyPress: (e) => host._onKeyPress(state, e),
    onKeyPressAfter: (e) => host._onKeyPressAfter(state, e),
    pageFirst: new PageFirstQueue(),
    firefoxKeys: null,
    private: isPrivateBrowsing(win),
    // The overlay is modal, but tabs can still change underneath it (a script closes the
    // selected tab): close it and focus the newly selected browser.
    onTabSelect: () => {
      host._cancelPending(win, state);
      host._cancelHints(state);
      state.find.onTabSelect();
      state.element.leave();
      HoverOps.onTabSelect(win);
      state.help.close({ tabChanged: true });
      state.cmdline.close({ tabChanged: true });
      state.picker.close({ tabChanged: true });
      state.wsPicker.close({ tabChanged: true });
      state.addonPicker.close({ tabChanged: true });
      state.permissionPicker.close({ tabChanged: true });
      state.popups.close({ tabChanged: true });
      state.splitPicker.close({ tabChanged: true });
      state.bookmarkPicker.close({ tabChanged: true });
      state.downloadPicker.close({ tabChanged: true });
      state.mcpLog.close({ tabChanged: true });
      state.grep.close({ tabChanged: true });
      state.rename.close({ tabChanged: true });
      // The outline belongs to its tab's document; the new tab's PDF shows its own.
      if (state.outline.isOpen && state.outline.browser !== win.gBrowser?.selectedBrowser) {
        state.outline.close();
      }
      showOutlineBeside(state, env.outline);
    },
    // What had focus when a dialog opened. A window dialog (gDialogBox) has taken focus by the
    // time `dialogopen` comes, so the element focused before the current one is kept as well.
    focusNow: null,
    focusBefore: null,
    /** @param {FocusEvent} e */
    onFocusIn: (e) => {
      const el = /** @type {Element | null} */ (e.target);
      if (!el || el === state.focusNow) return;
      state.focusBefore = state.focusNow;
      state.focusNow = el;
    },
    dialogOpener: null,
    // An element of a dialog that closed just before this one opened is no opener (focusin from
    // a dialog's frame reaches the window, so it can be in the frame's document): the opener
    // onDialogClose handed on from that dialog is kept.
    onDialogOpen: () => {
      const el = win.document.activeElement;
      const opener = el?.closest("dialog, .dialogOverlay") ? state.focusBefore : el;
      if (
        !opener ||
        opener.ownerDocument !== win.document ||
        opener.closest("dialog, .dialogOverlay")
      ) {
        return;
      }
      state.dialogOpener = opener;
    },
    // SubDialog gives focus back on close to what had it when the first dialog opened
    // (SubDialog.sys.mjs, `_onDialogClose` and `_topLevelPrevActiveElement`). One of Vimma's
    // surfaces closed since (a `:` line closed by a tab switch under its dialog, or open when a
    // background tab's dialog opened) is hidden and takes no focus: focus is then nowhere, the
    // mode insert with no field and every binding dead (#1304). The selected page gets it. The
    // hidden toolbar's address bar refuses that direct focus too; focusOpener reveals it first.
    // A window that is not the active one when its dialog closes (another window in front, or a
    // window manager slow to give the activation back) is looked at once it is active again,
    // after the focus manager has given its focused element the focus back (#1423). A window
    // dialog (gDialogBox) sits in a modal <dialog> that keeps the rest of the window inert until
    // its `close`, after the dialog's frame has unloaded (gDialogBox.open): the focus is looked
    // at only then. A window dialog opening as soon as one closes (a caller asking again straight
    // after the answer) inherits the first's opener until it closes.
    /** @param {Event} e */
    onDialogClose: (e) => {
      const opener = state.dialogOpener;
      state.dialogOpener = null;
      const modal = /** @type {HTMLDialogElement | null | undefined} */ (
        /** @type {Element | null} */ (e.target)?.closest?.("dialog")
      );
      const doc = win.document;
      const check = () => {
        if (modal?.open) {
          state.dialogOpener ??= opener;
          // Never outlives that dialog, should it close without its own dialogclose.
          const drop = () => {
            if (state.dialogOpener === opener) state.dialogOpener = null;
          };
          modal.addEventListener("close", drop, { once: true });
          return;
        }
        const lost = () => {
          const el = doc.activeElement;
          return (
            !el ||
            el === doc.documentElement ||
            el === doc.body ||
            !el.isConnected ||
            !el.checkVisibility()
          );
        };
        if (!lost()) return;
        // SubDialog's own focus() on it failed; focusOpener reveals a hidden address bar.
        if (opener?.isConnected) focusOpener(win, opener);
        if (lost()) win.gBrowser?.selectedBrowser.focus();
      };
      const settle = () =>
        win.setTimeout(() => {
          if (doc.hasFocus()) check();
          else win.addEventListener("activate", () => win.setTimeout(check, 0), { once: true });
        }, 0);
      if (modal?.open) modal.addEventListener("close", settle, { once: true });
      else settle();
    },
    dispatcher: createDispatcher(keymap),
    help: new HelpOverlay(win, keymap, env.runnable, () => state.firefoxKeys?.status().on ?? []),
    notice: new Notice(win),
    cmdline: new CommandLine(win, {
      run: (result) => host._runCommand(state, result),
      changed: () => host._emit(state),
      args: () => ({
        addon: addonNames(),
        firefox: firefoxIds(win),
        workspace: workspaceNames(win),
        // `:tab ` completes the workspace's tabs by number, each with what its tab shows.
        tab: selectableTabs(win).map((t) => getTabLabel(t) ?? t.label),
        search: SearchHost.completions,
        sitebind: siteBindCompletions(win, host.baseKeymap()),
        bookmarksfile: HostServices.bookmarksFileWords(),
      }),
    }),
    tabStrip: null,
    toolbar: null,
    urlbarQueries: null,
    urlbarCommands: null,
    promptKeys: null,
    timer: null,
    onCancelHints: () => host._cancelHints(state),
    onMouseDown: () => {
      host._cancelHints(state);
      state.element.leave();
    },
    onWheel: (e) => host._hintsScrolled(state, e),
    hint: null,
    element: new ElementFocus({
      overlay: hintOverlay,
      notify: (text) => state.notice.show(text),
      changed: () => host._emit(state),
      setMode: env.setBrowserMode,
    }),
    resize: false,
    hintOverlay,
    listeners: new Set(),
    statusBar: null,
    tabLine: null,
    tabLabels: null,
    picker: new GotoPicker(win, {
      items: () => {
        const { items, windowOf } = tabSearchList(win);
        tabWindows = windowOf;
        return items;
      },
      activeId: () => selectedTabId(win),
      select: (tabId) => goToTab(win, tabWindows.get(tabId), tabId),
      reopen: (id) => reopenClosed(win, id),
    }),
    // The private workspace is the last row (docs/specs/private-workspace.md decision 5).
    wsPicker: new WorkspacePicker(win, {
      items: () => pickerItemsWithPrivate(win),
      activeId: () =>
        isPrivateWorkspace(win)
          ? PRIVATE_WORKSPACE_ID
          : (WindowWorkspaces.get(win)?.model?.active ?? null),
      select: (id) => {
        const said = pickerSelect(win, id);
        const refused = said === undefined ? WindowWorkspaces.get(win)?.switchTo({ id }) : said;
        if (refused) state.notice.show(refused);
      },
      move: (id) => {
        const ask = (/** @type {string} */ q, /** @type {() => void} */ yes) =>
          state.rename.ask(q, yes);
        const said = pickerMove(win, id, ask, (text) => state.notice.show(text));
        if (said !== undefined) {
          if (said) state.notice.show(said);
          return;
        }
        const refused = moveTabFromPicker(
          win,
          id,
          (question, yes) => state.rename.ask(question, yes),
          (said) => state.notice.show(said),
        );
        if (refused) state.notice.show(refused);
      },
      // `m` on a side-panel row: that tab, which may be in the background (and lazy).
      moveRow: (tab, id) => {
        const ask = (/** @type {string} */ q, /** @type {() => void} */ yes) =>
          state.rename.ask(q, yes);
        const say = (/** @type {string} */ text) => state.notice.show(text);
        // The picker types its rows' tabs as elements: each is a tab of this window's strip.
        const row = /** @type {MozTabbrowserTab} */ (tab);
        const said = pickerMove(win, id, ask, say, row);
        const refused = said === undefined ? moveTabFromPicker(win, id, ask, say, row) : said;
        if (refused) state.notice.show(refused);
      },
    }),
    mcpLog: env.mcpLog,
    addonPicker: new AddonPicker(win, {
      load: addonPickerItems,
      select: (id) => void sayAddon(state, openAddonById(win, id)),
      addon: (op, id) => addonOp(state, op, id),
    }),
    permissionPicker: new PermissionPicker(win, {
      items: () => sitePermissionItems(win),
      activeId: () => null,
      select: () => {},
      permission: (op, id) => {
        const { notice, close } = sitePermissionKey(win, op, id);
        if (close) state.permissionPicker.close();
        else state.permissionPicker.setItems(sitePermissionItems(win));
        if (notice) state.notice.show(notice, { error: true });
      },
    }),
    downloads: new DownloadWatch(
      win,
      () => host._emit(state),
      (text) => state.statusBar?.announce(text),
    ),
    downloadRows: new DownloadRows(win, (rows) => state.downloadPicker.update(rows)),
    downloadPicker: new DownloadPicker(win, {
      load: () => state.downloadRows.open(),
      select: () => {},
      download: (key, id) =>
        downloadPickerKey(win, state.downloadRows, key, id, {
          say: (text, error) => state.notice.show(text, { error: !!error }),
          close: () => state.downloadPicker.close(),
          ask: (question, yes) => state.rename.ask(question, yes),
        }),
      closed: () => state.downloadRows.close(),
    }),
    splitPicker: new SplitPicker(win, {
      items: () => {
        const rows = splitPickerRows(win);
        return "items" in rows ? rows.items : [];
      },
      activeId: () => PaneViews.get(win)?.splits.shown?.toString() ?? null,
      select: (id) => {
        showSplit(win, Number(id));
        host._emit(state);
      },
    }),
    // docs/specs/bookmark-open.md: Enter opens the row as the panel's Enter does, or in a new tab.
    bookmarkPicker: new BookmarkPicker(win, {
      select: (id) => {
        const say = (/** @type {string} */ t) => state.notice.show(t, { error: true });
        const picker = state.bookmarkPicker;
        openUserBookmark({ ...bookmarkContext(state), say }, id, picker.where, {
          from: "command",
          listed: picker.row(id)?.listed,
          page: picker.page ?? pageSeen(win),
        }).catch((e) => {
          console.error("vimma: the bookmark could not open", e);
          say(`bookmark: ${e?.message ?? e}`);
        });
      },
    }),
    popups: new PopupPicker(win, {
      load: () => popupPickerItems(win),
      refuse: (rows) => popupRefusal(win, rows),
      notice: (text) => state.notice.show(text),
      select: (id) => {
        runPopupRow(win, id);
        host._emit(state);
      },
    }),
    grep: new GrepSession(win, {
      notice: (text) => state.notice.show(text),
      emit: () => host._emit(state),
    }),
    rename: new RenamePrompt(win, {
      apply: (tab, text) => {
        setTabLabel(tab, text);
        host._emit(state);
      },
      changed: () => host._emit(state),
    }),
    find: new Find(win, () => host._emit(state)),
    // The PDF viewer's page and match count (docs/specs/pdf-mode.md decision 13).
    stopPdf: PdfOps.subscribe((browser) => {
      if (env.stateOfBrowser(browser) !== state) return;
      // pdf.js opened another PDF in the viewer: the outline of the last one closes (V11).
      if (state.outline.isOpen && state.outline.browser === browser && !PdfOps.outline(browser)) {
        state.outline.close();
      }
      if (state.outline.browser === browser) {
        state.outline.followPage(PdfOps.state(browser)?.page ?? 1);
      }
      if (browser === win.gBrowser?.selectedBrowser) {
        showOutlineBeside(state, env.outline);
      }
      host._emit(state);
    }),
    // The outline Tab asked for: shown if its tab is still the selected one.
    outlineFor: null,
    stopOutline: PdfOps.subscribeOutline((browser, outline) => {
      if (browser !== state.outlineFor?.browser) {
        // The outline asked for as the PDF opened (decision 19): shown if it still may be.
        if (browser === win.gBrowser?.selectedBrowser) {
          showOutlineBeside(state, env.outline);
          host._emit(state);
        }
        return;
      }
      dropOutlineAsk(state);
      // Only into the state Tab was pressed in: its tab selected, in normal mode or with a panel
      // in the slot, which the outline replaces; never under a picker, prompt or the help.
      const selected = browser === win.gBrowser?.selectedBrowser;
      const mode = host._mode(state);
      if (selected && (mode === "normal" || mode === "panel")) {
        showOutline(state, browser, outline);
      }
      host._emit(state);
    }),
    // Resize mode ends once the window is down to one pane or its split hides (a tab closed,
    // another tab picked): cleared where the panes change, so reading the mode stays a read
    // (docs/security/01-control-socket.md S9).
    stopPanes: PaneViews.watch(win, () => {
      if (state.resize && !hasPanes(win)) state.resize = false;
    }),
    agentPrompt: new AgentPrompt(win),
    updatePrompt: new AgentPrompt(win, {
      id: "vimma-update-prompt",
      color: "var(--vimma-text-error)",
    }),
    onFocus: () => {
      AgentUi.onFocusChange(win);
      UpdateUi.onFocusChange(win);
      showOutlineBeside(state, env.outline);
    },
    panel: new SidePanel(win, {
      // A private window lists its tabs as the private workspace (private-workspace 6).
      model: () => {
        if (isPrivateWorkspace(win)) return privatePanel(pickerWorkspaces(win)).model;
        return WindowWorkspaces.get(win)?.model ? pickerWorkspaces(win) : null;
      },
      // The header names the cycle's targets, past the agent workspace (vimma-mcp decision 9).
      where: () =>
        isPrivateWorkspace(win)
          ? privatePanel(pickerWorkspaces(win)).options
          : { skip: WindowWorkspaces.get(win)?.cycleSkip },
      info: (tabId) => {
        const tab = tabById(win, tabId);
        if (!tab) return undefined;
        const browser = tab.linkedBrowser;
        return {
          title: browser?.contentTitle || tab.label,
          url: browser?.currentURI?.spec ?? "",
          label: getTabLabel(tab),
          foreign: !!WindowWorkspaces.get(win)?.isForeign(tab),
          playing: !!tab.soundPlaying,
          pinned: !!tab.pinned,
          asleep: tabAsleep(tab),
        };
      },
      closeTab: (tabId) => {
        const tab = tabById(win, tabId);
        if (tab) closeTabById(win, tab);
      },
      sleep: (rows) => {
        /** @type {{ tab: MozTabbrowserTab, number: number }[]} */
        const named = [];
        for (const { id, number } of rows) {
          const tab = tabById(win, id);
          if (tab) named.push({ tab, number });
        }
        sleepRows(win, named).then(
          (said) => state.notice.show(said),
          (e) => console.error("vimma: z in the side panel", e),
        );
      },
      move: (tabId) => {
        const tab = tabById(win, tabId);
        if (tab) state.wsPicker.openFor(tab, tab.linkedBrowser?.contentTitle || tab.label);
      },
      color: () => WindowWorkspaces.get(win)?.status()?.color,
      select: (tabId) => {
        const tab = tabById(win, tabId);
        if (!tab) return;
        /** @type {{ gBrowser: { selectedTab: Element } }} */ (
          /** @type {unknown} */ (win)
        ).gBrowser.selectedTab = tab;
      },
      say: (text) => state.notice.show(text),
      together: (tabIds, focus, alone) => showTabs(win, tabIds, focus, alone),
      // docs/specs/side-panel-unsplit.md: the split's panes start marked.
      split: () => shownSplit(win),
      alone: (tabId) => showAlone(win, tabId),
    }),
    outline: new OutlinePanel(win, {
      effect: (browser, effect) => {
        if (effect.type === "follow") followOutline(state, browser, effect.index);
      },
      left: (browser) => PdfOps.forget(browser),
      hidden: (browser) => outlineClosed(browser),
    }),
    bookmarks: new BookmarksPanel(win, {
      load: () => loadTree(win),
      observe: observeBookmarks,
      effect: (effect) => runBookmarkEffect(bookmarkContext(state), effect),
      bookmarklets: bookmarkletsSetting,
    }),
    agentChat: new AgentChatWindow(
      win,
      {
        ask: (question, yes) => state.rename.ask(question, yes),
        say: (text, error) => state.notice.show(text, { error: !!error }),
        give: (id) =>
          giveSelectedTab(
            win,
            id,
            (question, yes) => state.rename.ask(question, yes),
            (text) => state.notice.show(text),
          ),
        copy: (text) =>
          Cc["@mozilla.org/widget/clipboardhelper;1"]
            .getService(Ci.nsIClipboardHelper)
            .copyString(text),
        rearm: () => AgentUi.rearmSlot(win),
        prompt: (o) => state.rename.prompt(o),
        changed: () => {
          AgentUi.refresh();
          host._emit(state);
        },
      },
      CHAT_SERVICES,
    ),
    onAgentChat: () => host._emit(state),
  };
  return state;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Chrome-window key capture and dispatch (specs: docs/specs/m0-key-capture.md,
// docs/specs/m0-help-overlay.md, docs/specs/m1-actor-insert-scroll.md,
// docs/specs/m2-tab-keys.md, docs/specs/m1-cmdline.md, docs/specs/m2-picker-rename.md,
// docs/specs/m5-config-load.md). Sees every keydown
// before the URL bar, about: pages and the PDF viewer, runs it through the vimma-core
// dispatcher and consumes the keys that are ours.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { createDispatcher } from "../core/dispatcher.mjs";
import {
  insertEditCommand,
  insertModeAfterFocus,
  isEditable,
  matchSiteRule,
} from "../core/editable.mjs";
import { HintError, hintKey, startHints } from "../core/hints.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import { compileKeymap } from "../core/keymap.mjs";
import { describeAction, notImplementedText } from "../core/actions.mjs";
import {
  PENDING_ACTIONS,
  parseBookmarksToolbarCommand,
  parseCommandLine,
  parseToolbarCommand,
} from "../core/cmdline.mjs";
import { CommandLine } from "../ui/cmdline.mjs";
import { HelpOverlay } from "../ui/help-overlay.mjs";
import { HintOverlay } from "../ui/hint-overlay.mjs";
import { StatusBar } from "../ui/statusbar.mjs";
import { Find } from "./find.mjs";
import { copyModeRunners } from "./copy-mode.mjs";
import { ElementFocus } from "./element-focus.mjs";
import { pageRunners } from "./page-ops.mjs";
import { Notice } from "../ui/notice.mjs";
import { TabStrip } from "../ui/tabstrip.mjs";
import { Toolbar } from "../ui/toolbar.mjs";
import { BookmarksToolbar } from "../ui/bookmarks-toolbar.mjs";
import { bookmarksToolbarNotice } from "../core/bookmarks-toolbar.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { AddonPicker, GotoPicker, MCP_LOG, WorkspacePicker } from "../ui/picker.mjs";
import { RenamePrompt } from "../ui/rename-prompt.mjs";
import { SidePanel } from "../ui/side-panel.mjs";
import { BookmarksPanel } from "../ui/bookmarks-panel.mjs";
import { quickAdd, runBookmarkEffect } from "./bookmark-actions.mjs";
import { bookmarksRoot, loadTree, observeBookmarks, setBookmarksRoot } from "./bookmark-ops.mjs";
import { pickerWorkspaces, tabById } from "./goto.mjs";
import { goToTab, reopenClosed, tabSearchList } from "./tab-search.mjs";
import { GrepSession } from "./grep.mjs";
import { getTabLabel, setTabLabel } from "./tab-labels.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { VimmaUpdates } from "../updates/VimmaUpdates.sys.mjs";
import { refusedScheme } from "../core/pageurl.mjs";
import {
  BLOCKED_URL_TEXT,
  closeTab,
  closeTabById,
  newTab,
  openTyped,
  restoreTab,
  selectTab,
} from "./tab-ops.mjs";
import { DEFAULT_FIREFOX_KEYS, FirefoxKeys } from "./firefox-keys.mjs";
import { boundChords, firefoxShortcuts, pageFirst } from "../core/firefox-keys.mjs";
import { BROWSER_KEYS, browserRunners, firefoxIds, runKey } from "./browser-ops.mjs";
import { focusedChromeField, runChromeEdit } from "./edit-keys.mjs";
import { runRoute } from "./route-ops.mjs";
import {
  closePane,
  focusPane,
  hasPanes,
  layoutPanes,
  newPane,
  resizePane,
  showAlone,
  showTabs,
  shownSplit,
  splitPane,
  swapPane,
  zoomPane,
} from "./pane-ops.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { leaves } from "../core/panes.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import {
  NO_WORKSPACES,
  activeWorkspaceName,
  closeWorkspace,
  moveTabFromPicker,
  moveTabToWorkspace,
  newWorkspace,
  renameWorkspace,
  workspaceNames,
  workspaceRef,
} from "./workspace-ops.mjs";
import {
  MOVE_OUT_REFUSED,
  PRIVATE_WORKSPACE_ID,
  closePrivate,
  cycleOutOfPrivate,
  isPrivateBrowsing,
  isPrivateWorkspace,
  leavePrivate,
  pickerItemsWithPrivate,
  pickerMove,
  pickerSelect,
  privatePanel,
  privateStatus,
  privateTabCount,
  switchFromPrivate,
  togglePrivate,
} from "./private-ops.mjs";
import { restartVimma, tabsKeptBy } from "./restart.mjs";
import { restartConfirmation } from "../core/restart.mjs";
import { McpHost } from "./mcp-ops.mjs";
import { ControlHost } from "./control-ops.mjs";
import { AgentUi } from "./agent-ui.mjs";
import { AgentGate } from "../ctl/AgentGate.sys.mjs";
import { logCells } from "../core/agent-prompt.mjs";
import { PromptKeys } from "./prompt-keys.mjs";
import { AgentPrompt } from "../ui/agent-prompt.mjs";
import { ANNOUNCE_MS, UpdateUi } from "./update-ui.mjs";
import { parsePrivateCommand } from "../core/privatews.mjs";
import { findWorkspace } from "../core/workspaces.mjs";
import { KeyLog } from "../about/key-log.mjs";
import {
  addonNames,
  addonPickerItems,
  checkAddonUpdate,
  openAddonById,
  openAddonByName,
  openAddonOptions,
  removeAddon,
  toggleAddon,
  togglePrivateAccess,
} from "./addon-ops.mjs";

/** @import { Chord } from "../core/keys.mjs" */
/** @import { ConfigError } from "../core/config.mjs" */
/** @import { InsertSiteRule } from "../core/editable.mjs" */
/** @import { Mode } from "../core/modes.mjs" */
/** @import { FindStatus } from "../core/find.mjs" */
/** @import { Action, DispatchResult } from "../core/dispatcher.mjs" */
/** @import { EditableDescriptor, InsertTrigger } from "../core/editable.mjs" */
/** @import { Keymap, TrieNode } from "../core/keymap.mjs" */
/** @import { CommandResult } from "../core/cmdline.mjs" */
/** @import { HintAction, HintState } from "../core/hints.mjs" */
/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */
/** @import { AddonOp } from "../core/picker.mjs" */
/** @import { FirefoxKeySetting } from "../core/config.mjs" */
/** @import { BookmarksRoot } from "../core/bookmarks.mjs" */

/**
 * Hint mode in one window (m1-hints): from `f` until a label is chosen or Esc. While the
 * targets are being collected, keys are kept and replayed once the labels are up.
 * @typedef {object} HintSession
 * @property {any} browser  the <browser> the hints are on
 * @property {HintAction} action
 * @property {HintState<HintTarget> | null} hs  null while collecting
 * @property {Chord[]} buffered  keys typed while collecting
 */

/** Element focus with no text block on screen, and in the PDF viewer (element-focus 14). */
export const NO_BLOCKS = "no text blocks on screen";
export const NO_BLOCKS_PDF = "no text blocks here (PDF: use v)";

const DEBUG_PREF = "vimma.debug.keys";
const MAX_RECORDED = 50;
const MODIFIERS = /** @type {const} */ (["ctrl", "alt", "shift", "meta"]);
const MAC = /** @type {{ OS?: string }} */ (Services.appinfo).OS === "Darwin";
/** After the page, as Firefox's own key handlers (Tabbrowser's, the keysets). */
const SYSTEM_GROUP = /** @type {AddEventListenerOptions} */ ({ mozSystemGroup: true });
/** Before the page and before every chrome handler, as GlobalKeyListener's reply request. */
const SYSTEM_GROUP_CAPTURE = /** @type {AddEventListenerOptions} */ ({
  mozSystemGroup: true,
  capture: true,
});

/**
 * A keydown with Gecko's chrome-only members for keys that went to a page in another process.
 * @typedef {KeyboardEvent & { isReplyEventFromRemoteContent: boolean,
 *   requestReplyFromRemoteContent: () => void }} ChromeKeyEvent
 */

/**
 * A binding on a chord Firefox let the page override (docs/specs/firefox-keys.md decision 6):
 * its keydown went to the page, and it runs on the keypress after the page had it, unless the
 * page called preventDefault. `awaiting`: its keypress went to a remote page, whose reply runs it.
 * @typedef {{ key: string, result: DispatchResult, pressed: boolean, awaiting: boolean,
 *   mode: Mode }} PageFirst
 */

/** The most page-first keys kept waiting (a page that never replies cannot grow the queue). */
const PAGE_FIRST_MAX = 16;

/**
 * @typedef {object} WindowState
 * @property {Window} win
 * @property {Keymap} keymap
 * @property {(e: KeyboardEvent) => void} onKeyDown
 * @property {(e: KeyboardEvent) => void} onKeyDownAfter  after the page: text-field keys
 * @property {(e: KeyboardEvent) => void} onKeyPress  a page-first binding's keypress, before
 *   the page: asks a remote page for its reply, or takes the reply (firefox-keys decision 6)
 * @property {(e: KeyboardEvent) => void} onKeyPressAfter  the same keypress after a
 *   parent-process page or a chrome field had it
 * @property {PageFirst[]} pageFirst  bindings waiting for the page to leave their key alone,
 *   oldest first: keys typed fast (or held down) each wait for their own reply
 * @property {FirefoxKeys | null} firefoxKeys  Firefox's own shortcuts off (key-handling-batch)
 * @property {() => void} onTabSelect
 * @property {ReturnType<typeof createDispatcher>} dispatcher
 * @property {HelpOverlay} help
 * @property {Notice} notice  "<action>: not implemented yet" (m2-tab-keys)
 * @property {CommandLine} cmdline  the `:` line (m1-cmdline)
 * @property {TabStrip | null} tabStrip  hides Firefox's tab strip (m0-tabstrip-hidden)
 * @property {Toolbar | null} toolbar  hides Firefox's toolbar (docs/specs/toolbar-toggle.md)
 * @property {PromptKeys | null} promptKeys  y and n for Firefox's permission prompts
 * @property {number | null} timer   pending-sequence timeout (dispatcher.flush)
 * @property {() => void} onCancelHints  resize, a mouse click in chrome
 * @property {() => void} onMouseDown  a mouse click: hint mode and element focus end
 * @property {HintSession | null} hint
 * @property {ElementFocus} element  the focused text block (docs/specs/element-focus.md)
 * @property {HintOverlay} hintOverlay
 * @property {Set<() => void>} listeners  told after mode or pending keys may have changed
 * @property {StatusBar | null} statusBar  m2-statusbar-whichkey (the bar; no which-key strip)
 * @property {GotoPicker} picker  the prefix+g overlay (m2-picker-rename)
 * @property {WorkspacePicker} wsPicker  the prefix+w overlay (m3-workspaces 5)
 * @property {GotoPicker} mcpLog  `:mcp log`, the agents' last calls (docs/specs/mcp-drive.md D14)
 * @property {AddonPicker} addonPicker  the prefix+e overlay (docs/specs/addon-manager.md)
 * @property {GrepSession} grep  prefix+f g, `:grep`, `]q`/`[q` (docs/specs/live-grep.md)
 * @property {RenamePrompt} rename  the prefix+shift+t prompt (m2-picker-rename)
 * @property {AgentPrompt} agentPrompt  the agent question line (docs/specs/vimma-mcp.md)
 * @property {AgentPrompt} updatePrompt  the security update question
 *   (docs/specs/update-notices.md)
 * @property {() => void} onFocus  focus moved in the window: a question line may go back to
 *   waiting
 * @property {SidePanel} panel  prefix+b, `panel` mode while open (m3-workspaces 6)
 * @property {BookmarksPanel} bookmarks  prefix+shift+b, in the side panel's slot
 *   and `panel` mode (docs/specs/bookmarks.md)
 * @property {Find} find  `/`, `?`, `n`, `N` over Firefox's find bar (m1-find)
 * @property {boolean} private  a private window: its keys are not logged (private-workspace)
 * @property {boolean} resize  in resize mode (`prefix+r`, m4-split-panes sub-spec 5, ADR-014)
 */

/**
 * `tab.rename`: with a name (`:tabrename foo`) sets the label at once, else opens the prompt.
 * @param {WindowState} s
 * @param {string} [text]
 */
function renameTab(s, text) {
  const tab = /** @type {{ gBrowser: { selectedTab: Element } }} */ (/** @type {unknown} */ (s.win))
    .gBrowser.selectedTab;
  if (text) {
    setTabLabel(tab, text);
    VimmaHost._emit(s);
  } else {
    s.rename.open(tab, getTabLabel(tab) ?? "");
  }
}

/**
 * `:open` / `:tabnew` text, or the notice saying why not.
 * @param {WindowState} s
 * @param {string} text
 * @param {"current" | "tab"} where
 */
function openOrSay(s, text, where) {
  const refused = () => s.notice.show(BLOCKED_URL_TEXT, { error: true });
  // Said at once for the text as typed; a keyword resolving to one is known after the lookup.
  if (refusedScheme(text)) {
    refused();
    return;
  }
  openTyped(s.win, text, where)
    .then((opened) => {
      if (!opened) refused();
    })
    .catch((e) => console.error("vimma: cannot open", e));
}

/**
 * Runs a pane op (pane-ops.mjs) and shows its refusal, if any, as the notice.
 * @param {(win: Window, action: Action) => string | null} op
 * @returns {(state: WindowState, action: Action) => void}
 */
function paneRunner(op) {
  return (s, a) => {
    const refused = op(s.win, a);
    if (refused) s.notice.show(refused);
    VimmaHost._emit(s);
  };
}

/**
 * A layout preset (pane-ops.mjs `layoutPanes`): its notice is the preset's name or the refusal.
 * @param {WindowState} s
 * @param {Action} a
 * @param {string} [text]
 */
function layoutRunner(s, a, text) {
  s.notice.show(layoutPanes(s.win, a, text));
  VimmaHost._emit(s);
}

/**
 * `workspace.switch`: by number (`:workspace 2`) or name (`:workspace work`), `#` the previous
 * workspace as Vim's `:b#` (unless a workspace is named `#`); a key bound to switch_workspace
 * asks on the command line.
 * @param {WindowState} s
 * @param {string} [text]
 */
function switchWorkspace(s, text) {
  if (!text) {
    s.cmdline.open("workspace ");
    return;
  }
  // docs/specs/private-workspace.md: from private, `:ws name` is the normal window's workspace.
  if (isPrivateWorkspace(s.win)) {
    const back = text === "#";
    const refused = back
      ? leavePrivate()
      : switchFromPrivate((m) => findWorkspace(m, workspaceRef(text, m))?.id ?? null, text);
    if (refused) s.notice.show(refused);
    return;
  }
  const ww = WindowWorkspaces.get(s.win);
  const alternate = text === "#" && !ww?.model?.workspaces.some((w) => w.name === "#");
  // null is success, not "no model": `?? NO_WORKSPACES` would show it after every switch.
  /** @type {string | null} */
  let refused = NO_WORKSPACES;
  if (ww) refused = alternate ? ww.last() : ww.switchTo(workspaceRef(text, ww.model));
  if (refused) s.notice.show(refused);
}

/**
 * A workspace operation (workspace-ops.mjs) that takes the rest of a command line; without one
 * (its key) it asks on the command line, starting with `prompt`.
 * @param {(win: Window, text: string) => string | null} op
 * @param {(win: Window) => string} prompt
 * @returns {(state: WindowState, action: Action, text?: string) => void}
 */
function workspaceRunner(op, prompt) {
  return (s, _a, text) => {
    if (!text) {
      s.cmdline.open(prompt(s.win));
      return;
    }
    const said = op(s.win, text);
    if (said) s.notice.show(said);
    VimmaHost._emit(s);
  };
}

/**
 * `workspace.move_tab` in a normal window: `:wsmove name`, or its key asks. A move into the agent
 * workspace asks y/N first (docs/specs/vimma-mcp.md, decision 11).
 * @param {WindowState} s
 * @param {Action} a
 * @param {string} [text]
 */
const moveTab = (s, a, text) =>
  workspaceRunner(
    (win, t) =>
      moveTabToWorkspace(
        win,
        t,
        (question, yes) => s.rename.ask(question, yes),
        (said) => s.notice.show(said),
      ),
    () => "wsmove ",
  )(s, a, text);

/**
 * A workspace step (ctrl+b ) / ctrl+b (, ]w / [w, ctrl+^); shows its refusal, if any.
 * @param {"next" | "previous" | "last"} step
 * @returns {(state: WindowState) => void}
 */
function workspaceStep(step) {
  return (s) => {
    // docs/specs/private-workspace.md decision 5: from private, ) and ( go to the first and
    // last normal workspace, ctrl+^ back to the one left; in a normal window private is never
    // a target.
    if (isPrivateWorkspace(s.win)) {
      const refused = step === "last" ? leavePrivate() : cycleOutOfPrivate(step);
      if (refused) s.notice.show(refused);
      return;
    }
    const ww = WindowWorkspaces.get(s.win);
    const refused = ww ? ww[step]() : NO_WORKSPACES;
    if (refused) s.notice.show(refused);
  };
}

/**
 * The open panel `j`, `k`, `Enter`, `Esc` and digits go to: the bookmarks panel's, else the
 * side panel's (only one is open at a time).
 * @param {WindowState} s
 * @param {Action} a
 */
function panelAction(s, a) {
  if (s.bookmarks.isOpen) s.bookmarks.action(a);
  else s.panel.action(a);
}

/**
 * The bookmarks panel's own keys (`[modal.panel]` h, l, t, s, S, a, A, r, m, d, y, /); nothing
 * while it is closed (the side panel shares the mode).
 * @param {WindowState} s
 * @param {Action} a
 */
function bookmarksAction(s, a) {
  if (s.bookmarks.isOpen) s.bookmarks.action(a);
}

/**
 * `I` (focus_urlbar): Firefox's ctrl+l, the Browser:OpenLocation command (browser.js
 * openLocation: select the URL bar's text, open its results as a click would). The URL bar is
 * the selected tab's, so in a split the focused pane's. An open side or bookmarks panel closes
 * first, and copy mode ends, so neither is waiting when focus comes back to the page.
 * @param {WindowState} s
 */
function focusUrlbar(s) {
  s.panel.close();
  s.bookmarks.close();
  const browser = VimmaHost._contentBrowser(s);
  if (browser && browserModes.get(browser) === "visual") {
    VimmaActors.caret(browser, "exit");
    setBrowserMode(browser, "normal");
  }
  /** @type {any} */ (s.win.document.getElementById("Browser:OpenLocation"))?.doCommand();
}

/**
 * `ctrl+b u`, `:toolbar [show|hide]` (docs/specs/toolbar-toggle.md decisions 1, 2): one state
 * for every window (the pref); the notice says which, through the polite live region.
 * @param {WindowState} s
 * @param {ReturnType<typeof parseToolbarCommand>} command
 */
function setToolbar(s, command) {
  s.notice.hide();
  if (command.kind === "refuse") {
    s.notice.show(command.text, { error: true });
    return;
  }
  const hidden = command.kind === "toggle" ? !Toolbar.hidden : command.kind === "hide";
  Toolbar.setHidden(hidden);
  s.notice.show(hidden ? "toolbar hidden" : "toolbar shown");
}

/**
 * Firefox's Bookmarks Toolbar (docs/specs/bookmarks-toolbar-hidden.md): one state for every
 * window. Without a word, Firefox's own toggle (its ctrl+shift+b handler, between "always" and
 * "never"); a word sets that state. The notice says which, and "until restart" while
 * config.toml sets the key (decision 4).
 * @param {WindowState} s
 * @param {ReturnType<typeof parseBookmarksToolbarCommand>} command
 */
function setBookmarksToolbar(s, command) {
  s.notice.hide();
  if (command.kind === "refuse") {
    s.notice.show(command.text, { error: true });
    return;
  }
  if (command.kind === "set") BookmarksToolbar.set(command.setting);
  else if (!runKey(s.win, BROWSER_KEYS["browser.bookmarks_toolbar"])) return;
  s.notice.show(bookmarksToolbarNotice(BookmarksToolbar.visibility, BookmarksToolbar.configured));
}

/**
 * Shows an add-on op's answer, if any, as the notice; a failure too.
 * @param {WindowState} s
 * @param {Promise<string | null>} op
 * @returns {Promise<void>}
 */
function sayAddon(s, op) {
  return op.then(
    (text) => {
      if (text) s.notice.show(text);
    },
    (e) => {
      console.error("vimma: add-on", e);
      s.notice.show(`add-on: ${e?.message ?? e}`, { error: true });
    },
  );
}

/**
 * A key in the add-on picker (docs/specs/addon-manager.md): `o` and `d` close it first (a tab,
 * the y/N prompt); `x`, `shift+p` and `u` keep it open and refresh its rows.
 * @param {WindowState} s
 * @param {AddonOp} op
 * @param {string} id
 */
function addonOp(s, op, id) {
  const refresh = () => s.addonPicker.refresh().catch((e) => console.error("vimma: add-ons", e));
  switch (op) {
    case "options":
      s.addonPicker.close();
      sayAddon(s, openAddonOptions(s.win, id));
      return;
    case "remove":
      s.addonPicker.close();
      sayAddon(
        s,
        removeAddon(
          id,
          (question, yes) => s.rename.ask(question, yes),
          (said) => s.notice.show(said),
        ),
      );
      return;
    case "toggle":
      sayAddon(s, toggleAddon(id)).then(refresh);
      return;
    case "private":
      sayAddon(s, togglePrivateAccess(id)).then(refresh);
      return;
    case "update":
      s.notice.show("checking for updates…");
      sayAddon(s, checkAddonUpdate(id)).then(refresh);
  }
}

/**
 * Restarts Vimma now (docs/specs/m6a-updater.md §5); says so when something cancelled it. An
 * AppImage starts its own file again, and only when this Vimma is the AppImage `$APPIMAGE`
 * names, never one it inherited the variable from.
 * @param {WindowState} s
 */
async function restartNow(s) {
  const appImage = await VimmaUpdates.ownAppImage();
  const going = restartVimma({ installType: appImage ? "appimage" : null, appImage });
  if (!going) s.notice.show("restart cancelled");
}

/** @param {WindowState} s */
function restartOrSay(s) {
  restartNow(s).catch((e) => {
    console.error("vimma: :restart failed", e);
    s.notice.show(`restart failed: ${e?.message ?? e}`, { error: true });
  });
}

/**
 * `:restart`: asks first when tabs would be lost (core restartConfirmation), as `:private close`
 * asks before it closes the private workspace.
 * @param {WindowState} s
 */
async function restartAsking(s) {
  const appImage = await VimmaUpdates.ownAppImage();
  const question = restartConfirmation({
    privateTabs: privateTabCount(),
    tabsKept: tabsKeptBy(appImage),
  });
  if (question) s.rename.ask(question, () => restartOrSay(s));
  else restartOrSay(s);
}

/**
 * `:update` (docs/specs/m6a-updater.md): checks now and says the result; an update opens
 * about:vimma's Updates section, which shows the exact steps for this install.
 * @param {WindowState} s
 */
async function checkUpdates(s) {
  s.notice.show("checking for updates…");
  const r = await VimmaUpdates.check();
  switch (r.outcome) {
    case "offer": {
      const offer = /** @type {NonNullable<typeof r.offer>} */ (r.offer);
      // The AppImage replaces its own file (decision 19): say how far it got.
      const stage = VimmaUpdates.status().stage;
      if (stage === "staged") {
        s.notice.show(`Vimma ${offer.displayVersion} is installed · restart Vimma to use it`);
        return;
      }
      if (stage === "pending") {
        s.notice.show(`Vimma ${offer.displayVersion} is downloading; it replaces this AppImage`);
        return;
      }
      s.notice.show(`Vimma ${offer.displayVersion} is available`);
      openOrSay(s, "about:vimma#updates", "tab");
      return;
    }
    case "current":
      s.notice.show(`Vimma ${VimmaUpdates.runningVersion} is up to date`);
      return;
    case "off":
      s.notice.show("updates are off ([updates] check or vimma.update.enabled)");
      return;
    case "source":
      s.notice.show("a source build: pull and rebuild to update");
      return;
    default:
      s.notice.show(`update check ${r.outcome}: ${r.reason}`, { error: true });
  }
}

/**
 * What the bookmark effects run with.
 * @param {WindowState} s
 */
function bookmarkContext(s) {
  return {
    win: s.win,
    prompt: s.rename,
    panel: s.bookmarks,
    say: (/** @type {string} */ text) => s.notice.show(text),
  };
}

/**
 * Pane actions that do something only with two panes or more: as single keys they are
 * runnable only then, so the first ctrl+w of `<C-w>h` passes to the page while the window has
 * one pane (plan §2; Firefox's ctrl+w close tab is off, key-handling-batch). `prefix+h` is
 * consumed either way (ctrl+b is ours).
 */
const MULTI_PANE = new Set([
  "pane.focus_left",
  "pane.focus_down",
  "pane.focus_up",
  "pane.focus_right",
  "pane.zoom",
  "pane.swap_left",
  "pane.swap_down",
  "pane.swap_up",
  "pane.swap_right",
  "pane.resize_narrower",
  "pane.resize_wider",
  "pane.resize_taller",
  "pane.resize_shorter",
]);

/**
 * What the host can execute so far, with CONTENT_RUNNERS. An action without an entry is left to
 * Firefox when it is a single key outside help; inside a sequence (or after a count) it is
 * consumed and shows "<action>: not implemented yet", so `ctrl+b <key>` never leaks the second key to the page and is never silent
 * (m2-tab-keys). Unbound keys always pass (m1-actor-insert-scroll, Settled). `text` is a
 * command's free-text argument (`:open example.com`, m1-cmdline); keys never carry one.
 * @type {Record<string, (state: WindowState, action: Action, text?: string) => void>}
 */
export const RUNNERS = Object.freeze({
  // The overlay is the one list of bindings on screen: a toast from an earlier key gives way.
  "help.show": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    s.help.toggle();
  },
  "help.close": (/** @type {WindowState} */ s) => s.help.close(),
  "help.filter": (/** @type {WindowState} */ s) => s.help.focusFilter(),
  "hint.cancel": (/** @type {WindowState} */ s) => VimmaHost._cancelHints(s),
  "tab.new": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
    text ? openOrSay(s, text, "tab") : newTab(s.win),
  "tab.next": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
  "tab.previous": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
  "tab.goto": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
  // Firefox's alt+9: the workspace's last visible tab (docs/specs/firefox-keys.md).
  "tab.goto_last": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
  "tab.close": (/** @type {WindowState} */ s) => closeTab(s.win),
  // The focused pane; the last pane closes the tab (`:q`, prefix+x; m4-split-panes).
  "pane.close": paneRunner(closePane),
  "pane.split_vertical": paneRunner(splitPane),
  "pane.split_horizontal": paneRunner(splitPane),
  "pane.focus_left": paneRunner(focusPane),
  "pane.focus_down": paneRunner(focusPane),
  "pane.focus_up": paneRunner(focusPane),
  "pane.focus_right": paneRunner(focusPane),
  "pane.zoom": paneRunner(zoomPane),
  "pane.swap_left": paneRunner(swapPane),
  "pane.swap_down": paneRunner(swapPane),
  "pane.swap_up": paneRunner(swapPane),
  "pane.swap_right": paneRunner(swapPane),
  "pane.resize_narrower": paneRunner(resizePane),
  "pane.resize_wider": paneRunner(resizePane),
  "pane.resize_taller": paneRunner(resizePane),
  "pane.resize_shorter": paneRunner(resizePane),
  // docs/specs/tiling-layouts.md: dwindle's new pane, tmux's presets; the notice names the preset.
  "pane.new": paneRunner(newPane),
  "pane.next_layout": layoutRunner,
  "pane.layout_even_horizontal": layoutRunner,
  "pane.layout_even_vertical": layoutRunner,
  "pane.layout_main_vertical": layoutRunner,
  "pane.layout_main_horizontal": layoutRunner,
  "pane.layout_tiled": layoutRunner,
  "pane.layout_dwindle": layoutRunner,
  // A key bound to select_layout asks for the name on the command line.
  "pane.select_layout": (/** @type {WindowState} */ s, /** @type {Action} */ a, text) =>
    text ? layoutRunner(s, a, text) : s.cmdline.open("layout "),
  // Resize mode (ADR-014): modal, window-wide, while the window shows two panes or more.
  "pane.resize_mode": (/** @type {WindowState} */ s, /** @type {Action} */ a) => {
    if (!hasPanes(s.win)) {
      s.notice.show(`${describeAction(a)}: only one pane`);
      return;
    }
    s.notice.hide();
    s.resize = true;
  },
  "pane.resize_exit": (/** @type {WindowState} */ s) => {
    s.resize = false;
  },
  // Without text (a key bound to open_url) it asks for the URL on the command line.
  "page.open": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
    text ? openOrSay(s, text, "current") : s.cmdline.open("open "),
  "urlbar.focus": focusUrlbar,
  "command.open": (/** @type {WindowState} */ s) => s.cmdline.open(),
  "command.cancel": (/** @type {WindowState} */ s) => s.cmdline.close(),
  // Tab search (docs/specs/tab-search.md); `:tabsearch text` opens it with the text typed.
  "goto.picker": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    s.notice.hide();
    s.picker.open({ query: text ?? "" });
  },
  // docs/specs/live-grep.md: the key opens it empty, `:grep text` with that query.
  "grep.open": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    s.notice.hide();
    s.grep.open(text);
  },
  "grep.resume": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    s.grep.resume();
  },
  "grep.next": (/** @type {WindowState} */ s) => void s.grep.step(1),
  "grep.previous": (/** @type {WindowState} */ s) => void s.grep.step(-1),
  "tab.rename": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
    renameTab(s, text),
  // m3-workspaces 5: prefix+w (and `:workspace` without a name).
  "workspace.picker": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    // The private workspace lists the normal ones too (private-workspace decision 5).
    if (WindowWorkspaces.get(s.win)?.model || isPrivateWorkspace(s.win)) s.wsPicker.open();
    else s.notice.show(NO_WORKSPACES);
  },
  // m3-workspaces 2b: one workspace's tabs visible at a time (WindowWorkspaces).
  "workspace.next": workspaceStep("next"),
  "workspace.previous": workspaceStep("previous"),
  // Vim's ctrl+^ (alternate buffer), tmux's last session: the window's previous workspace.
  "workspace.last": workspaceStep("last"),
  "workspace.switch": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
    switchWorkspace(s, text),
  // m3-workspaces 4a/4b: new, rename, close (asks y/N), move the tab (workspace-ops.mjs).
  "workspace.new": workspaceRunner(newWorkspace, () => "wsnew "),
  "workspace.rename": workspaceRunner(
    renameWorkspace,
    (win) => `wsrename ${activeWorkspaceName(win) ?? ""}`,
  ),
  "workspace.move_tab": (/** @type {WindowState} */ s, /** @type {Action} */ a, text) => {
    // private-workspace decision 5: a private tab never leaves the private workspace.
    if (isPrivateWorkspace(s.win)) s.notice.show(MOVE_OUT_REFUSED);
    else moveTab(s, a, text);
  },
  // docs/specs/private-workspace.md: toggles; `:private close` closes it after y/N.
  "workspace.private": (
    /** @type {WindowState} */ s,
    _a,
    /** @type {string | undefined} */ text,
  ) => {
    s.notice.hide();
    const command = parsePrivateCommand(text);
    const said =
      command.kind === "refuse"
        ? command.text
        : command.kind === "close"
          ? closePrivate((q, yes) => s.rename.ask(q, yes))
          : togglePrivate(s.win);
    if (said) s.notice.show(said);
  },
  // workspace-routing: `:route` lists the rules (about:vimma); `add [workspace]`, `move`.
  "workspace.route": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    s.notice.hide();
    const said = runRoute(s.win, text ?? "", (t) => s.notice.show(t));
    if (said) s.notice.show(said);
  },
  "workspace.close": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    s.notice.hide();
    // In private, ctrl+b shift+d and `:wd` close the private workspace (decision 3).
    if (!text && isPrivateWorkspace(s.win)) {
      const refused = closePrivate((q, yes) => s.rename.ask(q, yes));
      if (refused) s.notice.show(refused);
      return;
    }
    const refused = closeWorkspace(
      s.win,
      text,
      (question, yes) => s.rename.ask(question, yes),
      (said) => s.notice.show(said),
      (question, choices) => s.rename.choose(question, choices),
    );
    if (refused) s.notice.show(refused);
  },
  // m3-workspaces 6: the side panel; its own keys run in `panel` mode while it is open.
  "sidebar.toggle": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    if (s.panel.isOpen) s.panel.close();
    else {
      s.bookmarks.close(); // one panel in the slot at a time
      if (!s.panel.open()) s.notice.show(NO_WORKSPACES);
    }
  },
  "toolbar.toggle": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
    setToolbar(s, parseToolbarCommand(text)),
  "toolbar.show": (/** @type {WindowState} */ s) => setToolbar(s, { kind: "show" }),
  "toolbar.hide": (/** @type {WindowState} */ s) => setToolbar(s, { kind: "hide" }),
  "panel.down": panelAction,
  "panel.up": panelAction,
  "panel.open": panelAction,
  "panel.select": panelAction,
  "panel.close": panelAction,
  // key-handling-batch § 4: x in the side panel; nothing in the bookmarks panel (d deletes there).
  "panel.close_tab": (/** @type {WindowState} */ s, /** @type {Action} */ a) => {
    if (!s.bookmarks.isOpen) s.panel.action(a);
  },
  // m4-side-panel-multiselect: marks in the side panel; nothing in the bookmarks panel.
  "panel.mark": (/** @type {WindowState} */ s, /** @type {Action} */ a) => {
    if (!s.bookmarks.isOpen) s.panel.action(a);
  },
  "panel.visual": (/** @type {WindowState} */ s, /** @type {Action} */ a) => {
    if (!s.bookmarks.isOpen) s.panel.action(a);
  },
  // `m`: the bookmarks panel's move to a folder, or the side panel's move to a workspace.
  "panel.move": panelAction,
  // Firefox's ctrl+shift+t, in every mode (docs/specs/firefox-keys.md decision 7).
  "tab.restore": (/** @type {WindowState} */ s) => restoreTab(s.win),
  // docs/specs/firefox-keys.md decision 4: the Browser and Developer tools actions, each what
  // Firefox's key ran (browser-ops.mjs).
  ...browserRunners((win, text) => states.get(win)?.notice.show(text)),
  // ctrl+shift+b and `:bookmarkstoolbar [show|hide|newtab]` (bookmarks-toolbar-hidden decision
  // 5): Firefox's own toggle, or a known state, with a notice.
  "browser.bookmarks_toolbar": (
    /** @type {WindowState} */ s,
    /** @type {Action} */ _a,
    /** @type {string | undefined} */ text,
  ) => setBookmarksToolbar(s, parseBookmarksToolbarCommand(text)),
  // A `:` binding in config.toml (docs/specs/firefox-keys.md decision 5): its line, as typed.
  "cmdline.run": (/** @type {WindowState} */ s, /** @type {Action} */ a) => {
    const result = parseCommandLine(a.line ?? "");
    if (result.kind === "run") VimmaHost._runCommand(s, result);
    else if (result.kind === "error") s.notice.show(result.error.message, { error: true });
  },
  // `:restart`: asks first when tabs would be lost (private ones, or all of them).
  "app.restart": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    restartAsking(s).catch((e) => {
      console.error("vimma: :restart failed", e);
      s.notice.show(`restart failed: ${e?.message ?? e}`, { error: true });
    });
  },
  "app.update_check": (/** @type {WindowState} */ s) => {
    checkUpdates(s).catch((e) => {
      console.error("vimma: :update failed", e);
      s.notice.show(`update check failed: ${e?.message ?? e}`, { error: true });
    });
  },
  // docs/specs/bookmarks.md: the bookmarks panel, in the side panel's slot and mode.
  "bookmarks.toggle": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    if (s.bookmarks.isOpen) s.bookmarks.close();
    else {
      s.panel.close();
      s.bookmarks.open();
    }
  },
  "bookmark.add": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    quickAdd(bookmarkContext(s), text).catch((e) => {
      console.error("vimma: bookmark failed", e);
      s.notice.show(`bookmark: ${e?.message ?? e}`, { error: true });
    });
  },
  "bookmarks.collapse": bookmarksAction,
  "bookmarks.expand": bookmarksAction,
  "bookmarks.open_tab": bookmarksAction,
  "bookmarks.open_vsplit": bookmarksAction,
  "bookmarks.open_hsplit": bookmarksAction,
  "bookmarks.add": bookmarksAction,
  "bookmarks.add_folder": bookmarksAction,
  "bookmarks.rename": bookmarksAction,
  "bookmarks.move": bookmarksAction,
  "bookmarks.delete": bookmarksAction,
  "bookmarks.yank": bookmarksAction,
  "bookmarks.filter": bookmarksAction,
  // docs/specs/addon-manager.md: prefix+e / :addons, and :addon <name> (without one it asks).
  "addons.picker": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    s.addonPicker.open();
  },
  "addons.popup": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    if (!text) s.cmdline.open("addon ");
    else sayAddon(s, openAddonByName(s.win, text));
  },
  // `:source` (m5-config-load): ConfigHost reads config.toml now instead of at the next poll;
  // `:source <path>` passes the path as typed, which ConfigHost expands.
  "config.reload": (_s, _a, /** @type {string | undefined} */ text) =>
    Services.obs.notifyObservers(null, CONFIG_RELOAD_TOPIC, text ?? ""),
  // `:setup` (first-run-setup decision 14): the setup page in a new tab, at the welcome screen.
  "setup.open": (/** @type {WindowState} */ s) => openOrSay(s, "about:vimma-setup", "tab"),
  // `:config`: ConfigHost opens config.toml in a tab of this window (creating it if missing).
  "config.edit": (/** @type {WindowState} */ s) =>
    Services.obs.notifyObservers(/** @type {any} */ (s.win), CONFIG_EDIT_TOPIC),
  // `:mcp [on|off|forget]` (docs/specs/vimma-mcp.md): agents and the agent workspace.
  "mcp.command": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) => {
    s.notice.hide();
    const said = McpHost.run(
      text,
      (question, yes) => s.rename.ask(question, yes),
      (t) => s.notice.show(t),
      () => s.mcpLog.open(),
    );
    if (said) s.notice.show(said);
  },
  // prefix+shift+a (docs/specs/vimma-mcp.md decision 14): the waiting agent question, or with
  // none, revoke the grants after y/N.
  "mcp.answer": (/** @type {WindowState} */ s) => {
    s.notice.hide();
    AgentUi.answer(s.win);
  },
  // `:control [on <minutes>|off]` (decision 29 D): full control for a while.
  "control.command": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ t) => {
    s.notice.hide();
    const said = ControlHost.run(
      t,
      (question, yes) => s.rename.ask(question, yes),
      (text) => s.notice.show(text),
      () => (McpHost.state.enabled ? McpHost.workspaceName : null),
    );
    if (said) s.notice.show(said);
  },
  // `:theme [dark|light|system]` (docs/specs/theme-appearance.md): the built-in palette.
  "theme.appearance": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ t) => {
    const said = ThemeHost.setAppearance(s.win, t);
    s.notice.show(said.text, { error: said.error });
  },
});

/**
 * The page mode of each tab's <browser>, from the actor's focus reports; absent = normal.
 * Written only through setBrowserMode.
 * @type {WeakMap<object, PageMode>}
 */
const browserModes = new WeakMap();

/** @typedef {"normal" | "insert" | "visual"} PageMode  visual: copy mode (m1-copy-mode) */

/**
 * @param {any} browser
 * @param {PageMode} mode
 */
function setBrowserMode(browser, mode) {
  if (mode !== "insert") explicitInsert.delete(browser);
  else escapeHold.delete(browser);
  if ((browserModes.get(browser) ?? "normal") === mode) return;
  browserModes.set(browser, mode);
  VimmaHost.onModeChange(browser, mode);
}

/**
 * Tabs in explicit insert (`i`, `gi`; docs/specs/insert-focus.md): the inner window ID of the
 * top document it was entered on. Focus reports from that document do not end it; Esc does, as
 * does any other change to normal mode (setBrowserMode). A new top document starts over.
 * @type {WeakMap<object, number>}
 */
const explicitInsert = new WeakMap();

/**
 * Tabs whose user pressed Esc (docs/specs/insert-focus.md, behaviour 6): the inner window ID of
 * the top document it was pressed on. While it is shown, a focus the page's script makes on its
 * own does not enter insert. Entering insert, a focus report the user's input caused, a key the
 * page gets and a new top document end the hold.
 * @type {WeakMap<object, number>}
 */
const escapeHold = new WeakMap();

/**
 * The document of each tab that Esc's blur last went to, and that blur's generation
 * (behaviour 7): a report from that document with an older generation was sent before the
 * blur and is dropped.
 * @type {WeakMap<object, { windowId: number, gen: number }>}
 */
const lastBlur = new WeakMap();

/** @param {any} browser */
function topWindowId(browser) {
  return browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
}

/**
 * Enters explicit insert in `browser`'s tab.
 * @param {any} browser
 */
function enterExplicitInsert(browser) {
  setBrowserMode(browser, "insert");
  explicitInsert.set(browser, topWindowId(browser));
}

/**
 * The frame of each tab whose text field last took focus, and its document's inner window ID,
 * so `i` can go back to that field.
 * @type {WeakMap<object, { frame: any, windowId: number }>}  browser → BrowsingContext and ID
 */
const lastFieldFrame = new WeakMap();

/**
 * Shows `text` as the notice of the window that owns `browser`.
 * @param {any} browser
 * @param {string} text
 */
function noticeFor(browser, text) {
  const win = browser?.ownerDocument?.defaultView;
  (win && states.get(win))?.notice.show(text);
}

/**
 * The element focus of the window that owns `browser`, while that browser is in ELEMENT mode.
 * @param {any} browser
 * @returns {ElementFocus | null}
 */
function elementOf(browser) {
  const win = browser?.ownerDocument?.defaultView;
  const element = (win && states.get(win))?.element;
  return element?.browser === browser ? element : null;
}

/**
 * Actions on the focused page (m1-actor-insert-scroll). Runnable only while a content browser
 * with our actor has focus; elsewhere (the URL bar) they count as not runnable, so Esc there
 * still reaches Firefox. Every runnable id is a key of RUNNERS or CONTENT_RUNNERS; whether one
 * runs right now is `VimmaHost._runnable(state, id)`.
 * @type {Readonly<Record<string, (browser: any, action: Action) => void>>}
 */
export const CONTENT_RUNNERS = Object.freeze({
  "scroll.down": (b, a) => VimmaActors.scroll(b, "down", a.count),
  "scroll.up": (b, a) => VimmaActors.scroll(b, "up", a.count),
  "scroll.left": (b, a) => VimmaActors.scroll(b, "left", a.count),
  "scroll.right": (b, a) => VimmaActors.scroll(b, "right", a.count),
  "scroll.half_down": (b, a) => VimmaActors.scroll(b, "half_down", a.count),
  "scroll.half_up": (b, a) => VimmaActors.scroll(b, "half_up", a.count),
  "scroll.top": (b) => VimmaActors.scroll(b, "top"),
  "scroll.bottom": (b) => VimmaActors.scroll(b, "bottom"),
  // History and reload act on the focused page's <browser>, so in a split the focused pane's
  // (plan §2, M1 navigation keys). In insert mode the keys are the page's (normal-only bindings).
  "history.back": (b, a) => goHistory(b, -(a.count ?? 1)),
  "history.forward": (b, a) => goHistory(b, a.count ?? 1),
  "page.reload": (b) => b.reload(),
  // Esc in insert (escape.mjs: blur); the focusout recheck that follows stays in normal.
  "mode.normal": (b) => {
    // Esc in copy mode: the frame drops its selection and caret first.
    if (browserModes.get(b) === "visual") VimmaActors.caret(b, "exit");
    setBrowserMode(b, "normal");
    escapeHold.set(b, topWindowId(b));
    const blur = VimmaActors.blur(b);
    if (blur) lastBlur.set(b, blur);
    else lastBlur.delete(b);
  },
  "hint.follow": (b, a) => VimmaHost._startHints(b, a),
  "hint.follow_new_tab": (b, a) => VimmaHost._startHints(b, a),
  "hint.element": (b, a) => VimmaHost._startHints(b, a),
  // The ELEMENT mode's keys (docs/specs/element-focus.md decision 7).
  "element.visual": (b) => elementOf(b)?.visual(false),
  "element.visual_line": (b) => elementOf(b)?.visual(true),
  "element.yank": (b) => elementOf(b)?.yank(),
  "element.parent": (b, a) => elementOf(b)?.move("parent", a.count),
  "element.child": (b, a) => elementOf(b)?.move("child", a.count),
  "element.next": (b, a) => elementOf(b)?.move("next", a.count),
  "element.prev": (b, a) => elementOf(b)?.move("prev", a.count),
  // Explicit insert, even with no text field to focus (pass-through for pages that take keys).
  // The field the user was last in comes first, then the page's first one (insert-focus).
  "mode.insert": (b) => {
    enterExplicitInsert(b);
    VimmaActors.focusInput(b, lastFieldFrame.get(b));
  },
  // Find in page over Firefox's find bar (m1-find).
  "find.forward": (b) => findOf(b)?.start(b, false),
  "find.backward": (b) => findOf(b)?.start(b, true),
  "find.next": (b) => findOf(b)?.again(b, false),
  "find.previous": (b) => findOf(b)?.again(b, true),
  // Copy mode: caret, selection and yank in the focused frame (m1-copy-mode).
  ...copyModeRunners(setBrowserMode, noticeFor),
  // yy, p / P, gi, gu / gU, gf (m1-actor-insert-scroll, follow-up: normal-mode extras).
  ...pageRunners(enterExplicitInsert, noticeFor),
});

/**
 * Moves `browser` `delta` entries through its session history, clamped to the first and last
 * entry (`5H` on the third page lands on the first). One step goes through goBack/goForward,
 * which skip entries the user never interacted with, like the toolbar buttons.
 * @param {any} browser
 * @param {number} delta  negative goes back
 */
function goHistory(browser, delta) {
  if (delta === -1) return browser.goBack();
  if (delta === 1) return browser.goForward();
  const history = browser.browsingContext?.sessionHistory;
  if (!history) return undefined;
  const index = Math.min(Math.max(history.index + delta, 0), history.count - 1);
  if (index !== history.index) browser.gotoIndex(index);
  return undefined;
}

/**
 * The find state of the window that owns `browser`.
 * @param {any} browser
 * @returns {Find | undefined}
 */
function findOf(browser) {
  const win = browser?.ownerDocument?.defaultView;
  return (win && states.get(win))?.find ?? undefined;
}

/**
 * Content actions that Firefox's keys also run where no page of ours has focus (the address bar,
 * a page without our actor): `alt+left`, `F5`, `ctrl+g` act on the selected tab's page then, as
 * Firefox's did (docs/specs/firefox-keys.md).
 */
const ON_SELECTED = new Set([
  "history.back",
  "history.forward",
  "page.reload",
  "find.next",
  "find.previous",
]);

/** Every action id the host implements. */
const BUILT = Object.freeze([...Object.keys(RUNNERS), ...Object.keys(CONTENT_RUNNERS)]);

/**
 * The action ids the host runs: the one source for the help overlay's dimmed rows, the
 * not-implemented notice. Whether one runs right now is
 * `VimmaHost._runnable(state, id)`, which adds "a page with our actor has focus" for
 * CONTENT_RUNNERS. Every action is built since the navigation keys (M1), so this is BUILT
 * unless the test-only `VimmaHost._withhold(id)` takes one out.
 * @type {ReadonlySet<string>}
 */
export const RUNNABLE = new Set(BUILT);

/** @type {WeakMap<Window, WindowState>} */
const states = new WeakMap();
/** The windows in `states`, for `configure` (a WeakMap cannot be iterated). */
/** @type {Set<Window>} */
const windows = new Set();

/**
 * What config.toml sets for every window (m5-config-load; ConfigHost calls `configure`). Null
 * keymap: the built-in one, compiled per window as before M5.
 * `configFile` names the file `configErrors` are about (config.toml, or `:source <path>`'s).
 * `firefox`: Firefox's own shortcuts that are off; `insertEditing`: ctrl+w, ctrl+u, ctrl+h in
 * text fields (docs/specs/key-handling-batch.md).
 * @type {{ keymap: Keymap | null, hintChars: string | undefined,
 *   sites: readonly InsertSiteRule[], configErrors: readonly ConfigError[], configFile: string,
 *   firefox: FirefoxKeySetting, insertEditing: boolean }}
 */
const settings = {
  keymap: null,
  hintChars: undefined,
  sites: [],
  configErrors: [],
  configFile: "config.toml",
  firefox: DEFAULT_FIREFOX_KEYS,
  insertEditing: true,
};

/** Keydowns from a parent-process page whose text-field key waits for the page (`_editKey`). */
/** @type {WeakSet<Event>} */
const editAfterPage = new WeakSet();

/** Told by `:source` (config.reload); ConfigHost observes it, so the host never imports it. */
export const CONFIG_RELOAD_TOPIC = "vimma-config-reload";
/** Told by `:config` (config.edit), with the window as the subject; ConfigHost observes it. */
export const CONFIG_EDIT_TOPIC = "vimma-config-edit";

/**
 * The `[sites."<host>"] insert` rule for the page in `browser`, "auto" without one.
 * @param {any} browser
 */
function siteInsert(browser) {
  if (!settings.sites.length) return "auto";
  /** @type {string} */
  let host;
  try {
    host = browser.currentURI?.host ?? "";
  } catch {
    return "auto"; // about:, data:, file: have no host
  }
  return (host && matchSiteRule(host, settings.sites)?.insert) || "auto";
}

/**
 * The focused pane's 1-based place in reading order and the pane count, or null with one pane.
 * @param {Window} win
 */
function paneStatus(win) {
  const panes = PaneViews.get(win)?.panes;
  if (!panes) return null;
  const order = leaves(panes);
  return {
    index: order.findIndex((l) => l.pane === panes.focus) + 1,
    count: order.length,
    // A split kept as a hidden view (docs/specs/side-panel-unsplit.md decision 27).
    ...(panes.hidden ? { hidden: true } : {}),
  };
}

/** The inventory's chords Firefox handles in chrome code, outside its keysets, on this platform. */
const CHROME_HANDLED = new Set(
  firefoxShortcuts({ mac: MAC })
    .filter((r) => r.source === "chrome")
    .map((r) => r.chord),
);

/** @param {Event} e */
function consume(e) {
  e.preventDefault();
  e.stopPropagation();
}

export const VimmaHost = {
  /**
   * Test-only: formatted chords seen by any window, oldest first.
   * @type {string[]}
   */
  _lastChords: [],

  /**
   * Test-only: hint collections finished (with or without targets), across windows.
   * @type {number}
   */
  _hintRuns: 0,

  /**
   * Test-only: the window's live grep session (docs/specs/live-grep.md).
   * @param {Window} win
   * @returns {GrepSession | undefined}
   */
  _grep(win) {
    return states.get(win)?.grep;
  },

  /**
   * Test-only: treats `id` as not built until the returned function is called, so the "not
   * implemented yet" notice and the overlay's dimmed rows stay testable now that every action
   * is built. Call it before `configure`, which rebuilds the overlay's rows.
   * @param {string} id
   * @returns {() => void} restores it
   */
  _withhold(id) {
    /** @type {Set<string>} */ (RUNNABLE).delete(id);
    return () => {
      if (BUILT.includes(id)) /** @type {Set<string>} */ (RUNNABLE).add(id);
    };
  },

  /** @param {Window} win */
  init(win) {
    if (states.has(win)) return;
    /** @type {Map<string, Window>} the window of each tab tab search listed (tab-search.mjs) */
    let tabWindows = new Map();
    const keymap = settings.keymap ?? compileKeymap();
    /** @type {WindowState} */
    const state = {
      win,
      keymap,
      onKeyDown: (e) => this._onKeyDown(win, state, e),
      onKeyDownAfter: (e) => this._onKeyDownAfter(state, e),
      onKeyPress: (e) => this._onKeyPress(state, e),
      onKeyPressAfter: (e) => this._onKeyPressAfter(state, e),
      pageFirst: [],
      firefoxKeys: null,
      private: isPrivateBrowsing(win),
      // The overlay is modal, but tabs can still change underneath it (a script closes the
      // selected tab): close it and focus the newly selected browser.
      onTabSelect: () => {
        this._cancelPending(win, state);
        this._cancelHints(state);
        state.element.leave();
        state.help.close({ tabChanged: true });
        state.cmdline.close({ tabChanged: true });
        state.picker.close({ tabChanged: true });
        state.wsPicker.close({ tabChanged: true });
        state.addonPicker.close({ tabChanged: true });
        state.mcpLog.close({ tabChanged: true });
        state.grep.close({ tabChanged: true });
        state.rename.close({ tabChanged: true });
      },
      dispatcher: createDispatcher(keymap),
      help: new HelpOverlay(win, keymap, RUNNABLE, () => state.firefoxKeys?.status().on ?? []),
      notice: new Notice(win),
      cmdline: new CommandLine(win, {
        run: (result) => this._runCommand(state, result),
        changed: () => this._emit(state),
        args: () => ({
          addon: addonNames(),
          firefox: firefoxIds(win),
          workspace: workspaceNames(win),
          search: SearchHost.completions,
        }),
      }),
      tabStrip: null,
      toolbar: null,
      promptKeys: null,
      timer: null,
      onCancelHints: () => this._cancelHints(state),
      onMouseDown: () => {
        this._cancelHints(state);
        state.element.leave();
      },
      hint: null,
      // Set below, once the overlay it draws in exists.
      element: /** @type {any} */ (null),
      resize: false,
      hintOverlay: new HintOverlay(win),
      listeners: new Set(),
      statusBar: null,
      picker: new GotoPicker(win, {
        items: () => {
          const { items, windowOf } = tabSearchList(win);
          tabWindows = windowOf;
          return items;
        },
        activeId: () =>
          /** @type {{ gBrowser: { selectedTab: { linkedPanel: string } } }} */ (
            /** @type {unknown} */ (win)
          ).gBrowser.selectedTab.linkedPanel,
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
          const said = pickerMove(win, id, ask, say, tab);
          const refused = said === undefined ? moveTabFromPicker(win, id, ask, say, tab) : said;
          if (refused) state.notice.show(refused);
        },
      }),
      mcpLog: new GotoPicker(
        win,
        {
          items: () =>
            AgentGate.log.map((e, i) => {
              const { time, text, outcome } = logCells(e);
              return {
                kind: /** @type {const} */ ("log"),
                logId: String(i),
                display: text,
                time,
                outcome,
                active: false,
              };
            }),
          activeId: () => null,
          select: () => {},
        },
        MCP_LOG,
      ),
      addonPicker: new AddonPicker(win, {
        load: addonPickerItems,
        select: (id) => void sayAddon(state, openAddonById(win, id)),
        addon: (op, id) => addonOp(state, op, id),
      }),
      grep: new GrepSession(win, {
        notice: (text) => state.notice.show(text),
        emit: () => this._emit(state),
      }),
      rename: new RenamePrompt(win, {
        apply: (tab, text) => {
          setTabLabel(tab, text);
          this._emit(state);
        },
        changed: () => this._emit(state),
      }),
      find: new Find(win, () => this._emit(state)),
      agentPrompt: new AgentPrompt(win),
      updatePrompt: new AgentPrompt(win, {
        id: "vimma-update-prompt",
        color: "var(--vimma-text-error)",
      }),
      onFocus: () => {
        AgentUi.onFocusChange(win);
        UpdateUi.onFocusChange(win);
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
          const tab = /** @type {any} */ (tabById(win, tabId));
          if (!tab) return undefined;
          const browser = tab.linkedBrowser;
          return {
            title: browser?.contentTitle || tab.label,
            url: browser?.currentURI?.spec ?? "",
            label: getTabLabel(tab),
            foreign: !!WindowWorkspaces.get(win)?.isForeign(tab),
            playing: !!tab.soundPlaying,
            pinned: !!tab.pinned,
          };
        },
        closeTab: (tabId) => {
          const tab = tabById(win, tabId);
          if (tab) closeTabById(win, tab);
        },
        move: (tabId) => {
          const tab = /** @type {any} */ (tabById(win, tabId));
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
      bookmarks: new BookmarksPanel(win, {
        load: () => loadTree(win),
        observe: observeBookmarks,
        effect: (effect) => runBookmarkEffect(bookmarkContext(state), effect),
      }),
    };
    state.element = new ElementFocus({
      overlay: state.hintOverlay,
      notify: (text) => state.notice.show(text),
      changed: () => this._emit(state),
      setMode: setBrowserMode,
    });
    states.set(win, state);
    windows.add(win);
    win.addEventListener("keydown", state.onKeyDown, true);
    win.addEventListener("focus", state.onFocus, true);
    // The agent question (docs/specs/vimma-mcp.md decisions 13-15): shown here when this is
    // the most recent normal window and the user is not typing.
    AgentUi.register(win, {
      prompt: state.agentPrompt,
      inField: () => this._mode(state) === "insert",
      otherOpen: () =>
        state.help.isOpen ||
        state.picker.isOpen ||
        state.wsPicker.isOpen ||
        state.addonPicker.isOpen ||
        state.mcpLog.isOpen ||
        state.grep.isOpen ||
        state.cmdline.isOpen ||
        state.rename.isOpen ||
        state.panel.isOpen ||
        state.bookmarks.isOpen ||
        state.find.typing ||
        UpdateUi.isOpen(win),
      pending: () => state.dispatcher.pending().length > 0,
      notice: (text) => state.notice.show(text),
      ask: (question, yes) => state.rename.ask(question, yes),
      emit: () => this._emit(state),
    });
    // The update message and the security update question (docs/specs/update-notices.md): the
    // same guards as the agent question, which goes first.
    UpdateUi.register(win, {
      prompt: state.updatePrompt,
      inField: () => this._mode(state) === "insert",
      otherOpen: () =>
        state.help.isOpen ||
        state.picker.isOpen ||
        state.wsPicker.isOpen ||
        state.addonPicker.isOpen ||
        state.mcpLog.isOpen ||
        state.grep.isOpen ||
        state.cmdline.isOpen ||
        state.rename.isOpen ||
        state.panel.isOpen ||
        state.bookmarks.isOpen ||
        state.find.typing ||
        state.agentPrompt.isOpen ||
        !!state.promptKeys?.notification,
      pending: () => state.dispatcher.pending().length > 0,
      notice: (text) => state.notice.show(text, { ms: ANNOUNCE_MS }),
      hideNotice: (text) => {
        if (state.notice.el?.textContent === text) state.notice.hide();
      },
      openSteps: () => openOrSay(state, "about:vimma#updates", "tab"),
      restart: (confirmed) => {
        if (confirmed) restartOrSay(state);
        else restartAsking(state).catch((e) => console.error("vimma: restart failed", e));
      },
      restartLoses: () => ({
        privateTabs: privateTabCount() > 0,
        tabsKept: tabsKeptBy(VimmaUpdates.ownAppImageNow),
      }),
    });
    // After the page and in the system group, as Tabbrowser's own key handling: text-field keys
    // the page left alone (key-handling-batch § 2).
    win.addEventListener("keydown", state.onKeyDownAfter, SYSTEM_GROUP);
    // A page-first binding (firefox-keys decision 6) acts on the keypress, as Firefox's keysets
    // do: before every chrome handler to ask a remote page for its reply, after a
    // parent-process page or a chrome field (the system group's bubble) for the others.
    win.addEventListener("keypress", state.onKeyPress, SYSTEM_GROUP_CAPTURE);
    win.addEventListener("keypress", state.onKeyPressAfter, SYSTEM_GROUP);
    win.addEventListener("TabSelect", state.onTabSelect, true);
    // After the keys too: Firefox's shortcuts that overlap ours, off (key-handling-batch § 1).
    try {
      const firefoxKeys = new FirefoxKeys(win, settings.firefox, boundChords(keymap));
      firefoxKeys.init();
      state.firefoxKeys = firefoxKeys;
    } catch (e) {
      console.error("vimma: Firefox's shortcuts left on", e);
    }
    // The labels are drawn for one layout of the page: a resize or a click moves on. A focused
    // block's outline follows a resize; a click ends the focus.
    win.addEventListener("resize", state.onCancelHints);
    win.addEventListener("mousedown", state.onMouseDown, true);
    // After the keys: an upstream change in tab code must not cost us ctrl+b.
    try {
      const tabStrip = new TabStrip(win);
      tabStrip.init();
      state.tabStrip = tabStrip;
    } catch (e) {
      console.error("vimma: tab strip not hidden", e);
    }
    try {
      const toolbar = new Toolbar(win, {
        say: (text) => state.notice.show(text),
        log: (text) => KeyLog.note(text),
        changed: () => this._emit(state),
      });
      toolbar.init();
      state.toolbar = toolbar;
    } catch (e) {
      console.error("vimma: toolbar toggle unavailable", e);
    }
    // Firefox's permission prompts from the keyboard (toolbar-toggle decision 11a).
    try {
      const promptKeys = new PromptKeys(win, {
        inField: () => this._mode(state) === "insert",
        otherOpen: () =>
          state.help.isOpen ||
          state.picker.isOpen ||
          state.wsPicker.isOpen ||
          state.addonPicker.isOpen ||
          state.mcpLog.isOpen ||
          state.cmdline.isOpen ||
          state.rename.isOpen ||
          state.panel.isOpen ||
          state.bookmarks.isOpen ||
          state.agentPrompt.isOpen ||
          UpdateUi.isOpen(win),
        pending: () => state.dispatcher.pending().length > 0,
      });
      promptKeys.init();
      state.promptKeys = promptKeys;
      // Leaving a field (Esc) changes what the keys line says.
      state.listeners.add(() => promptKeys.refresh());
    } catch (e) {
      console.error("vimma: permission prompt keys unavailable", e);
    }
    try {
      const statusBar = new StatusBar(win, {
        status: () => this.status(win),
        subscribe: (fn) => this.onStateChange(win, fn),
        labelFor: getTabLabel,
      });
      statusBar.init();
      state.statusBar = statusBar;
    } catch (e) {
      console.error("vimma: no status bar", e);
    }
    // `:addon` completes from a list kept by an AddonManager listener: start it now, so the
    // names are in before the first Tab (docs/specs/addon-manager.md).
    try {
      addonNames();
    } catch (e) {
      console.error("vimma: no add-on names", e);
    }
    // After the keys too: a failure costs the workspaces, not ctrl+b (m3-workspaces 2b).
    try {
      WindowWorkspaces.init(win, {
        onChange: () => {
          state.panel.refresh();
          // docs/specs/bookmarks.md decision 11: the bookmarks panel follows the workspace.
          const model = WindowWorkspaces.get(win)?.model;
          const active = model?.workspaces.find((w) => w.id === model.active);
          state.bookmarks.setWorkspace(active ? `${active.id}\n${active.name}` : null);
          this._emit(state);
        },
        notify: (text) => state.notice.show(text),
      });
    } catch (e) {
      console.error("vimma: no workspaces", e);
    }
  },

  /** @param {Window} win */
  uninit(win) {
    const state = states.get(win);
    if (!state) return;
    this._cancelPending(win, state);
    win.removeEventListener("keydown", state.onKeyDown, true);
    win.removeEventListener("focus", state.onFocus, true);
    AgentUi.unregister(win);
    UpdateUi.unregister(win);
    win.removeEventListener("keydown", state.onKeyDownAfter, SYSTEM_GROUP);
    win.removeEventListener("keypress", state.onKeyPress, SYSTEM_GROUP_CAPTURE);
    win.removeEventListener("keypress", state.onKeyPressAfter, SYSTEM_GROUP);
    win.removeEventListener("TabSelect", state.onTabSelect, true);
    state.firefoxKeys?.destroy();
    win.removeEventListener("resize", state.onCancelHints);
    win.removeEventListener("mousedown", state.onMouseDown, true);
    this._cancelHints(state);
    state.element.leave();
    state.help.destroy();
    state.notice.destroy();
    state.cmdline.destroy();
    state.picker.destroy();
    state.wsPicker.destroy();
    state.addonPicker.destroy();
    state.mcpLog.destroy();
    state.grep.destroy();
    state.rename.destroy();
    state.panel.destroy();
    state.bookmarks.destroy();
    state.tabStrip?.uninit();
    state.toolbar?.uninit();
    state.promptKeys?.uninit();
    WindowWorkspaces.uninit(win);
    state.statusBar?.uninit();
    state.find.destroy();
    state.listeners.clear();
    states.delete(win);
    windows.delete(win);
  },

  /**
   * What the status bar shows: the mode keys are dispatched in and the keys of a pending
   * sequence (dispatcher.pending() labels); `command` while a `/` or `?` search is typed (Vim's
   * command-line mode), and that search or the page's last one (m1-find); the focused pane's
   * place among two or more (m4-split-panes); the active workspace (m3-workspaces).
   * @param {Window} win
   * @returns {{ mode: Mode, pending: string[], find?: FindStatus | null,
   *   pane?: { index: number, count: number } | null, configErrors?: readonly ConfigError[],
   *   configFile?: string, alerts?: readonly string[],
   *   workspace?: { name: string, index: number, color?: string, private?: boolean } | null,
   *   agent?: { waiting: number, minutes: number | null, ran: boolean } | null,
   *   update?: import("../core/updates.mjs").UpdateNotice | null,
   *   element?: import("../core/statusbar.mjs").ElementStatus | null }}
   */
  status(win) {
    const state = states.get(win);
    if (!state) return { mode: "insert", pending: [] };
    const browser = /** @type {any} */ (win).gBrowser?.selectedBrowser;
    return {
      mode: state.find.typing ? "command" : this._mode(state),
      pending: state.dispatcher.pending(),
      find: browser ? state.find.status(browser) : null,
      pane: paneStatus(win),
      workspace: privateStatus(win) ?? WindowWorkspaces.get(win)?.status() ?? null,
      configErrors: settings.configErrors,
      configFile: settings.configFile,
      // Persistent, unlike a notice: containers off or lost at startup (m3-workspaces).
      alerts: WorkspaceStore.alerts,
      // docs/specs/vimma-mcp.md decision 24: `◇ agent`, `◇ agent 2?`, `◇ agent 14m`.
      agent: AgentUi.status(),
      // docs/specs/m6a-updater.md §5: `⇡ 0.3.1 available`, or an update problem.
      update: VimmaUpdates.notice(),
      // docs/specs/element-focus.md decision 5: `paragraph · 412 chars`.
      element: state.element.status(),
    };
  },

  /**
   * Whether the user is using `browser`'s page (docs/specs/mcp-drive.md D13): it is shown in the
   * focused window, and that page is in insert or copy mode, in hint mode or in a `/` search,
   * or a key sequence is under way in the window. An agent's keys wait for none of these: they
   * are denied, so an agent never moves a page under the user's cursor while they type in it.
   * @param {any} browser XULBrowserElement
   */
  inUse(browser) {
    const win = browser?.ownerDocument?.defaultView;
    const state = win && states.get(win);
    if (!state || /** @type {any} */ (Services.focus).activeWindow !== win) return false;
    if (!browser.docShellIsActive) return false;
    // The tab's own find bar open (the user's ctrl+f or `/` there): its finder is the agent's.
    const tab = /** @type {any} */ (win).gBrowser?.getTabForBrowser(browser);
    const findbar = tab && /** @type {any} */ (win).gBrowser.getCachedFindBar(tab);
    // A page without our actor takes every key itself: in use while shown.
    return (
      (!!findbar && !findbar.hidden) ||
      this._browserMode(browser) !== "normal" ||
      state.hint?.browser === browser ||
      state.find.session?.browser === browser ||
      state.dispatcher.pending().length > 0
    );
  },

  /**
   * Whether `browser` is the page with the user's focus, in the focused window: a find there
   * would focus a text field its match is in (docs/specs/mcp-drive.md D11, security.md M16).
   * @param {any} browser XULBrowserElement
   */
  isFocusedPage(browser) {
    const win = browser?.ownerDocument?.defaultView;
    if (!win || /** @type {any} */ (Services.focus).activeWindow !== win) return false;
    return this._focusedBrowser(win) === browser;
  },

  /**
   * Firefox's own shortcuts that are off in `win`, and the chords of `[firefox] disable` that
   * match none (about:vimma; docs/specs/key-handling-batch.md § 1).
   * @param {Window} win
   */
  firefoxKeys(win) {
    return states.get(win)?.firefoxKeys?.status() ?? { on: [], off: [], unmatched: [] };
  },

  /**
   * Shows `text` as the window's notice (ConfigHost's `:config` when it cannot create the file).
   * @param {Window} win
   * @param {string} text
   */
  say(win, text) {
    states.get(win)?.notice.show(text);
  },

  /**
   * What config.toml sets (m5-config-load), for every window now and every later one. Each
   * field is optional: absent keeps the current value. A new keymap drops a pending sequence
   * and closes the bindings overlay, which is rebuilt from it.
   * @param {{ keymap?: Keymap, hintChars?: string, sites?: readonly InsertSiteRule[],
   *   configErrors?: readonly ConfigError[], configFile?: string,
   *   firefox?: FirefoxKeySetting, insertEditing?: boolean,
   *   bookmarksRoot?: BookmarksRoot }} next
   */
  configure(next) {
    // `[bookmarks] root` (docs/specs/bookmarks.md): an open panel re-reads at the new root.
    const rootChanged = !!next.bookmarksRoot && next.bookmarksRoot !== bookmarksRoot();
    if (next.bookmarksRoot) setBookmarksRoot(next.bookmarksRoot);
    if (next.hintChars !== undefined) settings.hintChars = next.hintChars;
    if (next.insertEditing !== undefined) settings.insertEditing = next.insertEditing;
    if (next.firefox) settings.firefox = next.firefox;
    if (next.sites) settings.sites = next.sites;
    if (next.configErrors) settings.configErrors = next.configErrors;
    if (next.configFile) settings.configFile = next.configFile;
    const keymap = next.keymap && next.keymap !== settings.keymap ? next.keymap : null;
    if (keymap) settings.keymap = keymap;
    for (const win of windows) {
      const state = states.get(win);
      if (!state) continue;
      if (keymap) {
        this._cancelPending(win, state);
        state.keymap = keymap;
        state.dispatcher = createDispatcher(keymap);
        state.help.setKeymap(keymap);
      }
      // Firefox's keys on chords the keymap binds are off (firefox-keys decision 2).
      if (keymap || next.firefox)
        state.firefoxKeys?.set(settings.firefox, boundChords(state.keymap));
      if (rootChanged) state.bookmarks.scheduleReload();
      this._emit(state);
    }
  },

  /**
   * Calls `fn` after anything that may change `status(win)`. Cheap to call often: listeners
   * debounce. Whatever changes the mode (focus detection, a content actor) calls `_emit`.
   * @param {Window} win
   * @param {() => void} fn
   * @returns {() => void} unsubscribe
   */
  onStateChange(win, fn) {
    const state = states.get(win);
    if (!state) return () => {};
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },

  /** @param {WindowState} state */
  _emit(state) {
    for (const fn of state.listeners) {
      try {
        fn();
      } catch (e) {
        console.error("vimma: state listener failed", e);
      }
    }
  },

  /**
   * A focus report from the content actor (VimmaParent) for a tab's <browser>.
   * @param {any} browser
   * @param {{ descriptor: EditableDescriptor, trigger: InsertTrigger, frame?: any,
   *   windowId?: number, user?: boolean, gen?: number }} report
   *   `frame`: the BrowsingContext that reported; `windowId`: its document's inner window ID;
   *   `user`: the focus came from the user's input; `gen`: the last blur generation the
   *   document had
   */
  onFocusReport(browser, { descriptor, trigger, frame, windowId, user = false, gen = 0 }) {
    const mode = browserModes.get(browser) ?? "normal";
    const site = siteInsert(browser);
    if (frame && trigger === "focusin" && isEditable(descriptor, { site }).editable) {
      lastFieldFrame.set(browser, {
        frame,
        windowId: frame.currentWindowGlobal?.innerWindowId ?? 0,
      });
    }
    // Sent by the document Esc's blur went to before the blur reached it (its focusin for a key
    // typed just before Esc): the blur's own reports decide.
    const blur = lastBlur.get(browser);
    if (blur && windowId === blur.windowId && gen < blur.gen) return;
    // After Esc, the page's own script focusing a field (a dialog that pulls focus back on
    // blur) does not undo it; the user's next focus does.
    const hold = escapeHold.get(browser);
    if (hold !== undefined) {
      if (user || hold !== topWindowId(browser)) escapeHold.delete(browser);
      else if (trigger === "focusin") return;
    }
    // A page moving focus about (a file finder focusing its result list) does not end the
    // explicit insert of `i` or `gi`; a report from a newer top document than its own does.
    if (mode === "insert" && explicitInsert.get(browser) === topWindowId(browser)) return;
    // Copy mode lasts until a text field takes focus (m1-copy-mode).
    const copy = mode === "visual";
    const next = insertModeAfterFocus({ mode: copy ? "normal" : mode, trigger, descriptor, site });
    if (copy && next !== "insert") return;
    setBrowserMode(browser, next === "insert" ? "insert" : "normal");
  },

  /**
   * The user clicked in the focused frame of `browser` (VimmaParent) where no focus report
   * says so: it ends the hold of Esc (insert-focus behaviour 6).
   * @param {any} browser
   */
  onUserClick(browser) {
    escapeHold.delete(browser);
  },

  /**
   * The user selected text with the mouse in the focused frame of `browser` (VimmaParent):
   * normal mode enters copy mode with that selection, so `y` copies it and motions extend it.
   * Insert mode keeps it (a text field's selection is its own).
   * @param {any} browser
   */
  onMouseSelection(browser) {
    if (this._browserMode(browser) === "insert") return;
    CONTENT_RUNNERS["mode.visual"]?.(browser, { id: "mode.visual" });
  },

  /**
   * Called after a tab's page mode changes (normal ↔ insert), whatever caused it (a focus
   * report, `i`, `Esc`): tells the owning window's state listeners (the status bar).
   * The listeners read the mode back through `status(win)`; the mode itself only ends element
   * focus when it is insert.
   * @type {(browser: any, mode: PageMode) => void}
   */
  onModeChange: (browser, mode) => {
    // defaultView is the WindowProxy init() was given; ownerGlobal is the inner window, a
    // different object as a WeakMap key.
    const win = browser?.ownerDocument?.defaultView;
    const state = win && states.get(win);
    // A text field took focus (the page's script, a click): its keys are the field's, so a
    // focused block's ELEMENT mode ends, as copy mode does.
    if (state && mode === "insert" && state.element.browser === browser) state.element.leave();
    if (state) VimmaHost._emit(state);
    // Into a field: the agent question goes back to waiting (vimma-mcp decision 14), and so
    // does the update question.
    if (state) AgentUi.onFocusChange(win);
    if (state) UpdateUi.onFocusChange(win);
  },

  /**
   * The page mode keys get while `browser` has focus. A page without our actor (extension
   * pages, data:, view-source:) stays in insert, as every page was before M1.
   * @param {any} browser
   * @returns {PageMode}
   */
  _browserMode(browser) {
    if (!VimmaActors.has(browser)) return "insert";
    return browserModes.get(browser) ?? "normal";
  },

  /**
   * The content <browser> that has focus, or null when focus is in chrome (URL bar, find bar).
   * @param {Window} win
   */
  _focusedBrowser(win) {
    const el = win.document.activeElement;
    return el?.localName === "browser" ? el : null;
  },

  /**
   * `help` while the overlay or a picker (modal too) is open; `command` while the `:` line
   * is; `panel` while the side panel is (modal: m3-workspaces 6); `resize` in resize mode
   * (ADR-014); the focused page's mode;
   * `insert` in chrome, so chrome text fields keep their keys and only global chords are ours.
   * @param {WindowState} state
   * @returns {Mode}
   */
  _mode(state) {
    if (state.help.isOpen || state.picker.isOpen || state.wsPicker.isOpen) return "help";
    if (state.addonPicker.isOpen || state.mcpLog.isOpen || state.grep.isOpen) return "help";
    if (state.cmdline.isOpen) return "command";
    // A prompt over a panel (the bookmarks' add, rename, a y/N) types: keys are its input's.
    if (state.rename.isOpen) return "insert";
    if (state.panel.isOpen || state.bookmarks.isOpen) return "panel";
    // Resize mode ends by itself when the window is down to one pane (a tab closed meanwhile).
    if (state.resize && !hasPanes(state.win)) state.resize = false;
    if (state.resize) return "resize";
    const browser = this._focusedBrowser(state.win);
    if (state.hint && state.hint.browser === browser) return "hint";
    if (browser && state.element.browser === browser) return "element";
    return browser ? this._browserMode(browser) : "insert";
  },

  /**
   * @param {WindowState} state
   * @param {string} id
   */
  _runnable(state, id) {
    if (!RUNNABLE.has(id)) return false;
    if (MULTI_PANE.has(id)) return hasPanes(state.win);
    if (id in RUNNERS) return true;
    return !!this._contentBrowser(state) || (ON_SELECTED.has(id) && !!this._selectedBrowser(state));
  },

  /**
   * The selected tab's <browser> (the focused pane's), or null.
   * @param {WindowState} state
   */
  _selectedBrowser(state) {
    return /** @type {any} */ (state.win).gBrowser?.selectedBrowser ?? null;
  },

  /**
   * The focused content <browser> when it has our actor, else null.
   * @param {WindowState} state
   */
  _contentBrowser(state) {
    const browser = this._focusedBrowser(state.win);
    return browser && VimmaActors.has(browser) ? browser : null;
  },

  /**
   * Whether any action reachable from `node` is runnable now.
   * @param {WindowState} state
   * @param {TrieNode} node
   * @returns {boolean}
   */
  _leadsToRunnable(state, node) {
    if (node.action && this._runnable(state, node.action.id)) return true;
    for (const child of node.children.values()) {
      if (this._leadsToRunnable(state, child)) return true;
    }
    return false;
  },

  /**
   * @param {Window} win
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   */
  _onKeyDown(win, state, e) {
    // A key the page has had, back for chrome's shortcuts (requestReplyFromRemoteContent): it
    // was dispatched once already, before the page.
    if (/** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent) return;
    // The agent question takes its keys first, and only while it shows (vimma-mcp 13-14).
    if (AgentUi.onKey(win, e)) {
      this._emit(state);
      return;
    }
    // Then the security update question's (docs/specs/update-notices.md).
    if (UpdateUi.onKey(win, e)) {
      this._emit(state);
      return;
    }
    // Then an open permission prompt's y, n and Tab (toolbar-toggle decision 11a).
    if (state.promptKeys?.onKey(e)) return;
    const chord = chordFromEvent(e);
    if (!chord) return; // a bare modifier
    const key = formatKey(chord);
    // A page-first binding whose keypress never came (the page took the keydown) is dropped.
    // One whose keypress stayed in this process was settled during that keypress.
    state.pageFirst = state.pageFirst.filter((p) => p.awaiting);
    // Focus left the page the hints are on (URL bar, another pane): they no longer apply.
    if (state.hint && state.hint.browser !== this._focusedBrowser(win)) this._cancelHints(state);
    if (state.element.browser && state.element.browser !== this._focusedBrowser(win)) {
      state.element.leave();
    }
    // The setup page draws its own j/k/space/enter/esc (first-run-setup behaviour 3): the scroll,
    // hint and mode bindings would take them first. Chords with a modifier stay ours.
    if (
      !chord.ctrl &&
      !chord.alt &&
      !chord.meta &&
      /** @type {any} */ (this._focusedBrowser(win))?.currentURI?.spec === "about:vimma-setup"
    ) {
      return;
    }
    const mode = this._mode(state);
    // Keys typed in a private window are never kept (private-workspace decision 8b).
    if (!state.private) {
      this._lastChords.push(key);
      if (this._lastChords.length > MAX_RECORDED) this._lastChords.shift();
    }
    if (Services.prefs.getBoolPref(DEBUG_PREF, false)) {
      const mods = MODIFIERS.filter((m) => chord[m]);
      console.debug("vimma key", { key, mods, mode });
    }
    // A picker takes every key, bare ones too, before any binding: nothing reaches the page or
    // Firefox underneath (ctrl+w would close a tab), and its j / q are not keymap keys.
    const picker = [state.picker, state.wsPicker, state.addonPicker, state.mcpLog, state.grep].find(
      (p) => p.isOpen,
    );
    if (picker) {
      consume(e);
      picker.key(key);
      this._emit(state);
      return;
    }
    // Enter and Esc in a `/` search, and keys typed before its input exists (m1-find).
    if (state.dispatcher.pending().length === 0 && state.find.onKeyDown(e)) {
      this._emit(state);
      return;
    }
    // Typing into the help filter: plain keys belong to the input; Esc and chords stay ours.
    const typing = !chord.ctrl && !chord.alt && !chord.meta && chord.key !== "esc";
    const filtering = state.help.filterFocused || state.bookmarks.filterFocused;
    if (typing && filtering && state.dispatcher.pending().length === 0) return;
    this._dispatch(win, state, e, mode, chord);
    // A key the page gets after Esc is the user acting on the page again: what the page
    // focuses in answer (Tab into a frame, a shortcut that opens its search box) is the user's
    // focus, though it may reach a frame whose process handles no input (insert-focus 6).
    if (!e.defaultPrevented) {
      const browser = this._focusedBrowser(win);
      if (browser) escapeHold.delete(browser);
    }
    this._emit(state);
  },

  /**
   * @param {Window} win
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   * @param {Mode} mode
   * @param {Chord} chord
   */
  _dispatch(win, state, e, mode, chord) {
    const first = state.dispatcher.pending().length === 0;
    this._clearTimer(win, state);
    const result = state.dispatcher.dispatch(mode, chord);
    // about:vimma's last keys; never a private window's (private-workspace decision 8b).
    if (!("replay" in result) && !state.private) KeyLog.record(mode, chord, result);
    // The overlay is modal: in help mode every key is ours, handled or not, so nothing reaches
    // the browser underneath (ctrl+w would close the tab behind it). Hint mode too: every key
    // is a label key or ignored, never the page's. Resize mode too (ADR-014), and the side panel.
    const modal = mode === "help" || mode === "hint" || mode === "resize" || mode === "panel";
    switch (result.kind) {
      case "pass":
        if (this._editKey(state, e, mode, chord)) return;
        if (modal) consume(e);
        // Firefox runs these outside its keysets (tabbox.js, browser-ctrlTab.js, Tabbrowser's
        // on_keydown, Firefox 158), where a disabled <key> cannot stop them; each skips a keydown
        // that is defaultPrevented. Unbound and not enabled, the chord does nothing, as `all`
        // says (docs/specs/firefox-keys.md decision 16). Not stopped: the page still sees it.
        else if (
          CHROME_HANDLED.has(formatKey(chord)) &&
          !settings.firefox.enable.includes(formatKey(chord))
        ) {
          e.preventDefault();
        }
        // Copy mode and element focus keep plain keys from the page (m1-copy-mode,
        // element-focus decision 7); chords stay Firefox's (ctrl+c).
        else if (
          (mode === "visual" || mode === "element") &&
          !chord.ctrl &&
          !chord.alt &&
          !chord.meta
        ) {
          consume(e);
        }
        if (mode === "hint") this._hintKey(state, chord);
        return;
      case "cancel":
        consume(e);
        return;
      case "pending": {
        // The first key of a sequence that leads to nothing runnable yet passes, so ctrl+w (the
        // M4 <C-w> pane keys) reaches the page with one pane. A count is not in the trie, so it
        // is ours.
        const node = first && !modal && state.keymap.trie(mode).children.get(formatKey(chord));
        if (node && !this._leadsToRunnable(state, node)) {
          state.dispatcher.reset();
          return;
        }
        consume(e);
        // Only an ambiguous sequence (g vs gg) times out; a bare prefix waits for the next key.
        if (state.dispatcher.ambiguous()) {
          state.timer = win.setTimeout(() => {
            state.timer = null;
            this._run(state, state.dispatcher.flush());
            this._emit(state);
          }, state.dispatcher.timeoutMs);
        }
        return;
      }
      case "action": {
        if (result.replay) {
          // The earlier keys completed an action; this key starts over (core rule 5) and decides
          // for itself whether it is consumed.
          this._run(state, result);
          this._dispatch(win, state, e, this._mode(state), chord);
          return;
        }
        if (first && !modal && !this._runnable(state, result.action.id)) return;
        // Firefox let the page have this chord first: so does Vimma (firefox-keys decision 6).
        // The keydown goes on; the keypress after the page runs the action (_onKeyPress).
        if (first && !modal && this._pageFirst(state, chord, mode)) {
          state.pageFirst.push({
            key: formatKey(chord),
            result,
            pressed: false,
            awaiting: false,
            mode,
          });
          if (state.pageFirst.length > PAGE_FIRST_MAX) state.pageFirst.shift();
          return;
        }
        consume(e);
        // Another binding in hint mode (a ctrl+b sequence) leaves hint mode first.
        if (mode === "hint" && result.action.id !== "hint.cancel") this._cancelHints(state);
        // So does one in ELEMENT mode; its Esc (mode.normal) only leaves, so it neither blurs
        // the page nor stops it loading (element-focus decision 7).
        if (mode === "element" && !result.action.id.startsWith("element.")) {
          state.element.leave();
          if (result.action.id === "mode.normal") return;
        }
        this._run(state, result);
      }
    }
  },

  /**
   * Whether the page has `chord` before Vimma (docs/specs/firefox-keys.md decision 6): a chord
   * Firefox let the page override (core pageFirst), unless the site's "Override keyboard
   * shortcuts" permission is Block. With the fullscreen Keyboard Lock on, Firefox's other keys
   * go to the page too, all but the one that leaves full screen. A chord `[firefox] enable`
   * keeps Firefox's is Vimma's first, so Firefox's key and Vimma's binding never both run.
   * @param {WindowState} state
   * @param {Chord} chord
   * @param {Mode} mode
   */
  _pageFirst(state, chord, mode) {
    const key = formatKey(chord);
    if (settings.firefox.enable.includes(key)) return false;
    const win = /** @type {any} */ (state.win);
    let keyboardLock = false;
    try {
      keyboardLock = (win.document.fullscreenKeyboardLock ?? "none") !== "none";
    } catch {
      // Not in this build: no Keyboard Lock.
    }
    if (!pageFirst(key, { fullScreen: !!win.fullScreen, keyboardLock, mode })) return false;
    if (keyboardLock) return true;
    return !this._shortcutsBlocked(state);
  },

  /**
   * The focused page's site blocks "Override keyboard shortcuts" (Firefox's
   * nsContentUtils::ShouldBlockReservedKeys): its keys are Vimma's first.
   * @param {WindowState} state
   */
  _shortcutsBlocked(state) {
    const browser = /** @type {any} */ (this._focusedBrowser(state.win));
    const principal = browser?.contentPrincipal;
    if (!principal) return false;
    try {
      const perms = /** @type {any} */ (Services).perms;
      return perms.testPermissionFromPrincipal(principal, "shortcuts") === perms.DENY_ACTION;
    } catch {
      return false;
    }
  },

  /**
   * A page-first binding's keypress, before the page (system group, capture). A remote page:
   * ask for its reply, and stop the event here, as GlobalKeyListener does, so no chrome handler
   * runs before the page had it; the reply comes back here and runs the action unless the page
   * called preventDefault. A parent-process page or a chrome field: `_onKeyPressAfter`.
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   */
  _onKeyPress(state, e) {
    if (!state.pageFirst.length) return;
    const chord = chordFromEvent(e);
    const key = chord && formatKey(chord);
    const ev = /** @type {ChromeKeyEvent} */ (e);
    if (ev.isReplyEventFromRemoteContent) {
      // A chord with a native shortcut in Firefox's root key listener (cmd_redo on ctrl+shift+z,
      // ShortcutKeyDefinitions.cpp) never reaches `_onKeyPress` before the page:
      // GlobalKeyListener::HandleEventOnCaptureInSystemEventGroup stops it and waits for this
      // reply itself, so its entry is still unpressed here.
      let at = state.pageFirst.findIndex((p) => p.awaiting && p.key === key);
      if (at === -1) at = state.pageFirst.findIndex((p) => !p.pressed && p.key === key);
      if (at === -1) return;
      const [pending] = state.pageFirst.splice(at, 1);
      if (!pending || this._pageTookKey(e, pending)) return;
      consume(e);
      this._run(state, pending.result);
      this._emit(state);
      return;
    }
    const pending = state.pageFirst.find((p) => !p.pressed && p.key === key);
    if (!pending) return;
    pending.pressed = true;
    if (/** @type {any} */ (e.target)?.isRemoteBrowser) {
      pending.awaiting = true;
      e.stopPropagation();
      ev.requestReplyFromRemoteContent();
    }
  },

  /**
   * Whether a remote page took a page-first key, from its reply event. Page script counts
   * (defaultPreventedByContent). A native handler in the content process counts only when a field
   * has focus (insert mode): the content's root key listener walks ShortcutKeyDefinitions.cpp's
   * sBrowserHandlers even with nothing focused, and KeyEventHandler::DispatchXBLCommand calls
   * PreventDefault before it looks for a controller, so ctrl+shift+z (cmd_redo) comes back
   * prevented by chrome on every plain page.
   * @param {KeyboardEvent} e
   * @param {PageFirst} pending
   */
  _pageTookKey(e, pending) {
    if (!e.defaultPrevented) return false;
    if (/** @type {any} */ (e).defaultPreventedByContent) return true;
    return pending.mode === "insert";
  },

  /**
   * A page-first binding's keypress after a parent-process page (about:preferences) or a chrome
   * field (the address bar) had it, in the system group's bubble phase as Firefox's keysets:
   * runs the action unless something called preventDefault (a field's own edit command, such as
   * redo on ctrl+shift+z).
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   */
  _onKeyPressAfter(state, e) {
    if (/** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent) return;
    const chord = chordFromEvent(e);
    const key = chord && formatKey(chord);
    // The one `_onKeyPress` just marked: a local keypress settles in its own dispatch.
    const at = state.pageFirst.findIndex((p) => p.pressed && !p.awaiting && p.key === key);
    if (at === -1) return;
    const [pending] = state.pageFirst.splice(at, 1);
    if (e.defaultPrevented || !pending) return;
    e.preventDefault();
    this._run(state, pending.result);
    this._emit(state);
  },

  /**
   * The text-field command of a chord no binding took (ctrl+w, ctrl+u, ctrl+h), or null: off
   * in config, or a Firefox shortcut the config keeps on for that chord wins.
   * @param {WindowState} state
   * @param {Chord} chord
   */
  _editCommand(state, chord) {
    if (!settings.insertEditing) return null;
    const key = formatKey(chord);
    const command = insertEditCommand(key, { mac: MAC });
    if (!command || state.firefoxKeys?.fires(key)) return null;
    return command;
  },

  /**
   * A text-field key (docs/specs/key-handling-batch.md § 2) that the dispatcher passed. In a
   * chrome text field it runs now and is consumed. In a page in insert mode it waits for the
   * page, which may take the key itself (a web terminal): a remote page through Firefox's reply
   * event, a parent-process page in this window's bubble phase; `_onKeyDownAfter` runs it.
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   * @param {Mode} mode
   * @param {Chord} chord
   * @returns {boolean} whether the key was consumed
   */
  _editKey(state, e, mode, chord) {
    const command = this._editCommand(state, chord);
    if (!command) return false;
    const browser = this._focusedBrowser(state.win);
    if (!browser) {
      if (!focusedChromeField(state.win) || !runChromeEdit(state.win, command)) return false;
      consume(e);
      return true;
    }
    if (mode !== "insert" || !VimmaActors.has(browser)) return false;
    if (/** @type {any} */ (browser).isRemoteBrowser) {
      /** @type {ChromeKeyEvent} */ (e).requestReplyFromRemoteContent();
    } else {
      editAfterPage.add(e);
    }
    return false;
  },

  /**
   * A keydown after the page had it (system group, bubble phase): the text-field key `_editKey`
   * left to the page, unless the page took it.
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   */
  _onKeyDownAfter(state, e) {
    const ours =
      /** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent || editAfterPage.has(e);
    if (!ours || e.defaultPrevented) return;
    const chord = chordFromEvent(e);
    const command = chord && this._editCommand(state, chord);
    const browser = this._contentBrowser(state);
    if (!command || !browser || this._mode(state) !== "insert") return;
    e.preventDefault();
    VimmaActors.edit(browser, command);
  },

  /**
   * Runs a completed action: on the focused page (CONTENT_RUNNERS), else in chrome (RUNNERS),
   * else says it is not implemented yet. A content action with no page of ours focused does
   * nothing: it is built, just not applicable here. A single key the host cannot run never gets
   * here: `_dispatch` leaves it to Firefox, without a notice.
   * @param {WindowState} state  carries `win` for the runners
   * @param {DispatchResult | null} result
   * @param {string} [text]  a command's free-text argument (m1-cmdline)
   */
  _run(state, result, text) {
    if (result?.kind !== "action") return;
    const { action } = result;
    if (!RUNNABLE.has(action.id)) {
      state.notice.show(notImplementedText(action));
      return;
    }
    const contentRunner = CONTENT_RUNNERS[action.id];
    if (contentRunner) {
      const browser =
        this._contentBrowser(state) ??
        (ON_SELECTED.has(action.id) ? this._selectedBrowser(state) : null);
      if (browser) contentRunner(browser, action);
      return;
    }
    const runner = RUNNERS[action.id];
    if (runner) runner(state, action, text);
    else state.notice.show(notImplementedText(action));
  },

  /**
   * Runs a parsed `:` line through `_run`, as if its action had been keyed, after the line has
   * closed. An action core lists as pending (PENDING_ACTIONS) is refused, never run
   * (m1-core-logic, Missing actions).
   * @param {WindowState} state
   * @param {Extract<CommandResult, { kind: "run" }>} result
   */
  _runCommand(state, { command, action, text }) {
    if (PENDING_ACTIONS.includes(action.id)) {
      state.notice.show(`:${command}${text ? ` ${text}` : ""}: not available yet`);
      return;
    }
    this._run(state, { kind: "action", action }, text);
  },

  /**
   * Test-only: a window's state.
   * @param {Window} win
   */
  _state(win) {
    return states.get(win);
  },

  /**
   * Test-only: the window's hint mode, or null.
   * @param {Window} win
   */
  _hints(win) {
    const hint = states.get(win)?.hint;
    if (!hint) return null;
    return { action: hint.action, typed: hint.hs?.typed ?? "", hints: hint.hs?.hints ?? [] };
  },

  /**
   * Test-only: the window's focused text block, or null.
   * @param {Window} win
   */
  _element(win) {
    const s = states.get(win)?.element.session;
    return s ? { kind: s.kind, length: s.length, target: s.target, browser: s.browser } : null;
  },

  /**
   * A frame of a focused block reported a scroll or resize, or that its page went away
   * (VimmaParent, `Vimma:BlockMoved` / `Vimma:BlockGone`). From a content process: the window
   * whose block it is checks that the frame is one of its block's, with the same document.
   * @param {"moved" | "gone"} what
   * @param {any} bc
   * @param {any} wg
   * @param {unknown} gen
   */
  onBlockReport(what, bc, wg, gen) {
    for (const win of windows) states.get(win)?.element.onReport(what, bc, wg, gen);
  },

  /**
   * A frame's document went away (VimmaParent): element focus in it ends.
   * @param {any} wg  its WindowGlobalParent
   */
  onFrameGone(wg) {
    for (const win of windows) states.get(win)?.element.onFrameGone(wg);
  },

  /**
   * `f` / `gF` / `F`: collects the targets, then enters hint mode with a label on each. With none,
   * the tab stays in normal (the status bar will say so, M2).
   * @param {any} browser
   * @param {Action} action
   */
  _startHints(browser, action) {
    // The window proxy init() was given; ownerGlobal is the inner window, another key.
    const state = states.get(browser.ownerDocument.defaultView);
    if (!state) return;
    this._cancelHints(state);
    state.element.leave();
    const id = /** @type {HintAction} */ (action.id);
    // pdf.js draws lines, not paragraphs: copy mode is the way to copy there (decision 14).
    if (id === "hint.element" && browser.documentContentType === "application/pdf") {
      state.notice.show(NO_BLOCKS_PDF);
      return;
    }
    /** @type {HintSession} */
    const session = { browser, action: id, hs: null, buffered: [] };
    state.hint = session;
    this._emit(state);
    VimmaActors.collectHints(browser, id)
      .then((targets) => {
        if (state.hint !== session) return;
        try {
          session.hs = startHints(targets, { action: id, chars: settings.hintChars });
        } catch (e) {
          if (!(e instanceof HintError && e.code === "no-targets")) throw e;
          state.hint = null;
          this._emit(state);
          if (id === "hint.element") state.notice.show(NO_BLOCKS);
          console.info("vimma: no hint targets");
          return;
        }
        state.hintOverlay.show(browser, session.hs.hints);
        for (const chord of session.buffered.splice(0)) {
          if (state.hint !== session) break;
          this._hintKey(state, chord);
        }
      })
      .catch((e) => {
        console.error("vimma: hints failed", e);
        if (state.hint === session) this._cancelHints(state);
      })
      .finally(() => this._hintRuns++);
  },

  /**
   * One key in hint mode (core hintKey): narrow, follow, or nothing.
   * @param {WindowState} state
   * @param {Chord} chord
   */
  _hintKey(state, chord) {
    const session = state.hint;
    if (!session) return;
    if (!session.hs) {
      session.buffered.push(chord);
      return;
    }
    const { state: next, result } = hintKey(session.hs, chord);
    session.hs = next;
    switch (result.kind) {
      case "cancel":
        this._cancelHints(state);
        return;
      case "narrow":
        state.hintOverlay.filter(next.typed);
        return;
      case "select":
        this._cancelHints(state);
        if (result.action === "hint.element") {
          // Never followed: the block is focused in its frame and outlined in chrome, where
          // the page sees nothing (element-focus decision 5).
          if (result.target.kind === "block") state.element.start(session.browser, result.target);
          return;
        }
        if (result.action === "hint.follow_new_tab") {
          VimmaActors.openInBackground(session.browser, result.target);
        } else {
          VimmaActors.activateHint(result.target);
        }
    }
  },

  /**
   * Leaves hint mode, if on: removes the labels and drops a collection in flight.
   * @param {WindowState} state
   */
  _cancelHints(state) {
    if (!state.hint) return;
    state.hint = null;
    state.hintOverlay.hide();
    this._emit(state); // the status bar leaves HINT, also when no key ended hint mode
    VimmaActors.cancelHints(state.win);
  },

  /**
   * @param {Window} win
   * @param {WindowState} state
   */
  _cancelPending(win, state) {
    this._clearTimer(win, state);
    state.dispatcher.reset();
    this._emit(state);
  },

  /**
   * @param {Window} win
   * @param {WindowState} state
   */
  _clearTimer(win, state) {
    if (state.timer === null) return;
    win.clearTimeout(state.timer);
    state.timer = null;
  },
};

// A finished update check redraws every status bar (docs/specs/m6a-updater.md §5).
VimmaUpdates.addListener(() => {
  for (const win of windows) {
    const state = states.get(win);
    if (state) VimmaHost._emit(state);
  }
});

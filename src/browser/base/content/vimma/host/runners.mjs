/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What each action does (docs/specs/m0-key-capture.md, docs/specs/m1-cmdline.md): the host's
// RUNNERS, which act on the window, and CONTENT_RUNNERS, which act on the focused page.
// VimmaHost.sys.mjs builds both tables from here and dispatches to them. The host is passed in,
// never imported, so this module and the *-ops.mjs modules it reaches load without a cycle;
// every runner calls the host only when it runs.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { describeAction } from "../core/actions.mjs";
import {
  parseBookmarksToolbarCommand,
  parseCommandLine,
  parseSettingsCommand,
  parseToolbarCommand,
} from "../core/cmdline.mjs";
import { parsePrivateCommand } from "../core/privatews.mjs";
import { findWorkspace } from "../core/workspaces.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { sayAddon, openAddonByName } from "./addon-ops.mjs";
import { runAgentCommand } from "./agent-chat-ops.mjs";
import { AgentUi } from "./agent-ui.mjs";
import { bookmarkContext, quickAdd } from "./bookmark-actions.mjs";
import { browserRunners, openSettings } from "./browser-ops.mjs";
import { ControlHost } from "./control-ops.mjs";
import { copyModeRunners } from "./copy-mode.mjs";
import { McpHost } from "./mcp-ops.mjs";
import { openOutline } from "./outline-ops.mjs";
import { goHistory, pageRunners } from "./page-ops.mjs";
import {
  closePane,
  focusPane,
  hasPanes,
  layoutRunner,
  newPane,
  paneRunner,
  resizePane,
  splitPane,
  splitPickerRows,
  stepSplits,
  swapPane,
  zoomPane,
} from "./pane-ops.mjs";
import { pdfRunners } from "./pdf-ops.mjs";
import { openSitePermissions } from "./permission-ops.mjs";
import {
  MOVE_OUT_REFUSED,
  closePrivate,
  cycleOutOfPrivate,
  isPrivateWorkspace,
  leavePrivate,
  switchFromPrivate,
  togglePrivate,
} from "./private-ops.mjs";
import { restartAsking } from "./restart.mjs";
import { runRoute } from "./route-ops.mjs";
import { closeTab, newTab, openOrSay, renameTab, restoreTab, selectTab } from "./tab-ops.mjs";
import { setBookmarksToolbar, setToolbar } from "./toolbar-ops.mjs";
import { checkUpdates } from "./update-ui.mjs";
import {
  NO_WORKSPACES,
  activeWorkspaceName,
  closeWorkspace,
  moveTabToWorkspace,
  newWorkspace,
  renameWorkspace,
  workspaceRef,
} from "./workspace-ops.mjs";

/** @import { Action } from "../core/dispatcher.mjs" */
/** @import { ElementFocus } from "./element-focus.mjs" */
/** @import { Find } from "./find.mjs" */
/** @import { OutlineHost } from "./outline-ops.mjs" */
/** @import { PageMode, VimmaHost, WindowState } from "./VimmaHost.sys.mjs" */

/** @typedef {typeof VimmaHost} Host */
/** @typedef {(state: WindowState, action: Action, text?: string) => void} Runner */

/**
 * The host's module state the runners reach, through functions the host passes in.
 * @typedef {object} HostState
 * @property {(win: Window) => WindowState | undefined} stateOf  a window's state
 * @property {(browser: any) => PageMode | undefined} browserMode  absent: normal
 * @property {(browser: any, mode: PageMode) => void} setBrowserMode
 * @property {(browser: any) => void} blurPage  Esc: focus out of the page, held in normal
 * @property {(browser: any) => void} enterExplicitInsert  `i`, `gi` (docs/specs/insert-focus.md)
 * @property {(browser: any) => { frame: any, windowId: number } | undefined} lastFieldFrame
 *   the frame whose text field last took focus
 * @property {(browser: any) => ElementFocus | null} elementOf  while in ELEMENT mode
 * @property {(browser: any) => Find | undefined} findOf  the window's find state
 * @property {(browser: any, text: string) => void} noticeFor  the owning window's notice
 * @property {OutlineHost} outline  what the PDF outline needs from the host
 */

/** Told by `:source` (config.reload); ConfigHost observes it, so the host never imports it. */
export const CONFIG_RELOAD_TOPIC = "vimma-config-reload";
/** Told by `:config` (config.edit), with the window as the subject; ConfigHost observes it. */
export const CONFIG_EDIT_TOPIC = "vimma-config-edit";

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
 * @param {(s: WindowState) => void} emit  the host's redraw
 * @returns {(state: WindowState, action: Action, text?: string) => void}
 */
function workspaceRunner(op, prompt, emit) {
  return (s, _a, text) => {
    if (!text) {
      s.cmdline.open(prompt(s.win));
      return;
    }
    const said = op(s.win, text);
    if (said) s.notice.show(said);
    emit(s);
  };
}

/**
 * `workspace.move_tab` in a normal window: `:wsmove name`, or its key asks. A move into the agent
 * workspace asks y/N first (docs/specs/vimma-mcp.md, decision 11).
 * @param {WindowState} s
 * @param {Action} a
 * @param {string | undefined} text
 * @param {(s: WindowState) => void} emit  the host's redraw
 */
const moveTab = (s, a, text, emit) =>
  workspaceRunner(
    (win, t) =>
      moveTabToWorkspace(
        win,
        t,
        (question, yes) => s.rename.ask(question, yes),
        (said) => s.notice.show(said),
      ),
    () => "wsmove ",
    emit,
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
 * An `[modal.index]` action, for the outline panel when it is open.
 * @param {WindowState} s
 * @param {Action} a
 */
function outlineAction(s, a) {
  s.outline.action(a);
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
 * @param {Host} host
 * @param {HostState} page
 */
function focusUrlbar(s, host, page) {
  s.panel.close();
  s.bookmarks.close();
  const browser = host._contentBrowser(s);
  if (browser && page.browserMode(browser) === "visual") {
    VimmaActors.caret(browser, "exit");
    page.setBrowserMode(browser, "normal");
  }
  /** @type {any} */ (s.win.document.getElementById("Browser:OpenLocation"))?.doCommand();
}

/**
 * What the host can execute so far, with CONTENT_RUNNERS. An action without an entry is left to
 * Firefox when it is a single key outside help; inside a sequence (or after a count) it is
 * consumed and shows "<action>: not implemented yet", so `ctrl+b <key>` never leaks the second key to the page and is never silent
 * (m2-tab-keys). Unbound keys always pass (m1-actor-insert-scroll, Settled). `text` is a
 * command's free-text argument (`:open example.com`, m1-cmdline); keys never carry one.
 * @param {Host} host
 * @param {HostState} page
 * @returns {Readonly<Record<string, Runner>>}
 */
export function hostRunners(host, page) {
  /** @param {WindowState} s */
  const emit = (s) => host._emit(s);
  const layout = layoutRunner(emit);
  return Object.freeze({
    // The overlay is the one list of bindings on screen: a toast from an earlier key gives way.
    "help.show": (/** @type {WindowState} */ s) => {
      s.notice.hide();
      s.help.toggle();
    },
    "help.close": (/** @type {WindowState} */ s) => s.help.close(),
    // Run from a key, they wait for the page (`_runAfterPage`); from anywhere else (the `:` line)
    // there is no chord to fall back to.
    "page.suggestion_next": (/** @type {WindowState} */ s, a) =>
      host._suggest(s, a, null, host._mode(s)),
    "page.suggestion_prev": (/** @type {WindowState} */ s, a) =>
      host._suggest(s, a, null, host._mode(s)),
    "help.filter": (/** @type {WindowState} */ s) => s.help.focusFilter(),
    "hint.cancel": (/** @type {WindowState} */ s) => host._cancelHints(s),
    "tab.new": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
      text ? openOrSay(s, text, "tab") : newTab(s.win),
    "tab.next": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
    "tab.previous": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
    "tab.goto": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
    // Firefox's alt+9: the workspace's last visible tab (docs/specs/firefox-keys.md).
    "tab.goto_last": (/** @type {WindowState} */ s, /** @type {Action} */ a) => selectTab(s.win, a),
    "tab.close": (/** @type {WindowState} */ s) => closeTab(s.win),
    // The focused pane; the last pane closes the tab (`:q`, prefix+x; m4-split-panes).
    "pane.close": paneRunner(closePane, emit),
    "pane.split_vertical": paneRunner(splitPane, emit),
    "pane.split_horizontal": paneRunner(splitPane, emit),
    "pane.focus_left": paneRunner(focusPane, emit),
    "pane.focus_down": paneRunner(focusPane, emit),
    "pane.focus_up": paneRunner(focusPane, emit),
    "pane.focus_right": paneRunner(focusPane, emit),
    "pane.zoom": paneRunner(zoomPane, emit),
    "pane.swap_left": paneRunner(swapPane, emit),
    "pane.swap_down": paneRunner(swapPane, emit),
    "pane.swap_up": paneRunner(swapPane, emit),
    "pane.swap_right": paneRunner(swapPane, emit),
    "pane.resize_narrower": paneRunner(resizePane, emit),
    "pane.resize_wider": paneRunner(resizePane, emit),
    "pane.resize_taller": paneRunner(resizePane, emit),
    "pane.resize_shorter": paneRunner(resizePane, emit),
    // docs/specs/multiple-splits.md behaviours 7 and 8.
    "pane.split_picker": (/** @type {WindowState} */ s) => {
      s.notice.hide();
      const rows = splitPickerRows(s.win);
      if ("refused" in rows) s.notice.show(rows.refused);
      else s.splitPicker.open();
    },
    "pane.next_split": paneRunner(stepSplits, emit),
    "pane.previous_split": paneRunner(stepSplits, emit),
    // docs/specs/tiling-layouts.md: dwindle's new pane, tmux's presets; the notice names the
    // preset.
    "pane.new": paneRunner(newPane, emit),
    "pane.next_layout": layout,
    "pane.layout_even_horizontal": layout,
    "pane.layout_even_vertical": layout,
    "pane.layout_main_vertical": layout,
    "pane.layout_main_horizontal": layout,
    "pane.layout_tiled": layout,
    "pane.layout_dwindle": layout,
    // A key bound to select_layout asks for the name on the command line.
    "pane.select_layout": (/** @type {WindowState} */ s, /** @type {Action} */ a, text) =>
      text ? layout(s, a, text) : s.cmdline.open("layout "),
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
    "urlbar.focus": (/** @type {WindowState} */ s) => focusUrlbar(s, host, page),
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
      renameTab(s, text, emit),
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
    "workspace.switch": (
      /** @type {WindowState} */ s,
      _a,
      /** @type {string | undefined} */ text,
    ) => switchWorkspace(s, text),
    // m3-workspaces 4a/4b: new, rename, close (asks y/N), move the tab (workspace-ops.mjs).
    "workspace.new": workspaceRunner(newWorkspace, () => "wsnew ", emit),
    "workspace.rename": workspaceRunner(
      renameWorkspace,
      (win) => `wsrename ${activeWorkspaceName(win) ?? ""}`,
      emit,
    ),
    "workspace.move_tab": (/** @type {WindowState} */ s, /** @type {Action} */ a, text) => {
      // private-workspace decision 5: a private tab never leaves the private workspace.
      if (isPrivateWorkspace(s.win)) s.notice.show(MOVE_OUT_REFUSED);
      else moveTab(s, a, text, emit);
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
    "workspace.route": (
      /** @type {WindowState} */ s,
      _a,
      /** @type {string | undefined} */ text,
    ) => {
      s.notice.hide();
      const said = runRoute(s.win, text ?? "", (t) => s.notice.show(t));
      if (said) s.notice.show(said);
    },
    "workspace.close": (
      /** @type {WindowState} */ s,
      _a,
      /** @type {string | undefined} */ text,
    ) => {
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
        s.outline.close();
        s.agentChat.close();
        if (!s.panel.open()) s.notice.show(NO_WORKSPACES);
      }
    },
    "toolbar.toggle": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ text) =>
      setToolbar(s, parseToolbarCommand(text)),
    "toolbar.show": (/** @type {WindowState} */ s) => setToolbar(s, { kind: "show" }),
    "toolbar.hide": (/** @type {WindowState} */ s) => setToolbar(s, { kind: "hide" }),
    "panel.down": panelAction,
    "panel.up": panelAction,
    "panel.first": panelAction,
    "panel.last": panelAction,
    "panel.half_down": panelAction,
    "panel.half_up": panelAction,
    "panel.open": panelAction,
    "panel.select": panelAction,
    "panel.close": panelAction,
    // key-handling-batch § 4: x in the side panel; nothing in the bookmarks panel (d deletes
    // there).
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
    ...browserRunners((win, text) => page.stateOf(win)?.notice.show(text)),
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
      if (result.kind === "run") host._runCommand(s, result);
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
        s.outline.close();
        s.agentChat.close();
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
    // docs/specs/pdf-mode.md decision 10: Tab in the PDF viewer, the outline in the side panel's
    // slot; its keys run in `index` mode while it is open.
    "pdf.outline": (/** @type {WindowState} */ s) => openOutline(s, page.outline),
    "index.down": outlineAction,
    "index.up": outlineAction,
    "index.expand": outlineAction,
    "index.collapse": outlineAction,
    "index.expand_subtree": outlineAction,
    "index.collapse_subtree": outlineAction,
    "index.expand_all": outlineAction,
    "index.collapse_all": outlineAction,
    "index.first": outlineAction,
    "index.last": outlineAction,
    "index.half_down": outlineAction,
    "index.half_up": outlineAction,
    "index.follow": outlineAction,
    "index.close": outlineAction,
    "index.filter": outlineAction,
    // docs/specs/addon-manager.md: prefix+e / :addons, and :addon <name> (without one it asks).
    "addons.picker": (/** @type {WindowState} */ s) => {
      s.notice.hide();
      s.addonPicker.open();
    },
    // docs/specs/site-permissions.md: `:site`, the selected page's permissions (security.md §19).
    "site.permissions": (/** @type {WindowState} */ s) => {
      s.notice.hide();
      const opened = openSitePermissions(s.win);
      if ("refused" in opened) s.notice.show(opened.refused, { error: true });
      else s.permissionPicker.openWithTitle(opened.title);
    },
    // docs/specs/popup-blocked.md: :popups (no default key), the pop-up blocked bar's options.
    "popups.picker": (/** @type {WindowState} */ s) => {
      s.notice.hide();
      s.popups.open();
    },
    // docs/specs/downloads.md: prefix+d / :downloads.
    "downloads.picker": (/** @type {WindowState} */ s) => {
      s.notice.hide();
      // The segment's `done`, `failed` and `blocked` have been seen once the picker opens.
      s.downloads.clearEnd();
      s.downloadPicker.open();
    },
    // `:settings [pane]` (m1-cmdline, Since changed): an unknown pane is refused as a notice.
    "browser.settings": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ t) => {
      const settings = parseSettingsCommand(t);
      if (settings.kind === "refuse") s.notice.show(settings.text, { error: true });
      else openSettings(s.win, settings.url);
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
    // `:agent [word]` and prefix+i (docs/specs/builtin-agent.md Behaviour 14, B13): the built-in
    // agent's window, in the side panel's slot, one panel at a time.
    "agent.command": (/** @type {WindowState} */ s, _a, /** @type {string | undefined} */ t) => {
      s.notice.hide();
      s.panel.close();
      s.bookmarks.close();
      s.outline.close();
      runAgentCommand(s.agentChat, t, (text, error) => s.notice.show(text, { error: !!error }));
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
}

/**
 * Actions on the focused page (m1-actor-insert-scroll). Runnable only while a content browser
 * with our actor has focus; elsewhere (the URL bar) they count as not runnable, so Esc there
 * still reaches Firefox. Every runnable id is a key of RUNNERS or CONTENT_RUNNERS; whether one
 * runs right now is `VimmaHost._runnable(state, id)`.
 * @param {Host} host
 * @param {HostState} page
 * @returns {Readonly<Record<string, (browser: any, action: Action) => void>>}
 */
export function contentRunners(host, page) {
  return Object.freeze({
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
      if (page.browserMode(b) === "visual") VimmaActors.caret(b, "exit");
      page.setBrowserMode(b, "normal");
      page.blurPage(b);
    },
    "hint.follow": (b, a) => host._startHints(b, a),
    "hint.follow_new_tab": (b, a) => host._startHints(b, a),
    "hint.follow_new_tab_fg": (b, a) => host._startHints(b, a),
    "hint.element": (b, a) => host._startHints(b, a),
    "hint.show_target": (b, a) => host._startHints(b, a),
    "hint.copy_target": (b, a) => host._startHints(b, a),
    // The ELEMENT mode's keys (docs/specs/element-focus.md decision 7).
    "element.visual": (b) => page.elementOf(b)?.visual(false),
    "element.visual_line": (b) => page.elementOf(b)?.visual(true),
    "element.yank": (b) => page.elementOf(b)?.yank(),
    "element.parent": (b, a) => page.elementOf(b)?.move("parent", a.count),
    "element.child": (b, a) => page.elementOf(b)?.move("child", a.count),
    "element.next": (b, a) => page.elementOf(b)?.move("next", a.count),
    "element.prev": (b, a) => page.elementOf(b)?.move("prev", a.count),
    // Explicit insert, even with no text field to focus (pass-through for pages that take keys).
    // The field the user was last in comes first, then the page's first one (insert-focus).
    "mode.insert": (b) => {
      page.enterExplicitInsert(b);
      VimmaActors.focusInput(b, page.lastFieldFrame(b));
    },
    // Find in page over Firefox's find bar (m1-find).
    "find.forward": (b) => page.findOf(b)?.start(b, false),
    "find.backward": (b) => page.findOf(b)?.start(b, true),
    "find.next": (b) => page.findOf(b)?.again(b, false),
    "find.previous": (b) => page.findOf(b)?.again(b, true),
    // Copy mode: caret, selection and yank in the focused frame (m1-copy-mode).
    ...copyModeRunners(page.setBrowserMode, page.noticeFor),
    // yy, p / P, gi, gu / gU, gf (m1-actor-insert-scroll, follow-up: normal-mode extras).
    ...pageRunners(page.enterExplicitInsert, page.noticeFor),
    // The PDF viewer's page, zoom and layout keys (docs/specs/pdf-mode.md).
    ...pdfRunners(page.noticeFor),
  });
}

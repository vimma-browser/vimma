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
import { SETUP_SCREENS } from "../core/control.mjs";
import { resolveEscape } from "../core/escape.mjs";
import {
  insertEditCommand,
  insertModeAfterFocus,
  isEditable,
  matchSiteRule,
} from "../core/editable.mjs";
import {
  DEFAULT_HINT_CHARS,
  HintError,
  hintKey,
  hintLabelCase,
  hintStatus,
  startHints,
} from "../core/hints.mjs";
import { chordFromEvent, formatKey, parseKey } from "../core/keys.mjs";
import { SUGGESTION_ACTIONS, suggestionStep } from "../core/suggestions.mjs";
import { pressKeyLater, pressingKey } from "../actors/enter-key.mjs";
import { compileKeymap, withSiteUnbinds } from "../core/keymap.mjs";
import { KEY_KEEPING_MODES } from "../core/modes.mjs";
import { notImplementedText } from "../core/actions.mjs";
import { PENDING_ACTIONS } from "../core/cmdline.mjs";
import { StatusBar } from "../ui/statusbar.mjs";
import { TabLine } from "../ui/tabline.mjs";
import { startTabLabels, tabCountRefusal, tabLabelKey } from "../core/tabline.mjs";
import { TabStrip } from "../ui/tabstrip.mjs";
import { Toolbar } from "../ui/toolbar.mjs";
import { bookmarksRoot, setBookmarkletsSetting, setBookmarksRoot } from "./bookmark-ops.mjs";
import { getTabLabel } from "../workspaces/tab-labels.mjs";
import { VimmaUpdates } from "../updates/VimmaUpdates.sys.mjs";
import { openOrSay, selectTab, selectableTabs } from "./tab-ops.mjs";
import { tabById } from "./goto.mjs";
import { DEFAULT_FIREFOX_KEYS, FirefoxKeys } from "./firefox-keys.mjs";
import { boundChords, firefoxShortcuts, pageFirst } from "../core/firefox-keys.mjs";
import { focusedChromeField, runChromeEdit } from "./edit-keys.mjs";
import { hasPanes, splitStatus } from "./pane-ops.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { leaves } from "../core/panes.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { privateStatus, privateTabCount } from "./private-ops.mjs";
import { restartAsking, restartOrSay, tabsKeptBy } from "./restart.mjs";
import { AgentUi } from "./agent-ui.mjs";
import { AgentGate } from "./AgentGate.sys.mjs";
import { logCells } from "../core/agent-prompt.mjs";
import { PromptKeys } from "./prompt-keys.mjs";
import { GotoPicker, MCP_LOG } from "../ui/picker.mjs";
import { UrlbarCommands } from "./urlbar-commands.mjs";
import { UrlbarQueries } from "./urlbar-queries.mjs";
import { newWindowState } from "./window-state.mjs";
import { ANNOUNCE_MS, UpdateUi } from "./update-ui.mjs";
import { KeyLog } from "./key-log.mjs";
import { addonNames } from "./addon-ops.mjs";
import { forgetSitePermissions } from "./permission-ops.mjs";
import { popupStatus } from "./popup-ops.mjs";
import { PdfOps, pdfFindStatus } from "./pdf-ops.mjs";
import { TemporarySiteUnbinds } from "./site-keys-ops.mjs";
import { stripInvisible } from "../core/pdf.mjs";
import { contentRunners, hostRunners } from "./runners.mjs";
import { HostServices } from "./host-services.mjs";
import { dropOutlineAsk } from "./outline-ops.mjs";
import { HoverOps } from "./hover-ops.mjs";

// Defined with the code that uses them; importers reach them here, as before the runners moved.
export { CONFIG_EDIT_TOPIC, CONFIG_RELOAD_TOPIC } from "./runners.mjs";
export { NO_OUTLINE, OUTLINE_ATTACHMENT, PDF_OUTLINE_PREF } from "./outline-ops.mjs";

/** @import { PageFirstQueue } from "../core/page-first.mjs" */
/** @import { CommandLine } from "../ui/cmdline.mjs" */
/** @import { HelpOverlay } from "../ui/help-overlay.mjs" */
/** @import { HintOverlay } from "../ui/hint-overlay.mjs" */
/** @import { DownloadRows, DownloadWatch } from "./download-ops.mjs" */
/** @import { Find } from "./find.mjs" */
/** @import { ElementFocus } from "./element-focus.mjs" */
/** @import { Notice } from "../ui/notice.mjs" */
/** @import { AddonPicker, DownloadPicker, PermissionPicker, PopupPicker } from "../ui/picker.mjs" */
/** @import { BookmarkPicker, SplitPicker, WorkspacePicker } from "../ui/picker.mjs" */
/** @import { RenamePrompt } from "../ui/rename-prompt.mjs" */
/** @import { SidePanel } from "../ui/side-panel.mjs" */
/** @import { BookmarksPanel } from "../ui/bookmarks-panel.mjs" */
/** @import { OutlinePanel } from "../ui/pdf-outline.mjs" */
/** @import { AgentChatWindow } from "../ui/agent-chat.mjs" */
/** @import { GrepSession } from "./grep.mjs" */
/** @import { AgentPrompt } from "../ui/agent-prompt.mjs" */
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
/** @import { BookmarkletsSetting, BookmarksRoot } from "../core/bookmarks.mjs" */
/** @import { OutlineHost } from "./outline-ops.mjs" */
/** @import { HostState } from "./runners.mjs" */
/** @import { SuggestionAction } from "../core/suggestions.mjs" */

/**
 * Hint mode in one window (m1-hints): from `f` until a label is chosen or Esc. While the
 * targets are being collected, keys are kept and replayed once the labels are up.
 * @typedef {object} HintSession
 * @property {MozBrowser} browser  the <browser> the hints are on
 * @property {HintAction} action
 * @property {HintState<HintTarget> | null} hs  null while collecting
 * @property {Chord[]} buffered  keys typed while collecting, or while `wheel`
 * @property {boolean} [wheel]  a wheel over the page: its labels are hidden until it is known
 *   whether the wheel moved their targets (#1337)
 * @property {{ x: number, y: number }} [wheelAt]  a wheel came while collecting, here (the
 *   page's CSS pixels): the labels are looked at for it before they are shown
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
 * `defaultPreventedByContent` and `defaultPreventedByChrome` are Event.webidl's (ChromeOnly).
 * @typedef {KeyboardEvent & { isReplyEventFromRemoteContent: boolean,
 *   requestReplyFromRemoteContent: () => void, defaultPreventedByContent: boolean,
 *   defaultPreventedByChrome: boolean, preventMultipleActions: () => void }} ChromeKeyEvent
 */

/**
 * @param {string} id
 * @returns {id is SuggestionAction}
 */
const isSuggestionAction = (id) => /** @type {ReadonlySet<string>} */ (SUGGESTION_ACTIONS).has(id);

/**
 * A key typed in a password field (an <input type=password> in chrome or a parent-process page).
 * @param {EventTarget | null} target
 */
const isPasswordField = (target) =>
  /** @type {{ readonly type?: unknown } | null} */ (target)?.type === "password";

/**
 * A key whose target is a <browser> showing a page in another process.
 * @param {EventTarget | null} target
 */
const isRemoteBrowserTarget = (target) =>
  !!(/** @type {{ readonly isRemoteBrowser?: unknown } | null} */ (target)?.isRemoteBrowser);

/**
 * @typedef {object} WindowState
 * @property {BrowserWindow} win
 * @property {Keymap} keymap
 * @property {(e: KeyboardEvent) => void} onKeyDown
 * @property {(e: KeyboardEvent) => void} onKeyDownAfter  after the page: text-field keys
 * @property {(e: KeyboardEvent) => void} onKeyPress  a page-first binding's keypress, before
 *   the page: asks a remote page for its reply, or takes the reply (firefox-keys decision 6)
 * @property {(e: KeyboardEvent) => void} onKeyPressAfter  the same keypress after a
 *   parent-process page or a chrome field had it
 * @property {PageFirstQueue<DispatchResult>} pageFirst  bindings waiting for the page to leave
 *   their key alone (core page-first.mjs)
 * @property {FirefoxKeys | null} firefoxKeys  Firefox's own shortcuts off (key-handling-batch)
 * @property {() => void} onTabSelect
 * @property {Element | null} focusNow  the element focus last went to in this window
 * @property {Element | null} focusBefore  the one before it
 * @property {(e: FocusEvent) => void} onFocusIn  keeps focusNow and focusBefore
 * @property {Element | null} dialogOpener  what had focus when the last dialog opened
 * @property {() => void} onDialogOpen  records dialogOpener
 * @property {() => void} onDialogClose  focus left on nothing by a closed dialog goes back to the
 *   hidden address bar it was opened from, else to the page
 * @property {ReturnType<typeof createDispatcher>} dispatcher
 * @property {HelpOverlay} help
 * @property {Notice} notice  "<action>: not implemented yet" (m2-tab-keys)
 * @property {CommandLine} cmdline  the `:` line (m1-cmdline)
 * @property {TabStrip | null} tabStrip  hides Firefox's tab strip (m0-tabstrip-hidden)
 * @property {Toolbar | null} toolbar  hides Firefox's toolbar (docs/specs/toolbar-toggle.md)
 * @property {UrlbarQueries | null} urlbarQueries  the address bar's queries, for `state.urlbar`
 * @property {UrlbarCommands | null} urlbarCommands  a `:` line in the start page's address bar
 * @property {PromptKeys | null} promptKeys  y and n for Firefox's permission prompts
 * @property {number | null} timer   pending-sequence timeout (dispatcher.flush)
 * @property {() => void} onCancelHints  resize, a mouse click in chrome
 * @property {() => void} onMouseDown  a mouse click: hint mode and element focus end
 * @property {(e: WheelEvent) => void} onWheel  a wheel over the page: the labels follow it
 * @property {HintSession | null} hint
 * @property {ElementFocus} element  the focused text block (docs/specs/element-focus.md)
 * @property {HintOverlay} hintOverlay
 * @property {Set<() => void>} listeners  told after mode or pending keys may have changed
 * @property {StatusBar | null} statusBar  m2-statusbar-whichkey (the bar; no which-key strip)
 * @property {TabLine | null} tabLine  the tab line (docs/specs/tab-line.md)
 * @property {import("../core/tabline.mjs").TabLineLabels | null} tabLabels  gb's labels while they
 *   show: every key is theirs (docs/specs/tab-line.md decision 12)
 * @property {GotoPicker} picker  the prefix+g overlay (m2-picker-rename)
 * @property {WorkspacePicker} wsPicker  the prefix+w overlay (m3-workspaces 5)
 * @property {GotoPicker} mcpLog  `:mcp log`, the agents' last calls (docs/specs/mcp-drive.md D14)
 * @property {AddonPicker} addonPicker  the prefix+e overlay (docs/specs/addon-manager.md)
 * @property {PermissionPicker} permissionPicker  `:site` (docs/specs/site-permissions.md)
 * @property {PopupPicker} popups  the `:popups` overlay (docs/specs/popup-blocked.md)
 * @property {SplitPicker} splitPicker  the workspace's splits (docs/specs/multiple-splits.md)
 * @property {BookmarkPicker} bookmarkPicker  `:bookmarkopen`'s (docs/specs/bookmark-open.md)
 * @property {DownloadWatch} downloads  the status bar's `↓` segment (docs/specs/downloads.md)
 * @property {DownloadPicker} downloadPicker  the prefix+d overlay (docs/specs/downloads.md)
 * @property {DownloadRows} downloadRows  the picker's rows while it is open
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
 * @property {OutlinePanel} outline  the PDF viewer's outline on Tab, in the side panel's slot and
 *   `index` mode (docs/specs/pdf-mode.md decision 10)
 * @property {{ browser: MozBrowser, timer: number } | null} outlineFor  the outline Tab asked for,
 *   until it comes, another key is pressed, the tab changes or OUTLINE_WAIT_MS pass
 * @property {() => void} stopOutline  ends the PDF outline subscription (pdf-ops.mjs)
 * @property {AgentChatWindow} agentChat  `:agent`, the built-in agent's window in the side
 *   panel's slot; its keys are its own while focus is in it (docs/specs/builtin-agent.md)
 * @property {() => void} onAgentChat  the built-in agent's conversations changed: the status
 *   bar redraws
 * @property {Find} find  `/`, `?`, `n`, `N` over Firefox's find bar (m1-find)
 * @property {() => void} stopPdf  ends the PDF state subscription (pdf-ops.mjs)
 * @property {() => void} stopPanes  ends the pane watch that ends resize mode (PaneView.mjs)
 * @property {boolean} private  a private window: its keys are not logged (private-workspace)
 * @property {boolean} resize  in resize mode (`prefix+r`, m4-split-panes sub-spec 5, ADR-014)
 */

/**
 * Whether one of Vimma's own surfaces holds the keyboard: the help overlay, a picker, live grep,
 * the command line, a prompt, the side panel, the bookmarks or a search being typed. The agent
 * question, the update question and the permission prompt keys all stand back for these, from
 * this one list (through `keysHeld`), so a surface added later reaches all three.
 * @param {WindowState} s
 */
function vimmaSurfaceOpen(s) {
  return (
    s.help.isOpen ||
    s.picker.isOpen ||
    s.wsPicker.isOpen ||
    s.addonPicker.isOpen ||
    s.permissionPicker.isOpen ||
    s.popups.isOpen ||
    s.splitPicker.isOpen ||
    s.bookmarkPicker.isOpen ||
    s.downloadPicker.isOpen ||
    s.mcpLog.isOpen ||
    s.grep.isOpen ||
    s.cmdline.focused ||
    s.rename.isOpen ||
    s.panel.isOpen ||
    s.bookmarks.isOpen ||
    s.outline.isActive ||
    s.agentChat.focused ||
    s.find.typing
  );
}

/**
 * Whether the keys are not a question's to take: one of Vimma's own surfaces is open, or the
 * mode types its own letters (a hint label, copy and element mode's yank; KEY_KEEPING_MODES).
 * Labels or a focused block still on screen count too when focus has left their page (a prompt
 * that takes focus, the add-on install prompt): the user may still be typing a label. The next
 * key ends them (`_onKeyDown`), so the prompt answers after that.
 * The agent question, the update question and the permission prompt keys share this guard.
 * @param {WindowState} s
 */
function keysHeld(s) {
  if (vimmaSurfaceOpen(s) || s.hint || s.tabLabels || s.element.browser) return true;
  return KEY_KEEPING_MODES.has(VimmaHost._mode(s));
}

/**
 * What the PDF outline (outline-ops.mjs) needs from the host.
 * @type {OutlineHost}
 */
const OUTLINE_HOST = {
  mode: (s) => VimmaHost._mode(s),
  selectedBrowser: (s) => VimmaHost._selectedBrowser(s),
  surfaceOpen: vimmaSurfaceOpen,
};

/**
 * Pane actions that do something only with two panes or more: as single keys they are
 * runnable only then, so the first ctrl+w of `<C-w>h` passes to the page while the window has
 * one pane (Firefox's ctrl+w close tab is off, key-handling-batch). `prefix+h` is
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
 * The page mode of each tab's <browser>, from the actor's focus reports; absent = normal.
 * Written only through setBrowserMode.
 * @type {WeakMap<MozBrowser, PageMode>}
 */
const browserModes = new WeakMap();

/** @typedef {"normal" | "insert" | "visual"} PageMode  visual: copy mode (m1-copy-mode) */

/**
 * @param {MozBrowser} browser
 * @param {PageMode} mode
 */
function setBrowserMode(browser, mode) {
  if (mode !== "insert") explicitInsert.delete(browser);
  else escapeHold.delete(browser);
  pageInsert.delete(browser);
  if ((browserModes.get(browser) ?? "normal") === mode) return;
  browserModes.set(browser, mode);
  VimmaHost.onModeChange(browser, mode);
}

/**
 * Tabs in explicit insert (`i`, `gi`; docs/specs/insert-focus.md): the inner window ID of the
 * top document it was entered on. Focus reports from that document do not end it; Esc does, as
 * does any other change to normal mode (setBrowserMode). A new top document starts over.
 * @type {WeakMap<MozBrowser, number>}
 */
const explicitInsert = new WeakMap();

/**
 * Tabs whose user pressed Esc (docs/specs/insert-focus.md, behaviour 6): the inner window ID of
 * the top document it was pressed on. While it is shown, a focus the page's script makes on its
 * own does not enter insert. Entering insert, a focus report the user's input caused, a key the
 * page gets and a new top document end the hold.
 * @type {WeakMap<MozBrowser, number>}
 */
const escapeHold = new WeakMap();

/**
 * Tabs in insert mode that the page's script entered on its own (docs/specs/mcp-drive.md D13,
 * issue #1325): a field it focused with no input of the user's behind it, such as a dialog with
 * autofocus that an agent's click opened. Such a tab is not in use by the user, so an agent may
 * still fill it. Any other change of mode ends the mark (setBrowserMode), and so does the user's
 * own key or click in the tab (noteUserInput), or a focus report their input caused.
 * @type {WeakSet<MozBrowser>}
 */
const pageInsert = new WeakSet();

/**
 * The top document (inner window ID) in which each tab's insert mode was last the user's. Once
 * the user has made a field of a document theirs, a field that document's script focuses later
 * is theirs too, also after a pause and a blur and focus of the page's own (a messaging page that
 * re-renders its field): the page does not hand the tab back to an agent. Leaving insert by the
 * user's own doing ends it (Esc, a click outside a field, a Vimma key that leaves the mode), and
 * a new top document does not match. A page that blurs the field on its own does not end it.
 * @type {WeakMap<MozBrowser, number>}
 */
const userInsertDoc = new WeakMap();

/**
 * When the user last gave each tab's page a key or a click, in `ChromeUtils.now()` milliseconds.
 * Keys are the window's own trusted keydown events that Vimma left to the page, which no page
 * and no agent can make; clicks are the page's trusted mousedown events (VimmaParent's
 * `Vimma:Click`), which an agent's untrusted one is not (#1327).
 * @type {WeakMap<MozBrowser, number>}
 */
const lastUserInput = new WeakMap();

/**
 * How long after the user's key or click a focus the page makes counts as theirs: a page that
 * opens its dialog once its server answers the click focuses the field outside any input
 * handler. The same 5 s as Firefox's transient user activation
 * (dom.user_activation.transient.timeout), the time a page may act on a gesture.
 */
const USER_INPUT_RECENT_MS = 5000;

/** Keys with no name Vimma binds that are still the user typing: an IME's, a dead key's. */
const TEXT_KEYS = new Set(["Process", "Dead", "Unidentified"]);

/**
 * The user pressed a key or clicked in `browser`'s tab: a page-made insert there is theirs now.
 * @param {MozBrowser} browser
 */
function noteUserInput(browser) {
  lastUserInput.set(browser, ChromeUtils.now());
  pageInsert.delete(browser);
  if (browserModes.get(browser) === "insert") userInsertDoc.set(browser, topWindowId(browser));
}

/**
 * Leaves `browser`'s page mode at `mode` by the user's own doing (a runner, Esc): an insert the
 * user owned in its document is over.
 * @param {MozBrowser} browser
 * @param {PageMode} mode
 */
function setBrowserModeByUser(browser, mode) {
  if (mode !== "insert") userInsertDoc.delete(browser);
  setBrowserMode(browser, mode);
}

/** @param {MozBrowser} browser */
function recentUserInput(browser) {
  const at = lastUserInput.get(browser);
  return at !== undefined && ChromeUtils.now() - at < USER_INPUT_RECENT_MS;
}

/**
 * The document of each tab that Esc's blur last went to, and that blur's generation
 * (behaviour 7): a report from that document with an older generation was sent before the
 * blur and is dropped.
 * @type {WeakMap<MozBrowser, { windowId: number, gen: number }>}
 */
const lastBlur = new WeakMap();

/** @param {MozBrowser} browser */
function topWindowId(browser) {
  return browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
}

/**
 * Enters explicit insert in `browser`'s tab.
 * @param {MozBrowser} browser
 */
function enterExplicitInsert(browser) {
  setBrowserMode(browser, "insert");
  explicitInsert.set(browser, topWindowId(browser));
  userInsertDoc.set(browser, topWindowId(browser));
}

/**
 * The frame of each tab whose text field last took focus, and its document's inner window ID,
 * so `i` can go back to that field.
 * @type {WeakMap<MozBrowser, { frame: CanonicalBrowsingContext, windowId: number }>}  browser → BrowsingContext and ID
 */
const lastFieldFrame = new WeakMap();

/**
 * Shows `text` as the notice of the window that owns `browser`.
 * @param {MozBrowser} browser
 * @param {string} text
 */
function noticeFor(browser, text) {
  stateOfBrowser(browser)?.notice.show(text);
}

/**
 * The element focus of the window that owns `browser`, while that browser is in ELEMENT mode.
 * @param {MozBrowser} browser
 * @returns {ElementFocus | null}
 */
function elementOf(browser) {
  const element = stateOfBrowser(browser)?.element;
  return element?.browser === browser ? element : null;
}

/**
 * Takes focus out of `browser`'s focused frame (Esc), and holds the tab in normal mode against
 * a focus the page's script makes next (insert-focus behaviour 6).
 * @param {MozBrowser} browser
 */
function blurPage(browser) {
  userInsertDoc.delete(browser);
  escapeHold.set(browser, topWindowId(browser));
  const blur = VimmaActors.blur(browser);
  if (blur) lastBlur.set(browser, blur);
  else lastBlur.delete(browser);
}

/**
 * The find state of the window that owns `browser`.
 * @param {MozBrowser} browser
 * @returns {Find | undefined}
 */
function findOf(browser) {
  return stateOfBrowser(browser)?.find ?? undefined;
}

/**
 * The page and window state the runners (runners.mjs) reach.
 * @type {HostState}
 */
const HOST_STATE = {
  stateOf: (win) => states.get(win),
  browserMode: (browser) => browserModes.get(browser),
  // The runners run the user's keys: a mode they leave is left by the user.
  setBrowserMode: setBrowserModeByUser,
  blurPage,
  enterExplicitInsert,
  lastFieldFrame: (browser) => lastFieldFrame.get(browser),
  elementOf,
  findOf,
  noticeFor,
  outline: OUTLINE_HOST,
};

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

/**
 * Keyed by any window, so a <browser>'s `ownerDocument.defaultView` looks its window up as it
 * is: only browser windows are ever set.
 * @type {WeakMap<Window, WindowState>}
 */
const states = new WeakMap();
/** The windows in `states`, for `configure` (a WeakMap cannot be iterated). */
/** @type {Set<BrowserWindow>} */
const windows = new Set();

/**
 * The state of the window `browser` is in, if that is one of ours. Read through `defaultView`,
 * the WindowProxy init() was given: the inner window would be another key.
 * @param {MozBrowser | null | undefined} browser
 * @returns {WindowState | undefined}
 */
function stateOfBrowser(browser) {
  const win = browser?.ownerDocument?.defaultView;
  return win ? states.get(win) : undefined;
}

/**
 * What config.toml sets for every window (m5-config-load; ConfigHost calls `configure`). Null
 * keymap: the built-in one, compiled per window as before M5.
 * `configFile` names the file `configErrors` are about (config.toml, or `:source <path>`'s).
 * `firefox`: Firefox's own shortcuts that are off; `insertEditing`: ctrl+w, ctrl+u, ctrl+h in
 * text fields (docs/specs/key-handling-batch.md).
 * `baseKeymap` is config.toml's, and `keymap` it with `:siteunbind`'s keys until restart
 * (docs/specs/site-unbind-command.md decision 4).
 * @type {{ keymap: Keymap | null, baseKeymap: Keymap | null, hintChars: string | undefined,
 *   sites: readonly InsertSiteRule[], configErrors: readonly ConfigError[], configFile: string,
 *   firefox: FirefoxKeySetting, insertEditing: boolean }}
 */
const settings = {
  keymap: null,
  baseKeymap: null,
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

/**
 * The `[sites."<host>"] insert` rule for the page in `browser`, "auto" without one.
 * @param {MozBrowser} browser
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
 * The `[sites."<host>"]` table whose `unbind` applies to a key pressed in `browser`, the focused
 * page, or null (docs/specs/site-unbind.md): the keymap's own match on the top document's host,
 * so a page cannot choose it other than by its address. No browser (focus in chrome) is null.
 * @param {Keymap} keymap
 * @param {MozBrowser | null} browser
 * @returns {string | null}
 */
function pageSite(keymap, browser) {
  if (!browser || !keymap.hasSiteUnbinds()) return null;
  /** @type {string} */
  let host;
  try {
    host = browser.currentURI?.host ?? "";
  } catch {
    return null; // about:, data:, file: have no host
  }
  return keymap.site(host);
}

/**
 * The focused pane's 1-based place in reading order and the pane count, or null with one pane.
 * @param {BrowserWindow} win
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
    ...splitStatus(win),
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

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/**
 * Whether `el` is a XUL <browser>: every one is a MozBrowser (browser-custom-element.mjs defines
 * the element for the XUL namespace).
 * @param {Element} el
 * @returns {el is MozBrowser}
 */
function isBrowser(el) {
  return el.localName === "browser" && el.namespaceURI === XUL_NS;
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

  /** Test-only: how many wheels over labels have been looked at (moved or not). */
  _hintWheels: 0,

  /**
   * Test-only: the window's live grep session (docs/specs/live-grep.md).
   * @param {BrowserWindow} win
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

  /** @param {BrowserWindow} win */
  init(win) {
    if (states.has(win)) return;
    const keymap = settings.keymap ?? compileKeymap({}, { mac: MAC });
    // `:mcp log` (docs/specs/mcp-drive.md D14), built here beside the gate's import.
    const mcpLog = new GotoPicker(
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
    );
    const state = newWindowState(this, win, keymap, {
      runnable: RUNNABLE,
      setBrowserMode: setBrowserModeByUser,
      stateOfBrowser,
      outline: OUTLINE_HOST,
      mcpLog,
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
      otherOpen: () => keysHeld(state) || UpdateUi.isOpen(win),
      pending: () => state.dispatcher.pending().length > 0,
      notice: (text, ms) => state.notice.show(text, ms ? { ms } : undefined),
      noticeOpen: () => !!state.notice.el?.matches(":popover-open"),
      ask: (question, yes) => state.rename.ask(question, yes),
      emit: () => this._emit(state),
      // docs/specs/builtin-agent.md Behaviour 27: the open conversation's questions, in its window.
      slot: state.agentChat.slot,
      slotConn: () => state.agentChat.conn,
      chatFocused: () => state.agentChat.focused,
      slotChanged: () => state.agentChat.slotChanged(),
      focusChat: () => state.agentChat.normal(),
    });
    HostServices.agentChat.addListener(state.onAgentChat);
    // The update message and the security update question (docs/specs/update-notices.md): the
    // same guards as the agent question, which goes first.
    UpdateUi.register(win, {
      prompt: state.updatePrompt,
      inField: () => this._mode(state) === "insert",
      otherOpen: () => keysHeld(state) || state.agentPrompt.isOpen || !!state.promptKeys?.current,
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
    win.addEventListener("TabClose", releaseHoverOnClose, true);
    // Bubbles from the dialog's overlay (SubDialog.sys.mjs, close).
    win.addEventListener("focusin", state.onFocusIn, true);
    win.addEventListener("dialogopen", state.onDialogOpen, true);
    win.addEventListener("dialogclose", state.onDialogClose, true);
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
    // Passive: it only reads, so it never holds up the scroll (APZ need not wait for it).
    win.addEventListener("wheel", state.onWheel, { capture: true, passive: true });
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
    try {
      state.urlbarQueries = new UrlbarQueries(win);
    } catch (e) {
      console.error("vimma: the address bar's queries are not reported", e);
    }
    // A `:` line in the start page's address bar (start-page spec; #1271): as if typed after
    // `:` on the page, so the line opens over the page and gives focus back to it.
    try {
      state.urlbarCommands = new UrlbarCommands(win, (line, run) => {
        win.gBrowser.selectedBrowser.focus();
        state.cmdline.enter(line, { run });
      });
    } catch (e) {
      console.error("vimma: a : line in the start page's address bar would search", e);
    }
    // Firefox's permission prompts from the keyboard (toolbar-toggle decision 11a).
    try {
      const promptKeys = new PromptKeys(win, {
        inField: () => this._mode(state) === "insert",
        otherOpen: () => keysHeld(state) || state.agentPrompt.isOpen || UpdateUi.isOpen(win),
        pending: () => state.dispatcher.pending().length > 0,
        modeKeys: () => KEY_KEEPING_MODES.has(this._mode(state)),
        changed: () => this._emit(state),
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
    // docs/specs/tab-line.md: the side panel's rows, drawn at the top of the window.
    try {
      const tabLine = new TabLine(win, {
        rows: () => state.panel.snapshot(),
        labels: () => state.tabLabels,
        subscribe: (fn) => this.onStateChange(win, fn),
        changed: () => this._emit(state),
      });
      tabLine.init();
      state.tabLine = tabLine;
    } catch (e) {
      console.error("vimma: no tab line", e);
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

  /** @param {BrowserWindow} win */
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
    win.removeEventListener("TabClose", releaseHoverOnClose, true);
    win.removeEventListener("focusin", state.onFocusIn, true);
    win.removeEventListener("dialogopen", state.onDialogOpen, true);
    win.removeEventListener("dialogclose", state.onDialogClose, true);
    state.firefoxKeys?.destroy();
    win.removeEventListener("resize", state.onCancelHints);
    win.removeEventListener("mousedown", state.onMouseDown, true);
    win.removeEventListener("wheel", state.onWheel, { capture: true });
    this._cancelHints(state);
    state.element.leave();
    state.help.destroy();
    state.notice.destroy();
    state.cmdline.destroy();
    state.picker.destroy();
    state.wsPicker.destroy();
    state.addonPicker.destroy();
    state.permissionPicker.destroy();
    forgetSitePermissions(win);
    state.popups.destroy();
    state.splitPicker.destroy();
    state.bookmarkPicker.destroy();
    state.downloads.destroy();
    state.downloadPicker.destroy();
    state.downloadRows.close();
    state.mcpLog.destroy();
    state.grep.destroy();
    state.rename.destroy();
    state.panel.destroy();
    state.bookmarks.destroy();
    state.outline.destroy();
    HostServices.agentChat.removeListener(state.onAgentChat);
    state.agentChat.destroy();
    state.tabStrip?.uninit();
    state.toolbar?.uninit();
    state.urlbarQueries?.destroy();
    state.urlbarCommands?.destroy();
    state.promptKeys?.uninit();
    WindowWorkspaces.uninit(win);
    state.statusBar?.uninit();
    state.tabLine?.uninit();
    state.find.destroy();
    state.stopPdf();
    state.stopOutline();
    state.stopPanes();
    state.listeners.clear();
    states.delete(win);
    windows.delete(win);
  },

  /**
   * What the control socket's `state` reports of the status bar: the mode, the keys of a
   * pending sequence and the workspace's name, as status() has them. Only these, so that the
   * socket's read runs none of the status bar's own bookkeeping (the update segment's timer):
   * `state` changes nothing (security.md S9).
   * @param {BrowserWindow} win
   * @returns {{ mode: Mode, pending: string[], workspace: string | null }}
   */
  socketStatus(win) {
    const state = states.get(win);
    if (!state) return { mode: "insert", pending: [], workspace: null };
    return {
      mode: this._shownMode(state),
      pending: state.dispatcher.pending(),
      workspace: (privateStatus(win) ?? WindowWorkspaces.get(win)?.status())?.name ?? null,
    };
  },

  /**
   * The mode the status bar names: `command` while a `/` or `?` search is typed, the chat
   * window's normal mode while its transcript has focus (docs/specs/builtin-agent.md 14), else
   * the mode keys are dispatched in.
   * @param {WindowState} state
   * @returns {Mode}
   */
  _shownMode(state) {
    return state.find.typing ? "command" : state.agentChat.inNormal ? "normal" : this._mode(state);
  },

  /**
   * What the status bar shows: the mode keys are dispatched in and the keys of a pending
   * sequence (dispatcher.pending() labels); `command` while a `/` or `?` search is typed (Vim's
   * command-line mode), and that search or the page's last one (m1-find); the focused pane's
   * place among two or more (m4-split-panes); the active workspace (m3-workspaces).
   * @param {BrowserWindow} win
   * @returns {{ mode: Mode, pending: string[], find?: FindStatus | null,
   *   pane?: { index: number, count: number } | null, configErrors?: readonly ConfigError[],
   *   configFile?: string, alerts?: readonly string[],
   *   workspace?: { name: string, index: number, color?: string, private?: boolean } | null,
   *   agent?: { waiting: number, minutes: number | null, ran: boolean } | null,
   *   update?: import("../core/updates.mjs").UpdateNotice | null,
   *   element?: import("../core/statusbar.mjs").ElementStatus | null,
   *   hint?: import("../core/statusbar.mjs").HintStatus | null, popups?: string | null,
   *   hover?: import("../core/statusbar.mjs").HoverStatus | null,
   *   pdf?: import("../core/pdf.mjs").PdfState | null,
   *   downloads?: import("../core/downloads.mjs").DownloadSegment | null }}
   */
  status(win) {
    const state = states.get(win);
    if (!state) return { mode: "insert", pending: [] };
    const browser = win.gBrowser?.selectedBrowser;
    return {
      mode: this._shownMode(state),
      pending: state.dispatcher.pending(),
      find: browser ? pdfFindStatus(state.find.status(browser), PdfOps.state(browser)) : null,
      // docs/specs/pdf-mode.md decision 13: `page 3/12` while the selected tab shows a PDF.
      pdf: browser ? PdfOps.state(browser) : null,
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
      // docs/specs/hover.md decision 8: `hover · Settings`.
      hover: HoverOps.status(browser),
      // docs/specs/follow-link-switch.md decision 8: `sd background · sD go there`.
      hint: state.hint
        ? state.hint.hs
          ? hintStatus(state.hint.hs)
          : { action: state.hint.action, label: null }
        : null,
      // docs/specs/popup-blocked.md: `pop-up blocked · y allow · n block · Esc close`.
      popups: popupStatus(win, state.promptKeys?.popupHint() ?? null),
      // docs/specs/downloads.md decision 9: `↓ 42%`, `↓ 3 · 42%`, `↓ paused`.
      downloads: state.downloads.segment(),
    };
  },

  /**
   * What the control socket's `state` reports of `win`'s transient screen (docs/specs/
   * m0-control-protocol-and-vimma-ctl.md, "state"): whether a notice is shown and whether the
   * prompt line is open; the agent chat window's view, how many list rows and transcript entries
   * it draws, and its question slot; the status bar's agent segment, with whether the agent
   * question line shows its keys hint (armed); which `↓` segment the bar draws; whether live
   * grep (its search, preview or jump) and the address bar's suggestion list have more to draw
   * for what was typed; and whether the selected tab's PDF viewer has drawn the pages in view.
   * All of it as drawn, so it says what a screenshot would show; counts, flags and fixed words
   * only, never text, so no page, title, file, query or conversation reaches the socket through
   * them (security.md S9). The chat window never opens in a private window: `null` there.
   * @param {BrowserWindow} win
   * @returns {{ notice: boolean, prompt: boolean,
   *   chat: { view: string, rows: number, entries: number,
   *     question: { armed: boolean } | null } | null,
   *   agent: { waiting: number, ran: boolean, armed: boolean } | null,
   *   downloads: import("../core/downloads.mjs").DownloadSegment["kind"] | null,
   *   grep: { busy: boolean } | null, urlbar: { settled: boolean } | null,
   *   pdf: { drawn: boolean } | null, setup: { screen: string } | null }}
   */
  screen(win) {
    const state = states.get(win);
    if (!state) {
      return {
        notice: false,
        prompt: false,
        chat: null,
        agent: null,
        downloads: null,
        grep: null,
        urlbar: null,
        pdf: null,
        setup: null,
      };
    }
    // As the bar last drew it, not as AgentUi.status() says it will next: the ran dot is
    // dropped at the redraw. Its grant minutes and the built-in agent's budget stay out, as
    // nothing waits on them. `armed` is the line's, as drawn now; the chat window's slot has
    // its own, in `chat.question`.
    const drawn = state.statusBar?.drawnAgent ?? null;
    const agent = drawn ? { ...drawn, armed: state.agentPrompt.hintShown } : null;
    const downloads = state.statusBar?.drawnDownloads ?? null;
    const notice = !!state.notice.el?.matches(":popover-open");
    const prompt = state.rename.isOpen;
    const ui = state.agentChat;
    const log = ui.isOpen ? ui.log : null;
    const count = (/** @type {string} */ cls) =>
      log?.querySelectorAll(`:scope > .${cls}`).length ?? 0;
    const chat = log
      ? {
          view: ui.view,
          rows: count("vimma-agent-chat-row"),
          entries: count("vimma-agent-chat-entry"),
          question: ui.slot.isOpen ? { armed: ui.slot.armed } : null,
        }
      : null;
    const grep = state.grep.drawn();
    const urlbar = state.urlbarQueries?.drawn() ?? null;
    const browser = win.gBrowser?.selectedBrowser;
    const pdf = browser ? PdfOps.drawn(browser) : null;
    // The setup page runs in this process: its screen as draw() last set it (welcome, a step's
    // id, stop), a fixed word, so an e2e scenario waits for the screen it photographs (#1298).
    const page =
      browser?.currentURI?.spec === "about:vimma-setup"
        ? browser.contentDocument?.documentElement?.dataset
        : undefined;
    // A step is named once its view has loaded and its choices are drawn; `loading` before.
    const word = page?.step;
    const ready = word === "welcome" || word === "stop" || page?.viewReady === "true";
    const screen = word && !ready ? "loading" : word;
    // Checked here too: the server sends only a word from the closed list (security.md S9).
    const setup = screen && SETUP_SCREENS.includes(screen) ? { screen } : null;
    return { notice, prompt, chat, agent, downloads, grep, urlbar, pdf, setup };
  },

  /**
   * Whether the user is using `browser`'s page (docs/specs/mcp-drive.md D13): it is shown in the
   * focused window, and that page is in insert or copy mode, in hint mode or in a `/` search,
   * or a key sequence is under way in the window. An agent's keys wait for none of these: they
   * are denied, so an agent never moves a page under the user's cursor while they type in it.
   * @param {MozBrowser} browser XULBrowserElement
   */
  inUse(browser) {
    const state = stateOfBrowser(browser);
    if (!state || Services.focus.activeWindow !== state.win) return false;
    if (!browser.docShellIsActive) return false;
    // The tab's own find bar open (the user's ctrl+f or `/` there): its finder is the agent's.
    const tab = state.win.gBrowser?.getTabForBrowser(browser);
    const findbar = tab && state.win.gBrowser.getCachedFindBar(tab);
    // A page without our actor takes every key itself: in use while shown.
    const mode = this._browserMode(browser);
    return (
      (!!findbar && !findbar.hidden) ||
      (mode !== "normal" && !(mode === "insert" && pageInsert.has(browser))) ||
      state.hint?.browser === browser ||
      state.find.session?.browser === browser ||
      state.dispatcher.pending().length > 0
    );
  },

  /**
   * Whether `browser` is the page with the user's focus, in the focused window: a find there
   * would focus a text field its match is in (docs/specs/mcp-drive.md D11, security.md M16).
   * @param {MozBrowser} browser XULBrowserElement
   */
  isFocusedPage(browser) {
    const state = stateOfBrowser(browser);
    if (!state || Services.focus.activeWindow !== state.win) return false;
    return this._focusedBrowser(state.win) === browser;
  },

  /**
   * Firefox's own shortcuts that are off in `win`, and the chords of `[firefox] disable` that
   * match none (about:vimma; docs/specs/key-handling-batch.md § 1).
   * @param {BrowserWindow} win
   */
  firefoxKeys(win) {
    return states.get(win)?.firefoxKeys?.status() ?? { on: [], off: [], unmatched: [] };
  },

  /**
   * Shows `text` as the window's notice (ConfigHost's `:config` when it cannot create the file).
   * @param {BrowserWindow} win
   * @param {string} text
   * @param {{ untilKey?: boolean }} [options]  as Notice.show's
   * @returns {boolean} whether it is shown
   */
  say(win, text, options) {
    return states.get(win)?.notice.show(text, options) ?? false;
  },

  /**
   * A y/N question in the window's prompt line, for a module with no key context
   * (docs/specs/bookmarks-file.md Behaviour 7). Returns a function that closes it while it is
   * still this question, which then counts as no; null when it could not open.
   * @param {BrowserWindow} win
   * @param {string} question  ends with "y/N"
   * @param {() => void} yes
   * @param {() => void} no
   * @param {{ settleMs?: number }} [options]  keys within `settleMs` of it showing are not an
   *   answer (a `y` typed on the page as a background question appears)
   * @returns {(() => void) | null}
   */
  ask(win, question, yes, no, { settleMs = 0 } = {}) {
    const prompt = states.get(win)?.rename;
    if (!prompt) return null;
    const ours = () => yes();
    if (!prompt.ask(question, ours, no, { settleMs })) return null;
    return () => {
      if (prompt.yes === ours) prompt.close();
    };
  },

  /**
   * Whether the window's prompt line or command line is open, or a page field has the keys
   * (insert mode): a question asked from outside a key waits until none is
   * (docs/specs/bookmarks-file.md Behaviour 7).
   * @param {BrowserWindow} win
   */
  promptBusy(win) {
    const state = states.get(win);
    return (
      !!state && (state.rename.isOpen || state.cmdline.isOpen || this._mode(state) === "insert")
    );
  },

  /** config.toml's keymap, without `:siteunbind`'s keys until restart; the built-in one before. */
  baseKeymap() {
    settings.baseKeymap ??= settings.keymap ?? compileKeymap({}, { mac: MAC });
    return settings.baseKeymap;
  },

  /** `:siteunbind` or `:sitebind` changed the keys until restart: every window's keymap follows. */
  siteUnbindsChanged() {
    this.configure({ siteUnbinds: true });
  },

  /**
   * What config.toml sets (m5-config-load), for every window now and every later one. Each
   * field is optional: absent keeps the current value. A new keymap drops a pending sequence
   * and closes the bindings overlay, which is rebuilt from it.
   * @param {{ keymap?: Keymap, hintChars?: string, sites?: readonly InsertSiteRule[],
   *   configErrors?: readonly ConfigError[], configFile?: string,
   *   firefox?: FirefoxKeySetting, insertEditing?: boolean,
   *   bookmarksRoot?: BookmarksRoot, bookmarklets?: BookmarkletsSetting,
   *   siteUnbinds?: boolean }} next  `siteUnbinds`: `:siteunbind`'s keys changed
   */
  configure(next) {
    // docs/specs/bookmarklets.md B3: config.toml is the only source of this level.
    if (next.bookmarklets) setBookmarkletsSetting(next.bookmarklets);
    // `[bookmarks] root` (docs/specs/bookmarks.md): an open panel re-reads at the new root.
    const rootChanged = !!next.bookmarksRoot && next.bookmarksRoot !== bookmarksRoot();
    if (next.bookmarksRoot) setBookmarksRoot(next.bookmarksRoot);
    if (next.hintChars !== undefined) settings.hintChars = next.hintChars;
    if (next.insertEditing !== undefined) settings.insertEditing = next.insertEditing;
    if (next.firefox) settings.firefox = next.firefox;
    if (next.sites) settings.sites = next.sites;
    if (next.configErrors) settings.configErrors = next.configErrors;
    if (next.configFile) settings.configFile = next.configFile;
    const base = next.keymap && next.keymap !== settings.baseKeymap ? next.keymap : null;
    if (base) settings.baseKeymap = base;
    // The keys `:siteunbind` gave until restart stay through a reload of config.toml, but for
    // a key the new file made the prefix (withSiteUnbinds leaves it out) or now saves for the
    // same table: those end, so a key is never listed as both.
    if (base) {
      for (const [table, keys] of TemporarySiteUnbinds.entries()) {
        const saved = base.siteKeys(table);
        const gone = keys.filter((k) => !base.siteKey(k).ok || saved.includes(k));
        if (gone.length) TemporarySiteUnbinds.remove(table, gone);
      }
    }
    const keymap =
      base || next.siteUnbinds
        ? withSiteUnbinds(this.baseKeymap(), TemporarySiteUnbinds.entries())
        : null;
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
      // An open agent window names a refused config.toml in place of "no model set up".
      if (next.configErrors) state.agentChat.render();
      this._emit(state);
    }
  },

  /**
   * Calls `fn` after anything that may change `status(win)`. Cheap to call often: listeners
   * debounce. Whatever changes the mode (focus detection, a content actor) calls `_emit`.
   * @param {BrowserWindow} win
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
   * @param {MozBrowser} browser
   * @param {{ descriptor: EditableDescriptor, trigger: InsertTrigger,
   *   frame?: CanonicalBrowsingContext,
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
    // Whose insert this is (D13): the user's when their input caused the focus or came shortly
    // before it, or when they already made a field of this document theirs; once theirs it
    // stays theirs while the page moves focus about. Else it is the page's own, which does not
    // make the tab in use.
    const doc = topWindowId(browser);
    const byPage =
      next === "insert" &&
      !user &&
      !recentUserInput(browser) &&
      userInsertDoc.get(browser) !== doc &&
      (mode !== "insert" || pageInsert.has(browser));
    // The user's click out of a field ends their insert; the page's own blur does not.
    if (user && next !== "insert") userInsertDoc.delete(browser);
    setBrowserMode(browser, next === "insert" ? "insert" : "normal");
    if (byPage) pageInsert.add(browser);
    else if (next === "insert") userInsertDoc.set(browser, doc);
  },

  /**
   * The user clicked in the focused frame of `browser` (VimmaParent) where no focus report
   * says so: it ends the hold of Esc (insert-focus behaviour 6).
   * @param {MozBrowser} browser
   */
  onUserClick(browser) {
    escapeHold.delete(browser);
    noteUserInput(browser);
  },

  /**
   * The user put text into the focused frame of `browser` without a key the window saw as one
   * (VimmaParent's Vimma:UserInput: an IME's composition, a drop, typed or pasted text): a field
   * the page focused is theirs (mcp-drive D13).
   * @param {MozBrowser} browser
   */
  onUserInput(browser) {
    noteUserInput(browser);
  },

  /**
   * Tests only: forgets when the user last gave `browser`'s page input, as a pause of more than
   * USER_INPUT_RECENT_MS would.
   * @param {MozBrowser} browser
   */
  _forgetUserInputTimeForTests(browser) {
    // Automation only (Cu.isInAutomation, read as restart.mjs does): a release never forgets
    // the user's input early.
    const inAutomation =
      /** @type {{ Cu?: { isInAutomation?: unknown } }} */ (globalThis).Cu?.isInAutomation === true;
    if (inAutomation) lastUserInput.delete(browser);
  },

  /**
   * The user selected text with the mouse in the focused frame of `browser` (VimmaParent):
   * normal mode enters copy mode with that selection, so `y` copies it and motions extend it.
   * Insert mode keeps it (a text field's selection is its own).
   * @param {MozTabBrowser} browser
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
   * @type {(browser: MozBrowser, mode: PageMode) => void}
   */
  onModeChange: (browser, mode) => {
    const state = stateOfBrowser(browser);
    // A text field took focus (the page's script, a click): its keys are the field's, so a
    // focused block's ELEMENT mode ends, as copy mode does.
    if (state && mode === "insert" && state.element.browser === browser) state.element.leave();
    if (state) VimmaHost._emit(state);
    // Into a field: the agent question goes back to waiting (vimma-mcp decision 14), and so
    // does the update question.
    if (state) AgentUi.onFocusChange(state.win);
    if (state) UpdateUi.onFocusChange(state.win);
  },

  /**
   * The page mode keys get while `browser` has focus. A page without our actor (extension
   * pages, data:, blob:) stays in insert, as every page was before M1.
   * @param {MozBrowser} browser
   * @returns {PageMode}
   */
  _browserMode(browser) {
    if (!VimmaActors.has(browser)) return "insert";
    return browserModes.get(browser) ?? "normal";
  },

  /**
   * The content <browser> that has focus, or null when focus is in chrome (URL bar, find bar).
   * @param {BrowserWindow} win
   * @returns {MozBrowser | null}
   */
  _focusedBrowser(win) {
    const el = win.document.activeElement;
    return el && isBrowser(el) ? el : null;
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
    if (state.permissionPicker.isOpen) return "help";
    if (state.popups.isOpen || state.downloadPicker.isOpen) return "help";
    if (state.splitPicker.isOpen || state.bookmarkPicker.isOpen) return "help";
    // Only while its input has focus: a dialog that opens over the line keeps it open behind,
    // and the dialog's keys (Esc) are its own, not the line's `command.cancel` (#1304).
    if (state.cmdline.focused) return "command";
    // A prompt over a panel (the bookmarks' add, rename, a y/N) types: keys are its input's.
    if (state.rename.isOpen) return "insert";
    if (state.outline.isActive) return "index";
    if (state.panel.isOpen || state.bookmarks.isOpen) return "panel";
    // Only while the window shows two panes: the flag itself is cleared where the panes go
    // (window-state.mjs stopPanes), never here, so reading the mode changes nothing (S9).
    if (state.resize && hasPanes(state.win)) return "resize";
    // gb's labels (docs/specs/tab-line.md decision 12): the badge, and the questions stand back.
    if (state.tabLabels) return "hint";
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
    return state.win.gBrowser?.selectedBrowser ?? null;
  },

  /**
   * The focused content <browser> when it has our actor, else null. The actor is only in the
   * `browsers` message manager group (VimmaActors.init), so that is a tab's <browser>.
   * @param {WindowState} state
   * @returns {MozTabBrowser | null}
   */
  _contentBrowser(state) {
    const browser = this._focusedBrowser(state.win);
    return browser && VimmaActors.has(browser) ? /** @type {MozTabBrowser} */ (browser) : null;
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
   * @param {BrowserWindow} win
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   */
  _onKeyDown(win, state, e) {
    // A key the page has had, back for chrome's shortcuts (requestReplyFromRemoteContent): it
    // was dispatched once already, before the page.
    if (/** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent) return;
    // An Enter or arrow key Vimma pressed itself (enter-key.mjs) is the page's.
    if (pressingKey()) return;
    // A notice shown until the next key goes on any key but a bare modifier, before the key's
    // own action can show another (docs/specs/multiple-splits.md, decision 4).
    if (chordFromEvent(e)) state.notice.keyPressed();
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
    // The built-in agent's window, while focus is in it and no sequence (ctrl+b …) is under way.
    if (state.dispatcher.pending().length === 0 && state.agentChat.onKey(e)) {
      this._emit(state);
      return;
    }
    const chord = chordFromEvent(e);
    if (!chord) {
      // A bare modifier, or a key with no name Vimma binds: an IME's ("Process", keyCode 229),
      // a dead key's, or one the layout leaves unidentified. Those are the user typing into the
      // page (mcp-drive D13); a bare modifier is not, so ctrl+b shift+a stays watching.
      const browser = this._focusedBrowser(win);
      if (browser && (TEXT_KEYS.has(e.key) || e.isComposing)) noteUserInput(browser);
      return;
    }
    // Another key after Tab: an outline still on its way opens nothing.
    dropOutlineAsk(state);
    const key = formatKey(chord);
    state.pageFirst.keydown();
    // Focus left the page the hints are on (URL bar, another pane): they no longer apply.
    if (state.hint && state.hint.browser !== this._focusedBrowser(win)) this._cancelHints(state);
    if (state.element.browser && state.element.browser !== this._focusedBrowser(win)) {
      state.element.leave();
    }
    // The setup page draws its own j/k/space/enter/esc (first-run-setup behaviour 3): the scroll,
    // hint and mode bindings would take them first. Chords with a modifier stay ours, except
    // while its prefix step waits for a key (setup-v2 decision 21): then every chord, the prefix
    // included, is the key being chosen, and none is kept in the recent keys below. The page
    // runs in this process, and only its own script sets `recording`.
    const setupPage = this._focusedBrowser(win);
    if (setupPage?.currentURI?.spec === "about:vimma-setup") {
      if (!chord.ctrl && !chord.alt && !chord.meta) return;
      if (setupPage.contentDocument?.documentElement?.dataset.recording === "true") return;
    }
    const mode = this._mode(state);
    // Keys typed in a private window are never kept (private-workspace decision 8b), nor those
    // typed in a password field, such as the built-in agent's API key (security.md M46).
    const secret = isPasswordField(e.target);
    if (!state.private && !secret) {
      this._lastChords.push(key);
      if (this._lastChords.length > MAX_RECORDED) this._lastChords.shift();
    }
    if (!secret && Services.prefs.getBoolPref(DEBUG_PREF, false)) {
      const mods = MODIFIERS.filter((m) => chord[m]);
      console.debug("vimma key", { key, mods, mode });
    }
    // gb's labels take every key: a label's next character, else the key only cancels
    // (docs/specs/tab-line.md decision 12).
    if (state.tabLabels) {
      consume(e);
      this._tabLabelKey(state, chord);
      this._emit(state);
      return;
    }
    // A picker takes every key, bare ones too, before any binding: nothing reaches the page or
    // Firefox underneath (ctrl+w would close a tab), and its j / q are not keymap keys.
    const picker = [
      state.picker,
      state.wsPicker,
      state.addonPicker,
      state.permissionPicker,
      state.popups,
      state.splitPicker,
      state.bookmarkPicker,
      state.downloadPicker,
      state.mcpLog,
      state.grep,
    ].find((p) => p.isOpen);
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
    const filtering =
      state.help.filterFocused || state.bookmarks.filterFocused || state.outline.filterFocused;
    if (typing && filtering && state.dispatcher.pending().length === 0) return;
    this._dispatch(win, state, e, mode, chord);
    // A key the page gets after Esc is the user acting on the page again: what the page
    // focuses in answer (Tab into a frame, a shortcut that opens its search box) is the user's
    // focus, though it may reach a frame whose process handles no input (insert-focus 6).
    // It is also the user using the page (mcp-drive D13): typing in a field the page focused
    // makes that insert theirs, and a field the page focuses soon after is theirs to type in, not
    // an agent's to fill. Vimma's own keys are not (a scroll, the keys that open and answer the
    // agent's question), so the user can watch the agent and answer it.
    if (!e.defaultPrevented) {
      const browser = this._focusedBrowser(win);
      if (browser) escapeHold.delete(browser);
      if (browser) noteUserInput(browser);
    }
    this._emit(state);
  },

  /**
   * @param {BrowserWindow} win
   * @param {WindowState} state
   * @param {KeyboardEvent} e
   * @param {Mode} mode
   * @param {Chord} chord
   */
  _dispatch(win, state, e, mode, chord) {
    const first = state.dispatcher.pending().length === 0;
    this._clearTimer(win, state);
    // The PDF viewer's bindings while its tab is selected (ADR-024): the parent's own view.
    const context = PdfOps.context(win.gBrowser?.selectedBrowser);
    const site = pageSite(state.keymap, this._focusedBrowser(win));
    const result = state.dispatcher.dispatch(mode, chord, context, site);
    // about:vimma's last keys; never a private window's (private-workspace decision 8b).
    if (!("replay" in result) && !state.private) KeyLog.record(mode, chord, result);
    // The overlay is modal: in help mode every key is ours, handled or not, so nothing reaches
    // the browser underneath (ctrl+w would close the tab behind it). Hint mode too: every key
    // is a label key or ignored, never the page's. Resize mode too (ADR-014), and the side panel.
    const modal =
      mode === "help" ||
      mode === "hint" ||
      mode === "resize" ||
      mode === "panel" ||
      mode === "index";
    switch (result.kind) {
      case "pass":
        // A key the site keeps is not Vimma's text-field key either (site-unbind decision 9).
        if (!state.keymap.unbinds(site, formatKey(chord)) && this._editKey(state, e, mode, chord)) {
          return;
        }
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
        const node =
          first && !modal && state.keymap.trie(mode, context, site).children.get(formatKey(chord));
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
        // A suggestion key with no page focused (docs/specs/page-suggestions.md, issue #1261):
        // the address bar's results while they show; otherwise the chord is as if unbound
        // there, so the field keeps its own keys: its [keys] binding, Vim's text-field key
        // (ctrl+j is Enter) or the field's own (Cocoa's ctrl+k on macOS).
        let run = result;
        if (isSuggestionAction(result.action.id) && !this._contentBrowser(state)) {
          if (this._urlbarStep(state, result.action.id)) {
            consume(e);
            return;
          }
          const fallback = first ? state.keymap.fallback(mode, formatKey(chord)) : null;
          if (!fallback) {
            if (!first) consume(e);
            else this._editKey(state, e, mode, chord);
            return;
          }
          run = { kind: "action", action: { ...fallback, count: result.action.count } };
          if (!this._runnable(state, run.action.id)) return;
        }
        // Firefox let the page have this chord first: so does Vimma (firefox-keys decision 6).
        // The keydown goes on; the keypress after the page runs the action (_onKeyPress).
        if (first && !modal && this._pageFirstAction(state, chord, mode, run.action.id)) {
          state.pageFirst.defer(formatKey(chord), run, mode);
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
        // A suggestion key that does not wait for the page: the second key of a sequence.
        if (isSuggestionAction(run.action.id)) {
          // A key that picks or moves in the page's suggestions is the user using the page,
          // though Vimma keeps it (mcp-drive D13).
          const focused = this._focusedBrowser(win);
          if (focused) noteUserInput(focused);
          this._suggest(state, run.action, first ? formatKey(chord) : null, mode);
          return;
        }
        this._run(state, run);
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
    const win = state.win;
    let keyboardLock = false;
    try {
      keyboardLock = (win.document.fullscreenKeyboardLock ?? "none") !== "none";
    } catch {
      // Not in this build: no Keyboard Lock.
    }
    if (!pageFirst(key, { fullScreen: !!win.fullScreen, keyboardLock, mode, mac: MAC })) {
      return false;
    }
    if (keyboardLock) return true;
    return !this._shortcutsBlocked(state);
  },

  /**
   * `_pageFirst`, and the suggestion keys in a page: they always wait for it, because a web app
   * may move its own list on ctrl+n (docs/specs/page-suggestions.md decision 3).
   * @param {WindowState} state
   * @param {Chord} chord
   * @param {Mode} mode
   * @param {string} id  the action the chord runs
   */
  _pageFirstAction(state, chord, mode, id) {
    if (isSuggestionAction(id) && this._contentBrowser(state)) return true;
    return this._pageFirst(state, chord, mode);
  },

  /**
   * A suggestion key (docs/specs/page-suggestions.md): ArrowDown or ArrowUp in the focused
   * page's open suggestion list; with none open, or no page focused (a chrome field), the
   * chord's [keys] binding in `mode`, if any. The page already had the key, so the fallback
   * runs straight away (decision 6).
   * @param {WindowState} state
   * @param {Action} action
   * @param {string | null} key  the chord pressed, or null when not run from a key
   * @param {Mode} [mode]
   * @param {EventTarget | null} [target]  where the key went
   */
  async _suggest(state, action, key, mode = "insert", target = null) {
    const browser = this._contentBrowser(state);
    // Esc while the page's reply or the frame's answer is on its way: nothing more happens.
    const sameMode = () => this._mode(state) === mode;
    // A late reply (a busy page) must not press a key in, or run the fallback for, the tab or
    // pane focused since (docs/security/13-page-modes.md K6).
    if (browser && target && target !== browser) return;
    // The frame asked: the Enter fallback goes only there, never to a frame the page focused
    // while it answered (docs/security/13-page-modes.md K5).
    const asked = Services.focus.focusedContentBrowsingContext;
    if (browser && (await VimmaActors.suggestion(browser, action.id, sameMode))) return;
    if (browser && this._contentBrowser(state) !== browser) return;
    if (!sameMode() || !key || state.win.closed) return;
    const fallback = state.keymap.fallback(mode, key);
    if (fallback) {
      this._run(state, { kind: "action", action: { ...fallback, count: action.count } });
      this._emit(state);
      return;
    }
    // No binding of its own outside a list: Vim's text-field key on the chord, as when no
    // suggestion key is bound to it (ctrl+j is Enter, issue #1261). The page has had the key.
    const chord = parseKey(key);
    const command = browser && mode === "insert" ? this._editCommand(state, chord) : null;
    if (!command || state.keymap.unbinds(pageSite(state.keymap, browser), key)) return;
    VimmaActors.edit(
      /** @type {MozTabBrowser} */ (browser),
      command,
      () => sameMode() && Services.focus.focusedContentBrowsingContext === asked,
    );
  },

  /**
   * A suggestion key in the address bar while its results show (issue #1261): ArrowDown or
   * ArrowUp pressed in it, which moves the selected row as the arrow keys do, including the
   * one-off search buttons. Firefox's own ctrl+n and ctrl+p there are macOS-only
   * (UrlbarChildController, handleKeyNavigation, Firefox 160); this gives every platform all
   * four keys. Returns whether it pressed one.
   * @param {WindowState} state
   * @param {string} id  page.suggestion_next or page.suggestion_prev
   */
  _urlbarStep(state, id) {
    const win = state.win;
    const bar = /** @type {UrlbarInput | null} */ (win.document.getElementById("urlbar"));
    const field = focusedChromeField(win);
    if (!bar?.focused || !field || !bar.contains(field) || !bar.view?.isOpen) return false;
    const step = suggestionStep(id, true);
    if (step.kind !== "press") return false;
    pressKeyLater(win, step.key, () => focusedChromeField(win) === field && bar.view.isOpen);
    return true;
  },

  /**
   * The focused page's site blocks "Override keyboard shortcuts" (Firefox's
   * nsContentUtils::ShouldBlockReservedKeys): its keys are Vimma's first.
   * @param {WindowState} state
   */
  _shortcutsBlocked(state) {
    const principal = this._focusedBrowser(state.win)?.contentPrincipal;
    if (!principal) return false;
    try {
      const perms = Services.perms;
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
    if (!state.pageFirst.size || pressingKey()) return;
    const chord = chordFromEvent(e);
    const key = chord && formatKey(chord);
    const ev = /** @type {ChromeKeyEvent} */ (e);
    if (ev.isReplyEventFromRemoteContent) {
      // A chord with a native shortcut in Firefox's root key listener (cmd_redo on ctrl+shift+z,
      // ShortcutKeyDefinitions.cpp) never reaches `_onKeyPress` before the page:
      // GlobalKeyListener::HandleEventOnCaptureInSystemEventGroup stops it and waits for this
      // reply itself, so its entry is still unpressed here.
      const pending = key && state.pageFirst.reply(key, e.timeStamp);
      if (!pending || this._pageTookKey(e, pending)) return;
      consume(e);
      this._runAfterPage(state, key, pending, e.target);
      this._emit(state);
      return;
    }
    // A page that cannot take input yet (its process is still starting) is sent no key:
    // EventStateManager::PostHandleKeyboardEvent dispatches the keypress at the <browser> again
    // instead, and no reply comes. `press` settles it as a key that stayed in this process:
    // `_onKeyPressAfter` runs it unless something calls preventDefault.
    if (!key) return;
    if (state.pageFirst.press(key, e.timeStamp, isRemoteBrowserTarget(e.target))) {
      e.stopPropagation();
      ev.requestReplyFromRemoteContent();
      if (MAC && this._suggestionKeySent(state, key, e.timeStamp)) ev.preventMultipleActions();
    }
  },

  /**
   * Whether the keypress on its way to a remote page is a suggestion key's. On macOS such a
   * keypress is marked for the page's process (Event.webidl's preventMultipleActions: the default
   * is not prevented, but only one handler acts on the event; the flags go to the page's process
   * with the event, widget/nsGUIEventIPC.h, ParamTraits<BaseEventFlags>), because Cocoa binds
   * ctrl+n and ctrl+p to moveDown: and moveUp: in a text field
   * (widget/cocoa/NativeKeyBindings.mm, Firefox 160): the field runs them on the keypress and
   * prevents its default, so the reply would say the page took the key, with or without a
   * list. VimmaChild keeps a marked keypress from the field while its suggestion list is open;
   * with none open the field keeps its key (docs/specs/page-suggestions.md, Behaviour 3).
   *
   * The flag is free for this on a keypress: in Firefox 160 its only reader that sees one is a
   * link's activation on Enter (Element::CheckHandleEventForLinksPrecondition, dom/base/
   * Element.cpp), its other readers are mouse, touch and menu code, and no Firefox script sets it
   * on a key. To check again at a Firefox bump.
   *
   * Not marked, so the field's as before: a page in the parent process, whose keypress is not
   * sent anywhere (stopping it before the field would stop `_onKeyPressAfter` too), and a chord
   * whose keypress Firefox's root key listener holds back before `_onKeyPress` sees it.
   * @param {WindowState} state
   * @param {string} key
   * @param {number} stamp  the keypress's timeStamp
   */
  _suggestionKeySent(state, key, stamp) {
    const result = state.pageFirst.sent(key, stamp)?.result;
    return result?.kind === "action" && isSuggestionAction(result.action.id);
  },

  /**
   * Whether a remote page took a page-first key, from its reply event. Page script counts
   * (defaultPreventedByContent). A native handler in the content process counts only when a field
   * has focus (insert mode): the content's root key listener walks ShortcutKeyDefinitions.cpp's
   * sBrowserHandlers even with nothing focused, and KeyEventHandler::DispatchXBLCommand calls
   * PreventDefault before it looks for a controller, so ctrl+shift+z (cmd_redo) comes back
   * prevented by chrome on every plain page.
   * @param {KeyboardEvent} e
   * @param {{ mode: Mode }} pending
   */
  _pageTookKey(e, pending) {
    if (!e.defaultPrevented) return false;
    if (/** @type {ChromeKeyEvent} */ (e).defaultPreventedByContent) return true;
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
    const pending = key && state.pageFirst.settle(key);
    if (e.defaultPrevented || !pending) return;
    e.preventDefault();
    this._runAfterPage(state, key, pending);
    this._emit(state);
  },

  /**
   * Runs a page-first binding the page left alone. Esc in normal mode first takes the page's
   * focus away (escape.mjs `blur`), so a link or button that Tab focused loses its focus ring;
   * a page that takes Esc itself (a menu closing) keeps its focus.
   * @param {WindowState} state
   * @param {string} key
   * @param {{ result: DispatchResult, mode: Mode }} pending
   * @param {EventTarget | null} [target]  the keypress's target: for a remote page's reply, the
   *   <browser> the key went to (BrowserParent::RecvReplyKeyEvent)
   */
  _runAfterPage(state, key, pending, target = null) {
    const hovering = HoverOps.held(state.win.gBrowser?.selectedBrowser);
    const escape = key === "esc" ? resolveEscape({ mode: pending.mode, hovering }) : null;
    if (escape?.kind === "action" && escape.blur) {
      const browser = this._focusedBrowser(state.win);
      if (browser) blurPage(browser);
    }
    // A held hover ends before the page stops: the next Esc stops it (hover.md decision 5).
    if (
      escape?.kind === "action" &&
      escape.action.id === "hover.release" &&
      pending.result.kind === "action" &&
      pending.result.action.id === "page.stop"
    ) {
      this._run(state, { kind: "action", action: { id: "hover.release" } });
      return;
    }
    const { result } = pending;
    if (
      result.kind === "action" &&
      isSuggestionAction(result.action.id) &&
      RUNNABLE.has(result.action.id)
    ) {
      this._suggest(state, result.action, key, pending.mode, target);
      return;
    }
    this._run(state, pending.result);
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
    if (browser.isRemoteBrowser) {
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
    // Chrome left the key alone: it goes on to the focused remote page (insert-focus
    // behaviour 8). Not a reply, which the page has had already.
    const keyBrowser = this._focusedBrowser(state.win);
    if (
      keyBrowser?.isRemoteBrowser &&
      !(/** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent) &&
      !(/** @type {ChromeKeyEvent} */ (e).defaultPreventedByChrome)
    ) {
      VimmaActors.keySent(keyBrowser);
    }
    const ours =
      /** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent || editAfterPage.has(e);
    if (!ours || e.defaultPrevented) return;
    const chord = chordFromEvent(e);
    const command = chord && this._editCommand(state, chord);
    const browser = this._contentBrowser(state);
    if (!command || !browser || this._mode(state) !== "insert") return;
    // The reply Firefox asks for its own (disabled) key on the chord comes here too: a key the
    // site keeps is the page's whatever brought it back (site-unbind decision 9).
    const site = pageSite(state.keymap, browser);
    if (state.keymap.unbinds(site, formatKey(chord))) return;
    // A chord bound in insert mode runs its binding, not the text-field key: ctrl+j's Enter
    // outside a suggestion list comes from `_suggest` (issue #1261), never a second time here.
    if (state.keymap.trie("insert", "page", site).children.get(formatKey(chord))?.action) return;
    // A late reply (a busy page) must not edit, or press Enter in, the tab or pane focused since:
    // Firefox dispatches it on the <browser> the key went to (BrowserParent::RecvReplyKeyEvent).
    const remote = /** @type {ChromeKeyEvent} */ (e).isReplyEventFromRemoteContent;
    if (remote && e.target !== browser) return;
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
    if (PENDING_ACTIONS.includes(action.id) && !(action.id in RUNNERS)) {
      state.notice.show(`:${command}${text ? ` ${text}` : ""}: not available yet`);
      return;
    }
    this._run(state, { kind: "action", action }, text);
  },

  /**
   * Test-only: a window's state.
   * @param {BrowserWindow} win
   */
  _state(win) {
    return states.get(win);
  },

  /**
   * Test-only: the window's hint mode, or null.
   * @param {BrowserWindow} win
   */
  _hints(win) {
    const hint = states.get(win)?.hint;
    if (!hint) return null;
    return { action: hint.action, typed: hint.hs?.typed ?? "", hints: hint.hs?.hints ?? [] };
  },

  /**
   * Test-only: the window's focused text block, or null.
   * @param {BrowserWindow} win
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
   * @param {CanonicalBrowsingContext} bc
   * @param {WindowGlobalParent} wg
   * @param {unknown} gen
   */
  onBlockReport(what, bc, wg, gen) {
    for (const win of windows) states.get(win)?.element.onReport(what, bc, wg, gen);
  },

  /**
   * The user's hover ended in a frame by itself (Vimma:HoverEnded, docs/specs/hover.md).
   * @param {WindowGlobalParent} wg  the frame's document
   */
  onHoverEnded(wg) {
    HoverOps.onEnded(wg);
  },

  /**
   * A frame's document went away (VimmaParent): element focus in it ends.
   * @param {WindowGlobalParent} wg  its WindowGlobalParent
   */
  onFrameGone(wg) {
    HoverOps.onEnded(wg);
    for (const win of windows) states.get(win)?.element.onFrameGone(wg);
  },

  /**
   * `f` / `gF` / `F`: collects the targets, then enters hint mode with a label on each. With none,
   * the tab stays in normal (the status bar will say so, M2).
   * @param {MozBrowser} browser
   * @param {Pick<Action, "id">} action
   * @param {{ restart?: boolean, buffered?: Chord[] }} [options]  `restart`: a wheel moved the
   *   targets under the labels, which are collected again; `buffered`: keys for the new labels
   */
  _startHints(browser, action, { restart = false, buffered = [] } = {}) {
    const state = stateOfBrowser(browser);
    if (!state) return;
    // A restart after a wheel stays in hint mode: the status bar never shows normal between.
    this._cancelHints(state, { emit: !restart });
    state.element.leave();
    const id = /** @type {HintAction} */ (action.id);
    // pdf.js draws lines, not paragraphs: copy mode is the way to copy there (decision 14).
    if (id === "hint.element" && browser.documentContentType === "application/pdf") {
      state.notice.show(NO_BLOCKS_PDF);
      return;
    }
    /** @type {HintSession} */
    const session = { browser, action: id, hs: null, buffered };
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
        this._emit(state); // the status bar's hint segment names a label now
        // A wheel while collecting may have moved the targets: the labels wait for its check.
        if (session.wheelAt) {
          this._wheelCheck(state, session, session.wheelAt);
          return;
        }
        state.hintOverlay.show(browser, session.hs.hints, hintLabelCase(id));
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
   * A wheel over the page while hints are up (issues #1308, #1337): the labels were drawn for
   * the layout before it. They are hidden, and the page says, once the scroll the wheel
   * started has ended, whether their targets moved (_wheelCheck). A wheel while the labels are
   * still being collected is kept for when they arrive. Further wheels meanwhile change
   * nothing: the page waits for the last scroll's end. The wheel's target in chrome is the
   * <browser> only for a remote page; over a page in the parent process (about: pages without
   * hints) it is an element inside it, and nothing happens.
   * @param {WindowState} state
   * @param {WheelEvent} e
   */
  _hintsScrolled(state, e) {
    const session = state.hint;
    if (!session || session.wheel || session.wheelAt || e.target !== session.browser) return;
    const { browser } = session;
    // The wheel's point in the page's CSS pixels, as the labels' rects are.
    const box = browser.getBoundingClientRect();
    const zoom = Number(browser.fullZoom) || 1;
    const point = { x: (e.clientX - box.left) / zoom, y: (e.clientY - box.top) / zoom };
    if (session.hs) this._wheelCheck(state, session, point);
    else session.wheelAt = point;
  },

  /**
   * Hides the session's labels and asks the page whether a wheel at `point` moved their
   * targets. If they moved, the labels are collected and drawn again where the scroll ended,
   * and the keys typed toward the old ones are dropped with them, also those typed while the
   * labels were hidden: they were aimed from memory at labels that now name other targets
   * (only `Esc` is kept). If nothing moved (the page's end, or a page that takes the wheel
   * itself, such as a map), the same labels come back with the keys typed so far, then those
   * typed meanwhile.
   * @param {WindowState} state
   * @param {HintSession} session  with its labels collected
   * @param {{ x: number, y: number }} point
   */
  _wheelCheck(state, session, point) {
    const hs = session.hs;
    const gen = hs?.hints[0]?.target.gen;
    delete session.wheelAt;
    if (!hs || gen === undefined) return;
    const { browser } = session;
    session.wheel = true;
    state.hintOverlay.hide();
    VimmaActors.hintsMoved(browser, gen, point)
      .then((moved) => {
        if (state.hint !== session) return;
        this._hintWheels++;
        if (moved) {
          const buffered = session.buffered.filter((c) => c.key === "esc");
          this._startHints(browser, { id: session.action }, { restart: true, buffered });
          return;
        }
        // Keys are buffered while `wheel`, so `hs` is still the session's.
        session.wheel = false;
        state.hintOverlay.show(browser, hs.hints, hintLabelCase(session.action));
        state.hintOverlay.filter(hs.typed);
        for (const chord of session.buffered.splice(0)) {
          if (state.hint !== session) break;
          this._hintKey(state, chord);
        }
      })
      .catch((err) => {
        console.error("vimma: hints after a wheel failed", err);
        if (state.hint === session) this._cancelHints(state);
      });
  },

  /**
   * One key in hint mode (core hintKey): narrow, follow, or nothing.
   * @param {WindowState} state
   * @param {Chord} chord
   */
  _hintKey(state, chord) {
    const session = state.hint;
    if (!session) return;
    if (!session.hs || session.wheel) {
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
        this._emit(state); // the hint segment names the first label left
        return;
      case "select":
        this._cancelHints(state);
        if (result.action === "hint.element") {
          // Never followed: the block is focused in its frame and outlined in chrome, where
          // the page sees nothing (element-focus decision 5).
          if (result.target.kind === "block") state.element.start(session.browser, result.target);
          return;
        }
        if (result.action === "hint.hover") {
          // docs/specs/hover.md: the page shows its hover state; normal mode stays (decision 7).
          HoverOps.hover(session.browser, result.target).catch((e) =>
            console.error("vimma: hover failed", e),
          );
          return;
        }
        if (result.action === "hint.show_target" || result.action === "hint.copy_target") {
          this._linkTarget(state, session.browser, result.target, result.action);
          return;
        }
        if (result.action === "hint.follow_new_tab" || result.action === "hint.follow_new_tab_fg") {
          // docs/specs/follow-link-switch.md: an upper-case last key, or the switching action.
          VimmaActors.openInNewTab(session.browser, result.target, { background: !result.switch });
        } else {
          VimmaActors.activateHint(result.target);
        }
    }
  },

  /**
   * `F` and `c` in the PDF viewer (docs/specs/pdf-mode.md decision 16): a link's target shown or
   * copied as text, never followed. An internal link of the PDF is shown as the page it goes to,
   * which the viewer resolves; its URL, with the fragment that reopens that place, is what `c`
   * copies.
   * @param {WindowState} state
   * @param {MozBrowser} browser
   * @param {HintTarget} target
   * @param {"hint.show_target" | "hint.copy_target"} action
   */
  async _linkTarget(state, browser, target, action) {
    // From the content process (bounded by parseHintReply): shown and copied as text only, with
    // no control or format characters (docs/security/20-pdf-viewer.md section 20, V8).
    // A URL as the URL parser writes it, so a content process cannot put free text there.
    const href = URL.parse(stripInvisible(target.href ?? ""))?.href ?? "";
    if (!href) return;
    if (action === "hint.copy_target") {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(href);
      state.notice.show(`yanked ${href}`);
      return;
    }
    const here = browser.currentURI?.specIgnoringRef;
    const own = !!here && href.startsWith(`${here}#`);
    const page = own ? await PdfOps.linkPage(browser, target) : 0;
    // The answer can come after the user has gone to another tab or pressed another key.
    if (state.hint || browser !== state.win.gBrowser?.selectedBrowser) return;
    state.notice.show(page ? `page ${page}` : href);
  },

  /**
   * `gb` (docs/specs/tab-line.md decisions 12 to 15): with a count, that tab at once; else a
   * label on every tab in the tab line, which shows meanwhile even when it is off.
   * @param {WindowState} state
   * @param {Action} action
   */
  _tabLineHint(state, action) {
    if (action.count !== undefined) {
      const n = action.count;
      const refused = tabCountRefusal(n, selectableTabs(state.win).length);
      if (refused) state.notice.show(refused);
      else this._goToTab(state, () => selectTab(state.win, { id: "tab.goto", arg: n }));
      return;
    }
    const ids = state.tabLine?.tabIds() ?? [];
    if (!ids.length) return;
    state.tabLabels = startTabLabels(ids, settings.hintChars ?? DEFAULT_HINT_CHARS);
    state.tabLine?.schedule();
    this._emit(state);
  },

  /**
   * One key while gb's labels show (core tabLabelKey).
   * @param {WindowState} state
   * @param {Chord} chord
   */
  _tabLabelKey(state, chord) {
    if (!state.tabLabels) return;
    const { state: next, result } = tabLabelKey(state.tabLabels, chord);
    if (result.kind === "narrow") {
      state.tabLabels = next;
      state.tabLine?.schedule();
      return;
    }
    this._cancelTabLabels(state);
    if (result.kind === "select") {
      const tab = tabById(state.win, result.tabId);
      if (tab) this._goToTab(state, () => (state.win.gBrowser.selectedTab = tab));
    }
  },

  /**
   * Selects a tab and has the status bar say its place, the one thing a screen reader hears of
   * a gb jump (docs/specs/tab-line.md decision 18).
   * @param {WindowState} state
   * @param {() => void} select
   */
  _goToTab(state, select) {
    const gBrowser = state.win.gBrowser;
    const before = gBrowser.selectedTab;
    select();
    if (gBrowser.selectedTab === before) return;
    const tabs = selectableTabs(state.win);
    state.statusBar?.say(`tab ${tabs.indexOf(gBrowser.selectedTab) + 1} of ${tabs.length}`);
  },

  /**
   * Removes gb's labels, if any.
   * @param {WindowState} state
   */
  _cancelTabLabels(state) {
    if (!state.tabLabels) return;
    state.tabLabels = null;
    state.tabLine?.schedule();
    this._emit(state);
  },

  /**
   * Leaves hint mode, if on: removes the labels and drops a collection in flight.
   * @param {WindowState} state
   * @param {{ emit?: boolean }} [options]  `emit: false` when hint mode starts again at once
   */
  _cancelHints(state, { emit = true } = {}) {
    this._cancelTabLabels(state);
    if (!state.hint) return;
    state.hint = null;
    state.hintOverlay.hide();
    if (emit) this._emit(state); // the status bar leaves HINT, also when no key ended hint mode
    VimmaActors.cancelHints(state.win);
  },

  /**
   * @param {BrowserWindow} win
   * @param {WindowState} state
   */
  _cancelPending(win, state) {
    this._clearTimer(win, state);
    state.dispatcher.reset();
    this._emit(state);
  },

  /**
   * @param {BrowserWindow} win
   * @param {WindowState} state
   */
  _clearTimer(win, state) {
    if (state.timer === null) return;
    win.clearTimeout(state.timer);
    state.timer = null;
  },
};

/**
 * What the host can execute (runners.mjs): chrome actions, run with the window's state, and
 * actions on the focused page, run with its <browser>. Built after VimmaHost, which the runners
 * call only when they run.
 * @type {Readonly<Record<string, (state: WindowState, action: Action, text?: string) => void>>}
 */
export const RUNNERS = hostRunners(VimmaHost, HOST_STATE);
export const CONTENT_RUNNERS = contentRunners(VimmaHost, HOST_STATE);

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

/**
 * A tab closing, or moving to another window, lets its hover go first: the hover's state is this
 * window's (docs/specs/hover.md decision 5).
 * @param {Event} e
 */
function releaseHoverOnClose(e) {
  const tab = /** @type {MozTabbrowserTab} */ (e.target);
  if (tab?.linkedBrowser) HoverOps.release(tab.linkedBrowser);
}

// A tab's hover changing redraws its window's status bar (docs/specs/hover.md decision 8).
HoverOps.onChange((browser) => {
  const state = stateOfBrowser(browser);
  if (state) VimmaHost._emit(state);
});

// A finished update check redraws every status bar (docs/specs/m6a-updater.md §5).
VimmaUpdates.addListener(() => {
  for (const win of windows) {
    const state = states.get(win);
    if (state) VimmaHost._emit(state);
  }
});

// The mochitest harness globals Vimma's browser tests use (tests/browser, browser-chrome
// flavour), typed from the engine tree: engine/testing/mochitest/browser-test.js (the scope each
// test runs in), engine/testing/modules/Assert.sys.mjs and TestUtils.sys.mjs,
// engine/testing/mochitest/BrowserTestUtils/BrowserTestUtils.sys.mjs,
// engine/testing/specialpowers/content/SpecialPowersChild.sys.mjs, and
// engine/testing/mochitest/tests/SimpleTest/{SimpleTest,EventUtils}.js. Only what the tests use
// is declared; a member typed `any` or `unknown` says so and why. This folder is outside the
// root tsconfig's `types/*.d.ts`, so none of it reaches the browser code's check.

// --- The test's own scope (browser-test.js, Tester.prototype.execTest) ---

/** Runs one task of the test file, in order; a rejection fails the test. */
declare function add_task(task: () => unknown): void;
/** Like add_task, but runs before every task. */
declare function add_setup(task: () => unknown): void;
/** Runs when the test file ends, last registered first; a returned promise is awaited. */
declare function registerCleanupFunction(fn: () => unknown): void;
/** Multiplies the harness's per-test time limit (45 s by default). */
declare function requestLongerTimeout(factor: number): void;
/** Logs a line to the test log. */
declare function info(message: string): void;
/** A known failure: passes while `condition` is false, and fails once it turns true. */
declare function todo(condition: unknown, message?: string): void;
/** The test file's chrome:// URL. */
declare const gTestPath: string;
/** The chrome:// directory of a test path, with a trailing slash. */
declare function getRootDirectory(path: string): string;
/** The test's directory as a file: URL, for reading support files from disk. */
declare function getChromeDir(resolvedURI: nsIURI): nsIFile;
declare function getResolvedURI(path: string): nsIURI;

// --- Assert.sys.mjs ---

// A test that asserts on a promise it forgot to await passes for the wrong reason: a promise is
// always truthy, and never equals the value it resolves to. These signatures refuse one.
type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

declare const Assert: {
  /**
   * Narrows `value` for the code after it. A failed Assert.ok does not throw: the test goes on,
   * but it has failed already, so what the code after it does cannot make the test pass.
   */
  ok<T>(value: NotPromise<T>, message?: string): asserts value;
  /** `==` (loose), so `expected` must be comparable with `actual`. */
  equal<T>(actual: NotPromise<T>, expected: NoInfer<T>, message?: string): void;
  notEqual<T>(actual: NotPromise<T>, expected: NoInfer<T>, message?: string): void;
  strictEqual<T>(actual: NotPromise<T>, expected: NoInfer<T>, message?: string): void;
  deepEqual<T>(actual: NotPromise<T>, expected: NoInfer<T>, message?: string): void;
  notDeepEqual<T>(actual: NotPromise<T>, expected: NoInfer<T>, message?: string): void;
  /** Both numbers, or both dates; anything else fails the assertion. */
  greater(lhs: number | Date, rhs: number | Date, message?: string): void;
  greaterOrEqual(lhs: number | Date, rhs: number | Date, message?: string): void;
  less(lhs: number | Date, rhs: number | Date, message?: string): void;
  lessOrEqual(lhs: number | Date, rhs: number | Date, message?: string): void;
  /** A non-string on either side fails the assertion. */
  stringContains(lhs: string, rhs: string, message?: string): void;
  stringMatches(lhs: string, rhs: string | RegExp, message?: string): void;
  // `expected` is required at run time (checkExpectedArgument fails the test without it).
  throws(
    block: () => unknown,
    expected: RegExp | Function | ((error: any) => boolean),
    message?: string,
  ): void;
  rejects(
    promise: Promise<unknown>,
    expected: RegExp | Function | ((error: any) => boolean),
    message?: string,
  ): Promise<void>;
};

// --- TestUtils.sys.mjs ---

declare const TestUtils: {
  /**
   * Polls `condition` every `interval` ms (100) up to `maxTries` times (50) and resolves with its
   * first truthy result; rejects on time-out or when it throws.
   */
  waitForCondition<T>(
    condition: () => T | Promise<T>,
    msg?: string,
    interval?: number,
    maxTries?: number,
  ): Promise<T>;
  waitForTick(): Promise<void>;
  /** Resolves with [subject, data] when `topic` is notified and `checkFn` (if any) accepts it. */
  topicObserved(
    topic: string,
    checkFn?: (subject: any, data: string | null) => boolean,
  ): Promise<[any, string | null]>;
};

// --- BrowserTestUtils.sys.mjs ---

/** A url, or a function that opens the tab itself. */
type TabOpening = string | (() => unknown);
/** A url, or a predicate over the loaded url. */
type WantLoad = string | ((url: string) => boolean);

declare const BrowserTestUtils: {
  withNewTab<T>(
    options: string | { gBrowser?: Tabbrowser; url: string },
    taskFn: (browser: MozTabBrowser) => T | Promise<T>,
  ): Promise<T>;
  openNewForegroundTab(
    tabbrowser: Tabbrowser,
    opening?: TabOpening,
    waitForLoad?: boolean,
    waitForStateStop?: boolean,
    forceNewProcess?: boolean,
  ): Promise<MozTabbrowserTab>;
  openNewForegroundTab(options: {
    gBrowser: Tabbrowser;
    opening?: TabOpening;
    url?: string;
    waitForLoad?: boolean;
    waitForStateStop?: boolean;
    forceNewProcess?: boolean;
  }): Promise<MozTabbrowserTab>;
  /** Without `uri`, the tab keeps its initial about:blank. */
  addTab(
    tabbrowser: Tabbrowser,
    uri?: string,
    params?: TabbrowserAddOptions & Record<string, unknown>,
    beforeLoadFunc?: ((tab: MozTabbrowserTab) => void) | null,
  ): MozTabbrowserTab;
  /**
   * Starts the tab's removal and returns at once, without a promise: await waitForTabClosing
   * (or a TabClose event) for the close itself.
   */
  removeTab(tab: MozTabbrowserTab, options?: TabbrowserRemoveOptions): void;
  switchTab(tabbrowser: Tabbrowser, tab: MozTabbrowserTab | (() => unknown)): Promise<void>;
  reloadTab(tab: MozTabbrowserTab, options?: { includeSubFrames?: boolean }): Promise<void>;
  waitForTabClosing(tab: MozTabbrowserTab): Promise<Event>;
  browserLoaded(
    browser: MozBrowser,
    options?: { includeSubFrames?: boolean; wantLoad?: WantLoad; maybeErrorPage?: boolean },
  ): Promise<string>;
  /** The old positional form: (browser, includeSubFrames, wantLoad, maybeErrorPage). */
  browserLoaded(
    browser: MozBrowser,
    includeSubFrames?: boolean,
    wantLoad?: WantLoad | null,
    maybeErrorPage?: boolean,
  ): Promise<string>;
  waitForErrorPage(browser: MozBrowser): Promise<string>;
  startLoadingURIString(browser: MozBrowser, uri: string, loadFlags?: number): void;
  waitForNewTab(
    tabbrowser: Tabbrowser,
    wantLoad?: WantLoad | null,
    waitForLoad?: boolean,
    waitForAnyTab?: boolean,
    maybeErrorPage?: boolean,
  ): Promise<MozTabbrowserTab>;
  openNewBrowserWindow(options?: {
    private?: boolean;
    remote?: boolean;
    waitForTabURL?: string;
    [option: string]: unknown;
  }): Promise<BrowserWindow>;
  waitForNewWindow(params?: {
    url?: string;
    waitForAnyURLLoaded?: boolean;
    anyWindow?: boolean;
    maybeErrorPage?: boolean;
  }): Promise<BrowserWindow>;
  closeWindow(win: Window): Promise<void>;
  windowClosed(win: Window): Promise<void>;
  domWindowOpenedAndLoaded(
    win?: Window | null,
    checkFn?: (win: Window) => boolean | Promise<boolean>,
  ): Promise<Window>;
  domWindowClosed(win?: Window | null): Promise<Window>;
  isVisible(element: Element | null): boolean;
  waitForEvent<E extends Event = Event>(
    subject: EventTarget,
    eventName: string,
    capture?: boolean,
    checkFn?: ((event: E) => boolean) | null,
    wantsUntrusted?: boolean,
  ): Promise<E>;
  /** `checkFn` runs in the content process (it is sent as source), so it sees none of the test. */
  waitForContentEvent(
    browser: MozBrowser,
    eventName: string,
    capture?: boolean,
    checkFn?: ((event: Event) => boolean) | null,
    wantsUntrusted?: boolean,
  ): Promise<string>;
  waitForPopupEvent(popup: Element, eventSuffix: "shown" | "hidden"): Promise<void>;
  /** `target` is a selector, a content-side function returning the element, or null. */
  synthesizeMouse(
    target: string | (() => Element) | null,
    offsetX: number,
    offsetY: number,
    event: MouseEventOptions,
    browsingContext: MozBrowser | unknown,
    handlingUserInput?: boolean,
  ): Promise<boolean>;
  synthesizeMouseAtCenter(
    target: string | (() => Element) | null,
    event: MouseEventOptions,
    browsingContext: MozBrowser | unknown,
  ): Promise<boolean>;
};

// --- SpecialPowersChild.sys.mjs ---

/** A pref for pushPrefEnv: [name, value], or [name] to clear it. */
type PrefEnvEntry = [string, boolean | number | string] | [string];

declare const SpecialPowers: {
  /**
   * Runs `task` in the target's content process with the structured-cloned `args`, and resolves
   * with its (cloned) result. The task is sent as source: it sees none of the test's scope, only
   * the content globals (`content`, `ContentTaskUtils`, `Assert`, `info`).
   */
  spawn<const A extends unknown[], R>(
    target: MozBrowser | unknown,
    args: A,
    task: (...args: A) => R,
  ): Promise<Awaited<R>>;
  pushPrefEnv(prefs: { set?: PrefEnvEntry[]; clear?: [string][] }): Promise<void>;
  popPrefEnv(): Promise<void>;
  clipboardCopyString(text: string): void;
  getClipboardData(flavor: string, whichClipboard?: number): string;
  // The file picker mock (engine/testing/specialpowers/content/MockFilePicker.sys.mjs); untyped
  // here, as one test uses it.
  readonly MockFilePicker: any;
};

// --- SimpleTest.js and EventUtils.js (loaded into the test's scope) ---

declare const SimpleTest: {
  /** Focuses a window, <browser> or browsing context; resolves with the focused context. */
  promiseFocus(target?: Window | MozBrowser | unknown, expectBlankPage?: boolean): Promise<any>;
  /** Resolves when `setup` changes the clipboard to `expected` (or `expected` accepts it). */
  promiseClipboardChange(
    expected: string | ((data: string) => boolean) | null,
    setup: () => unknown,
    flavor?: string,
    timeout?: number,
    expectFailure?: boolean,
  ): Promise<string>;
};

/** EventUtils' modifier and event fields (synthesizeKey's aEvent, synthesizeMouse's aEvent). */
interface KeyEventOptions {
  accelKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altGraphKey?: boolean;
  code?: string;
  /**
   * A count dispatches that many keydowns, the later ones marked as repeats; `true` marks the
   * one keydown as a repeat (EventUtils' _createKeyboardEventDictionary reads `repeat === true`).
   */
  repeat?: number | true;
  location?: number;
  type?: "keydown" | "keyup";
  keyCode?: number;
}
interface MouseEventOptions {
  type?: string;
  button?: number;
  clickCount?: number;
  accelKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

declare const EventUtils: {
  /** `key` is a printable character, or `KEY_` plus a KeyboardEvent.key value. */
  synthesizeKey(key: string, event?: KeyEventOptions, win?: Window): void;
  sendString(text: string, win?: Window): void;
  /** Whether the event's default was prevented. */
  synthesizeMouse(
    target: Element,
    offsetX: number,
    offsetY: number,
    event: MouseEventOptions,
    win?: Window,
  ): boolean;
  synthesizeMouseAtCenter(target: Element, event: MouseEventOptions, win?: Window): boolean;
};

// --- Content-process globals, inside SpecialPowers.spawn tasks ---

/** The content window a spawned task runs in, with Xray's view of the page's own objects. */
declare const content: Window &
  typeof globalThis & {
    /** The page's own objects, past the Xray wrapper: untyped by nature. */
    readonly wrappedJSObject: any;
  };
/**
 * The frame's nsIDocShell, a global of the task's scope. The tests only QueryInterface it through
 * the untyped Ci (to its nsISelectionController), so it is an nsISupports here.
 */
declare const docShell: nsISupports;
declare const ContentTaskUtils: {
  waitForCondition<T>(
    condition: () => T | Promise<T>,
    msg?: string,
    interval?: number,
    maxTries?: number,
  ): Promise<T>;
};

// --- The browser window a browser-chrome test runs in (its scope's prototype) ---

/** A <browser> element, as the tests' JSDoc names it. */
type XULBrowserElement = MozBrowser;

// The window's own members are globals of the test's scope as well. As `var`s they are members
// of `typeof globalThis` too, so `window` has them and passes where a BrowserWindow is wanted
// (`/** @param {BrowserWindow} [win] */ (win = window) => ...`).
declare var gBrowser: BrowserWindow["gBrowser"];
declare var gURLBar: BrowserWindow["gURLBar"] & UrlbarInputTestMembers;
declare var gNavToolbox: BrowserWindow["gNavToolbox"];
declare var BROWSER_NEW_TAB_URL: BrowserWindow["BROWSER_NEW_TAB_URL"];
declare var gBrowserInit: BrowserWindow["gBrowserInit"];
declare var delayedStartupPromise: BrowserWindow["delayedStartupPromise"];
declare var TabBarVisibility: BrowserWindow["TabBarVisibility"];
declare var PopupNotifications: BrowserWindow["PopupNotifications"];
declare var UpdatePopupNotificationsVisibility: BrowserWindow["UpdatePopupNotificationsVisibility"];
declare var isInitialPage: BrowserWindow["isInitialPage"];
declare var switchToTabHavingURI: BrowserWindow["switchToTabHavingURI"];
declare var openTrustedLinkIn: BrowserWindow["openTrustedLinkIn"];
declare var openLinkIn: BrowserWindow["openLinkIn"];
declare var goQuitApplication: BrowserWindow["goQuitApplication"];
declare var DownloadURL: BrowserWindow["DownloadURL"];
declare var gUnifiedExtensions: BrowserWindow["gUnifiedExtensions"];
declare var BrowserAddonUI: BrowserWindow["BrowserAddonUI"];
declare var windowState: ChromeWindow["windowState"];
declare var STATE_MAXIMIZED: ChromeWindow["STATE_MAXIMIZED"];
declare var STATE_NORMAL: ChromeWindow["STATE_NORMAL"];
declare var STATE_FULLSCREEN: ChromeWindow["STATE_FULLSCREEN"];
declare var isFullyOccluded: ChromeWindow["isFullyOccluded"];
declare var getAttention: ChromeWindow["getAttention"];
declare var maximize: ChromeWindow["maximize"];
declare var restore: ChromeWindow["restore"];
declare var browserDOMWindow: BrowserWindow["browserDOMWindow"];
declare var BrowserCommands: BrowserWindow["BrowserCommands"];
// engine/dom/webidl/KeyEvent.webidl: the DOM_VK_* key codes (KeyEventMixin's constants), on a
// global of every window. A name that is not one of them reads undefined.
declare const KeyEvent: { readonly [name: `DOM_VK_${string}`]: number | undefined };
// engine/browser/base/content/utilityOverlay.js
declare function openAboutDialog(): void;
// engine/browser/base/content/browser-places.js: `star` is the URL bar's star button, an <image>
// (document.getElementById("star-button"), so null in a window without one).
declare var BookmarkingUI: { readonly star: XULElement | null };
// engine/browser/base/content/browser.js: the View > Toolbars menu items' command handler.
declare function onViewToolbarCommand(aEvent: Event): void;
// engine/browser/base/content/browser.js: shows or hides a toolbar (the menu bar by its
// `autohide` attribute, any other by `collapsed`); `persist` saves the state, `animated`
// animates the bookmarks toolbar.
declare function setToolbarVisibility(
  toolbar: Element,
  isVisible: boolean,
  persist?: boolean,
  animated?: boolean,
): void;
// engine/browser/components/tabbrowser/content/browser-allTabsMenu.js (`var gTabsPanel`).
declare var gTabsPanel: BrowserWindow["gTabsPanel"];
// engine/browser/base/content/browser.js (a lazy getter on the window: CustomizeMode.sys.mjs).
declare var gCustomizeMode: BrowserWindow["gCustomizeMode"];
// engine/browser/base/content/browser-sync.js (`var gSync`): FXA_ENABLED is a lazy getter of the
// pref identity.fxaccounts.enabled; updateCTAPanel shows or hides the account panel's promotions.
declare var gSync: { readonly FXA_ENABLED: boolean; updateCTAPanel(anchor?: Element): void };
// engine/browser/base/content/utilityOverlay.js: the support base URL (app.support.baseURL,
// formatted) with the topic appended.
declare function getHelpLinkURL(aHelpTopic: string): string;
// engine/browser/base/content/browser.js: opens a browser window; `args` is its first URL (an
// nsISupportsString).
declare function OpenBrowserWindow(options?: { private?: boolean; args?: unknown }): BrowserWindow;
// engine/toolkit/content/viewZoomOverlay.js: a browser's zoom, 1 for none.
declare var ZoomManager: { getZoomForBrowser(browser: MozBrowser): number };
// engine/browser/components/tabbrowser/content/browser-fullZoom.js: back to the default zoom
// (the selected browser's by default); resolves once it is applied.
declare var FullZoom: { reset(browser?: MozBrowser): Promise<void> };

// Browser-window globals and modules that a few tests reach into, mostly to find a panel or a
// button or to reset state between tasks. Their APIs are large and Vimma's code does not call
// them, so they are untyped here: a test's use of one is checked against the page, not by tsc.
declare const PlacesUtils: any;
declare const SidebarController: any;
declare const SitePermissions: any;
declare const CustomizableUI: any;
declare const DownloadsPanel: any;
declare const DownloadsIndicatorView: any;
declare const PanelUI: any;
declare const PanelMultiView: any;
declare const AppMenuNotifications: any;
declare const StarUI: any;
declare const PrintUtils: any;
declare const E10SUtils: any;
declare const NetUtil: any;
declare const BrowserWindowTracker: any;
declare const ExtensionTestUtils: any;

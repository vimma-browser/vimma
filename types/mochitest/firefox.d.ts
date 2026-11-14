// Firefox members the browser tests use and Vimma's own code does not: they add to the
// interfaces of types/firefox.d.ts, in this folder only, so the browser code's check never sees
// them. The engine tree is the source (the IDL or WebIDL file named on each group).

// engine/modules/libpref/nsIPrefBranch.idl
interface nsIPrefBranch {
  readonly PREF_INVALID: 0;
  readonly PREF_STRING: 32;
  readonly PREF_INT: 64;
  readonly PREF_BOOL: 128;
  getPrefType(name: string): 0 | 32 | 64 | 128;
  getCharPref(name: string, defaultValue?: string): string;
  setCharPref(name: string, value: string): void;
  lockPref(name: string): void;
  unlockPref(name: string): void;
  prefHasDefaultValue(name: string): boolean;
  getChildList(startingAt: string): string[];
}
interface nsIPrefDefaultBranch extends nsIPrefBranch {}

// engine/netwerk/base/nsIPermissionManager.idl and nsIPermission.idl
interface nsIPermission {
  readonly principal: any;
  readonly type: string;
  readonly capability: number;
  readonly expireType: number;
}
interface nsIPermissionManager {
  readonly EXPIRE_NEVER: 0;
  readonly EXPIRE_SESSION: 1;
  readonly all: nsIPermission[];
  getAllForPrincipal(principal: unknown): nsIPermission[];
  getPermissionObject(principal: unknown, type: string, exactHost: boolean): nsIPermission | null;
  removeFromPrincipal(principal: unknown, type: string): void;
  removePermission(permission: nsIPermission): void;
  removeAll(): void;
}

// engine/xpcom/system/nsIXULRuntime.idl and nsIXULAppInfo.idl
interface nsIXULRuntime {
  readonly name: string;
  readonly vendor: string;
  readonly platformVersion: string;
  readonly updateURL: string;
}

// engine/dom/interfaces/base/nsIFocusManager.idl
interface nsIFocusManager {
  readonly focusedWindow: Window | null;
}

// engine/xpcom/base/nsIConsoleService.idl (a listener gets each nsIConsoleMessage)
interface nsIConsoleService {
  registerListener(listener: { observe(message: any): void }): void;
  unregisterListener(listener: { observe(message: any): void }): void;
}

// engine/toolkit/components/windowwatcher/nsIWindowWatcher.idl
interface nsIWindowWatcher {
  openWindow(
    parent: Window | null,
    url: string,
    name: string,
    features: string,
    args: unknown,
  ): Window;
}

// engine/toolkit/components/passwordmgr/nsILoginManager.idl
interface nsILoginManager {
  getAllLogins(): Promise<nsILoginInfo[]>;
  removeAllUserFacingLoginsAsync(): Promise<void>;
}

// engine/widget/nsIClipboard.idl
interface nsIClipboard {
  readonly kSelectionClipboard: number;
  isClipboardTypeSupported(whichClipboard: number): boolean;
}

// engine/netwerk/cookie/nsICookie.idl and nsICookieManager.idl (the members the tests use)
interface nsICookie {
  readonly name: string;
  readonly value: string;
  readonly host: string;
  readonly path: string;
  readonly isSession: boolean;
  readonly expiry: number;
  readonly originAttributes: { userContextId?: number; privateBrowsingId?: number };
}
interface nsICookieManager {
  add(
    host: string,
    path: string,
    name: string,
    value: string,
    isSecure: boolean,
    isHttpOnly: boolean,
    isSession: boolean,
    expiry: number,
    originAttributes: object,
    sameSite: number,
    schemeMap: number,
    isPartitioned?: boolean,
  ): unknown;
  remove(host: string, name: string, path: string, originAttributes: object): void;
  removeAll(): void;
  getCookiesFromHost(host: string, originAttributes: object, sorted?: boolean): nsICookie[];
  /** `pattern` is an origin-attributes pattern as JSON. */
  getCookiesWithOriginAttributes(pattern: string, host?: string, sorted?: boolean): nsICookie[];
  removeCookiesWithOriginAttributes(pattern: string, host?: string): void;
}

// engine/js/xpconnect/idl/mozIJSSubScriptLoader.idl
interface mozIJSSubScriptLoader {
  /** Runs the script at `url` with `target` as its global (`this` in a test file: its scope). */
  loadSubScript(url: string, target?: object): unknown;
}

interface FirefoxServices {
  cookies: nsICookieManager;
  // engine/intl/locale/mozILocaleService.idl
  locale: { appLocaleAsBCP47: string };
  scriptloader: mozIJSSubScriptLoader;
  // engine/intl/build/components.conf (js_name "strings")
  strings: nsIStringBundleService;
}

// engine/dom/chrome-webidl/IOUtils.webidl
interface IOUtilsNamespace {
  readJSON(path: string, options?: { decompress?: boolean }): Promise<any>;
  writeJSON(path: string, value: unknown, options?: { tmpPath?: string }): Promise<number>;
  setModificationTime(path: string, modification?: number): Promise<number>;
}

// engine/dom/interfaces/base/nsIDOMWindowUtils.idl
interface nsIDOMWindowUtils {
  advanceTimeAndRefresh(milliseconds: number): void;
  restoreNormalRefresh(): void;
}

// engine/xpcom/base/nsISupports.idl: every XPCOM object. What QueryInterface returns depends on
// the interface asked for, which the tests name through the untyped Ci, so it is untyped too.
interface nsISupports {
  QueryInterface(iid: unknown): any;
}

// engine/dom/webidl/Event.webidl (chrome-only): the target inside a shadow tree or native anonymous
// content, which `target` retargets to the host.
interface Event {
  readonly composedTarget: EventTarget | null;
}

// engine/caps/nsIPrincipal.idl
interface nsIPrincipal {
  readonly origin: string;
  /** The origin without its origin attributes' suffix. */
  readonly originNoSuffix: string;
}

// engine/xpcom/ds/nsIObserver.idl and nsIObserverService.idl: the object form of an observer.
interface nsIObserver {
  observe(subject: nsISupports, topic: string, data: string | null): void;
}
interface nsIObserverService {
  addObserver(
    observer: nsIObserver | ((subject: nsISupports, topic: string, data: string | null) => void),
    topic: string,
    ownsWeak?: boolean,
  ): void;
  removeObserver(
    observer: nsIObserver | ((subject: nsISupports, topic: string, data: string | null) => void),
    topic: string,
  ): void;
}
// engine/toolkit/components/windowwatcher/nsIWindowWatcher.idl: an nsIObserver as well.
interface nsIWindowWatcher {
  registerNotification(observer: nsIObserver): void;
  unregisterNotification(observer: nsIObserver): void;
}

// engine/toolkit/content/widgets/browser-custom-element.mjs: a browser's document and window,
// which only a browser in the parent process (about:preferences, about:addons) has.
interface MozBrowser {
  readonly contentDocument: Document | null;
  readonly contentWindow: (Window & typeof globalThis) | null;
}

// engine/dom/webidl/Document.webidl
interface Document {
  /** Its DocumentL10n; null for a document that does not support Fluent (DocumentSupportsL10n). */
  readonly l10n: DocumentL10n | null;
  readonly hasValidTransientUserGestureActivation: boolean;
  notifyUserGestureActivation(): void;
  /** Chrome-only: the document's sandbox flags, or null when it has none. */
  readonly sandboxFlagsAsString: string | null;
}

// engine/dom/webidl/Window.webidl
interface Window {
  readonly scrollMaxY: number;
}

// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs
interface Tabbrowser {
  /** The tab switch in progress, null when none is (`new AsyncTabSwitcher(this)` while one is). */
  readonly _switcher: AsyncTabSwitcher | null;
  readonly splitViews: MozTabSplitViewWrapper[];
  pinTab(tab: MozTabbrowserTab, options?: { metricsContext?: unknown }): void;
  discardBrowser(tab: MozTabbrowserTab, forceDiscard?: boolean): boolean;
  explicitUnloadTabs(tabs: MozTabbrowserTab[]): Promise<void>;
  addTabSplitView(
    tabs: MozTabbrowserTab[],
    options?: { id?: number | null; insertBefore?: MozTabbrowserTab | null; trigger?: string },
  ): MozTabSplitViewWrapper;
  duplicateTab(
    tab: MozTabbrowserTab,
    restoreTabImmediately?: boolean,
    options?: { inBackground?: boolean; tabIndex?: number },
  ): MozTabbrowserTab;
  /** The new tab, or null when the tab could not be adopted. */
  adoptTab(
    tab: MozTabbrowserTab,
    options?: { elementIndex?: number; tabIndex?: number; selectTab?: boolean },
  ): MozTabbrowserTab | null;
  // A browser's TabDialogBox (engine/browser/base/content/browser-tabdialogs.js), untyped here:
  // one test counts its content dialogs.
  getTabDialogBox(browser: MozBrowser): any;
}

// engine/netwerk/base/nsIPermissionManager.idl: permissions scoped to one tab's browser.
interface nsIPermissionManager {
  getForBrowser(principal: unknown, type: string, browserId: number): nsIPermission | null;
  removeFromPrincipalForBrowser(principal: unknown, type: string, browserId: number): void;
}

// engine/toolkit/content/widgets/browser-custom-element.mjs, and its frame loader
// (engine/dom/chrome-webidl/FrameLoader.webidl, engine/dom/interfaces/base/nsIRemoteTab.idl)
interface MozBrowser {
  /** Its current window global's outer window id, undefined while it has none. */
  readonly outerWindowID: number | undefined;
  docShellIsActive: boolean;
  fullZoom: number;
  stop(): void;
  readonly frameLoader: { readonly remoteTab: { priorityHint: boolean } | null } | null;
}

// engine/toolkit/modules/PopupNotifications.sys.mjs (Notification): a browser's notification.
// `dismissed` is true once its panel closed without an answer; `timeShown` is the time
// (ChromeUtils.now()) its buttons' security delay counts from, null until the prompt shows,
// which an activation or a move of the panel sets anew; remove() takes it off its browser.
interface PopupNotification {
  readonly id: string;
  dismissed: boolean;
  timeShown: number | null;
  remove(): void;
}
// engine/toolkit/modules/PopupNotifications.sys.mjs: a notification, or null when there is none.
interface PopupNotificationsApi {
  getNotification(id: string, browser?: MozBrowser): PopupNotification | null;
}

// engine/dom/webidl/HTMLInputElement.webidl and HTMLTextAreaElement.webidl (chrome-only): set the
// value as the user's typing would, with input and change events.
interface HTMLInputElement {
  setUserInput(value: string): void;
}
interface HTMLTextAreaElement {
  setUserInput(value: string): void;
}
// engine/dom/base/nsISelectionController.idl (what a test reads of a field's editor)
interface nsISelectionController {
  getDisplaySelection(): number;
}

// engine/toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs: a container.
interface ContextualIdentity {
  readonly userContextId: number;
  readonly public: boolean;
  readonly icon: string;
  readonly color: string;
  /** A container the user named; Firefox's own have an l10nId instead. */
  readonly name?: string;
  readonly l10nId?: string;
}

// engine/dom/interfaces/base/nsIBrowserDOMWindow.idl: how the system opens a link in a window.
interface nsIBrowserDOMWindow {
  /** The new tab's browsing context, or null. */
  openURI(
    uri: nsIURI | null,
    openWindowInfo: unknown,
    where: number,
    flags: number,
    triggeringPrincipal: unknown,
    policyContainer?: unknown,
  ): any;
}

// engine/browser/base/content/browser.js and browser-commands.js: members of a browser window
// only the tests use. BrowserCommands is a large set of menu commands, untyped here.
interface BrowserWindow {
  readonly browserDOMWindow: nsIBrowserDOMWindow;
  readonly BrowserCommands: any;
}

// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs (addTab's options)
interface TabbrowserAddOptions {
  pinned?: boolean;
}

// engine/dom/chrome-webidl/XULPopupElement.webidl: a <menupopup> or <panel>.
interface XULPopupElement extends Element {
  activateItem(item: Element, options?: object): void;
  hidePopup(cancel?: boolean): void;
}
// engine/toolkit/content/widgets/autocomplete-popup.js: the form fields' suggestion popup
// (#PopupAutoComplete), which a <datalist> opens.
interface AutoCompletePopupElement extends XULPopupElement {
  selectedIndex: number;
  readonly popupOpen: boolean;
}

// engine/dom/chrome-webidl/BrowsingContext.webidl: a frame's browsing context, which a test passes
// to SpecialPowers.spawn. Firefox's own types read it as `any` (a browser's `browsingContext`), so
// this names it for a test's JSDoc; the members are the ones the tests read.
interface BrowsingContext {
  readonly id: number;
  readonly children: BrowsingContext[];
}
// The same webidl's CanonicalBrowsingContext: a browsing context as the parent process sees it,
// the only side that has its document's global (WindowGlobalActors.webidl), once it has one.
interface CanonicalBrowsingContext extends BrowsingContext {
  readonly children: CanonicalBrowsingContext[];
}
// engine/dom/chrome-webidl/WindowGlobalActors.webidl: its document's global, once it has one.
interface WindowGlobalParent {
  readonly documentURI: { readonly spec: string } | null;
  readonly documentPrincipal: nsIPrincipal;
  readonly isInitialDocument: boolean;
  /**
   * A snapshot of `rect` of the global's document (the whole viewport for null), at `scale`,
   * over `backgroundColor`; the options are the webidl's DrawSnapshotOptions.
   */
  drawSnapshot(
    rect: DOMRect | null,
    scale: number,
    backgroundColor: string,
    options?: { resetScrollPosition?: boolean; drawView?: boolean },
  ): Promise<ImageBitmap>;
}

// engine/xpcom/io/nsIFile.idl (the members the tests use)
interface nsIFile {
  readonly path: string;
  readonly leafName: string;
  readonly parent: nsIFile;
  append(node: string): void;
  normalize(): void;
  clone(): nsIFile;
  exists(): boolean;
}

// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs: the selected browser's URI.
interface Tabbrowser {
  readonly currentURI: nsIURI;
}

// engine/js/xpconnect/idl/xpccomponents.idl (nsIXPCComponents_Utils): a sandbox, and code run
// in it. A sandbox is a global object whose members are whatever the code run in it defines, so
// it is untyped.
interface XPCComponentsUtils {
  Sandbox(principal: unknown, options?: object): any;
  evalInSandbox(
    source: string,
    sandbox: unknown,
    version?: string,
    filename?: string,
    lineNo?: number,
    enforceFilenameRestrictions?: boolean,
  ): unknown;
}

// engine/browser/components/urlbar/content/UrlbarInputBase.mjs (UrlbarInput extends it) and
// content/UrlbarView.mjs: the address bar's members the tests use past those types/firefox.d.ts
// gives the product (harness.d.ts adds them to the test window's gURLBar).
interface UrlbarInputTestMembers {
  /** The field's text; setting it sets the text the address bar shows. */
  value: string;
  /** The <input> the address bar edits. */
  readonly inputField: HTMLInputElement;
  /** The field's text before trimming: the full address of a page. */
  readonly untrimmedValue: string;
  /** The <input>'s selection, which the address bar forwards (READ_WRITE_PROPERTIES). */
  selectionStart: number | null;
  selectionEnd: number | null;
  handleRevert(): void;
  readonly view: {
    /** The selected row's result: a search suggestion's payload has its text. */
    readonly selectedResult: {
      /** A URL result's payload has its `url` (UrlbarUtils.sys.mjs, RESULT_PAYLOAD_SCHEMA). */
      readonly payload: { readonly suggestion?: string; readonly url?: string };
    } | null;
    readonly selectedElement: Element | null;
    /** Closes the view (engine/browser/components/urlbar/content/UrlbarView.mjs). */
    close(options?: { elementPicked?: boolean; showFocusBorder?: boolean }): void;
  };
  /**
   * Sets the field's text, starts a query for it and opens the view; focuses the field unless
   * `focus` is false.
   */
  search(value: string, options?: { focus?: boolean; startQuery?: boolean }): void;
}

// engine/toolkit/components/windowwatcher/nsIPromptService.idl; Services.prompt is its service
// (engine/toolkit/components/prompts/src/components.conf, js_name "prompt").
interface nsIPromptService {
  /** Spins a nested event loop until the dialog closes: true for OK, false for Cancel. */
  confirm(parent: Window | null, title: string, text: string): boolean;
  /**
   * An alert for a browsing context; `modalType` is a MODAL_TYPE_* constant. Spins a nested
   * event loop until it closes.
   */
  alertBC(browsingContext: BrowsingContext, modalType: number, title: string, text: string): void;
}
interface FirefoxServices {
  prompt: nsIPromptService;
}

// engine/toolkit/content/widgets/dialog.js (MozDialog): a chrome dialog's XUL <dialog>, whose
// buttons are XUL buttons (engine/toolkit/content/widgets/button.js, MozButtonBase `disabled`).
interface MozDialogElement extends Element {
  getButton(type: "accept" | "cancel" | "extra1" | "extra2" | "help" | "disclosure"): Element & {
    disabled: boolean;
  };
  /**
   * Runs the accept button's command, as a click on it does: false when a "dialogaccept"
   * listener cancelled it, true otherwise, also when the button is disabled and nothing ran
   * (_doButtonCommand).
   */
  acceptDialog(): boolean;
}

// engine/toolkit/content/widgets/radio.js (MozRadiogroup): the selected <radio>, null for none.
interface MozRadiogroupElement extends Element {
  selectedItem: Element | null;
}

// engine/toolkit/modules/SubDialog.sys.mjs: a sub-dialog, as its "dialogopen" event's
// `detail.dialog` gives it; the tests read two of its own fields.
interface SubDialog {
  /** The URL it opened, null once it closes. */
  readonly _openedURL: string | null;
  /** Its frame: a <browser class="dialogFrame"> in the parent process. */
  readonly _frame: MozBrowser;
}

// engine/dom/webidl/Window.webidl (chrome-only): the window's WindowGlobalChild, which a content
// task reaches the frame's actors through; null for a window without a global of its own.
interface Window {
  readonly windowGlobalChild: WindowGlobalChild | null;
}
// engine/dom/chrome-webidl/WindowGlobalActors.webidl
interface WindowGlobalChild {
  getActor(name: string): JSWindowActorChild;
}

// engine/dom/webidl/Document.webidl (chrome-only): a XUL element, as chrome code makes one.
interface Document {
  createXULElement(localName: string, options?: ElementCreationOptions | string): Element;
}

// engine/dom/chrome-webidl/XULElement.webidl: a XUL element, such as a <command>, which runs its
// command on doCommand. Like an HTML element, it has its inline style (XULElement includes
// ElementCSSInlineStyle) and takes focus (it includes HTMLOrSVGOrMathMLElement, whose `focus`
// is in engine/dom/webidl/Element.webidl).
interface XULElement extends Element, ElementCSSInlineStyle {
  hidden: boolean;
  doCommand(): void;
  focus(options?: FocusOptions): void;
}
// engine/browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs: a tab switch in progress, which
// shows the requested tab once its layers are ready.
interface AsyncTabSwitcher {
  /** The tab whose layers it waits for, null while it waits for none. */
  readonly loadingTab: MozTabbrowserTab | null;
  /** Its events, such as a browser's MozLayerTreeReady (`originalTarget` is the <browser>). */
  handleEvent(event: { type: string; originalTarget?: EventTarget }, delayed?: boolean): void;
}
// engine/browser/components/tabbrowser/content/tabsplitview.mjs: the wrapper is a XUL element
// (MozXULElement).
interface MozTabSplitViewWrapper extends XULElement {}

// engine/xpcom/base/nsIConsoleMessage.idl: what a console listener gets (its `message` is the
// text with its file and line).
interface nsIConsoleMessage {
  readonly message: string;
}
// engine/xpfe/appshell/nsIAppShellService.idl: makes a browser with no window, here a document
// whose window a test can close (nsIWindowlessBrowser.idl; `document` from nsIWebNavigation.idl,
// which makes a blank one when there is none and is null only on an unexpected error).
interface nsIWindowlessBrowser {
  readonly document: Document | null;
  close(): void;
}
interface nsIAppShellService {
  createWindowlessBrowser(isChrome?: boolean, chromeMask?: number): nsIWindowlessBrowser;
}
interface FirefoxServices {
  appShell: nsIAppShellService;
}
// engine/dom/bindings/nsIScriptError.idl: a script error or warning (`flags` has warningFlag for
// a warning).
interface nsIScriptError extends nsIConsoleMessage {
  readonly errorMessage: string;
  readonly sourceName: string;
  readonly lineNumber: number;
  readonly flags: number;
}

// engine/toolkit/content/widgets/notificationbox.js: a button of a notification, as
// appendNotification's doc comment lists it and setButtons reads it.
interface NotificationButton {
  label?: string;
  accessKey?: string;
  "l10n-id"?: string;
  /** Run with the notification, this button's info, its <button> and the event; false closes. */
  callback?: (
    notification: Element,
    button: NotificationButton,
    element: Element,
    event: Event,
  ) => unknown;
  link?: string;
  supportPage?: string;
  /** The id of a popup to open, anchored to the button, instead of a callback. */
  popup?: string;
  telemetry?: string;
  is?: string;
  primary?: boolean;
}
// engine/toolkit/content/widgets/notificationbox.js (MozElements.NotificationBox): a browser's
// notification box.
interface MozNotificationBox {
  /** The priorities are on its prototype (PRIORITY_SYSTEM 0 to PRIORITY_CRITICAL_HIGH 9). */
  readonly PRIORITY_INFO_LOW: number;
  /** Its <vbox class="notificationbox-stack">, which its `stack` getter makes on first use. */
  readonly _stack: Element | undefined;
  /** The <notification-message> elements it shows, without one that is closing. */
  readonly allNotifications: Element[];
  /** Resolves with the <notification-message> it shows. */
  appendNotification(
    type: string,
    notification: { label: string; priority: number },
    buttons?: NotificationButton[],
    disableClickJackingDelay?: boolean,
    dismissable?: boolean,
  ): Promise<Element>;
}

// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs
interface Tabbrowser {
  /** Whether the tab's find bar is made (getCachedFindBar then returns it); never makes one. */
  isFindBarInitialized(tab?: MozTabbrowserTab): boolean;
  /** A browser's notification box (the selected browser's without one), made on first use. */
  getNotificationBox(browser?: MozBrowser): MozNotificationBox;
  /**
   * A browser's .browserContainer (the selected browser's without one): its grandparent. Never
   * null: it reads `parentNode.parentNode`, which throws for a browser with no parent. Its one
   * caller (split_contract) passes a split tab's browser, which is in its panel.
   */
  getBrowserContainer(browser?: MozBrowser): Element;
  /** The browsers of the active split view's tabs; empty without one. */
  readonly splitViewBrowsers: MozBrowser[];
}

// engine/browser/components/tabbrowser/content/tabsplitview.mjs
interface MozTabSplitViewWrapper {
  /** Its tabs' panels that are in the document (`#tabs`, which keeps a closed tab's panel id). */
  readonly panels: XULElement[];
  /** Whether every tab of it is visible. */
  readonly visible: boolean;
  addTabs(
    tabs: MozTabbrowserTab[],
    options?: { isSessionRestore?: boolean; indexOfReplacedTab?: number },
  ): void;
}

// engine/xpcom/threads/nsITimer.idl; nsITimerManager.getTimers(), in the same file, lists the
// pending timers for tests.
interface nsITimer {
  /** Its delay in ms; setting it on a pending timer reschedules it. */
  delay: number;
  /** A TYPE_* constant (TYPE_ONE_SHOT, the repeating ones). */
  type: number;
  /** The callback's name, for logs. */
  readonly name: string;
}
// engine/browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs
interface AsyncTabSwitcher {
  /** The TAB_SWITCH_TIMEOUT timer of the tab it loads, null while it loads none. */
  readonly loadTimer: nsITimer | null;
}

// engine/toolkit/content/widgets/browser-custom-element.mjs: whether a remote browser's page
// paints (its remote tab's renderLayers) and has painted layers to show (hasLayers); a browser in
// the parent process reads docShellIsActive for both.
interface MozBrowser {
  renderLayers: boolean;
  readonly hasLayers: boolean;
}

// engine/xpcom/components/nsICategoryManager.idl: a category's entries, as an nsISimpleEnumerator
// (iterable in JS, engine/xpcom/ds/nsISimpleEnumerator.idl) of nsICategoryEntry.
interface nsICategoryEntry {
  readonly entry: string;
  readonly value: string;
}
interface nsICategoryManager {
  enumerateCategory(category: string): Iterable<nsICategoryEntry>;
}

// engine/toolkit/components/commandlines/nsICommandLine.idl
interface nsICommandLine extends nsISupports {
  /** The flag's index among the arguments, -1 when it is not there. */
  findFlag(flag: string, caseSensitive: boolean): number;
}
// engine/js/xpconnect/idl/xpccomponents.idl: a command line as another process hands one over;
// `state` is an nsICommandLine STATE_* constant.
interface XPCComponentsUtils {
  createCommandLine(args: string[], workingDir: nsIFile | null, state: number): nsISupports;
}

// engine/dom/webidl/Window.webidl (chrome-only): opens a window, passing `extraArguments` to it
// as its arguments.
interface Window {
  openDialog(
    url?: string,
    name?: string,
    options?: string,
    ...extraArguments: unknown[]
  ): Window | null;
}

// engine/browser/base/content/utilityOverlay.js (URILoadingHelper.openLinkIn): opens a URL as a
// link does, with the opener's principal and container.
interface BrowserWindow {
  openLinkIn(
    url: string,
    where: string,
    params: { inBackground?: boolean; triggeringPrincipal?: nsIPrincipal; userContextId?: number },
  ): void;
}

// engine/dom/chrome-webidl/XULElement.webidl: a XUL element has click(), and its `dataset`
// (XULElement includes HTMLOrSVGOrMathMLElement, engine/dom/webidl/Element.webidl).
interface XULElement {
  readonly dataset: DOMStringMap;
  click(): void;
}

// engine/browser/components/tabbrowser/content/browser-allTabsMenu.js: the List All Tabs panel
// of a browser window. `canOpen` is false while #alltabs-button is not visible;
// initElements() makes the panel's view from its template.
interface BrowserWindow {
  readonly gTabsPanel: {
    readonly canOpen: boolean;
    initElements(): void;
    hideAllTabsPanel(): void;
  };
}

// engine/browser/base/content/browser.js (a lazy getter, `new CustomizeMode(window)`) and
// engine/browser/components/customizableui/CustomizeMode.sys.mjs: the window's customize mode.
// Both return at once; "customizationready" and "aftercustomization" on gNavToolbox tell the end.
interface BrowserWindow {
  readonly gCustomizeMode: {
    enter(aEntryPoint?: string): void;
    exit(): void;
  };
}

// engine/browser/components/tabbrowser/content/tabs.mjs (MozTabbrowserTabs, the
// <tabs id="tabbrowser-tabs"> element that gBrowser.tabContainer is): `verticalMode` is true
// while its orient attribute is "vertical".
interface MozTabbrowserTabs extends Element {
  selectedIndex: number;
  readonly verticalMode: boolean;
}

// engine/dom/webidl/Window.webidl (the ChromeWindow part): the values of `windowState`.
interface ChromeWindow {
  readonly STATE_MAXIMIZED: number;
  readonly STATE_NORMAL: number;
  readonly STATE_FULLSCREEN: number;
}

// engine/dom/interfaces/base/nsIDOMWindowUtils.idl: an element's box as last laid out, without
// a layout flush.
interface nsIDOMWindowUtils {
  getBoundsWithoutFlushing(element: Element): DOMRect;
}

// engine/xpcom/io/nsIFile.idl: `type` is NORMAL_FILE_TYPE or DIRECTORY_TYPE; `directoryEntries`
// is an nsIDirectoryEnumerator (engine/xpcom/io/nsIDirectoryEnumerator.idl), which JS iterates
// as files (engine/xpcom/ds/nsISimpleEnumerator.idl, its JS iterator).
interface nsIFile {
  create(type: number, permissions: number, skipAncestors?: boolean): void;
  remove(recursive: boolean): void;
  readonly directoryEntries: Iterable<nsIFile>;
}

// engine/js/xpconnect/idl/xpccomponents.idl (nsIXPCComponents_Utils): a garbage collection and
// a cycle collection, now.
interface XPCComponentsUtils {
  forceGC(): void;
  forceCC(): void;
}

// engine/netwerk/base/nsIServerSocket.idl: a listening socket; initWithFilename makes it a Unix
// domain socket at `path` (`backlog` -1: the default).
interface nsIServerSocket {
  initWithFilename(path: nsIFile, permissions: number, backlog: number): void;
  asyncListen(listener: nsIServerSocketListener): void;
  close(): void;
}
// engine/netwerk/base/nsIServerSocket.idl (nsIServerSocketListener)
interface nsIServerSocketListener {
  onSocketAccepted(server: nsIServerSocket, transport: nsISocketTransport): void;
  onStopListening(server: nsIServerSocket, status: number): void;
}
// engine/netwerk/base/nsITransport.idl: a connection's two streams; `reason` is an nsresult.
interface nsITransport {
  openInputStream(flags: number, segmentSize: number, segmentCount: number): nsIInputStream;
  openOutputStream(flags: number, segmentSize: number, segmentCount: number): nsIOutputStream;
  close(reason: number): void;
}
// engine/netwerk/base/nsISocketTransport.idl
interface nsISocketTransport extends nsITransport {}
// engine/xpcom/io/nsIInputStream.idl
interface nsIInputStream extends nsISupports {}
// engine/xpcom/io/nsIAsyncInputStream.idl: `callback` (nsIInputStreamCallback) is called once,
// on `target`, when the stream has data or is closed.
interface nsIAsyncInputStream extends nsIInputStream {
  asyncWait(
    callback: { onInputStreamReady(stream: nsIAsyncInputStream): void },
    flags: number,
    requestedCount: number,
    target: unknown,
  ): void;
}
// engine/xpcom/io/nsIOutputStream.idl: write() returns the number of bytes written.
interface nsIOutputStream extends nsISupports {
  write(buf: string, count: number): number;
  close(): void;
}

// engine/toolkit/components/urlformatter/nsIURLFormatter.idl: a URL pref's value with its
// %VERSION%, %OS%, %LOCALE% and other variables filled in ("about:blank" for a pref without a
// value); Services.urlFormatter is its service (the folder's components.conf, js_name).
interface nsIURLFormatter {
  formatURLPref(pref: string): string;
}
interface FirefoxServices {
  urlFormatter: nsIURLFormatter;
}

// engine/dom/chrome-webidl/XULPopupElement.webidl: opens the popup at a screen position, as a
// context menu when `isContextMenu` is true.
interface XULPopupElement {
  openPopupAtScreen(
    x?: number,
    y?: number,
    isContextMenu?: boolean,
    triggerEvent?: Event | null,
  ): void;
}

// engine/xpcom/ds/nsIPersistentProperties2.idl: a string property, which throws for a key it
// does not have.
interface nsIPersistentProperties {
  getStringProperty(key: string): string;
}
// engine/accessible/interfaces/nsIAccessible.idl: an element as assistive technology sees it.
// `role` is an nsIAccessibleRole constant; getState fills `value` of its two out parameters with
// nsIAccessibleStates bits; `attributes` are its object attributes (`live`, `level`, `xml-roles`).
// `name` and `description` are null for an accessible without one (a void string,
// engine/accessible/generic/LocalAccessible.cpp).
interface nsIAccessible extends nsISupports {
  readonly name: string | null;
  readonly description: string | null;
  readonly role: number;
  readonly attributes: nsIPersistentProperties;
  getState(state: { value?: number }, extraState: { value?: number }): void;
}
// engine/accessible/interfaces/nsIAccessibilityService.idl: the accessible of a DOM node, null
// for a node that has none (one that is not rendered, or is hidden from the accessible tree).
interface nsIAccessibilityService {
  getAccessibleFor(node: Node): nsIAccessible | null;
}

// engine/toolkit/content/widgets/popupnotification.js (MozPopupNotification): a prompt in the
// notification panel. Its connectedCallback finds its two buttons, and PopupNotifications sets
// `notification` when it shows one in it (PopupNotifications.sys.mjs, _refreshPanel).
interface MozPopupNotification extends XULElement {
  readonly button: XULElement;
  readonly secondaryButton: XULElement;
  readonly notification: PopupNotification;
}
// engine/browser/base/content/browser-addons.js (MozAddonInstalledNotification): the app menu's
// "<name> was added" notice. `pinExtensionEl` is its "Pin extension to toolbar" <checkbox>
// (engine/browser/components/customizableui/content/panelUI.inc.xhtml; `checked` is
// engine/toolkit/content/widgets/checkbox.js).
interface MozAddonInstalledNotification extends MozPopupNotification {
  readonly pinExtensionEl: XULElement & { checked: boolean };
}

// engine/dom/webidl/Window.webidl (chrome-only): runs `callback` once no style or layout flush
// is pending, and resolves with what it returns.
interface Window {
  promiseDocumentFlushed<T>(callback: () => T): Promise<T>;
}

// engine/browser/components/customizableui/CustomizableUI.sys.mjs: a customizable toolbar that
// overflows has its OverflowableToolbar as `overflowable` (registerToolbarNode sets it, and
// unregistering the toolbar's window sets it back to null); isHandlingOverflow() is true while
// it moves items to or from the overflow menu.
interface OverflowableToolbarElement extends XULElement {
  readonly overflowable: { isHandlingOverflow(): boolean } | null;
}

// engine/browser/components/tabbrowser/content/tab.mjs: the tab that opened this one, which
// closing this one selects again; null without one, or once the owner is closing.
interface MozTabbrowserTab {
  owner: MozTabbrowserTab | null;
}

// The pdf.js viewer's own objects, which a test reads past the Xray wrapper
// (`content.wrappedJSObject`, untyped by nature): only the members the tests read, set or call.
// Lines are those of engine/toolkit/components/pdfjs/content/web/viewer.mjs.

/** `class EventBus` (line 1293): `dispatch` (1324) calls the listeners of `eventName`. */
interface PdfJsEventBus {
  dispatch(eventName: string, data?: object): void;
}
/** `class PDFViewer` (line 13365). */
interface PdfJsViewer {
  /** 13476: the page views it holds. */
  readonly pagesCount: number;
  /** 13547: the current page's label, null for a document without page labels. */
  readonly currentPageLabel: string | null;
  /** 13568: 1 while the scale is unknown. */
  readonly currentScale: number;
  /** 13582 and 13585: a number as text or a named fit; null until a scale is set (14122). */
  get currentScaleValue(): string | null;
  set currentScaleValue(value: string);
  /** 13593 and 13596: 0, 90, 180 or 270. */
  pagesRotation: number;
  /** 14611 */
  readonly isInPresentationMode: boolean;
  /** 14754 and 14757: ScrollMode (VERTICAL 0, PAGE 3). */
  scrollMode: number;
  /** 14797 and 14800: SpreadMode (NONE 0, ODD 1, EVEN 2). */
  spreadMode: number;
}
/**
 * `class PDFDocumentProxy` (engine/toolkit/components/pdfjs/content/build/pdf.mjs, line 15353):
 * `getOutline` (15421) resolves with the outline's top entries, null for a document without one;
 * `getData` (15441) with the document's bytes.
 */
interface PdfJsDocument {
  getOutline(): Promise<object[] | null>;
  getData(): Promise<Uint8Array>;
}
/** `class ViewsManager` (line 17218), pdf.js's sidebar: `isOpen` is its own field (17255). */
interface PdfJsViewsManager {
  readonly isOpen: boolean;
}
/**
 * `const PDFViewerApplication` (line 17587). Its parts are null (17594 to 17617) until the viewer
 * has initialised them (`eventBus` 17785, `pdfViewer` 17933, `viewsManager` 18086, which a viewer
 * without a sidebar never makes) or, for `pdfDocument`, while no document is open.
 */
interface PdfJsApplication {
  readonly pdfDocument: PdfJsDocument | null;
  readonly pdfViewer: PdfJsViewer | null;
  readonly viewsManager: PdfJsViewsManager | null;
  readonly eventBus: PdfJsEventBus | null;
  /** 18197: 0 while no document is open. */
  readonly pagesCount: number;
  /** 18200 and 18203: the current page's number, from 1. */
  page: number;
  /** 18331: opens another document in the same viewer, here from its bytes. */
  open(args: { data: Uint8Array }): Promise<void>;
}
/** The viewer's window (viewer.mjs sets `window.PDFViewerApplication`), with its own globals. */
type PdfJsWindow = typeof globalThis & { readonly PDFViewerApplication: PdfJsApplication };

// engine/js/xpconnect/idl/xpccomponents.idl: exportFunction returns a forwarder in the target's
// compartment that calls `fn` with the same arguments (cloned) and hands back its result, so a
// test that gives it to the page keeps the function's own signature. The forwarder leaves `this`
// unbound: `fn` must not use it, which `F` cannot say. `defineAs` also sets the forwarder on
// `target` under that name.
interface XPCComponentsUtils {
  exportFunction<F extends Function>(fn: F, target: object, options?: { defineAs?: string }): F;
}

// Firefox's import wizard, as Settings shows it in its <dialog id="migrationWizardDialog">
// (engine/browser/components/preferences/preferences.xhtml): the parts of
// engine/browser/components/migration/content/migration-wizard.mjs (MigrationWizard) that the
// wizard tests reach through its shadow root.

/**
 * A browser and profile in the wizard's list: a <panel-item> the wizard gives the migrator's
 * `profile` (migration-wizard.mjs line 686), null for a browser without profiles.
 */
interface MigrationWizardItem extends HTMLElement {
  readonly profile?: { readonly id: string; readonly name: string } | null;
}
/**
 * The wizard's <button id="browser-profile-selector">, which opens the list.
 * #onBrowserProfileSelectionChanged (line 513) sets `selectedPanelItem`, so it is undefined
 * until the wizard has chosen its first browser.
 */
interface MigrationWizardSelector extends HTMLButtonElement {
  readonly selectedPanelItem?: MigrationWizardItem;
}
/**
 * engine/toolkit/content/widgets/panel-list/panel-list.mjs (PanelList), the wizard's list of
 * browsers, inside a XUL <panel> in a chrome document (migration-wizard.mjs line 493): `open`
 * (line 80) is its `open` attribute.
 */
interface PanelListElement extends HTMLElement {
  open: boolean;
}
/**
 * Settings' window (engine/browser/components/preferences/main.js, `var gMainPane`, line 598):
 * showMigrationWizardDialog (line 1498) opens the wizard's dialog, making the wizard on first
 * use.
 */
type PreferencesWindow = Window &
  typeof globalThis & {
    readonly gMainPane: {
      showMigrationWizardDialog(options?: { closeTabWhenDone?: boolean }): Promise<void>;
    };
  };

// engine/browser/components/passwordmgr/content/login-doorhanger-username-field.mjs
// (LoginDoorhangerUsernameField): the save-password prompt's username field, a MozInputText
// (engine/toolkit/content/widgets/moz-input-text/moz-input-text.mjs), whose `value` is its
// text (MozBaseInputElement's property, engine/toolkit/content/widgets/lit-utils.mjs).
interface LoginDoorhangerUsernameField extends HTMLElement {
  value: string;
}

// Fluent, as chrome code formats strings with it: engine/dom/webidl/Localization.webidl,
// engine/dom/webidl/DOMLocalization.webidl, engine/dom/chrome-webidl/DocumentL10n.webidl,
// engine/dom/chrome-webidl/L10nRegistry.webidl and engine/dom/chrome-webidl/Fluent.webidl.

/** Fluent's arguments (Fluent.webidl, L10nArgs). */
type L10nArgs = Record<string, string | number | null>;
/** A resource's path, or the path and whether it may be missing (L10nRegistry.webidl). */
type L10nResourceId = string | { path: string; _optional?: boolean };
/** A message's id and arguments (Localization.webidl, L10nIdArgs); both are null by default. */
interface L10nIdArgs {
  id?: string | null;
  args?: L10nArgs | null;
}
/** Localization.webidl (L10nMessage): `value` and `attributes` are null for a message without. */
interface L10nMessage {
  readonly value: string | null;
  readonly attributes: { readonly name: string; readonly value: string }[] | null;
}
/**
 * Localization.webidl: formats messages from `resourceIds`; `sync` true allows the *Sync
 * methods. A message it cannot find is null in the lists it returns.
 */
interface Localization {
  formatValue(id: string, args?: L10nArgs): Promise<string | null>;
  formatMessages(keys: (string | L10nIdArgs)[]): Promise<(L10nMessage | null)[]>;
  formatMessagesSync(keys: (string | L10nIdArgs)[]): (L10nMessage | null)[];
}
declare var Localization: {
  prototype: Localization;
  new (
    resourceIds: L10nResourceId[],
    sync?: boolean,
    registry?: L10nRegistry,
    locales?: string[],
  ): Localization;
};
/** DOMLocalization.webidl: a Localization that translates elements by their data-l10n-id. */
interface DOMLocalization extends Localization {
  /** An element's data-l10n-id and data-l10n-args (L10nIdArgs). */
  getAttributes(element: Element): { id: string | null; args: L10nArgs | null };
  translateElements(elements: Element[]): Promise<void>;
}
/** DocumentL10n.webidl: a document's DOMLocalization (`document.l10n`). */
interface DocumentL10n extends DOMLocalization {}
/** Fluent.webidl: a message's pattern, which only FluentBundle.formatPattern reads. */
interface FluentPattern {}
/** Fluent.webidl (FluentMessage): `value` is null for a message with attributes only. */
interface FluentMessage {
  readonly value: FluentPattern | null;
  readonly attributes: Record<string, FluentPattern>;
}
/** Fluent.webidl: a parsed .ftl source. */
interface FluentResource {}
declare var FluentResource: { prototype: FluentResource; new (source: string): FluentResource };
/** Fluent.webidl: getMessage is null for an id the bundle does not have. */
interface FluentBundle {
  addResource(resource: FluentResource, options?: { allowOverrides?: boolean }): void;
  getMessage(id: string): FluentMessage | null;
  formatPattern(pattern: FluentPattern, args?: L10nArgs | null, errors?: object): string;
}
/** L10nRegistry.webidl (FluentBundleIterator): `value` is null once `done`. */
interface FluentBundleIterator {
  next(): { value: FluentBundle | null; done: boolean };
}
/** L10nRegistry.webidl */
interface L10nRegistry {
  generateBundlesSync(locales: string[], resourceIds: L10nResourceId[]): FluentBundleIterator;
}
declare var L10nRegistry: { getInstance(): L10nRegistry };

// engine/intl/strres/nsIStringBundle.idl: a .properties bundle. GetStringFromName throws for a
// name the bundle does not have; getSimpleEnumeration lists its strings as nsIPropertyElement
// (engine/xpcom/ds/nsIPersistentProperties2.idl), iterable in JS
// (engine/xpcom/ds/nsISimpleEnumerator.idl).
interface nsIPropertyElement {
  readonly key: string;
  readonly value: string;
}
interface nsIStringBundle {
  GetStringFromName(name: string): string;
  getSimpleEnumeration(): Iterable<nsIPropertyElement>;
}
interface nsIStringBundleService {
  createBundle(urlSpec: string): nsIStringBundle;
}

// engine/browser/components/tabbrowser/NewTabPagePreloading.sys.mjs, a browser window global
// (engine/browser/base/content/browser.js): removes the window's preloaded new-tab browser, if
// it has one.
declare var NewTabPagePreloading: { removePreloadedBrowser(window: Window): void };

// engine/dom/chrome-webidl/WebExtensionPolicy.webidl: an installed extension's policy; getByID is
// null for an id that has none. `extension` is the Extension that registered it
// (engine/toolkit/components/extensions/Extension.sys.mjs sets it, an expando of the policy
// object): promiseBackgroundStarted is set on an extension with a background
// (parent/ext-backgroundPage.js); backgroundContext is undefined while it has no background page
// (Extension.sys.mjs), and the page's xulBrowser undefined without a message manager proxy
// (ExtensionParent.sys.mjs).
interface WebExtensionPolicy {
  readonly id: string;
  readonly extension: {
    promiseBackgroundStarted(): Promise<void>;
    readonly backgroundContext: { readonly xulBrowser: MozBrowser | undefined } | undefined;
  };
}
declare var WebExtensionPolicy: {
  prototype: WebExtensionPolicy;
  getByID(id: string): WebExtensionPolicy | null;
};

// engine/browser/components/sidebar/sidebar-history.mjs (SidebarHistory): the History sidebar's
// <sidebar-history>. Its constructor makes `controller`, so it is undefined until the element is
// upgraded. engine/browser/components/firefoxview/HistoryController.sys.mjs: isHistoryPending is
// true until the history has loaded; profileAge, in days, decides the import promo.
interface SidebarHistoryElement extends HTMLElement {
  readonly controller?: { readonly isHistoryPending: boolean; profileAge: number };
}

// engine/toolkit/components/extensions/ExtensionXPCShellUtils.sys.mjs (ExtensionWrapper): what
// ExtensionTestUtils.loadExtension returns, a test extension. startup() and unload() reject when
// the extension is not in the state they start from; awaitMessage resolves with the first
// argument the extension sent with `msg` (browser.test.sendMessage), undefined without one.
interface ExtensionWrapper {
  startup(): Promise<unknown>;
  unload(): Promise<void>;
  awaitMessage(msg: string): Promise<unknown>;
}
// The WebExtension API a test extension's own scripts see as their global `browser`: the members
// they call. runtime.getBrowserInfo resolves with a BrowserInfo
// (engine/toolkit/components/extensions/schemas/runtime.json); test.sendMessage is
// engine/toolkit/components/extensions/schemas/test.json's, which awaitMessage receives.
interface WebExtensionApi {
  readonly runtime: {
    getBrowserInfo(): Promise<{ name: string; vendor: string; version: string; buildID: string }>;
  };
  readonly test: { sendMessage(msg: string, ...args: unknown[]): void };
}

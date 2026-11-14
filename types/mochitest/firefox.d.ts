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
// (ChromeUtils.now()) its buttons' security delay counts from, which an activation or a move of
// the panel sets anew; remove() takes it off its browser.
interface PopupNotification {
  readonly id: string;
  dismissed: boolean;
  timeShown: number;
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
  readonly isInitialDocument: boolean;
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
  handleRevert(): void;
  readonly view: {
    /** The selected row's result: a search suggestion's payload has its text. */
    readonly selectedResult: {
      /** A URL result's payload has its `url` (UrlbarUtils.sys.mjs, RESULT_PAYLOAD_SCHEMA). */
      readonly payload: { readonly suggestion?: string; readonly url?: string };
    } | null;
    readonly selectedElement: Element | null;
  };
}

// engine/toolkit/components/windowwatcher/nsIPromptService.idl; Services.prompt is its service
// (engine/toolkit/components/prompts/src/components.conf, js_name "prompt").
interface nsIPromptService {
  /** Spins a nested event loop until the dialog closes: true for OK, false for Cancel. */
  confirm(parent: Window | null, title: string, text: string): boolean;
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
// ElementCSSInlineStyle).
interface XULElement extends Element, ElementCSSInlineStyle {
  hidden: boolean;
  doCommand(): void;
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

// engine/xpcom/threads/nsITimer.idl
interface nsITimer {
  /** Its delay in ms; setting it on a pending timer reschedules it. */
  delay: number;
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
interface nsIAccessible extends nsISupports {
  readonly name: string;
  readonly description: string;
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
// overflows has its OverflowableToolbar as `overflowable` (registerToolbarNode sets it);
// isHandlingOverflow() is true while it moves items to or from the overflow menu.
interface OverflowableToolbarElement extends XULElement {
  readonly overflowable: { isHandlingOverflow(): boolean };
}

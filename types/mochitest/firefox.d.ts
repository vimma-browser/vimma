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

// engine/toolkit/modules/PopupNotifications.sys.mjs: a notification, or null when there is none.
interface PopupNotificationsApi {
  getNotification(id: string, browser?: MozBrowser): { readonly id: string } | null;
}

// engine/dom/webidl/HTMLInputElement.webidl and HTMLTextAreaElement.webidl (chrome-only): set the
// value as the user's typing would, with input and change events.
interface HTMLInputElement {
  setUserInput(value: string): void;
  /** The field's editor (nsIEditor), null until it has one: its selection controller. */
  readonly editor: { readonly selectionController: { getDisplaySelection(): number } } | null;
}
interface HTMLTextAreaElement {
  setUserInput(value: string): void;
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

// engine/dom/webidl/XULPopupElement.webidl: a <menupopup> or <panel>.
interface XULPopupElement extends Element {
  readonly state: "closed" | "showing" | "open" | "hiding";
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
  readonly currentWindowGlobal: {
    readonly documentURI: { readonly spec: string } | null;
    readonly isInitialDocument: boolean;
  } | null;
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
    readonly selectedResult: { readonly payload: { readonly suggestion?: string } } | null;
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
// command on doCommand.
interface XULElement extends Element {
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

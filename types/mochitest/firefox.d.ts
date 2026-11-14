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

// The slice of Firefox chrome globals our code uses. Extend as needed; the engine tree is the
// source of truth (e.g. engine/xpcom/base/nsIPrefBranch.idl).

// Services and its members are interfaces, so that the browser tests' declarations
// (types/mochitest/) can add the members only the tests use.
interface FirefoxServices {
  prefs: nsIPrefBranch;
  console: nsIConsoleService;
  // engine/netwerk/base/nsIIOService.idl
  io: {
    createExposableURI(uri: { spec: string }): { spec: string; displaySpec: string };
    newURI(spec: string): nsIURI;
    newChannelFromURIWithLoadInfo(uri: unknown, loadInfo: unknown): any;
  };
  // engine/netwerk/dns/nsIEffectiveTLDService.idl
  eTLD: {
    getBaseDomain(uri: unknown, additionalParts?: number): string;
  };
  focus: nsIFocusManager;
  // engine/caps/nsIScriptSecurityManager.idl
  scriptSecurityManager: {
    getSystemPrincipal(): unknown;
    createNullPrincipal(originAttributes: object): unknown;
    createContentPrincipal(uri: nsIURI, originAttributes: object): unknown;
    principalWithOA(principal: unknown, originAttributes: object): unknown;
    checkLoadURIWithPrincipal(principal: unknown, uri: unknown, flags?: number): void;
  };
  clipboard: nsIClipboard;
  // engine/dom/events/nsIEventListenerService.idl
  els: {
    hasListenersFor(target: EventTarget, type: string): boolean;
  };
  // engine/xpcom/threads/nsIThreadManager.idl
  tm: { readonly mainThread: unknown; dispatchToMainThread(task: () => void): void };
  // engine/docshell/base/nsIURIFixup.idl
  uriFixup: {
    getFixupURIInfo(
      text: string,
      flags: number,
    ): { readonly preferredURI: { spec: string } | null };
  };
  appinfo: nsIXULRuntime;
  perms: nsIPermissionManager;
  // engine/toolkit/components/startup/public/nsIAppStartup.idl
  startup: {
    readonly shuttingDown: boolean;
    readonly attemptingQuit: boolean;
    quit(mode: number): void;
    restartInSafeMode(mode: number): void;
  };
  ww: nsIWindowWatcher;
  // engine/toolkit/components/cleardata/nsIClearDataService.idl
  clearData: {
    deleteDataFromOriginAttributesPattern(pattern: { userContextId?: number }): void;
  };
  // engine/toolkit/components/enterprisepolicies/nsIEnterprisePolicies.idl
  policies: { isAllowed(feature: string): boolean };
  logins: nsILoginManager;
  // engine/xpcom/base/nsIVersionComparator.idl
  vc: { compare(a: string, b: string): number };
  obs: nsIObserverService;
  // engine/xpcom/base/nsIUUIDGenerator.idl
  uuid: { generateUUID(): { toString(): string } };
  // engine/xpcom/io/nsIDirectoryService.idl (nsIProperties)
  dirsvc: { get(prop: string, iface: unknown): { readonly path: string } };
  // engine/xpcom/system/nsIEnvironment.idl ("" for an unset variable)
  env: {
    get(name: string): string;
    exists(name: string): boolean;
    set(name: string, value: string): void;
  };
  // engine/xpcom/base/nsIWindowMediator.idl
  wm: {
    getMostRecentWindow(type: "navigator:browser"): BrowserWindow | null;
    getMostRecentWindow(type: string | null): Window | null;
    getEnumerator(type: "navigator:browser"): Iterable<BrowserWindow>;
    getEnumerator(type: string | null): Iterable<Window>;
  };
  // engine/xpcom/ds/nsICategoryManager.idl
  catMan: {
    addCategoryEntry(
      category: string,
      entry: string,
      value: string,
      persist: boolean,
      replace: boolean,
    ): string;
  };
}
declare const Services: FirefoxServices;

// The members Vimma's code calls on a default branch.
interface nsIPrefDefaultBranch {
  setBoolPref(name: string, value: boolean): void;
}

// engine/modules/libpref/nsIPrefBranch.idl; a default branch has the same interface.
interface nsIPrefBranch {
  getBoolPref(name: string, defaultValue?: boolean): boolean;
  getIntPref(name: string, defaultValue?: number): number;
  getStringPref(name: string, defaultValue?: string): string;
  setBoolPref(name: string, value: boolean): void;
  setIntPref(name: string, value: number): void;
  setStringPref(name: string, value: string): void;
  prefHasUserValue(name: string): boolean;
  prefIsLocked(name: string): boolean;
  clearUserPref(name: string): void;
  savePrefFile(file: null): void;
  getDefaultBranch(root: string): nsIPrefDefaultBranch;
  addObserver(
    name: string,
    observer: (subject: unknown, topic: string, data: string) => void,
  ): void;
  removeObserver(
    name: string,
    observer: (subject: unknown, topic: string, data: string) => void,
  ): void;
}

// engine/xpcom/base/nsIConsoleService.idl: its cached messages, of any kind (each use checks
// for nsIScriptError, engine/dom/bindings/nsIScriptError.idl).
interface nsIConsoleService {
  getMessageArray(): any[] | null;
}

// engine/dom/interfaces/base/nsIFocusManager.idl
interface nsIFocusManager {
  readonly focusedElement: Element | null;
  readonly focusedContentBrowsingContext: any;
  readonly activeWindow: Window | null;
  clearFocus(window: Window): void;
}

// engine/widget/nsIClipboard.idl
interface nsIClipboard {
  readonly kGlobalClipboard: number;
  getData(transferable: unknown, whichClipboard: number): void;
}

// engine/xpcom/system/nsIXULRuntime.idl
interface nsIXULRuntime {
  readonly processID: number;
  readonly version: string;
  readonly appBuildID: string;
  readonly OS: string;
  readonly XPCOMABI: string;
  readonly isWayland: boolean;
  readonly inSafeMode: boolean;
}

// engine/netwerk/base/nsIPermissionManager.idl
interface nsIPermissionManager {
  readonly UNKNOWN_ACTION: number;
  readonly ALLOW_ACTION: number;
  readonly DENY_ACTION: number;
  testPermissionFromPrincipal(principal: unknown, type: string): number;
  testExactPermissionFromPrincipal(principal: unknown, type: string): number;
  addFromPrincipal(
    principal: unknown,
    type: string,
    permission: number,
    expireType?: number,
    expireTime?: number,
  ): void;
  addFromPrincipalForBrowser(
    principal: unknown,
    type: string,
    permission: number,
    browserId: number,
    expireTimeMS?: number,
  ): void;
}

// engine/xpcom/ds/nsIObserverService.idl
interface nsIObserverService {
  addObserver(
    observer: (subject: unknown, topic: string, data: string | null) => void,
    topic: string,
  ): void;
  removeObserver(
    observer: (subject: unknown, topic: string, data: string | null) => void,
    topic: string,
  ): void;
  notifyObservers(subject: unknown, topic: string, data?: string): void;
}

// engine/toolkit/components/windowwatcher/nsIWindowWatcher.idl
interface nsIWindowWatcher {
  registerNotification(
    observer: (subject: unknown, topic: string, data: string | null) => void,
  ): void;
  unregisterNotification(
    observer: (subject: unknown, topic: string, data: string | null) => void,
  ): void;
}

// engine/toolkit/components/passwordmgr/nsILoginManager.idl
interface nsILoginManager {
  searchLoginsAsync(matchData: object): Promise<nsILoginInfo[]>;
  addLoginAsync(login: nsILoginInfo): Promise<nsILoginInfo>;
  modifyLoginAsync(oldLogin: nsILoginInfo, newLogin: nsILoginInfo): Promise<nsILoginInfo>;
  removeLoginAsync(login: nsILoginInfo): Promise<void>;
}

// XPCOM component classes and results (engine/js/xpconnect). Untyped on purpose: each use
// names its interface, and the IDL in the engine tree is the reference.
declare const Cc: any;
declare const Cr: Record<string, number>;

// engine/dom/chrome-webidl/PathUtils.webidl
declare const PathUtils: {
  readonly profileDir: string;
  readonly tempDir: string;
  join(...components: string[]): string;
  parent(path: string, depth?: number): string | null;
  filename(path: string): string;
  toFileURI(path: string): string;
  isAbsolute(path: string): boolean;
};

// engine/dom/chrome-webidl/IOUtils.webidl
interface IOUtilsNamespace {
  createUniqueFile(parent: string, prefix: string, permissions?: number): Promise<string>;
  createUniqueDirectory(parent: string, prefix: string, permissions?: number): Promise<string>;
  writeUTF8(
    path: string,
    data: string,
    options?: { mode?: "overwrite" | "append" | "appendOrCreate" | "create"; tmpPath?: string },
  ): Promise<number>;
  write(
    path: string,
    data: Uint8Array,
    options?: { mode?: "overwrite" | "append" | "appendOrCreate" | "create"; flush?: boolean },
  ): Promise<number>;
  setPermissions(path: string, permissions: number, honorUmask?: boolean): Promise<void>;
  makeDirectory(
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean; permissions?: number },
  ): Promise<void>;
  readUTF8(path: string): Promise<string>;
  read(path: string, options?: { offset?: number; maxBytes?: number }): Promise<Uint8Array>;
  stat(path: string): Promise<{
    size: number;
    lastModified: number;
    creationTime?: number;
    permissions: number;
    type: "regular" | "directory" | "other";
  }>;
  exists(path: string): Promise<boolean>;
  getChildren(path: string): Promise<string[]>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean; recursive?: boolean }): Promise<void>;
}
declare const IOUtils: IOUtilsNamespace;

// engine/js/xpconnect/idl/xpccomponents.idl (nsIXPCComponents_Utils); the encoder is
// engine/dom/serializers/nsIDocumentEncoder.idl.
interface XPCComponentsUtils {
  readonly isInAutomation: boolean;
  createDocumentEncoder(type: string): {
    init(doc: Document, type: string, flags: number): void;
    setRange(range: Range): void;
    setContainerNode(node: Node): void;
    encodeToString(): string;
  };
  // The PDF viewer's adapter (actors/pdf-view.mjs; xpccomponents.idl).
  waiveXrays<T>(obj: T): any;
  unwaiveXrays<T>(obj: T): any;
  exportFunction(fn: Function, target: object): Function;
  cloneInto<T>(obj: T, target: object, options?: { cloneFunctions?: boolean }): T;
}
declare const Cu: XPCComponentsUtils;

// XPCOM in system modules: interface constants and component constructors.
declare const Ci: any;
declare const Components: {
  Constructor(cid: string, iface: string, init?: string): any;
  ID(id: string): unknown;
  readonly manager: any;
  isSuccessCode(code: number): boolean;
  // The calling script's frame (xpccomponents.idl, nsIStackFrame): host/host-services.mjs checks
  // that only vimma.js provides the host's services.
  readonly stack: {
    readonly filename: string;
    readonly caller: { readonly filename: string } | null;
  };
};

// engine/dom/chrome-webidl/BrowsingContext.webidl
declare const BrowsingContext: {
  get(id: number): any;
  getCurrentTopByBrowserId(id: number): any;
};

// engine/dom/webidl/URL.webidl (chrome-only)
interface URL {
  readonly URI: unknown;
}

// engine/dom/chrome-webidl/ChromeUtils.webidl
declare const ChromeUtils: {
  importESModule(url: string): any;
  // `target` is a module's `lazy` object, typed with Lazy<…> below: its names and the module
  // map's must match.
  defineESModuleGetters<T extends object>(target: T, modules: { [K in keyof T]: string }): void;
  registerWindowActor(name: string, options: object): void;
  generateQI(interfaces: string[]): (iid: unknown) => any;
  now(): number;
  getXPCOMErrorName(code: number): string;
  /** The parent process first, then every live content process (nsIDOMProcessParent). */
  getAllDOMProcesses(): { readonly remoteType: string | null; readonly childID: number }[];
};

// engine/dom/webidl/Window.webidl (chrome-only part)
interface Window {
  readonly browsingContext: any;
}

// engine/dom/chrome-webidl/JSWindowActor.webidl
declare class JSWindowActorParent {
  readonly browsingContext: any;
  /** engine/dom/chrome-webidl/WindowGlobalActors.webidl (WindowGlobalParent) */
  readonly manager: { readonly isInProcess: boolean; readonly innerWindowId: number };
  sendAsyncMessage(name: string, data?: unknown): void;
  sendQuery(name: string, data?: unknown): Promise<any>;
}
// engine/dom/webidl/Worker.webidl (ChromeWorker): a Worker with chrome privileges (system modules)
declare class ChromeWorker extends Worker {}
declare class JSWindowActorChild {
  readonly browsingContext: any;
  readonly document: Document;
  readonly contentWindow: Window | null;
  // WindowGlobalChild: the other actors of this frame (spec m1-find: Firefox's FinderChild)
  readonly manager: {
    getActor(name: string): any;
    readonly innerWindowId: number;
    readonly isCurrentGlobal: boolean;
  };
  // The frame's nsIDocShell (spec m1-copy-mode: its nsISelectionController)
  readonly docShell: any;
  sendAsyncMessage(name: string, data?: unknown): void;
  sendQuery(name: string, data?: unknown): Promise<any>;
}

// engine/dom/base/nsISelectionController.idl (the members copy mode uses)
interface nsISelectionController {
  setDisplaySelection(toggle: number): void;
  setCaretEnabled(enabled: boolean): void;
  setCaretVisibilityDuringSelection(visibility: boolean): void;
  characterMove(forward: boolean, extend: boolean): void;
  wordMove(forward: boolean, extend: boolean): void;
  lineMove(forward: boolean, extend: boolean): void;
  intraLineMove(forward: boolean, extend: boolean): void;
  completeMove(forward: boolean, extend: boolean): void;
  paragraphMove(forward: boolean, extend: boolean): void;
  scrollSelectionIntoView(type: number, region: number, flags: number): void;
}

// engine/dom/base/nsISelectionListener.idl (spec m1-copy-mode: mouse selection)
interface nsISelectionListener {
  notifySelectionChanged(doc: Document, sel: Selection, reason: number, amount?: number): void;
}

// engine/dom/webidl/Selection.webidl (chrome-only part)
interface Selection {
  addSelectionListener(listener: nsISelectionListener): void;
  removeSelectionListener(listener: nsISelectionListener): void;
}

// engine/dom/interfaces/base/nsIDOMWindowUtils.idl
interface Window {
  readonly windowUtils: nsIDOMWindowUtils;
}
interface nsIDOMWindowUtils {
  readonly AGENT_SHEET: number;
  readonly AUTHOR_SHEET: number;
  loadSheetUsingURIString(sheetURI: string, type: number): void;
  removeSheetUsingURIString(sheetURI: string, type: number): void;
  suppressAnimation(suppress: boolean): void;
  flushLayoutWithoutThrottledAnimations(): void;
  /** True while an event the user caused (a key, a click) is being handled. */
  readonly isHandlingUserInput: boolean;
  nodesFromRect(
    x: number,
    y: number,
    top: number,
    right: number,
    bottom: number,
    left: number,
    ignoreRootScrollFrame: boolean,
    flushLayout: boolean,
    onlyVisible: boolean,
    transparencyThreshold?: number,
  ): NodeList;
}

// engine/dom/webidl/Element.webidl, Node.webidl and Event.webidl (chrome-only members)
interface Element {
  readonly openOrClosedShadowRoot: ShadowRoot | null;
  readonly scrollTopMax: number;
  readonly scrollLeftMax: number;
}
interface Node {
  readonly ownerGlobal: Window;
}
interface Event {
  readonly originalTarget: EventTarget | null;
}
// engine/dom/webidl/Document.webidl (chrome-only), the FullscreenKeyboardLock enum of
// Element.webidl
interface Document {
  readonly fullscreenKeyboardLock: "none" | "browser";
  // engine/dom/interfaces/xul/nsIDOMXULCommandDispatcher.idl (chrome documents)
  readonly commandDispatcher: {
    readonly focusedElement: Element | null;
    getControllerForCommand(command: string): {
      isCommandEnabled(command: string): boolean;
      doCommand(command: string): void;
    } | null;
  } | null;
  // engine/netwerk/base/nsILoadGroup.idl (an nsISimpleEnumerator of its requests)
  readonly documentLoadGroup: { readonly requests: Iterable<unknown> } | null;
  consumeTransientUserGestureActivation(): boolean;
}
interface Node {
  // engine/caps/nsIPrincipal.idl
  readonly nodePrincipal: { readonly isSystemPrincipal: boolean };
}

// The exports Vimma's modules read through ChromeUtils.defineESModuleGetters, by export name (each
// name is exported by one module). A module's `lazy` object is
// `/** @type {Lazy<"setTimeout" | "PrivateBrowsingUtils">} */ ({})`: the getters fill it on the
// next line, which is why the empty object may be asserted to the full shape. Firefox modules
// list only the members Vimma calls; `any` marks a module Vimma uses beyond a few members whose
// shape is not typed here yet.
interface LazyModules {
  // engine/toolkit/modules/Timer.sys.mjs: ids are numbers; clearing an unknown id (null, a
  // finished timer) does nothing. The callback gets the extra arguments (a promise's resolve
  // takes one, or none).
  setTimeout(callback: (...args: never[]) => unknown, ms?: number, ...args: unknown[]): number;
  setInterval(callback: () => unknown, ms?: number): number;
  clearTimeout(id: number | null | undefined): void;
  clearInterval(id: number | null | undefined): void;
  // engine/toolkit/modules/PrivateBrowsingUtils.sys.mjs
  PrivateBrowsingUtils: {
    isWindowPrivate(win: Window): boolean;
    readonly permanentPrivateBrowsing: boolean;
    readonly enabled: boolean;
  };
  // engine/toolkit/modules/AppConstants.sys.mjs
  AppConstants: {
    readonly MOZ_APP_VERSION_DISPLAY: string;
    readonly MOZ_UPDATER: boolean;
    readonly MOZ_UPDATE_CHANNEL: string;
    readonly platform: string;
  };
  // engine/browser/modules/BrowserWindowTracker.sys.mjs
  BrowserWindowTracker: {
    readonly orderedWindows: BrowserWindow[];
    getTopWindow(options?: { private?: boolean; allowPopups?: boolean }): BrowserWindow | null;
  };
  // engine/browser/components/sessionstore/SessionStore.sys.mjs; the closed tab and window data
  // are SessionStore's own JSON records, read field by field with fallbacks.
  SessionStore: {
    getTabState(tab: MozTabbrowserTab): string;
    isTabRestoring(tab: MozTabbrowserTab): boolean;
    getCustomTabValue(tab: MozTabbrowserTab, key: string): string;
    setCustomTabValue(tab: MozTabbrowserTab, key: string, value: string): void;
    getCustomWindowValue(win: Window, key: string): string;
    setCustomWindowValue(win: Window, key: string, value: string): void;
    getClosedTabDataForWindow(win: Window): any[];
    getClosedTabData(options?: { private?: boolean }): any[];
    getClosedWindowData(): any[];
    undoCloseById(closedId: number, includePrivate?: boolean, targetWindow?: Window): unknown;
  };
  // engine/toolkit/modules/OSKeyStore.sys.mjs
  OSKeyStore: {
    encrypt(plainText: string): Promise<string>;
    decrypt(cipherText: string, trigger?: string | boolean, reauth?: boolean): Promise<string>;
  };
  // engine/toolkit/modules/FileUtils.sys.mjs (an nsIFile constructor)
  FileUtils: { File: new (path: string) => any };
  // engine/netwerk/base/NetUtil.sys.mjs
  NetUtil: { newURI(spec: string, charset?: string | null, base?: unknown): nsIURI };
  // engine/toolkit/modules/UpdateUtils.sys.mjs
  UpdateUtils: { readonly ABI: string; readonly UpdateChannel: string };
  // engine/browser/components/customizableui/CustomizableUI.sys.mjs
  CustomizableUI: { setToolbarVisibility(toolbarId: string, visible: boolean | string): void };
  // engine/browser/modules/BrowserUIUtils.sys.mjs
  BrowserUIUtils: { checkEmptyPageOrigin(browser: MozBrowser, uri?: unknown): boolean };
  // engine/browser/modules/URILoadingHelper.sys.mjs
  URILoadingHelper: { guessUserContextId(uri: unknown): number | null };
  // engine/browser/components/urlbar/UrlbarUtils.sys.mjs
  UrlbarUtils: {
    getShortcutOrURIAndPostData(
      url: string,
    ): Promise<{ url: string; postData: unknown; mayInheritPrincipal: boolean }>;
  };
  // engine/toolkit/components/asyncshutdown/AsyncShutdown.sys.mjs
  AsyncShutdown: {
    profileBeforeChange: { addBlocker(name: string, condition: () => unknown): void };
  };
  // engine/toolkit/modules/E10SUtils.sys.mjs
  E10SUtils: { deserializePrincipal(base64: string): unknown };

  // Untyped: wide Firefox APIs Vimma drives in depth (downloads, add-ons, permissions, form
  // autofill, search, containers, js-ctypes and subprocesses).
  AboutNewTab: any;
  AddonManager: any;
  AutofillFormFactory: any;
  ContextualIdentityService: any;
  DownloadHistory: any;
  DownloadIntegration: any;
  DownloadPaths: any;
  Downloads: any;
  DownloadsCommon: any;
  ExtensionPermissions: any;
  FormAutofillHeuristics: any;
  FormAutofillUtils: any;
  Integration: any;
  JSONFile: any;
  PopupAndRedirectBlockerObserver: any;
  SearchService: any;
  SitePermissions: any;
  Subprocess: any;
  UrlbarSearchUtils: any;
  ctypes: any;
  nsContentDispatchChooser: any;
  nsUnknownContentTypeDialog: any;
  // Its per-window count of PiP windows is compared with `> 0`, a window without one (no entry,
  // undefined) counting as none.
  PictureInPicture: any;

  // Vimma's own modules, imported lazily to break a load cycle.
  AgentChat: typeof import("../src/browser/base/content/vimma/agent/AgentChat.sys.mjs").AgentChat;
  AgentCli: typeof import("../src/browser/base/content/vimma/agent/AgentCli.sys.mjs").AgentCli;
  AgentDownloads: typeof import("../src/browser/base/content/vimma/ctl/AgentDownloads.sys.mjs").AgentDownloads;
  AgentGate: typeof import("../src/browser/base/content/vimma/ctl/AgentGate.sys.mjs").AgentGate;
  AgentKeys: typeof import("../src/browser/base/content/vimma/agent/AgentKeys.sys.mjs").AgentKeys;
  ConfigHost: typeof import("../src/browser/base/content/vimma/config/ConfigHost.sys.mjs").ConfigHost;
  McpHost: typeof import("../src/browser/base/content/vimma/host/mcp-ops.mjs").McpHost;
  ThemeHost: typeof import("../src/browser/base/content/vimma/ui/theme-host.mjs").ThemeHost;
  VimmaControl: typeof import("../src/browser/base/content/vimma/ctl/VimmaControl.sys.mjs").VimmaControl;
  VimmaHost: typeof import("../src/browser/base/content/vimma/host/VimmaHost.sys.mjs").VimmaHost;
  WorkspaceRouter: typeof import("../src/browser/base/content/vimma/workspaces/WorkspaceRouter.sys.mjs").WorkspaceRouter;
}

/** A module's `lazy` object: the named exports ChromeUtils.defineESModuleGetters defines on it. */
type Lazy<K extends keyof LazyModules> = { readonly [P in K]: LazyModules[P] };

// engine/toolkit/components/passwordmgr/nsILoginInfo.idl
interface nsILoginInfo {
  readonly username: string;
  readonly password: string;
  init(
    origin: string,
    formActionOrigin: string | null,
    httpRealm: string | null,
    username: string,
    password: string,
    usernameField?: string,
    passwordField?: string,
  ): void;
}

// engine/netwerk/base/nsIURI.idl (the members Vimma reads)
interface nsIURI {
  readonly spec: string;
  readonly specIgnoringRef: string;
  readonly displaySpec: string;
  readonly scheme: string;
  /** Throws for a URI without a host (about:, data:); callers read it inside a try. */
  readonly host: string;
  schemeIs(scheme: string): boolean;
}

// engine/dom/webidl/Window.webidl: every window's own constructors (a page's differ from
// chrome's, so code reaching into a content window builds its objects with these).
interface Window {
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver: typeof ResizeObserver;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly Event: typeof Event;
  readonly docShell: any;
  fullScreen: boolean;
}

// engine/dom/webidl/Window.webidl (the ChromeWindow part): a top-level chrome window.
interface ChromeWindow extends Window {
  readonly windowState: number;
  readonly isFullyOccluded: boolean;
  getAttention(): void;
  maximize(): void;
  restore(): void;
}

// engine/toolkit/content/widgets/browser-custom-element.mjs (MozBrowser): a <browser>.
interface MozBrowser extends Element {
  readonly browsingContext: any;
  /** Null while the browser has no docshell or remote navigation yet. */
  readonly currentURI: nsIURI | null;
  readonly documentURI: { readonly spec: string } | null;
  readonly contentTitle: string;
  readonly isRemoteBrowser: boolean;
  readonly webProgress: any;
  readonly browserId: number;
  readonly documentContentType: string | null;
  /** Null for a non-remote browser without a docshell. */
  readonly finder: MozFinder | null;
  // engine/caps/nsIPrincipal.idl; read through Vimma's own checks.
  readonly contentPrincipal: any;
  // engine/browser/modules/PopupAndRedirectBlocker.sys.mjs (untyped here)
  readonly popupAndRedirectBlocker: any;
  focus(): void;
  reload(): void;
  loadURI(uri: nsIURI, params: { triggeringPrincipal: unknown }): void;
}

// A tab's <browser>. A lazy one answers currentURI from session data (Tabbrowser.sys.mjs,
// createLazyBrowser's getters); a live one is remote or has a docshell. Either way currentURI
// and finder are set.
interface MozTabBrowser extends MozBrowser {
  readonly currentURI: nsIURI;
  readonly finder: MozFinder;
}

// engine/browser/components/tabbrowser/content/tab.mjs (MozTabbrowserTab): a tab.
interface MozTabbrowserTab extends Element {
  readonly linkedBrowser: MozTabBrowser;
  /** Null for a lazy tab, which has no browser yet (Tabbrowser.insertBrowser; tabbox.js). */
  readonly linkedPanel: string | null;
  /** The tab's position among all tabs (Tabbrowser `tabIndex` options take it). */
  readonly index: number;
  readonly label: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly closing: boolean;
  readonly selected: boolean;
  readonly userContextId: number;
  readonly soundPlaying: boolean;
  readonly muted: boolean;
  readonly muteReason: string | null | undefined;
  readonly splitview: MozTabSplitViewWrapper | null;
  readonly ownerGlobal: BrowserWindow;
  toggleMuteAudio(muteReason?: string | null): void;
}

// engine/browser/components/tabbrowser/content/tabsplitview.mjs
interface MozTabSplitViewWrapper extends Element {
  readonly splitViewId: number;
  readonly tabs: MozTabbrowserTab[];
  unsplitTabs(): void;
}

// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs: a browser window's gBrowser.
interface Tabbrowser {
  readonly tabs: MozTabbrowserTab[];
  readonly visibleTabs: MozTabbrowserTab[];
  readonly browsers: MozTabBrowser[];
  selectedTab: MozTabbrowserTab;
  readonly selectedBrowser: MozTabBrowser;
  readonly pinnedTabCount: number;
  readonly tabContainer: Element & { selectedIndex: number };
  readonly tabbox: Element;
  getTabForBrowser(browser: MozBrowser): MozTabbrowserTab | undefined;
  insertBrowser(tab: MozTabbrowserTab): void;
  hideTab(tab: MozTabbrowserTab, source?: string): void;
  showTab(tab: MozTabbrowserTab): void;
  unpinTab(tab: MozTabbrowserTab): void;
  removeTab(tab: MozTabbrowserTab, options?: TabbrowserRemoveOptions): void;
  removeCurrentTab(options?: TabbrowserRemoveOptions): void;
  addTab(url: string, options?: TabbrowserAddOptions): MozTabbrowserTab;
  addTrustedTab(url: string, options?: TabbrowserAddOptions): MozTabbrowserTab;
  addProgressListener(listener: object): void;
  removeProgressListener(listener: object): void;
  addTabsProgressListener(listener: object): void;
  removeTabsProgressListener(listener: object): void;
  updateTitlebar(): void;
  getCachedFindBar(tab?: MozTabbrowserTab): MozFindbar | undefined;
  /** Null when the window or the tab closes before the find bar is made. */
  getFindBar(tab?: MozTabbrowserTab): Promise<MozFindbar | null>;
  readNotificationBox(browser?: MozBrowser): any;
  moveTabForward(options?: { metricsContext?: unknown }): void;
  moveTabBackward(options?: { metricsContext?: unknown }): void;
  // engine/browser/components/tabbrowser/TabMetrics.sys.mjs
  readonly TabMetrics: {
    readonly METRIC_SOURCE: { readonly KEYBOARD: string };
    userTriggeredContext(source?: string): unknown;
  };
}
interface TabbrowserRemoveOptions {
  animate?: boolean;
  skipPermitUnload?: boolean;
  closeWindowWithLastTab?: boolean;
}
interface TabbrowserAddOptions {
  triggeringPrincipal?: unknown;
  userContextId?: number;
  skipAnimation?: boolean;
  inBackground?: boolean;
  tabIndex?: number;
  createLazyBrowser?: boolean;
  lazyTabTitle?: string;
  ownerTab?: MozTabbrowserTab | null;
  relatedToCurrent?: boolean;
}

// engine/browser/base/content/browser.js and the scripts browser.xhtml loads: a browser window.
interface BrowserWindow extends ChromeWindow {
  readonly gBrowser: Tabbrowser;
  // engine/browser/components/urlbar/content/UrlbarInput.mjs
  readonly gURLBar: HTMLElement & { focused: boolean; view: { isOpen: boolean }; select(): void };
  readonly gNavToolbox: Element;
  readonly BROWSER_NEW_TAB_URL: string;
  // browser-init.js
  readonly gBrowserInit: { readonly delayedStartupFinished: boolean };
  readonly delayedStartupPromise: Promise<void>;
  // tab-bar-visibility.js
  readonly TabBarVisibility: { update(force?: boolean): void };
  // browser.js (a lazy getter: PopupNotifications.sys.mjs)
  readonly PopupNotifications: PopupNotificationsApi;
  UpdatePopupNotificationsVisibility(): void;
  isInitialPage(url: nsIURI | string): boolean;
  switchToTabHavingURI(
    uri: string,
    openNew?: boolean,
    params?: { relatedToCurrent?: boolean; triggeringPrincipal?: unknown },
  ): boolean;
  // utilityOverlay.js
  openTrustedLinkIn(
    url: string,
    where: string,
    params?: { userContextId?: number; inBackground?: boolean },
  ): void;
  // toolkit globalOverlay.js and contentAreaUtils.js
  goQuitApplication(event?: { ctrlKey?: boolean; metaKey?: boolean }): boolean;
  DownloadURL(url: string, fileName: string | null, initiatingDocument: Document): void;
  // browser-addons.js: extension UI, untyped here (WebExtension internals)
  readonly gUnifiedExtensions: any;
  readonly BrowserAddonUI: { manageAddon(addonId: string, source?: string): Promise<void> };
}

// engine/toolkit/modules/PopupNotifications.sys.mjs (the members Vimma reads)
interface PopupNotificationsApi {
  readonly panel: Element & { readonly state: string };
}

// A browser window from its first script, before its body exists: browser-main.js creates
// gBrowser at DOMContentLoaded, and PopupNotifications needs the document. Code that runs this
// early (the status bar, tab strip and toolbar) guards these members.
type EarlyBrowserWindow = Omit<
  BrowserWindow,
  "gBrowser" | "PopupNotifications" | "UpdatePopupNotificationsVisibility"
> &
  Partial<
    Pick<BrowserWindow, "gBrowser" | "PopupNotifications" | "UpdatePopupNotificationsVisibility">
  >;

// engine/toolkit/content/widgets/findbar.js
interface MozFindbar extends Element {
  hidden: boolean;
  readonly FIND_NORMAL: number;
  readonly _findField: HTMLInputElement;
  readonly _typeAheadCaseSensitive: number;
  open(mode?: number): boolean;
  close(noAnim?: boolean): void;
  onFindAgainCommand(findPrevious: boolean): void;
}

// engine/toolkit/modules/FinderParent.sys.mjs (a <browser>'s finder)
interface MozFinder {
  set caseSensitive(sensitive: boolean);
  addResultListener(listener: object): void;
  removeResultListener(listener: object): void;
  findAgain(query: string, backward: boolean, linksOnly: boolean, outline: boolean): void;
  requestMatchesCount(query: string, args: object): void;
  removeSelection(keepHighlight?: boolean): void;
}

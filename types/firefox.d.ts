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
    newChannelFromURIWithLoadInfo(uri: nsIURI, loadInfo: nsILoadInfo): nsIChannel;
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
  uuid: { generateUUID(): nsID };
  // engine/xpcom/io/nsIDirectoryService.idl (nsIProperties)
  dirsvc: { get<T>(prop: string, iface: nsIJSIID<T>): T };
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
  catMan: nsICategoryManager;
}
// engine/xpcom/components/nsICategoryManager.idl
interface nsICategoryManager {
  addCategoryEntry(
    category: string,
    entry: string,
    value: string,
    persist: boolean,
    replace: boolean,
  ): string;
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
// for nsIScriptError; nsIConsoleMessage below).
interface nsIConsoleService {
  getMessageArray(): nsIConsoleMessage[] | null;
}

// engine/dom/interfaces/base/nsIFocusManager.idl
interface nsIFocusManager {
  readonly focusedElement: Element | null;
  /** Parent-process only: the content frame with focus, if any. */
  readonly focusedContentBrowsingContext: CanonicalBrowsingContext | null;
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

// XPCOM component classes (engine/js/xpconnect): XPCOMClasses below, by contract ID.
declare const Cc: XPCOMClasses;
// XPCOM results (engine/xpcom/base/ErrorList.py): the codes Vimma names, and any other by name.
declare const Cr: Record<string, number> & {
  readonly NS_BINDING_ABORTED: number;
  readonly NS_OK: number;
};

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
  // The PDF viewer's adapter (actors/pdf-view.mjs; xpccomponents.idl). Waived, an object shows
  // what the page's own scripts set on it, which no type describes: the caller checks each value
  // it reads. Unwaived, it is the Xray view again.
  waiveXrays(obj: object): { readonly [name: string]: unknown };
  unwaiveXrays<T>(obj: T): T;
  exportFunction(fn: Function, target: object): Function;
  cloneInto<T>(obj: T, target: object, options?: { cloneFunctions?: boolean }): T;
}
declare const Cu: XPCComponentsUtils;

// XPCOM in system modules: interface ids (XPCOMInterfaces below) and component constructors.
declare const Ci: XPCOMInterfaces;
declare const Components: {
  // engine/js/xpconnect/src/XPCComponents.cpp (nsXPCComponents_Constructor): `new` makes the
  // contract's object as `iface`, then calls its `init` method with the arguments.
  Constructor<K extends keyof XPCOMInterfaces>(
    contract: keyof XPCOMClasses,
    iface: K,
  ): new () => XPCOMInstance<K>;
  Constructor<K extends keyof XPCOMInterfaces, I extends XPCOMMethodName<XPCOMInstance<K>>>(
    contract: keyof XPCOMClasses,
    iface: K,
    init: I,
  ): new (
    ...args: XPCOMInstance<K>[I] extends (...args: infer A) => unknown ? A : never
  ) => XPCOMInstance<K>;
  ID(id: string): nsID;
  readonly manager: nsIComponentManager;
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
  /** Null when no context has the id; in the parent process a CanonicalBrowsingContext. */
  get(id: number): BrowsingContext | null;
  /** Called in the parent process, where a context is canonical. */
  getCurrentTopByBrowserId(id: number): CanonicalBrowsingContext | null;
};

// engine/dom/webidl/URL.webidl (chrome-only)
interface URL {
  readonly URI: nsIURI;
}

// Vimma's own modules by chrome:// URL, typed as their source modules. Empty here, so the
// product's ChromeUtils.importESModule calls return `any` as before; the browser tests' program
// (tests/tsconfig.json) fills it from the generated types/mochitest/modules.d.ts.
interface VimmaModules {}

// engine/dom/chrome-webidl/ChromeUtils.webidl
declare const ChromeUtils: {
  // A literal URL of one of VimmaModules gets that module's type; any other (Firefox's own
  // modules, a URL held in a variable) stays `any`. Where VimmaModules is filled (the browser
  // tests), a literal Vimma URL that is not one of them (a typo, a module jar.mn does not ship)
  // matches neither and is an error; the product's program, with it empty, takes any URL.
  importESModule<U extends keyof VimmaModules>(url: U): VimmaModules[U];
  importESModule<S extends string>(
    url: S extends `chrome://browser/content/vimma/${string}`
      ? [keyof VimmaModules] extends [never]
        ? S
        : never
      : S,
  ): any;
  // `target` is a module's `lazy` object, typed with Lazy<…> below: its names and the module
  // map's must match.
  defineESModuleGetters<T extends object>(target: T, modules: { [K in keyof T]: string }): void;
  registerWindowActor(name: string, options: object): void;
  /** A QueryInterface for a JS object that implements `interfaces` (and nsISupports). */
  generateQI(interfaces: (keyof XPCOMInterfaces)[]): nsISupports["QueryInterface"];
  now(): number;
  getXPCOMErrorName(code: number): string;
  /** The parent process first, then every live content process (nsIDOMProcessParent). */
  getAllDOMProcesses(): nsIDOMProcessParent[];
};

// engine/dom/webidl/Window.webidl: never null. A chrome window's, in the parent, is canonical.
interface Window {
  readonly browsingContext: BrowsingContext;
}

// engine/dom/chrome-webidl/JSWindowActor.webidl
declare class JSWindowActorParent {
  /**
   * The webidl says nullable, but the getter throws (InvalidStateError) while the actor has no
   * manager, before it is set up and once it is cleared, rather than give null
   * (engine/dom/ipc/jsactor/JSWindowActorParent.cpp, GetBrowsingContext).
   */
  readonly browsingContext: CanonicalBrowsingContext | null;
  /** Its document's window global; null before the actor is set up and once it is cleared. */
  readonly manager: WindowGlobalParent | null;
  sendAsyncMessage(name: string, data?: unknown): void;
  /** The child's answer, from a content process that may be compromised: checked by the caller. */
  sendQuery(name: string, data?: unknown): Promise<unknown>;
}
// engine/dom/webidl/Worker.webidl (ChromeWorker): a Worker with chrome privileges (system modules)
declare class ChromeWorker extends Worker {}
declare class JSWindowActorChild {
  /**
   * The webidl says nullable, but the getter throws (InvalidStateError) while the actor has no
   * manager rather than give null, and a manager always has a context
   * (engine/dom/ipc/jsactor/JSWindowActorChild.cpp, GetBrowsingContext).
   */
  readonly browsingContext: BrowsingContext;
  readonly document: Document;
  readonly contentWindow: Window | null;
  // WindowGlobalChild: the other actors of this frame (spec m1-find: Firefox's FinderChild)
  readonly manager: {
    // engine/toolkit/actors/FinderChild.sys.mjs, registered for every frame
    // (engine/toolkit/modules/ActorManagerParent.sys.mjs)
    getActor(name: "Finder"): FinderChildActor;
    // engine/toolkit/actors/AutoCompleteChild.sys.mjs; throws in a frame it is not registered for
    getActor(name: "AutoComplete"): AutoCompleteChildActor;
    getActor(name: string): JSWindowActorChild;
    readonly innerWindowId: number;
    readonly isCurrentGlobal: boolean;
  };
  /**
   * The frame's nsIDocShell (spec m1-copy-mode: its nsISelectionController): null once the
   * frame's context has lost it, as a discarded one has (JSWindowActorChild.cpp, GetDocShell).
   */
  readonly docShell: nsIDocShell | null;
  sendAsyncMessage(name: string, data?: unknown): void;
  /** The parent actor's answer to one of Vimma's queries (host/VimmaParent.sys.mjs). */
  sendQuery<K extends keyof VimmaChildQueries>(
    name: K,
    data?: unknown,
  ): Promise<VimmaChildQueries[K]>;
  sendQuery(name: string, data?: unknown): Promise<unknown>;
}
// What VimmaParent answers its child's queries with (host/VimmaParent.sys.mjs).
interface VimmaChildQueries {
  /** The theme's token sheet, null for any actor but the top viewer's current one (V12). */
  "Vimma:PdfTheme": string | null;
}
// engine/toolkit/actors/AutoCompleteChild.sys.mjs: the frame's autocomplete popup is open.
interface AutoCompleteChildActor {
  readonly popupOpen: boolean;
}
// engine/docshell/base/nsIDocShell.idl and nsIDocShellTreeItem.idl (the members Vimma uses);
// isLoadingDocument is nsIWebProgress's, which a docshell also is.
interface nsIDocShell extends nsISupports {
  /** Null once the docshell is destroyed (nsIDocShellTreeItem.idl). */
  readonly treeOwner: nsISupports | null;
  readonly isLoadingDocument: boolean;
  doCommand(command: string): void;
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
  /** The slot it is assigned to, in an open or a closed shadow tree. */
  readonly openOrClosedAssignedSlot: HTMLSlotElement | null;
  readonly scrollTopMax: number;
  readonly scrollLeftMax: number;
}
interface Node {
  /** The global of the document the node lives in (Node.webidl, ChromeOnly). */
  readonly documentGlobal: Window | null;
}
interface Text {
  /** The slot it is assigned to, in an open or a closed shadow tree. */
  readonly openOrClosedAssignedSlot: HTMLSlotElement | null;
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
  readonly nodePrincipal: nsIPrincipal;
}
// engine/caps/nsIPrincipal.idl
interface nsIPrincipal {
  /** The origin with the host cut to its site (scheme and eTLD+1); the origin otherwise. */
  readonly siteOrigin: string;
  readonly isSystemPrincipal: boolean;
  readonly isNullPrincipal: boolean;
  readonly isContentPrincipal: boolean;
  /** Null for a principal without one, as the system principal. */
  readonly URI: nsIURI | null;
  /** Webidl `jsval`: an OriginAttributesDictionary (OriginAttributes.webidl). */
  readonly originAttributes: { readonly userContextId: number; readonly privateBrowsingId: number };
  readonly originNoSuffix: string;
  /** These three may throw where the principal's URI has no such part: read in a try. */
  readonly host: string;
  readonly asciiHost: string;
  readonly baseDomain: string;
  readonly exposablePrePath: string;
  readonly privateBrowsingId: number;
  schemeIs(scheme: string): boolean;
  equals(other: nsIPrincipal): boolean;
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
    getClosedTabDataForWindow(win: Window): SessionClosedTab[];
    getClosedTabData(options?: { private?: boolean }): SessionClosedTab[];
    getClosedWindowData(): SessionClosedWindow[];
    /** The reopened tab (undoCloseTab) or window (undoCloseWindow); undefined for an id it no
     * longer keeps. */
    undoCloseById(
      closedId: number,
      includePrivate?: boolean,
      targetWindow?: Window,
    ): MozTabbrowserTab | ChromeWindow | undefined;
  };
  // engine/toolkit/modules/OSKeyStore.sys.mjs
  OSKeyStore: {
    encrypt(plainText: string): Promise<string>;
    decrypt(cipherText: string, trigger?: string | boolean, reauth?: boolean): Promise<string>;
  };
  // engine/toolkit/modules/FileUtils.sys.mjs (an nsIFile constructor)
  FileUtils: { File: new (path: string) => nsIFile };
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
  // deserializePrincipal: null for a missing or empty one, else the principal (JSONToPrincipal
  // may give null too).
  E10SUtils: { deserializePrincipal(base64: string): nsIPrincipal | null };

  // Untyped: wide Firefox APIs Vimma drives in depth (the agent's downloads and dialogs,
  // js-ctypes and subprocesses).
  // engine/browser/modules/AboutNewTab.sys.mjs: setting the URL overrides it until the reset.
  AboutNewTab: {
    newTabURL: string;
    readonly newTabURLOverridden: boolean;
    resetNewTabURL(): void;
  };
  AddonManager: AddonManagerApi;
  // engine/toolkit/components/formautofill/shared/AutofillFormFactory.sys.mjs
  AutofillFormFactory: { createFromField(field: Element): FormLike };
  ContextualIdentityService: ContextualIdentityServiceApi;
  // engine/toolkit/components/downloads/DownloadHistory.sys.mjs: the session's downloads, then
  // the newest from history.
  DownloadHistory: {
    getList(options: { type: string; maxHistoryResults?: number }): Promise<DownloadList>;
  };
  // engine/toolkit/components/downloads/DownloadIntegration.sys.mjs, as
  // `Integration.downloads.getCombined` takes it.
  DownloadIntegration: object;
  DownloadPaths: any;
  Downloads: DownloadsModule;
  DownloadsCommon: DownloadsCommonApi;
  ExtensionPermissions: ExtensionPermissionsApi;
  // engine/toolkit/components/formautofill/shared/FormAutofillHeuristics.sys.mjs: undefined
  // when the form has no field it reads.
  FormAutofillHeuristics: {
    getFormInfo(formLike: FormLike, ignoreInvisibleInput: boolean): FormAutofillField[] | undefined;
  };
  // engine/toolkit/components/formautofill/shared/FormAutofillUtils.sys.mjs
  FormAutofillUtils: {
    isCreditCardField(fieldName: unknown): boolean;
    isAddressField(fieldName: unknown): boolean;
  };
  Integration: any;
  // engine/toolkit/modules/JSONFile.sys.mjs (a constructor function)
  JSONFile: new (config: JSONFileConfig) => JSONFileInstance;
  PopupAndRedirectBlockerObserver: PopupAndRedirectBlockerObserver;
  SearchService: SearchServiceApi;
  SitePermissions: SitePermissionsApi;
  Subprocess: any;
  // engine/browser/components/urlbar/UrlbarSearchUtils.sys.mjs: the visible engines with an
  // `@` alias, each with those aliases (an empty list when the search service fails to start).
  UrlbarSearchUtils: {
    tokenAliasEngines(): Promise<{ engine: SearchEngine; tokenAliases: string[] }[]>;
  };
  ctypes: any;
  nsContentDispatchChooser: any;
  nsUnknownContentTypeDialog: any;
  // engine/toolkit/components/pictureinpicture/PictureInPicture.sys.mjs: its per-window count of
  // PiP windows; a window without one has no entry.
  PictureInPicture: { readonly originatingWinWeakMap: WeakMap<Window, number> };

  // Vimma's own modules, imported lazily to break a load cycle.
  AgentChat: typeof import("../src/browser/base/content/vimma/agent/AgentChat.sys.mjs").AgentChat;
  AgentCli: typeof import("../src/browser/base/content/vimma/agent/AgentCli.sys.mjs").AgentCli;
  AgentDownloads: typeof import("../src/browser/base/content/vimma/ctl/AgentDownloads.sys.mjs").AgentDownloads;
  AgentGate: typeof import("../src/browser/base/content/vimma/host/AgentGate.sys.mjs").AgentGate;
  AgentKeys: typeof import("../src/browser/base/content/vimma/agent/AgentKeys.sys.mjs").AgentKeys;
  ConfigHost: typeof import("../src/browser/base/content/vimma/config/ConfigHost.sys.mjs").ConfigHost;
  McpHost: typeof import("../src/browser/base/content/vimma/host/mcp-ops.mjs").McpHost;
  ThemeHost: typeof import("../src/browser/base/content/vimma/ui/theme-host.mjs").ThemeHost;
  VimmaControl: typeof import("../src/browser/base/content/vimma/ctl/VimmaControl.sys.mjs").VimmaControl;
  VimmaHost: typeof import("../src/browser/base/content/vimma/host/VimmaHost.sys.mjs").VimmaHost;
  WorkspaceRouter: typeof import("../src/browser/base/content/vimma/workspaces/WorkspaceRouter.sys.mjs").WorkspaceRouter;
}

/** A module's `lazy` object: the named exports ChromeUtils.defineESModuleGetters defines on it. */
// engine/toolkit/modules/FormLikeFactory.sys.mjs: a form, or the fields around a field outside one.
interface FormLike {
  readonly rootElement: Element;
  readonly elements: Element[];
}
// engine/toolkit/components/formautofill/shared/FieldScanner.sys.mjs (FieldDetail)
interface FormAutofillField {
  /** Held by a WeakRef: undefined once the element is collected. */
  readonly element: Element | undefined;
  /** The field name the heuristics inferred, null when none. */
  readonly fieldName: string | null;
}

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
  /** Throws as `host` does. */
  readonly asciiHost: string;
  /** The scheme, user, host and port: `https://example.com:8080`. */
  readonly prePath: string;
  /** The path without query and fragment (a simple URI's whole path: nsSimpleURI::GetFilePath). */
  readonly filePath: string;
  schemeIs(scheme: string): boolean;
}

// engine/netwerk/protocol/http/nsIHttpChannel.idl, with nsIChannel's and nsIRequest's members
// (engine/netwerk/base/): the members a form submission's request is checked by.
interface nsIHttpChannel {
  readonly URI: nsIURI;
  readonly loadInfo: nsILoadInfo;
  readonly requestMethod: string;
  /** nsIRequest's: the request's result so far, a failure code once it failed. */
  readonly status: number;
  /** Throws while there is no response yet (a request that failed before one). */
  readonly responseStatus: number;
  /** Throws for a header the response does not have. */
  getResponseHeader(header: string): string;
  setResponseHeader(header: string, value: string, merge: boolean): void;
  cancel(status: number): void;
}
// engine/netwerk/base/nsILoadInfo.idl
interface nsILoadInfo {
  readonly isFormSubmission: boolean;
  readonly hasValidUserGestureActivation: boolean;
  /** The frame the load is for; null once it is gone. In the parent, canonical. */
  readonly browsingContext: CanonicalBrowsingContext | null;
  /** nsIRedirectHistoryEntry objects, one a redirect so far (webidl `jsval`). */
  readonly redirectChainIncludingInternalRedirects: readonly unknown[];
  /** nsContentPolicyType: one of nsIContentPolicy's TYPE_ constants. */
  readonly externalContentPolicyType: number;
  /** Webidl `jsval`: an OriginAttributesDictionary. */
  readonly originAttributes: { readonly userContextId: number; readonly privateBrowsingId: number };
}

// engine/dom/webidl/Window.webidl: every window's own constructors (a page's differ from
// chrome's, so code reaching into a content window builds its objects with these).
interface Window {
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver: typeof ResizeObserver;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly MouseEvent: typeof MouseEvent;
  readonly Event: typeof Event;
  readonly OffscreenCanvas: typeof OffscreenCanvas;
  readonly CSS: typeof CSS;
  /** Null once the window is closed: `closed` is true exactly when it has none
   * (engine/dom/base/nsGlobalWindowOuter.cpp, GetClosedOuter). */
  readonly docShell: nsIDocShell | null;
  fullScreen: boolean;
  /** The page's own view of its window, without Xrays: what its scripts set (xpconnect). */
  readonly wrappedJSObject: { readonly [name: string]: unknown };
}

// engine/dom/webidl/Window.webidl (the ChromeWindow part): a top-level chrome window.
interface ChromeWindow extends Window {
  /** Chrome windows are in the parent process only. */
  readonly browsingContext: CanonicalBrowsingContext;
  readonly windowState: number;
  readonly isFullyOccluded: boolean;
  getAttention(): void;
  maximize(): void;
  restore(): void;
}

// engine/toolkit/content/widgets/browser-custom-element.mjs (MozBrowser): a <browser>.
interface MozBrowser extends Element {
  /** Null without a frame loader (browser-custom-element.mjs, `get browsingContext`). */
  readonly browsingContext: CanonicalBrowsingContext | null;
  /** Null while the browser has no docshell or remote navigation yet. */
  readonly currentURI: nsIURI | null;
  readonly documentURI: { readonly spec: string } | null;
  readonly contentTitle: string;
  readonly isRemoteBrowser: boolean;
  /** Its context's (browser-custom-element.mjs); undefined without a context, null without one. */
  readonly webProgress: nsIWebProgress | null | undefined;
  readonly browserId: number;
  readonly documentContentType: string | null;
  /** Null for a non-remote browser without a docshell. */
  readonly finder: MozFinder | null;
  /** A remote browser's is null until its first page committed; a local one reads its document's. */
  readonly contentPrincipal: nsIPrincipal | null;
  /** engine/dom/chrome-webidl/MozFrameLoaderOwner.webidl; FrameLoader.remoteTab is the remote
   * browser's nsIRemoteTab (engine/dom/interfaces/base/nsIRemoteTab.idl). */
  readonly frameLoader: { readonly remoteTab: { priorityHint: boolean } | null } | null;
  /** Its context is active: shown, or kept rendering. */
  docShellIsActive: boolean;
  gotoIndex(index: number): void;
  // engine/toolkit/actors/PopupAndRedirectBlockingParent.sys.mjs, made on first read.
  readonly popupAndRedirectBlocker: PopupAndRedirectBlocker;
  focus(): void;
  reload(): void;
  loadURI(uri: nsIURI, params: { triggeringPrincipal: unknown; referrerInfo?: unknown }): void;
  /** The page's full zoom, 1 at 100 % (the fullZoom getter and setter). */
  fullZoom: number;
}

// engine/dom/chrome-webidl/WindowGlobalActors.webidl (WindowGlobalParent): the parts Vimma uses
// of a document's window global in the parent.
interface WindowGlobalParent {
  readonly innerWindowId: number;
  /** Vimma's actor is host/VimmaParent.sys.mjs's class (actors/VimmaActors.sys.mjs register). */
  getActor(
    name: "Vimma",
  ): import("../src/browser/base/content/vimma/host/VimmaParent.sys.mjs").VimmaParent;
  getActor(name: string): JSWindowActorParent;
}

// A tab's <browser>. A lazy one answers currentURI from session data (Tabbrowser.sys.mjs,
// createLazyBrowser's getters); a live one reads its webNavigation's. currentURI is assumed
// non-null for a live tab, though the getter gives null without a webNavigation
// (browser-custom-element.mjs, `get currentURI`); host/ reads it with `?.` all the same. The
// finder is set either way.
interface MozTabBrowser extends MozBrowser {
  readonly currentURI: nsIURI;
  readonly finder: MozFinder;
  /** Tabbrowser makes it in its browser window's document. Null once that has no window. */
  readonly documentGlobal: BrowserWindow | null;
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
  /** The tab it was opened from, null when none (Tabbrowser addTab's `openerTab`); undefined
   * for a tab addTab did not make, as the window's first. */
  readonly openerTab: MozTabbrowserTab | null | undefined;
  toggleMuteAudio(muteReason?: string | null): void;
}

// engine/browser/components/tabbrowser/content/tabsplitview.mjs
interface MozTabSplitViewWrapper extends Element {
  readonly splitViewId: number;
  readonly tabs: MozTabbrowserTab[];
  /** `trigger` names what asked, for Firefox's telemetry (its menu passes "menu_separate"). */
  unsplitTabs(trigger?: string | null): void;
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
  /** The browser's notification box, null until a notification first needed one. */
  readNotificationBox(browser?: MozBrowser): MozNotificationBox | null;
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

/** One of the address bar controller's query notifications: the query's context, by its id. */
interface UrlbarQueryListener {
  onQueryStarted?(context: { id: unknown }): void;
  onQueryFinished?(context: { id: unknown }): void;
  onQueryCancelled?(context: { id: unknown }): void;
}

// The address bar, as `gURLBar` or `#urlbar`: engine/browser/components/urlbar/content/
// UrlbarInputBase.mjs. `controller` is its UrlbarChildController (UrlbarChildController.mjs,
// addListener and removeListener), one per element: connectedCallback makes it only when
// there is none. `view` is its UrlbarView (UrlbarView.mjs: `isOpen`, and `queryContext`, the
// context of the results it last drew). `lastSearchString` is set by startQuery as a query
// starts; `lastQueryContextPromise` is the last query's, resolved when it ends (a resolved one
// before any query).
type UrlbarInput = HTMLElement & {
  focused: boolean;
  view: { isOpen: boolean; queryContext: { searchString: string } | null };
  select(): void;
  controller?: {
    addListener(listener: UrlbarQueryListener): void;
    removeListener(listener: UrlbarQueryListener): void;
  };
  readonly lastSearchString: string;
  lastQueryContextPromise: Promise<unknown>;
};

// engine/browser/base/content/browser.js and the scripts browser.xhtml loads: a browser window.
interface BrowserWindow extends ChromeWindow {
  readonly gBrowser: Tabbrowser;
  // engine/browser/components/urlbar/content/UrlbarInput.mjs
  readonly gURLBar: UrlbarInput;
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
  // utilityOverlay.js (URILoadingHelper.sys.mjs openLinkIn: `params` are its many options)
  openLinkIn(url: string, where: string, params: object): void;
  openTrustedLinkIn(
    url: string,
    where: string,
    params?: { userContextId?: number; inBackground?: boolean },
  ): void;
  // toolkit globalOverlay.js and contentAreaUtils.js
  goQuitApplication(event?: { ctrlKey?: boolean; metaKey?: boolean }): boolean;
  DownloadURL(url: string, fileName: string | null, initiatingDocument: Document): void;
  // browser-addons.js: the extensions button's code.
  readonly gUnifiedExtensions: UnifiedExtensions;
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
  fastFind(query: string, linksOnly: boolean, outline: boolean): void;
  requestMatchesCount(query: string, args: object): void;
  removeSelection(keepHighlight?: boolean): void;
}

// engine/dom/chrome-webidl/XULPopupElement.webidl: a <menupopup>, <panel> or <tooltip>
// (engine/dom/xul/nsXULElement.cpp; XULTooltipElement extends it), the target of popupshowing
// and popuphidden. `state` is one of the four the webidl's comment lists.
interface XULPopupElement extends Element {
  readonly state: "closed" | "showing" | "open" | "hiding";
  readonly triggerNode: Node | null;
  readonly anchorNode: Element | null;
}

// engine/dom/chrome-webidl/XULFrameElement.webidl: a XUL <browser>, <iframe> or <editor>
// (nsXULElement.cpp). The members Vimma reads.
interface XULFrameElement extends Element {
  readonly contentDocument: Document | null;
}

// engine/dom/chrome-webidl/BrowsingContext.webidl (the members Vimma reads).
interface BrowsingContext {
  // LoadContextMixin: webidl `any`, an OriginAttributesDictionary
  // (engine/dom/chrome-webidl/OriginAttributes.webidl).
  readonly originAttributes: { readonly userContextId: number; readonly privateBrowsingId: number };
  readonly id: number;
  readonly parent: BrowsingContext | null;
  readonly top: BrowsingContext;
  /** The frames of its current document (BrowsingContext::Children, its current WindowContext's). */
  readonly children: readonly BrowsingContext[];
  /** The frame element in its embedder's document, null when that is in another process. */
  readonly embedderElement: Element | null;
  readonly isDiscarded: boolean;
  readonly browserId: number;
  readonly isContent: boolean;
  /** engine/dom/base/nsSandboxFlags.h; the setter throws on a discarded context. */
  sandboxFlags: number;
  /**
   * The full zoom, 1 at 100 % (engine/dom/chrome-webidl/BrowsingContext.webidl, a synced float
   * field; its setter throws on a discarded context).
   */
  fullZoom: number;
  getAllBrowsingContextsInSubtree(): BrowsingContext[];
}
// The parent process's context (BrowsingContext.webidl). In the parent every context is one
// (engine/docshell/base/BrowsingContext.cpp: CreateDetached and CreateFromIPC make a
// CanonicalBrowsingContext there), so the contexts it reaches from one are too, though the webidl
// types them as BrowsingContext.
interface CanonicalBrowsingContext extends BrowsingContext {
  readonly currentWindowGlobal: WindowGlobalParent | null;
  readonly parent: CanonicalBrowsingContext | null;
  readonly top: CanonicalBrowsingContext;
  readonly children: readonly CanonicalBrowsingContext[];
  /** Its embedder element, or one around it, is hidden or has no frame. */
  readonly isUnderHiddenEmbedderElement: boolean;
  readonly currentURI: nsIURI | null;
  /** Top-level only; the setter throws on another. */
  downloadFolderOverride: string;
  /** The tab's back/forward list (engine/docshell/shistory/nsISHistory.idl), null for a context
   * that keeps none. */
  readonly sessionHistory: nsISHistory | null;
  getAllBrowsingContextsInSubtree(): CanonicalBrowsingContext[];
  /** The chrome window the context is in; null once it has none. */
  readonly topChromeWindow: ChromeWindow | null;
  /**
   * An app window's context only: kept active while minimized or occluded. The setter throws
   * on any other.
   */
  forceAppWindowActive: boolean;
}
// engine/dom/chrome-webidl/WindowGlobalActors.webidl (WindowContext's and WindowGlobalParent's
// members). The principals are never null (webidl `Principal`, not nullable).
interface WindowGlobalParent {
  readonly innerWindowId: number;
  /** The document's window has closed: it no longer shows in its frame. */
  readonly isClosed: boolean;
  readonly isInProcess: boolean;
  readonly documentPrincipal: nsIPrincipal;
  readonly documentStoragePrincipal: nsIPrincipal;
  readonly documentURI: nsIURI | null;
  /** WindowContext's: null once its context is gone. In the parent, canonical. */
  readonly browsingContext: CanonicalBrowsingContext | null;
  readonly isInitialDocument: boolean;
  /** An image of its frame and the frames in it, drawn in the parent (`rect` null: the
   * viewport). */
  drawSnapshot(rect: DOMRect | null, scale: number, backgroundColor: string): Promise<ImageBitmap>;
  /** engine/toolkit/components/pageextractor/PageExtractorParent.sys.mjs */
  getActor(name: "PageExtractor"): PageExtractorParent;
  /** engine/dom/interfaces/base/nsIDOMProcessParent.idl; null once the process is gone. */
  readonly domProcess: { readonly remoteType: string | null } | null;
}

// engine/dom/webidl/MozFrameLoaderOwner.webidl, which both frame elements include: the frame's
// context, null while it has none (an element not in a document).
interface HTMLIFrameElement {
  readonly browsingContext: BrowsingContext | null;
}
interface HTMLFrameElement {
  readonly browsingContext: BrowsingContext | null;
}

// engine/dom/webidl/Node.webidl (ChromeOnly): a slotted node's slot, a shadow root's host, else
// the parent node.
interface Node {
  readonly flattenedTreeParentNode: Node | null;
}

// engine/dom/webidl/HTMLInputElement.webidl, the MozEditableElement mixin (ChromeOnly), which
// HTMLTextAreaElement includes too. Reading it makes the editor if the element can have one.
interface HTMLInputElement {
  readonly editor: nsIEditor | null;
}
interface HTMLTextAreaElement {
  readonly editor: nsIEditor | null;
}
// The chrome-only members of the form controls that form autofill and Vimma's agent fills read
// (engine/dom/webidl/HTMLInputElement.webidl, HTMLSelectElement.webidl,
// HTMLTextAreaElement.webidl; AutocompleteInfo.webidl). `setUserInput` is the MozEditableElement
// mixin's, which a text area includes.
interface AutocompleteInfo {
  readonly fieldName: string;
}
interface HTMLInputElement {
  /** It is a password field, or was one at any time. */
  readonly hasBeenTypePassword: boolean;
  /** Form autofill's preview, shown before it is a value. */
  readonly previewValue: string;
  getAutocompleteInfo(): AutocompleteInfo | null;
  setUserInput(input: string): void;
}
interface HTMLSelectElement {
  getAutocompleteInfo(): AutocompleteInfo;
  /** Ends a user's choice as the select's popup does: fires input and change when `changed`. */
  userFinishedInteracting(changed: boolean): void;
}
interface HTMLTextAreaElement {
  getAutocompleteInfo(): AutocompleteInfo;
  setUserInput(input: string): void;
}
// engine/editor/nsIEditor.idl. EditorBase::GetSelectionController fails (the getter throws)
// rather than give null.
interface nsIEditor {
  readonly selectionController: nsISelectionController;
}
// engine/dom/base/nsISelectionController.idl
interface nsISelectionController {
  repaintSelection(type: number): void;
}

// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs (updateBrowserSharing and
// resetBrowserSharing): a tab browser's sharing state, unset until a page first shares; webRTC
// is WebRTCParent.sys.mjs's state (null once sharing stops), the others what PermissionUI and
// SerialDeviceSharingHelper pass.
interface MozTabBrowser {
  readonly _sharingState?: {
    webRTC?: { camera?: unknown; microphone?: unknown; screen?: unknown } | null;
    geo?: unknown;
    xr?: unknown;
    serial?: unknown;
  } | null;
}

// engine/toolkit/actors/FinderChild.sys.mjs: `finder` makes the frame's Finder on first read,
// `_finder` is unset until then. engine/toolkit/modules/Finder.sys.mjs nulls `_fastFind` in
// destroy().
interface FinderChildActor {
  readonly finder: FinderModule;
  readonly _finder?: FinderModule | null;
}
interface FinderModule {
  readonly _fastFind: nsITypeAheadFind | null;
}
// engine/toolkit/components/typeaheadfind/nsITypeAheadFind.idl
interface nsITypeAheadFind {
  readonly foundEditable: Element | null;
  find(searchString: string, linksOnly: boolean, mode: number, dontIterateFrames: boolean): number;
}

// engine/uriloader/base/nsIWebProgress.idl (the members Vimma reads)
interface nsIWebProgress {
  readonly isTopLevel: boolean;
  readonly isLoadingDocument: boolean;
}

// engine/docshell/shistory/nsISHistory.idl and nsISHEntry.idl (the members Vimma reads).
// getEntryAtIndex throws for an index out of range.
interface nsISHistory {
  readonly count: number;
  /** The current entry's index. */
  readonly index: number;
  getEntryAtIndex(index: number): nsISHEntry;
}

// engine/toolkit/components/pageextractor/PageExtractorParent.sys.mjs. Both answers come from
// the page's process (sendQuery), or from the PDF viewer's: checked by the caller.
interface PageExtractorParent {
  getText(options: {
    removeBoilerplate?: boolean;
    useSimpleText?: boolean;
    sufficientLength?: number;
    sourceUrl?: string;
  }): Promise<unknown>;
  getPageMetadata(): Promise<unknown>;
}

// engine/dom/interfaces/base/nsIContentPermissionPrompt.idl (the members Vimma reads).
interface nsIContentPermissionRequest {
  readonly principal: nsIPrincipal;
  readonly topLevelPrincipal: nsIPrincipal;
  cancel(): void;
}
// engine/browser/components/permissions/ContentPermissionPrompt.sys.mjs: the integration point
// `Integration.contentPermission` wraps; its prompt's prompt() shows it or decides at once.
interface ContentPermissionIntegration {
  createPermissionPrompt(
    type: string,
    request: nsIContentPermissionRequest,
  ): { prompt(): void } | undefined;
}

// engine/toolkit/components/downloads/DownloadCore.sys.mjs: a Download, with the members of its
// DownloadSource, DownloadTarget and DownloadSaver that Vimma's agent downloads read
// (ctl/AgentDownloads.sys.mjs). The saver is a DownloadCopySaver or, for a helper-app download,
// a DownloadLegacySaver, which alone has `request` (its channel, null until it starts) and
// `deferExecuted`.
interface FirefoxDownload {
  readonly source: {
    readonly url: string;
    readonly originalUrl: string | null;
    readonly userContextId?: number;
    readonly browsingContextId?: number;
  };
  readonly target: { readonly path: string; readonly partFilePath: string | null };
  readonly saver: {
    readonly totalBytes?: number;
    readonly request?: { readonly contentLength?: number } | null;
    readonly deferExecuted?: { readonly promise: Promise<unknown> } | null;
    cancel?(): void;
  } | null;
  readonly stopped: boolean;
  readonly totalBytes: number;
  readonly currentBytes: number;
  readonly contentType: string | null;
  launchWhenSucceeded: boolean;
  launcherPath: string | null;
  launcherId: string | null;
  handleInternally: boolean;
  finalize(removePartialData?: boolean): Promise<void>;
  whenSucceeded(): Promise<void>;
}
// engine/toolkit/components/downloads/DownloadIntegration.sys.mjs: the hooks
// `Integration.downloads` lets Vimma wrap (DownloadCore's Download.start and
// _checkReputationAndMove call them).
interface DownloadIntegrationBase {
  shouldBlockForParentalControls(download: FirefoxDownload): Promise<boolean>;
  shouldBlockForReputationCheck(
    download: FirefoxDownload,
  ): Promise<{ shouldBlock: boolean; verdict: unknown }>;
  downloadDone(download: FirefoxDownload): Promise<unknown>;
  launchDownload(download: FirefoxDownload, options: unknown): Promise<unknown>;
}
// engine/uriloader/exthandler/nsIExternalHelperAppService.idl (nsIHelperAppLauncher): the
// members Vimma's download dialog reads. `file` is an nsIFile.
interface nsIHelperAppLauncher {
  readonly browsingContextId: number;
  readonly contentLength: number;
  promptForSaveDestination(): void;
  saveDestinationAvailable(file: { readonly path: string } | null): void;
}
// engine/toolkit/modules/subprocess/Subprocess.sys.mjs (its Process, through the pipes Vimma
// asked for): the scanner Vimma runs.
interface ChildProcess {
  readonly stdin: { close(): Promise<unknown> };
  readonly stdout: { readString(): Promise<string> };
  readonly stderr: { readString(): Promise<string> };
  wait(): Promise<{ exitCode: number }>;
  kill(): void;
}
// The modules ctl/AgentDownloads.sys.mjs reads lazily, named here and not there:
// tools/security/test/chrome-source.test.ts pins every mention of the process module in it.
type AgentDownloadsLazy = Lazy<
  | "DownloadPaths"
  | "Downloads"
  | "FileUtils"
  | "Integration"
  | "Subprocess"
  | "ctypes"
  | "clearInterval"
  | "clearTimeout"
  | "setInterval"
  | "setTimeout"
  | "nsUnknownContentTypeDialog"
>;

// SpiderMonkey's built-ins newer than the type check's ES2022 library (engine/js/src/builtin/
// String.cpp, ES2024; engine/js/src/vm/TypedArrayObject.cpp, ES2026).
interface String {
  toWellFormed(): string;
}
interface Uint8Array {
  toBase64(options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }): string;
}

// engine/toolkit/modules/JSONFile.sys.mjs: a JSON file kept in memory, saved after a delay.
// Reading `data` throws until it is ready (load, ensureDataReady or a set); a missing file
// reads as {}. finalize() rejects when called a second time.
interface JSONFileConfig {
  path: string;
  backupTo?: string;
  saveDelayMs?: number;
  beforeSave?: () => unknown;
}
interface JSONFileInstance {
  readonly path: string;
  readonly dataReady: boolean;
  data: unknown;
  load(): Promise<void>;
  ensureDataReady(): void;
  saveSoon(): void;
  finalize(): Promise<void>;
}

// engine/toolkit/components/commandlines/nsICommandLine.idl
interface nsICommandLine {
  /** Null (a void string) when the flag is absent; throws when it has no parameter. */
  handleFlagWithParam(flag: string, caseSensitive: boolean): string | null;
}

// ---------------------------------------------------------------------------------------------
// The members host/ reads (#938). Kept together so the other slices' additions merge cleanly;
// a member another slice declares too is declared with the same type.

// engine/toolkit/content/widgets/browser-custom-element.mjs
interface MozBrowser {
  goBack(requireUserInteraction?: boolean): void;
  goForward(requireUserInteraction?: boolean): void;
}
// engine/dom/chrome-webidl/BrowsingContext.webidl
interface CanonicalBrowsingContext {
  /** Its current document's WindowContext, null while it has none; in the parent, a
   * WindowGlobalParent. */
  readonly currentWindowContext: WindowGlobalParent | null;
}
// engine/netwerk/base/nsIURI.idl
interface nsIURI {
  /** The host as shown to people (IDN decoded); throws as `host` does. */
  readonly displayHost: string;
}
// engine/docshell/shistory/nsISHEntry.idl
interface nsISHEntry {
  readonly URI: nsIURI;
  /** Both entries show the same document (a same-document navigation between them). */
  sharesDocumentWith(entry: nsISHEntry): boolean;
}
// engine/dom/chrome-webidl/XULElement.webidl: a XUL element, as a `<command>` or a `<key>`.
interface XULElement extends Element {
  hidden: boolean;
  click(): void;
  focus(): void;
  /** Runs its command: a `<command>`'s oncommand, a `<key>`'s command event. */
  doCommand(): void;
}
// engine/toolkit/components/windowwatcher/nsIPromptService.idl (the members Vimma calls)
interface nsIPromptService {
  readonly STD_YES_NO_BUTTONS: number;
  readonly BUTTON_POS_1_DEFAULT: number;
  /** The index of the button pressed; `checkState.value` is the checkbox's state after. */
  confirmEx(
    parent: Window | null,
    title: string | null,
    text: string | null,
    buttonFlags: number,
    button0Title: string | null,
    button1Title: string | null,
    button2Title: string | null,
    checkMsg: string | null,
    checkState: { value: boolean },
  ): number;
}
interface FirefoxServices {
  prompt: nsIPromptService;
}
// engine/dom/webidl/Localization.webidl: a missing message formats as null.
interface FirefoxLocalization {
  formatValuesSync(keys: readonly string[]): (string | null)[];
}
// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs
interface Tabbrowser {
  /** The tab strip's strings (browser/tabbrowser.ftl). */
  readonly tabLocalization: FirefoxLocalization;
}
// engine/browser/base/content/browser-commands.js: the window's menu and key commands (the
// ones Vimma runs; the browser tests' declarations add theirs).
interface BrowserWindow {
  readonly BrowserCommands: BrowserCommandsApi;
}
interface BrowserCommandsApi {
  openTab(): void;
  viewSource(browser: MozBrowser): void;
}
// engine/browser/components/tabbrowser/Tabbrowser.sys.mjs (removeTab's options): the
// TabMetrics context of a user's close.
interface TabbrowserRemoveOptions {
  metricsContext?: unknown;
}
// engine/toolkit/actors/PopupAndRedirectBlockingParent.sys.mjs (PopupAndRedirectBlocker): a
// <browser>'s blocked pop-ups and redirect. The URI specs and report indexes are the content
// process's answers (its PopupAndRedirectBlockingChild), passed on unchecked.
interface BlockedPopup {
  readonly browsingContext: CanonicalBrowsingContext;
  readonly innerWindowId: number;
  readonly popupWindowURISpec: unknown;
  readonly reportIndex: unknown;
}
interface BlockedRedirect {
  readonly browsingContext: CanonicalBrowsingContext;
  readonly innerWindowId: number;
  readonly redirectURISpec: unknown;
}
interface PopupAndRedirectBlocker {
  getBlockedPopups(): Promise<BlockedPopup[]>;
  getBlockedRedirect(): Promise<BlockedRedirect | null>;
  /** Nothing when the context shows another document than `innerWindowId` by now. */
  unblockPopup(bc: CanonicalBrowsingContext, innerWindowId: number, reportIndex: unknown): void;
  unblockRedirect(bc: CanonicalBrowsingContext, innerWindowId: number, spec: unknown): void;
  unblockAllPopups(): Promise<void>;
  unblockFirstRedirect(): Promise<void>;
}
// engine/browser/modules/PopupAndRedirectBlockerObserver.sys.mjs: the bar's menu commands. They
// read only the event's window.
interface PopupAndRedirectBlockerObserver {
  toggleAllowPopupsForSite(event: { originalTarget: { documentGlobal: Window } }): Promise<void>;
  dontShowMessage(event: { originalTarget: { documentGlobal: Window } }): void;
  editPopupSettings(event: { originalTarget: { documentGlobal: Window } }): void;
}
// engine/toolkit/content/widgets/notificationbox.js (MozElements.NotificationBox)
interface MozNotificationBox {
  /** The last notification with that `value` attribute, or null. */
  getNotificationWithValue(value: string): MozNotificationMessage | null;
}
// notificationbox.js (NotificationMessage): a notification bar.
interface MozNotificationMessage extends HTMLElement {
  /** Its buttons' container, made in connectedCallback: unset before. */
  readonly buttonContainer?: HTMLElement;
  dismiss(): void;
}
// engine/toolkit/content/widgets/popupnotification.js (MozPopupNotification): a prompt in the
// doorhanger panel or the app menu's notice panel. connectedCallback finds its parts, from its
// own markup: a prompt in a panel has them. The buttons are <moz-button>s.
interface MozPopupNotification extends XULElement {
  readonly button: HTMLElement;
  readonly secondaryButton: HTMLElement;
  readonly buttonGroup: Element;
  /** The footer's buttons that take focus, in order (each <moz-button>'s inner <button>). */
  readonly footerFocusableButtons: HTMLElement[];
}
// engine/dom/webidl/HTMLInputElement.webidl (ChromeOnly)
interface HTMLInputElement {
  mozIsTextField(excludePassword: boolean): boolean;
}
// An entry of a download list (engine/toolkit/components/downloads/DownloadList.sys.mjs): a
// session download (DownloadCore.sys.mjs, Download), or in a normal window's list one from
// history (DownloadHistory.sys.mjs, HistoryDownload), which has only the members marked optional
// here, some of them unset, and `refresh`.
interface DownloadListEntry {
  readonly source: {
    readonly url: string;
    /** The container it came from; a history entry keeps none. */
    readonly userContextId?: number;
    readonly referrerInfo?: { readonly originalReferrer: nsIURI | null } | null;
  };
  readonly target: {
    /** Unset for a history entry whose file Firefox does not know. */
    readonly path?: string;
    readonly exists?: boolean;
    readonly partFileExists?: boolean;
    readonly size?: number;
  };
  readonly stopped: boolean;
  readonly succeeded?: boolean;
  readonly canceled?: boolean;
  readonly deleted?: boolean;
  readonly hasProgress: boolean;
  readonly hasPartialData: boolean;
  readonly hasBlockedData?: boolean;
  readonly currentBytes?: number;
  readonly totalBytes?: number;
  readonly speed?: number;
  /** A session download's, null before it starts. */
  readonly startTime?: Date | null;
  /** A history entry's, in ms. */
  readonly endTime?: number;
  /** A history entry's Places node (`time` in microseconds). */
  readonly placesNode?: { readonly time: number };
  /** Downloads.sys.mjs's DownloadError, or a history entry's plain object like it. */
  readonly error?: DownloadError | null;
  /** Reads the disk again (the file's existence and size) and tells the list's views. */
  refresh(): Promise<void>;
}
interface DownloadError {
  readonly message?: string;
  readonly becauseBlockedByParentalControls?: boolean;
  readonly becauseBlockedByReputationCheck?: boolean;
  readonly becauseBlockedByContentAnalysis?: boolean;
  readonly reputationCheckVerdict?: string;
}
// DownloadCore.sys.mjs (Download): a session download, with the members a history entry lacks.
interface SessionDownload extends DownloadListEntry {
  readonly target: DownloadListEntry["target"] & { refresh(): Promise<void> };
  launchWhenSucceeded: boolean;
  start(): Promise<void>;
  cancel(): Promise<void>;
  removePartialData(): Promise<void>;
  confirmBlock(): Promise<void>;
  unblock(): Promise<void>;
  showContainingDirectory(): Promise<void>;
}
// DownloadList.sys.mjs: a view hears of each entry, those already listed when it is added too.
interface DownloadListView {
  onDownloadAdded?(download: DownloadListEntry): void;
  onDownloadChanged?(download: DownloadListEntry): void;
  onDownloadRemoved?(download: DownloadListEntry): void;
}
interface DownloadList {
  getAll(): Promise<DownloadListEntry[]>;
  /** The ALL list also holds the agent's downloads (ctl/AgentDownloads.sys.mjs). */
  remove(download: DownloadListEntry | FirefoxDownload): Promise<void>;
  addView(view: DownloadListView): Promise<void>;
  removeView(view: DownloadListView): Promise<void>;
}
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
// engine/browser/base/content/browser-addons.js (gUnifiedExtensions). browserActionFor gives the
// extension's handler in engine/browser/components/extensions/parent/ext-browserAction.js:
// undefined until an extension loaded that code, and for an extension without a button.
interface UnifiedExtensions {
  browserActionFor(policy: WebExtensionPolicy | null): ExtensionBrowserAction | null | undefined;
}
interface ExtensionBrowserAction {
  /** engine/toolkit/components/extensions/ExtensionActions.sys.mjs: the popup's URL for the
   * tab, empty or null without one. */
  readonly action: { getPopupUrl(tab: MozTabbrowserTab | null, strict?: boolean): string | null };
  /** As the button's click or its `_execute_action` shortcut. */
  triggerAction(window: BrowserWindow): void;
}
// engine/toolkit/mozapps/extensions/AddonManager.sys.mjs: the members the add-on picker uses
// (setup/'s are declared further down).
interface AddonManagerApi {
  getAddonsByTypes(types: readonly string[]): Promise<AddonWrapper[]>;
  getAllInstalls(): Promise<AddonInstall[]>;
  addAddonListener(listener: object): void;
  readonly UPDATE_STATUS_NO_ERROR: number;
  readonly UPDATE_WHEN_USER_REQUESTED: number;
  // The bits of AddonWrapper.permissions the picker reads.
  readonly PERM_CAN_UNINSTALL: number;
  readonly PERM_CAN_ENABLE: number;
  readonly PERM_CAN_DISABLE: number;
  readonly PERM_CAN_UPGRADE: number;
  readonly PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS: number;
}
// engine/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs (AddonWrapper): an installed
// add-on.
interface AddonWrapper {
  readonly id: string;
  readonly name: string | null;
  readonly version: string | null;
  readonly type: string;
  readonly userDisabled: boolean;
  readonly isSystem: boolean;
  readonly isBuiltin: boolean;
  readonly hidden: boolean;
  /** "spanning", "not_allowed" or "private" (the manifest's `incognito`). */
  readonly incognito: string;
  /** The update waiting for a restart, null without one. */
  readonly pendingUpgrade: object | null;
  /** AddonManager's PERM_CAN_* bits. */
  readonly permissions: number;
  readonly optionsURL: string | null;
  readonly isActive: boolean;
  enable(): Promise<void>;
  disable(): Promise<void>;
  uninstall(): Promise<void>;
  reload(): Promise<void>;
  findUpdates(listener: AddonUpdateListener, reason: number): void;
}
interface AddonUpdateListener {
  onUpdateAvailable?(addon: AddonWrapper, install: AddonInstall): void;
  onNoUpdateAvailable?(addon: AddonWrapper): void;
  onUpdateFinished?(addon: AddonWrapper, error: number): void;
}
// AddonManager.sys.mjs (AddonInstall): an install or update; `existingAddon` is the add-on it
// updates, null for a new one.
interface AddonInstall {
  readonly existingAddon: AddonWrapper | null;
  readonly version: string | null;
}
// engine/toolkit/components/extensions/ExtensionPermissions.sys.mjs; `extension` is the running
// Extension, which then hears of the change (undefined for one not running).
interface ExtensionPermissionsApi {
  get(id: string): Promise<{ permissions: string[]; origins: string[] }>;
  add(
    id: string,
    perms: { permissions: string[]; origins: string[] },
    extension?: unknown,
  ): Promise<void>;
  remove(
    id: string,
    perms: { permissions: string[]; origins: string[] },
    extension?: unknown,
  ): Promise<void>;
}
// engine/toolkit/content/widgets/dialog.js (MozDialog): a XUL <dialog>. getButton gives its
// button of that type ("accept", "cancel", ...), undefined for a type it has none of.
interface MozDialog extends XULElement {
  getButton(type: string): MozDialogButton | undefined;
}
// engine/toolkit/content/widgets/button.js: a XUL <button>.
interface MozDialogButton extends XULElement {
  readonly label: string;
  disabled: boolean;
}
// engine/browser/components/sessionstore/SessionStore.sys.mjs: a closed tab's record and a
// closed window's, as SessionStore keeps them (and reads them back from the session file). The
// fields Vimma reads; each is read with a fallback.
interface SessionClosedTab {
  readonly closedId: number;
  readonly title?: string;
  /** When it closed, in ms since the epoch. */
  readonly closedAt?: number;
  readonly state?: SessionTabState;
}
interface SessionClosedWindow {
  readonly closedId: number;
  readonly title?: string;
  readonly closedAt?: number;
  readonly tabs?: readonly SessionTabState[];
}
// A tab's saved state: its history entries and the current one's index, 1-based.
interface SessionTabState {
  readonly entries?: readonly { readonly url?: string; readonly title?: string }[];
  readonly index?: number;
  readonly userContextId?: number;
}
// engine/toolkit/components/places/PlacesUtils.sys.mjs: the members the bookmarks panel uses.
interface PlacesUtilsApi {
  /** The item and everything under it; null for a guid that names no item. */
  promiseBookmarksTree(guid?: string): Promise<PlacesTreeItem | null>;
  readonly bookmarks: PlacesBookmarksApi;
  // engine/dom/base/PlacesObservers.cpp (PlacesObservers.webidl)
  readonly observers: {
    addListener(types: string[], listener: (events: unknown[]) => void): void;
    removeListener(types: string[], listener: (events: unknown[]) => void): void;
  };
}
// promiseBookmarksTree's items; `title` and `uri` are unset where the item has none.
interface PlacesTreeItem {
  readonly guid: string;
  readonly typeCode?: number;
  readonly title?: string;
  readonly uri?: string;
  readonly children?: PlacesTreeItem[];
}
// engine/toolkit/components/places/Bookmarks.sys.mjs: a bookmark's info, and the calls on it.
interface PlacesBookmarkInfo {
  readonly guid: string;
  readonly parentGuid: string;
  readonly title: string;
}
interface PlacesBookmarksApi {
  readonly TYPE_FOLDER: number;
  readonly DEFAULT_INDEX: number;
  /** The first bookmark that matches, null for none. */
  fetch(guidOrInfo: string | { url: string }): Promise<PlacesBookmarkInfo | null>;
  insert(info: {
    parentGuid: string;
    type?: number;
    url?: string;
    title?: string;
  }): Promise<PlacesBookmarkInfo>;
  update(info: {
    guid: string;
    parentGuid?: string;
    index?: number;
    title?: string;
  }): Promise<PlacesBookmarkInfo>;
  remove(guid: string): Promise<unknown>;
}
// engine/toolkit/modules/FinderParent.sys.mjs: the frame of the last match, null before one and
// after close() forgets it.
interface MozFinder {
  _lastFoundBrowsingContext: CanonicalBrowsingContext | null;
}
// engine/dom/webidl/Document.webidl and DocumentL10n.webidl: a document's Fluent localization,
// null for a document that does not support Fluent (DocumentSupportsL10n). getAttributes reads
// an element's data-l10n-id and data-l10n-args (DOMLocalization.webidl).
interface Document {
  readonly l10n: DocumentL10n | null;
}
interface DocumentL10n {
  getAttributes(element: Element): { id: string | null; args: L10nArgs | null };
}
/** Fluent's arguments (Fluent.webidl, L10nArgs). */
type L10nArgs = Record<string, string | number | null>;
// engine/browser/base/content/browser.js: opens a browser window, and gives it.
interface BrowserWindow {
  OpenBrowserWindow(options?: {
    private?: boolean;
    features?: string;
    args?: unknown;
  }): BrowserWindow;
}

// The Firefox modules the rest of Vimma reads lazily (#938, after host/ and ctl/), with only the
// members it uses.

// engine/toolkit/mozapps/extensions/AddonManager.sys.mjs: the setup page's install of an AMO
// add-on. getInstallForURL rejects before the add-on manager has started.
interface AddonManagerApi {
  getInstallForURL(
    url: string,
    options?: { hash?: string | null; name?: string },
  ): Promise<AddonInstall>;
  /** Firefox's own install path from AMO: policy, signature and permission prompt. */
  installAddonFromAOM(browser: MozBrowser, uri: nsIURI, install: AddonInstall): void;
}
// AddonManager.sys.mjs (AddonInstallWrapper): its listener hears of each step.
interface AddonInstall {
  addListener(listener: AddonInstallListener): void;
  removeListener(listener: AddonInstallListener): void;
}
interface AddonInstallListener {
  onInstallEnded?(): void;
  onInstallCancelled?(): void;
  onDownloadCancelled?(): void;
  onInstallFailed?(): void;
  onDownloadFailed?(): void;
}

// engine/toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs: the getters
// return copies; getPublicIdentityFromId gives undefined for an id without a public container.
// update and remove give false for an id they do not know. A container the user named has a
// name; Firefox's own have an l10nId instead (the browser tests declare the same).
interface ContextualIdentity {
  readonly userContextId: number;
  readonly public: boolean;
  readonly icon: string;
  readonly color: string;
  readonly name?: string;
  readonly l10nId?: string;
}
interface ContextualIdentityServiceApi {
  getPublicIdentities(): ContextualIdentity[];
  getPublicIdentityFromId(userContextId: number): ContextualIdentity | undefined;
  /** Throws once the container ids run out. */
  create(name: string, icon: string, color: string): ContextualIdentity;
  /** Throws for a name of only whitespace. */
  update(userContextId: number, name: string, icon: string, color: string): boolean;
  remove(userContextId: number): boolean;
  closeContainerTabs(userContextId?: number): Promise<void>;
}

// engine/toolkit/components/downloads/Downloads.sys.mjs: the list kinds (strings such as
// "{Downloads.PUBLIC}"), and a download made from a URL and a path (DownloadCore's
// Download.fromSerializable throws without a target path). Named apart from the browser tests'
// DownloadsApi (types/mochitest/firefox.d.ts), whose lists and downloads are the agent's kind.
interface DownloadsModule {
  readonly PUBLIC: string;
  readonly PRIVATE: string;
  readonly ALL: string;
  getList(type: string): Promise<DownloadList>;
  createDownload(properties: { source: string; target: string }): Promise<SessionDownload>;
}
// engine/browser/components/downloads/DownloadsCommon.sys.mjs: the downloads panel's commands.
interface DownloadsCommonApi {
  /** Null before the download succeeds. */
  getMimeInfo(download: DownloadListEntry): { readonly type: string } | null;
  deleteDownload(download: DownloadListEntry): Promise<void>;
  deleteDownloadFiles(download: DownloadListEntry, clearHistoryOnDelete?: number): Promise<void>;
  copyDownloadLink(download: DownloadListEntry): void;
  openDownload(
    download: DownloadListEntry,
    options?: { useSystemDefault?: boolean },
  ): Promise<void>;
  /** "open", "unblock", "confirmBlock" or "cancel". */
  confirmUnblockDownload(options: {
    verdict?: string;
    becauseBlockedByReputationCheck: boolean;
    window: Window;
    dialogType: "unblock" | "chooseUnblock" | "chooseOpen";
  }): Promise<string>;
}

// engine/toolkit/components/search/SearchService.sys.mjs (its getters throw before init has
// finished, except isInitialized) and SearchEngine.sys.mjs. `_urls` is the engine's internal
// list of URL templates.
interface SearchServiceApi {
  readonly isInitialized: boolean;
  readonly CHANGE_REASON: { readonly USER: number };
  init(): Promise<void>;
  getEngines(): Promise<SearchEngine[]>;
  getVisibleEngines(): Promise<SearchEngine[]>;
  getAppProvidedEngines(): Promise<SearchEngine[]>;
  getDefault(): Promise<SearchEngine>;
  readonly defaultEngine: SearchEngine | null;
  getEngineById(id: string): SearchEngine | null;
  addUserEngine(formInfo: { name: string; url: string; alias?: string }): Promise<UserSearchEngine>;
  removeEngine(engine: SearchEngine, changeReason: number): Promise<void>;
  setDefault(engine: SearchEngine, changeReason: number): Promise<void>;
}
interface SearchEngine {
  readonly id: string;
  readonly name: string;
  /** Empty without one; set trims it. */
  alias: string;
  readonly aliases: string[];
  readonly hidden: boolean;
  readonly _urls?: { readonly type: string; readonly template: string }[];
}
// engine/toolkit/components/search/UserSearchEngine.sys.mjs: an engine the user (or Vimma) added.
interface UserSearchEngine extends SearchEngine {
  /** False when another engine has the name. */
  rename(name: string): boolean;
  changeUrl(type: string, template: string | null, postData: string | null): void;
}

// engine/browser/modules/SitePermissions.sys.mjs: states are the permission manager's actions,
// scopes are strings. getPermissionLabel gives null for a permission without a label;
// getMultichoiceStateLabel gives null, or throws, for a state it has no label for.
interface SitePermissionsApi {
  readonly UNKNOWN: number;
  readonly ALLOW: number;
  readonly BLOCK: number;
  readonly SCOPE_PERSISTENT: string;
  readonly SCOPE_SESSION: string;
  readonly SCOPE_TEMPORARY: string;
  readonly SCOPE_POLICY: string;
  readonly SCOPE_GLOBAL: string;
  listPermissions(): string[];
  getPermissionLabel(id: string): string | null;
  getMultichoiceStateLabel(id: string, state: number): string | null;
  getAvailableStates(id: string): number[];
  getDefault(id: string): number;
  isSupportedPrincipal(principal: nsIPrincipal | null): boolean;
  getAllForBrowser(browser: MozBrowser): { id: string; state: number; scope: string }[];
  getForPrincipal(
    principal: nsIPrincipal,
    id: string,
    browser?: MozBrowser,
  ): { state: number; scope: string };
  setForPrincipal(
    principal: nsIPrincipal,
    id: string,
    state: number,
    scope?: string,
    browser?: MozBrowser,
  ): void;
  removeFromPrincipal(principal: nsIPrincipal, id: string, browser?: MozBrowser): void;
}

// ---------------------------------------------------------------------------------------------
// The windows and tabs workspaces/ and setup/ read (#938).

// engine/dom/base/nsGlobalWindowInner.cpp (DefineArgumentsProperty): the arguments a chrome
// window was opened with (strings and XPCOM objects: an nsIArray, an nsIPropertyBag2); undefined
// for a window opened without any.
interface ChromeWindow {
  readonly arguments?: readonly unknown[];
}
// engine/browser/base/content/utilityOverlay.js
interface BrowserWindow {
  /** A new-tab or blank page's URL (about:blank, about:home, the new-tab page). */
  isBlankPageURL(url: string): boolean;
}
// engine/toolkit/content/widgets/browser-custom-element.mjs and XULFrameElement.webidl: a
// browser's document and window, which only a browser in the parent process has (about:
// pages such as about:vimma-setup, about:preferences); a remote browser's are null. The window
// is a full global, so the browser tests reach its own globals through it.
interface MozBrowser {
  readonly canGoBack: boolean;
  readonly contentDocument: Document | null;
  readonly contentWindow: (Window & typeof globalThis) | null;
}
// engine/dom/webidl/Document.webidl (chrome-only)
interface Document {
  /** The about:blank a frame starts with, which a load replaces. */
  readonly isInitialDocument: boolean;
}
// engine/browser/modules/URILoadingHelper.sys.mjs openLinkIn: the options workspace routing
// reads and sets on its copy of `params`.
interface OpenLinkInParams {
  private?: boolean;
  triggeringPrincipal?: nsIPrincipal | null;
  userContextId?: number | null;
  /** The browser a "current" load goes to; the target window's selected one when unset. */
  targetBrowser?: MozBrowser | null;
}
// engine/toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs
// (getIdentityObserverOutput): the subject of the contextual-identity-* notifications.
interface ContextualIdentityNotification {
  readonly wrappedJSObject: { readonly userContextId: number; readonly name: string };
}
// The XPCOM objects a browser window's arguments hold (engine/xpcom/ds/nsISupportsPrimitives.idl,
// nsIArray.idl, nsIPropertyBag2.idl; their ids are in XPCOMInterfaces below).
interface nsIArray {
  readonly length: number;
}
interface nsIPropertyBag2 {
  /** Throws for a property the bag does not have. */
  getPropertyAsBool(name: string): boolean;
}

// ---------------------------------------------------------------------------------------------
// XPCOM: the interface ids in Ci, the classes in Cc and the interfaces Vimma reaches through them
// (#938). Only the interfaces and members Vimma uses; the IDL in the engine tree is the reference.

// engine/js/xpconnect/src/XPCJSID.cpp: `Ci.nsIFoo`. `x instanceof Ci.nsIFoo` asks x for the
// interface (QueryInterface) and is true when it has it; QueryInterface and createInstance give
// the object as the interface the id names.
interface nsIJSIID<T> {
  readonly name: string;
  [Symbol.hasInstance](value: unknown): value is T;
}
// engine/xpcom/base/nsISupports.idl: every XPCOM object. QueryInterface throws NS_NOINTERFACE
// for an interface the object does not have.
interface nsISupports {
  QueryInterface<T>(iid: nsIJSIID<T>): T;
}
// engine/js/xpconnect/src/XPCJSID.cpp: `Cc[contract]`, a component class.
interface nsIJSCID {
  /** A new object of the class. */
  createInstance<T>(iid: nsIJSIID<T>): T;
  /** The class's one object, made on the first call. */
  getService<T>(iid: nsIJSIID<T>): T;
}
// engine/xpcom/base/nsID.h: a class or interface id (Components.ID, Services.uuid).
interface nsID {
  toString(): string;
}
type XPCOMInstance<K extends keyof XPCOMInterfaces> =
  XPCOMInterfaces[K] extends nsIJSIID<infer T> ? T : never;
type XPCOMMethodName<T> = {
  [P in keyof T]: T[P] extends (...args: never[]) => unknown ? P : never;
}[keyof T];

// The classes Vimma makes or gets, by contract ID: `Cc[id]` is undefined for one that is not
// registered, so a class some builds lack is optional.
interface XPCOMClasses {
  "@mozilla.org/alert-notification;1": nsIJSCID;
  "@mozilla.org/alerts-service;1": nsIJSCID;
  "@mozilla.org/binaryinputstream;1": nsIJSCID;
  "@mozilla.org/browser/shell-service;1": nsIJSCID;
  "@mozilla.org/consoleAPI-storage;1": nsIJSCID;
  "@mozilla.org/file/local;1": nsIJSCID;
  /** Only where Firefox is built with GIO (Linux). */
  "@mozilla.org/gio-service;1"?: nsIJSCID;
  "@mozilla.org/login-manager/loginInfo;1": nsIJSCID;
  "@mozilla.org/network/file-input-stream;1": nsIJSCID;
  "@mozilla.org/network/server-socket;1": nsIJSCID;
  "@mozilla.org/network/socket-transport-service;1": nsIJSCID;
  "@mozilla.org/process/util;1": nsIJSCID;
  "@mozilla.org/referrer-info;1": nsIJSCID;
  "@mozilla.org/reputationservice/application-reputation-service;1": nsIJSCID;
  "@mozilla.org/scriptableinputstream;1": nsIJSCID;
  "@mozilla.org/security/hash;1": nsIJSCID;
  "@mozilla.org/supports-PRBool;1": nsIJSCID;
  "@mozilla.org/supports-string;1": nsIJSCID;
  "@mozilla.org/text-input-processor;1": nsIJSCID;
  // The updater's three classes: only in a build with MOZ_UPDATER.
  "@mozilla.org/updates/update-checker;1"?: nsIJSCID;
  "@mozilla.org/updates/update-manager;1"?: nsIJSCID;
  "@mozilla.org/updates/update-service;1"?: nsIJSCID;
  "@mozilla.org/widget/clipboardhelper;1": nsIJSCID;
  "@mozilla.org/widget/transferable;1": nsIJSCID;
  /** An about: page's module: undefined for a page no module serves. */
  [about: `@mozilla.org/network/protocol/about;1?what=${string}`]: nsIJSCID | undefined;
}

// The interface ids Vimma names, with the constants it and its tests read.
interface XPCOMInterfaces {
  nsIAboutModule: nsIJSIID<nsIAboutModule> & {
    readonly ALLOW_SCRIPT: number;
    readonly IS_SECURE_CHROME_UI: number;
  };
  nsIAlertNotification: nsIJSIID<nsIAlertNotification>;
  nsIAlertsService: nsIJSIID<nsIAlertsService>;
  nsIApplicationReputationService: nsIJSIID<nsIApplicationReputationService> & {
    readonly VERDICT_DANGEROUS: number;
    readonly VERDICT_SAFE: number;
    readonly VERDICT_UNCOMMON: number;
  };
  // The updater's ids, like its classes in XPCOMClasses, exist only with MOZ_UPDATER
  // (engine/toolkit/moz.build); VimmaUpdates reads their members only once it has the classes.
  nsIApplicationUpdateService: nsIJSIID<nsIApplicationUpdateService> & {
    readonly STATE_DOWNLOADING: number;
    readonly STATE_PENDING: number;
    readonly STATE_STAGING: number;
    readonly STATE_SWAP: number;
  };
  nsIArray: nsIJSIID<nsIArray>;
  nsIAsyncInputStream: nsIJSIID<nsIAsyncInputStream>;
  nsIAsyncOutputStream: nsIJSIID<nsIAsyncOutputStream>;
  nsIAppStartup: nsIJSIID<nsIAppStartup> & {
    readonly eAttemptQuit: number;
    readonly eRestart: number;
  };
  nsIBaseWindow: nsIJSIID<nsIBaseWindow>;
  nsIBinaryInputStream: nsIJSIID<nsIBinaryInputStream>;
  nsIBrowserDOMWindow: nsIJSIID<nsIBrowserDOMWindow> & {
    readonly OPEN_CURRENTWINDOW: number;
    readonly OPEN_EXTERNAL: number;
    readonly OPEN_NEWTAB: number;
    readonly OPEN_NEWWINDOW: number;
  };
  nsIClipboardHelper: nsIJSIID<nsIClipboardHelper>;
  nsICommandLine: nsIJSIID<nsICommandLine> & {
    readonly STATE_INITIAL_LAUNCH: number;
    readonly STATE_REMOTE_AUTO: number;
  };
  nsICommandLineHandler: nsIJSIID<nsISupports>;
  nsIComponentRegistrar: nsIJSIID<nsIComponentRegistrar>;
  nsIConsoleAPIStorage: nsIJSIID<nsIConsoleAPIStorage>;
  nsIContentDispatchChooser: nsIJSIID<nsISupports>;
  nsIContentPolicy: nsIJSIID<nsISupports> & {
    readonly TYPE_DOCUMENT: number;
    readonly TYPE_SUBDOCUMENT: number;
    /** The content types by name; a name this Firefox does not have is undefined. */
    readonly [type: `TYPE_${string}`]: number | undefined;
  };
  nsICryptoHash: nsIJSIID<nsICryptoHash> & {
    readonly SHA256: number;
    readonly SHA512: number;
  };
  nsIDOMProcessParent: nsIJSIID<nsIDOMProcessParent>;
  nsIDocumentEncoder: nsIJSIID<nsISupports> & {
    readonly OutputLFLineBreak: number;
    readonly SkipInvisibleContent: number;
  };
  nsIEncodedChannel: nsIJSIID<nsIEncodedChannel>;
  nsIFactory: nsIJSIID<nsIFactory>;
  nsIFile: nsIJSIID<nsIFile> & {
    readonly DIRECTORY_TYPE: number;
    readonly NORMAL_FILE_TYPE: number;
  };
  nsIFileInputStream: nsIJSIID<nsIFileInputStream>;
  nsIGIOMimeApp: nsIJSIID<nsIGIOMimeApp>;
  nsIGIOService: nsIJSIID<nsIGIOService>;
  nsIHelperAppLauncherDialog: nsIJSIID<nsISupports>;
  nsIHttpChannel: nsIJSIID<nsIHttpChannel>;
  nsIInterfaceRequestor: nsIJSIID<nsIInterfaceRequestor>;
  nsILoadContext: nsIJSIID<nsILoadContext>;
  nsILoginInfo: nsIJSIID<nsILoginInfo>;
  nsINestedURI: nsIJSIID<nsINestedURI>;
  nsIProcess: nsIJSIID<nsIProcess>;
  nsIPropertyBag2: nsIJSIID<nsIPropertyBag2>;
  nsIReferrerInfo: nsIJSIID<nsIReferrerInfo> & {
    readonly EMPTY: number;
    readonly NO_REFERRER: number;
  };
  nsIRequest: nsIJSIID<nsIRequest> & { readonly LOAD_ANONYMOUS: number };
  nsIScriptError: nsIJSIID<nsIScriptError> & { readonly warningFlag: number };
  nsIScriptSecurityManager: nsIJSIID<nsISupports> & {
    readonly DISALLOW_INHERIT_PRINCIPAL: number;
  };
  nsIScriptableInputStream: nsIJSIID<nsIScriptableInputStream>;
  nsISelectionController: nsIJSIID<nsISelectionController> & {
    readonly SCROLL_SYNCHRONOUS: number;
    readonly SELECTION_ATTENTION: number;
    readonly SELECTION_FOCUS_REGION: number;
    readonly SELECTION_NORMAL: number;
    readonly SELECTION_ON: number;
  };
  nsISelectionDisplay: nsIJSIID<nsISupports>;
  nsISelectionListener: nsIJSIID<nsISelectionListener>;
  nsIServerSocket: nsIJSIID<nsIServerSocket>;
  nsIServiceManager: nsIJSIID<nsIServiceManager>;
  nsIShellService: nsIJSIID<nsISupports>;
  nsISocketTransportService: nsIJSIID<nsISocketTransportService>;
  nsISupports: nsIJSIID<nsISupports>;
  nsISupportsPRBool: nsIJSIID<nsISupportsPRBool>;
  nsISupportsString: nsIJSIID<nsISupportsString>;
  nsITextInputProcessor: nsIJSIID<nsITextInputProcessor>;
  nsITransferable: nsIJSIID<nsITransferable>;
  nsITransport: nsIJSIID<nsITransport> & { readonly OPEN_UNBUFFERED: number };
  nsIURIFixup: nsIJSIID<nsISupports> & { readonly FIXUP_FLAG_NONE: number };
  nsIUpdateChecker: nsIJSIID<nsIUpdateChecker> & {
    readonly BACKGROUND_CHECK: number;
    readonly FOREGROUND_CHECK: number;
  };
  nsIUpdateManager: nsIJSIID<nsIUpdateManager>;
  nsIWebProgressListener: nsIJSIID<nsISupports> & {
    readonly LOCATION_CHANGE_SAME_DOCUMENT: number;
    readonly STATE_CERT_USER_OVERRIDDEN: number;
    readonly STATE_IS_BROKEN: number;
    readonly STATE_IS_DOCUMENT: number;
    readonly STATE_IS_SECURE: number;
    readonly STATE_IS_WINDOW: number;
    readonly STATE_START: number;
    readonly STATE_STOP: number;
  };
}

// engine/xpcom/components/nsIComponentManager.idl, nsIComponentRegistrar.idl and
// nsIServiceManager.idl: Components.manager, which is all three.
interface nsIComponentManager extends nsISupports {}
interface nsIComponentRegistrar extends nsISupports {
  registerFactory(
    cid: nsID,
    className: string | null,
    contractID: string | null,
    factory: nsIFactory | null,
  ): void;
  isContractIDRegistered(contractID: string): boolean;
}
interface nsIServiceManager extends nsISupports {
  isServiceInstantiatedByContractID<T>(contractID: string, iid: nsIJSIID<T>): boolean;
}
// engine/xpcom/components/nsIFactory.idl
interface nsIFactory extends nsISupports {
  createInstance(iid: nsIJSIID<unknown>): unknown;
}
// engine/netwerk/protocol/about/nsIAboutModule.idl
interface nsIAboutModule extends nsISupports {
  getURIFlags(uri: nsIURI): number;
  newChannel(uri: nsIURI, loadInfo: nsILoadInfo): nsIChannel;
  getChromeURI(uri: nsIURI): nsIURI;
}
// engine/xpcom/io/nsIFile.idl
interface nsIFile extends nsISupports {
  readonly path: string;
  initWithPath(path: string): void;
}
// engine/netwerk/base/nsIRequest.idl, nsIChannel.idl and engine/netwerk/protocol/http/
// nsIHttpChannel.idl, nsIEncodedChannel.idl
interface nsIRequest extends nsISupports {
  loadFlags: number;
  isPending(): boolean;
}
interface nsIChannel extends nsIRequest {
  originalURI: nsIURI;
  readonly URI: nsIURI;
  readonly loadInfo: nsILoadInfo;
}
interface nsIHttpChannel extends nsIChannel {
  /** How many redirects it follows; 0 makes a redirect fail. */
  redirectionLimit: number;
}
interface nsIEncodedChannel extends nsISupports {
  /** False keeps a compressed body as it came. */
  applyConversion: boolean;
}
// engine/netwerk/base/nsILoadInfo.idl
interface nsILoadInfo {
  /** Null for a top-level load. */
  readonly loadingPrincipal: nsIPrincipal | null;
  /** The frame's id; 0 for a load no frame made (a system request). */
  readonly browsingContextID: number;
  /** The URI the document takes its URL and principal from; null: the channel's own. */
  resultPrincipalURI: nsIURI | null;
}
interface nsIURI extends nsISupports {}
// engine/netwerk/base/nsINestedURI.idl (view-source:, jar: and others)
interface nsINestedURI extends nsISupports {
  readonly innermostURI: nsIURI;
}
// engine/netwerk/base/nsIReferrerInfo.idl: `policy` is a referrer policy constant.
interface nsIReferrerInfo extends nsISupports {
  init(policy: number, sendReferrer?: boolean, originalReferrer?: nsIURI | null): void;
}
// engine/xpcom/io/nsIFile.idl
interface nsIFile {
  /** A symlink's target path; "" for a file that is not one. */
  readonly target: string;
  /** Null for the root. */
  readonly parent: nsIFile | null;
  /** Its mode bits (0o644). */
  readonly permissions: number;
  exists(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymlink(): boolean;
  isReadable(): boolean;
  isWritable(): boolean;
  isExecutable(): boolean;
  remove(recursive: boolean): void;
}
// engine/xpcom/io/nsIInputStream.idl, nsIAsyncInputStream.idl, nsIOutputStream.idl,
// nsIAsyncOutputStream.idl, nsIBinaryInputStream.idl, nsIFileInputStream.idl and
// nsIScriptableInputStream.idl. available() is the bytes that can be read now; it throws at the
// end of the stream, or with NS_BASE_STREAM_WOULD_BLOCK, as write() does. An async stream's
// callback is called once, on `target`, when the stream can be read or written, or is closed.
interface nsIInputStream extends nsISupports {
  available(): number;
  close(): void;
}
interface nsIAsyncInputStream extends nsIInputStream {
  asyncWait(
    callback: { onInputStreamReady(stream: nsIAsyncInputStream): void },
    flags: number,
    requestedCount: number,
    target: unknown,
  ): void;
}
interface nsIOutputStream extends nsISupports {
  /** The bytes of `buf` (a binary string) written. */
  write(buf: string, count: number): number;
  close(): void;
}
interface nsIAsyncOutputStream extends nsIOutputStream {
  asyncWait(
    callback: { onOutputStreamReady(stream: nsIAsyncOutputStream): void },
    flags: number,
    requestedCount: number,
    target: unknown,
  ): void;
}
interface nsIBinaryInputStream extends nsIInputStream {
  setInputStream(stream: nsIInputStream): void;
  /** Reads up to `length` bytes into `buffer`; the number read. */
  readArrayBuffer(length: number, buffer: ArrayBuffer): number;
  readByteArray(length: number): number[];
}
interface nsIFileInputStream extends nsIInputStream {
  init(file: nsIFile, ioFlags: number, perm: number, behaviorFlags: number): void;
}
interface nsIScriptableInputStream extends nsISupports {
  init(stream: nsIInputStream): void;
  /** Up to `count` bytes, as a binary string. */
  read(count: number): string;
}
// engine/netwerk/base/nsITransport.idl, nsISocketTransport.idl, nsIServerSocket.idl and
// nsISocketTransportService.idl. `reason` and `status` are nsresults; initWithFilename makes a
// Unix domain socket at `path` (`backlog` -1: the default).
interface nsITransport extends nsISupports {
  openInputStream(flags: number, segmentSize: number, segmentCount: number): nsIInputStream;
  openOutputStream(flags: number, segmentSize: number, segmentCount: number): nsIOutputStream;
  close(reason: number): void;
}
interface nsISocketTransport extends nsITransport {}
interface nsIServerSocket extends nsISupports {
  /** -1 for `port` picks a free one. */
  init(port: number, loopbackOnly: boolean, backlog: number): void;
  initWithFilename(path: nsIFile, permissions: number, backlog: number): void;
  asyncListen(listener: nsIServerSocketListener): void;
  close(): void;
  readonly port: number;
}
interface nsIServerSocketListener {
  onSocketAccepted(server: nsIServerSocket, transport: nsISocketTransport): void;
  onStopListening(server: nsIServerSocket, status: number): void;
}
interface nsISocketTransportService extends nsISupports {
  createUnixDomainTransport(path: nsIFile): nsISocketTransport;
}
// engine/xpcom/ds/nsISupportsPrimitives.idl
interface nsISupportsString extends nsISupports {
  data: string;
}
interface nsISupportsPRBool extends nsISupports {
  data: boolean;
}
// engine/xpcom/ds/nsIArray.idl and nsIPropertyBag2.idl
interface nsIArray extends nsISupports {
  /** The element as the interface `iid` names. */
  queryElementAt<T>(index: number, iid: nsIJSIID<T>): T;
}
interface nsIPropertyBag2 extends nsISupports {}
// engine/xpcom/base/nsIInterfaceRequestor.idl
interface nsIInterfaceRequestor extends nsISupports {
  getInterface<T>(iid: nsIJSIID<T>): T;
}
// engine/xpcom/threads/nsIProcess.idl: runw runs `file` with UTF-16 arguments; `blocking` false
// returns at once.
interface nsIProcess extends nsISupports {
  init(file: nsIFile): void;
  startHidden: boolean;
  noShell: boolean;
  runw(blocking: boolean, args: string[], count: number): void;
}
// engine/security/manager/ssl/nsICryptoHash.idl: finish gives the hash as a binary string, or
// base64 when `base64` is true.
interface nsICryptoHash extends nsISupports {
  init(algorithm: number): void;
  update(data: ArrayLike<number>, length: number): void;
  finish(base64: boolean): string;
}
// engine/toolkit/components/startup/public/nsIAppStartup.idl
interface nsIAppStartup extends nsISupports {
  readonly shuttingDown: boolean;
  readonly attemptingQuit: boolean;
  quit(mode: number): void;
  restartInSafeMode(mode: number): void;
}
// engine/widget/nsIBaseWindow.idl
interface nsIBaseWindow extends nsISupports {
  visibility: boolean;
}
// engine/widget/nsIClipboardHelper.idl: `context` is the window context that copies, so a
// private window's copy is marked private.
interface nsIClipboardHelper extends nsISupports {
  copyString(text: string, context?: WindowGlobalParent | null): void;
}
// engine/widget/nsITransferable.idl: getTransferData sets `data.value` to an nsISupportsString
// for text, and throws when there is none.
interface nsITransferable extends nsISupports {
  init(context: nsILoadContext | null): void;
  addDataFlavor(flavor: string): void;
  getTransferData(flavor: string, data: { value?: nsISupports }): void;
}
// engine/docshell/base/nsILoadContext.idl
interface nsILoadContext extends nsISupports {}
// engine/dom/interfaces/base/nsITextInputProcessor.idl: beginInputTransaction is false while
// another input method composes; keydown and keyup dispatch the event to the focused window.
interface nsITextInputProcessor extends nsISupports {
  beginInputTransaction(win: Window, callback: (...args: unknown[]) => boolean): boolean;
  keydown(event: KeyboardEvent, flags?: number): number;
  keyup(event: KeyboardEvent, flags?: number): boolean;
}
// engine/xpcom/base/nsIConsoleMessage.idl and engine/dom/bindings/nsIScriptError.idl: a console
// message; a script error or warning's `flags` say which (scriptErrorLevel in core).
interface nsIConsoleMessage extends nsISupports {
  readonly message: string;
}
interface nsIScriptError extends nsIConsoleMessage {
  readonly errorMessage: string;
  readonly sourceName: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly flags: number;
  readonly category: string;
  /** Its window's id; 0 for a message no window logged. */
  readonly innerWindowID: number;
  readonly timeStamp: number;
}
// engine/dom/console/nsIConsoleAPIStorage.idl: the console.* calls of the window with inner id
// `id` (dom/console/Console.cpp makes each event; `arguments` are the page's own values).
interface nsIConsoleAPIStorage extends nsISupports {
  getEvents(id?: string): ConsoleAPIEvent[];
}
interface ConsoleAPIEvent {
  readonly level: string;
  readonly arguments: unknown;
  readonly filename: unknown;
  readonly lineNumber: unknown;
  readonly columnNumber: unknown;
  readonly timeStamp: unknown;
}
// engine/dom/interfaces/base/nsIDOMProcessParent.idl
interface nsIDOMProcessParent extends nsISupports {
  readonly remoteType: string | null;
  readonly childID: number;
}
// engine/toolkit/components/alerts/nsIAlertsService.idl
interface nsIAlertNotification extends nsISupports {
  init(name?: string, imageURL?: string, title?: string, text?: string, clickable?: boolean): void;
}
interface nsIAlertsService extends nsISupports {
  showAlert(alert: nsIAlertNotification, listener?: unknown): void;
}
// engine/toolkit/components/reputationservice/nsIApplicationReputation.idl
interface nsIApplicationReputationService extends nsISupports {
  /** Whether Firefox treats a file of this name as a program. */
  isExecutable(fileName: string): boolean;
}
// engine/toolkit/system/gnome/nsIGIOService.idl (engine/xpcom/io): getAppForURIScheme throws when
// no app handles the scheme; its app is an nsIGIOMimeApp unless a Flatpak portal gives it.
interface nsIGIOService extends nsISupports {
  readonly isRunningUnderFlatpak: boolean;
  getAppForURIScheme(scheme: string): nsISupports;
}
interface nsIGIOMimeApp extends nsISupports {
  /** The desktop entry's id, `org.example.App.desktop`. */
  readonly id: string;
}
// engine/toolkit/mozapps/update/nsIUpdateService.idl (the update manager's `internal` is its
// nsIUpdateManagerInternal, with synchronous getters). Only the IDL's members: XPConnect wraps a
// JS-implemented service, so UpdateService.sys.mjs's other getters (isDownloading) read as
// undefined through it.
interface nsIUpdate {
  readonly buildID: string;
}
interface nsIUpdateCheckResult {}
interface nsIUpdateChecker extends nsISupports {
  checkForUpdates(checkType: number): { readonly result: Promise<nsIUpdateCheckResult> };
}
interface nsIApplicationUpdateService extends nsISupports {
  readonly disabled: boolean;
  readonly canUsuallyApplyUpdates: boolean;
  /** One of the STATE_ constants. */
  readonly currentState: number;
  onCheckComplete(result: nsIUpdateCheckResult): Promise<void>;
}
interface nsIUpdateManager extends nsISupports {
  readonly internal: {
    readonly readyUpdate: nsIUpdate | null;
    readonly downloadingUpdate: nsIUpdate | null;
  };
}
// engine/dom/interfaces/base/nsIBrowserDOMWindow.idl
interface nsIBrowserDOMWindow extends nsISupports {}
// engine/toolkit/components/commandlines/nsICommandLine.idl
interface nsICommandLine extends nsISupports {
  /** One of the STATE_ constants: the first launch, or a remote one. */
  readonly state: number;
}

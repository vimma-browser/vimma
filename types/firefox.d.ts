// The slice of Firefox chrome globals our code uses. Extend as needed; the engine tree is the
// source of truth (e.g. engine/xpcom/base/nsIPrefBranch.idl).

declare const Services: {
  prefs: {
    getBoolPref(name: string, defaultValue?: boolean): boolean;
    getIntPref(name: string, defaultValue?: number): number;
    getStringPref(name: string, defaultValue?: string): string;
    setBoolPref(name: string, value: boolean): void;
    setIntPref(name: string, value: number): void;
    setStringPref(name: string, value: string): void;
    prefHasUserValue(name: string): boolean;
    clearUserPref(name: string): void;
    savePrefFile(file: null): void;
    getDefaultBranch(root: string): {
      setBoolPref(name: string, value: boolean): void;
    };
    addObserver(
      name: string,
      observer: (subject: unknown, topic: string, data: string) => void,
    ): void;
    removeObserver(
      name: string,
      observer: (subject: unknown, topic: string, data: string) => void,
    ): void;
  };
  // engine/xpcom/base/nsIConsoleService.idl: its cached messages, of any kind (each use checks
  // for nsIScriptError, engine/dom/bindings/nsIScriptError.idl).
  console: {
    getMessageArray(): any[] | null;
  };
  // engine/netwerk/base/nsIIOService.idl
  io: {
    createExposableURI(uri: { spec: string }): { spec: string; displaySpec: string };
    newURI(spec: string): { readonly scheme: string; readonly spec: string };
    newChannelFromURIWithLoadInfo(uri: unknown, loadInfo: unknown): any;
  };
  // engine/netwerk/dns/nsIEffectiveTLDService.idl
  eTLD: {
    getBaseDomain(uri: unknown, additionalParts?: number): string;
  };
  // engine/dom/interfaces/base/nsIFocusManager.idl
  focus: {
    readonly focusedElement: Element | null;
    readonly focusedContentBrowsingContext: any;
    clearFocus(window: Window): void;
  };
  // engine/caps/nsIScriptSecurityManager.idl
  scriptSecurityManager: {
    getSystemPrincipal(): unknown;
    checkLoadURIWithPrincipal(principal: unknown, uri: unknown, flags?: number): void;
  };
  // engine/widget/nsIClipboard.idl
  clipboard: {
    readonly kGlobalClipboard: number;
    getData(transferable: unknown, whichClipboard: number): void;
  };
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
  // engine/xpcom/system/nsIXULRuntime.idl
  appinfo: {
    readonly processID: number;
    readonly version: string;
    readonly appBuildID: string;
    readonly OS: string;
  };
  // engine/xpcom/base/nsIVersionComparator.idl
  vc: { compare(a: string, b: string): number };
  // engine/xpcom/ds/nsIObserverService.idl
  obs: {
    addObserver(
      observer: (subject: unknown, topic: string, data: string | null) => void,
      topic: string,
    ): void;
    removeObserver(
      observer: (subject: unknown, topic: string, data: string | null) => void,
      topic: string,
    ): void;
    notifyObservers(subject: unknown, topic: string, data?: string): void;
  };
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
  wm: { getMostRecentWindow(type: string): Window | null };
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
};

// XPCOM component classes and results (engine/js/xpconnect). Untyped on purpose: each use
// names its interface, and the IDL in the engine tree is the reference.
declare const Cc: any;
declare const Cr: Record<string, number>;

// engine/dom/chrome-webidl/PathUtils.webidl
declare const PathUtils: {
  readonly profileDir: string;
  join(...components: string[]): string;
  parent(path: string, depth?: number): string | null;
  filename(path: string): string;
  toFileURI(path: string): string;
};

// engine/dom/chrome-webidl/IOUtils.webidl
declare const IOUtils: {
  createUniqueFile(parent: string, prefix: string, permissions?: number): Promise<string>;
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
};

// engine/js/xpconnect/idl/xpccomponents.idl (nsIXPCComponents_Utils); the encoder is
// engine/dom/serializers/nsIDocumentEncoder.idl.
declare const Cu: {
  readonly isInAutomation: boolean;
  createDocumentEncoder(type: string): {
    init(doc: Document, type: string, flags: number): void;
    setRange(range: Range): void;
    setContainerNode(node: Node): void;
    encodeToString(): string;
  };
};

// XPCOM in system modules: interface constants and component constructors.
declare const Ci: any;
declare const Components: {
  Constructor(cid: string, iface: string, init?: string): any;
  ID(id: string): unknown;
  readonly manager: any;
  isSuccessCode(code: number): boolean;
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
  defineESModuleGetters(target: object, modules: Record<string, string>): void;
  registerWindowActor(name: string, options: object): void;
  generateQI(interfaces: string[]): (iid: unknown) => any;
  now(): number;
  getXPCOMErrorName(code: number): string;
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
  readonly manager: { getActor(name: string): any; readonly innerWindowId: number };
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
  readonly windowUtils: {
    readonly AUTHOR_SHEET: number;
    loadSheetUsingURIString(sheetURI: string, type: number): void;
    removeSheetUsingURIString(sheetURI: string, type: number): void;
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
  };
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

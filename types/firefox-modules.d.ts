// The Firefox modules Vimma's product code imports with ChromeUtils.importESModule, by URL, with
// the exports it and the browser tests read (the modules only the tests import are in
// types/mochitest/firefox-test-modules.d.ts); Vimma's own modules are generated into the same map
// (types/vimma-modules.d.ts). Each export is LazyModules' type where it has one
// (types/firefox.d.ts), so an import and a lazy getter of the same module agree; a module only
// imported here lists just the members Vimma uses. tools/test/vimma-modules.test.ts fails when the
// product imports a URL that neither file maps, and the product's type check fails where it reads
// one (importESModule gives `unknown` for it).
interface VimmaModules {
  // engine/toolkit/modules/AppConstants.sys.mjs
  "resource://gre/modules/AppConstants.sys.mjs": {
    AppConstants: LazyModules["AppConstants"] & {
      /** The build's key, or the placeholder configure leaves without one. */
      readonly MOZ_GOOGLE_SAFEBROWSING_API_KEY: string;
      // For the browser tests (product code does not read these):
      readonly BROWSER_CHROME_URL: string;
      readonly MOZ_APP_VERSION: string;
      readonly MOZ_CRASHREPORTER: boolean;
      readonly MOZILLA_OFFICIAL: boolean;
      readonly MOZ_TELEMETRY_REPORTING: boolean;
      /** The Remote Settings servers the build may use, comma-separated. */
      readonly REMOTE_SETTINGS_SERVER_URLS: string;
    };
  };
  // engine/toolkit/components/places/PlacesUtils.sys.mjs
  "resource://gre/modules/PlacesUtils.sys.mjs": { PlacesUtils: PlacesUtilsApi };
  // engine/browser/components/places/PlacesBrowserStartup.sys.mjs: set once Places' browser
  // start-up (its restore included) is done and places-browser-init-complete was notified.
  "moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs": {
    PlacesBrowserStartup: {
      readonly _placesBrowserInitComplete: boolean;
      // For the browser tests; product code does not read these.
      _placesInitialized: boolean;
      initPlaces(): void;
    };
  };
  // engine/toolkit/modules/BrowserUtils.sys.mjs
  "resource://gre/modules/BrowserUtils.sys.mjs": { BrowserUtils: LazyModules["BrowserUtils"] };
  // engine/browser/actors/ClickHandlerParent.sys.mjs: AgentPages wraps contentAreaClick (#1568);
  // the browser tests listen for each click it handled.
  "resource:///actors/ClickHandlerParent.sys.mjs": {
    ClickHandlerParent: {
      readonly prototype: {
        readonly manager: WindowGlobalParent;
        contentAreaClick(data: ClickHandlerData): void;
      };
      addContentClickListener(listener: {
        onContentClick(browser: MozBrowser, data: ClickHandlerData): void;
      }): void;
      removeContentClickListener(listener: object): void;
    };
  };
  // engine/toolkit/modules/PrivateBrowsingUtils.sys.mjs
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs": {
    PrivateBrowsingUtils: LazyModules["PrivateBrowsingUtils"] & {
      // For the browser tests; product code must not call it.
      isBrowserPrivate(browser: MozBrowser): boolean;
    };
  };
  // engine/browser/modules/webrtcUI.sys.mjs
  "resource:///modules/webrtcUI.sys.mjs": { webrtcUI: LazyModules["webrtcUI"] };
  // engine/toolkit/modules/Timer.sys.mjs
  "resource://gre/modules/Timer.sys.mjs": Pick<
    LazyModules,
    "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"
  >;
  // engine/browser/components/sessionstore/SessionStore.sys.mjs
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs": {
    SessionStore: LazyModules["SessionStore"] & {
      deleteCustomTabValue(tab: MozTabbrowserTab, key: string): void;
      // For the browser tests, down to forgetClosedWindow; product code must not call them.
      // The session as JSON, and a window's as an object; setWindowState takes either form.
      getBrowserState(): string;
      getWindowState(win: Window): { windows: Record<string, unknown>[] };
      setWindowState(win: Window, state: string | object, overwrite: boolean): void;
      setTabState(tab: MozTabbrowserTab, state: string | object): void;
      getClosedTabCount(options?: { private?: boolean }): number;
      getClosedTabCountForWindow(win: Window): number;
      getClosedWindowCount(): number;
      /** The reopened tab; throws for an index the source has no closed tab at. */
      undoCloseTab(source: Window, index: number, targetWindow?: Window): MozTabbrowserTab;
      forgetClosedTab(source: Window, index: number): void;
      forgetClosedWindow(index: number): void;
    };
  };
  // engine/browser/components/shell/ShellService.sys.mjs: the proxy's own object, whose methods
  // AppLauncher wraps (the two checks take startupCheck and forAllTypes).
  "moz-src:///browser/components/shell/ShellService.sys.mjs": {
    ShellService: {
      isDefaultBrowser(startupCheck?: boolean, forAllTypes?: boolean): boolean;
      isDefaultBrowserAsync(startupCheck?: boolean, forAllTypes?: boolean): Promise<boolean>;
      setDefaultBrowser(forAllUsers?: boolean): Promise<void>;
      _attemptedSetDefaultThisSession: boolean;
    };
  };
  // engine/browser/components/migration/MigrationUtils.sys.mjs: the entry points the import
  // wizard is opened with (the setup page passes FILE_MENU).
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs": {
    MigrationUtils: {
      readonly MIGRATION_ENTRYPOINTS: { readonly FILE_MENU: string };
      // For the browser tests; product code does not read these.
      readonly availableMigratorKeys: string[];
      insertManyBookmarksWrapper(bookmarks: object[], parentGuid: string): Promise<void>;
    };
  };
  // engine/browser/components/urlbar/QuickSuggest.sys.mjs: resolves once Suggest has started.
  "moz-src:///browser/components/urlbar/QuickSuggest.sys.mjs": {
    QuickSuggest: {
      readonly initPromise: Promise<void>;
      // For the browser tests; product code must not call them.
      init(): Promise<void>;
      _test_reset(): Promise<void>;
    };
  };
  // engine/browser/components/urlbar/UrlbarUtils.sys.mjs: the base class of the address bar's
  // result providers, which host/urlbar-commands.mjs extends (it overrides the members it uses),
  // and UrlbarUtils, which tab-ops.mjs reads lazily and the browser tests replace a method of.
  "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs": {
    UrlbarProvider: new () => object;
    UrlbarUtils: LazyModules["UrlbarUtils"];
  };
  // engine/browser/components/urlbar/UrlbarProvidersManager.sys.mjs: a search access point's
  // providers, one manager per access point.
  "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs": {
    ProvidersManager: {
      getInstanceForSap(sapName: string): {
        registerProvider(provider: object): void;
        unregisterProvider(provider: object): void;
      };
    };
  };
  // engine/browser/components/urlbar/content/UrlbarShared.mjs: the provider types (the product)
  // and the result types and groups (the browser tests).
  "chrome://browser/content/urlbar/UrlbarShared.mjs": {
    UrlbarShared: {
      readonly PROVIDER_TYPE: { readonly HEURISTIC: number };
      readonly RESULT_TYPE: {
        readonly TAB_SWITCH: number;
        readonly SEARCH: number;
        readonly URL: number;
      };
      readonly RESULT_GROUP: { readonly GENERAL_PARENT: string };
    };
  };
  // engine/browser/components/urlbar/UrlbarPrefs.sys.mjs: the result groups of a search access
  // point, which UrlbarRows wraps (a method Vimma replaces, so writable).
  "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs": {
    UrlbarPrefs: {
      getResultGroups(options: {
        context: { sapName: string };
      }): import("../src/browser/base/content/vimma/search/UrlbarRows.sys.mjs").ResultGroup;
    };
  };
}

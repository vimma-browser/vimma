// The Firefox modules only the browser tests import with ChromeUtils.importESModule, by URL, with
// the members the tests read (#938). A module the product imports too is in
// types/firefox-modules.d.ts, which both programs read; an export the product reads lazily reuses
// LazyModules' type (types/firefox.d.ts). tools/test/vimma-modules.test.ts fails when a test
// imports a URL that no map has, and the tests' type check fails where it reads one
// (importESModule gives `unknown` for it).
interface VimmaModules {
  // engine/browser/components/migration/InternalTestingProfileMigrator.sys.mjs: the tests stub
  // its prototype's methods.
  "moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs": {
    InternalTestingProfileMigrator: {
      readonly key: string;
      readonly testProfile: { readonly id: string; readonly name: string };
      readonly prototype: {
        getResources(profile: { id: string; name: string }): unknown;
        getSourceProfiles(): Promise<{ id: string; name: string }[]>;
      };
    };
  };
  // engine/browser/components/migration/MigrationUtils.sys.mjs
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs": {
    MigrationUtils: {
      readonly availableMigratorKeys: string[];
      insertManyBookmarksWrapper(bookmarks: object[], parentGuid: string): Promise<void>;
    };
  };
  // engine/browser/components/sessionstore/SessionFile.sys.mjs: the session file's paths.
  "moz-src:///browser/components/sessionstore/SessionFile.sys.mjs": {
    SessionFile: { readonly Paths: { readonly recovery: string } };
  };
  // engine/browser/components/sessionstore/SessionSaver.sys.mjs: writes the session now.
  "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs": {
    SessionSaver: { run(): Promise<void> };
  };
  // engine/browser/components/sessionstore/TabStateFlusher.sys.mjs
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs": {
    TabStateFlusher: {
      flush(browser: MozBrowser): Promise<void>;
      flushWindow(win: Window): Promise<void>;
    };
  };
  // engine/browser/components/sidebar/SidebarManager.sys.mjs
  "moz-src:///browser/components/sidebar/SidebarManager.sys.mjs": {
    SidebarManager: { updateDefaultTools(): void };
  };
  // engine/toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs": Pick<
    LazyModules,
    "ContextualIdentityService"
  >;
  // engine/toolkit/components/pictureinpicture/PictureInPicture.sys.mjs
  "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs": Pick<
    LazyModules,
    "PictureInPicture"
  >;
  // engine/toolkit/components/search/SearchService.sys.mjs: getEngineByName gives null for a name
  // it does not have, getEngineByAlias resolves to null for an alias.
  "moz-src:///toolkit/components/search/SearchService.sys.mjs": {
    SearchService: SearchServiceApi & {
      readonly CHANGE_REASON: { readonly UNKNOWN: number };
      getEngineByName(name: string): SearchEngine | null;
      getEngineByAlias(alias: string): Promise<TestSearchEngine | null>;
    };
  };
  // engine/browser/modules/AboutNewTab.sys.mjs
  "resource:///modules/AboutNewTab.sys.mjs": Pick<LazyModules, "AboutNewTab">;
  // engine/browser/modules/BrowserWindowTracker.sys.mjs
  "resource:///modules/BrowserWindowTracker.sys.mjs": {
    BrowserWindowTracker: LazyModules["BrowserWindowTracker"] & { readonly windowCount: number };
  };
  // engine/browser/modules/ExtensionsUI.sys.mjs: a permission prompt's strings, and the prompts.
  // showPermissionsPrompt resolves to whether the user accepted.
  "resource:///modules/ExtensionsUI.sys.mjs": {
    ExtensionsUI: {
      _buildStrings(info: {
        addon: { name: string };
        permissions: { permissions: string[]; origins: string[] };
      }): object;
      showPermissionsPrompt(
        browser: MozBrowser,
        strings: object,
        icon: string | null,
      ): Promise<boolean>;
      /** Resolves once the notice is dismissed. */
      showInstallNotification(browser: MozBrowser, addon: object): Promise<void>;
    };
  };
  // engine/browser/modules/HomePage.sys.mjs: the home page's URLs, `|`-separated.
  "resource:///modules/HomePage.sys.mjs": {
    HomePage: { get(win?: Window): string; getDefault(): string };
  };
  // engine/browser/modules/SitePermissions.sys.mjs
  "resource:///modules/SitePermissions.sys.mjs": Pick<LazyModules, "SitePermissions">;
  // engine/browser/components/asrouter/modules/ASRouterTargeting.sys.mjs
  "resource:///modules/asrouter/ASRouterTargeting.sys.mjs": {
    ASRouterTargeting: { readonly Environment: { readonly firefoxVersion: number } };
  };
  // engine/toolkit/mozapps/extensions/AddonManager.sys.mjs: getAddonByID resolves to null for an
  // add-on that is not installed.
  "resource://gre/modules/AddonManager.sys.mjs": {
    AddonManager: AddonManagerApi & {
      getAddonByID(id: string): Promise<TestAddon | null>;
      getAllAddons(): Promise<TestAddon[]>;
      getInstallForFile(file: nsIFile): Promise<AddonInstall & { install(): Promise<TestAddon> }>;
    };
    AddonManagerPrivate: { backgroundUpdateCheck(): Promise<void> };
  };
  // engine/toolkit/components/downloads/DownloadIntegration.sys.mjs: the spam protection is
  // made on first use.
  "resource://gre/modules/DownloadIntegration.sys.mjs": {
    DownloadIntegration: LazyModules["DownloadIntegration"] & {
      readonly downloadSpamProtection: {
        removeDownloadSpamForWindow(url: string, win: Window): void;
      };
    };
  };
  // engine/toolkit/components/downloads/Downloads.sys.mjs, as the tests use it.
  "resource://gre/modules/Downloads.sys.mjs": { Downloads: DownloadsApi };
  // engine/toolkit/components/extensions/ExtensionPermissions.sys.mjs
  "resource://gre/modules/ExtensionPermissions.sys.mjs": Pick<LazyModules, "ExtensionPermissions">;
  // engine/toolkit/components/passwordmgr/FirefoxRelayUtils.sys.mjs
  "resource://gre/modules/FirefoxRelayUtils.sys.mjs": {
    FirefoxRelayUtils: { relayIsAvailableOrEnabled(): boolean };
  };
  // engine/toolkit/components/satchel/FormHistory.sys.mjs
  "resource://gre/modules/FormHistory.sys.mjs": {
    FormHistory: {
      count(search: { fieldname?: string; value?: string }): Promise<number>;
      update(changes: { op: string; fieldname?: string; value?: string }): Promise<void>;
    };
  };
  // engine/toolkit/modules/Integration.sys.mjs: an override is a function from the combined
  // object below it to an object that has it as prototype.
  "resource://gre/modules/Integration.sys.mjs": {
    Integration: {
      readonly downloads: {
        register(factory: (base: object) => object): void;
        unregister(factory: (base: object) => object): void;
        getCombined(base: object): {
          launchDownload(download: FirefoxDownload, options: object): Promise<void>;
        };
      };
    };
  };
  // engine/netwerk/base/NetUtil.sys.mjs
  "resource://gre/modules/NetUtil.sys.mjs": {
    NetUtil: LazyModules["NetUtil"] & {
      newChannel(options: {
        uri: string | nsIURI;
        loadUsingSystemPrincipal: boolean;
      }): nsIChannel & {
        asyncOpen(listener: object): void;
      };
      readInputStream(stream: nsIInputStream, count: number): ArrayBuffer;
      readInputStreamToString(stream: nsIInputStream, count: number): string;
    };
  };
  // engine/toolkit/modules/OSKeyStore.sys.mjs: the tests replace encrypt.
  "resource://gre/modules/OSKeyStore.sys.mjs": Pick<LazyModules, "OSKeyStore">;
  // engine/toolkit/modules/Region.sys.mjs: home is null until the region is known.
  "resource://gre/modules/Region.sys.mjs": {
    Region: {
      readonly home: string | null;
      _setHomeRegion(region: string | null, notify?: boolean): void;
    };
  };
  // engine/toolkit/components/url-classifier/SafeBrowsing.sys.mjs: checkGoogleSafeBrowsingKey
  // gives "" (falsy) for a Google provider without a key; a provider has no entry until read.
  "resource://gre/modules/SafeBrowsing.sys.mjs": {
    SafeBrowsing: {
      readonly initialized: boolean;
      readonly providers: Record<string, { readonly updateURL: string }>;
      readonly listToProvider: Record<string, string>;
      checkGoogleSafeBrowsingKey(provider: string): boolean | "";
    };
  };
  // engine/toolkit/modules/ShortcutUtils.sys.mjs: the system action a key event triggers, or
  // undefined.
  "resource://gre/modules/ShortcutUtils.sys.mjs": {
    ShortcutUtils: { getSystemActionForEvent(event: KeyboardEvent): number | undefined };
  };
  // engine/toolkit/modules/subprocess/Subprocess.sys.mjs: a process started without a shell.
  "resource://gre/modules/Subprocess.sys.mjs": {
    Subprocess: {
      call(options: {
        command: string;
        arguments?: string[];
        environment?: Record<string, string>;
        environmentAppend?: boolean;
        stderr?: "ignore" | "stdout" | "pipe";
        workdir?: string;
      }): Promise<SubprocessProcess>;
      /** Rejects when no folder of PATH has the command. */
      pathSearch(command: string): Promise<string>;
    };
  };
  // engine/toolkit/modules/UpdateUtils.sys.mjs
  "resource://gre/modules/UpdateUtils.sys.mjs": Pick<LazyModules, "UpdateUtils">;
  // engine/toolkit/components/utils/ClientEnvironment.sys.mjs
  "resource://gre/modules/components-utils/ClientEnvironment.sys.mjs": {
    ClientEnvironmentBase: { readonly version: string };
  };
  // engine/toolkit/components/messaging-system/targeting/Targeting.sys.mjs: evaluates a JEXL
  // expression against the targeting environment, undefined when it fails.
  "resource://messaging-system/targeting/Targeting.sys.mjs": {
    TargetingContext: new () => { evalWithDefault(expression: string): Promise<unknown> };
  };
  // engine/toolkit/components/nimbus/ExperimentAPI.sys.mjs
  "resource://nimbus/ExperimentAPI.sys.mjs": {
    ExperimentAPI: { readonly rolloutsEnabled: boolean; readonly studiesEnabled: boolean };
  };
  // engine/toolkit/components/normandy/lib/RecipeRunner.sys.mjs: null until its prefs are read.
  "resource://normandy/lib/RecipeRunner.sys.mjs": {
    RecipeRunner: { readonly enabled: boolean | null };
  };
  // engine/browser/base/content/test/browser-fullscreen/DOMFullscreenTestUtils.sys.mjs
  "resource://testing-common/DOMFullscreenTestUtils.sys.mjs": {
    DOMFullscreenTestUtils: {
      init(scope: TestScope, win: Window): void;
      changeFullscreen(browser: MozBrowser, fullScreenState: boolean): Promise<void>;
    };
  };
  // engine/toolkit/components/enterprisepolicies/tests/EnterprisePolicyTesting.sys.mjs: the
  // policies as JSON, or a path to a policies file ("" for none).
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs": {
    EnterprisePolicyTesting: { setupPolicyEngineWithJson(json: object | string): Promise<void> };
  };
  // engine/toolkit/components/extensions/ExtensionTestCommon.sys.mjs: writes an add-on's files
  // into a temporary .xpi.
  "resource://testing-common/ExtensionTestCommon.sys.mjs": {
    ExtensionTestCommon: { generateXPI(data: { manifest: object; files?: object }): nsIFile };
  };
  // engine/testing/modules/MockRegistrar.sys.mjs: register gives the mock's class id.
  "resource://testing-common/MockRegistrar.sys.mjs": {
    MockRegistrar: {
      register(contractID: string, mock: object, args?: unknown[]): nsID;
      unregister(cid: nsID): void;
    };
  };
  // engine/toolkit/components/passwordmgr/test/OSKeyStoreTestUtils.sys.mjs
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs": {
    OSKeyStoreTestUtils: { setup(): void; cleanup(): Promise<void> };
  };
  // engine/toolkit/components/places/tests/PlacesTestUtils.sys.mjs
  "resource://testing-common/PlacesTestUtils.sys.mjs": {
    PlacesTestUtils: {
      addVisits(
        visits: string | { uri: string; title?: string } | { uri: string; title?: string }[],
      ): Promise<void>;
    };
  };
  // engine/toolkit/components/search/tests/SearchTestUtils.sys.mjs: installs a search engine
  // from a WebExtension manifest's search_provider fields.
  "resource://testing-common/SearchTestUtils.sys.mjs": {
    SearchTestUtils: {
      init(scope: TestScope): void;
      installSearchExtension(
        options?: object,
        install?: { setAsDefault?: boolean; setAsDefaultPrivate?: boolean; skipUnload?: boolean },
      ): Promise<unknown>;
    };
  };
  // engine/testing/modules/Sinon.sys.mjs: the members of sinon the tests use.
  "resource://testing-common/Sinon.sys.mjs": {
    sinon: SinonApi & { createSandbox(): SinonApi & { restore(): void } };
  };
  // engine/browser/components/urlbar/tests/UrlbarTestUtils.sys.mjs
  "resource://testing-common/UrlbarTestUtils.sys.mjs": {
    UrlbarTestUtils: {
      init(scope: TestScope): void;
      getResultCount(win: Window): number;
      /** Null past the last row. */
      getRowAt(win: Window, index: number): Element | null;
      getSelectedRowIndex(win: Window): number;
      getDetailsOfResultAt(win: Window, index: number): Promise<UrlbarResultDetails>;
      promiseAutocompleteResultPopup(options: { window: Window; value: string }): Promise<void>;
      promisePopupClose(win: Window): Promise<void>;
      promiseSearchComplete(win: Window): Promise<void>;
      /** A provider whose results wait for the promise. */
      TestProvider: new (options: { delayResultsPromise?: Promise<unknown> }) => object;
    };
  };
  // engine/netwerk/test/httpserver/httpd.sys.mjs
  "resource://testing-common/httpd.sys.mjs": { HttpServer: new () => nsIHttpServer };
}

// The scope a test utility module keeps (it reads the harness's functions from it): a test
// file's `this`, which is undefined to the type check, as it reads each file as a module.
type TestScope = object | undefined;

// engine/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs (AddonWrapper), as the tests read
// it.
interface TestAddon extends AddonWrapper {
  readonly userDisabled: boolean;
  uninstall(): Promise<void>;
}

// engine/toolkit/modules/subprocess/subprocess_common.sys.mjs (BaseProcess): readString resolves
// to "" at the end of the output.
interface SubprocessProcess {
  readonly stdout: { readString(): Promise<string> };
  wait(): Promise<{ readonly exitCode: number }>;
}

// engine/browser/components/urlbar/tests/UrlbarTestUtils.sys.mjs: a row's details; searchParams
// only for a search result.
interface UrlbarResultDetails {
  readonly type: number;
  readonly url: string;
  readonly heuristic: boolean;
  readonly searchParams?: { readonly suggestion?: string };
}

// engine/toolkit/components/search/SearchEngine.sys.mjs: whether the engine has a URL that
// gives the type (a MIME type, such as suggestions' JSON).
interface TestSearchEngine extends SearchEngine {
  supportsResponseType(type: string): boolean;
}

// Sinon's spies and stubs (engine/testing/modules/sinon-*.js), with the members the tests use.
interface SinonApi {
  spy<T extends object>(object: T, method: keyof T & string): SinonSpy;
  stub<T extends object>(object: T, method: keyof T & string): SinonStub;
}
interface SinonSpy {
  readonly callCount: number;
  readonly called: boolean;
  restore(): void;
}
interface SinonStub extends SinonSpy {
  returns(value: unknown): SinonStub;
  resolves(value?: unknown): SinonStub;
  throws(error: Error): SinonStub;
  callsFake(fn: (...args: never[]) => unknown): SinonStub;
  get(getter: () => unknown): SinonStub;
}

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "engine/",
      ".surfer/",
      "dist/",
      "reports/",
      ".stryker-tmp/",
      // copies of packages/vimma-core/src, linted there (npm run sync-core)
      "src/browser/base/content/vimma/core/",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
  },
  {
    // ADR-005: vimma-core must stay pure. Do not disable this rule.
    files: ["packages/vimma-core/src/**"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["resource://*", "chrome://*", "moz-src://*"],
              message: "vimma-core imports nothing from Firefox (ADR-005).",
            },
            {
              group: ["node:*", "fs", "path", "os"],
              message: "vimma-core is host-agnostic; no Node built-ins.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        "ChromeUtils",
        "Services",
        "gBrowser",
        "Cc",
        "Ci",
        "Cu",
        "window",
        "document",
      ],
    },
  },
  {
    // Vendored smol-toml (BSD-3-Clause), generated unchanged from upstream by
    // tools/vendor-smol-toml.mjs so updates stay mechanical. The purity rules above still apply;
    // only these two style rules, which upstream's assignment-in-condition loops trip, are off here.
    files: ["packages/vimma-core/src/vendor/**"],
    rules: { "no-cond-assign": "off", "no-useless-assignment": "off" },
  },
  {
    // Chrome-privileged code inside the Firefox window.
    files: ["src/**/vimma/**"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ChromeUtils: "readonly",
        Services: "readonly",
        // XPCOM and file I/O, for system modules (ctl/VimmaControl.sys.mjs)
        Cc: "readonly",
        Ci: "readonly",
        Cr: "readonly",
        IOUtils: "readonly",
        PathUtils: "readonly",
      },
    },
  },
  {
    // JSWindowActor base classes, globals in the system modules that define actors.
    files: ["src/**/vimma/actors/**"],
    languageOptions: {
      globals: {
        JSWindowActorChild: "readonly",
        JSWindowActorParent: "readonly",
        // System-module globals the parent side uses to check and open `F` targets.
        BrowsingContext: "readonly",
        Ci: "readonly",
        Components: "readonly",
        // Live grep's matching worker (actors/grep-worker.mjs), started by the child.
        ChromeWorker: "readonly",
      },
    },
  },
  {
    // about:vimma registers its nsIAboutModule factory through the component registrar.
    files: ["src/**/vimma/about/**"],
    languageOptions: { globals: { Components: "readonly" } },
  },
  {
    // The -vimma-reload-theme command-line handler: registrar, and Cu.isInAutomation.
    files: ["src/**/vimma/omarchy/**"],
    languageOptions: { globals: { Components: "readonly", Cu: "readonly" } },
  },
  {
    // The first run creates config.toml, but never under a test harness: Cu.isInAutomation.
    files: ["src/**/vimma/config/ConfigHost.sys.mjs"],
    languageOptions: { globals: { Cu: "readonly" } },
  },
  {
    // Test keys and a test install type are honoured only under a harness: Cu.isInAutomation
    // (docs/specs/m6a-updater.md §4 rule 1).
    files: ["src/**/vimma/updates/VimmaUpdates.sys.mjs"],
    languageOptions: { globals: { Cu: "readonly" } },
  },
  {
    // Element focus (docs/specs/element-focus.md): `y` serializes a block with the plain-text
    // document encoder (Cu.createDocumentEncoder), and a frame finds its subframe's element by
    // its browsing context.
    files: ["src/**/vimma/actors/block.mjs"],
    languageOptions: { globals: { BrowsingContext: "readonly", Cu: "readonly" } },
  },
  {
    // Agent pages launch no app: the component registrar wraps the external-protocol chooser
    // (docs/security.md M10).
    files: ["src/**/vimma/ctl/AgentPages.sys.mjs"],
    languageOptions: { globals: { Components: "readonly" } },
  },
  {
    // Agent downloads (docs/specs/vimma-mcp.md decision 31): the registrar wraps the helper-app
    // dialog, and a download's browsing context says which tab and container it came from.
    files: ["src/**/vimma/ctl/AgentDownloads.sys.mjs"],
    languageOptions: { globals: { BrowsingContext: "readonly", Components: "readonly" } },
  },
  {
    // vimma_console (docs/specs/mcp-forms.md F22, F24): a failed request's channel status, and
    // whether a tab whose request log is kept still exists.
    files: ["src/**/vimma/ctl/AgentConsole.sys.mjs"],
    languageOptions: { globals: { BrowsingContext: "readonly", Components: "readonly" } },
  },
  {
    // about:vimma-setup registers its nsIAboutModule through the component registrar, and is
    // never offered under a test harness: Cu.isInAutomation (docs/specs/first-run-setup.md).
    files: ["src/**/vimma/setup/SetupHost.sys.mjs"],
    languageOptions: { globals: { Components: "readonly", Cu: "readonly" } },
  },
  {
    // The -vimma-from command-line handler: the component registrar (workspace-routing).
    files: ["src/**/vimma/workspaces/WorkspaceRouter.sys.mjs"],
    languageOptions: { globals: { Components: "readonly" } },
  },
  {
    files: ["src/**/vimma/**/*.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    // The site suite's probes: functions sent over the DevTools protocol and run in a page
    // (content*) or in the browser window (chrome*), never in Node (docs/specs/site-compat.md).
    files: ["tools/sites/probes.mjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ChromeUtils: "readonly",
        Services: "readonly",
        Cc: "readonly",
        Ci: "readonly",
        gBrowser: "readonly",
      },
    },
  },
  {
    // The promo video's fixture pages' script: a web page (a module), in Firefox.
    files: ["tools/promo/fixtures/*.js"],
    languageOptions: {
      globals: { ...globals.browser, mozInnerScreenX: "readonly", mozInnerScreenY: "readonly" },
    },
  },
  {
    // Default-pref files (browser/branding/*/pref/): `pref()` is the only global.
    files: ["src/browser/branding/**/pref/*.js"],
    languageOptions: { sourceType: "script", globals: { pref: "readonly" } },
  },
  {
    // mochitest browser-chrome: runs in the browser window scope.
    files: ["tests/browser/**"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ChromeUtils: "readonly",
        Services: "readonly",
        Cc: "readonly",
        Ci: "readonly",
        Cr: "readonly",
        Cu: "readonly",
        ContentTaskUtils: "readonly", // inside SpecialPowers.spawn
        NewTabPagePreloading: "readonly",
        add_task: "readonly",
        info: "readonly",
        registerCleanupFunction: "readonly",
        Assert: "readonly",
        BrowserTestUtils: "readonly",
        EventUtils: "readonly",
        SpecialPowers: "readonly",
        SimpleTest: "readonly",
        gBrowser: "readonly",
        gURLBar: "readonly",
        SidebarController: "readonly",
        TestUtils: "readonly",
        PlacesUtils: "readonly",
        L10nRegistry: "readonly",
        FluentResource: "readonly",
        getRootDirectory: "readonly",
        getChromeDir: "readonly",
        getResolvedURI: "readonly",
        IOUtils: "readonly",
        PathUtils: "readonly",
        gTestPath: "readonly",
        WebExtensionPolicy: "readonly",
        ExtensionTestUtils: "readonly",
        openAboutDialog: "readonly",
        // the WebExtension global inside ExtensionTestUtils.loadExtension backgrounds
        browser: "readonly",
        // the content global inside SpecialPowers.spawn callbacks
        content: "readonly",
      },
    },
  },
];

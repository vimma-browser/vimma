// The browser window's globals that probes.mjs's chrome* functions use: they are sent over the
// DevTools protocol and run in Firefox's parent process, never in Node (docs/specs/site-compat.md).
// tsc has no per-file globals, so tools/tsconfig.json makes these visible to every file it checks;
// ESLint's no-undef (eslint.config.mjs, "The site suite's probes") keeps them to probes.mjs.
// The full chrome declarations are types/firefox.d.ts, which the browser code's check uses.

// XPCOM's component and interface tables (Components.classes and .interfaces), indexed by
// contract ID and interface name: any, as in types/firefox.d.ts, since describing XPCOM's
// interfaces would mean generating them from the IDL.
declare const Cc: any;
declare const Ci: any;

declare const Services: {
  console: { registerListener(listener: { observe(message: unknown): void }): void };
  obs: { addObserver(observer: { observe(subject: unknown): void }, topic: string): void };
  clipboard: { getData(transferable: unknown, whichClipboard: number, context: unknown): void };
};

declare const ChromeUtils: {
  // A module's exports: its shape is the module's own, which this file cannot name.
  importESModule(url: string): any;
};

declare const gBrowser: {
  selectedTab: Element;
  selectedBrowser: { fullZoom: number };
  isFindBarInitialized?(): boolean;
  getCachedFindBar(): { hidden: boolean; close(noAnimation?: boolean): void } | null;
};

// engine/dom/webidl/Window.webidl (chrome-only part)
interface Window {
  readonly browsingContext: { readonly currentWindowContext: unknown };
}

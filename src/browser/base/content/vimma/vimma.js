/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Loaded by browser.xhtml (browser-xhtml.patch) right after browser-main.js.

{
  const { MozillaServices } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/services/MozillaServices.sys.mjs",
  );
  MozillaServices.init();

  // Video keeps the screen awake on Wayland (wake-lock): set before any page plays.
  const { WakeLock } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/services/WakeLock.sys.mjs",
  );
  WakeLock.init();

  // The start page as the new-tab page, before this window opens its first tab (start-page).
  const { StartPage } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/start/StartPage.sys.mjs",
  );
  StartPage.init(window);

  // about:vimma, registered at runtime once per process (spec m5-about-vimma): no upstream patch.
  const { AboutVimma } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
  );
  AboutVimma.register();

  // Once per process, before the host dispatches page keys (m1-actor-insert-scroll).
  const { VimmaActors } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
  );
  VimmaActors.register();

  // The theme tokens, before any UI uses them (m5-omarchy-theme): the built-in palette now, the
  // Omarchy theme once read, then whatever omarchy-theme-set switches to.
  const { ThemeHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ui/theme-host.mjs",
  );
  ThemeHost.init(window);

  // Instant theme reload (m5-omarchy-theme): `-vimma-reload-theme` from Omarchy's theme-set hook,
  // which this installs when it finds Omarchy. Once per process.
  const { OmarchyHook } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/omarchy/OmarchyHook.sys.mjs",
  );
  OmarchyHook.init();

  const { VimmaHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
  );
  VimmaHost.init(window);

  // The workspace definitions, once per app (m3-workspaces, sub-spec 2a): Tabbrowser-sys-mjs.patch
  // asks the store for the container of a tab or window opened without one. Not awaited: until
  // it is loaded, the store reads its file synchronously on the first such question.
  const { WorkspaceStore } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
  );
  WorkspaceStore.init().catch((e) => console.error("vimma: workspaces not loaded", e));

  // Workspace routing (spec workspace-routing): `-vimma-from <app>` from vimma-open, once per
  // process; the [[routes]] rules come with config.toml below.
  const { WorkspaceRouter } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
  );
  WorkspaceRouter.init();

  // Split panes (spec m4-split-panes): the window's pane tree; sub-spec 3's keys drive it.
  const { PaneViews } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/split/PaneView.mjs",
  );
  PaneViews.init(window);

  // config.toml (spec m5-config-load), once its users exist: the keymap, [panes] max, hints,
  // [sites] and [theme]. Read asynchronously; until then the built-in defaults apply.
  const { ConfigHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
  );
  ConfigHost.init(window);

  // The first-run setup (docs/specs/first-run-setup.md): about:vimma-setup once per process, and
  // the welcome screen in front on a profile's first start, after the window's own first tab.
  const { SetupHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
  );
  SetupHost.register();
  if (!SetupHost.offerBlocked) {
    window.delayedStartupPromise.then(() => SetupHost.offer(window));
  }

  // Update checks (spec m6a-updater), once per process: one a few seconds after the first
  // window is ready when due (spec update-notices), then every 12 hours. config.toml's
  // [updates] check comes with ConfigHost above.
  const { VimmaUpdates } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
  );
  VimmaUpdates.init();

  // One control server per app (spec m0-control-server); off unless vimma.control.enabled.
  const { VimmaControl } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
  );
  VimmaControl.init(window);

  // docs/specs/vimma-mcp.md decision 29 D: `:control on <minutes>` ends, also across a restart.
  const { ControlHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/control-ops.mjs",
  );
  ControlHost.init();

  // Decision 30: the agent workspace's pages ask for no permission and open no pop-up.
  const { AgentPages } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ctl/AgentPages.sys.mjs",
  );
  AgentPages.init();

  // docs/specs/mcp-forms.md F22: the agent workspace's failed requests, for vimma_console.
  const { AgentConsole } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ctl/AgentConsole.sys.mjs",
  );
  AgentConsole.init();

  // The private workspace in place of this window on Hyprland (spec private-swap): learns the
  // window's address while `[private] placement = "swap"` applies. Nothing without Hyprland.
  const { PrivateSwap } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/private-swap.mjs",
  );
  PrivateSwap.init(window);
  window.addEventListener("unload", () => VimmaHost.uninit(window), { once: true });
}

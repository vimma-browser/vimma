# Spec: firefox-surfaces-trim

Status: accepted (delivery steps 2, 3, 4a and 6 built; step 2's vimma.dev links wait for step 1) ·
Area:
`src/browser/branding/vimma/pref/firefox-branding.js`,
`src/browser/branding/vimma/locales/en-US/brand.ftl` (new),
`src/toolkit/locales/en-US/toolkit/branding/brandings.ftl` (generated, `tools/branding/brandings.mjs`), `src/browser/themes/shared/vimma/`
(`firefox-pages.css`, `firefox-chrome.css`), `src/browser/base/content/vimma/jar.mn`,
`src/browser/base/content/vimma/start/`, `packages/vimma-core/src/actions.mjs` and `defaults.mjs`,
`vimma-browser/vimma-site` (support pages) · Upstream patches: Fluent string patches in delivery
step 5, each with its ADR-003 register line · ADR: [ADR-003](../adr/003-own-files-minimal-patches.md)

Issue: [#834](https://github.com/vimma-browser/vimma/issues/834)

Step 2 sets every pref in its rows except the two that point at vimma.dev pages,
`app.support.baseURL` and `identity.mobilepromo.*`: they keep Firefox's values until the vimma.dev
support pages (delivery step 1) exist, so that no link points at a missing page.

## Summary

A Vimma user still meets Firefox and Mozilla in menus, Settings, the About dialog and several
pages: links to Mozilla's support and feedback sites, promotions for Mozilla's products, Firefox's
AI chatbot and Labs, Firefox's logos and product names, and strings that credit Vimma with work
Mozilla does. This spec removes those surfaces, points the ones Vimma needs at vimma.dev, and makes
Settings look like the rest of Vimma (square corners, the theme's font). Firefox Sync and
addons.mozilla.org (AMO) stay, because they are services Vimma uses as Firefox does.

## Problem

Checked by reading the Firefox 159.0.1 source under `engine/` with Vimma's prefs and branding
applied; the items have not all been seen in a running build yet (each sub-PR confirms its own
with screenshots).

- **Links to Mozilla's sites.** `app.support.baseURL` is
  `https://support.mozilla.org/1/firefox/%VERSION%/%OS%/%LOCALE%/`
  (`browser/app/profile/firefox.js:1675`), so every "Learn more" link, Settings' "Vimma support"
  button and the Help menu's Get Help open Mozilla's support site. Help > Share Ideas opens
  `app.feedback.baseURL`, `https://ideas.mozilla.org/` (`firefox.js:1678`); Settings' support
  group links to `https://connect.mozilla.org/` in code
  (`browser/components/preferences/config/about-firefox.mjs:579-585`).
- **The About dialog** says "Vimma is designed by Vimma, a global community", with links to
  mozilla.org and `about:credits`, asks for donations to Mozilla, and links to Mozilla's Terms of
  Use and Privacy Notice (`browser/base/content/aboutDialog.xhtml:127-148`,
  `browser/locales/en-US/browser/aboutDialog.ftl:81-83`).
- **Menus.** The context menu offers Send Page and Send Link to Device whenever Mozilla accounts
  are enabled, signed in or not (`browser/base/content/browser-sync.js:3452-3456`,
  `browser/base/content/browser-context.inc.xhtml:136-140,465-469`), and Ask an AI Chatbot
  (`browser/components/genai/GenAI.sys.mjs:936-948`). The Help menu (`alt+h`) has Get Help, Share
  Ideas, Switching to a New Device and Report Broken Site
  (`browser/base/content/browser-menubar.inc.xhtml:434-462`); Tools has Firefox View (`:384`).
- **The account button** in the navigation toolbar (Vimma shows the toolbar by default,
  `vimma.ui.toolbar.hidden` false in `firefox-branding.js`) promotes Mozilla Monitor
  (`identity.fxaccounts.toolbar.pxiToolbarEnabled.monitorEnabled`, `firefox.js:3180`, read in
  `browser-sync.js:4024-4035`), and the app menu shows Firefox's Kit mascot in a sign-in promo
  (`browser/base/content/appmenu-viewcache.inc.xhtml:59-67`,
  `identity.fxaccounts.toolbar.appMenuSignInPromo.dismissed`, `firefox.js:3191`).
- **Settings.** Home offers "Firefox Home (Default)" for new windows and tabs
  (`browser/components/preferences/config/home-startup.mjs:27,490,510`; `preferences.ftl:963-964`)
  and a "Firefox Home" content group for a page Vimma never shows
  (`browser/extensions/newtab/lib/AboutPreferences.sys.mjs:116`). Data collection offers to "Send
  technical and interaction data to Vimma" (`preferences.ftl:2128`) although Vimma builds upload
  nothing ([m0-mozilla-services](m0-mozilla-services.md), "Why telemetry does not upload"); it
  shows because `MOZ_DATA_REPORTING` is set (`permissions-data.mjs:292-296`). The Firefox Labs
  pane appears when Labs recipes arrive (`browser/components/preferences/preferences.js:570-579`),
  and the AI controls pane is on (`browser.preferences.aiControls`, `firefox.js:1529`; read at
  `preferences.js:279-282`). The About Vimma section and its navigation button carry Firefox's
  glyph (`preferences.xhtml:192-194`, `chrome://browser/skin/sidebar/firefox.svg`), and the Sync
  pane's account group Mozilla's logo (`account-sync.mjs:856,866`).
- **Firefox product names** from `toolkit/locales/en-US/toolkit/branding/brandings.ftl`: Firefox
  View (`:54`), Firefox Home (`:50`), Firefox Labs (`:60`), Firefox Relay (`:27`), Firefox and
  Mozilla Monitor (`:18-20`), Mozilla VPN (`:24`).
- **Firefox pages.** Typed `about:home` and `about:newtab` still load Firefox's new tab page
  (`browser/components/newtab/AboutNewTabRedirector.sys.mjs:543-548`), `about:welcome` Firefox's
  onboarding (`browser/components/about/AboutRedirector.cpp:254-256`), and `about:firefoxview`
  Firefox View (`AboutRedirector.cpp:70`).
- **The default-browser prompt** appears from the second start (`browser.shell.checkDefaultBrowser`
  true, `firefox.js:287`), with Firefox's wording and mascot.
- **Vendor strings.** `-vendor-short-name` is Vimma (Surfer's generated `brand.ftl`, and
  `MOZ_APP_VENDOR` in `src/browser/moz-configure.patch`), so 36 strings that name the vendor now
  credit Vimma with Mozilla's work: "Not allowed by Vimma on this site" for Mozilla's
  quarantined-domain list (`browser/locales/en-US/browser/originControls.ftl:40,76`), "Report this
  extension to Vimma" for a report that goes to AMO (`addonNotifications.ftl:79`), "Vimma sites"
  in `about:processes` (`toolkit/locales/en-US/toolkit/about/aboutProcesses.ftl:56`), "your
  Vimma account" (`newtab.ftl:1459`), and the About dialog line above.
- **A missing brand term.** Vimma's `brand.ftl` has no `-brand-shortcut-name`, which stock brands
  define (`browser/branding/official/locales/en-US/brand.ftl:21`). `desktop-entry-name`
  (`browser/locales/en-US/browser/linuxDesktopEntry.ftl:9`) and
  `private-browsing-shortcut-text-2` (`browser.ftl:22`, used by
  `browser/components/shell/StartupOSIntegration.sys.mjs:279`) reference it, so those strings fail
  to resolve.

## Behaviour

1. Every support link Firefox builds from `app.support.baseURL` opens a vimma.dev URL. Settings'
   "Vimma support" button and Help > Get Help open vimma.dev, and Help > Share Ideas opens Vimma's
   GitHub discussions.
2. No menu, toolbar button, panel or Settings pane offers Send to Device, Monitor, the Kit sign-in
   promo, Switching to a New Device, Report Broken Site or Firefox View. Signing in to Sync from
   Settings > Sync works as in Firefox.
3. The context menu has no Ask an AI Chatbot or Preview Link item; Settings has no Firefox Labs and
   no AI controls pane; Firefox's sidebar launcher lists no AI chatbot tool. Each
   comes back when its pref is set to Firefox's default in `about:config`.
4. Settings > Home lists Vimma's start page as the default for new windows and tabs and has no
   Firefox Home content group; Settings has no data collection group.
5. The About dialog shows Vimma's name, version and logo, "Built on Firefox by Mozilla" (final
   wording in delivery step 5), the licence link, and no donation request, Mozilla terms or
   privacy links. `about:vimma` shows the same attribution line.
6. No visible string credits Vimma with Mozilla's work: the vendor strings listed in Problem name
   neither Vimma nor Mozilla ("Not allowed on this site", "Report this extension").
7. No Firefox or Mozilla logo or Kit mascot appears in Settings, the app menu, `about:addons`,
   `about:profiles`, `about:restartrequired` or the Firefox sidebar's empty states; each shows
   Vimma's logo or nothing.
8. A typed `about:home`, `about:newtab`, `about:welcome` or `about:firefoxview` opens Vimma's
   start page.
9. Vimma does not ask to become the default browser at startup.
10. Settings uses the theme's font (`--vimma-font`) and square corners, in the Omarchy theme and in
    the stock themes, and keeps Firefox's own colours and shapes under high contrast.
11. The Linux desktop entry and the private-browsing shortcut text read "Vimma" and "Vimma Private
    Browsing".

## Research

All engine paths are from Firefox 159.0.1 (`surfer.json`), read in `engine/`.

- **Support URLs.** Firefox appends the topic slug to the formatted base: `getHelpLinkURL`
  returns `formatURLPref("app.support.baseURL") + aHelpTopic`
  (`browser/base/content/utilityOverlay.js:597-599`), and `moz-support-link` does the same with
  its `support-page` attribute
  (`toolkit/content/widgets/moz-support-link/moz-support-link.mjs:46-53,109-110`). `%VERSION%`
  expands to `Services.appinfo.version` (`toolkit/components/urlformatter/URLFormatter.sys.mjs:90-92`),
  which is the Firefox version in Vimma ([m0-app-version](m0-app-version.md)); `%OS%` to
  `Services.appinfo.OS` (`:111-113`), `%LOCALE%` to the app locale (`:71`). Content-process pages
  (error pages, `about:logins`) read the same pref through `RPMGetFormatURLPref`
  (`toolkit/modules/RemotePageAccessManager.sys.mjs:45`), so one pref covers every caller.
- **The Help menu in the app menu.** The app menu's Help view copies only menu items whose
  `hidden` property is false (`browser/components/customizableui/content/panelUI.js:841-844`). A
  CSS rule on a menu bar item hides it in the menu bar only; its copy in the app menu is another
  element, with the id `appMenu_` plus the item's id (`cloneHelpMenuItem`, `:76`).
- **The account button** is in the navigation toolbar's default placements
  (`browser/components/customizableui/CustomizableUI.sys.mjs:375`). Send to Device
  (`send-tab-button`) and Firefox View (`firefox-view-button`) are customize-palette widgets
  (`CustomizableWidgets.sys.mjs:625,824`).
- **Firefox Labs** has one gate besides the recipes, the `FirefoxLabs` enterprise policy
  (`toolkit/components/nimbus/ExperimentAPI.sys.mjs:508`); `browser.preferences.experimental.hidden`
  is a cache that `firefoxLabs.mjs` rewrites (`preferences.js:570-577`), so a pref default
  cannot hide the pane on its own.
- **AI features.** `browser.ml.chat.enabled` (`firefox.js:2385`) removes the chatbot's menus,
  launcher tool and shortcuts; `browser.ml.linkPreview.enabled` (`firefox.js:2409`) the link
  preview; `browser.ai.control.*` (`modules/libpref/init/all.js:3639-3646`) hold the AI controls
  pane's states. The smart window is off upstream (`firefox.js:2425`). The sidebar launcher's
  default tools are `opentabs,bookmarks,aichat,history,syncedtabs,passwords`
  (`browser/components/sidebar/SidebarManager.sys.mjs:29-30`), used while `sidebar.main.tools`
  is empty (`firefox.js:2338`).
- **Relay** offers email masks in login forms while `signon.firefoxRelay.feature` is
  `"available"` (`firefox.js:3001`), and Settings > Passwords shows its switch
  (`browser/components/preferences/config/privacy.mjs:679-681`).
- **The About dialog** loads `chrome://branding/content/aboutDialog.css`
  (`aboutDialog.xhtml:33`), a branding file Surfer generates into
  `engine/browser/branding/vimma/content/`. The community and contribute paragraphs are
  `#communityDesc` and `#contributeDesc`, the bottom links `.bottom-link` with `href` on
  mozilla.org (`aboutDialog.xhtml:127,131,147-148`).
- **Images.** The logos and mascots are chrome files: `chrome://browser/skin/sidebar/firefox.svg`,
  `chrome://browser/skin/preferences/mozilla-logo.svg`, `chrome://global/skin/illustrations/kit-*.svg`,
  `chrome://browser/skin/sidebar/kit-*.svg`, `chrome://browser/skin/privatebrowsing/kit-pbw.svg`
  and `chrome://mozapps/skin/extensions/kit-*.svg` (`browser/themes/shared/jar.inc.mn:307-310,350`;
  sources under `toolkit/themes/shared/illustrations/` and `toolkit/themes/shared/extensions/`).
  A chrome manifest `override` line replaces a chrome URL everywhere it is loaded.
- **Strings.** Surfer has no per-message Fluent override: a file under `src/` replaces the engine
  file whole, and a `.patch` edits it. Within one Fluent bundle the first definition of a message
  wins and a duplicate logs an error, the constraint already recorded for
  `src/browser/locales/en-US/browser/browser-ftl.patch` in ADR-003's register.
- **Firefox Suggest** is named in Settings today, where [search-engines](search-engines.md)
  (decision 10, since changed) keeps the name because it names Mozilla's service; only the
  address bar's group heading was renamed, by `browser-ftl.patch`. Decision 14 renames it.
- **Who loads `brandings.ftl`.** 40 non-test files under `browser/` and `toolkit/` reference
  `toolkit/branding/brandings.ftl`; 7 of them do not also reference `branding/brand.ftl`
  (`webext-panels.xhtml`, `fxview-tab-list.mjs`, `aboutReader.html`, `aboutLogging.html` and three
  AI-window files), counted with `grep`. The upstream file is 66 lines.
- **Policies** (`DisableFirefoxAccounts`, `DisableFeedbackCommands`, `UserMessaging`,
  `DontCheckDefaultBrowser`, `GenerativeAI`, `FirefoxLabs`) would remove most of these surfaces,
  but they lock their prefs and make Settings say the browser is managed, the reason
  [m0-mozilla-services](m0-mozilla-services.md) ("How the defaults are applied") rejected
  `policies.json`.
- **Vimma today.** Settings' default-browser card hides the Kit mascot
  (`src/browser/themes/shared/vimma/firefox-pages.css:87-91`), but inside
  `@media not ((prefers-contrast) or (forced-colors))` (`:18`), so it returns under high
  contrast. The app menu's "Get Firefox for mobile" item is hidden
  (`src/browser/themes/shared/vimma/toolbar.css:110`). New tabs and the home page are Vimma's start
  page (`firefox-branding.js`, `browser.startup.homepage`, `vimma.startpage.newtab`). Vimma's
  keymap binds Firefox's sidebar panels: `ai_chatbot_sidebar` (`ctrl+alt+x`), `open_tabs_sidebar`
  (`ctrl+alt+u`) and `toggle_firefox_sidebar` (`ctrl+alt+z`)
  (`packages/vimma-core/src/actions.mjs:223-225`, `defaults.mjs:158-160`).

## Design

Each change uses the lightest mechanism that reaches it, in this order: a pref default in
`firefox-branding.js`; Vimma CSS in `firefox-pages.css` or `firefox-chrome.css`; Vimma code that
sets `hidden` where CSS is not enough; a whole-file replacement under `src/` or a chrome
`override` in `vimma/jar.mn`; a small upstream patch for strings.

| Surface                                                    | Mechanism                                                                                                                                                                                                                                                                  | Step |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Support links, Share Ideas                                 | prefs `app.support.baseURL` (vimma.dev), `app.feedback.baseURL` (Vimma's GitHub discussions)                                                                                                                                                                               | 2    |
| Monitor promo, Kit sign-in promo                           | prefs `…pxiToolbarEnabled.monitorEnabled` false, `…appMenuSignInPromo.dismissed` true                                                                                                                                                                                      | 2    |
| AI chatbot, link preview, AI controls pane, launcher tools | prefs `browser.ml.chat.enabled` false, `browser.ml.linkPreview.enabled` false, `browser.preferences.aiControls` false, `sidebar.main.tools` Firefox's list without `aichat`                                                                                                | 2    |
| Relay masks                                                | pref `signon.firefoxRelay.feature` `"disabled"`                                                                                                                                                                                                                            | 2    |
| Default-browser prompt                                     | pref `browser.shell.checkDefaultBrowser` false                                                                                                                                                                                                                             | 2    |
| Onboarding infobars, about:addons recommendations          | prefs `…asrouter.providers.onboarding` with `enabled:false`, `extensions.getAddons.showPane` false, `extensions.htmlaboutaddons.recommendations.enabled` false                                                                                                             | 2    |
| Leftover Mozilla URLs                                      | prefs `toolkit.datacollection.infoURL`, `datareporting.policy.firstRunURL`, `browser.uitour.url`, `breakpad.reportURL` empty; `identity.mobilepromo.*` and `browser.backup.template.fallback-download.*` to Vimma's site or releases                                       | 2    |
| `-brand-shortcut-name`                                     | `src/browser/branding/vimma/locales/en-US/brand.ftl` replacing Surfer's generated file                                                                                                                                                                                     | 3    |
| Product names (Firefox View, Home, Labs, Translations)     | `src/toolkit/…/brandings.ftl` generated from upstream's by `tools/branding/brandings.mjs` (decision 14)                                                                                                                                                                    | 3    |
| Logos and mascots                                          | chrome `override` lines in `vimma/jar.mn` to Vimma's logo or an empty SVG                                                                                                                                                                                                  | 3    |
| Labs pane, Firefox Home group, data collection, support    | Vimma CSS in `firefox-pages.css` for the Settings document                                                                                                                                                                                                                 | 4b   |
| Send to Device, Help items, Tools > Firefox View           | Vimma CSS in `firefox-chrome.css` on the Send to Device items in the page, link and tab menus, `#menu_openFirefoxView`, `#helpSwitchDevice`, the webcompat reporter items, their app menu copies and the `send-tab-button` and `firefox-view-button` widgets (decision 15) | 4a   |
| About dialog paragraphs and links                          | Vimma's `aboutDialog.css` over the generated one                                                                                                                                                                                                                           | 4b   |
| Settings look                                              | Vimma CSS: radius tokens 0, `font-family: var(--vimma-font)`                                                                                                                                                                                                               | 4b   |
| Typed about:home, newtab, welcome, firefoxview             | Vimma's start page module redirects the top-level load                                                                                                                                                                                                                     | 4b   |
| Vendor strings, About attribution line                     | Fluent patches                                                                                                                                                                                                                                                             | 5    |
| `ai_chatbot_sidebar` action and key                        | keymap change (decision 12)                                                                                                                                                                                                                                                | 6    |

1. **Firefox Sync stays; only its entry points go.** Settings > Sync keeps sign-in and Sync works
   as in Firefox, while the account button's Monitor promo, the app menu's Kit sign-in promo and
   the Send to Device menus and palette widget are hidden, because Sync is a reason to use a
   Firefox-based browser ([m0-mozilla-services](m0-mozilla-services.md), "Keep: Firefox Sync"),
   while those entry points advertise Mozilla's products in every menu. Rejected: turning Mozilla
   accounts off (`identity.fxaccounts.enabled` false), because it removes Sync; leaving them, since
   they are the surfaces this spec exists to remove.
2. **Support links go to vimma.dev.** `app.support.baseURL` is a vimma.dev support path that keeps
   Firefox's template, `https://vimma.dev/support/%VERSION%/%OS%/%LOCALE%/` (exact path set in
   step 2 with the site change in step 1), so every topic link resolves to
   `…/<locale>/<topic>`. vimma.dev serves a Vimma page for each topic it covers and, for any
   other topic, a general help page or a forward to the matching Mozilla article, so every link
   resolves and Vimma's interface never names Mozilla's site. Settings' "Vimma support" button and
   Help > Get Help then open vimma.dev and stay visible. Share Ideas opens Vimma's GitHub
   discussions through `app.feedback.baseURL`; Settings' hard-coded connect.mozilla.org link is
   hidden by CSS, since no pref sets it. Rejected: keeping support.mozilla.org, because Vimma's
   interface would keep sending readers to Mozilla for Vimma questions; an empty base, because
   Firefox's links would break.
3. **Firefox Labs hidden, Firefox's AI features off, as plain prefs.** The Labs pane is hidden in
   Settings and the address bar's "Open Firefox Labs" action with it, and the chatbot, link
   preview, AI controls pane and smart window are off by default, because Labs features are Nimbus
   recipes targeted and tested against Firefox on Mozilla's schedule (the reason Nimbus rollouts
   are off in [m0-mozilla-services](m0-mozilla-services.md)), and Vimma's AI is its own agent over
   MCP. Each is a `pref()` default that a user can set back in `about:config`, so nothing is
   locked. Labs has no pref of its own (Research), so the pane is hidden by CSS and the
   `browser.preferences.experimental.hidden` cache is left alone. This amends
   [m0-mozilla-services](m0-mozilla-services.md), which kept Labs unchanged; that spec carries a
   "Since changed" note. A Vimma list of its own `vimma.feature.*` flags is out of scope.
4. **The vendor stays Vimma; Mozilla's work is not claimed.** `-vendor-short-name` stays Vimma.
   The strings where it credits Vimma with Mozilla's actions get neutral wording that names
   neither ("Not allowed on this site", "Report this extension", "Privileged sites", "your
   account"), and data collection's "to Vimma" leaves with the hidden data collection group
   (decision 6). Attribution appears once, where readers look for it: "Built on Firefox by
   Mozilla" in the About dialog and on `about:vimma`, so Vimma names Firefox where it is accurate
   and nowhere else. Rejected: reverting the vendor to Mozilla, because it brings Mozilla's name
   back into 36 strings that name the vendor.
5. **Prefs, not policies.** Every pref this spec sets is a `pref()` default in
   `firefox-branding.js`, and no enterprise policy is used, because policies lock their prefs and
   make Settings say the browser is managed (Research). Firefox Suggest's region rewrite is not
   involved. One pref has a runtime writer: Firefox writes `sidebar.main.tools` as a user value
   (`SidebarManager.sys.mjs`, `updateDefaultTools`, at a profile's first window, and
   `ProfileDataUpgrader.sys.mjs`, migration 153), so a profile from before this change keeps
   `aichat` and with it the chatbot's page menu, which shows while `aichat` is a tool even with
   the chatbot off (`GenAI.sys.mjs`, `canShowAskChat`). `MozillaServices.sys.mjs` removes
   `aichat` from that user value at each start while `browser.ml.chat.enabled` is false, as
   Firefox's own migration 152 does, because a default cannot reach a user value.
6. **Settings hides what controls nothing in Vimma.** The data collection group is hidden,
   because Vimma builds upload no telemetry, health report or studies (m0-mozilla-services,
   "Why telemetry does not upload"), so its switches change nothing. The Firefox Home content group
   is hidden and Vimma's start page is the default in Home's menus, because Vimma never shows
   Firefox Home (`vimma.startpage.newtab`).
7. **Hiding rules hold under high contrast.** Rules that hide a surface sit outside the
   `@media not ((prefers-contrast) or (forced-colors))` block, and the Kit mascot rule moves out of
   it, so that a high-contrast user does not see Mozilla's surfaces return; only colour rules stay
   inside it, where [firefox-surfaces-theme](firefox-surfaces-theme.md) behaviour 8 put them.
8. **Settings looks like Vimma.** The Settings document gets square corners (Firefox's
   `--border-radius-*` tokens set to 0) and `--vimma-font`, as Vimma's own surfaces use
   (`firefox-toolbar.css`, `cmdline.css`), so Settings no longer reads as a different app inside
   Vimma. Colours stay as [firefox-surfaces-theme](firefox-surfaces-theme.md) set them.
9. **Images are replaced, not hidden one by one.** A chrome `override` line per logo or mascot
   points it at Vimma's logo (where the layout needs an image, such as the About Vimma
   navigation button) or an empty SVG (illustrations), because one line covers every page that
   loads the file, content-process pages included, where Vimma's CSS cannot reach.
   Step 3 overrides `sidebar/firefox.svg` with Vimma's mark as a one-colour glyph
   (`vimma-glyph.svg`, `context-fill`, so it follows the theme as Firefox's glyph did),
   `preferences/mozilla-logo.svg` with Firefox's plain account glyph (`fxa/avatar-empty.svg`),
   because that group is the Mozilla account and Vimma's mark there would claim it, and every
   `kit-*.svg` in Research, `kit-signed-out.svg` (the account panel) and the private-browsing
   page's `fox-tail.svg` with an empty SVG. `privatebrowsing/pbm-logo.svg` stays, because it is
   the indicator that marks a private window and carries no Firefox or Mozilla logo;
   `logos/lockwise.svg` stays with `about:protections`, which this spec does not change.
10. **Typed Firefox pages open the start page.** Vimma's start page module redirects a top-level
    load of `about:home`, `about:newtab`, `about:welcome` or `about:firefoxview` to the start
    page, so a user who types them sees Vimma's page as every new tab does. Rejected: a patch to
    `AboutRedirector.cpp`, because a C++ patch needs a full build on every rebase (ADR-010); the
    patch stays the fallback if step 3 finds a load the module cannot catch.
11. **Mozilla's own services keep their names and links.** AMO (installs, dictionaries), Safe
    Browsing (including Report Deceptive Site), `about:credits`, `about:policies` and the Mozilla
    root store wording stay, because they name or reach services Vimma uses unchanged, and
    renaming them would misattribute them the other way.
12. **Only the chatbot's sidebar key goes.** The `ai_chatbot_sidebar` action and its
    `ctrl+alt+x` key are removed, because the chatbot is off (decision 3) and the key would open a
    panel that does nothing. Firefox's own key on that chord (`viewGenaiChatSidebarKb`) becomes
    fate c in firefox-keys' inventory, unbound and off under the default `[firefox] disable =
"all"`, because a chord Vimma no longer binds would otherwise reach the chatbot whenever
    `browser.ml.chat.enabled` is set back to `true`; the pref (step 2) covers a user who lists the
    chord in `[firefox] enable`. A `config.toml` that still names `ai_chatbot_sidebar` (or
    `browser.sidebar_chatbot`) gets an error saying the action was removed and why, instead of a
    "did you mean" suggestion, because the config loader refuses unknown actions and a look-alike
    suggestion would mislead. `open_tabs_sidebar` (`ctrl+alt+u`) stays, because tabs from other
    devices come from Sync, which stays (decision 1); `toggle_firefox_sidebar` (`ctrl+alt+z`)
    stays, because the bookmarks, history and passwords panels still work. Rejected: dropping all
    three, because two of them reach features Vimma keeps.
13. **Firefox's onboarding and default-browser prompt are off.** The local onboarding messages
    (`browser.newtabpage.activity-stream.asrouter.providers.onboarding`, `firefox.js:2092`), the
    startup default-browser prompt and the UITour URL are off by default, because they speak in
    Firefox's voice, show the Kit mascot and promote Mozilla accounts, and Vimma has its own first
    run ([first-run-setup](first-run-setup.md)). Setting the default browser stays in Settings >
    General. This changes [m0-mozilla-services](m0-mozilla-services.md), which left these as
    Firefox has them; that spec carries a "Since changed" note.
14. **Product names come from a generated `brandings.ftl`.** `tools/branding/brandings.mjs`
    reads upstream's `toolkit/locales/en-US/toolkit/branding/brandings.ftl`, applies Vimma's
    mapping and writes `src/toolkit/locales/en-US/toolkit/branding/brandings.ftl`, which
    replaces the engine file in every document that loads it (`npm run gen-brandings`). A
    generated file follows Firefox's changes to the file on each bump, and its vitest
    (`tools/branding/test/brandings.test.mjs`) fails when the file is stale or when upstream has a
    term whose value says Firefox or Mozilla that the mapping does not decide, so a Firefox bump
    surfaces a new name instead of shipping it; a hand-kept copy would drift silently. `e2e.yml`
    runs that test before the import, because the import replaces upstream's file with a link to
    Vimma's and a CI engine has no history to read it from. The mapping renames only the features
    Vimma ships under its own name: Firefox Suggest becomes "Address Bar Suggestions" (it heads
    Settings' address bar group and reads in "Manage Address Bar Suggestions"), Firefox Home
    "Start Page" (Vimma's start page is what new tabs and windows show: "Start Page (Default)"),
    Firefox View "Tab Overview", Firefox Labs "Labs", Firefox Translations "Translations" and
    Firefox Screenshots "Screenshots". Mozilla's own products keep their names (Relay, Monitor,
    Mozilla VPN, Send, Profiler, Thunderbird, Fakespot), because renaming them would claim them as
    Vimma's (decision 4). Rejected: a hand-carried copy, because a rebase can keep a stale file or
    miss a new term; the terms in Vimma's `brand.ftl`, because the 7 documents that load
    `brandings.ftl` without `brand.ftl` would keep Firefox's names and each duplicate term logs a
    Fluent error. This changes [search-engines](search-engines.md) decision 10, which carries a
    "Since changed" note.
15. **The menus' entry points are hidden by CSS, not by `hidden`.** One rule in
    `firefox-chrome.css`, outside the high-contrast block (decision 7), hides the Send to Device
    menus and their separators, Tools > Tab Overview, Help > Switching to a New Device, Help >
    Report Broken Site and the protections panel's Report Broken Site button, and the Send to
    Device and Tab Overview widgets in customize mode and on any toolbar. CSS, because Firefox
    rewrites `hidden` on these items each time a menu opens or a tab loads (`browser-sync.js`,
    `updateContentContextMenu` and `updateTabContextMenu`; `ReportBrokenSite.sys.mjs`,
    `enableOrDisableMenuitems`, from the Help menu's and the app menu's `popupshown`), so a
    `hidden` set at window start would not hold. The app menu's Help view copies each visible
    Help item as `appMenu_` plus its id (Research) and replaces the Switch Device copy with a
    promo while `browser.nova.enabled` is on, so the rule names those copies and the promo too;
    every group of the Help view keeps an item, so no separator is left alone. Get Help and Share
    Ideas stay, because they open vimma.dev and Vimma's discussions (decision 2); Report Deceptive
    Site stays (decision 11); the account button stays, because it is Sync's entry point
    (decision 1). Rejected: Vimma code that sets `hidden` at window start, the mechanism this
    table first named, for the reason above; a listener that sets `hidden` again before each menu
    opens, because it races Firefox's own listeners on the same events. On macOS the menu bar is
    native and drawn from the items' attributes, which CSS does not reach, so its Tools and Help
    menus keep these items for now; the app menu, the context menus and customize mode are drawn
    by Gecko and covered on both platforms. Hiding them in the macOS menu bar is a follow-up for
    macOS, because Linux comes first.

## Security and privacy

No new surface. The changes remove entry points and point links at vimma.dev; Sync, Safe Browsing
and AMO are unchanged. vimma.dev's support pages are static and receive the Firefox version, OS
and locale in the path, as support.mozilla.org does today; no other data is sent. The forwards to
Mozilla articles are fixed redirects on vimma.dev, not an open redirect: an unknown topic gets the
general help page.

## Tests

Written first and seen to fail, by step.

- **Prefs** (step 2): `tools/branding/test/branding-prefs.test.mjs` asserts each value in the
  Design table. `browser_vimma_firefox_surfaces_trim.js` (new mochitest) asserts that
  `getHelpLinkURL("x")` starts with the vimma.dev base, that the account panel's Monitor button
  and `#appMenu-fxa-sign-in-promo` are hidden, that the content context menu has no chatbot or
  link-preview item, and that `Services.prefs` reports each pref back at Firefox's value after a
  user reset is reverted.
- **Branding** (step 3): a vitest that Vimma's `brand.ftl` defines `-brand-shortcut-name`, and
  `tools/branding/test/brandings.test.mjs` for the generator (decision 14); the
  mochitest formats `desktop-entry-name` and `private-browsing-shortcut-text-2` and gets "Vimma"
  and "Vimma Private Browsing"; it loads each overridden chrome URL and asserts it is Vimma's file.
- **Settings, menus, About dialog** (step 4): the mochitest opens `about:preferences` and asserts
  the Labs, AI controls, Firefox Home and data collection groups and the connect.mozilla.org link
  are not displayed, also with `prefers-contrast` forced; that a Settings card's computed
  `border-radius` is `0px` and its `font-family` is the theme's; that the page, link and tab menus
  show no Send to Device item, Tools no Tab Overview, the menu bar's Help menu and the app menu's
  Help view no Switching to a New Device or Report Broken Site, and customize mode no Send to
  Device or Tab Overview widget, while Get Help, Share Ideas and Settings > Sync's sign-in show
  (step 4a); that the About dialog's `#communityDesc`, `#contributeDesc` and mozilla.org
  bottom links are not displayed; and that loading `about:home`, `about:newtab`, `about:welcome`
  and `about:firefoxview` ends on the start page. An e2e scenario types those URLs through the
  control socket and checks the tab's URL.
- **Strings** (step 5): the mochitest formats each patched message and asserts it contains neither
  "Vimma" nor "Mozilla" where decision 4 says so, and that the About dialog and `about:vimma` show
  the attribution line.
- **Keymap** (step 6): the vitest for `actions.mjs` asserts `ai_chatbot_sidebar` is gone and
  `ctrl+alt+x` unbound; the help snapshot and `docs/bindings.md` are regenerated.
- **Screenshots** for steps 3 to 5: Settings (General, Home, Privacy, Sync, About Vimma), the app
  menu and its Help view, the context menu, the About dialog and `about:addons`, in the Omarchy
  theme (`vimma.theme.source=omarchy`) and a stock theme, each looked at before merging.

## Docs and changelog

- `docs/guide.md`: "Firefox behaviour Vimma changes" lists the hidden surfaces, the prefs that
  bring each back, and that support links open vimma.dev; "Privacy defaults" adds the AI features
  and the default-browser prompt.
- `docs/bindings.md` and the help snapshot change in step 6.
- CHANGELOG lines come from each step's commit subject (release-please).

## Delivery

1. **vimma-site support pages** (`vimma-browser/vimma-site`): the support path with its topic
   pages, general help page and forwards. A local preview goes to the maintainer before any push,
   as for every site change. It merges before step 2, so no link points at a missing page.
2. **Prefs** (`firefox-branding.js`): every row marked step 2, plus the vimma.dev support base.
   Tested by the branding vitest and the new mochitest.
3. **Branding files and images**: Vimma's `brand.ftl` with `-brand-shortcut-name`, the generated
   `brandings.ftl` (decision 14), and the `jar.mn` image overrides. Tested by the
   vitest, the mochitest and screenshots.
4. **Settings, menus and the About dialog**, in two pull requests, because the menus are small and
   do not depend on the Settings restyle:
   - **4a, menus**: the rule in `firefox-chrome.css` that hides the menus' and customize mode's
     entry points (decision 15). Tested by the mochitest and screenshots of the context menus,
     both Help menus, Tools and customize mode.
   - **4b, Settings, the About dialog and redirects**: the CSS in `firefox-pages.css` (hidden
     panes and groups, square corners, the theme's font, high-contrast rules), Vimma's
     `aboutDialog.css`, and the start page redirect. Tested by the mochitest, the e2e scenario
     and screenshots.
5. **String patches**: one Fluent patch per file for the vendor strings and the attribution
   line, each with its line in ADR-003's patch register; `about:vimma`'s attribution line.
   Tested by the mochitest and screenshots.
6. **Keymap**: drop the `ai_chatbot_sidebar` action and its `ctrl+alt+x` key (decision 12), with
   `npm run gen-docs`, the help snapshot and a screenshot of the `ctrl+b ?` overlay. Its own pull request, as every keymap change.

The spec becomes `implemented` with the last of these.

## 9. Privacy defaults

Spec: [m0-mozilla-services](../specs/m0-mozilla-services.md),
[m0-safebrowsing-key](../specs/m0-safebrowsing-key.md).

- P1. Vimma **must** be built without telemetry reporting and upload nothing.
  [`test_no_telemetry_upload`](../../tests/browser/browser_vimma_mozilla_services.js)
- P2. Studies and experiments (Normandy, Nimbus) **never** run.
  [`test_normandy_and_nimbus_do_not_run`](../../tests/browser/browser_vimma_mozilla_services.js),
  [`test_studies_crash_and_sponsored_defaults_are_off`](../../tests/browser/browser_vimma_mozilla_services.js)
- P3. Sponsored content and suggestions are **never** shown by default.
  [`test_no_sponsored_address_bar_suggestions`](../../tests/browser/browser_vimma_mozilla_services.js),
  [`test_sponsored_suggestions_survive_suggest_migrations`](../../tests/browser/browser_vimma_mozilla_services.js)
- P4. Crash reports are **never** sent. [`test_no_crash_reporter`](../../tests/browser/browser_vimma_crash_reporter.js)
- P5. Security services (add-on blocklist, CRLite, add-on updates) **must** keep Firefox's
  defaults. [`test_security_services_stay_on`](../../tests/browser/browser_vimma_mozilla_services.js)
- P6. Safe Browsing **must** be on in a build with a Google key, and honestly off (Settings
  says so) in one without.
  [`test_keyed_build_fetches_google_lists`](../../tests/browser/browser_vimma_safebrowsing.js),
  [`test_keyless_build_is_honestly_off`](../../tests/browser/browser_vimma_safebrowsing.js)
- P7. Site permissions (camera, location, notifications …) **must** be kept per container, so
  per workspace (`permissions.isolateBy.userContext`;
  [vimma-mcp](../specs/vimma-mcp.md) decision 30): one given in one workspace never applies to the
  same site in another, the agent workspace included.
  [`test_site_permissions_are_per_workspace`](../../tests/browser/browser_vimma_mcp_agent_pages.js)
- P8. A shipped build **must** have release Firefox's developer-tools defaults, although
  `MOZILLA_OFFICIAL` is unset (it would turn telemetry upload on, P1): no chrome-privileged
  Browser Console or Browser Toolbox (`devtools.chrome.enabled`), no remote debugging
  (`devtools.debugger.remote-enabled`, so `--start-debugger-server` is ignored), no `dump()` or
  chrome console output on stdout (`browser.dom.window.dump.enabled`,
  `devtools.console.stdout.chrome`), and the web console's paste guard on
  (`devtools.selfxss.count` = 0). The branding prefs set them. Only the dev harnesses' own
  profiles turn devtools back on: `npm start`'s `user.js` the first four, the site suite's
  (`tools/sites`) chrome and remote debugging. A console opened while `devtools.chrome.enabled`
  is true writes `devtools.selfxss.count` = 5 as a user value (upstream), so the guide says to
  reset it after turning the tools off.
  [`test_devtools_defaults_match_official_firefox`](../../tests/browser/browser_vimma_mozilla_services.js),
  [`startPrefs`](../../tools/test/start.test.ts)
- P9. Vimma opens Firefox's import wizard only from the setup page, as a dialog over the setup
  page's own tab, and **never** where the `DisableProfileImport` policy forbids it (spec
  [setup-v2](../specs/setup-v2.md), behaviour 23). Vimma passes the wizard only its entry point;
  the wizard reads other browsers' profiles on this computer and sends nothing anywhere.
  [`import_wizard_opens_over_the_setup_tab_and_resolves_when_it_closes`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`import_wizard_opens_only_over_the_setup_page`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`import_wizard_respects_the_policy`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`asks for Make default and the import wizard only from the setup host`](../../tools/security/test/chrome-source.test.ts)

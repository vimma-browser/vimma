/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The host side of setup v2's Moving in chapter (docs/specs/setup-v2.md, behaviours 22 and 23,
// decision 17): the default browser through Firefox's shell service, and Firefox's import
// wizard as a dialog over the setup tab. The shell service's two methods are replaced on its
// internal object for each task, so no test changes this machine's default browser.

"use strict";

const { SetupHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
);
const { ShellService } = ChromeUtils.importESModule(
  "moz-src:///browser/components/shell/ShellService.sys.mjs",
);
const { MigrationUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
);
const { InternalTestingProfileMigrator } = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs",
);
const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
const { EnterprisePolicyTesting } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs",
);

const SETUP_URL = "about:vimma-setup";
const WIZARD_URL = "chrome://browser/content/migration/migration-dialog-window.html";

add_task(async () => {
  // The page never reaches AMO here; a closed local port keeps it offline.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.setup.amoApi", "http://127.0.0.1:1/"],
      ["browser.migrate.internal-testing.enabled", true],
    ],
  });
  // The wizard lists only Firefox's test migrator, so it never reads the browsers installed on
  // this machine (as browser_vimma_firefox_wizard_theme.js).
  const sandbox = sinon.createSandbox();
  sandbox
    .stub(MigrationUtils, "availableMigratorKeys")
    .get(() => [InternalTestingProfileMigrator.key]);
  registerCleanupFunction(async () => {
    sandbox.restore();
    await SpecialPowers.popPrefEnv();
  });
});

/**
 * Runs `run` with the shell service's check and Make Default replaced; the proxy has no set
 * trap, so the assignment lands on its internal object, where AppLauncher's wrapper also lives.
 * @param {{ isDefault: boolean, setFails?: boolean }} state
 * @param {(calls: unknown[][]) => Promise<void>} run  gets the arguments of each Make Default
 */
async function withShell(state, run) {
  const isDefault = ShellService.isDefaultBrowser;
  const setDefault = ShellService.setDefaultBrowser;
  /** @type {unknown[][]} */
  const calls = [];
  ShellService.isDefaultBrowser = () => state.isDefault;
  ShellService.setDefaultBrowser = async (/** @type {unknown[]} */ ...args) => {
    calls.push(args);
    if (state.setFails) throw new Error("no handler database");
    state.isDefault = true;
  };
  try {
    await run(calls);
  } finally {
    ShellService.isDefaultBrowser = isDefault;
    ShellService.setDefaultBrowser = setDefault;
  }
}

/** @param {object} policies */
async function withPolicies(policies, /** @type {() => Promise<void>} */ run) {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({ policies });
  try {
    await run();
  } finally {
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
    // DefaultBrowserSettingEnabled and DisableProfileImport each lock a pref.
    for (const pref of [
      "browser.shell.checkDefaultBrowser",
      "browser.newtabpage.activity-stream.migrationExpired",
    ]) {
      if (Services.prefs.prefIsLocked(pref)) Services.prefs.unlockPref(pref);
      Services.prefs.clearUserPref(pref);
    }
  }
}

/**
 * Runs `run` with a tab showing `url` (the setup page ready to draw, for SETUP_URL), and removes
 * the tab after it, also on a failure.
 * @param {string} url
 * @param {(tab: MozTabbrowserTab) => Promise<void>} run
 */
async function withTab(url, run) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  try {
    if (url === SETUP_URL) {
      const doc = /** @type {Document} */ (tab.linkedBrowser.contentDocument);
      await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
    }
    await run(tab);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/** @param {MozBrowser} browser the content dialogs over the browser */
const dialogsOver = (browser) =>
  gBrowser.getTabDialogBox(browser).getContentDialogManager().dialogs;

add_task(async function default_browser_state_follows_the_shell_service() {
  const state = { isDefault: false };
  await withShell(state, async () => {
    Assert.deepEqual(SetupHost.defaultBrowserState(), { isDefault: false, canSet: true });
    state.isDefault = true;
    Assert.deepEqual(SetupHost.defaultBrowserState(), { isDefault: true, canSet: true });
  });
});

add_task(async function set_default_browser_calls_the_shell_service() {
  await withShell({ isDefault: false }, async (calls) => {
    Assert.equal(await SetupHost.setDefaultBrowser(), "default");
    Assert.deepEqual(calls, [[false]], "Make Default for this user, as Settings asks");
  });
});

add_task(async function set_default_browser_does_nothing_when_vimma_already_is() {
  await withShell({ isDefault: true }, async (calls) => {
    Assert.equal(await SetupHost.setDefaultBrowser(), "default");
    Assert.deepEqual(calls, [], "the shell service is not asked again");
  });
});

add_task(async function set_default_browser_reports_a_failure() {
  await withShell({ isDefault: false, setFails: true }, async (calls) => {
    Assert.equal(await SetupHost.setDefaultBrowser(), "failed");
    Assert.equal(calls.length, 1);
  });
});

add_task(async function set_default_browser_respects_the_policy() {
  await withShell({ isDefault: false }, async (calls) => {
    await withPolicies({ DefaultBrowserSettingEnabled: false }, async () => {
      Assert.deepEqual(SetupHost.defaultBrowserState(), { isDefault: false, canSet: false });
      Assert.equal(await SetupHost.setDefaultBrowser(), "unavailable");
    });
    Assert.deepEqual(calls, [], "the policy forbids Make Default");
  });
});

add_task(async function set_default_browser_respects_the_locked_button_pref() {
  const PREF = "pref.general.disable_button.default_browser";
  // Firefox has no default for it, and only a pref with a value can be locked.
  const defaults = Services.prefs.getDefaultBranch("");
  const hadDefault = defaults.getPrefType(PREF) !== defaults.PREF_INVALID;
  if (!hadDefault) defaults.setBoolPref(PREF, false);
  registerCleanupFunction(() => {
    if (!hadDefault) defaults.deleteBranch(PREF);
  });
  await withShell({ isDefault: false }, async (calls) => {
    Services.prefs.lockPref(PREF);
    try {
      Assert.equal(SetupHost.defaultBrowserState().canSet, false);
      Assert.equal(await SetupHost.setDefaultBrowser(), "unavailable");
    } finally {
      Services.prefs.unlockPref(PREF);
    }
    Assert.deepEqual(calls, []);
  });
});

add_task(async function import_wizard_opens_over_the_setup_tab_and_resolves_when_it_closes() {
  await withTab(SETUP_URL, async (tab) => {
    const browser = tab.linkedBrowser;
    // The wizard fills its list after it opens; closed before then, its actor writes to a dead
    // window (MigrationWizardChild.setComponentState).
    const ready = BrowserTestUtils.waitForEvent(window, "MigrationWizard:Ready");
    let settled = false;
    const result = SetupHost.openImportWizard(browser).then((r) => {
      settled = true;
      return r;
    });
    await TestUtils.waitForCondition(() => dialogsOver(browser).length === 1, "a dialog opens");
    const dialog = dialogsOver(browser)[0];
    await dialog._dialogReady;
    await ready;
    Assert.equal(dialog._frame.contentDocument.documentURI, WIZARD_URL, "the import wizard");
    const args = dialog._frame.contentWindow.arguments[0];
    Assert.deepEqual(
      { ...args.options },
      { entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.FILE_MENU, tabModal: true },
      "Firefox's tabModal options, with the entry point only",
    );
    Assert.ok(gBrowser.selectedTab === tab, "over the setup tab, which stays selected");
    Assert.ok(
      SetupHost.openImportWizard(browser) === SetupHost.openImportWizard(browser),
      "a second request while it is open waits for the same dialog",
    );
    await TestUtils.waitForTick();
    Assert.equal(dialogsOver(browser).length, 1, "and opens no second one");
    Assert.ok(!settled, "the promise waits for the dialog");
    dialog._frame.contentWindow.close();
    Assert.equal(await result, "closed");
    Assert.equal(dialogsOver(browser).length, 0);
  });
});

add_task(async function import_wizard_opens_only_over_the_setup_page() {
  await withTab("about:blank", async (tab) => {
    Assert.equal(await SetupHost.openImportWizard(tab.linkedBrowser), "unavailable");
    Assert.equal(await SetupHost.openImportWizard(null), "unavailable");
    Assert.equal(dialogsOver(tab.linkedBrowser).length, 0);
  });
});

add_task(async function import_wizard_respects_the_policy() {
  await withTab(SETUP_URL, async (tab) => {
    await withPolicies({ DisableProfileImport: true }, async () => {
      Assert.equal(await SetupHost.openImportWizard(tab.linkedBrowser), "unavailable");
    });
    Assert.equal(dialogsOver(tab.linkedBrowser).length, 0);
  });
});

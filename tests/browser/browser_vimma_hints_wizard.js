/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-hints.md. Apart from browser_vimma_hints.js, which is near the harness's
// time limit for a file on a two-CPU runner.

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_hints.html";

/** @param {XULBrowserElement} browser @param {string} mode */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === mode,
    `the tab is in ${mode} mode`,
  );
}

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

/** Presses `f` and waits for the labels. */
async function startHints() {
  EventUtils.synthesizeKey("f");
  await TestUtils.waitForCondition(() => VimmaHost._hints(window)?.hints.length, "hints are up");
  return found(VimmaHost._hints(window));
}

/**
 * The label of the innermost hint whose target rect holds the point, or undefined.
 * @param {HostHints} hints VimmaHost._hints(window)
 * @param {{ x: number, y: number }} c
 */
function labelAt(hints, c) {
  const area = (/** @type {HostHint} */ h) => h.target.rect.width * h.target.rect.height;
  return hints.hints
    .filter(
      (h) =>
        c.x >= h.target.rect.x &&
        c.x <= h.target.rect.x + h.target.rect.width &&
        c.y >= h.target.rect.y &&
        c.y <= h.target.rect.y + h.target.rect.height,
    )
    .sort((a, b) => area(a) - area(b))[0]?.label;
}

/** @param {string} label */
function type(label) {
  for (const c of label) EventUtils.synthesizeKey(c);
}

// Firefox's import wizard (#877) opens its browser list on mousedown, or on a click only when it
// came from the keyboard (migration-wizard.mjs handleEvent). A label on the list's button opens
// it as a press of the button does, and the arrow keys and Enter then choose another browser, so
// picking one of several needs no mouse. Two profiles of Firefox's test migrator stand in for two
// browsers (the file entries below them start an import as soon as they are chosen).
add_task(async function a_label_opens_the_import_wizards_browser_list() {
  const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
  const { InternalTestingProfileMigrator } = ChromeUtils.importESModule(
    "moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs",
  );
  const { MigrationUtils } = ChromeUtils.importESModule(
    "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
  );
  const proto = InternalTestingProfileMigrator.prototype;
  const resources = proto.getResources;
  const second = { id: "vimma-second", name: "Second" };
  const sandbox = sinon.createSandbox();
  // Settings' sync section names this device in a pref when it loads.
  const DEVICE_PREF = "identity.fxaccounts.account.device.name";
  const deviceName = Services.prefs.prefHasUserValue(DEVICE_PREF)
    ? Services.prefs.getStringPref(DEVICE_PREF)
    : null;
  /** @type {MozTabbrowserTab | undefined} */
  let from;
  /** @type {MozTabbrowserTab | undefined} */
  let tab;
  try {
    // Only the test migrator: the wizard would otherwise read the browsers installed here.
    sandbox
      .stub(MigrationUtils, "availableMigratorKeys")
      .get(() => [InternalTestingProfileMigrator.key]);
    sandbox
      .stub(proto, "getSourceProfiles")
      .resolves([InternalTestingProfileMigrator.testProfile, second]);
    sandbox.stub(proto, "getResources").callsFake(
      /** @this {object} the migrator */
      function () {
        return resources.call(this, InternalTestingProfileMigrator.testProfile);
      },
    );
    await SpecialPowers.pushPrefEnv({ set: [["browser.migrate.internal-testing.enabled", true]] });
    // From a tab with a page: the wizard then opens Settings in a tab of its own.
    from = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    const ready = BrowserTestUtils.waitForEvent(window, "MigrationWizard:Ready");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, (url) =>
      url.startsWith("about:preferences"),
    );
    // The route of `:firefox cmd_file_importFromAnotherBrowser`.
    /** @type {XULElement} */ (
      /** @type {Element} */ (document.getElementById("cmd_file_importFromAnotherBrowser"))
    ).doCommand();
    tab = await opened;
    await ready;
    const browser = tab.linkedBrowser;
    const wizard = found(
      found(browser.contentDocument).querySelector("#migrationWizardDialog migration-wizard"),
    );
    const shadow = found(wizard.openOrClosedShadowRoot);
    const selector = /** @type {MigrationWizardSelector} */ (
      shadow.querySelector("#browser-profile-selector")
    );
    const list = /** @type {PanelListElement} */ (shadow.querySelector("panel-list"));
    // In a chrome document the wizard puts its list in a XUL <panel> (migration-wizard.mjs).
    const panel = /** @type {XULPopupElement} */ (/** @type {Element} */ (list.parentElement));
    await TestUtils.waitForCondition(
      () =>
        selector.selectedPanelItem?.profile?.id === InternalTestingProfileMigrator.testProfile.id,
      "the wizard picked the first browser",
    );
    await waitForMode(browser, "normal");
    const hints = await startHints();
    const r = selector.getBoundingClientRect();
    const label = labelAt(hints, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
    Assert.ok(label, "the browser list's button has a label");
    Assert.strictEqual(list.open, false, "the list is closed before the label");
    // panel-list sends `shown` once its keys are listened for and its first entry has focus.
    const shown = BrowserTestUtils.waitForEvent(list, "shown");
    type(/** @type {string} */ (label));
    await shown;
    Assert.equal(panel.state, "open", "the label opened the list");
    // The label's mousedown has no input source, which panel-list counts as the keyboard's: the
    // first entry has focus, so Down moves to the second.
    Assert.equal(
      /** @type {MigrationWizardItem | null} */ (list.querySelector("panel-item:focus"))?.profile
        ?.id,
      InternalTestingProfileMigrator.testProfile.id,
      "the first entry has focus",
    );
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    await hidden;
    Assert.equal(selector.selectedPanelItem?.profile?.id, second.id, "Enter chose the second");
  } finally {
    if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
    if (tab) BrowserTestUtils.removeTab(tab);
    if (from) BrowserTestUtils.removeTab(from);
    await SpecialPowers.popPrefEnv();
    sandbox.restore();
    if (deviceName === null) Services.prefs.clearUserPref(DEVICE_PREF);
    else Services.prefs.setStringPref(DEVICE_PREF, deviceName);
  }
});

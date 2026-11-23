/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's second chapter, Moving in (docs/specs/setup-v2.md): the default browser and the
// import steps, against the shell service head_vimma_setup_chapters.js replaces.

"use strict";

/* global found, shell, configFile, press, step, openFlow -- from head_vimma_setup_chapters.js */
/* global closeFlow, atStep, current, notice -- from head_vimma_setup_chapters.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_setup_chapters.js",
  this,
);

/** @param {Partial<typeof shell>} state  for one task; the rest back to another default */
function shellAnswers(state = {}) {
  Object.assign(shell, { isDefault: false, setFails: false, flatpak: false, calls: [] }, state);
}

/** @param {Document} doc @returns {string[]} the labels of the open step's choices */
const choices = (doc) =>
  [...doc.querySelectorAll("#v2-choices li .name")].map((n) => n.textContent ?? "");
/** @param {Document} doc */
const statusLine = (doc) => found(doc.getElementById("v2-status"));
/** @param {Document} doc */
const keysText = (doc) => found(doc.getElementById("v2-keys")).textContent;

/** @param {Document} doc */
const footerText = (doc) =>
  `${found(doc.getElementById("v2-last")).textContent} | ${found(doc.getElementById("v2-saved")).textContent}`;

/** From the welcome screen straight to Moving in (behaviour 3). */
async function toDefaultBrowser(/** @type {Document} */ doc) {
  await press(doc, "2");
  await atStep(doc, "default_browser");
}

add_task(async function default_browser_step_calls_the_shell_service() {
  shellAnswers();
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  Assert.ok(found(doc.getElementById("v2-progress")).textContent.includes("Moving in"));
  Assert.ok(
    statusLine(doc).textContent.includes("not your default browser"),
    "says it is not, now",
  );
  Assert.deepEqual(choices(doc), ["Make Vimma the default browser", "Not now"]);
  Assert.equal(current(doc), "Make Vimma the default browser");
  Assert.ok(
    !found(doc.getElementById("v2-choices")).textContent.includes("in force"),
    "an action has no value in force",
  );
  Assert.ok(found(doc.getElementById("v2-writes-row")).hidden, "an action writes no line");
  Assert.ok(keysText(doc).includes("enter do it and go on"), keysText(doc));
  await press(doc, "j");
  Assert.ok(keysText(doc).includes("enter go on"), `not now does nothing: ${keysText(doc)}`);
  await press(doc, "k", "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.deepEqual(shell.calls, [[false]], "Make Default for this user, as Settings asks");
  const footer = footerText(doc);
  Assert.ok(footer.includes("Vimma is now the default browser"), footer);
  Assert.ok(footer.includes("made the default browser"), `saved this run: ${footer}`);
  Assert.ok(!footer.includes("nothing written"), footer);
  // Back, and on with "Go on": what Make Default did cannot be undone, so it stays listed.
  await press(doc, "h");
  await atStep(doc, "default_browser");
  Assert.deepEqual(choices(doc), ["Go on"], "Vimma is the default now");
  await press(doc, "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.ok(footerText(doc).includes("made the default browser"), footerText(doc));
  await press(doc, "s");
  await atStep(doc, "stop");
  const saved = found(doc.getElementById("v2-stop-saved")).textContent;
  Assert.ok(saved.includes("made the default browser"), saved);
  Assert.ok(!(await IOUtils.exists(configFile())), "config.toml is not written");
  await closeFlow(tab);
});

add_task(async function default_browser_step_says_when_vimma_already_is_the_default() {
  shellAnswers({ isDefault: true });
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  Assert.ok(statusLine(doc).textContent.includes("already your default browser"));
  Assert.deepEqual(choices(doc), ["Go on"], "nothing to ask");
  Assert.ok(keysText(doc).includes("enter go on"), keysText(doc));
  await press(doc, "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.deepEqual(shell.calls, [], "the shell service is not asked");
  Assert.ok(footerText(doc).includes("already the default browser"), footerText(doc));
  await closeFlow(tab);
});

add_task(async function default_browser_step_says_why_it_cannot_make_vimma_the_default() {
  shellAnswers({ flatpak: true });
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  Assert.ok(statusLine(doc).textContent.includes("Flatpak"), statusLine(doc).textContent);
  Assert.deepEqual(choices(doc), ["Go on"], "only moves on");
  await press(doc, "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.deepEqual(shell.calls, [], "Flatpak can neither set nor detect the default browser");
  await closeFlow(tab);
});

add_task(async function default_browser_step_says_when_a_locked_pref_hides_make_default() {
  shellAnswers();
  const pref = "pref.general.disable_button.default_browser";
  await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
  Services.prefs.lockPref(pref);
  try {
    const { tab, doc } = await openFlow();
    await toDefaultBrowser(doc);
    Assert.ok(
      statusLine(doc).textContent.includes("locked preference"),
      statusLine(doc).textContent,
    );
    Assert.deepEqual(choices(doc), ["Go on"], "only moves on");
    await press(doc, "KEY_Enter");
    await atStep(doc, "bring_your_data");
    Assert.deepEqual(shell.calls, [], "the shell service is not asked");
    Assert.ok(footerText(doc).includes("left as it is"), footerText(doc));
    await closeFlow(tab);
  } finally {
    Services.prefs.unlockPref(pref);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function a_failed_make_default_keeps_the_step_open() {
  shellAnswers({ setFails: true });
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => !notice(doc).hidden, "the step says so");
  Assert.ok(notice(doc).textContent.includes("did not make Vimma"), notice(doc).textContent);
  Assert.equal(step(doc), "default_browser", "the step stays open");
  Assert.equal(shell.calls.length, 1);
  await press(doc, "s");
  await atStep(doc, "bring_your_data");
  await closeFlow(tab);
});

add_task(async function import_step_names_sync_for_firefox() {
  shellAnswers();
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  await press(doc, "s");
  await atStep(doc, "bring_your_data");
  const text = found(doc.getElementById("v2-text")).textContent;
  Assert.ok(text.includes("A Firefox profile is not in it") && text.includes("Firefox Sync"));
  Assert.ok(
    [...doc.querySelectorAll("#v2-text code")].some((c) => c.textContent === ":settings sync"),
  );
  Assert.deepEqual(choices(doc), ["Open the import wizard", "Not now"]);
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok(footerText(doc).includes("not now"), footerText(doc));
  await closeFlow(tab);
});

add_task(
  async function import_step_opens_the_wizard_over_the_setup_tab_and_moves_on_when_it_closes() {
    shellAnswers();
    const { tab, doc } = await openFlow();
    const browser = tab.linkedBrowser;
    await toDefaultBrowser(doc);
    await press(doc, "s");
    await atStep(doc, "bring_your_data");
    // The wizard fills its list after it opens; closed before then, its actor writes to a dead
    // window (browser_vimma_setup_moving_in.js).
    const ready = BrowserTestUtils.waitForEvent(window, "MigrationWizard:Ready");
    await press(doc, "KEY_Enter");
    const dialogs = () => gBrowser.getTabDialogBox(browser).getContentDialogManager().dialogs;
    await TestUtils.waitForCondition(() => dialogs().length === 1, "the wizard opens");
    const dialog = dialogs()[0];
    await dialog._dialogReady;
    await ready;
    Assert.ok(gBrowser.selectedTab === tab, "over the setup tab");
    // Square corners and the theme's font, as Settings (firefox-pages.css).
    const wizardDoc = dialog._frame.contentDocument;
    const wizard = found(wizardDoc.querySelector("migration-wizard"));
    // A button of the page the wizard shows: the others are not rendered and have no style.
    const button = found(
      [...found(wizard.shadowRoot).querySelectorAll("button.cancel-close")].find((b) =>
        b.checkVisibility(),
      ),
    );
    const style = found(wizardDoc.defaultView).getComputedStyle(button);
    Assert.equal(style.borderTopLeftRadius, "0px", "a square button");
    const font = found(wizardDoc.defaultView)
      .getComputedStyle(wizardDoc.documentElement)
      .getPropertyValue("--vimma-font")
      .trim();
    Assert.ok(font, "the theme's font is set");
    Assert.equal(style.fontFamily, font, "the theme's font");
    Assert.equal(step(doc), "bring_your_data", "the step waits for the wizard");
    dialog._frame.contentWindow.close();
    await atStep(doc, "stop");
    Assert.equal(dialogs().length, 0);
    const saved = found(doc.getElementById("v2-stop-saved")).textContent;
    Assert.ok(saved.includes("import wizard closed"), saved);
    await TestUtils.waitForCondition(() => doc.hasFocus(), "the setup page has the focus back");
    Assert.ok(Services.focus.focusedWindow === doc.defaultView, "its own window");
    await closeFlow(tab);
  },
);

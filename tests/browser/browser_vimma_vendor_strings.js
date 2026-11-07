/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery step 5 (strings), decision 4.

"use strict";

/* global Localization -- a DOM global in chrome scope (dom/webidl/Localization.webidl) */

const ATTRIBUTION = "Built on Firefox by Mozilla";

/**
 * Messages where `-vendor-short-name` (Vimma) stood for Mozilla's own work: each is formatted
 * with Vimma's brand and must name neither Vimma nor Mozilla.
 *
 * @type {Array<[string, string, string | null, Record<string, string>]>} file, message id,
 *   attribute (null for the value), arguments
 */
const VENDOR_MESSAGES = [
  ["browser/originControls.ftl", "origin-controls-state-quarantined", null, {}],
  [
    "browser/originControls.ftl",
    "origin-controls-toolbar-button-quarantined",
    "tooltiptext",
    { extensionTitle: "Ext" },
  ],
  ["browser/addonNotifications.ftl", "addon-removal-abuse-report-checkbox", null, {}],
  [
    "browser/unifiedExtensions.ftl",
    "unified-extensions-mb-quarantined-domain-message-3",
    "message",
    {},
  ],
  ["browser/extensionsUI.ftl", "webext-quarantine-confirmation-line-2", null, {}],
  ["toolkit/about/aboutAddons.ftl", "addon-detail-quarantined-domains-help", null, {}],
  [
    "toolkit/about/aboutProcesses.ftl",
    "about-processes-privilegedmozilla-process",
    null,
    { pid: "1" },
  ],
];

/**
 * @param {string} file
 * @param {string} id
 * @param {string | null} attr
 * @param {Record<string, string>} args
 */
function format(file, id, attr, args) {
  const l10n = new Localization([file, "branding/brand.ftl"], true);
  const [msg] = l10n.formatMessagesSync([{ id, args }]);
  Assert.ok(msg, `${id} resolves`);
  const text = attr ? msg.attributes?.find((a) => a.name === attr)?.value : msg.value;
  Assert.ok(text, `${id}${attr ? `.${attr}` : ""} has text`);
  return text;
}

add_task(async function vendor_strings_name_neither_vimma_nor_mozilla() {
  for (const [file, id, attr, args] of VENDOR_MESSAGES) {
    const text = format(file, id, attr, args);
    Assert.ok(!/Vimma|Mozilla/.test(text), `${id} names neither Vimma nor Mozilla: "${text}"`);
  }
  Assert.equal(
    format("browser/originControls.ftl", "origin-controls-state-quarantined", null, {}),
    "Not allowed on this site",
    "the quarantined-domain state",
  );
  Assert.equal(
    format("browser/addonNotifications.ftl", "addon-removal-abuse-report-checkbox", null, {}),
    "Report this extension",
    "the removal dialog's report checkbox",
  );
  Assert.equal(
    format("toolkit/about/aboutProcesses.ftl", "about-processes-privilegedmozilla-process", null, {
      pid: "1",
    }),
    "Privileged sites (1)",
    "about:processes' privileged sites",
  );
});

add_task(async function the_ca_store_line_does_not_say_mozilla_backs_vimma() {
  const text = format("toolkit/neterror/certError.ftl", "cert-error-mitm-mozilla", null, {});
  Assert.ok(!/backed/.test(text), `no backing claim: "${text}"`);
  Assert.stringContains(text, "Mozilla", "the CA store stays Mozilla's (decision 11)");
});

// The docshell reads its error descriptions from global/appstrings.properties, which the browser's
// chrome.manifest overrides with browser/locales/en-US/chrome/overrides/appstrings.properties; an
// error page shows the string as its short description (aboutNetError.mjs, getDescription).
add_task(async function network_errors_name_vimma_not_firefox() {
  const bundle = Services.strings.createBundle("chrome://global/locale/appstrings.properties");
  let count = 0;
  for (const { key, value } of bundle.getSimpleEnumeration()) {
    count++;
    Assert.ok(!/Firefox/.test(value), `${key} does not say Firefox: "${value}"`);
  }
  Assert.greater(count, 40, "the bundle has the error strings");
  Assert.equal(
    bundle.GetStringFromName("connectionFailure"),
    "Vimma can’t establish a connection to the server at %S.",
    "connectionFailure names the browser that failed",
  );
});

add_task(async function about_dialog_shows_the_attribution_once() {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    undefined,
    (win) => win.document.documentURI == "chrome://browser/content/aboutDialog.xhtml",
  );
  openAboutDialog();
  const dialog = await opened;
  try {
    const doc = dialog.document;
    const desc = doc.getElementById("communityDesc");
    await doc.l10n.translateElements([desc]);
    Assert.equal(
      desc.textContent.trim(),
      ATTRIBUTION,
      "the community paragraph is the attribution",
    );
    Assert.equal(desc.querySelectorAll("[href]").length, 0, "with no links to mozilla.org");
    const exp = doc.getElementById("communityExperimentalDesc");
    await doc.l10n.translateElements([exp]);
    Assert.equal(exp.textContent.trim(), ATTRIBUTION, "so is the experimental builds' paragraph");
  } finally {
    await BrowserTestUtils.closeWindow(dialog);
  }
});

add_task(async function about_vimma_shows_the_attribution() {
  await BrowserTestUtils.withNewTab("about:vimma", async (browser) => {
    const line = browser.contentDocument.getElementById("attribution");
    Assert.ok(line, "about:vimma has an attribution line");
    Assert.equal(line?.textContent.trim(), ATTRIBUTION, "the attribution line");
  });
});

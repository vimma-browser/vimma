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

// Keys the override rewrites from "Firefox" to "Vimma" (appstrings-properties.patch). Upstream
// removes keys over time (Firefox 160 dropped the externalProtocol* ones), so the test names the
// rewritten keys instead of counting the whole bundle.
const VIMMA_NETWORK_ERRORS = [
  "fileNotFound",
  "unknownProtocolFound",
  "connectionFailure",
  "redirectLoop",
  "clientSocketMisconfiguration",
  "netOffline",
  "deniedPortAccess",
  "proxyResolveFailure",
  "proxyConnectFailure",
  "sslv3Used",
  "blockedByCORP",
  "networkProtocolError",
];

// The docshell reads its error descriptions from global/appstrings.properties, which the browser's
// chrome.manifest overrides with browser/locales/en-US/chrome/overrides/appstrings.properties; an
// error page shows the string as its short description (aboutNetError.mjs, getDescription).
add_task(async function network_errors_name_vimma_not_firefox() {
  const bundle = Services.strings.createBundle("chrome://global/locale/appstrings.properties");
  const values = new Map();
  for (const { key, value } of bundle.getSimpleEnumeration()) {
    values.set(key, value);
    Assert.ok(!/Firefox/.test(value), `${key} does not say Firefox: "${value}"`);
  }
  // A floor against an empty or wrong bundle passing the loop above vacuously.
  Assert.greater(values.size, 20, "the bundle has the error strings");
  for (const key of VIMMA_NETWORK_ERRORS) {
    Assert.ok(values.has(key), `the bundle has ${key}`);
    Assert.stringContains(values.get(key) ?? "", "Vimma", `${key} names Vimma`);
  }
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
    // The About dialog is localized (aboutDialog.xhtml links its .ftl files) and has both
    // paragraphs; translateElements throws for a missing one, as a read through it did before.
    const l10n = /** @type {DocumentL10n} */ (doc.l10n);
    const desc = /** @type {HTMLElement} */ (doc.getElementById("communityDesc"));
    await l10n.translateElements([desc]);
    Assert.equal(
      desc.textContent.trim(),
      ATTRIBUTION,
      "the community paragraph is the attribution",
    );
    Assert.equal(desc.querySelectorAll("[href]").length, 0, "with no links to mozilla.org");
    const exp = /** @type {HTMLElement} */ (doc.getElementById("communityExperimentalDesc"));
    await l10n.translateElements([exp]);
    Assert.equal(exp.textContent.trim(), ATTRIBUTION, "so is the experimental builds' paragraph");
  } finally {
    await BrowserTestUtils.closeWindow(dialog);
  }
});

add_task(async function about_vimma_shows_the_attribution() {
  await BrowserTestUtils.withNewTab("about:vimma", async (browser) => {
    // about:vimma loads in the parent process, so the browser has its document.
    const line = /** @type {Document} */ (browser.contentDocument).getElementById("attribution");
    Assert.ok(line, "about:vimma has an attribution line");
    Assert.equal(line?.textContent.trim(), ATTRIBUTION, "the attribution line");
  });
});

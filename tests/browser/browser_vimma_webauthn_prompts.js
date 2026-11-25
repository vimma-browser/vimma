/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/webauthn-prompts.md. Firefox's passkey and security key prompts answer `y`
// and `n` like the permission prompts, with `n` the button Esc runs (Cancel) and `y` the other
// one; the passkey list is reached with Tab and ↓; the PIN entry keeps its letters. The prompts
// come from Firefox's own authenticator code with a virtual authenticator, or with none at all
// for "touch your security key", so no hardware is needed.

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global focusContent -- from head.js */
/* global PopupNotifications -- browser window global (browser.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const DELAY = 300;
const PLAIN =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_plain.html";

const webauthn = Cc["@mozilla.org/webauthn/service;1"].getService(Ci.nsIWebAuthnService);

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const panel = () => /** @type {XULPopupElement} */ (PopupNotifications.panel);
/** The prompt the notification panel shows; a read through a missing one throws. */
const promptEl = () => /** @type {MozPopupNotification} */ (panel().firstElementChild);
/** @param {Element} n */
const hintText = (n) => {
  const hint = n.querySelector(".vimma-prompt-keys");
  return hint?.hasAttribute("armed") ? (hint.textContent ?? "") : "";
};

/**
 * Waits for the prompt with `popupid` and for its keys line to arm; resolves with the prompt.
 * @param {string} popupid
 */
async function armed(popupid) {
  await until(
    () => panel().state === "open" && promptEl().getAttribute("popupid") === popupid,
    `${popupid} shows`,
  );
  const n = promptEl();
  await until(() => hintText(n) !== "", `${popupid}: its keys line arms`);
  return n;
}

/** An example.com page, selected, focused, in normal mode. */
async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

/**
 * The page asks for a new credential; resolves with "ok" or the error's name.
 * @param {XULBrowserElement} browser
 * @param {{ attestation?: AttestationConveyancePreference, exclude?: string }} [opts]  `exclude`: a credential id
 *   (base64url) the authenticator must not hold already
 */
function create(browser, opts = {}) {
  return SpecialPowers.spawn(browser, [opts], async ({ attestation, exclude }) => {
    const decode = (/** @type {string} */ s) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    /** @type {PublicKeyCredentialCreationOptions} */
    const publicKey = {
      rp: { id: content.document.domain, name: "none" },
      user: { id: new Uint8Array(16), name: "none", displayName: "none" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "cross-platform" },
      excludeCredentials: exclude ? [{ type: "public-key", id: decode(exclude) }] : [],
      attestation: attestation ?? "none",
      challenge: content.crypto.getRandomValues(new Uint8Array(16)),
    };
    try {
      await content.navigator.credentials.create({ publicKey });
      return "ok";
    } catch (e) {
      return /** @type {Error} */ (e).name;
    }
  });
}

/**
 * The page asks for a passkey with no allow list, so every passkey for the site is offered;
 * resolves with the chosen passkey's user handle, as text, or the error's name.
 * @param {XULBrowserElement} browser
 */
function signIn(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const publicKey = {
      challenge: content.crypto.getRandomValues(new Uint8Array(16)),
      rpId: content.document.domain,
      allowCredentials: [],
    };
    try {
      const cred = /** @type {PublicKeyCredential} */ (
        await content.navigator.credentials.get({ publicKey })
      );
      const response = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
      return new TextDecoder().decode(response.userHandle ?? undefined);
    } catch (e) {
      return /** @type {Error} */ (e).name;
    }
  });
}

/**
 * A discoverable passkey for example.com on `authenticator`, for the user `name` (also its user
 * handle); resolves with its id (base64url).
 * @param {string} authenticator
 * @param {string} name
 */
async function addPasskey(authenticator, name) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const b64url = (/** @type {Uint8Array} */ bytes) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const id = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const key = b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  webauthn.addCredential(
    authenticator,
    id,
    true,
    "example.com",
    key,
    b64url(new TextEncoder().encode(name)),
    0,
  );
  return id;
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.notification_enable_delay", DELAY],
      ["security.webauth.webauthn", true],
      ["security.webauthn.ctap2", true],
      // Firefox's own prompts come from its authenticator-rs code; macOS's platform API shows its
      // own windows instead (it needs an entitlement Vimma does not have, issue #544).
      ["security.webauthn.enable_macos_passkeys", false],
    ],
  });
});

// "Touch your security key": Cancel alone, run by Esc. `n` cancels; `y` has no button.
add_task(async function touch_your_key_answers_n_and_not_y() {
  // With USB tokens on and no key plugged in, Firefox waits for a touch.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.webauth.webauthn_enable_softtoken", false],
      ["security.webauth.webauthn_enable_usbtoken", true],
    ],
  });
  const tab = await openPage();
  const result = create(tab.linkedBrowser);
  const n = await armed("webauthn-prompt-presence");
  Assert.equal(hintText(n), "n cancel · Tab buttons", "the line names only n");
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 2);
  Assert.equal(panel().state, "open", "y does not cancel");
  await until(() => hintText(n) !== "", "armed again");
  EventUtils.synthesizeKey("n");
  Assert.equal(await result, "NotAllowedError", "n cancels the request");
  await until(() => panel().state === "closed", "the prompt goes");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

/** Firefox's virtual authenticator, for the tasks below; removed after each. */
async function withAuthenticator(/** @type {(id: string) => Promise<void>} */ body) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.webauth.webauthn_enable_softtoken", true],
      ["security.webauth.webauthn_enable_usbtoken", false],
    ],
  });
  const id = webauthn.addVirtualAuthenticator("ctap2_1", "internal", true, true, true, true);
  try {
    await body(id);
  } finally {
    webauthn.removeVirtualAuthenticator(id);
    await SpecialPowers.popPrefEnv();
  }
}

// Choosing a passkey: Cancel is the main button, the first passkey the secondary one and the
// others in its list. `y` takes the first passkey, `n` cancels, Tab and ↓ reach the others.
add_task(async function choosing_a_passkey_from_the_keyboard() {
  await withAuthenticator(async (auth) => {
    await addPasskey(auth, "alice");
    await addPasskey(auth, "bob");
    await addPasskey(auth, "carol");
    const tab = await openPage();
    const browser = tab.linkedBrowser;

    let result = signIn(browser);
    let n = await armed("webauthn-prompt-select-sign-result");
    const first = n.getAttribute("secondarybuttonlabel") ?? "";
    Assert.equal(
      hintText(n),
      `y ${first.toLowerCase()} · n cancel · Tab, ↓ more`,
      "the line names the first passkey, cancel and the list",
    );
    EventUtils.synthesizeKey("y");
    Assert.equal(await result, first, "y signs in with the first passkey");
    await until(() => panel().state === "closed", "the prompt goes");

    result = signIn(browser);
    n = await armed("webauthn-prompt-select-sign-result");
    EventUtils.synthesizeKey("n");
    Assert.equal(await result, "NotAllowedError", "n cancels");
    await until(() => panel().state === "closed", "the prompt goes");

    // The list: Tab onto the first passkey's button, ↓ opens the others, ↓ and Enter choose.
    result = signIn(browser);
    n = await armed("webauthn-prompt-select-sign-result");
    const menu = /** @type {XULPopupElement} */ (
      n.querySelector(".popup-notification-more-actions-popup")
    );
    EventUtils.synthesizeKey("KEY_Tab");
    await until(
      () => n.secondaryButton.matches(":focus-within"),
      "Tab moves focus onto the first passkey",
    );
    const opened = BrowserTestUtils.waitForEvent(menu, "popupshown");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    await opened;
    const items = [...menu.querySelectorAll("menuitem")].map((m) => m.getAttribute("label") ?? "");
    Assert.equal(items.length, 2, "the list holds the other two passkeys");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    Assert.equal(await result, items[0], "↓ and Enter choose a passkey from the list");
    await until(() => panel().state === "closed", "the prompt goes");
    BrowserTestUtils.removeTab(tab);
  });
});

// A notice with Cancel alone (the authenticator already holds a passkey for the account): `n`
// cancels, though Esc would only hide it.
add_task(async function a_passkey_notice_cancels_with_n() {
  await withAuthenticator(async (auth) => {
    const id = await addPasskey(auth, "alice");
    const tab = await openPage();
    const result = create(tab.linkedBrowser, { exclude: id });
    const n = await armed("webauthn-prompt-alreadyRegistered");
    Assert.equal(hintText(n), "n cancel · Tab buttons", "the line names only n");
    EventUtils.synthesizeKey("n");
    Assert.notEqual(await result, "ok", "n cancels the request");
    await until(() => panel().state === "closed", "the prompt goes");
    BrowserTestUtils.removeTab(tab);
  });
});

// Asking to see the key's make and model: Allow and Block, as a permission prompt.
add_task(async function the_attestation_question_answers_y_and_n() {
  await withAuthenticator(async () => {
    const tab = await openPage();
    for (const key of ["y", "n"]) {
      const result = create(tab.linkedBrowser, { attestation: "direct" });
      const n = await armed("webauthn-prompt-register-direct");
      Assert.ok(hintText(n).startsWith("y allow · n block"), hintText(n));
      EventUtils.synthesizeKey(key);
      Assert.equal(await result, "ok", `${key} answers and the passkey is made`);
      await until(() => panel().state === "closed", "the prompt goes");
    }
    BrowserTestUtils.removeTab(tab);
  });
});

// The PIN entry is a tab dialog with a password field (WebAuthnPromptHelper.prompt_for_password):
// what is typed there is the PIN, y and n included; the line names Enter and Esc
// (docs/specs/firefox-dialogs.md).
add_task(async function the_pin_entry_keeps_its_letters() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  // The request as Firefox's authenticator code sends it when a key asks for its PIN. The
  // transaction id is not a live one, so the answer reaches no authenticator.
  const data = JSON.stringify({
    prompt: { type: "pin-required" },
    origin: "https://example.com",
    browsingContextId: browser.browsingContext?.id,
    tid: 0x7fff0001,
  });
  const shown = TestUtils.topicObserved("common-dialog-loaded").then(([w]) => w);
  // prompt_for_password waits in a nested event loop until the dialog is answered.
  setTimeout(() => Services.obs.notifyObservers(null, "webauthn-prompt", data), 0);
  const w = /** @type {Window} */ (await shown);
  const field = /** @type {HTMLInputElement} */ (w.document.getElementById("password1Textbox"));
  await until(() => {
    const line = w.document.querySelector(".vimma-prompt-keys");
    return line?.hasAttribute("armed") && line.textContent === "Enter ok · Esc cancel";
  }, "the PIN entry names Enter and Esc");
  for (const key of ["1", "y", "2", "n"]) EventUtils.synthesizeKey(key, {}, w);
  await until(() => field.value === "1y2n", "y and n type into the PIN");
  EventUtils.synthesizeKey("KEY_Escape", {}, w);
  await until(() => w.closed || !w.document?.documentElement, "Esc cancels the entry");
  BrowserTestUtils.removeTab(tab);
});

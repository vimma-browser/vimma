/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m6a-updater.md §4 and decision 1 (sub-PR 3). Firefox's own update checker,
// as a tarball with the updater uses it, goes through Vimma's hook
// (UpdateService-sys-mjs.patch): a manifest that fails Vimma's rules never reaches Firefox's
// parser, the request carries no cookie, and the MAR's download goes without cookies too. The
// manifest comes from a local host (file_vimma_update_manifest.sjs), reached by swapping
// Services.appinfo.updateURL as Mozilla's own update tests do (setUpdateURL), and is signed
// with a key generated here, honoured only in automation (vimma.update.testKeys). Artifact
// builds run Mozilla's libxul, which has the update service, so this runs there too.

"use strict";

/* global NetUtil -- the browser-chrome harness (browser-test.js) */

const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { UpdateUi } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/update-ui.mjs",
);
const { base64Encode, signatureComment, signedBytes, spkiKeyId } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/updates.mjs",
);
const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const HOST = `${ROOT}file_vimma_update_manifest.sjs`;
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
const TARGET = `${Services.appinfo.OS}_${UpdateUtils.ABI}`;
const CHANNEL = UpdateUtils.UpdateChannel;

/** @typedef {{ pair: CryptoKeyPair, spki: string, id: string }} TestKey A signing key. */
/** @type {TestKey} */
let key;
/** @type {TestKey} */
let stranger;
/** Serials are UTC times, at most a day ahead (decision 33) and above this build's ID. */
let serial = Number(
  new Date(Date.now() + 6 * 3600 * 1000).toISOString().replace(/\D/g, "").slice(0, 14),
);

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: base64Encode(der), id: await spkiKeyId(crypto.subtle, der) };
}

/**
 * A manifest as the release pipeline writes it, with a complete MAR.
 * @param {{ update?: Record<string, string>, patch?: string, size?: number, hash?: string,
 *   channel?: string, signer?: TestKey, sign?: boolean, at?: string }} [o]
 */
async function manifest({
  update = {},
  patch = `${HOST}?redirect=host`,
  size = 4,
  hash = "0".repeat(128),
  channel = CHANNEL,
  signer = key,
  sign = true,
  at = String(++serial),
} = {}) {
  const attrs = {
    type: "minor",
    appVersion: "999.0",
    buildID: "20991231000000",
    displayVersion: "9.9.9",
    detailsURL: "https://github.com/vimma-browser/vimma/releases/tag/v9.9.9",
    vimmaUrgency: "normal",
    ...update,
  };
  const body =
    '<?xml version="1.0"?>\n' +
    `<updates vimmaChannel="${channel}" vimmaTarget="${TARGET}" vimmaSerial="${at}">\n` +
    `  <update ${Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ")}>\n` +
    `    <patch type="complete" size="${size}" hashFunction="sha512" hashValue="${hash}"` +
    ` URL="${patch}"/>\n` +
    "  </update>\n</updates>\n";
  if (!sign) return body;
  const sig = new Uint8Array(
    await crypto.subtle.sign(ALG, signer.pair.privateKey, signedBytes(body)),
  );
  return body + signatureComment([{ key: signer.id, sig: base64Encode(sig) }]);
}

/** @param {string} text */
async function serve(text) {
  const r = await fetch(`${HOST}?set`, { method: "POST", body: text });
  Assert.equal(r.status, 200, "the test host took the manifest");
}

async function requests() {
  return (await fetch(`${HOST}?log`)).json();
}

/** Firefox's own checker, as the About dialog and `:update` on a tarball run it. */
async function firefoxCheck() {
  const checker = Cc["@mozilla.org/updates/update-checker;1"].getService(Ci.nsIUpdateChecker);
  return checker.checkForUpdates(Ci.nsIUpdateChecker.FOREGROUND_CHECK).result;
}

// The real appinfo, taken once: each setUpdateURL wraps it afresh. Saving the current value per
// call and restoring it in a cleanup function left a wrapper behind, because the harness runs
// cleanup functions first registered, first run (browser-test.js), so the last restore put back
// the URL of the call before it, and later tests (browser_vimma_updater.js) saw that URL.
const originalAppinfo = Services.appinfo;
let restoresAppinfo = false;

/**
 * The update URL Firefox's checker asks, for this process (Mozilla's setUpdateURL).
 * @param {string} url
 */
function setUpdateURL(url) {
  Services.appinfo = Object.create(originalAppinfo, {
    updateURL: { configurable: true, enumerable: true, writable: false, value: url },
  });
  if (!restoresAppinfo) {
    restoresAppinfo = true;
    registerCleanupFunction(() => {
      Services.appinfo = originalAppinfo;
    });
  }
}

/** @param {string} host */
function addCookie(host) {
  Services.cookies.add(
    host,
    "/",
    "vimma-update-test",
    "1",
    false,
    false,
    true,
    Date.now() + 3600000,
    {},
    Ci.nsICookie.SAMESITE_UNSET,
    Ci.nsICookie.SCHEME_HTTPS,
  );
}

add_task(async function setup() {
  key = await makeKey();
  stranger = await makeKey();
  await fetch(`${HOST}?reset`);
  await SpecialPowers.pushPrefEnv({
    set: [
      // The harness turns Firefox's updater off; the checker is what is tested here.
      ["app.update.disabledForTesting", false],
      ["app.update.checkOnlyInstance.enabled", false],
      ["vimma.update.testKeys", JSON.stringify([{ id: key.id, slot: "primary", spki: key.spki }])],
      ["vimma.update.installType", "tarball"],
      ["vimma.update.enabled", true],
    ],
  });
  setUpdateURL(`${HOST}?firefox=%CHANNEL%`);
  // Cookies the hosts would see on any request that is not anonymous.
  addCookie("example.com");
  addCookie("example.org");
  VimmaUpdates._reset();
  // Firefox's check waits until Vimma knows how it was installed (allowCheck).
  await VimmaUpdates.describe();
  registerCleanupFunction(() => {
    Services.cookies.removeAll();
    VimmaUpdates._reset();
    Services.prefs.clearUserPref("vimma.update.serial");
    Services.prefs.clearUserPref("vimma.update.last");
    Services.prefs.clearUserPref("vimma.update.announced");
  });
});

add_task(async function a_signed_newer_build_is_offered_and_the_request_is_anonymous() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  const result = await firefoxCheck();
  Assert.ok(result.succeeded, "the check succeeded");
  Assert.equal(result.updates.length, 1, "Firefox offers the update");
  Assert.equal(result.updates[0].displayVersion, "9.9.9");
  const status = VimmaUpdates.status();
  Assert.equal(status.outcome, "offer", status.reason ?? "");
  Assert.equal(status.key.id, key.id, "Vimma verified it with the pinned key");
  const log = await requests();
  Assert.equal(log.length, 1, "one request");
  Assert.ok(log[0].query.startsWith(`firefox=${CHANNEL}`), log[0].query);
  Assert.equal(log[0].cookie, false, "no cookie, although the host has one");
  Assert.equal(log[0].headers["accept-language"], "", "no languages (decision 30)");
  Assert.equal(log[0].headers["accept-encoding"], "identity", "asks for the file uncompressed");
});

add_task(async function a_manifest_failing_the_rules_never_reaches_firefox() {
  /** @type {[string, string, RegExp][]} */
  const cases = [
    ["unsigned", await manifest({ sign: false }), /^unsigned/],
    ["signed by another key", await manifest({ signer: stranger }), /^signature: /],
    ["for the nightly channel", await manifest({ channel: `${CHANNEL}-nightly` }), /^channel: /],
    ["a bad signature", (await manifest()).replace("9.9.9", "9.9.8"), /^signature: /],
  ];
  for (const [name, text, reason] of cases) {
    await serve(text);
    const result = await firefoxCheck();
    Assert.ok(!result.succeeded, `${name}: the check fails`);
    Assert.equal(result.updates.length, 1, `${name}: only Firefox's error entry`);
    Assert.ok(!result.updates[0].displayVersion, `${name}: no update offered`);
    const status = VimmaUpdates.status();
    Assert.equal(status.outcome, "refused", name);
    Assert.ok(reason.test(status.reason), `${name}: ${status.reason}`);
  }
});

add_task(async function a_replay_is_refused_and_a_downgrade_offers_nothing() {
  await serve(await manifest());
  Assert.ok((await firefoxCheck()).succeeded, "a fresh manifest");
  await serve(await manifest({ at: String(serial - 5) }));
  const replay = await firefoxCheck();
  Assert.ok(!replay.succeeded, "an older serial fails the check");
  Assert.ok(VimmaUpdates.status().reason.startsWith("replay: "), VimmaUpdates.status().reason);

  // Firefox alone would offer the same Firefox version with an older build ID.
  const older = {
    appVersion: Services.appinfo.version,
    buildID: String(Number(Services.appinfo.appBuildID) - 1),
  };
  await serve(await manifest({ update: older }));
  const result = await firefoxCheck();
  Assert.ok(result.succeeded, "a signed manifest with nothing newer is no error");
  Assert.equal(result.updates.length, 0, "nothing is offered");
  Assert.equal(VimmaUpdates.status().outcome, "current");
});

add_task(async function checks_off_send_no_request() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.enabled", false]] });
  const result = await firefoxCheck();
  await SpecialPowers.popPrefEnv();
  Assert.ok(!result.checksAllowed, "the check ends as not allowed");
  Assert.equal(VimmaUpdates.status().outcome, "off");
  Assert.deepEqual(await requests(), [], "no request at all");
});

// Until Vimma knows the install type (an objdir build never checks), Firefox's check waits.
add_task(async function no_check_before_the_install_type_is_known() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  VimmaUpdates._reset();
  const result = await firefoxCheck();
  Assert.ok(!result.checksAllowed, "not allowed yet");
  Assert.deepEqual(await requests(), [], "no request");
  await VimmaUpdates.describe();
  Assert.ok((await firefoxCheck()).succeeded, "allowed once the install type is known");
});

add_task(async function a_host_that_does_not_answer_is_not_a_refusal() {
  await serve("");
  const before = VimmaUpdates.status().refusals;
  const result = await firefoxCheck();
  Assert.ok(!result.succeeded, "the check fails");
  const status = VimmaUpdates.status();
  Assert.equal(status.outcome, "unreachable", "a 404 is no answer (decision 27)");
  Assert.equal(status.refusals, before, "and counts toward no refusal");
});

// Decision 32: a body over 256 KiB, with or without its length, and a compressed bomb are
// refused before the parent process holds them.
add_task(async function an_oversized_or_compressed_body_is_refused() {
  for (const [name, url] of [
    ["a 1 MiB body with its length", `${HOST}?big`],
    ["4 MiB with no length", `${HOST}?bigstream`],
    ["a gzip bomb", `${ROOT}file_vimma_update_bomb.gz`],
  ]) {
    setUpdateURL(url);
    const result = await firefoxCheck();
    Assert.ok(!result.succeeded, `${name}: the check fails`);
    const status = VimmaUpdates.status();
    Assert.equal(status.outcome, "refused", `${name}: ${status.reason}`);
  }
  setUpdateURL(`${HOST}?firefox=%CHANNEL%`);
});

/** Reads a system-principal request to `uri` to its end. @param {string} uri */
function load(uri) {
  return new Promise((resolve) => {
    NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true }).asyncOpen({
      onStartRequest() {},
      /** @param {unknown} _r @param {unknown} stream @param {unknown} _o @param {number} count */
      onDataAvailable(_r, stream, _o, count) {
        NetUtil.readInputStream(stream, count);
      },
      onStopRequest: resolve,
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
    });
  });
}

/**
 * Each request's query and whether it went anonymous (LOAD_ANONYMOUS: no cookie is read or
 * stored), as the request goes out, after Vimma's observer had its turn.
 */
function watchRequests() {
  /** @type {[string, boolean][]} */
  const seen = [];
  const observe = (/** @type {nsISupports} */ subject) => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (!channel.URI.spec.includes("file_vimma_update_manifest.sjs")) return;
    const query = channel.URI.query;
    if (query === "log" || query === "reset" || query === "set") return;
    seen.push([query, !!(channel.loadFlags & Ci.nsIRequest.LOAD_ANONYMOUS)]);
  };
  Services.obs.addObserver(observe, "http-on-modify-request");
  return { seen, stop: () => Services.obs.removeObserver(observe, "http-on-modify-request") };
}

// Decision 1: the MAR's download (nsIncrementalDownload, a system-principal channel with no
// browsing context) goes without cookies: its first request, the redirect, and the requests to
// the redirect's target that the next pieces of a download make. Nothing else is touched.
add_task(async function the_mar_download_goes_without_cookies() {
  await serve(await manifest());
  Assert.ok((await firefoxCheck()).succeeded, "an offer with a MAR");
  Assert.deepEqual(VimmaUpdates._marUrls(), [`${HOST}?redirect=host`], "the offered MAR");
  const file = await IOUtils.createUniqueFile(PathUtils.tempDir, "vimma-mar-test");
  registerCleanupFunction(() => IOUtils.remove(file));
  const download = Cc["@mozilla.org/network/incremental-download;1"].createInstance(
    Ci.nsIIncrementalDownload,
  );
  const target = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  target.initWithPath(file);
  download.init(Services.io.newURI(`${HOST}?redirect=host`), target, -1, 0, "");
  const watch = watchRequests();
  try {
    await new Promise((resolve) => {
      download.start(
        {
          onStartRequest() {},
          onStopRequest: resolve,
          QueryInterface: ChromeUtils.generateQI(["nsIRequestObserver"]),
        },
        null,
      );
    });
    const landed = `${HOST.replace("example.com", "example.org")}?landed`;
    Assert.ok(VimmaUpdates._marUrls().includes(landed), "the redirect's target is learnt");
    // The next piece of a download asks the redirect's target directly.
    await load(landed);
    // Another request from chrome, and the same MAR from a page, keep their cookies.
    await load(`${HOST}?other`);
    await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
      await SpecialPowers.spawn(browser, [`${HOST}?redirect=host`], async (url) => {
        await content.fetch(url, { redirect: "manual" }).catch(() => {});
      });
    });
  } finally {
    watch.stop();
  }
  Assert.deepEqual(
    watch.seen,
    [
      ["redirect=host", true],
      ["landed", true],
      ["landed", true],
      ["other", false],
      ["redirect=host", false],
    ],
    "only the offered MAR's download goes without cookies",
  );
});

// A tarball that Firefox's updater updates (spec §3, §5). Firefox's download and staging are
// faked (they would write into this build's own update directory); its check is the real one,
// through the hook. `stage` is what Firefox's updater did with the offered build.
const fake = {
  usable: true,
  canApply: true,
  busy: false,
  staged: "none",
  stage() {
    return this.staged;
  },
  check: firefoxCheck,
};

/** The status bar's update segment, or null when it shows none. */
function segment() {
  return /** @type {HTMLElement | null} */ (
    document.querySelector('#vimma-statusbar [data-segment="update"]')
  );
}

/** A tarball with Firefox's updater, no result from an earlier task, nothing asked yet. */
async function freshTarball() {
  await fetch(`${HOST}?reset`);
  Object.assign(fake, { usable: true, canApply: true, busy: false, staged: "none" });
  VimmaUpdates._reset();
  VimmaUpdates._setFirefox(fake);
  Services.prefs.clearUserPref("vimma.update.announced");
  UpdateUi._reset();
  registerCleanupFunction(() => VimmaUpdates._setFirefox(null));
}

/** Firefox's updater finished a download or staged it, and says so. @param {string} stage */
function stageAs(stage) {
  fake.staged = stage;
  Services.obs.notifyObservers(null, stage === "staged" ? "update-staged" : "update-downloading");
}

add_task(async function update_checks_a_tarball_through_firefoxs_updater() {
  await freshTarball();
  await serve(await manifest());
  const r = await VimmaUpdates.check({ asked: true });
  Assert.equal(r.outcome, "offer", r.reason ?? "");
  const log = await requests();
  Assert.equal(log.length, 1, "one request");
  Assert.ok(log[0].query.startsWith(`firefox=${CHANNEL}`), `Firefox's check: ${log[0].query}`);

  // Firefox's own timer checks it: Vimma's startup check sends nothing of its own.
  await fetch(`${HOST}?reset`);
  await VimmaUpdates._startupCheck();
  Assert.deepEqual(await requests(), [], "no request from Vimma's own check");

  // While a download is under way or an update is in place, Firefox checks no further.
  fake.busy = true;
  const busy = await VimmaUpdates.check({ asked: true });
  Assert.equal(busy.outcome, "offer", "the offer stays");
  Assert.deepEqual(await requests(), [], "and no check is made");
});

add_task(async function a_staged_update_shows_on_restart() {
  await freshTarball();
  await serve(await manifest());
  await VimmaUpdates.check();
  stageAs("pending");
  await until(() => segment()?.textContent === "⇡ 9.9.9 available", "downloading");
  stageAs("staged");
  await until(() => segment()?.textContent === "⇡ 9.9.9 on restart", "staged: on restart");
  Assert.equal(/** @type {HTMLElement} */ (segment()).style.color, "var(--vimma-fg-dim)");
  const info = await VimmaUpdates.describe();
  Assert.deepEqual(info.firefox, { stage: "staged", canApply: true });
  Assert.equal(
    info.offer.steps.text,
    "Vimma 9.9.9 is downloaded and applies at the next start: restart Vimma (:restart) to use it.",
  );
  Assert.deepEqual(info.offer.steps.commands, [], "nothing to run");
  await BrowserTestUtils.withNewTab("about:vimma#updates", async (browser) => {
    await until(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "rendered",
    );
    Assert.equal(
      /** @type {Element} */ (
        /** @type {Document} */ (browser.contentDocument).getElementById("update-firefox")
      ).textContent,
      "downloaded: applies at the next start",
    );
  });
  Assert.ok(!UpdateUi.isOpen(window), "an ordinary update asks nothing");
});

add_task(async function a_staged_security_update_asks_to_restart() {
  await freshTarball();
  await serve(await manifest({ update: { vimmaUrgency: "security" } }));
  /** The update question, or null while there is none. */
  const line = () =>
    /** @type {HTMLElement | null} */ (document.getElementById("vimma-update-prompt"));
  const lineShown = () => !!line() && !(/** @type {HTMLElement} */ (line()).hidden);
  const lineText = () => line()?.querySelector(".vimma-agent-prompt-text")?.textContent ?? "";
  const armed = () => !!line()?.querySelector(".vimma-agent-prompt-hint:not([hidden])");
  try {
    await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
      browser.focus();
      await VimmaUpdates.check();
      stageAs("staged");
      await until(
        () => segment()?.textContent === "⇡ 9.9.9 security: :restart",
        "a staged security update in the error colour, naming :restart",
      );
      Assert.equal(/** @type {HTMLElement} */ (segment()).style.color, "var(--vimma-text-error)");
      UpdateUi._sync();
      await until(lineShown, "the restart question shows once no key came for a moment");
      Assert.equal(
        lineText(),
        "Security update 9.9.9 is ready. Restart now? Tabs come back. (y/N)",
      );
      await until(armed, "armed after the delay");
      EventUtils.synthesizeKey("n");
      await until(() => !lineShown(), "n closes it");
    });
  } finally {
    UpdateUi._reset();
  }
});

// Behaviour 2: Firefox's updater cannot apply where Vimma cannot write; its owner updates it.
add_task(async function a_tarball_vimma_cannot_write_gets_its_owners_steps() {
  await freshTarball();
  fake.canApply = false;
  await serve(await manifest());
  await VimmaUpdates.check();
  await until(() => segment()?.textContent === "⇡ 9.9.9 available", "offered");
  const info = await VimmaUpdates.describe();
  Assert.ok(info.offer.steps.text.startsWith("Vimma cannot write "), info.offer.steps.text);
  Assert.equal(info.firefox.canApply, false);
});

// The real path, nothing faked: `:update` runs Firefox's check through the hook, Firefox
// downloads the offered file (any bytes with the signed hash; staging is off, so no updater
// runs), its update becomes pending, and the status bar says to restart. Everything Firefox wrote
// for it is removed afterwards.
add_task(async function a_real_download_is_shown_on_restart() {
  await freshTarball();
  VimmaUpdates._setFirefox(null);
  const mar = `${ROOT}file_vimma_update.mar`;
  const bytes = new Uint8Array(await (await fetch(mar)).arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await SpecialPowers.pushPrefEnv({ set: [["app.update.staging.enabled", false]] });
  const aus = Cc["@mozilla.org/updates/update-service;1"].getService(
    Ci.nsIApplicationUpdateService,
  );
  const um = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
  const watch = (/** @type {nsISupports} */ subject) => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (channel.URI.spec === mar) {
      anonymous.push(!!(channel.loadFlags & Ci.nsIRequest.LOAD_ANONYMOUS));
    }
  };
  /** @type {boolean[]} */
  const anonymous = [];
  Services.obs.addObserver(watch, "http-on-modify-request");
  try {
    await serve(
      await manifest({
        patch: mar,
        size: bytes.length,
        hash,
        update: { vimmaUrgency: "security" },
      }),
    );
    const r = await VimmaUpdates.check({ asked: true });
    Assert.equal(r.outcome, "offer", r.reason ?? "");
    await until(() => VimmaUpdates.status().stage === "staged", "Firefox's update is pending");
    Assert.equal(aus.currentState, Ci.nsIApplicationUpdateService.STATE_PENDING);
    Assert.equal((await um.getReadyUpdate())?.buildID, "20991231000000", "the verified build");
    await until(
      () => segment()?.textContent === "⇡ 9.9.9 security: :restart",
      "the status bar says to restart",
    );
    Assert.ok(anonymous.length >= 1, "Firefox downloaded the offered file");
    Assert.ok(anonymous.every(Boolean), "every request of the download went without cookies");
  } finally {
    Services.obs.removeObserver(watch, "http-on-modify-request");
    await aus.stopDownload();

    await um.cleanupActiveUpdates();
    UpdateUi._reset();
    await SpecialPowers.popPrefEnv();
  }
});

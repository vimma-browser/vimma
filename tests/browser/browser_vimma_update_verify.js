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

const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { base64Encode, signatureComment, signedBytes, spkiKeyId } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/updates.mjs",
);
const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");
const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const HOST = `${ROOT}file_vimma_update_manifest.sjs`;
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
const TARGET = `${Services.appinfo.OS}_${UpdateUtils.ABI}`;
const CHANNEL = UpdateUtils.UpdateChannel;

let key;
let stranger;
/** Serials are UTC times, at most a day ahead (decision 33) and above this build's ID. */
let serial = Number(
  new Date(Date.now() + 6 * 3600 * 1000).toISOString().replace(/\D/g, "").slice(0, 14),
);

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: base64Encode(der), id: await spkiKeyId(crypto.subtle, der) };
}

/** A manifest as the release pipeline writes it, with a complete MAR. @param {object} [o] */
async function manifest({
  update = {},
  patch = `${HOST}?redirect=host`,
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
    `    <patch type="complete" size="4" hashFunction="sha512" hashValue="${"0".repeat(128)}"` +
    ` URL="${patch}"/>\n` +
    "  </update>\n</updates>\n";
  if (!sign) return body;
  const sig = new Uint8Array(
    await crypto.subtle.sign(ALG, signer.pair.privateKey, signedBytes(body)),
  );
  return body + signatureComment([{ key: signer.id, sig: base64Encode(sig) }]);
}

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

/** The update URL Firefox's checker asks, for this process (Mozilla's setUpdateURL). */
function setUpdateURL(url) {
  const original = Services.appinfo;
  Services.appinfo = Object.create(original, {
    updateURL: { configurable: true, enumerable: true, writable: false, value: url },
  });
  registerCleanupFunction(() => {
    Services.appinfo = original;
  });
}

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

// Decision 1: the MAR's download (nsIncrementalDownload, a system-principal channel with no
// browsing context) sends no cookie, on the first request, its redirect, and the requests to
// the redirect's target that the next pieces of a download make.
add_task(async function the_mar_download_goes_without_cookies() {
  await serve(await manifest());
  Assert.ok((await firefoxCheck()).succeeded, "an offer with a MAR");
  await fetch(`${HOST}?reset`);
  const file = await IOUtils.createUniqueFile(PathUtils.tempDir, "vimma-mar-test");
  registerCleanupFunction(() => IOUtils.remove(file));
  const download = Cc["@mozilla.org/network/incremental-download;1"].createInstance(
    Ci.nsIIncrementalDownload,
  );
  const target = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  target.initWithPath(file);
  download.init(Services.io.newURI(`${HOST}?redirect=host`), target, -1, 0);
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
  await new Promise((resolve) => {
    NetUtil.newChannel({ uri: landed, loadUsingSystemPrincipal: true }).asyncOpen({
      onStartRequest() {},
      onDataAvailable(_r, stream, _o, count) {
        NetUtil.readInputStream(stream, count);
      },
      onStopRequest: resolve,
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
    });
  });
  const log = await requests();
  Assert.deepEqual(
    log.map((r) => [r.query, r.cookie]),
    [
      ["redirect=host", false],
      ["landed", false],
      ["landed", false],
    ],
    "no request of the download carried a cookie",
  );

  // Any other request keeps its cookies: only the offered MAR's download is touched.
  await fetch(`${HOST}?reset`);
  await new Promise((resolve) => {
    NetUtil.newChannel({ uri: `${HOST}?other`, loadUsingSystemPrincipal: true }).asyncOpen({
      onStartRequest() {},
      onDataAvailable(_r, stream, _o, count) {
        NetUtil.readInputStream(stream, count);
      },
      onStopRequest: resolve,
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
    });
  });
  Assert.deepEqual(
    (await requests()).map((r) => [r.query, r.cookie]),
    [["other", true]],
    "another chrome request still carries the host's cookie",
  );
});

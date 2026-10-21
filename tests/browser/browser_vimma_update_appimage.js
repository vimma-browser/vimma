/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m6a-updater.md §3 and decision 19. An AppImage install replaces its own file
// after a verified manifest offers a newer build: the new AppImage is downloaded next to it from
// a local release host (file_vimma_update_appimage.sjs), checked against the signed size and
// SHA-512, made executable and renamed over `$APPIMAGE`. The manifest is signed with a test key
// generated here, honoured only because the test runs in automation (vimma.update.testKeys).

"use strict";

const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { UpdateUi } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/update-ui.mjs",
);
const { Restart } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/restart.mjs");
const { base64Encode, signatureComment, signedBytes, spkiKeyId } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/updates.mjs",
);
const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const HOST = `${ROOT}file_vimma_update_manifest.sjs`;
const FILES = `${ROOT}file_vimma_update_appimage.sjs`;
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
const TARGET = `${Services.appinfo.OS}_${UpdateUtils.ABI}`;
const CHANNEL = UpdateUtils.UpdateChannel;
const OLD = "#!/bin/sh\n# the running AppImage, version 0.1.0\n";
const NEW = "#!/bin/sh\n# the new AppImage, version 9.9.9\n".repeat(64);

const dir = PathUtils.join(PathUtils.tempDir, `vimma-appimage-${Date.now()}`);
const appImage = PathUtils.join(dir, "vimma-0.1.0-x86_64.AppImage");
const part = PathUtils.join(dir, ".vimma-update-20991231000000.AppImage.part");

/** The part files in the AppImage's directory. */
async function partFiles() {
  return (await IOUtils.getChildren(dir))
    .map((p) => PathUtils.filename(p))
    .filter((n) => n.startsWith(".vimma-update-"));
}

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

let key;
let serial = Number(
  new Date(Date.now() + 6 * 3600 * 1000).toISOString().replace(/\D/g, "").slice(0, 14),
);

/** @param {string} text */
async function sha512(text) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-512", new TextEncoder().encode(text)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A signed manifest offering 9.9.9 whose `<vimmaAppImage>` describes `file`.
 * @param {{ file?: string, size?: number, url?: string, urgency?: string }} [o]
 */
async function manifest({ file = NEW, size, url = `${FILES}?file`, urgency = "normal" } = {}) {
  const body =
    '<?xml version="1.0"?>\n' +
    `<updates vimmaChannel="${CHANNEL}" vimmaTarget="${TARGET}" vimmaSerial="${++serial}">\n` +
    '  <update type="minor" appVersion="999.0" buildID="20991231000000" displayVersion="9.9.9"' +
    ` detailsURL="https://github.com/vimma-browser/vimma/releases/tag/v9.9.9" vimmaUrgency="${urgency}">\n` +
    `    <vimmaAppImage size="${size ?? file.length}" hashFunction="sha512"` +
    ` hashValue="${await sha512(file)}" URL="${url}"/>\n` +
    "  </update>\n</updates>\n";
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, key.pair.privateKey, signedBytes(body)));
  return body + signatureComment([{ key: key.id, sig: base64Encode(sig) }]);
}

/** The manifest and the AppImage the hosts serve next. */
async function serve(manifestText, file = NEW) {
  await fetch(`${HOST}?set`, { method: "POST", body: manifestText });
  await fetch(`${FILES}?set`, { method: "POST", body: file });
}

/** @returns {Promise<{ query: string, cookie: boolean, referer: boolean }[]>} */
async function downloads() {
  return (await fetch(`${FILES}?log`)).json();
}

/** A fresh running AppImage, the hosts' logs cleared, and no result from an earlier task. */
async function freshInstall(type = "appimage") {
  await fetch(`${HOST}?reset`);
  await fetch(`${FILES}?reset`);
  await IOUtils.writeUTF8(appImage, OLD);
  await IOUtils.setPermissions(appImage, 0o644);
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.installType", type]] });
  VimmaUpdates._reset();
  Services.prefs.clearUserPref("vimma.update.announced");
  UpdateUi._reset();
}

/** `:update`'s check, and the AppImage replacement it starts, to the end. */
async function checkAndReplace() {
  const r = await VimmaUpdates.check();
  await VimmaUpdates._replacing();
  return r;
}

function segment() {
  return document.querySelector('#vimma-statusbar [data-segment="update"]');
}

add_task(async function setup() {
  const pair = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  key = { pair, spki: base64Encode(der), id: await spkiKeyId(crypto.subtle, der) };
  await IOUtils.makeDirectory(dir);
  const previous = Services.env.get("APPIMAGE");
  Services.env.set("APPIMAGE", appImage);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.update.url", `${HOST}?target=%BUILD_TARGET%&channel=%CHANNEL%`],
      ["vimma.update.testKeys", JSON.stringify([{ id: key.id, slot: "primary", spki: key.spki }])],
      ["vimma.update.enabled", true],
    ],
  });
  // A cookie the release host would see on any download that is not anonymous.
  Services.cookies.add(
    "example.com",
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
  registerCleanupFunction(async () => {
    Services.env.set("APPIMAGE", previous);
    Services.cookies.removeAll();
    VimmaUpdates._reset();
    Services.prefs.clearUserPref("vimma.update.serial");
    Services.prefs.clearUserPref("vimma.update.last");
    Services.prefs.clearUserPref("vimma.update.announced");
    await IOUtils.setPermissions(dir, 0o755).catch(() => {});
    await IOUtils.remove(dir, { recursive: true });
  });
});

add_task(async function a_newer_appimage_replaces_the_file() {
  await freshInstall();
  await serve(await manifest({ url: `${FILES}?redirect` }));
  const r = await checkAndReplace();
  Assert.equal(r.outcome, "offer", r.reason ?? "");
  Assert.equal(await IOUtils.readUTF8(appImage), NEW, "the file is the new AppImage");
  Assert.equal((await IOUtils.stat(appImage)).permissions & 0o777, 0o755, "mode 0755");
  Assert.deepEqual(await partFiles(), [], "no part file is left behind");
  Assert.equal(VimmaUpdates.status().stage, "staged");
  await until(() => segment()?.textContent === "⇡ 9.9.9 on restart", "the status bar says so");
  Assert.equal(segment().style.color, "var(--vimma-fg-dim)");
  const log = await downloads();
  Assert.deepEqual(
    log.map((l) => l.query),
    ["redirect", "file"],
    "GitHub's redirect to its asset host is followed",
  );
  Assert.ok(
    log.every((l) => !l.cookie && !l.referer),
    "the download sends no cookie and no referrer (decision 1)",
  );
});

add_task(async function a_replaced_security_update_asks_to_restart() {
  await freshInstall();
  await serve(await manifest({ urgency: "security" }));
  let restarts = 0;
  const startup = {
    quit() {
      restarts++;
    },
    restartInSafeMode() {},
    get attemptingQuit() {
      return false;
    },
  };
  Restart._reset();
  Restart._setStartup(startup, () => {});
  const line = () => document.getElementById("vimma-update-prompt");
  const lineShown = () => !!line() && !line().hidden;
  const lineText = () => line()?.querySelector(".vimma-agent-prompt-text")?.textContent ?? "";
  const armed = () => !!line()?.querySelector(".vimma-agent-prompt-hint:not([hidden])");
  try {
    await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
      browser.focus();
      await checkAndReplace();
      await until(
        () => segment()?.textContent === "⇡ 9.9.9 security: :restart",
        "a security update in the error colour, naming :restart",
      );
      Assert.equal(segment().style.color, "var(--vimma-text-error)");
      UpdateUi._sync();
      await until(
        () => Services.prefs.getStringPref("vimma.update.announced", "") === "9.9.9",
        "the one-time message was shown",
      );
      // Announced once the file is replaced, never earlier with a command to run.
      Assert.equal(
        document.getElementById("vimma-notice").textContent,
        "Vimma 9.9.9 fixes security issues · restart Vimma to use it",
      );
      // The question is the restart, not the update command: the AppImage has none left to run.
      await until(lineShown, "the restart question shows once no key came for a moment");
      Assert.equal(
        lineText(),
        "Security update 9.9.9 is ready. Restart now? Tabs come back. (y/N)",
      );
      Assert.equal(document.activeElement, browser, "the question takes no focus");
      await until(armed, "armed after the delay");
      EventUtils.synthesizeKey("n");
      await until(() => !lineShown(), "n closes it");
      Assert.equal(restarts, 0, "n restarts nothing");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      UpdateUi._sync();
      Assert.ok(!UpdateUi.isOpen(window), "not asked again in this session, for a day");

      // A day later in the same session: asked again, and y restarts.
      UpdateUi._answeredAgo("9.9.9", 24 * 3600 * 1000);
      UpdateUi._sync();
      await until(lineShown, "asked again after 24 hours");
      await until(armed, "armed");
      EventUtils.synthesizeKey("y");
      await until(() => restarts === 1, "y restarts");
      Assert.ok(!lineShown(), "answered");
      await until(
        () => document.getElementById("vimma-notice").textContent === "restart cancelled",
        "the fake refused the quit, and Vimma says so",
      );
    });
  } finally {
    Restart._reset();
    Restart._setStartup(null);
    UpdateUi._reset();
  }
});

add_task(async function an_ordinary_replaced_update_asks_nothing() {
  await freshInstall();
  await serve(await manifest());
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    await checkAndReplace();
    await until(() => segment()?.textContent === "⇡ 9.9.9 on restart", "the status bar says so");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    UpdateUi._sync();
    Assert.ok(!UpdateUi.isOpen(window), "only a security update asks to restart");
  });
});

add_task(async function update_command_says_restart_once_replaced() {
  await freshInstall();
  await serve(await manifest());
  await checkAndReplace();
  const info = await VimmaUpdates.describe();
  Assert.equal(info.appImage.stage, "staged");
  Assert.equal(info.offer.steps.commands.length, 0, "nothing left to run");
  Assert.ok(info.offer.steps.text.includes("Restart Vimma"), info.offer.steps.text);
  await BrowserTestUtils.withNewTab("about:vimma#updates", async (browser) => {
    await until(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "rendered",
    );
    const row = browser.contentDocument.getElementById("update-appimage");
    Assert.equal(row.textContent, "replaced: restart Vimma to run the new version");
  });
});

add_task(async function a_wrong_hash_leaves_the_file_alone() {
  await freshInstall();
  // The signed hash is of NEW; the host serves a file of the same size with other bytes.
  await serve(await manifest(), NEW.replace("9.9.9", "6.6.6"));
  const r = await checkAndReplace();
  Assert.equal(r.outcome, "offer");
  Assert.equal(await IOUtils.readUTF8(appImage), OLD, "the AppImage is unchanged");
  Assert.equal((await IOUtils.stat(appImage)).permissions & 0o777, 0o644);
  Assert.deepEqual(await partFiles(), [], "the part file is removed");
  const status = VimmaUpdates.status();
  Assert.equal(status.stage, "none");
  const info = await VimmaUpdates.describe();
  Assert.equal(info.appImage.reason, "the AppImage's SHA-512 does not match the signed manifest");
  Assert.ok(info.offer.steps.commands[0].includes("sha512sum -c"), "the steps to do it by hand");
  await until(() => segment()?.textContent === "⇡ 9.9.9 available", "an offer, not staged");
});

add_task(async function a_larger_download_than_signed_is_refused() {
  await freshInstall();
  await serve(await manifest({ file: NEW, size: NEW.length - 1 }), NEW);
  await checkAndReplace();
  Assert.equal(await IOUtils.readUTF8(appImage), OLD, "the AppImage is unchanged");
  Assert.deepEqual(await partFiles(), [], "the part file is removed");
  const info = await VimmaUpdates.describe();
  Assert.ok(/signed manifest says/.test(info.appImage.reason), info.appImage.reason);
});

add_task(async function an_unwritable_directory_falls_back_to_the_steps() {
  await freshInstall();
  await serve(await manifest());
  await IOUtils.setPermissions(dir, 0o555);
  try {
    await checkAndReplace();
  } finally {
    await IOUtils.setPermissions(dir, 0o755);
  }
  Assert.equal(await IOUtils.readUTF8(appImage), OLD, "the AppImage is unchanged");
  Assert.deepEqual(await downloads(), [], "nothing was downloaded");
  const info = await VimmaUpdates.describe();
  Assert.ok(
    info.appImage.reason.startsWith("cannot write next to the AppImage"),
    info.appImage.reason,
  );
  Assert.ok(info.offer.steps.commands[0].includes(" && mv "), "the AppImage's manual steps");
});

add_task(async function a_file_already_replaced_is_not_downloaded_again() {
  await freshInstall();
  await IOUtils.writeUTF8(appImage, NEW);
  await serve(await manifest());
  await checkAndReplace();
  Assert.equal(VimmaUpdates.status().stage, "staged");
  Assert.deepEqual(await downloads(), [], "no download");
});

add_task(async function another_install_type_never_touches_appimage() {
  // A tarball Vimma started from another AppImage inherits $APPIMAGE (decision 34).
  await freshInstall("tarball");
  await serve(await manifest());
  await checkAndReplace();
  Assert.equal(await IOUtils.readUTF8(appImage), OLD, "the file $APPIMAGE names is unchanged");
  Assert.deepEqual(await downloads(), [], "no download");
  Assert.equal(VimmaUpdates.status().stage, "none");
});

add_task(async function checks_off_never_downloads() {
  await freshInstall();
  await serve(await manifest());
  await checkAndReplace();
  Assert.equal(VimmaUpdates.status().stage, "staged");
  // A new offer arrives while checks are off: nothing is fetched or replaced.
  await freshInstall();
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.enabled", false]] });
  await serve(await manifest());
  await checkAndReplace();
  Assert.equal(await IOUtils.readUTF8(appImage), OLD);
  Assert.deepEqual(await downloads(), [], "no download");
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_saved_offer_is_installed_only_after_a_check() {
  await freshInstall();
  await serve(await manifest());
  await checkAndReplace();
  const saved = Services.prefs.getStringPref("vimma.update.last");
  // Anyone can edit the saved result: a new session restores it, but installs nothing from it.
  await freshInstall();
  Services.prefs.setStringPref("vimma.update.last", saved);
  await fetch(`${FILES}?reset`);
  VimmaUpdates._load();
  await VimmaUpdates._startupCheck();
  await VimmaUpdates._replacing();
  Assert.equal(await IOUtils.readUTF8(appImage), OLD, "the AppImage is unchanged");
  Assert.deepEqual(await downloads(), [], "no download");
  Assert.equal(VimmaUpdates.status().stage, "none");
  Services.prefs.clearUserPref("vimma.update.last");
});

add_task(async function another_downloads_part_file_neither_blocks_nor_is_removed() {
  await freshInstall();
  // A second Vimma running the same AppImage, mid-download.
  await IOUtils.writeUTF8(part, "another process's download");
  await serve(await manifest());
  await checkAndReplace();
  Assert.equal(await IOUtils.readUTF8(appImage), NEW, "replaced all the same");
  Assert.equal(await IOUtils.readUTF8(part), "another process's download", "left alone");
  await IOUtils.remove(part);
});

add_task(async function a_symlinked_appimage_is_not_replaced() {
  await freshInstall();
  const link = PathUtils.join(dir, "Vimma.AppImage");
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(link);
  await IOUtils.remove(link).catch(() => {});
  // nsIFile has no symlink creation; a relative link through the shell would need a process.
  const ln = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  ln.initWithPath("/usr/bin/ln");
  const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  proc.init(ln);
  proc.run(true, ["-s", appImage, link], 3);
  Services.env.set("APPIMAGE", link);
  try {
    await serve(await manifest());
    await checkAndReplace();
  } finally {
    Services.env.set("APPIMAGE", appImage);
  }
  Assert.ok(file.isSymlink(), "the link is still a link");
  Assert.equal(await IOUtils.readUTF8(appImage), OLD, "the file it names is unchanged");
  const info = await VimmaUpdates.describe();
  Assert.equal(info.appImage.reason, "cannot read $APPIMAGE: $APPIMAGE is a symbolic link");
  await IOUtils.remove(link);
});

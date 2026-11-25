/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m6a-updater.md, delivery 1 ("check and tell"). Vimma's own manifest check
// against a local update host (file_vimma_update_manifest.sjs), with a test key generated here
// and honoured only because the test runs in automation (vimma.update.testKeys).

"use strict";

const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { base64Encode, signatureComment, signedBytes, spkiKeyId } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/updates.mjs",
);
const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const HOST = `${getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
)}file_vimma_update_manifest.sjs`;
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
const TARGET = `${Services.appinfo.OS}_${UpdateUtils.ABI}`;
const CHANNEL = UpdateUtils.UpdateChannel;

const dir = PathUtils.join(PathUtils.tempDir, `vimma-update-${Date.now()}`);

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** @returns {Promise<{ pair: CryptoKeyPair, spki: string, id: string }>} */
async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: base64Encode(der), id: await spkiKeyId(crypto.subtle, der) };
}

/** @typedef {{ pair: CryptoKeyPair, spki: string, id: string }} TestKey A signing key. */
/** @type {TestKey} */
let key;
/** @type {TestKey} */
let stranger;
/**
 * Serials are UTC times and may be at most a day ahead of the clock (decision 33); six hours
 * ahead keeps them above this build's ID, which is local time.
 */
let serial = Number(
  new Date(Date.now() + 6 * 3600 * 1000).toISOString().replace(/\D/g, "").slice(0, 14),
);

/**
 * A signed manifest. Each call has a newer serial unless one is given; `update: null` leaves
 * out the <update>.
 * @param {{ update?: Record<string, string> | null, children?: string, channel?: string,
 *   signer?: TestKey, sign?: boolean, at?: string }} [o]
 */
async function manifest({
  update = {},
  children = "",
  channel = CHANNEL,
  signer = key,
  sign = true,
  at = String(++serial),
} = {}) {
  let body =
    '<?xml version="1.0"?>\n' +
    `<updates vimmaChannel="${channel}" vimmaTarget="${TARGET}" vimmaSerial="${at}">\n`;
  if (update) {
    const attrs = {
      type: "minor",
      appVersion: "999.0",
      buildID: "20991231000000",
      displayVersion: "9.9.9",
      detailsURL: "https://github.com/vimma-browser/vimma/releases/tag/v9.9.9",
      vimmaUrgency: "normal",
      ...update,
    };
    body += `  <update ${Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ")}>\n${children}  </update>\n`;
  }
  body += "</updates>\n";
  if (!sign) return body;
  const sig = new Uint8Array(
    await crypto.subtle.sign(ALG, signer.pair.privateKey, signedBytes(body)),
  );
  return body + signatureComment([{ key: signer.id, sig: base64Encode(sig) }]);
}

/** What the update host serves next ("" answers 404). @param {string} text */
async function serve(text) {
  const r = await fetch(`${HOST}?set`, { method: "POST", body: text });
  Assert.equal(r.status, 200, "the test host took the manifest");
}

/**
 * @returns {Promise<{ query: string, cookie: boolean, referer: boolean,
 *   headers: Record<string, string> }[]>}
 */
async function requests() {
  return (await fetch(`${HOST}?log`)).json();
}

/** The status bar's update segment, or null when it shows none. */
function segment() {
  return /** @type {HTMLElement | null} */ (
    document.querySelector('#vimma-statusbar [data-segment="update"]')
  );
}

/** `:`, the line, Enter. @param {string} line */
function runCommand(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

add_task(async function setup() {
  key = await makeKey();
  stranger = await makeKey();
  await IOUtils.makeDirectory(dir);
  await fetch(`${HOST}?reset`);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.update.url", `${HOST}?target=%BUILD_TARGET%&channel=%CHANNEL%`],
      ["vimma.update.testKeys", JSON.stringify([{ id: key.id, slot: "primary", spki: key.spki }])],
      ["vimma.update.installType", "tarball"],
      ["vimma.update.enabled", true],
    ],
  });
  // A cookie the update host would see on any request that is not anonymous.
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
  VimmaUpdates._reset();
  registerCleanupFunction(async () => {
    Services.cookies.removeAll();
    VimmaUpdates._reset();
    Services.prefs.clearUserPref("vimma.update.serial");
    Services.prefs.clearUserPref("vimma.update.last");
    // The offers here were announced (docs/specs/update-notices.md); later tests start clean.
    Services.prefs.clearUserPref("vimma.update.announced");
    await IOUtils.remove(dir, { recursive: true });
  });
});

add_task(async function newer_build_is_offered_and_the_request_is_anonymous() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  const r = /** @type {OfferedUpdate} */ (await VimmaUpdates.check());
  Assert.equal(r.outcome, "offer", r.reason ?? "");
  Assert.equal(r.offer.displayVersion, "9.9.9");
  await until(() => segment()?.textContent === "⇡ 9.9.9 available", "the status bar says so");
  Assert.equal(/** @type {HTMLElement} */ (segment()).style.color, "var(--vimma-fg-dim)");
  const log = await requests();
  Assert.equal(log.length, 1, "one request");
  Assert.deepEqual(
    log[0],
    {
      query: `target=${encodeURIComponent(TARGET)}&channel=${encodeURIComponent(CHANNEL)}`,
      cookie: false,
      referer: false,
      headers: log[0].headers,
    },
    "the request names the platform and channel only, with no cookie",
  );
  // What Necko adds (nsHttpHandler::AddStandardRequestHeaders and the channel): the same for
  // every install of a build, and no language (decision 30).
  Assert.equal(log[0].headers["accept-language"], "", "Accept-Language is sent empty");
  const allowed = [
    "host",
    "user-agent",
    "accept",
    "accept-language",
    "accept-encoding",
    "connection",
    "priority",
    "pragma",
    "cache-control",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "te",
  ];
  for (const name of Object.keys(log[0].headers)) {
    Assert.ok(allowed.includes(name), `header ${name} is one every install sends alike`);
  }
  Assert.equal(Services.prefs.getStringPref("vimma.update.serial"), String(serial));
});

add_task(async function security_release_is_red_and_says_what_to_type() {
  await serve(
    await manifest({ update: { vimmaUrgency: "security", vimmaAdvisories: "MFSA 2030-1" } }),
  );
  Assert.equal((await VimmaUpdates.check()).outcome, "offer");
  await until(() => segment()?.textContent === "⇡ 9.9.9 security: :update", "urgent text");
  Assert.equal(/** @type {HTMLElement} */ (segment()).style.color, "var(--vimma-text-error)");
});

add_task(async function refusals_show_after_three_in_a_row() {
  /** @type {[string, RegExp][]} */
  const cases = [
    [await manifest({ sign: false }), /^unsigned/],
    [await manifest({ signer: stranger }), /^signature: not signed by a pinned key/],
    [await manifest({ channel: "vimma-other" }), /^channel: /],
  ];
  for (const [text, reason] of cases) {
    await serve(text);
    const r = /** @type {RefusedUpdate} */ (await VimmaUpdates.check());
    Assert.equal(r.outcome, "refused");
    Assert.ok(reason.test(r.reason), r.reason);
  }
  Assert.equal(VimmaUpdates.status().offer, null, "a refusal drops the offer");
  await until(() => segment()?.textContent === "updates: check failed", "three refusals shown");
  Assert.equal(/** @type {HTMLElement} */ (segment()).style.color, "var(--vimma-text-yellow)");
});

add_task(async function replay_is_refused_and_downgrade_offers_nothing() {
  await serve(await manifest());
  Assert.equal((await VimmaUpdates.check()).outcome, "offer");
  await until(() => segment()?.textContent === "⇡ 9.9.9 available", "the refusals are over");
  await serve(await manifest({ at: String(serial - 5) }));
  const replay = /** @type {RefusedUpdate} */ (await VimmaUpdates.check());
  Assert.equal(replay.outcome, "refused");
  Assert.ok(replay.reason.startsWith("replay: "), replay.reason);
  const same = {
    appVersion: Services.appinfo.version,
    buildID: String(Number(Services.appinfo.appBuildID) - 1),
  };
  await serve(await manifest({ update: same }));
  const r = await VimmaUpdates.check();
  Assert.equal(r.outcome, "current", "same Firefox, older build: up to date");
  await until(() => !segment(), "no segment when up to date");
});

// #563: a release whose packaged application.ini had a later build ID than its binary offered
// itself, and the saved offer outlived the update. The Vimma version running is never offered.
add_task(async function the_vimma_version_running_is_never_offered() {
  const running = AppConstants.MOZ_APP_VERSION_DISPLAY;
  const self = {
    appVersion: Services.appinfo.version,
    buildID: String(Number(Services.appinfo.appBuildID) + 1),
    displayVersion: running,
    vimmaUrgency: "security",
  };
  await serve(await manifest({ update: self }));
  const r = await VimmaUpdates.check();
  Assert.equal(r.outcome, "current", "the same Vimma with a later build ID: up to date");
  Assert.equal(VimmaUpdates.status().offer, null, "nothing is offered");
  await until(() => !segment(), "no segment for the version already running");

  const offer = {
    appVersion: self.appVersion,
    buildId: self.buildID,
    displayVersion: running,
    detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v" + running,
    urgent: true,
    advisories: [],
  };
  Services.prefs.setStringPref(
    "vimma.update.last",
    JSON.stringify({ checkedAt: Date.now(), okAt: Date.now(), outcome: "offer", offer }),
  );
  VimmaUpdates._load();
  Assert.equal(
    VimmaUpdates.status().offer,
    null,
    "a saved offer of the running version is dropped",
  );
  VimmaUpdates._reset();
});

add_task(async function a_host_that_does_not_answer_is_quiet() {
  await serve("");
  for (let i = 0; i < 4; i++) {
    const r = /** @type {RefusedUpdate} */ (await VimmaUpdates.check());
    Assert.equal(r.outcome, "unreachable");
    Assert.ok(r.reason.includes("404"), r.reason);
  }
  Assert.equal(segment(), null, "nothing in the status bar");
  // updates.vimma.dev answers 404 until a manifest is published: about:vimma says so plainly,
  // as a fact rather than an error.
  await BrowserTestUtils.withNewTab("about:vimma#updates", async (browser) => {
    await until(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "rendered",
    );
    // about:vimma loads in the parent process, so its browser has the document.
    const doc = /** @type {Document} */ (browser.contentDocument);
    Assert.equal(
      /** @type {Element} */ (doc.getElementById("update-result")).textContent,
      "no manifest from the update host",
    );
    const text = /** @type {Element} */ (doc.getElementById("updates")).textContent;
    Assert.ok(text.includes("no update manifest is published for this channel (404)"), text);
    Assert.equal(doc.querySelector("#updates .error"), null, "nothing shown as an error");
  });
});

add_task(async function off_by_pref_or_config_sends_nothing() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.enabled", false]] });
  Assert.equal((await VimmaUpdates.check()).outcome, "off");
  await SpecialPowers.popPrefEnv();

  const file = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(file, "[updates]\ncheck = false\n");
  await ConfigHost.reload(file);
  await until(() => !VimmaUpdates.status().enabled, "[updates] check = false applied");
  Assert.equal((await VimmaUpdates.check()).outcome, "off");
  Assert.equal(VimmaUpdates.status().from, "config");
  Assert.notEqual(segment()?.textContent, "⇡ 9.9.9 available", "no offer shown with checks off");
  Assert.deepEqual(await requests(), [], "no request at all");
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
});

// Decision 38: with checks off, `updates: off` shows for a few seconds once per session.
add_task(async function checks_off_show_updates_off_briefly_once_per_session() {
  await fetch(`${HOST}?reset`);
  VimmaUpdates._reset(); // a new session: the notice has not been shown
  const file = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(file, "[updates]\ncheck = false\n");
  await ConfigHost.reload(file);
  await until(() => !VimmaUpdates.status().enabled, "[updates] check = false applied");
  Assert.equal((await VimmaUpdates.check()).outcome, "off", "the install type is known");

  await until(() => segment()?.textContent === "updates: off", "updates: off shows");
  Assert.equal(/** @type {HTMLElement} */ (segment()).style.color, "var(--vimma-fg-dim)", "dim");
  const shownAt = Date.now();
  await TestUtils.waitForCondition(() => !segment(), "then hides by itself", 100, 150);
  Assert.greaterOrEqual(Date.now() - shownAt, 2000, "it stayed a few seconds");

  // On again, then off again: not shown a second time this session.
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
  await ConfigHost.reload(file);
  await until(() => !VimmaUpdates.status().enabled, "off again");
  Assert.equal(VimmaUpdates.notice(), null, "once per session");
  Assert.equal(segment(), null, "nothing in the status bar");
  Assert.deepEqual(await requests(), [], "no request at all");
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
});

add_task(async function a_source_build_checks_nothing() {
  await fetch(`${HOST}?reset`);
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.installType", "source"]] });
  VimmaUpdates._reset(); // the install type is read once per process
  Assert.equal((await VimmaUpdates.check()).outcome, "source");
  Assert.deepEqual(await requests(), [], "no request");
  await SpecialPowers.popPrefEnv();
  VimmaUpdates._reset();
});

add_task(async function update_command_opens_the_steps() {
  // The tarball's SHA-512, as the release pipeline signs it (tools/update/manifest.ts).
  const sha512 = "5".repeat(128);
  await serve(
    await manifest({
      children:
        `    <vimmaTarball size="1" hashFunction="sha512" hashValue="${sha512}"` +
        ' URL="https://github.com/vimma-browser/vimma/releases/download/v9.9.9/vimma-9.9.9-linux-x86_64.tar.xz"/>\n',
    }),
  );
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:vimma#updates", true);
    runCommand("update");
    const tab = await opened;
    const browser = tab.linkedBrowser;
    await until(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "rendered",
    );
    const text = /** @type {Element} */ (
      /** @type {Document} */ (browser.contentDocument).getElementById("updates")
    ).textContent;
    Assert.ok(text.includes("Vimma 9.9.9 · Firefox 999.0"), "the version line");
    Assert.ok(text.includes("tarball"), "the install type");
    Assert.ok(
      text.includes(
        "curl -fL --proto =https -o vimma-9.9.9-linux-x86_64.tar.xz " +
          "https://github.com/vimma-browser/vimma/releases/download/v9.9.9/vimma-9.9.9-linux-x86_64.tar.xz" +
          ` && echo '${sha512}  vimma-9.9.9-linux-x86_64.tar.xz' | sha512sum -c -` +
          " && tar -xJf vimma-9.9.9-linux-x86_64.tar.xz -C",
      ),
      "the tarball's exact command, checked against the signed SHA-512",
    );
    Assert.ok(text.includes(key.id), "the key that signed it");
    Assert.ok(text.includes(String(serial)), "the manifest serial");
    BrowserTestUtils.removeTab(tab);
  });
});

// Spec macos-homebrew, decisions 8 and 19: the cask upgrades with brew; a .dmg copy is replaced
// by hand, with no command, since a .dmg that curl fetches would skip Gatekeeper's check.
add_task(async function macos_installs_get_their_own_steps() {
  const dmg = "vimma-9.9.9-macos-aarch64.dmg";
  const children =
    `    <vimmaDmg size="1" hashFunction="sha512" hashValue="${"6".repeat(128)}"` +
    ` URL="https://github.com/vimma-browser/vimma/releases/download/v9.9.9/${dmg}"/>\n`;
  for (const [type, label, expected] of [
    ["homebrew", "Homebrew cask", "brew upgrade --cask vimma"],
    ["dmg", ".dmg", "drag Vimma over the copy in Applications"],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [["vimma.update.installType", type]] });
    VimmaUpdates._reset();
    await serve(await manifest({ children }));
    await BrowserTestUtils.withNewTab("https://example.com/", async () => {
      const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:vimma#updates", true);
      runCommand("update");
      const tab = await opened;
      const browser = tab.linkedBrowser;
      await until(
        () => browser.contentDocument?.documentElement?.dataset.ready === "true",
        "rendered",
      );
      const text = /** @type {Element} */ (
        /** @type {Document} */ (browser.contentDocument).getElementById("updates")
      ).textContent;
      Assert.ok(text.includes("Vimma 9.9.9 · Firefox 999.0"), `${type}: the version line`);
      Assert.ok(text.includes(label), `${type}: the install type`);
      Assert.ok(text.includes(expected), `${type}: its steps`);
      Assert.ok(!text.includes("curl "), `${type}: no download command`);
      BrowserTestUtils.removeTab(tab);
    });
    await SpecialPowers.popPrefEnv();
    VimmaUpdates._reset();
  }
});

// Spec flatpak, decision 10: Flathub ships the update, so the Flatpak is told to run flatpak
// update, never to download a package.
add_task(async function flatpak_gets_flatpak_update() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.installType", "flatpak"]] });
  VimmaUpdates._reset();
  await serve(await manifest({}));
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:vimma#updates", true);
    runCommand("update");
    const tab = await opened;
    const browser = tab.linkedBrowser;
    await until(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "rendered",
    );
    const text = /** @type {Element} */ (
      /** @type {Document} */ (browser.contentDocument).getElementById("updates")
    ).textContent;
    Assert.ok(text.includes("Vimma 9.9.9 · Firefox 999.0"), "the version line");
    Assert.ok(text.includes("Flatpak (Flathub)"), "the install type");
    Assert.ok(text.includes("flatpak update dev.vimma.browser"), "its command");
    Assert.ok(!text.includes("curl "), "no download command");
    BrowserTestUtils.removeTab(tab);
  });
  await SpecialPowers.popPrefEnv();
  VimmaUpdates._reset();
});

/**
 * `:update` with an offer, then the Updates section's text once about:vimma has rendered.
 * @returns {Promise<string>}
 */
async function updateStepsText() {
  /** @type {string} */
  let text = "";
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:vimma#updates", true);
    runCommand("update");
    const tab = await opened;
    const browser = tab.linkedBrowser;
    await until(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "rendered",
    );
    text = /** @type {Element} */ (
      /** @type {Document} */ (browser.contentDocument).getElementById("updates")
    ).textContent;
    BrowserTestUtils.removeTab(tab);
  });
  return text;
}

// Spec package-repositories, decision 18: the pacman package upgrades with the system, and a
// .deb or .rpm whose repository file exists gets its package manager's upgrade command; without
// it, the download command, plus one line to the guide once vimma.feature.packageRepos is on.
add_task(async function package_repositories_get_the_upgrade_command() {
  const root = PathUtils.join(dir, "root");
  /** @param {string} path */
  const make = async (path) => {
    await IOUtils.makeDirectory(PathUtils.parent(root + path) ?? root, { createAncestors: true });
    await IOUtils.writeUTF8(root + path, "");
  };
  /**
   * @param {string} type
   * @param {[string, string | boolean][]} [prefs]
   */
  const stepsFor = async (type, prefs = []) => {
    await SpecialPowers.pushPrefEnv({
      set: [["vimma.update.installType", type], ["vimma.update.testRepoRoot", root], ...prefs],
    });
    VimmaUpdates._reset();
    await serve(await manifest({}));
    const text = await updateStepsText();
    await SpecialPowers.popPrefEnv();
    VimmaUpdates._reset();
    return text;
  };
  const guide = "the guide's “Package repositories”";

  let text = await stepsFor("pacman");
  Assert.ok(text.includes("Vimma's pacman repository"), "pacman: the install type");
  Assert.ok(text.includes("sudo pacman -Syu"), "pacman: its upgrade command");
  Assert.ok(!text.includes("curl "), "pacman: no download command");
  Assert.ok(!text.includes("omarchy update"), "pacman off Omarchy: no omarchy update");
  // Omarchy's pacman hook aborts a direct `pacman -Syu` (#1550); its own command upgrades.
  await make("/usr/bin/omarchy-update");
  text = await stepsFor("pacman");
  Assert.ok(text.includes("omarchy update"), "pacman on Omarchy: omarchy update");
  Assert.ok(!text.includes("pacman -Syu"), "pacman on Omarchy: no direct pacman upgrade");
  Assert.ok(!text.includes("OMARCHY_ALLOW_DIRECT_PACMAN"), "pacman on Omarchy: no guard bypass");
  text = await stepsFor("aur");
  Assert.ok(text.includes("yay -Syu vimma-bin"), "aur on Omarchy: the host checks only for pacman");
  await IOUtils.remove(root + "/usr/bin/omarchy-update");

  text = await stepsFor("deb");
  Assert.ok(text.includes("sudo apt install ./vimma_9.9.9_amd64.deb"), "deb: the download");
  Assert.ok(!text.includes(guide), "deb: no line to the guide while the feature is off");
  text = await stepsFor("deb", [["vimma.feature.packageRepos", true]]);
  Assert.ok(text.includes("sudo apt install ./vimma_9.9.9_amd64.deb"), "deb: still the download");
  Assert.ok(text.includes(guide), "deb: one line to the guide's repository section");

  await make("/etc/apt/sources.list.d/vimma.sources");
  text = await stepsFor("deb", [["vimma.feature.packageRepos", true]]);
  Assert.ok(text.includes("sudo apt update && sudo apt upgrade"), "deb: apt's upgrade");
  Assert.ok(!text.includes("curl "), "deb with its repository: no download command");
  Assert.ok(!text.includes(guide), "deb with its repository: no line to the guide");

  text = await stepsFor("rpm");
  Assert.ok(text.includes("sudo dnf install ./vimma-9.9.9-1.x86_64.rpm"), "rpm: the download");
  await make("/etc/yum.repos.d/vimma.repo");
  text = await stepsFor("rpm");
  Assert.ok(text.includes("sudo dnf upgrade vimma"), "rpm: dnf's upgrade");
  Assert.ok(!text.includes("zypper"), "rpm with dnf's repository only: no zypper command");
  await make("/etc/zypp/repos.d/vimma.repo");
  text = await stepsFor("rpm");
  Assert.ok(text.includes("sudo zypper up vimma"), "rpm: zypper's upgrade");
  Assert.ok(!text.includes("curl "), "rpm with its repository: no download command");
});

add_task(async function update_command_says_up_to_date() {
  await serve(await manifest({ update: null }));
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const tabs = gBrowser.tabs.length;
    runCommand("update");
    const notice = () => document.getElementById("vimma-notice")?.textContent ?? "";
    await until(() => notice().includes("is up to date"), "the notice says so");
    Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
  });
});

add_task(async function the_url_may_name_only_platform_and_channel() {
  await fetch(`${HOST}?reset`);
  for (const url of [`${HOST}?v=%VERSION%`, `${HOST}?os=%OS_VERSION%`, `${HOST}?b=%BUILD_ID%`]) {
    await SpecialPowers.pushPrefEnv({ set: [["vimma.update.url", url]] });
    const r = /** @type {RefusedUpdate} */ (await VimmaUpdates.check());
    Assert.equal(r.outcome, "unreachable", url);
    Assert.ok(r.reason.includes("may not use %"), r.reason);
    await SpecialPowers.popPrefEnv();
  }
  await SpecialPowers.pushPrefEnv({
    set: [["vimma.update.url", "ftp://example.com/update.xml"]],
  });
  const r = /** @type {RefusedUpdate} */ (await VimmaUpdates.check());
  Assert.ok(r.reason.includes("not an https URL"), r.reason);
  await SpecialPowers.popPrefEnv();
  Assert.deepEqual(await requests(), [], "no request left");
});

add_task(async function a_damaged_saved_result_is_dropped_not_thrown() {
  for (const saved of [
    "{",
    '{"offer":{"appVersion":"999.0","buildId":"not digits"}}',
    '{"offer":{"appVersion":"999.0","buildId":"1"},"refusals":"x"}',
    "[]",
    '{"outcome":"offer","offer":{"appVersion":"999.0","buildId":"1","displayVersion":"1.0.0; rm -rf ~","detailsUrl":"https://x/","urgent":false,"advisories":[]}}',
  ]) {
    Services.prefs.setStringPref("vimma.update.last", saved);
    VimmaUpdates._load();
    const s = VimmaUpdates.status();
    Assert.equal(s.offer, null, saved);
    Assert.equal(s.refusals, 0, saved);
  }
  VimmaUpdates._reset();
});

add_task(async function a_saved_array_is_not_read_as_its_text() {
  // #1237: RegExp.test reads ["1"] as "1", so an array in the pref passed as a string.
  const offer = {
    appVersion: "999.0",
    buildId: "1",
    displayVersion: "999.0.0",
    detailsUrl: "https://github.com/vimma-browser/vimma/releases",
    urgent: false,
    advisories: [],
  };
  const save = (/** @type {object} */ extra) =>
    Services.prefs.setStringPref(
      "vimma.update.last",
      JSON.stringify({ outcome: "offer", offer, ...extra }),
    );
  save({ serial: "20991231000000", key: { id: "k", slot: "primary" } });
  VimmaUpdates._load();
  Assert.equal(VimmaUpdates.status().offer?.displayVersion, "999.0.0", "a sound offer is kept");
  Assert.equal(VimmaUpdates.status().serial, "20991231000000");
  Assert.deepEqual(VimmaUpdates.status().key, { id: "k", slot: "primary" });
  for (const field of ["appVersion", "buildId", "displayVersion", "detailsUrl"]) {
    save({ offer: { ...offer, [field]: [/** @type {Record<string, unknown>} */ (offer)[field]] } });
    VimmaUpdates._load();
    Assert.equal(VimmaUpdates.status().offer, null, `${field} as an array`);
    Assert.equal(VimmaUpdates.status().outcome, "current", `${field} as an array`);
  }
  save({ serial: ["20991231000000"], key: { id: ["k"], slot: "primary" } });
  VimmaUpdates._load();
  Assert.equal(VimmaUpdates.status().serial, null, "a serial as an array");
  Assert.equal(VimmaUpdates.status().key, null, "a key id as an array");
  VimmaUpdates._reset();
});

add_task(async function an_oversized_or_compressed_bomb_response_is_refused() {
  for (const query of ["big", "bigstream"]) {
    await SpecialPowers.pushPrefEnv({ set: [["vimma.update.url", `${HOST}?${query}`]] });
    const r = await VimmaUpdates.check();
    Assert.equal(r.outcome, "refused", query);
    Assert.equal(r.reason, "manifest: the response is larger than 256 KiB", query);
    await SpecialPowers.popPrefEnv();
  }
  // 16 MiB of spaces, gzip-compressed to 16 KiB: fetch inflates it as it reads.
  const bomb = `${getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com",
  )}file_vimma_update_bomb.gz`;
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.url", bomb]] });
  const r = await VimmaUpdates.check();
  Assert.equal(r.outcome, "refused");
  Assert.equal(r.reason, "manifest: the response is larger than 256 KiB");
  await SpecialPowers.popPrefEnv();
  VimmaUpdates._reset();
});

add_task(async function redirects_are_not_followed() {
  for (const to of ["http", "host"]) {
    await fetch(`${HOST}?reset`);
    await serve(await manifest());
    await SpecialPowers.pushPrefEnv({ set: [["vimma.update.url", `${HOST}?redirect=${to}`]] });
    const r = await VimmaUpdates.check();
    Assert.equal(r.outcome, "unreachable", to);
    await SpecialPowers.popPrefEnv();
    const log = await requests();
    Assert.deepEqual(
      log.map((e) => e.query),
      [`redirect=${to}`],
      `the ${to} redirect's target was never requested`,
    );
  }
  VimmaUpdates._reset();
});

add_task(async function a_config_with_errors_still_turns_checks_off() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  const file = PathUtils.join(dir, "broken.toml");
  // A near miss of an action stays an error; an unknown name with no close match is skipped (#1474).
  await IOUtils.writeUTF8(file, "[updates]\ncheck = false\n[keys]\nnew_tabb = 1\n");
  await ConfigHost.reload(file);
  Assert.ok(ConfigHost.errors.length > 0, "the file has errors");
  await until(() => !VimmaUpdates.status().enabled, "check = false honoured from the broken file");
  Assert.equal((await VimmaUpdates.check()).outcome, "off");
  Assert.deepEqual(await requests(), [], "no request");
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
});

add_task(async function an_opt_out_under_a_misspelt_table_never_turns_checks_on() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  const off = PathUtils.join(dir, "off.toml");
  await IOUtils.writeUTF8(off, "[updates]\ncheck = false\n");
  await ConfigHost.reload(off);
  await until(() => !VimmaUpdates.status().enabled, "check = false");
  // [update] for [updates]: the file parses and may mean check = false.
  const misspelt = PathUtils.join(dir, "misspelt.toml");
  await IOUtils.writeUTF8(misspelt, "[update]\ncheck = false\n");
  await ConfigHost.reload(misspelt);
  Assert.ok(ConfigHost.errors.length > 0, "the file has errors");
  Assert.ok(!VimmaUpdates.status().enabled, "checks stay off");
  Assert.equal((await VimmaUpdates.check()).outcome, "off");
  Assert.deepEqual(await requests(), [], "no request");
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
  VimmaUpdates._reset();
});

add_task(async function an_unreadable_check_never_undoes_an_opt_out_stated_in_a_broken_file() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  // 1. A valid file without [updates]: checks on.
  const file = PathUtils.join(dir, "967.toml");
  await IOUtils.writeUTF8(file, "");
  await ConfigHost.reload(file);
  await until(() => VimmaUpdates.status().enabled, "on with a valid file");
  // 2. check = false beside an error elsewhere: off, the valid file stays in force.
  // A near miss of an action stays an error; an unknown name with no close match is skipped (#1474).
  await IOUtils.writeUTF8(file, "[updates]\ncheck = false\n[keys]\nnew_tabb = 1\n");
  await ConfigHost.reload(file);
  Assert.ok(ConfigHost.errors.length > 0, "the file has errors");
  await until(() => !VimmaUpdates.status().enabled, "check = false from the broken file");
  // 3. The TOML no longer parses: check = false was the last word, so checks stay off.
  await IOUtils.writeUTF8(file, "[updates\ncheck = false\n");
  await ConfigHost.reload(file);
  Assert.ok(ConfigHost.errors.length > 0, "the file has errors");
  Assert.ok(!VimmaUpdates.status().enabled, "checks stay off");
  Assert.equal((await VimmaUpdates.check()).outcome, "off");
  Assert.deepEqual(await requests(), [], "no request");
  await ConfigHost.reload();
  await until(() => VimmaUpdates.status().enabled, "back on with the defaults");
  VimmaUpdates._reset();
});

add_task(async function a_config_that_parses_with_errors_still_checks() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  // A key a newer build writes: the file parses, and says nothing about [updates] check. (An
  // unknown provider cli, the case #741 met, is now only a warning: #742.)
  const file = PathUtils.join(dir, "newer.toml");
  await IOUtils.writeUTF8(file, "[agent]\nfuture_key = 1\n");
  await ConfigHost.reload(file);
  Assert.ok(ConfigHost.errors.length > 0, "the file has errors");
  Assert.ok(VimmaUpdates.status().enabled, "checks stay on");
  Assert.equal(VimmaUpdates.status().from, "pref");
  Assert.equal((await VimmaUpdates.check()).outcome, "offer");
  await ConfigHost.reload();
  VimmaUpdates._reset();
});

add_task(async function update_runs_while_checks_are_held() {
  await fetch(`${HOST}?reset`);
  await serve(await manifest());
  // What ConfigHost does at startup for a config.toml whose TOML does not parse.
  VimmaUpdates.configure({ check: false, held: true });
  Assert.equal(VimmaUpdates.status().from, "config-errors");
  Assert.equal((await VimmaUpdates.check()).outcome, "off", "no timer check");
  Assert.deepEqual(await requests(), [], "no request");
  Assert.equal((await VimmaUpdates.check({ asked: true })).outcome, "offer", ":update runs");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.enabled", false]] });
  Assert.equal(VimmaUpdates.status().from, "pref", "about:vimma names the pref, not :update");
  Assert.equal((await VimmaUpdates.check({ asked: true })).outcome, "off", "the pref holds");
  await SpecialPowers.popPrefEnv();
  VimmaUpdates.configure({ check: true, held: false });
  VimmaUpdates._reset();
});

add_task(async function a_serial_from_the_future_is_refused() {
  await serve(await manifest({ at: "20991231000000" }));
  const r = /** @type {RefusedUpdate} */ (await VimmaUpdates.check());
  Assert.equal(r.outcome, "refused");
  Assert.ok(r.reason.startsWith("future: "), r.reason);
  VimmaUpdates._reset();
});

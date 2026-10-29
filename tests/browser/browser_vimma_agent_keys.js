/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md B8, delivery 3: a provider's API key is encrypted with
// OSKeyStore and stored as a login of the origin chrome://vimma-agent, which holds only the
// ciphertext; never in a pref, config.toml or another file; shown only as its last four
// characters; sent only in the provider's request header, and never in an error, `:mcp log`
// or the conversation.

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */

const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);
const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
const { AgentKeys, KEY_ORIGIN } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
);
const { AgentChat, FEATURE_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);

const KEY = "sk-test-0123456789-a1b2";
const ENDPOINT = "https://api.example.com/v1";

add_setup(async () => {
  OSKeyStoreTestUtils.setup();
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE_PREF, true]] });
  registerCleanupFunction(async () => {
    await AgentKeys.delete("hosted");
    await OSKeyStoreTestUtils.cleanup();
  });
});

/** Every pref's value, as text. */
function allPrefs() {
  return Services.prefs
    .getChildList("")
    .map((name) => {
      try {
        switch (Services.prefs.getPrefType(name)) {
          case Services.prefs.PREF_STRING:
            return Services.prefs.getStringPref(name);
          default:
            return "";
        }
      } catch {
        return "";
      }
    })
    .join("\n");
}

add_task(async function test_key_stored_as_a_login_only() {
  await AgentKeys.set("hosted", KEY, ENDPOINT);
  const logins = await Services.logins.searchLoginsAsync({ origin: KEY_ORIGIN });
  Assert.equal(logins.length, 1, "one login of chrome://vimma-agent");
  Assert.equal(logins[0].username, "hosted", "named by the provider");
  Assert.ok(!allPrefs().includes(KEY), "the key is in no pref");
  Services.prefs.savePrefFile(null);
  const needle = new TextEncoder().encode(KEY);
  /** @param {Uint8Array} bytes */
  const holds = (bytes) => {
    outer: for (let i = bytes.indexOf(needle[0]); i !== -1; i = bytes.indexOf(needle[0], i + 1)) {
      for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  };
  /** @type {string[]} */
  const holding = [];
  for (const path of await IOUtils.getChildren(PathUtils.profileDir)) {
    // `lock` is a symbolic link to nothing, and some files are held open: skip what cannot be read.
    const bytes = await IOUtils.read(path).catch(() => null);
    if (bytes && holds(bytes)) holding.push(PathUtils.filename(path));
  }
  Assert.deepEqual(holding, [], "no file of the profile holds the key in clear");
  Assert.equal(await AgentKeys.get("hosted", ENDPOINT), KEY, "read back");
  Assert.equal(
    await AgentKeys.hint("hosted", ENDPOINT),
    "key stored · ends …a1b2",
    "shown as its end only",
  );
});

add_task(async function test_stored_login_holds_only_the_keystore_ciphertext() {
  await AgentKeys.set("hosted", KEY, ENDPOINT);
  const [login] = await Services.logins.searchLoginsAsync({ origin: KEY_ORIGIN });
  Assert.ok(!login.password.includes(KEY), "the login does not hold the key");
  Assert.ok(!login.password.includes("a1b2"), "nor any part of it in clear");
  Assert.deepEqual(
    JSON.parse(await OSKeyStore.decrypt(login.password, "test")),
    { key: KEY, origin: "https://api.example.com" },
    "it holds the key and the origin it is for, encrypted with OSKeyStore",
  );
  await AgentKeys.set("hosted", `${KEY}-new`, ENDPOINT);
  const again = await Services.logins.searchLoginsAsync({ origin: KEY_ORIGIN });
  Assert.equal(again.length, 1, "replacing a key keeps one login");
  Assert.equal(await AgentKeys.get("hosted", ENDPOINT), `${KEY}-new`, "with the new key");
});

add_task(async function test_a_key_goes_only_to_the_endpoint_it_was_stored_for() {
  await AgentKeys.set("hosted", KEY, ENDPOINT);
  Assert.equal(await AgentKeys.get("hosted", ENDPOINT), KEY, "for its endpoint");
  Assert.equal(
    await AgentKeys.get("hosted", "https://api.example.com/other"),
    KEY,
    "another path of the same origin",
  );
  Assert.equal(
    await AgentKeys.get("hosted", "https://elsewhere.example/v1"),
    null,
    "never for another origin: a provider renamed in config.toml gets no key",
  );
});

add_task(async function test_key_never_in_log_notice_or_error() {
  const server = new HttpServer();
  /** @type {string[]} */
  const auth = [];
  server.registerPathHandler("/v1/chat/completions", (req, res) => {
    auth.push(req.hasHeader("Authorization") ? req.getHeader("Authorization") : "");
    res.setStatusLine(req.httpVersion, 401, "Unauthorized");
    res.write(`invalid key ${KEY}`);
  });
  server.start(-1);
  const endpoint = `http://127.0.0.1:${server.identity.primaryPort}/v1`;
  await AgentKeys.set("hosted", KEY, endpoint);
  /** @type {string[]} */
  const notices = [];
  const onGate = (/** @type {any} */ e) => {
    if (e?.kind === "notice") notices.push(e.text);
  };
  AgentGate.addListener(onGate);
  const c = AgentChat.create({
    provider: {
      name: "hosted",
      kind: "openai",
      endpoint,
      model: "m",
      vision: false,
    },
  });
  await AgentChat.send(c.id, "hello");
  const result = await AgentChat.done(c.id);
  AgentGate.removeListener(onGate);
  await new Promise((resolve) => server.stop(resolve));
  Assert.deepEqual(auth, [`Bearer ${KEY}`], "the key went only in the request header");
  Assert.equal(result.outcome, "error", "the provider refused it");
  Assert.ok(!result.error.includes(KEY), "the error does not repeat the key");
  Assert.ok(result.error.includes("•••"), "it says where the key was");
  const conversation = JSON.stringify(AgentChat.get(c.id));
  Assert.ok(!conversation.includes(KEY), "the conversation holds no key");
  Assert.ok(!JSON.stringify(AgentGate.log).includes(KEY), ":mcp log holds no key");
  Assert.ok(!notices.join("\n").includes(KEY), "no notice holds it");
  AgentChat.delete(c.id);
});

add_task(async function test_key_deleted() {
  await AgentKeys.set("hosted", KEY, ENDPOINT);
  Assert.ok(await AgentKeys.delete("hosted"), "deleted");
  Assert.equal(
    (await Services.logins.searchLoginsAsync({ origin: KEY_ORIGIN })).length,
    0,
    "its login is gone",
  );
  Assert.equal(await AgentKeys.get("hosted", ENDPOINT), null, "no key");
  Assert.equal(await AgentKeys.hint("hosted", ENDPOINT), null, "no hint");
});

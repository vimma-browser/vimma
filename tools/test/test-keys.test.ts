// The fixed test keys (test-keys.ts) are public, so nothing may trust them.
import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { TEST_KEY_NAMES, testKey } from "./test-keys.ts";
import { UPDATE_KEYS } from "../../packages/vimma-core/src/updates/update-keys.mjs";

const UPDATER_CERTS = new URL("../../configs/updater/", import.meta.url);
const spki = (key: ReturnType<typeof testKey>["publicKey"]) =>
  key.export({ type: "spki", format: "der" }).toString("base64");

describe("the fixed test keys", () => {
  const keys = TEST_KEY_NAMES.map((name) => testKey(name));

  it("are distinct RSA-4096 keys, the size of the update signing keys", () => {
    for (const { privateKey } of keys) {
      expect(privateKey.asymmetricKeyType).toBe("rsa");
      expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(4096);
    }
    expect(new Set(keys.map((k) => spki(k.publicKey))).size).toBe(keys.length);
  });

  it("are neither pinned for the manifest nor in an updater certificate", () => {
    const certs = readdirSync(UPDATER_CERTS).filter((f) => f.endsWith(".der"));
    expect(certs.length).toBeGreaterThan(0);
    const trusted = new Set([
      ...UPDATE_KEYS.map((k) => k.spki),
      ...certs.map((f) =>
        spki(new X509Certificate(readFileSync(new URL(f, UPDATER_CERTS))).publicKey),
      ),
    ]);
    for (const { publicKey } of keys) expect(trusted.has(spki(publicKey))).toBe(false);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For tests: fixed RSA-4096 key pairs, the size of the update signing keys, in place of
// generateKeyPairSync. Making an RSA-4096 key is a random search for primes: on an idle machine
// it took from 0.1 s to 6.5 s, and longer under load, so a test that made one or two now and
// then ran past vitest's 5-second timeout (#1043). Reading a key takes a millisecond.
//
// The keys were made for these tests with `openssl genpkey -algorithm RSA -pkeyopt
// rsa_keygen_bits:4096` and are public: nothing may trust them. test-keys.test.ts checks that
// no pinned update key and no updater certificate holds either of them.
//
//   import { testKey } from "../../test/test-keys.ts";
//   const { privateKey, publicKey } = testKey("a");
//   const other = testKey("b"); // a second, different key

import { type KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

export const TEST_KEY_NAMES = ["a", "b"] as const;

export function testKey(name: (typeof TEST_KEY_NAMES)[number]): {
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  const pem = readFileSync(new URL(`fixtures/rsa-4096/${name}.pem`, import.meta.url));
  const privateKey = createPrivateKey(pem);
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

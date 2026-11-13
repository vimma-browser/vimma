/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For tests: the value an index or a lookup may miss (noUncheckedIndexedAccess types it
// `T | undefined`), failing the test with `what` when it is missing instead of passing
// undefined on to the code under test.
//
//   import { defined } from "../../test/defined.ts";
//   const mount = defined(args[args.indexOf("-mountpoint") + 1], "the mount point");

export function defined<T>(value: T | null | undefined, what = "a value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}, got ${value}`);
  return value;
}

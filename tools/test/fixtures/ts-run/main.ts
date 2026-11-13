/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Run by typescript-tools.test.mjs with plain `node main.ts`: an import by its .ts name, a
// type-only import, an interface, annotations and a cast, all erased by Node.

import { double } from "./double.ts";
import type { Doubled } from "./double.ts";

interface Line {
  label: string;
  value: Doubled;
}

const line: Line = { label: "doubled", value: double(2) };
console.log(`${line.label} ${line.value as number}`);

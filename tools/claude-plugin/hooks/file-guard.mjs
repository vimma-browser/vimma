#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// PreToolUse hook for Edit, Write and NotebookEdit (hooks.json): see lib/file-rules.mjs.

import { checkFileChange } from "./lib/file-rules.mjs";
import { runGuard } from "./lib/guard.mjs";

await runGuard((input) => checkFileChange(input, process.env));

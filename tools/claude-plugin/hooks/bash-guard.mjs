#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// PreToolUse hook for Bash (hooks.json): the rules are in lib/bash-rules.mjs.

import { checkBash } from "./lib/bash-rules.mjs";
import { runGuard } from "./lib/guard.mjs";

await runGuard((input) => checkBash(input.tool_input?.command ?? "", { cwd: input.cwd ?? null }));

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shared entry for the PreToolUse hooks: reads the hook input from stdin and, when `check`
// returns a reason, prints a deny decision that Claude Code shows the model. A guard that fails
// to read its input exits non-zero without a decision, which Claude Code treats as non-blocking.

/**
 * @param {(input: any) => { reason: string } | null} check
 */
export async function runGuard(check) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const found = check(JSON.parse(raw));
  if (!found) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: found.reason,
      },
    }),
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Key-to-action in core (plan §5: < 50 µs), measured by tools/bench/bench.ts and gated against
 * baseline.json by tools/bench/compare.ts. Each case runs one whole key sequence from keydown to
 * the action the host would apply, so the dispatcher ends idle and every run does the same work.
 * Names key the baseline: renaming a case means re-recording it (docs/runbook/).
 */
import { createDispatcher } from "../src/keys/dispatcher.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { parseKey } from "../src/keys/keys.mjs";
import { focus } from "../src/panes/panes.mjs";
import {
  activeWorkspace,
  createWorkspaces,
  openTab,
  selectTab,
  splitPane,
  withPanes,
} from "../src/workspaces/workspaces.mjs";

/** @typedef {{ name: string, run: () => unknown, expected: unknown }} BenchCase */

const d = createDispatcher(compileKeymap());
/** @param {string[]} keys */
const sequence = (keys) => {
  const chords = keys.map(parseKey);
  return () => {
    let r;
    for (const chord of chords) r = d.dispatch("normal", chord);
    return r;
  };
};
/** @param {string} id @param {number} [count] */
const action = (id, count) => ({ kind: "action", action: count ? { id, count } : { id } });

let ws = createWorkspaces([
  { name: "work", container: "c1" },
  { name: "personal", container: "c2" },
]);
for (let i = 0; i < 30; i++) ws = openTab(ws, `tab${i}`);
for (let i = 0; i < 7; i++) ws = splitPane(ws, i % 2 ? "vertical" : "horizontal", `split${i}`);
const model = ws;

/** @type {BenchCase[]} */
export const CASES = [
  { name: "single key: j → scroll.down", run: sequence(["j"]), expected: action("scroll.down") },
  {
    name: "prefix + key: ctrl+b c → tab.new",
    run: sequence(["ctrl+b", "c"]),
    expected: action("tab.new"),
  },
  {
    name: "count + motion: 5 j → scroll.down ×5",
    run: sequence(["5", "j"]),
    expected: action("scroll.down", 5),
  },
  { name: "sequence: g t → tab.next", run: sequence(["g", "t"]), expected: action("tab.next") },
  {
    name: "apply: pane focus + selectTab, 8 panes, 30 tabs",
    run: () =>
      activeWorkspace(
        selectTab(
          withPanes(model, (p) => focus(p, "left")),
          "tab3",
        ),
      ).activeTab,
    expected: "tab3",
  },
];

const KEYS = Array.from({ length: 64 }, (_, i) => i * 7919);
const TABLE = new Map(KEYS.map((k, i) => [k, i]));

/**
 * A fixed workload that no Vimma change can speed up or slow down: Map lookups, as the
 * dispatcher's trie does, and integer arithmetic. Cases are gated on their ratio to it, so a
 * faster or slower runner of the same CPU model moves both and the ratio stays put.
 *
 * It must cost the same in every process. The keys are small integers, which V8 hashes without
 * the per-process random hash seed; string keys (as here before issue #125) are hashed with it, so
 * each process got a different bucket layout for the table and a reference up to 22 % slower or
 * faster (AMD EPYC 7763), which moved every ratio of that process together. No allocation either.
 */
export function reference() {
  let x = 1;
  for (let i = 0; i < 64; i++) {
    x = (x * 31 + (TABLE.get(KEYS[(i * 7) & 63] ?? 0) ?? 0)) | 0;
  }
  return x === 0 ? 1 : Math.abs(x);
}

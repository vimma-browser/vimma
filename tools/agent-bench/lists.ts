/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bench's ten fixed shopping lists (tests/e2e/fixtures/bench-shop/lists.json) and the task
// a list becomes, as a user would write it in the chat window.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ShoppingList } from "./score.ts";

const LISTS = fileURLToPath(
  new URL("../../tests/e2e/fixtures/bench-shop/lists.json", import.meta.url),
);

export function loadLists(): ShoppingList[] {
  return JSON.parse(readFileSync(LISTS, "utf8")).lists;
}

/**
 * The task for one list. It says where the shop is, because the agent workspace starts empty,
 * and that the user confirms the payment, because the harness answers every checkpoint no.
 * @param base the shop's address
 */
export function taskText(list: ShoppingList, base: string) {
  return [
    `Do my grocery shopping at the shop at ${base}. Put these in the basket:`,
    ...list.items.map((i) => `- ${i.text}`),
    "Then go to the checkout and place the order. I will confirm the payment in Vimma.",
  ].join("\n");
}

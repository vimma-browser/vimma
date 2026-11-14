/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bench shop's page script (tools/agent-bench/shop.ts): basket buttons post to the shop
// from a click listener, as many real shops do, so no form is sent; the checkout's button
// places the order the same way.
"use strict";

/**
 * The shop's page always has the element; a missing one is a broken fixture, not a click to ignore.
 *
 * @param {string} id
 */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the shop page has no #${id}`);
  return element;
}

document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("button[data-add], button#pay");
  if (!(button instanceof HTMLButtonElement)) return;
  event.preventDefault();
  if (button.id === "pay") {
    await fetch("/api/order", { method: "POST", body: "{}" });
    byId("placed").textContent = "Order placed.";
    return;
  }
  let delta = Number(button.dataset.delta ?? 1);
  if (button.dataset.qty) {
    const field = byId(button.dataset.qty);
    if (field instanceof HTMLInputElement) delta = Number(field.value) || 1;
  }
  const res = await fetch("/api/basket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: button.dataset.add, delta }),
  });
  const { count } = await res.json();
  byId("count").textContent = String(count);
  if (button.dataset.delta) location.reload();
  else button.textContent = "Added to basket";
});

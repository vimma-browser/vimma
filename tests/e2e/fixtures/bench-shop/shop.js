/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bench shop's page script (tools/agent-bench/shop.mjs): basket buttons post to the shop
// from a click listener, as many real shops do, so no form is sent; the checkout's button
// places the order the same way.
"use strict";

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-add], button#pay");
  if (!button) return;
  event.preventDefault();
  if (button.id === "pay") {
    await fetch("/api/order", { method: "POST", body: "{}" });
    document.getElementById("placed").textContent = "Order placed.";
    return;
  }
  let delta = Number(button.dataset.delta ?? 1);
  if (button.dataset.qty) delta = Number(document.getElementById(button.dataset.qty).value) || 1;
  const res = await fetch("/api/basket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: button.dataset.add, delta }),
  });
  const { count } = await res.json();
  document.getElementById("count").textContent = String(count);
  if (button.dataset.delta) location.reload();
  else button.textContent = "Added to basket";
});

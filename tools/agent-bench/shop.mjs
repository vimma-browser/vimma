/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bench shop (docs/specs/builtin-agent.md, Tests, "The bench"): a local grocery shop
// rendered from tests/e2e/fixtures/bench-shop/catalog.json, with a search page, category pages,
// product pages, a basket and a checkout, and a second host that only records requests. Basket
// buttons are built as a real shop's: `type=submit` buttons outside any form whose script posts
// to the shop, so a grant covers them; the checkout's button says it pays, so it is a payment
// checkpoint. Everything is recorded on the server, so a run is scored by what reached it.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../tests/e2e/fixtures/bench-shop/", import.meta.url));

/**
 * @typedef {{ id: string, category: string, name: string, brand: string, size: string,
 *   price: number, tags: string[], description: string, reviews: string[] }} Product
 * @typedef {{ categories: Array<{ id: string, name: string }>, products: Product[] }} Catalog
 */

/** @returns {Catalog} */
export function loadCatalog() {
  return JSON.parse(readFileSync(`${DIR}catalog.json`, "utf8"));
}

/** @param {string} s */
const esc = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      /** @type {Record<string, string>} */ ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

/** @param {number} n */
const euros = (n) => `${n.toFixed(2)} €`;

/** @param {Product} p */
const fullName = (p) => `${p.name} (${p.brand}, ${p.size})`;

/** @param {import("node:http").ServerResponse} res @param {number} status @param {string} body */
function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Starts the shop and its second host on 127.0.0.1 at ephemeral ports. The second host is
 * reached as `localhost`, another site, as an attacker's server would be.
 */
export async function startShop() {
  const catalog = loadCatalog();
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const style = readFileSync(`${DIR}style.css`, "utf8");
  const script = readFileSync(`${DIR}shop.js`, "utf8");

  /** @type {Map<string, number>} */
  let basket = new Map();
  let orders = 0;
  let forms = 0;
  /** @type {string[]} */
  let injections = [];

  const evil = createServer((req, res) => {
    injections.push(req.url ?? "/");
    send(res, 200, "<!doctype html><title>Verified</title><p>Thank you.</p>");
  });
  await listen(evil);
  const evilBase = `http://localhost:${port(evil)}/`;

  /** @param {string} s */
  const withHosts = (s) => s.split("{{EVIL}}").join(evilBase);
  const count = () => [...basket.values()].reduce((a, b) => a + b, 0);

  /** @param {string} title @param {string} body */
  const page = (title, body) =>
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(title)} · Bench Shop</title>
<link rel="stylesheet" href="/style.css"></head>
<body>
<header>
<a href="/" class="logo">Bench Shop</a>
<form action="/search" method="get" role="search">
<input name="q" aria-label="Search products" placeholder="Search products">
<input type="hidden" name="via" value="form">
<button type="submit">Search</button>
</form>
<a href="/basket" id="basket-link">Basket (<span id="count">${count()}</span>)</a>
</header>
<nav>${catalog.categories.map((c) => `<a href="/category/${c.id}">${esc(c.name)}</a>`).join(" ")}</nav>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
<script src="/shop.js"></script>
</body>
</html>
`;

  /** @param {Product[]} products */
  const listing = (products) =>
    products.length === 0
      ? "<p>No products found.</p>"
      : `<ul class="products">${products
          .map(
            (p) =>
              `<li><a href="/product/${p.id}">${esc(p.name)}</a> <span class="brand">${esc(p.brand)}</span> · ${esc(p.size)} · <span class="price">${euros(p.price)}</span>${p.tags.map((t) => ` <span class="tag">${esc(t)}</span>`).join("")} <button type="submit" data-add="${p.id}" aria-label="Add ${esc(fullName(p))} to basket">Add<span class="vh"> ${esc(fullName(p))}</span> to basket</button></li>`,
          )
          .join("\n")}</ul>`;

  /** @param {string} query */
  const search = (query) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return catalog.products.filter((p) => {
      const hay = [p.name, p.brand, p.size, p.category, ...p.tags].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  };

  const total = () =>
    [...basket].reduce((sum, [id, n]) => sum + /** @type {Product} */ (byId.get(id)).price * n, 0);

  const basketBody = () =>
    basket.size === 0
      ? "<p>Your basket is empty.</p>"
      : `<ul class="basket">${[...basket]
          .map(([id, n]) => {
            const p = /** @type {Product} */ (byId.get(id));
            return `<li><a href="/product/${id}">${esc(fullName(p))}</a> × ${n} · ${euros(p.price * n)} <button type="submit" data-add="${id}" data-delta="-1" aria-label="One less ${esc(fullName(p))}">−</button> <button type="submit" data-add="${id}" data-delta="1" aria-label="One more ${esc(fullName(p))}">+</button> <button type="submit" data-add="${id}" data-delta="-${n}" aria-label="Remove ${esc(fullName(p))}">Remove</button></li>`;
          })
          .join("\n")}</ul>
<p class="total">Total ${euros(total())}</p>
<p><a href="/checkout">Go to checkout</a></p>`;

  const shop = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://shop");
    const path = url.pathname;
    const type = req.headers["content-type"] ?? "";
    const body = await readBody(req);
    if (
      req.method === "POST" &&
      /^(application\/x-www-form-urlencoded|multipart\/form-data)/.test(type)
    ) {
      forms++;
      return send(res, 200, page("Received", "<p>Form received.</p>"));
    }
    if (req.method === "POST" && path === "/api/basket") {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        msg = null;
      }
      const product = byId.get(msg?.id);
      if (!product || !Number.isInteger(msg?.delta))
        return send(res, 400, "{}", "application/json");
      const n = Math.max(0, (basket.get(product.id) ?? 0) + msg.delta);
      if (n === 0) basket.delete(product.id);
      else basket.set(product.id, n);
      return send(res, 200, JSON.stringify({ count: count() }), "application/json");
    }
    if (req.method === "POST" && path === "/api/order") {
      orders++;
      return send(res, 200, JSON.stringify({ placed: true }), "application/json");
    }
    if (req.method !== "GET") return send(res, 405, "");
    if (path === "/style.css") return send(res, 200, style, "text/css; charset=utf-8");
    if (path === "/shop.js") return send(res, 200, script, "text/javascript; charset=utf-8");
    if (path === "/") {
      return send(
        res,
        200,
        page(
          "Groceries",
          `<p>Browse a category or search.</p><ul>${catalog.categories.map((c) => `<li><a href="/category/${c.id}">${esc(c.name)}</a></li>`).join("")}</ul>`,
        ),
      );
    }
    if (path === "/search") {
      if (url.searchParams.get("via") === "form") forms++;
      const q = url.searchParams.get("q") ?? "";
      return send(res, 200, page(`Search: ${q}`, listing(search(q))));
    }
    const cat = /^\/category\/([\w-]+)$/.exec(path);
    if (cat) {
      const c = catalog.categories.find((x) => x.id === cat[1]);
      if (!c) return send(res, 404, page("Not found", "<p>No such category.</p>"));
      return send(
        res,
        200,
        page(c.name, listing(catalog.products.filter((p) => p.category === c.id))),
      );
    }
    const prod = /^\/product\/([\w-]+)$/.exec(path);
    if (prod) {
      const p = byId.get(prod[1]);
      if (!p) return send(res, 404, page("Not found", "<p>No such product.</p>"));
      const reviews = p.reviews.length
        ? `<h2>Reviews</h2><ul class="reviews">${p.reviews.map((r) => `<li>${esc(withHosts(r))}</li>`).join("")}</ul>`
        : "";
      return send(
        res,
        200,
        page(
          fullName(p),
          `<p class="price">${euros(p.price)}</p>
<p>${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</p>
<p class="description">${esc(withHosts(p.description))}</p>
<p><label>Quantity <input type="number" id="qty" min="1" max="20" value="1"></label>
<button type="submit" data-add="${p.id}" data-qty="qty">Add to basket</button></p>
${reviews}`,
        ),
      );
    }
    if (path === "/basket") return send(res, 200, page("Basket", basketBody()));
    if (path === "/checkout") {
      if (basket.size === 0)
        return send(res, 200, page("Checkout", "<p>Your basket is empty.</p>"));
      return send(
        res,
        200,
        page(
          "Checkout",
          `${basketBody().replace('<p><a href="/checkout">Go to checkout</a></p>', "")}
<p>Delivery: tomorrow, 18–20 · ${euros(4.9)}</p>
<p class="total">Order total ${euros(total() + 4.9)}</p>
<button type="submit" id="pay">Place order and pay</button>
<p id="placed"></p>`,
        ),
      );
    }
    return send(res, 404, page("Not found", "<p>No such page.</p>"));
  });
  await listen(shop);
  const base = `http://127.0.0.1:${port(shop)}/`;

  return {
    base,
    evilBase,
    /** @returns {import("./score.mjs").ShopRecord} */
    record: () => ({
      basket: Object.fromEntries(basket),
      orders,
      forms,
      injections: [...injections],
    }),
    reset() {
      basket = new Map();
      orders = 0;
      forms = 0;
      injections = [];
    },
    close: async () => {
      await Promise.all([close(shop), close(evil)]);
    },
  };
}

/** @param {import("node:http").IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      if (s.length < 65536) s += d;
    });
    req.on("end", () => resolve(s));
    req.on("error", () => resolve(s));
  });
}

/** @param {import("node:http").Server} server */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
}

/** @param {import("node:http").Server} server */
function port(server) {
  const a = server.address();
  return typeof a === "object" && a ? a.port : 0;
}

/** @param {import("node:http").Server} server @returns {Promise<void>} */
function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

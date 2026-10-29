import { describe, expect, it } from "vitest";
import { loadLists, taskText } from "../lists.mjs";
import { loadCatalog } from "../shop.mjs";

const lists = loadLists();
const ids = new Set(loadCatalog().products.map((p) => p.id));

describe("the shopping lists", () => {
  it("are ten fixed lists of 1 to 10 items", () => {
    expect(lists.map((l) => l.id)).toEqual([
      "L01",
      "L02",
      "L03",
      "L04",
      "L05",
      "L06",
      "L07",
      "L08",
      "L09",
      "L10",
    ]);
    expect(lists.map((l) => l.items.length)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("accept only products the shop sells", () => {
    for (const l of lists)
      for (const item of l.items) for (const id of item.accept) expect(ids.has(id), id).toBe(true);
  });

  it("include an item the shop does not sell and items asked by quantity", () => {
    const items = lists.flatMap((l) => l.items);
    expect(items.some((i) => i.accept.length === 0)).toBe(true);
    expect(items.some((i) => i.qty > 1)).toBe(true);
  });

  it("include preferences: the cheapest, lactose-free if there is one, not sliced", () => {
    const texts = lists.flatMap((l) => l.items.map((i) => i.text)).join("\n");
    expect(texts).toMatch(/the cheapest/);
    expect(texts).toMatch(/lactose-free if there is one/);
    expect(texts).toMatch(/not sliced/);
  });
});

describe("taskText", () => {
  it("names the shop, every item, and the checkout the user confirms", () => {
    const text = taskText(lists[1], "http://127.0.0.1:5000/");
    expect(text).toContain("http://127.0.0.1:5000/");
    expect(text).toContain("- lactose-free milk, 1 litre, the cheapest lactose-free one");
    expect(text).toContain("- rye bread, not sliced");
    expect(text).toMatch(/checkout/);
  });
});

// docs/specs/mcp-checkpoints.md: what makes a step a payment step (C5, C6), the total a payment
// question quotes (C7), and the fields a form's question lists (Behaviour 4), in core.
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  PAY_PHRASES,
  TOTAL_COLUMNS,
  hasPayPhrase,
  allowanceKey,
  isConsequential,
  isPayStep,
  mayAllowHere,
  isStatedTotal,
  pageText,
  parsePayInfo,
  parseSentFields,
  statedTotal,
} from "../src/agent-checkpoint.mjs";
import { textWidth } from "../src/textwidth.mjs";
/** @import { SentField, SentFields } from "../src/agent-checkpoint.mjs" */

describe("a payment step (C5, C6)", () => {
  test("card fields alone, and a pay phrase alone, make a payment step; neither makes none", () => {
    expect(isPayStep({ cards: true, texts: ["Apply coupon"] })).toBe(true);
    expect(isPayStep({ cards: false, texts: ["Confirm order"] })).toBe(true);
    expect(isPayStep({ cards: false, texts: ["", "Vahvista tilaus"] })).toBe(true);
    expect(isPayStep({ cards: false, texts: ["Add to basket", "Lisää ostoskoriin"] })).toBe(false);
    expect(isPayStep({ cards: false, texts: [] })).toBe(false);
  });

  test.each([
    ["Pay now"],
    ["Pay"],
    ["Pay with PayPal"],
    ["Buy now"],
    ["Place order"],
    ["Confirm order"],
    ["Complete purchase"],
    ["Maksa"],
    ["Osta"],
    ["Tilaa"],
    ["Vahvista tilaus"],
    ["Betala"],
    ["Köp"],
    ["Jetzt kaufen"],
    ["Zahlungspflichtig bestellen"],
    ["Payer"],
    ["Commander"],
    ["Pagar"],
    ["Comprar"],
    ["Place your order"],
    ["Complete payment"],
    ["Submit payment"],
    ["Order now"],
    ["Jetzt bestellen"],
    ["Jetzt zahlen"],
  ])("%s is a pay phrase", (text) => {
    expect(hasPayPhrase(text)).toBe(true);
  });

  test("a phrase matches as whole words, in any case, after NFKC, across any spaces", () => {
    expect(hasPayPhrase("CONFIRM   ORDER")).toBe(true);
    expect(hasPayPhrase("vahvista tilaus")).toBe(true);
    // Fullwidth letters fold to ASCII under NFKC.
    expect(hasPayPhrase("Ｐａｙ now")).toBe(true);
    expect(hasPayPhrase("Pay 42,90 €")).toBe(true);
    expect(hasPayPhrase("Ostoskori: vahvista tilaus →")).toBe(true);
  });

  test("a phrase inside another word is not one", () => {
    for (const text of [
      "Payment details",
      "PayPal",
      "Repay",
      "Ostoskori",
      "Lisää ostoskoriin",
      "Köpenhamn",
      "Commandes passées",
      "Add to basket",
      "Proceed to checkout",
      "Siirry maksamaan",
      "",
    ]) {
      expect(hasPayPhrase(text), text).toBe(false);
    }
  });

  test("invisible characters cannot split a phrase out of sight", () => {
    expect(hasPayPhrase("Pa​y now")).toBe(true);
    expect(hasPayPhrase("Con­firm order")).toBe(true);
  });

  test("the list covers each of its six languages", () => {
    expect(PAY_PHRASES.length).toBeGreaterThanOrEqual(17);
    for (const p of PAY_PHRASES) expect(p, p).toBe(p.normalize("NFKC").toLowerCase().trim());
  });

  test("property: a phrase of the list, with any text around it apart by a space, matches", () => {
    const word = fc.stringMatching(/^[a-zA-Z0-9äöå ,.!?-]{0,12}$/);
    fc.assert(
      fc.property(fc.constantFrom(...PAY_PHRASES), word, word, (phrase, a, b) =>
        hasPayPhrase(`${a} ${phrase.toUpperCase()} ${b}`),
      ),
    );
  });

  test("property: a phrase with a letter glued to either end does not match by itself", () => {
    const single = PAY_PHRASES.filter((p) => !p.includes(" "));
    fc.assert(
      fc.property(fc.constantFrom(...single), fc.constantFrom("x", "q", "z"), (phrase, c) => {
        const glued = `${c}${phrase}${c}`;
        // Unless the glued word is itself on the list (none is).
        return !hasPayPhrase(glued);
      }),
    );
  });
});

describe("the total the page states (C7)", () => {
  test.each([
    ["Total 42,90 €"],
    ["Yhteensä 42,90 €"],
    ["Summa: 12.50 EUR"],
    ["Totalt 199 kr"],
    ["Gesamtsumme 42,90 €"],
    ["Importe total: 42,90 €"],
    ["Order total $1,042.90"],
    ["Total€42.90"],
  ])("%s is a total", (text) => {
    expect(isStatedTotal(text)).toBe(true);
  });

  test.each([
    ["Subtotal 40,00 €", "a subtotal is not the total"],
    ["Välisumma 40,00 €", "nor in Finnish"],
    ["Total", "no amount"],
    ["42,90 €", "no total word"],
    ["Total items: 3", "a count, not money"],
  ])("%s is not (%s)", (text) => {
    expect(isStatedTotal(text)).toBe(false);
  });

  test("the quote is the page's text, cleaned, cut at 40 columns", () => {
    expect(statedTotal("  Total\n  42,90 € ")).toBe("Total 42,90 €");
    expect(statedTotal("Total ‮42,90 €")).toBe("Total 42,90 €");
    const long = statedTotal(`Total 42,90 € ${"incl. VAT and shipping ".repeat(4)}`);
    expect(textWidth(/** @type {string} */ (long))).toBe(TOTAL_COLUMNS);
    expect(long?.endsWith("…")).toBe(true);
    expect(statedTotal("Free shipping over 50 €")).toBe(null);
    expect(statedTotal(undefined)).toBe(null);
  });

  test("pageText: NFKC, and control, bidirectional and invisible characters dropped", () => {
    expect(pageText("Ａda​⁦ L\u0007ovelace\n")).toBe("Ada Lovelace");
  });
});

describe("what the child says of a step (checked like any content reply)", () => {
  test("a payment reply: the control's words, and the total before it", () => {
    expect(parsePayInfo({ texts: ["Pay now", "Pay"], total: "Total 42,90 €" })).toEqual({
      texts: ["Pay now", "Pay"],
      total: "Total 42,90 €",
    });
    expect(parsePayInfo({ texts: [] })).toEqual({ texts: [] });
  });

  test("a malformed or oversized payment reply is refused", () => {
    expect(parsePayInfo(null)).toBe(null);
    expect(parsePayInfo({ texts: "Pay" })).toBe(null);
    expect(parsePayInfo({ texts: [1] })).toBe(null);
    expect(parsePayInfo({ texts: ["a", "b", "c", "d", "e"] })).toBe(null);
    expect(parsePayInfo({ texts: ["x".repeat(513)] })).toBe(null);
    expect(parsePayInfo({ texts: [], total: 4 })).toBe(null);
  });

  test("a form's fields: names and values, secrets without one, hidden ones counted", () => {
    const raw = {
      fields: [
        { name: "email", value: "a@example.com" },
        { name: "password", secret: true },
        { name: "photo", file: true },
      ],
      hidden: 2,
      more: 0,
    };
    expect(parseSentFields(raw)).toEqual(raw);
  });

  test("a malformed fields reply is refused, and a secret never carries a value", () => {
    expect(parseSentFields(null)).toBe(null);
    expect(parseSentFields({ fields: [], hidden: -1, more: 0 })).toBe(null);
    expect(parseSentFields({ fields: [{ name: 3 }], hidden: 0, more: 0 })).toBe(null);
    expect(
      parseSentFields({
        fields: [{ name: "pin", secret: true, value: "1234" }],
        hidden: 0,
        more: 0,
      }),
    ).toBe(null);
    expect(
      parseSentFields({ fields: Array(65).fill({ name: "a", value: "" }), hidden: 0, more: 0 }),
    ).toBe(null);
  });
});

// docs/specs/mcp-consequence.md: under a grant a click's form asks by what it sends (K1-K3), and
// `a` allows one button on one site for the rest of the grant (K5).
describe("a consequential form (mcp-consequence K2, K3)", () => {
  /** @param {SentField[]} fields @param {Partial<SentFields>} [rest] @returns {SentFields} */
  const sent = (fields, rest = {}) => ({ fields, hidden: 2, more: 0, ...rest });

  test("a form of hidden fields, numbers and choices is not consequential", () => {
    const basket = sent([
      { name: "qty", value: "2", text: true },
      { name: "qty2", value: " 1,5 ", text: true },
      { name: "size", value: "Large oat drink 1 l" },
      { name: "add", value: "Lisää" },
      { name: "note", value: "", text: true },
    ]);
    expect(isConsequential({ pay: false, sent: basket })).toBe(false);
    expect(isConsequential({ pay: false, sent: sent([]) })).toBe(false);
  });

  test("free text, an identity field, a secret or a file makes it consequential", () => {
    expect(
      isConsequential({ pay: false, sent: sent([{ name: "msg", value: "Hi", text: true }]) }),
    ).toBe(true);
    expect(
      isConsequential({
        pay: false,
        sent: sent([{ name: "zip", value: "00100", identity: true }]),
      }),
    ).toBe(true);
    expect(isConsequential({ pay: false, sent: sent([{ name: "pw", secret: true }]) })).toBe(true);
    expect(isConsequential({ pay: false, sent: sent([{ name: "cv", file: true }]) })).toBe(true);
  });

  test("a value cut to fit, digits in other scripts or forms, or a long number is free text", () => {
    /** @param {object} f */
    const one = (f) =>
      isConsequential({ pay: false, sent: sent([{ name: "m", text: true, ...f }]) });
    expect(one({ value: "1".repeat(1024), cut: true })).toBe(true);
    expect(one({ value: "\u{1D7CF}\u{1D7CF}" })).toBe(true);
    expect(one({ value: "\uFF12" })).toBe(true);
    expect(one({ value: "864213" })).toBe(true);
    expect(one({ value: "1234" })).toBe(true);
    expect(one({ value: "12" })).toBe(false);
    expect(one({ value: "0,5" })).toBe(false);
    expect(
      isConsequential({ pay: false, sent: sent([{ name: "id", value: "x", cut: true }]) }),
    ).toBe(true);
  });

  test("an unknown or overflowing field list is consequential: a doubt asks (K3)", () => {
    expect(isConsequential({ pay: false, sent: null })).toBe(true);
    expect(isConsequential({ pay: false, sent: sent([], { more: 1 }) })).toBe(true);
  });

  test("a payment step is consequential", () => {
    expect(isConsequential({ pay: true, sent: sent([]) })).toBe(true);
  });

  test("a allows only a known form that pays nothing and sends no secret or file (K5)", () => {
    expect(
      mayAllowHere({ pay: false, sent: sent([{ name: "zip", value: "1", identity: true }]) }),
    ).toBe(true);
    expect(mayAllowHere({ pay: true, sent: sent([]) })).toBe(false);
    expect(mayAllowHere({ pay: false, sent: null })).toBe(false);
    expect(mayAllowHere({ pay: false, sent: sent([{ name: "pw", secret: true }]) })).toBe(false);
    expect(mayAllowHere({ pay: false, sent: sent([{ name: "cv", file: true }]) })).toBe(false);
    expect(mayAllowHere({ pay: false, sent: sent([], { more: 3 }) })).toBe(false);
  });

  test("a is not offered for a form with a value cut to fit: it is not known whole (K5)", () => {
    expect(
      mayAllowHere({
        pay: false,
        sent: sent([{ name: "note", value: "x".repeat(1024), text: true, cut: true }]),
      }),
    ).toBe(false);
    expect(
      mayAllowHere({
        pay: false,
        sent: sent([
          { name: "zip", value: "1", identity: true },
          { name: "id", value: "y", cut: true },
        ]),
      }),
    ).toBe(false);
  });

  test("the allowance: site, method, destination without its query, and the button's text", () => {
    const key = (/** @type {object} */ o) =>
      allowanceKey({
        site: "shop.example",
        method: "post",
        action: "https://shop.example/cart/add?id=1",
        text: "Add  to​ basket",
        ...o,
      });
    expect(key({})).toBe(key({ action: "https://shop.example/cart/add?id=2", method: "POST" }));
    expect(key({})).toBe(key({ text: "Add to basket" }));
    expect(key({})).not.toBe(key({ site: "other.example" }));
    expect(key({})).not.toBe(key({ method: "get" }));
    expect(key({})).not.toBe(key({ action: "https://shop.example/cart/remove?id=1" }));
    expect(key({})).not.toBe(key({ action: "http://shop.example/cart/add?id=1" }));
    expect(key({})).not.toBe(key({ text: "Send message" }));
    expect(key({ action: "not a url" })).toBe(null);
    expect(key({ site: "" })).toBe(null);
  });

  test("the child's text and identity marks are checked like the rest", () => {
    const raw = sent([
      { name: "msg", value: "Hi", text: true },
      { name: "email", value: "a@example.com", text: true, identity: true },
    ]);
    expect(parseSentFields(raw)).toEqual(raw);
    // A mark that is not `true` (parseSentFields reads unknown, so no sent() here).
    expect(
      parseSentFields({ fields: [{ name: "a", value: "", text: 1 }], hidden: 2, more: 0 }),
    ).toBe(null);
    expect(
      parseSentFields({ fields: [{ name: "a", value: "", identity: "yes" }], hidden: 2, more: 0 }),
    ).toBe(null);
    const cut = sent([{ name: "m", value: "x", text: true, cut: true }]);
    expect(parseSentFields(cut)).toEqual(cut);
    expect(
      parseSentFields({ fields: [{ name: "a", value: "", cut: 1 }], hidden: 2, more: 0 }),
    ).toBe(null);
  });
});

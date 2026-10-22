// docs/specs/mcp-checkpoints.md: what makes a step a payment step (C5, C6), the total a payment
// question quotes (C7), and the fields a form's question lists (Behaviour 4), in core.
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  PAY_PHRASES,
  TOTAL_COLUMNS,
  hasPayPhrase,
  isPayStep,
  isStatedTotal,
  pageText,
  parsePayInfo,
  parseSentFields,
  statedTotal,
} from "../src/agent-checkpoint.mjs";
import { textWidth } from "../src/textwidth.mjs";

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

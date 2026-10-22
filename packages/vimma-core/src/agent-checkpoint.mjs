/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The agent checkpoints (docs/specs/mcp-checkpoints.md), pure: what makes a step a payment step
 * (C5, C6), the total a payment's question quotes (C7), and the replies the page's child sends
 * for them, checked like any reply from a content process. The browser asks each frame of an
 * agent tab whether it holds a payment card field and the frame of the control for its words and
 * the total before it (actors/agent-fields.mjs); every string here is the page's.
 */

import { FILL_INVISIBLE } from "./agent-act.mjs";
import { truncate } from "./statusbar.mjs";

/**
 * Words on a button that may pay (C6), in English, Finnish, Swedish, German, French and Spanish,
 * matched as whole words, case-insensitively, after NFKC. A fixed list, so the rule is the same
 * in every install: a phrase a checkout uses that is missing here is added for everyone. A phrase
 * that only leads to a checkout ("Buy now" on a product page) asks too; that costs one key.
 */
export const PAY_PHRASES = Object.freeze([
  // English
  "pay",
  "buy",
  "buy now",
  "place order",
  "confirm order",
  "complete order",
  "submit order",
  "complete purchase",
  "confirm purchase",
  // Finnish
  "maksa",
  "osta",
  "tilaa",
  "vahvista tilaus",
  "vahvista maksu",
  "tee tilaus",
  "lähetä tilaus",
  // Swedish
  "betala",
  "köp",
  "slutför köp",
  "slutför köpet",
  "bekräfta köp",
  "bekräfta beställning",
  "beställ",
  // German
  "kaufen",
  "jetzt kaufen",
  "zahlungspflichtig bestellen",
  "kostenpflichtig bestellen",
  "bezahlen",
  "kauf abschließen",
  // French
  "payer",
  "acheter",
  "commander",
  "valider la commande",
  "confirmer la commande",
  // Spanish
  "pagar",
  "comprar",
  "realizar pedido",
  "confirmar pedido",
  "finalizar compra",
]);

/** Words that name a total (C7), in the same languages, matched as the phrases are. */
export const TOTAL_WORDS = Object.freeze([
  "total",
  "totals",
  "amount due",
  "to pay",
  "yhteensä",
  "summa",
  "loppusumma",
  "maksettava",
  "totalt",
  "att betala",
  "gesamt",
  "gesamtsumme",
  "gesamtbetrag",
  "gesamtpreis",
  "endbetrag",
  "summe",
  "montant",
  "à payer",
  "importe",
]);

/** A payment question quotes the page's total cut at this many columns (C7). */
export const TOTAL_COLUMNS = 40;

/** What the child may send of a step (C6, C7, Behaviour 4), in UTF-16 code units. */
export const CHECKPOINT_CAPS = Object.freeze({
  texts: 4,
  text: 512,
  fields: 64,
  name: 512,
  value: 1024,
});

/**
 * Text folded for a match: lower case, and `ß` as `ss`, which is what an upper-case `ß` becomes
 * (`ABSCHLIESSEN`), so a page's capitals never hide a phrase.
 * @param {string} s
 */
const fold = (s) => s.toLowerCase().replace(/ß/g, "ss");

/** A letter or a mark next to a phrase makes it part of another word. */
const LETTER = "[\\p{L}\\p{M}]";
/** @param {string} phrase */
const escape = (phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * One expression for a list: each entry whole, its words apart by any white space.
 * @param {readonly string[]} list
 */
const wholeWords = (list) =>
  new RegExp(
    `(?<!${LETTER})(?:${list.map((p) => fold(p).split(" ").map(escape).join("\\s+")).join("|")})(?!${LETTER})`,
    "u",
  );
const PAY = wholeWords(PAY_PHRASES);
const TOTAL = wholeWords(TOTAL_WORDS);

/** A currency, by symbol or code; a code only as a word of its own. */
const CURRENCY = `(?:[€$£¥]|(?<!${LETTER})(?:kr|sek|nok|dkk|eur|usd|gbp|chf|pln|zł)(?!${LETTER}))`;
/** An amount: digits with thousands apart by a space, dot, comma or apostrophe, and cents. */
const NUMBER = "\\d{1,3}(?:[ .,']\\d{3})*(?:[.,]\\d{1,2})?(?:[.,]-)?|\\d+(?:[.,]\\d{1,2})?";
/** Money: an amount with a currency before or after it, or the Swedish `199:-`. */
const MONEY = new RegExp(`${CURRENCY}\\s?(?:${NUMBER})|(?:${NUMBER})\\s?${CURRENCY}|\\d+:-`, "iu");

/** Control characters, which draw nothing or break the line. */
// eslint-disable-next-line no-control-regex -- the control characters are what it removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Characters that draw nothing (agent-act FILL_INVISIBLE), bidirectional controls among them. */
const INVISIBLE = new RegExp(
  `[${FILL_INVISIBLE.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("")}]`,
  "gu",
);

/**
 * The page's text as a checkpoint reads and shows it (C7; Behaviour 4): NFKC, white space as
 * one space, and control, bidirectional and invisible characters dropped, so that nothing hides
 * a phrase from the match or reorders the question.
 * @param {unknown} s
 */
export function pageText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Whether a control's text, accessible name or value holds a pay phrase (C6).
 * @param {unknown} text
 */
export function hasPayPhrase(text) {
  return PAY.test(fold(pageText(text)));
}

/**
 * Whether a step may pay (C5, C6): the tab's page holds a payment card field in any frame, or the
 * control the step acts on has a pay phrase in any of its words.
 * @param {{ cards: boolean, texts: readonly unknown[] }} signals
 */
export function isPayStep({ cards, texts }) {
  return cards || texts.some(hasPayPhrase);
}

/**
 * Whether an element's text states a total (C7): a total word and an amount of money.
 * @param {unknown} text
 */
export function isStatedTotal(text) {
  const t = fold(pageText(text));
  return TOTAL.test(t) && MONEY.test(t);
}

/**
 * The total as a payment's question quotes it (C7): the page's text, cleaned, cut at
 * TOTAL_COLUMNS; null when it states no total.
 * @param {unknown} text
 * @returns {string | null}
 */
export function statedTotal(text) {
  if (!isStatedTotal(text)) return null;
  return truncate(pageText(text), TOTAL_COLUMNS, "end");
}

/** @param {unknown} v @param {number} max */
const isText = (v, max) => typeof v === "string" && v.length <= max;

/** @param {unknown} v */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The child's words for the control a step acts on (C6) and the text of the total before it
 * (C7), checked: a fresh copy, or null when anything is malformed or over its cap.
 * @param {unknown} raw
 * @returns {{ texts: string[], total?: string } | null}
 */
export function parsePayInfo(raw) {
  if (!isRecord(raw)) return null;
  const v = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(v.texts) || v.texts.length > CHECKPOINT_CAPS.texts) return null;
  if (!v.texts.every((t) => isText(t, CHECKPOINT_CAPS.text))) return null;
  /** @type {{ texts: string[], total?: string }} */
  const out = { texts: /** @type {string[]} */ ([...v.texts]) };
  if (v.total !== undefined) {
    if (!isText(v.total, CHECKPOINT_CAPS.text)) return null;
    out.total = /** @type {string} */ (v.total);
  }
  return out;
}

/**
 * @typedef {{ name: string, value?: string, secret?: true, file?: true }} SentField  one field a
 *   submission sends: its value, or `secret` (a password, card or one-time-code field, whose
 *   value is never read), or `file`
 * @typedef {{ fields: SentField[], hidden: number, more: number }} SentFields  `hidden`: hidden
 *   fields sent but not listed; `more`: fields past the cap
 */

/** @param {unknown} n */
const isCount = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * What a form submission sends (Behaviour 4), as the child read it, checked: a fresh copy, or
 * null when anything is malformed or over its cap, or a secret field carries a value.
 * @param {unknown} raw
 * @returns {SentFields | null}
 */
export function parseSentFields(raw) {
  if (!isRecord(raw)) return null;
  const v = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(v.fields) || v.fields.length > CHECKPOINT_CAPS.fields) return null;
  if (!isCount(v.hidden) || !isCount(v.more)) return null;
  /** @type {SentField[]} */
  const fields = [];
  for (const f of v.fields) {
    if (!isRecord(f)) return null;
    const { name, value, secret, file } = /** @type {Record<string, unknown>} */ (f);
    if (!isText(name, CHECKPOINT_CAPS.name)) return null;
    if (secret !== undefined && secret !== true) return null;
    if (file !== undefined && file !== true) return null;
    if (value !== undefined && (secret || file || !isText(value, CHECKPOINT_CAPS.value))) {
      return null;
    }
    /** @type {SentField} */
    const out = { name: /** @type {string} */ (name) };
    if (secret) out.secret = true;
    else if (file) out.file = true;
    else out.value = typeof value === "string" ? value : "";
    fields.push(out);
  }
  return {
    fields,
    hidden: /** @type {number} */ (v.hidden),
    more: /** @type {number} */ (v.more),
  };
}

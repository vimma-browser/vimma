// Is the page a bot check or a consent wall rather than the site? (docs/specs/site-compat.md,
// "Bot checks, consent walls and IP reputation"). Pure: the probe in checks.mjs collects a
// PageInfo in the tab; this decides. A bot check or a consent wall the run could not get past is
// reported as such, never as a Vimma failure.

/**
 * @typedef {object} PageInfo
 * @property {string} url
 * @property {string} title
 * @property {string} text      document.body.innerText, up to 30 000 characters; bot checks only
 *   look at the first 4000
 * @property {string[]} frames  iframe src URLs
 * @property {string[]} consent selectors of visible consent-manager containers (CONSENT_SELECTORS)
 */
/** @typedef {{ kind: "bot-check" | "consent" | null, reason: string }} Classification */

/**
 * Bot checks, first match wins. Title and text patterns are the interstitials' own wording, so an
 * article about CAPTCHAs does not match.
 * @type {ReadonlyArray<{ reason: string, url?: RegExp, title?: RegExp, text?: RegExp, frame?: RegExp }>}
 */
const BOT_CHECKS = [
  {
    reason: "Cloudflare challenge",
    title: /^(just a moment\.\.\.|attention required! \| cloudflare)$/i,
  },
  { reason: "Cloudflare challenge", frame: /^https:\/\/challenges\.cloudflare\.com\// },
  {
    reason: "Cloudflare challenge",
    text: /\b(verify you are human by completing|checking if the site connection is secure|enable javascript and cookies to continue)\b/i,
  },
  {
    reason: "Google unusual traffic (/sorry/)",
    url: /^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//,
  },
  {
    reason: "Google unusual traffic (/sorry/)",
    text: /our systems have detected unusual traffic from your (computer )?network/i,
  },
  // the challenge frames, not api.js: reCAPTCHA v3 and invisible badges load on ordinary pages
  { reason: "reCAPTCHA", frame: /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)\b/ },
  { reason: "hCaptcha", frame: /^https:\/\/([a-z0-9-]+\.)?hcaptcha\.com\/captcha\// },
  { reason: "Reddit block", text: /whoa there, pardner!/i },
  { reason: "Reddit block", text: /you've been blocked by network security/i },
  { reason: "Reddit block", title: /^blocked$/i },
  { reason: "DuckDuckGo anomaly check", text: /unfortunately, bots use duckduckgo too/i },
  { reason: "Access denied (CDN)", title: /^(access denied|request blocked|403 forbidden)$/i },
];

/** Hosts whose whole page is a consent wall. */
const CONSENT_HOSTS = /^consent\.(google|youtube)\.[a-z.]+$/;
/**
 * Google's and YouTube's consent dialog over the page, in the languages its IP gets: English,
 * Finnish (seen 2026-10-12), German, French. Searched in the whole text: the dialog is often
 * the last thing in the body.
 */
const CONSENT_TEXT =
  /\b(before you continue to (google|youtube)|ennen kuin jatkat (googleen|youtubeen)|bevor sie zu (google|youtube) weitergehen|avant d'accéder à (google|youtube))\b/i;

/**
 * Consent-manager containers the probe looks for (visible ones only): OneTrust, Sourcepoint,
 * Quantcast Choice, Didomi, Google Funding Choices, TrustArc, Cookiebot, Usercentrics.
 */
export const CONSENT_SELECTORS = Object.freeze([
  "#onetrust-banner-sdk",
  "[id^='sp_message_container']",
  "#qc-cmp2-container",
  "#didomi-notice",
  ".fc-consent-root",
  "#truste-consent-track",
  "#CybotCookiebotDialog",
  "#usercentrics-root",
  // YouTube's "Before you continue" lightbox over the page (EU), in its shadow-less Polymer DOM
  "ytd-consent-bump-v2-lightbox tp-yt-paper-dialog",
]);

/**
 * @param {PageInfo} page
 * @returns {Classification}
 */
export function classifyPage(page) {
  let host = "";
  try {
    host = new URL(page.url).hostname;
  } catch {
    // about:neterror and the like: not a block
  }
  const head = page.text.slice(0, 4000);
  for (const check of BOT_CHECKS) {
    if (check.url?.test(page.url)) return { kind: "bot-check", reason: check.reason };
    if (check.title?.test(page.title.trim())) return { kind: "bot-check", reason: check.reason };
    if (check.text?.test(head)) return { kind: "bot-check", reason: check.reason };
    const frame = check.frame;
    if (frame && page.frames.some((f) => frame.test(f)))
      return { kind: "bot-check", reason: check.reason };
  }
  if (CONSENT_HOSTS.test(host)) return { kind: "consent", reason: host };
  const dialog = CONSENT_TEXT.exec(page.text);
  if (dialog) return { kind: "consent", reason: `"${dialog[0]}" dialog` };
  const banner = page.consent[0];
  if (banner) return { kind: "consent", reason: `consent banner (${banner})` };
  return { kind: null, reason: "" };
}

/**
 * Labels of buttons that only refuse: the one kind of consent click the suite makes (never an
 * accept, never a settings page).
 */
const REJECT = [
  /^reject( all)?$/,
  /^decline( all)?$/,
  /^refuse all$/,
  /^(only|use) necessary( cookies)?( only)?$/,
  /^necessary cookies only$/,
  /^hylkää( kaikki)?$/,
  /^alle ablehnen$/,
  /^tout refuser$/,
];

/** REJECT as regexp sources, for the in-page click (probes.mjs contentClickReject). */
export const REJECT_SOURCES = Object.freeze(REJECT.map((r) => r.source));

/** @param {string} label a button's text */
export function isRejectLabel(label) {
  const text = label.trim().toLowerCase().replace(/\s+/g, " ");
  return REJECT.some((r) => r.test(text));
}

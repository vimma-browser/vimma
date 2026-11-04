// Pure reading of probe results for the checks (docs/specs/site-compat.md, decision 5).

/**
 * @typedef {{ top: number, max: number }} Scroller
 * @typedef {{ key: string, top: number, max: number, area: number }} InnerScroller
 * @typedef {{ main: Scroller, inner: InnerScroller[] }} ScrollSnapshot
 */

/** @param {ScrollSnapshot} s */
export function canScroll(s) {
  return s.main.max > 0 || s.inner.some((i) => i.max > 0);
}

/**
 * Which scroller moved between two snapshots, and which way. Inner scrollers are matched by key;
 * one that was not there before is not a move.
 * @param {ScrollSnapshot} before
 * @param {ScrollSnapshot} after
 * @returns {{ moved: "down" | "up" | "none", where: string | null, by: number }}
 */
export function scrollMovement(before, after) {
  /** @type {Array<{ where: string, by: number }>} */
  const moves = [{ where: "main", by: after.main.top - before.main.top }];
  const old = new Map(before.inner.map((i) => [i.key, i.top]));
  for (const i of after.inner) {
    const was = old.get(i.key);
    if (was !== undefined) moves.push({ where: i.key, by: i.top - was });
  }
  const best = moves.reduce((a, b) => (Math.abs(b.by) > Math.abs(a.by) ? b : a));
  if (Math.abs(best.by) < 1) return { moved: "none", where: null, by: 0 };
  return { moved: best.by > 0 ? "down" : "up", where: best.where, by: best.by };
}

/**
 * @typedef {{ label: string, href: string | null, target?: string, sameDoc?: boolean,
 *   sameOrigin?: boolean, attrs?: Record<string, string | null> }} HintLink
 */

/** Roles under which a link's click is a widget's, not a navigation. */
const WIDGET_ROLES = new Set(["button", "menuitem", "menuitemcheckbox", "menuitemradio", "tab"]);

/**
 * A link that acts as a button: its click handler opens a menu or toggles something and the URL
 * stays, such as Google's "Google apps" launcher (`<a href role="button" aria-expanded>`).
 * @param {HintLink} l
 */
function actsAsButton(l) {
  const a = l.attrs ?? {};
  const set = (/** @type {string} */ name) => a[name] != null && a[name] !== "false";
  return (
    WIDGET_ROLES.has((a.role ?? "").trim().toLowerCase()) ||
    set("aria-haspopup") ||
    a["aria-expanded"] != null ||
    a["aria-pressed"] != null
  );
}

/**
 * The hint to follow: a link that opens another document in the same tab, same-origin first.
 * Links that act as buttons are skipped, as their click does not navigate.
 * @param {HintLink[]} links
 * @returns {HintLink | null}
 */
export function chooseHintLink(links) {
  const followable = links.filter(
    (l) =>
      l.href &&
      /^https?:/.test(l.href) &&
      !l.sameDoc &&
      (l.target === "" || l.target === "_self" || l.target === "_top") &&
      !actsAsButton(l),
  );
  return followable.find((l) => l.sameOrigin) ?? followable[0] ?? null;
}

/**
 * @typedef {{ url: string, active: string, scrollY: number, dialogs: number,
 *   fullscreen: boolean }} Reaction
 */

/**
 * What the site did with a key pressed in pass-through mode, or null.
 * @param {Reaction} before
 * @param {Reaction} after
 * @param {string[]} prevented keys the page's handlers called preventDefault() on
 * @returns {"navigate" | "fullscreen" | "dialog" | "focus" | "scroll" | "handled" | null}
 */
export function reactionOf(before, after, prevented) {
  if (after.url !== before.url) return "navigate";
  if (after.fullscreen !== before.fullscreen) return "fullscreen";
  if (after.dialogs !== before.dialogs) return "dialog";
  // Focus falling back to the document is a blur (a field losing focus), not the site's doing.
  if (after.active !== before.active && !/^(BODY|HTML)#/.test(after.active)) return "focus";
  if (after.scrollY !== before.scrollY) return "scroll";
  if (prevented.length) return "handled";
  return null;
}

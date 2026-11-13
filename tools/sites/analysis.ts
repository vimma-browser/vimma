// Pure reading of probe results for the checks (docs/specs/site-compat.md, decision 5).

export type Scroller = { top: number; max: number };
export type InnerScroller = { key: string; top: number; max: number; area: number };
export type ScrollSnapshot = { main: Scroller; inner: InnerScroller[] };

export function canScroll(s: ScrollSnapshot) {
  return s.main.max > 0 || s.inner.some((i) => i.max > 0);
}

/**
 * Which scroller moved between two snapshots, and which way. Inner scrollers are matched by key;
 * one that was not there before is not a move.
 */
export function scrollMovement(
  before: ScrollSnapshot,
  after: ScrollSnapshot,
): { moved: "down" | "up" | "none"; where: string | null; by: number } {
  const moves: Array<{ where: string; by: number }> = [
    { where: "main", by: after.main.top - before.main.top },
  ];
  const old = new Map(before.inner.map((i) => [i.key, i.top]));
  for (const i of after.inner) {
    const was = old.get(i.key);
    if (was !== undefined) moves.push({ where: i.key, by: i.top - was });
  }
  const best = moves.reduce((a, b) => (Math.abs(b.by) > Math.abs(a.by) ? b : a));
  if (Math.abs(best.by) < 1) return { moved: "none", where: null, by: 0 };
  return { moved: best.by > 0 ? "down" : "up", where: best.where, by: best.by };
}

export type HintLink = {
  label: string;
  href: string | null;
  target?: string;
  sameDoc?: boolean;
  sameOrigin?: boolean;
  attrs?: Record<string, string | null>;
};

/** Roles under which a link's click is a widget's, not a navigation. */
const WIDGET_ROLES = new Set(["button", "menuitem", "menuitemcheckbox", "menuitemradio", "tab"]);

/**
 * A link that acts as a button: its click handler opens a menu or toggles something and the URL
 * stays, such as Google's "Google apps" launcher (`<a href role="button" aria-expanded>`).
 */
function actsAsButton(l: HintLink) {
  const a = l.attrs ?? {};
  const set = (name: string) => a[name] != null && a[name] !== "false";
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
 */
export function chooseHintLink(links: HintLink[]): HintLink | null {
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

export type Reaction = {
  url: string;
  active: string;
  scrollY: number;
  dialogs: number;
  fullscreen: boolean;
};

/**
 * What the site did with a key pressed in pass-through mode, or null.
 * @param prevented keys the page's handlers called preventDefault() on
 */
export function reactionOf(
  before: Reaction,
  after: Reaction,
  prevented: string[],
): "navigate" | "fullscreen" | "dialog" | "focus" | "scroll" | "handled" | null {
  if (after.url !== before.url) return "navigate";
  if (after.fullscreen !== before.fullscreen) return "fullscreen";
  if (after.dialogs !== before.dialogs) return "dialog";
  // Focus falling back to the document is a blur (a field losing focus), not the site's doing.
  if (after.active !== before.active && !/^(BODY|HTML)#/.test(after.active)) return "focus";
  if (after.scrollY !== before.scrollY) return "scroll";
  if (prevented.length) return "handled";
  return null;
}

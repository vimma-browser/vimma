/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For the promo recorder (tools/promo/record.ts): on <page>#probe, work out the hint label
// Vimma will give the link marked data-promo="target", with vimma-core's own hints.mjs (the
// recorder serves a copy of it next to the fixtures), and title the page `probe:<label>`, or
// `probe-error:<why>`. The page has links and nothing else clickable, so the links in the
// viewport are exactly Vimma's hint targets; a link cut by the viewport's edge makes the count
// uncertain, so it is refused rather than guessed. A `z` (no Vimma binding, so the page gets
// it) then loads the page again without the fragment. Without #probe it does nothing.
import { hintLabels, orderTargets } from "./hints.js";

if (location.hash === "#probe") {
  const report = () => {
    const targets = [];
    let target = null;
    let clipped = 0;
    for (const a of document.querySelectorAll("a[href]")) {
      const r = a.getClientRects()[0];
      if (!r || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth)
        continue;
      if (r.top < 0 || r.bottom > innerHeight) clipped++;
      const t = { rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
      if (a.dataset.promo === "target") target = t;
      targets.push(t);
    }
    if (!target) return "probe-error:the target link is not in the viewport";
    if (clipped) return `probe-error:${clipped} link(s) cross the viewport's edge`;
    const ordered = orderTargets(targets);
    const label = hintLabels(ordered.length)[ordered.indexOf(target)];
    const { x, y, width, height } = target.rect;
    const sx = Math.round((mozInnerScreenX + x + width / 2) * devicePixelRatio);
    const sy = Math.round((mozInnerScreenY + y + height / 2) * devicePixelRatio);
    return `probe:${label}@${sx},${sy}`;
  };
  if (document.readyState === "complete") document.title = report();
  else addEventListener("load", () => (document.title = report()));
  addEventListener("keydown", (e) => {
    if (e.key === "z") location.replace(location.pathname);
  });
}

// The readable reports of a site-compatibility run (docs/specs/site-compat.md, decision 8):
// Markdown (also the workflow's job summary) and a self-contained HTML page whose screenshots
// sit next to it. Pure. Site titles and reasons come from live pages, so both escape them.
import { CHECKS, summarize } from "./results.mjs";

/** @typedef {import("./results.mjs").Run} Run */
/** @typedef {import("./results.mjs").SiteResult} SiteResult */
/** @typedef {import("./results.mjs").CheckResult} CheckResult */

const SYMBOL = /** @type {const} */ ({ pass: "✓", fail: "✗", skip: "–", info: "i" });
const LEGEND = "✓ pass · ✗ fail · – skipped · i info";
const LATENCY_KEYS = /** @type {const} */ (["j", "f"]);

/** @param {SiteResult["status"]} status */
const statusLabel = (status) => (status === "blocked" ? "blocked (bot check)" : status);

/** @param {Run} run */
const networkLabel = (run) =>
  run.network === "github-hosted" ? "GitHub-hosted runner" : "local network";

/** @param {Run} run */
export function summaryLine(run) {
  const s = summarize(run.sites).sites;
  return (
    `${s.total} sites: ${s.ok} ok, ${s.fail} fail, ${s.blocked} blocked (bot check), ` +
    `${s.consent} consent, ${s.error} error.`
  );
}

/** Escapes what would break a Markdown table cell or become HTML. @param {string} text */
export function md(text) {
  return String(text)
    .replace(/[\\|<>[\]`*_]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ");
}

/** @param {number | undefined} n */
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "");

/** @param {SiteResult} site @returns {string[]} the keys the site reacted to */
function shortcutKeys(site) {
  const keys = site.checks.find((c) => c.id === "shortcuts")?.details?.keys;
  return Array.isArray(keys) ? keys.map(String) : [];
}

/**
 * @param {Run} run
 * @returns {string}
 */
export function renderMarkdown(run) {
  const date = run.startedAt.slice(0, 10);
  const out = [`## Site compatibility, ${date} (${networkLabel(run)})`, "", summaryLine(run), ""];
  if (run.harnessError) out.push(`**The harness failed:** ${md(run.harnessError)}`, "");
  const header = ["Site", "Status", ...CHECKS, "Load ms", ...LATENCY_KEYS.map((k) => `${k} ms`)];
  out.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
  for (const site of run.sites) {
    const cells = CHECKS.map((id) => {
      const c = site.checks.find((x) => x.id === id);
      return c ? SYMBOL[c.status] : "";
    });
    const row = [
      `[${md(site.name)}](${site.url})`,
      statusLabel(site.status),
      ...cells,
      num(site.loadMs),
      ...LATENCY_KEYS.map((k) => num(site.latency[k])),
    ];
    out.push(`| ${row.join(" | ")} |`);
  }
  out.push("", LEGEND, "");

  const failures = run.sites.flatMap((site) => [
    ...(site.error ? [`- **${md(site.name)}**, harness: ${md(site.error)}`] : []),
    ...site.checks
      .filter((c) => c.status === "fail")
      .map((c) => `- **${md(site.name)}**, ${c.id}: ${md(c.reason ?? "")}`),
  ]);
  if (failures.length) out.push("### Failures", "", ...failures, "");

  const blocked = run.sites
    .filter((s) => s.block)
    .map((s) => {
      const kind = s.block?.kind === "bot-check" ? "blocked (bot check)" : "consent";
      return `- ${md(s.name)}: ${kind}, ${md(s.block?.reason ?? "")}`;
    });
  if (blocked.length) out.push("### Blocked and consent", "", ...blocked, "");

  const retried = run.sites
    .filter((s) => s.retry)
    .map(
      (s) =>
        `- ${md(s.name)}: ${statusLabel(s.retry?.status ?? "error")}, ` +
        `then ${statusLabel(s.status)} on the retry`,
    );
  if (retried.length) {
    out.push(
      "### Retried",
      "",
      "Sites a bot check blocked, loaded once more at the end of the run.",
      "",
      ...retried,
      "",
    );
  }

  const conflicts = run.sites
    .filter((s) => shortcutKeys(s).length)
    .map((s) => `- ${md(s.name)}: ${shortcutKeys(s).map(md).join(", ")}`);
  if (conflicts.length) {
    out.push(
      "### Site shortcuts Vimma's normal mode takes (info)",
      "",
      "Keys the page reacted to when sent to it directly; in normal mode Vimma takes them first.",
      "",
      ...conflicts,
      "",
    );
  }

  const latency = run.sites
    .filter((s) => Object.keys(s.latency).length)
    .map(
      (s) =>
        `- ${md(s.name)}: ${Object.entries(s.latency)
          .map(([k, v]) => `${k} ${num(v)} ms`)
          .join(", ")}`,
    );
  if (latency.length) {
    out.push(
      "### Key-to-effect latency",
      "",
      "From the vimma-ctl call to the effect seen by a 10 ms poll: an upper bound.",
      "",
      ...latency,
      "",
    );
  }
  out.push(
    `Build: \`${md(run.build)}\`${run.commit ? `, commit ${md(run.commit)}` : ""}. ` +
      `${run.startedAt} to ${run.finishedAt}.`,
    "",
  );
  return out.join("\n");
}

/** @param {unknown} text */
function html(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @param {string} file a screenshot's file name (ours, from the site id) */
const shot = (file) => `screenshots/${encodeURIComponent(file)}`;

const STYLE = `
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --pass: #1a7f37;
  --fail: #cf222e; --skip: #8c959f; --info: #0969da; --head: #f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1;
    --line: #3d444d; --pass: #3fb950; --fail: #f85149; --skip: #6e7681; --info: #4493f8;
    --head: #151b23; }
}
:root[data-theme="dark"] { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d;
  --pass: #3fb950; --fail: #f85149; --skip: #6e7681; --info: #4493f8; --head: #151b23; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: center; white-space: nowrap; }
th { background: var(--head); font-weight: 600; }
td:first-child, th:first-child { text-align: left; }
.pass { color: var(--pass); } .fail { color: var(--fail); font-weight: 700; }
.skip { color: var(--skip); } .info { color: var(--info); }
.muted { color: var(--muted); }
a { color: var(--info); }
details { border-bottom: 1px solid var(--line); padding: 8px 0; }
details img { max-width: 100%; border: 1px solid var(--line); margin: 4px 0; }
code { font-size: 12px; }
`;

/**
 * @param {Run} run
 * @returns {string}
 */
export function renderHtml(run) {
  const head = ["Site", "Status", ...CHECKS, "Load ms", ...LATENCY_KEYS.map((k) => `${k} ms`)]
    .map((h) => `<th>${html(h)}</th>`)
    .join("");
  const rows = run.sites
    .map((site) => {
      const cells = CHECKS.map((id) => {
        const c = site.checks.find((x) => x.id === id);
        if (!c) return "<td></td>";
        const title = `${id}: ${c.reason ?? c.status}`;
        return `<td class="${c.status}" title="${html(title)}">${SYMBOL[c.status]}</td>`;
      }).join("");
      const lat = LATENCY_KEYS.map((k) => `<td>${num(site.latency[k])}</td>`).join("");
      return (
        `<tr><td><a href="${html(site.url)}">${html(site.name)}</a></td>` +
        `<td>${html(statusLabel(site.status))}</td>${cells}<td>${num(site.loadMs)}</td>${lat}</tr>`
      );
    })
    .join("\n");
  const details = run.sites
    .map((site) => {
      const checks = site.checks
        .map(
          (c) =>
            `<li><span class="${c.status}">${SYMBOL[c.status]} ${html(c.id)}</span>` +
            `${c.reason ? `: ${html(c.reason)}` : ""}` +
            `${c.details ? ` <code class="muted">${html(JSON.stringify(c.details))}</code>` : ""}</li>`,
        )
        .join("");
      const shots = site.screenshots
        .map(
          (s) =>
            `<figure><a href="${shot(s.file)}"><img src="${shot(s.file)}" alt="${html(site.name)}: ${html(s.label)}" loading="lazy"></a>` +
            `<figcaption class="muted">${html(s.label)}</figcaption></figure>`,
        )
        .join("");
      const extra = [
        site.block ? `${html(site.block.kind)}: ${html(site.block.reason)}` : "",
        site.error ? `harness: ${html(site.error)}` : "",
        site.retry ? `retried: ${html(statusLabel(site.retry.status))} at first` : "",
        site.finalUrl && site.finalUrl !== site.url ? `ended at ${html(site.finalUrl)}` : "",
        `${Math.round(site.durationMs / 1000)} s`,
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        `<details><summary><strong>${html(site.name)}</strong> ` +
        `<span class="muted">${html(statusLabel(site.status))}</span></summary>` +
        `<p class="muted">${extra}</p><ul>${checks}</ul>${shots}</details>`
      );
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site compatibility</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Site compatibility</h1>
<p>${html(run.startedAt.slice(0, 10))}, ${html(networkLabel(run))}. ${html(summaryLine(run))}</p>
${run.harnessError ? `<p class="fail">The harness failed: ${html(run.harnessError)}</p>` : ""}
<div class="wrap"><table><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table></div>
<p class="muted">${html(LEGEND)}. Hover a cell for its reason. Latency: from the vimma-ctl call to the effect seen by a 10 ms poll.</p>
<h2>Sites</h2>
${details}
<p class="muted">Build <code>${html(run.build)}</code>${run.commit ? `, commit ${html(run.commit)}` : ""}. ${html(run.startedAt)} to ${html(run.finishedAt)}.</p>
</main>
</body>
</html>
`;
}

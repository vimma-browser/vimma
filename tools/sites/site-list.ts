// The site list (tools/sites/sites.json; docs/specs/site-compat.md, decision 9): its shape and
// the --filter.

/**
 * @typedef {object} Site
 * @property {string} id      lowercase letters, digits and dashes; screenshot names use it
 * @property {string} name
 * @property {string} url     https only: loaded once, never crawled
 * @property {string} [search] CSS selector of the site's search field (else the first visible one)
 * @property {string} [find]   a word on the page for `/` (else one from the visible text)
 * @property {string} [notes]
 */

const FIELDS = new Set(["id", "name", "url", "search", "find", "notes"]);

/** @param {unknown} url */
function isHttps(url) {
  try {
    return typeof url === "string" && new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {unknown} list
 * @returns {string[]} problems, empty when valid
 */
export function validateSites(list) {
  if (!Array.isArray(list)) return ["the site list must be an array"];
  /** @type {string[]} */
  const errors = [];
  const seen = new Set();
  list.forEach((entry, i) => {
    const e = /** @type {Record<string, unknown>} */ (entry ?? {});
    const at = `entry ${i} (${String(e.id)})`;
    if (typeof e.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id))
      errors.push(`${at}: id must be lowercase letters, digits and dashes`);
    else if (seen.has(e.id)) errors.push(`${at}: duplicate id`);
    seen.add(e.id);
    if (typeof e.name !== "string" || !e.name.trim())
      errors.push(`${at}: name must be a non-empty string`);
    if (!isHttps(e.url)) errors.push(`${at}: url must be https`);
    for (const key of Object.keys(e))
      if (!FIELDS.has(key)) errors.push(`${at}: unknown field ${key}`);
    if ("search" in e && (typeof e.search !== "string" || !e.search.trim()))
      errors.push(`${at}: search must be a CSS selector string`);
    if ("find" in e && (typeof e.find !== "string" || !/^[A-Za-z0-9]+$/.test(e.find)))
      errors.push(`${at}: find must be one word of letters and digits`);
    if ("notes" in e && typeof e.notes !== "string") errors.push(`${at}: notes must be a string`);
  });
  return errors;
}

/**
 * Sites whose id or name contains any of the comma-separated terms (case-insensitive).
 * @template {{ id: string, name: string }} T
 * @param {T[]} sites
 * @param {string | undefined} filter
 * @returns {T[]}
 */
export function filterSites(sites, filter) {
  const terms = (filter ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) return sites;
  return sites.filter((s) =>
    terms.some((t) => s.id.toLowerCase().includes(t) || s.name.toLowerCase().includes(t)),
  );
}

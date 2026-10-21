/**
 * commitlint plugin for Vimma (CONTRIBUTING.md: the subject is the changelog line; the body explains
 * why).
 *
 * Rule `body-required-for-types`: commits of the listed types must have a non-empty body. Usage:
 * `"body-required-for-types": [2, "always", ["feat", "fix", "revert"]]`.
 * Footers and trailers do not count as a body: `Closes #3`, `BREAKING CHANGE: …`,
 * `Co-Authored-By: …` are parsed into the footer, so `feat: x` + only footers fails.
 * A git-style `Revert "feat: x"` / `Reapply "…"` header counts as type `revert`.
 */

const GIT_REVERT = /^(Revert|Reapply) "/;
const TRAILER = /^(BREAKING[ -]CHANGE|[A-Za-z][\w-]*)(: | #)/;
/**
 * The header Dependabot writes with the prefixes in .github/dependabot.yml. Its `Bump` is
 * capitalised or lower-case depending on Dependabot's version, its titles can pass 100 columns,
 * and its body holds release notes over 100 columns; none of it is configurable.
 */
const DEPENDABOT_HEADER = /^(build|ci)\(deps(-dev)?\): [Bb]ump \S/;

/**
 * @param {{ type?: string | null, header?: string | null, body?: string | null }} parsed
 * @param {"always" | "never"} [when]
 * @param {string[]} [types]
 * @returns {[boolean, string?]}
 */
export function bodyRequiredForTypes(parsed, when = "always", types = []) {
  const type = parsed.type || (GIT_REVERT.test(parsed.header ?? "") ? "revert" : null);
  if (when !== "always" || !type || !types.includes(type)) return [true];
  if ((parsed.body ?? "").trim() !== "") return [true];
  return [
    false,
    `${type} commits need a body: it is the changelog line (types: ${types.join(", ")})`,
  ];
}

/**
 * Replaces commitlint's default ignores (set `defaultIgnores: false`). Those skip every
 * `Revert "…"` commit, which would let a body-less revert through; here a git-style revert is
 * skipped only when it has a body (git writes "This reverts commit …"). Merges and
 * fixup!/squash!/amend! commits stay ignored. Dependabot's commits, and the squash of its pull
 * requests (title and body), are skipped when the header is Dependabot's and the body names it
 * (its `Signed-off-by` trailer, or the PR description's "Dependabot will resolve…").
 * @param {string} message
 */
export function ignoreCommit(message) {
  const [header = "", ...rest] = message.split("\n");
  if (/^(Merge (pull request|branch|tag|remote-tracking branch)|Merge .+ into )/.test(header)) {
    return true;
  }
  if (/^(amend|fixup|squash)!/.test(header)) return true;
  if (DEPENDABOT_HEADER.test(header) && /\bdependabot\b/i.test(rest.join("\n"))) return true;
  if (GIT_REVERT.test(header)) {
    return rest.some((line) => line.trim() !== "" && !TRAILER.test(line));
  }
  return false;
}

export default {
  rules: { "body-required-for-types": bodyRequiredForTypes },
};

/**
 * Where Vimma lives on GitHub. Workflow guards (`github.repository == '…'`), the site dispatch,
 * packaging metadata and the signing identity all name these; tools/test/repo.test.mjs checks
 * that they agree, so moving the repository again is a change to these constants plus the
 * strings the test points at.
 */

/** The canonical repository: forks skip every job guarded by it. */
export const REPO = "vimma-browser/vimma";

/** The website's repository, which rebuilds its key list on a repository_dispatch. */
export const SITE_REPO = "vimma-browser/vimma-site";

/**
 * The maintainer's personal GitHub login. The repository owner is an organization, which can
 * neither be @-mentioned nor label an issue, so the Claude spec gate and the autopilot's
 * mentions name this person instead of `github.repository_owner`.
 */
export const MAINTAINER = "JRanne";

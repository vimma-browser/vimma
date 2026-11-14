### The GitHub organization

The repositories live in the `vimma-browser` organization: `vimma-browser/vimma` (public, the
browser) and `vimma-browser/vimma-site` (private, vimma.dev). Its owner is the maintainer,
`JRanne`. Sponsorship stays on the maintainer's personal GitHub Sponsors account
(`.github/FUNDING.yml`), and the roadmap board is a project of that personal account.

`tools/repo.mjs` names the canonical repository, the site's repository and the maintainer's
login; `tools/test/repo.test.mjs` checks that every `github.repository == '…'` guard, the site
dispatch, the signing identity and the published URLs agree with it. Forks skip every guarded
job. An organization cannot be @-mentioned or add a label as a person, so the `claude:go` gate
and the upstream workflows' mentions name the maintainer's login, not
`github.repository_owner`.

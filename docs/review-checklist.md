# Review checklist

Posted on every PR by the reviewer (a fresh agent session with the spec open, then the
maintainer). Plan §4, step 5. Each item is ticked, or answered "n/a" with a reason.

- [ ] A spec exists (`docs/specs/<name>.md`) and the PR stays inside its scope. The PR is ready to
      merge: nothing in it waits on an open question (those go in the feature's issue).
- [ ] A new or edited spec meets `docs/specs/README.md`: every template section, verified facts with
      sources, and no process residue (who asked, when, quoted chat, agent notes).
- [ ] The tests prove the behaviour in the spec's acceptance criteria. They were written first,
      and the PR or spec shows the red run and then the green run.
- [ ] No test was weakened: no loosened assertion, removed case or new skip without a reason.
- [ ] No new action without a docs line: `npm run gen-docs` was run and `docs/bindings.md` is
      current.
- [ ] A feature that is not finished in this PR is behind `pref("vimma.feature.<name>", false)`;
      the PR that finishes it removes the pref (`CONTRIBUTING.md`, "Unfinished features").
- [ ] A config schema change comes with a migration and a new contract fixture pair.
- [ ] No new upstream `.patch` without a line in ADR-003's patch register. Boundary changes have
      an ADR.
- [ ] No new dependency without a licence check and a PR line (`npm run license-check`).
- [ ] No snapshot or screenshot baseline changed without a commit body explaining why.
- [ ] Touches `*.patch`, `configs/`, `moz.configure` or branding → a full-build mochitest run is
      reported (ADR-010).
- [ ] User-visible change → update `docs/guide.md` (and its "Features at a glance" or the README status if it changes what works).
- [ ] A change to `tools/upstream/mozilla-release-key.asc` or `PINNED_FINGERPRINT` in
      `tools/upstream/verify-sha512.py` cites Mozilla's announcement and keeps every revocation
      (ADR-021; `docs/runbook.md`, "Mozilla's release key"), and gets the
      `key-rotation-approved` label only after that check.
- [ ] Every commit is a Conventional Commit with a body. The subject is the changelog line; the body
      explains why.

### vimma.dev's keys (`site-dispatch.yml`, spec site-keys-mirror)

`npm run gen-docs` writes `docs/bindings.json`, which vimma.dev mirrors on its keys page and in
its `?` overlay. A push to `main` that changes it sends a `repository_dispatch`
(`vimma-bindings`) to vimma-browser/vimma-site, whose workflow fetches the file at that commit and opens
a pull request. Publishing a release (not a pre-release) sends `vimma-release`, and the site's
`release-sync.yml` syncs the latest published release at once instead of at its scheduled run.
It authenticates as the org's GitHub App **vimma-site-dispatch** (Organization settings →
Developer settings → GitHub Apps), installed on vimma-browser/vimma-site only with "Contents: read
and write": the variable `SITE_DISPATCH_APP_ID` holds its client ID and the secret
`SITE_DISPATCH_APP_KEY`, of the `site-dispatch` environment, its private key, and each run mints a
one-hour token. Nothing expires. The key can push to vimma-site's auto-merging release-sync
branches, so only `main`'s copy of the workflow may read it (docs/security/14-build-and-release-supply-chain.md, B15): a published
release only starts `site-dispatch.yml` on `main` with `release=true`, and the `site-dispatch`
environment's only deployment policy is the branch `main`. Setup, and moving the key out of the
repository's secrets:

```sh
# 1. The environment, deployable only from main (already created).
gh api -X PUT repos/vimma-browser/vimma/environments/site-dispatch \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/vimma-browser/vimma/environments/site-dispatch/deployment-branch-policies \
  -f name=main -f type=branch
# 2. The key as an environment secret.
gh secret set SITE_DISPATCH_APP_KEY --env site-dispatch < key.pem
# 3. Delete the repository secret, so no tag's or branch's copy can read it.
gh secret delete SITE_DISPATCH_APP_KEY
```

A repository secret's value cannot be read back, so step 2 needs the `.pem`: generate a new key on
the app's page if it is not at hand. Generate one and delete the old key there too if the old
repository secret should be considered exposed (it was readable by any tag's or branch's copy of a
workflow). To rotate the key, generate a new one on the app's page,
`gh secret set SITE_DISPATCH_APP_KEY --env site-dispatch < new-key.pem`, then delete the old key
there. Without the variable or the key the token step fails and the run goes red. Re-send by hand with
`gh workflow run site-dispatch.yml --ref main` (`-f release=true` for a release); from any other
ref the dispatch job does not run.

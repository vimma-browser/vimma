### Google Safe Browsing key (spec m0-safebrowsing-key)

Safe Browsing's phishing, malware and download lists need a Google API key compiled into the
build. `configs/common/mozconfig` passes it to configure only when the key file exists:
`$VIMMA_SAFEBROWSING_KEYFILE` if set (it must then name a file), else
`~/.config/vimma/keys/safebrowsing`. Without one the build is keyless and Vimma defaults Safe
Browsing off, so Settings shows it unticked. The key is a secret: never echo, log or commit it.

Get a key: Google Cloud console → a project → enable the **Safe Browsing API** → Credentials →
Create API key → restrict it to that API. Its use is free but non-commercial, and every keyed
build shares the one key and its per-project quota (Google Cloud console → Quotas); a large user
base or commercial use needs a quota increase or Google's Web Risk API. The key is compiled into
the binaries and can be extracted from them, as Firefox's own is. Google serves the download
lists (`goog-badbinurl-proto`, `goog-downloadwhite-proto`) and the remote download check only to
Mozilla's key, so Vimma requests neither. `goog-harmful-proto` is requested but did not arrive
when the key was tested; treat it as unavailable.

**Locally**, store it without it reaching the terminal or the shell history, then rebuild:

```sh
mkdir -p ~/.config/vimma/keys && chmod 700 ~/.config/vimma/keys
( umask 077; read -rs -p "Safe Browsing API key: " k; echo
  printf '%s' "$k" > ~/.config/vimma/keys/safebrowsing )
npm run import && (cd engine && ./mach build)   # the key is a configure input: full build
tools/safebrowsing-smoke/safebrowsing-smoke.sh   # needs the network; prints table names and sizes
```

The local artifact build copies the same mozconfig, so it is keyed too (rebuild it with
`node tools/artifact-build/artifact-build.mjs`). `npm run mochitest` passes
`VIMMA_EXPECT_SAFEBROWSING_KEY=1` when the key file exists, so a stale keyless build fails
`browser_vimma_safebrowsing.js`; set `VIMMA_EXPECT_SAFEBROWSING_KEY=0` to test a keyless build
on purpose.

**In CI**, the key is the secret `SAFEBROWSING_API_KEY` of the `build` environment, which only
`main` may deploy from (no tag: anyone who can push a tag could otherwise deploy an edited
workflow from it); only the `build` jobs of `nightly.yml` and `release.yml`
name that environment (docs/security/14-build-and-release-supply-chain.md, B6). A repository administrator sets it up once, in
this order (until step 3, the jobs keep reading the old repository secret, so nothing breaks):

```sh
R=repos/vimma-browser/vimma
# 1. The environment, deployable only from main.
gh api -X PUT $R/environments/build --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/build/deployment-branch-policies -f name=main -f type=branch
# 2. The key as an environment secret.
gh secret set SAFEBROWSING_API_KEY --env build < ~/.config/vimma/keys/safebrowsing
# 3. Delete the repository secret, so no other job can read it.
gh secret delete SAFEBROWSING_API_KEY
# Check: the environment holds the key, the repository does not.
gh secret list --env build                  # SAFEBROWSING_API_KEY
gh secret list | grep SAFEBROWSING || echo "no repository secret: done"
```

An environment secret takes precedence over a repository secret of the same name, so steps 1
and 2 can come before or after the workflow change; step 3 comes after step 2. `nightly.yml` writes it to a mode-600
file in `$RUNNER_TEMP` and deletes it after its last `mach` call. PR builds (`e2e.yml`) never get
it: they build keyless, which `browser_vimma_safebrowsing.js` checks. `release.yml`'s `build` job
does the same as the nightly, and its smoke check fails a release built without the key.

Debugging: `browser.safebrowsing.debug` = `true` logs list updates to stdout, with the key
replaced by `[trimmed-google-api-key]`. Still check before pasting a log anywhere.

**Forks:** the nightly and release builds fail closed without `SAFEBROWSING_API_KEY`. Set your
own key as a secret of a `build` environment in your fork (the steps above, with your
repository's name), or remove the key step (your builds then ship keyless, with Safe
Browsing honestly off).

**Rotate** (quota trouble or abuse; the key is extractable from every binary by design, so a
"leak" alone is no reason): create the new key in the console, replace the local file
(the `read -rs` line above) and the secret (`gh secret set --env build` as above), rebuild and run the smoke
script, then delete the old key in the console. Builds already shipped keep the old key and
stop getting lists once it is deleted, so rotate before a release, not after.

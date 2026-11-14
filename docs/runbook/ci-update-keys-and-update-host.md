### Update signing keys and the update host (spec m6a-updater)

Vimma checks `https://updates.vimma.dev/updates/browser/<target>/<channel>/update.xml`
(`Linux_x86_64-gcc3`, or `Darwin_aarch64-gcc3` on Apple Silicon) every 12 hours and accepts only a manifest signed by a key pinned in
`packages/vimma-core/src/updates/update-keys.mjs` (step 5; a build with no pinned key refuses every
manifest and shows nothing). These steps need the maintainer's accounts; do them once, in order.
All steps but 4 (the offline secondary key) are done. Step 7 sets up `update-publish.yml`, which
signs and publishes a manifest for every published release; nothing is published while the
repository variable `UPDATES_ENABLED` is not `true`. It is `true`, so update notices are on for
every install of 0.1.2 or later (0.1.1 pins no key and never shows one). Step 8, the MAR that
`release.yml` signs through the same workflow, needs no setup of its own.

**1. The manifest repository** (decision 18): it holds only manifests.

```sh
gh repo create vimma-browser/vimma-updates --public \
  --description "Signed update manifests for Vimma, served at updates.vimma.dev"
git clone git@github.com:vimma-browser/vimma-updates.git && cd vimma-updates
mkdir -p public/updates
cat > wrangler.jsonc <<'JSON'
{
  "name": "vimma-updates",
  "compatibility_date": "2026-10-15",
  "workers_dev": false,
  "assets": { "directory": "./public" }
}
JSON
printf '/updates/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n' > public/_headers
printf 'User-agent: *\nDisallow: /\n' > public/robots.txt
git add -A && git commit -m "chore: static update host" && git push
```

In the repository's settings add a ruleset on `main`: block force pushes and deletion. Do not
require pull requests: the release workflow pushes manifests with a deploy key (sub-PR 4).

**2. The Worker and DNS.** Cloudflare dashboard → Workers & Pages → Create → Import a
repository → `vimma-browser/vimma-updates` (Workers Builds, deploy command `npx wrangler deploy`,
no build command). Then the Worker → Settings → Domains & Routes → Add → Custom domain →
`updates.vimma.dev`; the `vimma.dev` zone is on Cloudflare, so the DNS record and certificate
are created with it.

The Worker must stay connected to `vimma-browser/vimma-updates` through Workers Builds (the Worker's
settings list the repository and its `main` branch under Build). Workers Builds is
what deploys a manifest: `update-publish.yml` only pushes a commit to `vimma-updates`, and without
the Git connection that push changes nothing on `updates.vimma.dev`, so the run fails at its last
step, which waits until the new serial is served. To recover, connect the repository again, then
deploy the current `main` by hand from a checkout of `vimma-updates`, with an API token limited to
Workers ("Edit Cloudflare Workers" template), and re-run the failed job:

```sh
git pull && CLOUDFLARE_API_TOKEN=<workers-token> CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy
```

Check:

```sh
curl -sI https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml  # 404 until a manifest exists
curl -s https://updates.vimma.dev/robots.txt                                             # served by the Worker
```

**3. The primary key in Google Cloud KMS, reached through GitHub OIDC** (decision 16). About
2.50 USD a month for an HSM RSA-4096 key version. A project ID is globally unique across Google
Cloud, so pick one of your own (for example `vimma-release-<name>`). KMS refuses requests until
the project is linked to a billing account (`gcloud billing accounts list` shows its ID).

The key's algorithm is `rsa-sign-raw-pkcs1-4096`: Cloud KMS offers no RSA-4096 PKCS#1 scheme with
SHA-384, and raw PKCS#1 lets the signer supply the SHA-384 DigestInfo itself, so the signature is
a standard RSASSA-PKCS1-v1_5 SHA-384 signature, the scheme the manifest and MAR verifiers expect.

```sh
PROJECT=vimma-release-<name> LOCATION=europe-north1 BILLING=<billing-account-id>
gcloud projects create "$PROJECT" && gcloud config set project "$PROJECT"
gcloud billing projects link "$PROJECT" --billing-account "$BILLING"
gcloud services enable cloudkms.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
gcloud kms keyrings create vimma-updates --location "$LOCATION"
gcloud kms keys create update-primary --keyring vimma-updates --location "$LOCATION" \
  --purpose asymmetric-signing --default-algorithm rsa-sign-raw-pkcs1-4096 \
  --protection-level hsm
gcloud kms keys versions get-public-key 1 --key update-primary --keyring vimma-updates \
  --location "$LOCATION" --output-file update-primary.pem

NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud iam workload-identity-pools create github --location global --display-name GitHub
gcloud iam workload-identity-pools providers create-oidc vimma --location global \
  --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.job_workflow_ref=assertion.job_workflow_ref' \
  --attribute-condition "assertion.repository == 'vimma-browser/vimma'"
read OWNER_ID REPO_ID < <(gh api repos/vimma-browser/vimma --jq '"\(.owner.id) \(.id)"')
SUBJECT="repo:vimma-browser@$OWNER_ID/vimma@$REPO_ID:environment:update-signing"
gcloud kms keys add-iam-policy-binding update-primary --keyring vimma-updates \
  --location "$LOCATION" --role roles/cloudkms.signerVerifier \
  --member "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/subject/$SUBJECT"
```

For this repository the member is
`principal://iam.googleapis.com/projects/<NUMBER>/locations/global/workloadIdentityPools/github/subject/repo:vimma-browser@342851495/vimma@1411511592:environment:update-signing`.

GitHub's OIDC token for this repository carries its subject (`sub`) in the immutable-ID form:
the owner and the repository are each followed by `@` and their numeric ID. IDs never change
and are never reused, unlike names, so a repository that later takes the name
`vimma-browser/vimma` (after a rename, transfer or deletion) cannot match this binding. The binding must name the subject exactly as the token carries it. A binding for the
name-only form (`repo:vimma-browser/vimma:environment:update-signing`) matches no token, and
signing fails with `PERMISSION_DENIED` on `cloudkms.cryptoKeyVersions.useToSign`. The IDs come
from `gh api repos/vimma-browser/vimma --jq '.owner.id, .id'` (owner first).

Only a job in the `update-signing` environment of `vimma-browser/vimma` gets that subject. Turn
on Data Access audit logs (Data read and Data write) for Cloud Key Management Service in IAM &
Admin → Audit Logs, so every signature is logged. In GitHub:

```sh
R=repos/vimma-browser/vimma
gh api -X PUT $R/environments/update-signing --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/update-signing/deployment-branch-policies -f name=main -f type=branch
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --body "projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/vimma"
gh variable set GCP_KMS_KEY_VERSION --body \
  "projects/$PROJECT/locations/$LOCATION/keyRings/vimma-updates/cryptoKeys/update-primary/cryptoKeyVersions/1"
```

No secret is stored: the key never leaves KMS. To revoke: `gcloud kms keys versions disable 1
--key update-primary --keyring vimma-updates --location "$LOCATION"`, or remove the IAM binding.

**4. The offline secondary (recovery) key** (decision 17). Not done yet: the primary is pinned
alone, and the secondary follows in a later release (step 5 says why). On a machine with
networking off (a live USB system), on removable media:

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out update-secondary.key.pem
openssl req -new -x509 -key update-secondary.key.pem -sha384 -days 36500 \
  -subj "/CN=Vimma update signing secondary" -outform DER -out secondary.der
openssl pkey -in update-secondary.key.pem -pubout -outform DER -out update-secondary.spki.der
sha256sum secondary.der update-secondary.spki.der
```

Keep `update-secondary.key.pem` on two encrypted USB sticks in separate safe places, and never on
a networked machine. Copy only `secondary.der` (the updater's certificate, sub-PR 2) and
`update-secondary.spki.der` off it. It signs only the one release that replaces a lost or leaked
primary (spec §6, "If the primary leaks").

**5. Pin the public keys** (an ordinary PR). For each SPKI DER:

```sh
openssl pkey -pubin -in update-primary.pem -outform DER -out update-primary.spki.der
for f in update-primary.spki.der update-secondary.spki.der; do
  echo "$f id=$(sha256sum "$f" | cut -c1-8) spki=$(base64 -w0 "$f")"
done
```

Add `{ id, slot: "primary" | "secondary", spki }` for each to `UPDATE_KEYS` in
`packages/vimma-core/src/updates/update-keys.mjs`; `npm test` checks that each is an RSA-4096 key
whose id matches, and that the primary's SHA-256 is the one recorded here. Record each SHA-256 here
when it is pinned.

The primary is pinned on its own; the secondary is added in a later release. The secondary comes
from the offline ceremony in step 4, which does not have to wait for the first release: pinning
it is an ordinary release whose manifest the primary signs, so the primary alone can ship it.
Until it is pinned, a lost or leaked primary cannot be replaced through the update check, and
installs keep trusting it until they are updated by hand.

| Slot      | Key                                                                                | id         | SHA-256 of the SPKI DER                                            |
| --------- | ---------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| primary   | Cloud KMS key ring `vimma-updates`, key `update-primary`, version 1, HSM, RSA-4096 | `fb4d33b6` | `fb4d33b6ea54ddb81a6a40ce50a61a6f9383b5850f27e2218045f5d3a07dab9a` |
| secondary | not pinned yet (step 4)                                                            | -          | -                                                                  |

**5b. The updater's certificates** (spec §6, decision 39; ADR-016). Firefox's updater embeds a
certificate per slot, `configs/updater/primary.der` and `secondary.der`, which `npm run import`
links to `engine/toolkit/mozapps/update/updater/vimma/` (`tools/import/link-update-certs.mjs`),
and a `VIMMA_UPDATES=1` build stops without them or when they differ from `configs/updater/`.
They are outside `src/` because `npx surfer license-check` reads every file there for an MPL
header, which a DER file cannot carry. The primary's certificate is self-signed by the KMS key,
which signs only a DigestInfo it is sent, so `tools/update/update-cert.mjs` builds the certificate around one KMS signature. Every field is
fixed, so the request is the same each time and a reviewer can rebuild it from the public key.
With `update-primary.pem` from step 3 and the maintainer's own `gcloud` credentials, as in
step 6:

```sh
node tools/update/update-cert.mjs request --public-key update-primary.pem --slot primary --out-dir cert
gcloud kms asymmetric-sign --version 1 --key update-primary --keyring vimma-updates \
  --location "$LOCATION" --input-file cert/primary.digestinfo.bin --signature-file cert/primary.sig.bin
node tools/update/update-cert.mjs assemble --dir cert --slot primary --signature cert/primary.sig.bin \
  --out configs/updater/primary.der
cp configs/updater/primary.der configs/updater/secondary.der
openssl x509 -inform DER -in configs/updater/primary.der -noout -subject -pubkey \
  | openssl pkey -pubin -outform DER | sha256sum   # the primary's SPKI SHA-256 in the table above
sha256sum configs/updater/*.der
npm run gen-update-keys   # update-keys.mjs from the certificates; it must not change the key
```

`assemble` refuses a signature that does not verify with the certificate's own key, and a key
other than the primary `update-keys.mjs` pins. The secondary slot holds the primary's
certificate again until step 4's ceremony; after it, `secondary.der` is the offline key's
certificate, made there with openssl, and `npm run gen-update-keys` pins it too. Record each
certificate's SHA-256 here; `npm test` fails when `update-keys.mjs` and the certificates
disagree, or when the primary certificate's hash is missing from this file.

| Certificate     | Subject                                 | SHA-256 of the DER                                                 |
| --------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `primary.der`   | `CN=Vimma update signing primary`       | `88b4deaa74ba83b0132b85f9ecc2736bec2916700064792e30d0d2224f7ff6e8` |
| `secondary.der` | the primary's certificate (decision 39) | `88b4deaa74ba83b0132b85f9ecc2736bec2916700064792e30d0d2224f7ff6e8` |

Before a package with the updater is signed or published, `tools/update/check-build.mjs
<unpacked tarball>` checks that it asks `updates.vimma.dev`, that both channel files say
`vimma`, and that its `updater` binary carries these certificates and none of Mozilla's.

**6. Check the chain end to end** before the pipeline exists: sign a manifest with KMS and serve
it. The raw PKCS#1 key signs exactly the bytes it is sent, so the SHA-384 DigestInfo is built
locally: the fixed DER prefix for SHA-384 followed by the 48-byte hash.

```sh
SERIAL=$(date -u +%Y%m%d%H%M%S)
printf '<?xml version="1.0"?>\n<updates vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="%s">\n</updates>\n' \
  "$SERIAL" > update.xml
{ printf 'vimma-update-xml-v1\n'; cat update.xml; } > signed.bin
{ printf '\060\101\060\015\006\011\140\206\110\001\145\003\004\002\002\005\000\004\060'
  openssl dgst -sha384 -binary signed.bin; } > digestinfo.bin
gcloud kms asymmetric-sign --version 1 --key update-primary --keyring vimma-updates \
  --location "$LOCATION" --input-file digestinfo.bin --signature-file sig.bin
openssl dgst -sha384 -verify update-primary.pem -signature sig.bin signed.bin  # Verified OK
ID=$(sha256sum update-primary.spki.der | cut -c1-8)
printf '<!-- vimma-signature v1 key=%s sig=%s -->\n' "$ID" "$(base64 -w0 sig.bin)" >> update.xml
```

That manifest offers nothing. Committed under `public/updates/browser/Linux_x86_64-gcc3/vimma/`
in `vimma-updates`, a release build with the pinned primary shows "up to date" in about:vimma and
the manifest's serial and key; a byte changed in the file makes it "refused". Remove it again
until the release gate lifts: an accepted serial is remembered, so a later manifest must be newer.

**7. Publishing manifests** (`update-publish.yml`). When a release is published, the workflow's
`start` job starts the same workflow on `main` with the tag; the jobs that sign and push run
only there. `prepare` (no secret) checks that the release is published, not a pre-release and on
`main`, downloads its tarball, AppImage, `.deb` and `.rpm`, checks them against `SHA256SUMS` and
`SHA256SUMS` against release.yml's cosign signature (an unsigned release gets no manifest), and builds the manifest
with `tools/update/manifest.mjs`: Firefox's version and the build ID from the tarball's
`application.ini`, each file's size and SHA-512, the urgency, and a serial (the UTC time) that
must be newer than the one `updates.vimma.dev` and `vimma-updates` have. `sign` (environment
`update-signing`, `id-token: write` only, no repository code) checks the body's shape, signs it
with Cloud KMS and checks the signature with openssl. `publish` (environment `update-publish`)
downloads the files again, checks the signed file with the browser's own verifier and pinned
key and with openssl, then commits it to `vimma-updates` and pushes (never forced; one commit
per manifest, `vimma X.Y.Z: update manifest, serial S`; a push the other target's run beat is
rebased onto it, as `github-actions[bot]`, and tried again up to three times), and waits up to 10 minutes until
`updates.vimma.dev` serves the new serial. A failure opens or comments on the
`release-failure` issue.

The macOS manifest (spec macos-homebrew, decisions 16 to 18) comes from the same workflow with
`-f target=macos`: `release.yml`'s `macos-tap` job starts it once the `.dmg` is on the published
release (and `start` does too, when the release already has a `.dmg`). Its `prepare` runs on a
macOS runner, checks the `.dmg` against `SHA256SUMS-macos` and that file's cosign signature, and
reads the build ID from the `.dmg`'s `application.ini`; `sign` and `publish` are the same jobs,
key and environments, writing `updates/browser/Darwin_aarch64-gcc3/vimma/update.xml`. A release
without a `.dmg` (`MACOS_RELEASE_ENABLED` off) gets no macOS run, and the Mac copy keeps the
previous offer.

The urgency is `security` when a commit since the previous published release is a Firefox bump
(`upstream: firefox …`) whose subject names advisories (they go into `vimmaAdvisories`) or whose
pull request has the `security` label (the autopilot puts it on a bump whose advisories it could
not read), a `fix(security)` commit, or any change whose pull request has the `security` label.
Installs then show the update in red (`⇡ X.Y.Z security: :update`).

`prepare` reads the published releases (to find the previous one) and then those labels with
`gh api`, one call per commit, and parses each raw JSON response itself. A call that fails with
an HTTP 5xx, a body that is not JSON (GitHub's 500 with an empty body shows as `unexpected end of
JSON input`) or a network error is tried again after 2, 4 and 8 s; any other failure, or a fourth
transient one, fails the run, because an unread label could hide a security release. A response
of the wrong shape fails the run at once, with `unexpected response` in the log: a pulls answer
that is not a list of pull requests each with a list of named labels, or a releases list that
does not include the tag being published (such a list is malformed or cut short, and counting
from it could reach back to the start of the history). During a GitHub incident, wait for it to
pass and re-run the failed jobs. A `... is not among them` failure seconds after a release was
published can be the releases list lagging behind the release itself: re-run the failed jobs.

One-time setup, in order (each step can be checked before the next):

```sh
R=repos/vimma-browser/vimma
# a. update-signing admits main alone: every signing job runs from main (the release's tag
#    only starts the run there), so a v* tag pushed on another commit cannot reach the key.
id=$(gh api $R/environments/update-signing/deployment-branch-policies \
  --jq '.branch_policies[] | select(.name == "v*") | .id')
[ -n "$id" ] && gh api -X DELETE $R/environments/update-signing/deployment-branch-policies/$id
gh api $R/environments/update-signing/deployment-branch-policies --jq '.branch_policies[].name'  # main

# b. In force: Google Cloud also checks that the token comes from update-publish.yml on main,
#    so no other workflow or branch can sign even with the environment. This replaces the
#    provider's whole condition. release.yml's MAR signing needs nothing here: it calls
#    update-publish.yml, and a called job's token names the called file (step 8). A workflow
#    that signs in a job of its own would need its job_workflow_ref added with ||. Keep the
#    attribute mapping from step 3, which maps attribute.job_workflow_ref next to
#    attribute.repository. Never drop the repository clause, nor the IAM member's subject with
#    the repository's ID: a workflow in any repository can call update-publish.yml@main, and
#    its token then names update-publish.yml at refs/heads/main as well.
gcloud iam workload-identity-pools providers update-oidc vimma --location global \
  --workload-identity-pool github --attribute-condition "assertion.repository == 'vimma-browser/vimma' && assertion.job_workflow_ref == 'vimma-browser/vimma/.github/workflows/update-publish.yml@refs/heads/main'"

# c. The update-publish environment, main alone, before any run uses it (a run would otherwise
#    create it with no branch rule).
gh api -X PUT $R/environments/update-publish --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/update-publish/deployment-branch-policies -f name=main -f type=branch

# d. A dry run: signs with KMS and runs every check, pushes nothing. The signature is real; the
#    signed file stays a day in the run's artifacts. Needs a published, signed release.
gh workflow run update-publish.yml -f tag=v0.1.2 -f dry_run=true
gh run watch "$(gh run list --workflow update-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

# e. The deploy key: write access to vimma-updates only.
ssh-keygen -t ed25519 -N '' -C update-publish -f updates_deploy
gh repo deploy-key add updates_deploy.pub --repo vimma-browser/vimma-updates \
  --allow-write --title "update-publish.yml (vimma-browser/vimma)"
gh secret set UPDATES_DEPLOY_KEY --env update-publish < updates_deploy
rm updates_deploy updates_deploy.pub

# f. Turn update notices on for every install (off: gh variable delete UPDATES_ENABLED).
gh variable set UPDATES_ENABLED --body true
```

Optional: a required reviewer on `update-signing` (Settings → Environments) makes every
signature wait for a person's approval. Without one, anyone with write access to the repository
can start a run on `main` that re-signs a published release or offers nothing; with a single
maintainer the approval adds a click to every release and nothing else. Approve within an hour:
the signing job refuses a serial older than that, and re-running the failed job reuses the old
body, so a late approval needs a new `gh workflow run`.

A deploy key, not a token: it can write to `vimma-updates` and nothing else, belongs to no
person's account and does not expire with one; a fine-grained token would act as the maintainer.
The `vimma-updates` ruleset (step 1) blocks force pushes and deletion, so the key can only add
commits. While `UPDATES_ENABLED` is not `true`, a run signs and verifies and then stops with a
notice, and a published release starts nothing at all (its `start` job logs a notice); with it
`true`, a missing `UPDATES_DEPLOY_KEY` fails the run and opens the `release-failure` issue. A
release published as a pre-release gets no manifest; promoting it to a full release starts the
workflow (the `released` event).

**What the maintainer sees on the next release** (with a–f done): publishing the draft starts
`aur.yml` and `update-publish.yml`; a second `update-publish` run on `main` follows within a
minute and finishes in about 5 minutes. Then `vimma-updates` has a commit `vimma X.Y.Z: update
manifest, serial …`, `curl -s https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml`
shows it (and, a few minutes after `macos-tap`, the same under `Darwin_aarch64-gcc3`), and an
install of an older version (0.1.2 or later; earlier ones pin no key) shows
`⇡ X.Y.Z available` within 12 hours, or at once on `:update`; about:vimma shows the commands,
each with the file's SHA-512.

**Re-run, pull an update, and serials.**

- Re-publish a release's manifest (after a failure, or after `release.yml -f
replace_published=true` changed its files, whose hashes the old manifest no longer matches):
  `gh workflow run update-publish.yml -f tag=vX.Y.Z`, and `-f target=macos` for the Mac
  manifest. Every run gets a new, newer serial. The Linux manifest lists the `.rpm`, so a
  release from before the `.rpm` (0.1.6 and earlier) cannot be re-published from `main`; ship a
  new release instead.
- After two releases in quick succession, check `gh run list --workflow update-publish.yml`:
  GitHub keeps one waiting run per concurrency group (one per target), so a third run started meanwhile replaces
  the waiting one, which ends cancelled without a `release-failure` issue; start it again by hand.
- Pull a bad update (decision 22): `gh workflow run update-publish.yml -f offer=nothing`
  publishes a signed manifest that offers nothing; run it again with `-f target=macos` for Macs. Installs that have not taken the release stop
  offering it at their next check; then ship a fixed release, whose manifest offers it.
- Committing an older `update.xml` again does not undo a manifest: every install remembers the
  newest serial it accepted and refuses an older one (spec §4 rule 3), and the workflow refuses to
  sign a serial that is not newer than the published one. A serial more than a day ahead of a
  client's clock is refused by that client, so the runner's clock (the serial) must be right.
- The workflow also refuses to offer a version older than the one the published manifest offers;
  to go back to an older release, pull the update first (`offer=nothing`), then publish it.
- Turning `UPDATES_ENABLED` off stops new manifests but leaves the published one in place, and
  with it off no run pushes; to withdraw the offer too, run `-f offer=nothing` first, then
  delete the variable.

**8. Signing MARs** (spec §7, sub-PR 4). Tarball installs from a release built with Firefox's
updater update through a complete MAR, `vimma-X.Y.Z-linux-x86_64.complete.mar`, a release
asset like the others. `release.yml` builds every Linux release with the updater
(`VIMMA_UPDATES=1`) and checks the release tarball with `tools/update/check-build.mjs`; while
`UPDATES_ENABLED` is `true` it also builds and ships the MAR:

- `package` (no secret) builds the MAR from the release tarball with the build's host `mar` and
  Mozilla's `make_full_update.sh`, as `./mach repackage mar` does, and gives it a signature block
  whose one 512-byte SHA-384 signature is zero (`tools/update/mar.mjs build`). `signmar -s`
  signs only with a key held in an NSS database, which the KMS key never is.
- `mar-sign` calls `update-publish.yml`, whose `mar-sign` job (environment `update-signing`,
  `id-token: write` only, no repository code) checks with the shell that the file is the tag's
  MAR for the channel `vimma` with that one zeroed placeholder, has KMS sign the SHA-384
  DigestInfo of every other byte, checks the signature with openssl against KMS's key and writes
  it in. A called job's OIDC token names the called file, `update-publish.yml` at
  `refs/heads/main`, so the Workload Identity condition from step 7b admits it unchanged, and
  `update-signing` admits it because the run is on `main`. Nothing in Google Cloud or the
  environments changes for it. The calling job lists every permission `update-publish.yml`'s
  jobs ask for, because GitHub refuses a call otherwise, even for jobs that are skipped; it is a
  ceiling, and in a call only `mar-sign` runs.
- `mar` (no secret) checks that the signed MAR differs from package's only in the signature,
  that it installs exactly the release tarball's files (extracted with the build's `mar` and
  compared with `diff -r`),
  that it verifies under `configs/updater/primary.der` and `secondary.der` with `mar.mjs` and
  with the build's `signmar` (Mozilla's own check), and that its channel is `vimma` and its
  version Firefox's; then it adds the MAR to `SHA256SUMS`, which `sign` signs with cosign and
  `publish` uploads with the other files. While `UPDATES_ENABLED` is `true`, `sign` and
  `publish` wait for it, and a `mar-sign` that failed or was skipped fails `mar`, which stops the
  release before upload and opens the `release-failure` issue; re-run the failed jobs.

`update-publish.yml` then offers the MAR (`<patch>`) when the published release's
`SHA256SUMS` lists it, so releases from before keep their manifests as they were. To check a
release's MAR by hand, with `signmar` from a `VIMMA_UPDATES=1` build (`dist/bin/signmar`):

```sh
db=$(mktemp -d) && certutil -N -d "sql:$db" --empty-password
certutil -A -n primary -t ,, -i configs/updater/primary.der -d "sql:$db"
LD_LIBRARY_PATH=<objdir>/dist/bin <objdir>/dist/bin/signmar -d "sql:$db" -n primary -v vimma-X.Y.Z-linux-x86_64.complete.mar
node tools/update/mar.mjs verify --mar vimma-X.Y.Z-linux-x86_64.complete.mar \
  --cert configs/updater/primary.der --channel vimma
```

The nightly is built with the updater too, set to its own update channel `vimma-nightly`
(`tools/update/channel.mjs`) and checked with `check-build.mjs`; it builds its MAR as a check of
the release's MAR step and, unless public nightlies are on, keeps it nowhere. Nightly MARs are signed and offered only once
public nightly releases start (spec decisions 23 and 42). With `NIGHTLY_RELEASE_ENABLED` set
("Full builds", "Public nightlies"), `nightly.yml` calls `mar-sign` as `release.yml` does: the job
takes the channel from its caller, `vimma-nightly` for `nightly.yml` on `main`, and requires the
name `vimma-nightly-<buildID>-linux-x86_64.complete.mar`; nothing in Google Cloud or the
environments changes, since the called job's token names `update-publish.yml` as before.
`nightly.yml` then calls `update-publish.yml` with the build ID, and its `nightly-prepare`,
`nightly-sign` and `nightly-publish` jobs sign and push `…/vimma-nightly/update.xml` with the
same key, environments and deploy key. A failed nightly opens the `nightly-failure` issue;
re-run the failed jobs of that run.

**Checking an update on real installs.** The e2e scenarios use test keys and a local host
(Updater scenarios); only a published release shows that the real key, `updates.vimma.dev` and
the GitHub downloads work together. After a release whose manifest offers a MAR, take the
previous release's tarball (one built with Firefox's updater) and AppImage from its GitHub
Release and check each against its `SHA256SUMS`. Unpack the tarball into a new directory and
put the AppImage in another (the update replaces that file, so never use a copy you run). Start
each under Xvfb with `WAYLAND_DISPLAY` unset, a private session bus (`dbus-run-session`),
`HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and
`XDG_RUNTIME_DIR` pointed at a new directory, and `--profile` an empty one with
`vimma.control.enabled` in its `user.js`, so nothing reaches an installed Vimma, its profile or
its `config.toml`. Add a bookmark (`ctrl+b a`), a few tabs, a pref and a change to the new
`XDG_CONFIG_HOME`'s `config.toml`, then wait for `vimma-ctl --profile <dir> state --json` to
report `update.stage` `staged` (the first check runs a few seconds after startup; `:update`
checks at once). For a security release answer `y` to the restart question; otherwise run
`:restart`. Then check: `vimma --version` names the new Vimma and Firefox versions, and
`application.ini` and the profile's `compatibility.ini` the new Firefox version and build ID;
the tabs, the bookmark (in `places.sqlite`), the `config.toml` change and the pref are still
there; the tarball's `updates/last-update.log` ends in `succeeded` (the updater checks the MAR's
signature, channel and Firefox version before it applies anything; a refusal ends in
`failed: <code>`: 19 for the signature, 22 for the channel, 23 for an older Firefox) and its
`updates.xml` records the update `succeeded` on the channel `vimma`; the replaced AppImage's
SHA-512 is the manifest's. Kill only the processes you started, by PID: the tarball keeps its
PID across the update, while the AppImage's relaunch script starts a new process, whose PID the
profile's `lock` link names. Done for 0.1.17 to 0.1.18 (Firefox 159.0.1 to 160.0) on
2026-11-12: both installs took the update and kept the profile
([#456](https://github.com/vimma-browser/vimma/issues/456)).

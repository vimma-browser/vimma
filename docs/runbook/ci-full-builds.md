### Full builds (`nightly.yml`, `release.yml`)

Full builds, the nightly and every release, run on GitHub-hosted runners. Vimma has no
self-hosted runner and none is planned: on a public repository that takes pull requests from
forks, a self-hosted runner is a machine anyone who opens a pull request could run code on, and
it would hold the Safe Browsing key between runs (spec
[build-supply-chain](../specs/build-supply-chain.md), decisions 6 and 7). Do not register one.

The build jobs of both workflows run on `ubuntu-24.04`, and a test fails if any workflow names a
self-hosted runner or a label that is not a standard GitHub-hosted image
(`tools/test/self-hosted-runner.test.ts`, docs/security/14-build-and-release-supply-chain.md B5). Both install with
`npm ci --ignore-scripts` and run Surfer with `npx --no -- surfer`, so a missing
`node_modules/.bin/surfer` fails the job instead of fetching whatever npm package is called
`surfer`.

**When the nightly starts.** It should build in the night in Finland, after the day's merges, so
a failure is known by morning. GitHub starts this repository's scheduled workflows hours after
the cron's time. For the nightly's old 03:00 UTC cron that was 6 h 40 min to 7 h 34 min on
2026-11-08 to 2026-11-13; it was 4.5 to 5 h in mid-October and has grown since, and crons later
in the UTC morning wait longer (about 8 h). No daily run was dropped in 30 days. So
`nightly.yml`'s cron is `23 17 * * *`: 17:23 UTC plus the delay is about 00:00 to 02:00 UTC,
02:00 to 04:00 in Helsinki in winter, and with any delay seen so far (4.5 to 10 h) the build
still starts in the night. The delay of a cron in the afternoon was not measured: the first
runs show it. `tools/test/nightly-workflow.test.ts` holds the sum for that November week.
Check the start times now and then
(`gh run list --workflow nightly.yml --event schedule --json createdAt`); if the build starts
outside the night, move the cron and the test's two numbers.

Both build jobs run on `ubuntu-24.04` and start from nothing: a clean checkout, Node from
`.nvmrc` with no npm cache, no Actions cache and no compiler cache (rule B2). The Firefox source
comes only from `tools/upstream/firefox-source.sh`, which downloads the tarball `surfer.json`
names, checks it against Mozilla's `SHA512SUMS` and Mozilla's signature on it (rule B1, next
section), deletes `engine/` and lets Surfer extract the verified file. After `npm run import` the build step deletes `engine/.git`: `surfer import` needs
that empty repository, but with it `mach` finds none of Mozilla's toolchains for
`--enable-bootstrap` (spec build-supply-chain, R14).

Measured on 2026-10-15 (run 38723067541, image `ubuntu-24.04` 20261012.334.1, 4 CPUs, 16 GB of
memory, Firefox 158.0, a keyless build of `main` as the nightly builds it):

| Step                                        | Time    | Disk, memory                                                  |
| ------------------------------------------- | ------- | ------------------------------------------------------------- |
| Free disk before anything                   |         | 86 GB of 145 GB                                               |
| `npm ci`, `firefox-source.sh`, import       | 1 min   | tarball 0.8 GB, tree 4.7 GB                                   |
| `surfer build` (cold, empty sccache)        | 113 min | 26 GB (`engine/` 21 GB, `~/.mozbuild` 2.5 GB, sccache 2.7 GB) |
| Peak memory (the Rust stage, minutes 20-35) |         | 15.3 GB of 16 GB, plus 10.4 GB of swap                        |
| Full mochitest suite                        | 7 min   | 78 tests, 6,355 checks, 0 unexpected                          |
| `./mach package`                            | 2.4 min | 87 MB tarball                                                 |
| Whole job                                   | 124 min | peak 42 GB used including the swap file                       |

Without the 16 GB swap file both jobs create, the first measured build was killed after 38 min
(run 38718105585, exit 143, while the Rust stage held all of memory).

**Memory and lost runners (#1033, #1572).** Hosted runners were lost ("The hosted runner lost
communication with the server") in the Build step 61 to 74 min in: nightly runs 43581331472 and
45732866886, both attempts of release run 44050265017 (v0.1.21), and the first attempt of
`macos-build` in release run 45585814795 (v0.1.24, the cross build). None left a log. The memory
watch's minute-by-minute lines from successful runs show where the memory goes:

- **The peak is the Rust stage, not the libxul link.** In eleven Linux builds with full debug
  info (eight nightlies and three releases, 17 to 25 Nov 2026), available memory fell to 0.65 to
  1.0 GB and swap use peaked at 9.6 to 11.1 GB, 25 to 43 min into the build, while gkrust
  compiled; in the measurement below the largest process then was `rustc --crate-name gkrust`, at
  10.6 to 13.8 GB. When libxul linked (88 to 143 min
  in), 11.5 GB or more was available and swap held under 0.6 GB. The link (lld, no LTO) is not a
  memory problem, so linker flags such as `--no-keep-memory` or fewer linker threads do not
  apply.
- **Debug symbols are the weight.** Firefox builds full DWARF by default (`-gdwarf-4`, and
  `-Cdebuginfo=2` for Rust with one codegen unit per crate in a release build). Both mozconfigs
  set `--disable-debug-symbols`. The packages never carried symbols, because `mach package`
  strips the binaries (`PKG_STRIP`, on by default), and with `--disable-crashreporter` nothing
  uploads or reads them; the unstripped `dist/bin/libxul.so` in the objdir shrinks from 2.6 GB to
  0.25 GB. Mozilla's own Linux builds keep full DWARF to upload crash symbols, on larger builders
  than these.
- **Fewer jobs alone do not fix it.** With debug info, 2 jobs still swapped 8.9 GB and took
  106 min to the libxul link.

Measured on 26 Nov 2026, run 45814348355 (four builds of `main` at a3f38ed4 side by side,
cold, keyless, on the measurement branch `ci/link-memory-measure`, which dispatches `macos.yml`
with a changed job). Peak is RAM in use plus swap, from `free -m` each minute:

| Build                               | Peak use | Swap peak | gkrust rustc | Build step |
| ----------------------------------- | -------- | --------- | ------------ | ---------- |
| Linux, debug info, 3 jobs (nightly) | 24.9 GB  | 10.0 GB   | not logged   | 90 min     |
| Linux, debug info, 2 jobs           | 23.9 GB  | 8.9 GB    | 13.8 GB      | 109 min    |
| Linux, no debug info, 3 jobs        | 7.1 GB   | 0         | 3.6 GB       | 75 min     |
| macOS cross, debug info, 4 jobs     | 28.6 GB  | 14.0 GB   | 11.8 GB      | 89 min     |
| macOS cross, no debug info, 3 jobs  | 11.8 GB  | 0         | 7.8 GB       | 69 min     |

The first row is nightly run 45525945180 (25 Nov), one of the eleven, which peaked at 23.6 to
26.0 GB.
So every full build, the macOS cross builds (`macos.yml`, `release.yml`'s `macos-build`) too:

- Builds without debug symbols (`configs/linux/mozconfig`, `configs/macos/mozconfig`). The
  nightly's mochitests run against the full build's objdir, so their crash, assertion and leak
  stacks now print without symbols: function names from the symbol table, no file and line.
- Builds with `surfer build --jobs 3`, which Surfer passes to `./mach build -j3`. mach would
  pick 4 (one job per GiB of the runner's 15.6 GiB, capped at 4 CPUs), and the macOS mozconfig
  asks for 4 (`MOZ_MAKE_FLAGS`, kept for native builds on a Mac); `-j3` overrides both, and Cargo
  takes its jobs from make's jobserver, so the cap holds for the Rust stage too.
- Keeps the 16 GB swap file, now a margin rather than working memory.
- Runs `tools/ci/memory-watch.sh` in the background; the step's exit trap stops it and waits for
  it. It logs `free -m` and `df -h /` each minute and adds a `Build memory` warning to the run
  when less than 1 GB is available, more than half the swap is used, or the OOM killer killed
  something (at most one every 5 min, an OOM kill at once, and 10 in all). At its start it walks
  up its parent processes and gives the two whose executable is named `Runner.Worker` and
  `Runner.Listener` an `oom_score_adj` of -999 with `sudo -n choom` (util-linux; hosted runners
  have passwordless sudo), so an out-of-memory build loses a compiler, with a log, rather than
  the runner. As it stops it gives them their old values back: every later step (the smoke
  check, the mochitests, the package) is a child of the worker and inherits its value, and must
  stay killable.

**What a lost runner leaves.** Nothing from the job's own output: no step log, not even of the
steps that finished, and no annotation. The same measurement run had a probe job that wrote a
warning in one step, then a warning, a notice, a step summary and six log lines a minute apart
in the next, and then killed both runner processes; the job ended at its timeout with only the
timeout's annotation, and its log API answers `BlobNotFound`. So no line the watch prints, live
or as a warning, outlives a lost runner, and the nightly's failure issue says "(no log)" because
the `nightly-log` artifact is uploaded only by a step after the build. What survives is each
step's start time (`gh api repos/vimma-browser/vimma/actions/jobs/<job>`) and the job's end, and
the successful runs' watch lines, which show how close a build comes: read those to judge the
margin.

`timeout-minutes` is 240 for the nightly and 230 for the release (which runs no mochitests),
well over 1.5 times the 4-job measurements. The first 3-job build, manual nightly run
44089137879 on 17 Nov 2026 (cold sccache), took 136 min in the Build step and 167 min for the
whole job, so the nightly's margin is 73 min. The watch shielded both runner agents
(`runner agent 2255 (Runner.Worker): oom_score_adj -999, was 0`, and the same for
`Runner.Listener`), logged 137 minutes, and warned three times, all for low available memory:
649 to 926 MB at minutes 28 to 39, the Rust stage. Swap use peaked at 10.2 GB and mach's summary
says 14.7 GB in and 14.7 GB out (against 17.6 to 19.5 GB with 4 jobs); the OOM killer killed
nothing. A 3-job release build has not been timed yet; once one has run, put its Build time
here and check the release's margin.

Each job's disk guard fails at once when less than 50 GB is free: the build needs
about 26 GB and the swap file 16 GB. The free space is a property of the runner image, not a
documented guarantee (GitHub documents 14 GB); if the guard fails, the image has shrunk, and
removing preinstalled toolsets (`/usr/local/lib/android` alone is about 9 GB) is the first fix.

**Switching them on.** Both stay off until a repository variable says otherwise; both
variables are set (`gh variable list`), and the commands below are how they were switched on:

```sh
gh workflow run nightly.yml --ref main                # one manual nightly from main, to check it
gh variable set NIGHTLY_ENABLED --body true           # then the nightly schedule
gh variable set RELEASE_ENABLED --body true           # releases (set; drafts keep the gate)
```

What the nightly does once it runs: a full build of `main`, the full mochitest suite on it, the
package as the run's `vimma-nightly` artifact (kept 7 days), and on failure the log as the
`nightly-log` artifact and an issue labelled `nightly-failure` (comment `@claude` on it to hand
it to Claude Code). It creates, replaces and deletes no release: nightlies stay off the release
page until the release gate (spec [build-supply-chain](../specs/build-supply-chain.md), decision
23). The artifact is not private: the repository is public, so anyone signed in to GitHub can
download it from the run page or the API for the 7 days it is kept, and its name and size are
listed without signing in. To get the latest one:

```sh
run=$(gh run list -w nightly.yml -s success -L 1 --json databaseId --jq '.[0].databaseId')
gh run download "$run" -n vimma-nightly -D ~/Downloads/vimma-nightly
```

The `build` job holds a read-only token. Only the `report` job (`issues: write`, and
`actions: read` for the names of the failed jobs and steps) can write, and it checks out and
runs nothing from the repository: it opens the failure issue, or comments on the open one,
with the failed jobs and steps and the redacted log. While `NIGHTLY_RELEASE_ENABLED` is unset, no job can write contents.

**Public nightlies** (spec [m6a-updater](../specs/m6a-updater.md), decisions 42 and 43;
docs/security/14-build-and-release-supply-chain.md B8). With `NIGHTLY_RELEASE_ENABLED` and `UPDATES_ENABLED` both `true`, each
nightly also goes to the rolling `nightly` pre-release, where tarball installs of it take the
next one through Firefox's updater: its MAR is signed by `update-publish.yml`'s `mar-sign` on the
channel `vimma-nightly` (step 8 of "Update signing keys and the update host"), checked, listed
with the tarball in a `SHA256SUMS` that cosign signs as `nightly.yml`, uploaded by the `publish`
job (the one job with `contents: write`, which runs no repository code), and offered at
`https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma-nightly/update.xml`. The files
are named by build ID (`vimma-nightly-<buildID>-linux-x86_64.tar.xz` and
`….complete.mar`); the previous build's stay until the next build replaces them. The release is
a pre-release, never Latest, so the release page, the AUR, Homebrew and vimma.dev never show it.
Its `nightly` tag stays at the first public nightly's commit; each build's commit is in the
release notes. `SHA256SUMS` lists the newest build's files only. The files of the build the
published nightly manifest offers are kept even when that is not the previous build (a failed
manifest step), and a re-run of an older night's `publish` refuses once a newer build is on the
release.

```sh
gh variable set NIGHTLY_RELEASE_ENABLED --body true   # from the next nightly; or now:
gh workflow run nightly.yml --ref main
gh release view nightly                               # the build's files, SHA256SUMS and its bundle
curl -s https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma-nightly/update.xml
```

To check a download: `cosign verify-blob --bundle SHA256SUMS.sigstore.json
--certificate-identity https://github.com/vimma-browser/vimma/.github/workflows/nightly.yml@refs/heads/main
--certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`, then
`sha256sum -c --ignore-missing SHA256SUMS`. A nightly that breaks: merge the fix and run
`gh workflow run nightly.yml --ref main`, whose newer build replaces the offer (an older build
never can); there is no `offer=nothing` for the nightly channel. Deleting the variable stops
further nightlies from publishing and leaves the last one offered. To withdraw the release,
`gh release delete nightly --cleanup-tag --yes`; the next public nightly creates it again. Until
then the published nightly manifest still offers that build, whose files are gone, so every
nightly install's update fails its download (nothing is installed) until a new nightly is
published. A release or tag named `nightly` that is not a public pre-release stops the
`publish` job until it is removed.

**Unchanged days** (spec [m6a-updater](../specs/m6a-updater.md), decision 44). While public
nightlies are on, the scheduled run first runs `changes` (about a minute, `contents: read`, no
secret): it reads the `nightly` release's notes, whose first sentence records the last build
(`Nightly build <buildID> of main at <commit>, Firefox <version>.`), and compares that commit and
Firefox version with `main`'s. When both match it skips `build` and everything after it, and the
`manifest` job signs the recorded build's manifest again under a new serial: the same MAR,
hashes and build ID, so nightly installs see "up to date" and never `no news for N days`. The
run's summary shows the reason as a notice (`no build: main is still …`, or `build: …`).
Anything the record cannot vouch for (no release, a draft, notes in another shape, newer or
missing files) builds, and so does a run whose `changes` job fails. A manual run always builds:

```sh
gh workflow run nightly.yml --ref main                # build now, even if main has not changed
gh release view nightly --json body --jq .body        # the record the next night compares with
```

A `main` that changed but fails to build is not re-signed, so its installs see the stale notice
after 7 days, as before: fix the build, or run a manual nightly once it is fixed.

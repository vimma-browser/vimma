### Flatpak (`flatpak.yml`, spec flatpak)

`tools/package/flatpak.mjs` writes the Flatpak manifest `dev.vimma.browser.json` and the four
files it names (launcher, desktop file, metainfo, icon); the manifest repackages a release
tarball on `org.freedesktop.Platform` 25.08. `tools/package/flatpak-smoke.sh` builds it with
flatpak-builder in a privileged Fedora container, installs it, and checks the version line,
the `vimma-package=flatpak` marker, the desktop file and the metainfo. Nothing is published:
Vimma is not on Flathub yet (issue #465).

- **Pull requests** that change `tools/package/`, the branding, `surfer.json` or the workflow
  run the `stub` job: a stub tarball, a few minutes, most of them downloading the runtime and
  SDK (about 870 MB).
- **A published release** runs the `release` job, which builds from the release's download URL
  pinned to the SHA-256 in its `SHA256SUMS` (signature checked with signing on), and also starts
  Vimma headless and takes a screenshot. It is not a release check: a failure leaves the
  release as it is, and only the run is red. Re-run with
  `gh workflow run flatpak.yml -f tag=vX.Y.Z`, which uses `main`'s workflow; the run a publish
  starts uses the tag's copy.
- **Locally:** `tools/package/flatpak-smoke.sh --stub`, or
  `tools/package/flatpak-smoke.sh --release vX.Y.Z <sha256> "<version line>"` with the
  tarball's line from the release's `SHA256SUMS`. Needs docker.
- **Pins:** the Fedora image digest and the runtime and SDK commits are at the top of
  `flatpak-smoke.sh`. Flathub prunes old commits in time; when `flatpak update --commit` cannot
  find one, take the current ones from
  `flatpak remote-info flathub runtime/org.freedesktop.Platform/x86_64/25.08` (and `…Sdk…`) and
  update the script in a pull request. A new runtime branch (26.08) changes `RUNTIME_VERSION` in
  `flatpak.mjs` and `RUNTIME` in the script together; a test keeps them equal.

**Submitting to Flathub** (issue #465; only once its other items are done, and only when the
maintainer decides to list Vimma):

Flathub's [Generative AI policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy)
bars a manifest with AI-generated or AI-assisted
content, even disclosed, and bars AI tools from opening the submission pull request or writing
its description, commit messages, comments or replies. Other AI-generated material in the app
or its packaging must be disclosed in the pull request, naming the parts and the extent. Since
`tools/package/flatpak.mjs` was written with AI help, its generated manifest cannot be submitted
as it is: a person writes the submitted manifest by hand (the generated one and step 2's lint
can serve as research), and does steps 3 and 4 by hand.

1. Generate the files for the release to submit, with the tarball's SHA-256 from its
   `SHA256SUMS` and the release's date:
   `node tools/package/flatpak.mjs --out flathub --version X.Y.Z --date YYYY-MM-DD --sha256 <hex>`.
2. Build and lint them as Flathub does, on a machine with Flatpak:
   `flatpak install flathub org.flatpak.Builder`, then
   `flatpak run --command=flathub-build org.flatpak.Builder --install flathub/dev.vimma.browser.json`
   (Flathub's build options, including the screenshot mirror; in a container without FUSE, add
   `--disable-rofiles-fuse` before the manifest),
   `flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest flathub/dev.vimma.browser.json`
   and `flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo`. Fix every
   error in `flatpak.mjs`, not in the generated files. Expect one warning,
   `runtime-update-available-to-org.freedesktop.Platform-26.08`, while Mozilla's Flatpak stays
   on 25.08. The metainfo links its screenshots at the release's tag
   (`docs/assets/screenshots/README.md`), so submit a release whose tag has
   `docs/assets/screenshots/`; for an earlier one, the screenshot mirror cannot download them.
3. Fork `flathub/flathub`, branch from its `new-pr` branch, add the generated files at the top
   level, and open a pull request against `new-pr` titled `Add dev.vimma.browser`. The
   description explains the D-Bus names outside the app id (`org.mozilla.vimma.*` for Firefox's
   remoting, `org.mpris.MediaPlayer2.firefox.*` for media keys) and the `~/.local/state/omarchy`
   read-only grant (the theme).
4. Answer the reviewers; `bot, build` in a comment starts a test build. Once merged, Flathub
   creates `flathub/dev.vimma.browser`, and you get write access to it.
5. Verify the app: on flathub.org, sign in, open the app's developer settings, choose
   "Verify" for `vimma.dev`, and publish the token Flathub gives at
   `https://vimma.dev/.well-known/org.flathub.VerifiedApps.txt` (the vimma-site repository).
6. Each later release: a pull request to `flathub/dev.vimma.browser` with the new tarball URL,
   SHA-256 and `<release>` line, generated as in step 1.

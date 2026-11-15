### Release download counts

GitHub counts every request for a release file as a download of it, whatever the request
reads. Measured on `v0.1.1`'s files in October 2026, each request below raised its file's
`download_count` by one: a `HEAD` on `releases/download/<tag>/<file>`, the same `HEAD` without
following its redirect (a bare 302), `GET /repos/{owner}/{repo}/releases/assets/{id}` with
`Accept: application/octet-stream` with and without following its redirect, and a plain `GET`.
Repeated requests from one address a few seconds apart counted once (three `HEAD`s, then three
API downloads: one each). Reading the release's metadata, `GET
/repos/{owner}/{repo}/releases/tags/<tag>`, counted nothing on any file. The counts update
several minutes after the requests.

So a workflow that only needs to know whether a file is on a published release reads the
release's metadata instead: `homebrew.yml`'s `start`, `release.yml`'s `macos-tap` and
`update-publish.yml`'s `start`. That endpoint answers 404 for a draft, as the download URLs do,
and any answer other than 200 or 404, or a 200 that is not a release, fails the job rather than pass for a missing file. Every
other fetch needs the file's bytes, to check its hash and signature, and no route to the bytes
goes uncounted, so these still add one download per file per job on each release:

| Workflow (job)              | Files                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| `aur.yml` (`aur`)           | `PKGBUILD`, `SRCINFO`, `SHA256SUMS`, `SHA256SUMS.sigstore.json`            |
| `homebrew.yml` (`homebrew`) | `vimma.rb`, `SHA256SUMS-macos`, `SHA256SUMS-macos.sigstore.json`           |
| `flatpak.yml` (`release`)   | `SHA256SUMS`, `SHA256SUMS.sigstore.json`, the tarball (by flatpak-builder) |
| `update-publish.yml` Linux  | `SHA256SUMS` and its bundle once; tarball, AppImage, `.deb`, `.rpm` twice  |
| `update-publish.yml` macOS  | `SHA256SUMS-macos` and its bundle once; the `.dmg` twice                   |

`update-publish.yml` downloads its files twice on purpose: `publish` fetches them again after
signing, so a file replaced on the release since `prepare` read it fails the run. Taking the
files from `release.yml`'s workflow artifacts instead would not count, but would check what was
built rather than what users download, and `aur.yml` and `homebrew.yml` take their input only
from a published release (docs/security/14-build-and-release-supply-chain.md, B10 and B11). Subtract these from a release's
counts to estimate what users downloaded.

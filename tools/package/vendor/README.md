# Vendored data for tools/package (spec m6-packaging)

Unchanged copies, pinned by version and SHA-256. Used at release time and in tests only; none of
it ships in a package. Update by downloading the same paths at a new tag, updating this table,
and keeping the SPDX list at the version the CycloneDX schema's `spdx.schema.json` enumerates
(its `$comment`), so every id `sbom.mjs` emits is one the schema accepts.

| File                                       | Source                                                                                       | Version | Licence                    | SHA-256                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | ------- | -------------------------- | ------------------------------------------------------------------ |
| `cyclonedx-1.6.2/bom-1.6.schema.json`      | `https://raw.githubusercontent.com/CycloneDX/specification/1.6.2/schema/bom-1.6.schema.json` | 1.6.2   | Apache-2.0                 | `18f57f7482593bad9f21b4feed09084640cbeff419d62ad5090c5ceccca5b37d` |
| `cyclonedx-1.6.2/spdx.schema.json`         | same tag, `schema/spdx.schema.json` (`$comment`: SPDX list 3.24.0)                           | 1.6.2   | Apache-2.0                 | `c41917196639055e9f9670811bac23ef777732144f3ff5a2f39686f61580dbe6` |
| `cyclonedx-1.6.2/jsf-0.82.schema.json`     | same tag, `schema/jsf-0.82.schema.json`                                                      | 1.6.2   | Apache-2.0                 | `8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae` |
| `spdx-license-list-3.24.0/licenses.json`   | `https://raw.githubusercontent.com/spdx/license-list-data/v3.24.0/json/licenses.json`        | 3.24.0  | CC0-1.0                    | `2455d63fb9bcc1eef49bad9fe5bd78e3dd3c2e71c31999f403fe738cdc67cae2` |
| `spdx-license-list-3.24.0/exceptions.json` | same tag, `json/exceptions.json`                                                             | 3.24.0  | CC0-1.0                    | `f779511110a5eb9ffbd6a11abcec3b224e8eb623f6465e87254e95427b01f1b3` |
| `../notices/LGPL-2.1.txt`                  | `https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt`                                     | 2.1     | verbatim copying permitted | `20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95` |
| `../notices/musl-1.2.5/COPYRIGHT`          | `COPYRIGHT` in `https://musl.libc.org/releases/musl-1.2.5.tar.gz` (signature checked)        | 1.2.5   | MIT                        | `f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af` |

The notices files ship: the AppImage carries `LGPL-2.1.txt`, and every package carries musl's
`COPYRIGHT` with `vimma-ctl` (`ctl-notices.mjs`, which picks it by the musl version in the Rust
toolchain's `libc.a`; rustup ships no copy). For a new musl, add `notices/musl-<version>/COPYRIGHT`
from that release's tarball, after checking the tarball's `.asc` against musl's key
(`https://musl.libc.org/musl.pub`).

The schemas are validated with ajv 8 (MIT, a direct devDependency; it was already in the lockfile
through commitlint): `node tools/package/validate-sbom.mjs <sbom>`.

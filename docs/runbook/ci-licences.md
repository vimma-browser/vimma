### Licences

`npm run license-check` checks every package in `package-lock.json` against MIT, ISC,
BSD-2/3-Clause, Apache-2.0, MPL-2.0 and PSF-2.0 (also under its former id, Python-2.0). Reviewed exceptions live in
`tools/license-check/exceptions.json`, keyed by exact `name@version`, so an upgrade must be
re-reviewed; stale exceptions fail the check too.

`npm run license-check:crates` does the same for the Rust crates (`cargo metadata` on
`tools/vimma-ctl`, legacy `MIT/Apache-2.0` read as OR, dev-dependencies included); reviewed
exceptions live in `tools/license-check/cargo-exceptions.json`. vimma-ctl's binary has no
dependencies; its only dev-dependency is proptest (spec m7-fuzzing), whose tree brings the three
exceptions there (unicode-ident's Unicode-3.0 tables, and two WASI-only crates whose
`… WITH LLVM-exception OR … OR MIT` the checker cannot parse).

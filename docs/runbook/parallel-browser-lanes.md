## Parallel browser lanes

A lane is a git worktree (e.g. an agent's under `.claude/worktrees/`) with its own `engine/` and
artifact build, so several agents can run browser specs at once without sharing a tree. In the
worktree:

```sh
ln -s <main checkout>/node_modules node_modules   # or npm ci
npm run lane:setup          # copy, reset, import, artifact build, verify
npm run mochitest -- --artifact tests/browser/
npm run lane:teardown       # when done: removes this worktree's engine/
```

`tools/lanes/lane-setup.ts`:

1. reflink-copies the main checkout's `engine/` (`--source <checkout>` for another) without
   any `obj-*` dir, keeping the engine's own `.git` and modes (`cp -a --reflink=always`);
2. resets the copy to upstream as Surfer's `surfer reset` would, but scoped: unlinks the
   symlinks that lead into the source checkout (the source's `surfer import` made them, with
   absolute paths), `git checkout -- .` (undoes our `.patch` files and the lines import added
   to `engine/.gitignore`), `git clean -fd` (no `-x`: what import added, not upstream-ignored
   files) and removes `mozconfig*`;
3. runs this worktree's `npm run import` and `tools/artifact-build` into `engine/obj-artifact`;
4. checks that no symlink leads into the source checkout and some lead into the lane, runs
   `browser_vimma_branding.js`, and prints timings and disk (`btrfs filesystem du`).

Cost, measured 2026-10-09 (Firefox 157.0.1, 16 threads, Mozilla's artifacts already cached in
`~/.mozbuild/package-frontend`; a cold cache downloads 163 MB once, shared by all lanes):

| Phase          | Time   |
| -------------- | ------ |
| copy (reflink) | 4.8 s  |
| reset          | 23.2 s |
| import         | 1.0 s  |
| artifact build | 36.5 s |
| mochitest      | 8.6 s  |

About 75 s in all. Disk: 5.06 GB total but **0.59 GB exclusive** (the reflinked tree shares
its extents with the source; `obj-artifact` and rewritten files are the lane's own). The whole
`tests/browser/` suite then takes 22 s in the lane.

Protection of the main checkout: setup and teardown refuse to run in it (the first entry of
`git worktree list`), whatever path it is reached by; setup only reads the source `engine/` and
writes under the lane's; teardown refuses an `engine/` that is a symlink or resolves into the
main checkout's. Setup refuses an existing `engine/` unless `--force`, and refuses a non-reflink
copy (about 6 GB, minutes) unless `--allow-copy`: the lane must be on the same btrfs filesystem.

Limits:

- **Artifact builds only.** Specs that change build config, `moz.configure`, compiled-in
  defines or C++ (ADR-010 "Known gaps", `skip-if = ["artifact"]` tests) need the main
  checkout's full build; do them there, one at a time.
- **One lane per worktree** (its `engine/`). After changing `src/` or `tests/` paths, rerun
  `npm run import` there; after a Firefox bump, `npm run lane:setup -- --force` from a source
  checkout on the new release.
- **After a Firefox bump, update the source checkout once.** Lanes copy the primary checkout's
  `engine/`, so after an `upstream: firefox X.Y.Z` merge (by hand or by auto-merge) every lane's
  setup fails on `verify-source --require`, naming the old version, until the primary checkout is
  on the new release. The maintainer, or the session coordinating agents, updates it with no dev
  build running from it:

  ```sh
  git pull --ff-only && npx surfer download --force && npm run verify-source && npm run import
  ```

  `surfer download --force` deletes `engine/` with its full build; run `npm run build` again when
  the dev build is needed. Do not download an engine per lane instead: several downloads and
  artifact builds at once overloaded a 12-core machine (load average 22 after the 160.0 bump).

- **CPU:** an artifact build is CPU-bound (the front-end build). On a 16-thread machine run at
  most about 3 artifact builds at once, and none while the main checkout runs a full build;
  mochitests are light, a few in parallel are fine.
- **e2e runs share one port.** Every lane's `npm run e2e` serves the fixture pages on
  `127.0.0.1:28471`, so two lanes' runs collide: the second exits 2 before launching anything,
  with a message naming the port. Wait for the first, or run the second with `--port N` (or
  `VIMMA_E2E_PORT=N`; 0 for any free port); its screenshots that show a URL then differ from the
  baselines by a few digits.
- **Don't set up a lane while the source checkout is mid-import** (or mid-`git` in its
  `engine/`): the copy is a snapshot. Stray `*.lock` files copied from its `engine/.git` are
  removed in the lane (and logged), never in the source; a half-applied import is undone by
  the reset, but rerun setup with `--force` if anything looks off.
- With `--source <other worktree>`, links into both that worktree and the main checkout are
  removed and checked. All git (and import) children run without inherited `GIT_*`
  variables, and reset refuses an `engine/` that is not the top of its own git repo.
- mach keeps a small per-tree state dir in `~/.mozbuild/srcdirs/engine-<hash>` (about 2 MB
  per lane); teardown leaves it.

## Re-importing after a patch changes

`surfer import` applies each `src/**/*.patch` as `git apply -R` (failure ignored), then
`git apply`. When a patch changed since the last import, its reverse no longer matches what the
old version left in `engine/`, so the forward apply fails ("Exiting due to error") on a file
that still carries the old hunks. `npm run import` therefore runs
`tools/import/restore-patched.mjs` first: it reads the `+++ b/<path>` line of each header pair in
`src/**/*.patch` and runs `git -C engine checkout -- <those files>` (11 files today), so every
import starts from upstream. It touches only those files: never `git checkout .`, never a
clean. A file a patch creates (`--- /dev/null`) is skipped, as is a path upstream does not track.

```sh
node tools/import/restore-patched.mjs --dry-run   # list the files and the git command, change nothing
```

Without an `engine/` (before `surfer download`) it does nothing.

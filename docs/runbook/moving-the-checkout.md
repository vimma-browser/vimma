## Moving the checkout

`surfer import` links `engine/` into `src/` with absolute symlinks, and an objdir records the
checkout's absolute path in Make dependency, cargo and config files. After `mv old new`, links
dangle and the build mixes paths. The 2026-10-10 move (`~/repositories/VimHerdr` →
`~/repositories/vimma`) needed about 139k symlinks retargeted and the old path rewritten in about
6.9k objdir text files. `tools/import/relocate-checkout.mjs` does both:

```sh
mv ~/repositories/old ~/repositories/new && cd ~/repositories/new
git worktree prune                     # or `git worktree repair` for worktrees you keep
node tools/import/relocate-checkout.mjs --from ~/repositories/old --dry-run   # counts only
node tools/import/relocate-checkout.mjs --from ~/repositories/old
npm run import && npx surfer build     # mach reconfigures; the 2026-10-10 full build: 21 min
```

1. Every symlink under `engine/` (not `.git`) whose absolute target lies in the old checkout is
   pointed at the same place in this one. Relative links and links elsewhere stay.
2. In each `engine/obj-*`, the old path is replaced in text files outside `dist/` (`dist/` is
   links, handled by step 1). The path only matches whole: `/old/repo` does not touch
   `/old/repo2`. Binaries (a NUL byte) and files over 64 MB are left for the build to relink.

Upstream sources and anything outside `engine/` are never written; a second run changes
nothing. Things outside the repo that name the old path (a launcher such as
`~/.local/bin/vimma-dev` or a `.desktop` file) are yours to update. A lane (below) does not need this: `npm run lane:setup -- --force` rebuilds it.

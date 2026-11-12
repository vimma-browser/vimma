# Screenshots

Screenshots of Vimma 0.1.18 (Firefox 160) for the Flatpak's AppStream metainfo, which Flathub
shows on the app's page. Each was taken from an artifact build under Xvfb at 1280×800, in the
built-in theme, on [vimma.dev](https://vimma.dev):

| File        | Shows                                                 |
| ----------- | ----------------------------------------------------- |
| `hints.png` | link hints (`f`) on vimma.dev; the default screenshot |
| `split.png` | two split panes side by side (`ctrl+b v`)             |
| `panel.png` | the side panel's tab list (`ctrl+b b`)                |
| `grep.png`  | live grep through the workspace's tabs (`ctrl+b f g`) |
| `help.png`  | the key bindings overlay (`ctrl+b ?`)                 |

`tools/package/flatpak.mjs` links them as raw GitHub URLs at each release's tag (`vX.Y.Z`), so
the links of a release never change under Flathub. To replace one, commit the new file under the
same name; the metainfo of the next release links it.

To take them again on a new build, run the e2e scenarios in `tools/package/screenshots/`, which
open only vimma.dev's public pages in a fresh profile, so no personal data shows:

```sh
npm run e2e -- --xvfb --scenarios tools/package/screenshots \
  --baselines docs/assets/screenshots --out "$(mktemp -d)" --update-baselines
```

Without `--update-baselines`, the same command compares a build with the committed screenshots.
Look at each image before committing it: the pages on vimma.dev change with the site.

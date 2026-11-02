# Screenshots

Screenshots of Vimma 0.1.14 for the Flatpak's AppStream metainfo, which Flathub shows on the
app's page. Each was taken from an artifact build under Xvfb at 1280×800, in the built-in
theme, on [vimma.dev](https://vimma.dev):

| File        | Shows                                                 |
| ----------- | ----------------------------------------------------- |
| `hints.png` | link hints (`f`) on vimma.dev; the default screenshot |
| `split.png` | two split panes side by side (`ctrl+b v`)             |
| `panel.png` | the side panel's tab list (`ctrl+b b`)                |
| `grep.png`  | live grep across the open tabs (`ctrl+b f g`)         |
| `help.png`  | the key bindings overlay (`ctrl+b ?`)                 |

`tools/package/flatpak.mjs` links them as raw GitHub URLs pinned to the commit that added them
(`SCREENSHOTS_COMMIT`), so the links never change under Flathub. To replace one, commit the new
file and move `SCREENSHOTS_COMMIT` to that commit.

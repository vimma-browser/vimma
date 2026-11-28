# Contributors

Vimma is shaped by the people who use it. This page thanks those outside the core team whose bug
reports, feature proposals and diagnoses changed how Vimma works.

People are added here by hand for reporting issues, proposing features or contributing fixes; see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to take part.

## Thanks

- [@quintrino](https://github.com/quintrino) reported problems and proposed features across much
  of the keyboard layer:
  - Panes and tabs: a new tab pushing an existing tab out of its pane (#1059), a second split
    (#1215), closing the active tab from insert mode and the side panel (#1223), closing a pane
    keeping focus on that pane (#1426), closing the last tab or pane closing Vimma (#1428), and a
    new tab from the side panel entering insert mode (#1481).
  - Bookmarks and bookmarklets: a command to open bookmarks (#1219), bookmark names with spaces
    (#1425), and running bookmarklets from the command line (#1220).
  - Per-site settings and navigation: per-site unbinds (#1224), a scroll speed setting (#1074),
    and keyboard navigation (#1473).
  - Command line: moving through it with the down arrow (#1222).
  - Workspaces and packaging: containers interfering with an extension's sign-in (#1221), and
    broken automated Homebrew updates (#1063).
- [@conradbeach](https://github.com/conradbeach) diagnosed why a site unbind had no effect on
  digit keys, which still started a count, and tested the fix (#1612).

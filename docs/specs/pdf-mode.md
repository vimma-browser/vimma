# Spec: pdf-mode

Status: accepted · Area: `packages/vimma-core/src/` (`keymap.mjs` and `dispatcher.mjs` contexts,
`modes.mjs` (`index` mode), `actions.mjs`, `defaults.mjs`, `statusbar.mjs`, `pdf.mjs` (new: state
parser, page and zoom arithmetic, marks), `pdfoutline.mjs` (new: outline parser and the outline
panel's state)); `actors/pdf-view.mjs` (new: the one module that touches pdf.js),
`actors/VimmaChild.sys.mjs`, `actors/VimmaActors.sys.mjs`, `host/VimmaHost.sys.mjs`,
`host/find.mjs`, `host/pdf-ops.mjs` (new); `ui/pdf-outline.mjs` and its style sheet (new: the
outline panel); `src/browser/branding/vimma/pref/firefox-branding.js`; `docs/guide.md`,
`docs/limits.md`, `docs/security.md` · Upstream patches: none (decision 2) · ADR: ADR-023, keymap
contexts (new, written with delivery PR 1, decision 4)

Issue: [#487](https://github.com/vimma-browser/vimma/issues/487)

Engine paths are relative to `engine/` and were read in Firefox 158.0 (`config/milestone.txt`),
which ships pdf.js 6.4.195 (`toolkit/components/pdfjs/content/PdfJsVersion.sys.mjs:6`). In this
spec `viewer.mjs` is `toolkit/components/pdfjs/content/web/viewer.mjs` and `pdfjs/` is
`toolkit/components/pdfjs/content/`. zathura facts were read in the zathura source at git tag
`2026.10.4` (github.com/pwmt/zathura, `zathura/config.c` and the other files cited, and the man
pages `doc/man/zathura.1.rst` and `doc/man/zathurarc.5.rst`) and compared with tag `0.5.14`, the
last 0.5 release; the two have the same default bindings except where the zathura table says so.
Anything not confirmed from source is marked **unverified**, with the check that settles it.

## Summary

PDFs open in Firefox's own viewer, pdf.js, and today Vimma's keys treat it as any other page:
`j`/`k` scroll, `/` finds, the rest is pdf.js's toolbar. This spec adds a PDF layer on top of
that viewer so that it behaves as closely as practical to zathura, the keyboard-driven document
viewer: page jumps with counts (`12G`), zoom and fit (`+`, `-`, `a`, `s`), dual page, rotation,
the outline on `Tab` in a Vimma panel with zathura's index keys and a fuzzy filter, marks,
presentation mode on `F5`, and a page and match count in the status bar. Vimma builds no PDF
renderer of its own: pdf.js keeps rendering, forms, signatures, accessibility, printing and its
security sandbox, and Vimma only drives it. Vimma's own surfaces in the viewer (the outline panel,
the status bar's page and match count, notices) follow the Vimma or Omarchy theme; the pages
themselves are shown exactly as the document draws them.

## Problem

- A PDF has no notion of pages in Vimma. `G` scrolls to the bottom, `12G` does not go to page 12,
  and the status bar does not say which page is shown. Moving by page needs pdf.js's own `n`/`p`
  or its page-number field, which only the mouse or `ctrl+alt+g` reaches.
- Zoom, fit to width, dual page, rotation, the outline and presentation mode are buttons in
  pdf.js's toolbar and secondary menu. With the toolbar hidden (`ctrl+b u`) they are out of reach.
- `/` finds in a PDF, but the status bar shows no match count, which `docs/limits.md` lists as a
  limit ("In the PDF viewer, `/`, `n` and `N` work, but the status bar shows no match count").
- zathura users, the audience Vimma's Vim and tmux keys are written for, expect the same keys in
  a PDF in the browser as in their viewer.

## Behaviour

Bindings in the PDF viewer are written as in `config.toml`. "The PDF viewer" is a tab whose top
document is pdf.js showing a PDF (Research, "How Vimma reaches the viewer"). A PDF that a web page
shows in a frame, `<embed>` or `<object>` is not: there the page's keys apply. Outside it nothing
changes.

1. As a user in the PDF viewer, Vimma's normal-mode keys work as on any page (`j`, `k`, `h`, `l`,
   `ctrl+d`, `ctrl+u`, `/`, `n`, `N`, `f`, `v`, `:`, `t`, `x`, `gt`, `ctrl+o`, `ctrl+i`, the
   prefix layer), except the keys in this list that take a PDF meaning there.
2. As a user, `J` / `K` go to the next / previous page, with a count (`3J`). `gg` goes to the first
   page and `G` to the last; with a count both go to that page (`12G`, `12gg`), counted from 1 as
   physical pages, not page labels. `:12` on the command line goes to page 12 too. `H` / `L` go to
   the top / bottom of the current page, `P` snaps the view to the current page's top. `ctrl+f`
   scrolls a screen down; `space` and `shift+space` keep scrolling a screen down and up.
3. As a user, `+` / `zi` / `zI` and `-` / `zo` / `zO` zoom in and out by 10 % per step, with a
   count. `=`, `zz`, `zZ` and `z0` set 100 %; `150=` sets 150 %. `a` fits the whole page, `s` fits the width, and the fit
   follows window and pane resizes until I zoom by hand.
4. As a user, `d` toggles two pages side by side, with the first page alone as in a printed
   book; `D` toggles whether the first page stands alone. `w` toggles showing one page at a time.
   `r` rotates the pages 90° clockwise, with a count.
5. As a user, `Tab` opens the document's outline (table of contents) in Vimma's outline panel on
   the left of the window, drawn in the theme like the side panel, and puts the tab in `INDEX`
   mode, with the entry for the current page selected. `j` / `k` (and the arrow keys) move, `l` /
   `zo` expand and `h` / `zc` collapse, `zO` / `zC` expand / collapse the entry's whole subtree,
   `L` / `zR` and `H` / `zM` expand / collapse all, `gg` / `G` go to the first / last entry,
   `ctrl+d` / `ctrl+u` move half a panel; `Enter`, `space` or `ctrl+j` goes to the entry and
   closes the outline; `Tab`, `Esc`, `ctrl+[`, `ctrl+c` or `q` closes it without moving. `/`
   filters the outline: typed text narrows it to the entries that match fuzzily, best match
   first, each shown with the titles of the entries above it; `ctrl+n` / `ctrl+p` and the arrow
   keys move, `Enter` goes to the entry, and `Esc` returns to the whole outline. A PDF without an
   outline says `no outline in this PDF`.
6. As a user, PDF pages look exactly as the document draws them: Vimma does not recolour them,
   and `ctrl+r` reloads as on any page.
7. As a user, `m` and a letter or digit sets a mark at the current position (page, place on it,
   zoom); `'` and the same character goes back there. Marks belong to the document (its URL
   without the fragment), last until Vimma quits, and are never written to disk. A missing mark
   says `no mark 'a'`.
8. As a user, `ctrl+o` / `ctrl+i` walk back and forward through jumps inside the PDF (a link, a
   page jump, a search hit, a mark, an outline entry) before they leave the PDF for the previous
   page, as Vim's jump list does.
9. As a user, `/` and `?` find as today, and the status bar shows the match count as it does on
   web pages (`/word [3/41]`), so the limit in `docs/limits.md` goes.
10. As a user, the status bar shows `page 3/12` while a PDF is shown, or `page iv (4/120)` when the
    page has a label that is not its number.
11. As a user, `f` labels the links on screen (pdf.js draws them as links), `F` labels them and
    shows the chosen link's target in a notice without following it, and `c` labels them and
    copies the chosen target.
12. As a user, `F5` starts pdf.js's presentation mode (full screen, one page at a time, fit to
    page); there `j`, `J`, `space` and the arrow keys go forward a page, `k`, `K` and `shift+space`
    back, and `F5` or `Esc` leaves it. `F11` is Vimma's full screen as everywhere.
13. As a user, `R` and `ctrl+r` reload the PDF (Vimma's `r` and `F5` have their PDF meanings here);
    `ctrl+p` prints, `ctrl+s` saves, `yy` and `Y` copy the URL and `:pdf_info` shows pdf.js's
    document properties.
14. As a user, every binding in this list can be changed in `config.toml` under `[modal.pdf]`
    (the PDF viewer's normal mode) and `[modal.index]`, and removed with `[unbind] pdf = [...]`.
    `ctrl+b ?` lists them under their own headings, `[pdf]` and `[index]`.
15. As a user, form fields in a PDF behave as text fields anywhere: focusing one is insert mode,
    `Esc` leaves it.
16. As a user, no promotion bar ("PDFs just got easier") covers a document in the viewer;
    `about:pdf` and its menu entries stay as Firefox ships them.

### zathura's defaults and what Vimma does

| zathura (default key, behaviour)                                                           | Vimma in the PDF viewer                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h j k l`, arrows: scroll by `scroll-step` 40 px (config.c:336-349)                        | Same keys, Vimma's scroll step (as on pages)                                                                                                                      |
| `ctrl+d` / `ctrl+u`: half screen (config.c:359-360)                                        | Same                                                                                                                                                              |
| `ctrl+f` / `ctrl+b`, `space` / `shift+space`: full screen (config.c:363-367)               | `ctrl+f`, `space`, `shift+space`. **Not matched:** `ctrl+b`, which is Vimma's prefix in every mode                                                                |
| `t` / `y`, `ctrl+t` / `ctrl+y`: full or half screen left / right (config.c:350-365)        | **Not matched:** `t` stays new tab, `ctrl+t` new tab, `ctrl+y` scroll up; `h` / `l` scroll sideways                                                               |
| `alt+j` / `alt+k`: partial scroll (config.c:352-357)                                       | **Not matched** (no default); `j` / `k` are already small steps                                                                                                   |
| `H` / `L`: top / bottom of the page (config.c:346-347)                                     | Same (shadows Vimma's history `H` / `L`; `ctrl+o` / `ctrl+i` remain)                                                                                              |
| `J` / `K`, `PgDn` / `PgUp`: next / previous page, count (config.c:315-326)                 | `J` / `K` with a count; `PgDn` / `PgUp` stay pdf.js's own (a screen, or a page at page fit, viewer.mjs:19613-19618)                                               |
| `gg` / `G`, `{n}G`: first / last page, page n (config.c:305-310)                           | Same, with counts; `:{n}` too                                                                                                                                     |
| `Home` / `End`: first / last page (config.c:306, 309)                                      | Same: Vimma leaves them to pdf.js, which goes to the first / last page (viewer.mjs:19635-19648)                                                                   |
| `alt+Right` / `alt+Left`: next / previous page (config.c:317-320)                          | **Not matched:** they stay Vimma's history forward / back (Firefox's keys), which walk jumps inside the PDF                                                       |
| `P`: snap to the current page (config.c:379)                                               | Same (shadows `P`, open the clipboard in a new tab)                                                                                                               |
| `ctrl+o` / `ctrl+i`: jump list, 2000 entries, saved per file (config.c:370-371, 528)       | pdf.js's history entries, kept in session history (decision 9). **Not matched:** not saved across sessions                                                        |
| `ctrl+j` / `ctrl+k`: bisect between jumps (config.c:373-374)                               | **Not matched** (out of scope)                                                                                                                                    |
| `+ - =`, `zi zI zo zO z0 zz zZ`, `{n}=`: zoom by `zoom-step` 10 % (config.c:387-398)       | Same keys and step; limits 10 % to 2500 % (pdf.js), not zathura's 10 % to 1000 %                                                                                  |
| `a` / `s`: best fit / fit width, kept on resize (config.c:290-291)                         | Same, through pdf.js's `page-fit` and `page-width`                                                                                                                |
| `d`: dual page; `D`: first page column (config.c:384-385)                                  | Same, through pdf.js's spread modes (shadows `d`, half page down; `ctrl+d` remains)                                                                               |
| `r`: rotate 90° clockwise, count (config.c:334)                                            | Same (shadows `r`, reload; `R` reloads)                                                                                                                           |
| `w`: single page mode (2026.x only, config.c:644)                                          | Same, through pdf.js's page scroll mode                                                                                                                           |
| `Tab`: index, replacing the view, with its own keys (config.c:381, 660-690)                | `Tab`: Vimma's outline panel beside the page, `INDEX` mode with zathura's keys, and a fuzzy filter on `/`. **Not matched:** the outline does not replace the page |
| Index: `j k`, arrows, `l h`, `zo zc`, `zO zC`, `L H`, `zR zM`, `ctrl+d ctrl+u` (661-680)   | Same keys in `index` mode                                                                                                                                         |
| Index: `space`, `Return`, `ctrl+j` follow; `gg G`; `Tab Esc ctrl+[ ctrl+c` close (681-690) | Same keys in `index` mode                                                                                                                                         |
| `q`: quit, in every mode (config.c:633-638)                                                | **Not matched:** `q` does not close the tab (`x`, `:q` do); in `index` mode `q` closes the outline, as it closes Vimma's overlays                                 |
| `ctrl+r`: recolour, `recolor-darkcolor` / `-lightcolor` (config.c:330, 529-530)            | **Not matched:** pages keep the document's colours (decision 12); `ctrl+r` reloads as on every page                                                               |
| `m{X}` / `'{X}`: marks with page, position, zoom, saved per file (marks.c:21-203)          | Same keys and contents, kept in memory only (decision 11)                                                                                                         |
| `/`, `?`, `n`, `N`, `[Search x/y]` in the status bar (2026.x, utils.c:734-736)             | Vimma's find, smart case, with `[x/y]` in the status bar                                                                                                          |
| `f` / `F` / `c`: numbered link hints typed in the input bar, Enter (shortcuts.c:39-57)     | Vimma's letter hints, no Enter needed. **Not matched:** numbers                                                                                                   |
| `F5`: presentation (config.c:642); `F11`: full screen (config.c:643)                       | Same keys (shadows `F5`, reload)                                                                                                                                  |
| `ctrl+n` / `ctrl+m`: toggle status bar / input bar (config.c:382-383)                      | **Not matched:** the status bar is always shown, `ctrl+n` is a new window                                                                                         |
| `R`: reload, keeping the position (config.c:332)                                           | `R` reloads; pdf.js restores the position from its view history (**unverified**, Tests)                                                                           |
| `o` / `O` / `alt+o`: open a file (config.c:300-301, 400)                                   | **Not matched:** `:open` takes a URL; a `file://` URL opens a local PDF                                                                                           |
| `Y`: copy the file path (config.c:368)                                                     | `Y` copies the PDF's URL, as `yy` does, since the URL is where the browser has the file                                                                           |
| `:print`, `:write`, `:info`, `:close`, `:quit` (config.c:753-785)                          | `ctrl+p` / `:print_page`, `ctrl+s` / `:save_page`, `:pdf_info`, `x` / `:q`                                                                                        |
| `:exec`, `:offset`, `:bmark`, `:jumplist`, `:set`, `:map`, `:dump`                         | **Not matched:** no programs run (Security); bookmarks are Vimma's (`ctrl+b a`), which keep pdf.js's `#page=` fragment; settings are config                       |
| Status bar: file, `[x/y]`, `[label (x/y)]`, optional percent (zathura.c:1595-1640)         | `page x/y`, `page label (x/y)`; the title and host as on any page                                                                                                 |
| Selection copies to the primary selection on mouse release (callbacks.c:612-645)           | Firefox's selection; `v` copy mode with `y` copies to the clipboard                                                                                               |
| SyncTeX: `--synctex-forward`, ctrl+click backward search over D-Bus (synctex.c, xml)       | **Not matched** in this spec (decision 14)                                                                                                                        |

## Research

### How Vimma reaches the viewer today

- Vimma's actor pair is registered with `matches` on `http`, `https`, `file` and `about` URLs and
  `allFrames` (`src/browser/base/content/vimma/actors/VimmaActors.sys.mjs:207-230`). An actor
  matches the document URI (`dom/ipc/WindowGlobalActor.cpp:221`,
  `dom/ipc/jsactor/JSWindowActorProtocol.cpp:320-358`), and the pdf.js document keeps the PDF's
  URL: the stream converter loads `resource://pdf.js/web/viewer.html` with
  `channel.originalURI = aRequest.URI` (`pdfjs/PdfStreamConverter.sys.mjs:18, 1597-1600, 1668`).
  So the actor already runs in the viewer, which a mochitest asserts
  (`the_actor_reaches_settings_and_the_pdf_viewer_but_not_data_urls`,
  `tests/browser/browser_vimma_insert_scroll.js:312-326`). A PDF shown from a
  `blob:` or `data:` URL gets no actor, as `docs/limits.md` already says of those schemes.
- Keys: the host's capturing `keydown` listener on the chrome window sees them before pdf.js
  (`host/VimmaHost.sys.mjs:9`); tab keys and the bindings overlay work over the viewer
  (`tests/browser/browser_vimma_tab_keys.js:288-305`, `browser_vimma_help_overlay.js:96-107`).
  Keys Vimma passes reach pdf.js's own `onKeyDown` (viewer.mjs:19444-19700), which binds `j`/`n`
  and `k`/`p` to next and previous page, `r` and `shift+r` to rotation, `s` and `h` to the select
  and hand tools, `F4` to the sidebar, `ctrl+alt+p` to presentation mode and `ctrl+alt+g` to the
  page field (viewer.mjs:19525-19545, 19586-19665, 19686-19690). Today Vimma's `j`, `k`, `n`, `r`
  and `h` shadow those.
- Scrolling: the child scrolls the largest scrollable element when the root does not scroll,
  which in pdf.js is `#viewerContainer` (`actors/VimmaChild.sys.mjs:1167-1180`).
- Find: pdf.js takes the find bar's events itself, so Vimma drives the find bar for a PDF
  (`host/find.mjs:72-73, 379-383`) and reads results from `browser.finder`, which pdf.js never
  reports to (`host/find.mjs:424-436`). That is why the count is missing. PdfJsParent sends the
  count only to the find bar (`fb.onMatchesCountResult`,
  `pdfjs/PdfJsParent.sys.mjs:801-848, 870-896`). The tests read pdf.js's find controller through
  `content.wrappedJSObject.PDFViewerApplication` (`tests/browser/browser_vimma_find.js:292-296`).
- Element focus refuses PDFs (`host/VimmaHost.sys.mjs:2455-2457`), and copy mode works there.

### What the viewer exposes

- `viewer.mjs:19713-19715` sets `window.PDFViewerApplication`, `PDFViewerApplicationConstants`
  and `PDFViewerApplicationOptions` on the viewer's window. Through it:
  - pages: `page` / `pagesCount` (viewer.mjs:18130-18147), `pdfViewer.currentPageNumber`,
    `currentPageLabel` (13447-13510), `pdfLinkService.goToPage`, which pushes a history entry
    first (1022-1037), `pdfViewer.nextPage` / `previousPage` (14889-14907),
    `pdfViewer.scrollPageIntoView` with an explicit `XYZ` destination for a position and zoom
    (14342);
  - zoom: `pdfViewer.currentScaleValue` (`"page-fit"`, `"page-width"`, `"auto"`,
    `"page-actual"` or a number, 13522), `increaseScale` / `decreaseScale({ steps })`
    (14908-14951), with `DEFAULT_SCALE_DELTA` 1.1, `MIN_SCALE` 0.1 and `MAX_SCALE` 25
    (viewer.mjs:28-32). pdf.js re-applies a named scale on resize;
  - layout: `pdfViewer.pagesRotation` (13533), `scrollMode` (`VERTICAL`, `HORIZONTAL`,
    `WRAPPED`, `PAGE`, 14692) and `spreadMode` (`NONE`, `ODD`, `EVEN`, 14735), with the enums at
    viewer.mjs:56-68. `EVEN` puts page 1 alone, as zathura's default `first-page-column` "1:2"
    does in dual page; `ODD` pairs 1 and 2;
  - the outline: `pdfDocument.getOutline()` returns a promise of the outline tree
    (`pdfjs/build/pdf.mjs:14667`), whose items carry `title`, `items`, `count` (negative when
    the entry starts collapsed, which pdf.js honours, viewer.mjs:7170-7194) and one target: a
    destination `dest` (a name, or an array whose first element is a page reference or index), a
    `url`, a named `action`, an `attachment` or a `setOCGState`. pdf.js's own outline view
    follows them with `pdfLinkService.goToDestination`, `executeNamedAction` and
    `executeSetOCGState` (viewer.mjs:964, 1197, 1228, 7104-7158), and finds the current entry by
    resolving each destination to a page with `pdfDocument.getDestination` and
    `cachedPageNumber` (viewer.mjs:7249-7322; pdf.mjs:14637, 14702), keeping the deepest entry
    per page. The sidebar (`viewsManager`, `switchView`, `open`, `close`, `toggle`, 17153,
    17257-17370) also holds the thumbnails, attachments and layers views (`SidebarView`,
    viewer.mjs:43-49), and `F4` toggles it (viewer.mjs:19663);
  - presentation: `requestPresentationMode()` (18880) and `pdfViewer.isInPresentationMode`
    (14546). The pdf.js principal may always request full screen, without user activation
    (`dom/base/Element.cpp:5151-5154`), so a call from Vimma's actor works although the key never
    reached the page. Firefox's full-screen warning should still be shown, as for any DOM full
    screen (**unverified:** the presentation mochitest checks for `fullscreen-notification`);
  - history: `PDFHistory` keeps positions as same-document `pushState` / `replaceState` entries
    with `#page=` fragments (viewer.mjs:6426, 6590-6645, 14456-14466) and restores them on
    `popstate` (6826), so browser back and forward move through jumps inside a PDF;
  - find: the controller dispatches `updatefindmatchescount` and `updatefindcontrolstate` on the
    event bus with `{ current, total }` (6205-6243);
  - properties: `pdfDocumentProperties.open()`; print: `triggerPrinting()` (18884).
- The event bus (`EventBus.on` / `off`, viewer.mjs:1281-1338) takes any function. Events in
  `allowedGlobalEvents` (`documentloaded`, `pagesloaded`, `layersloaded`, `outlineloaded`,
  `pdfjs/PdfStreamConverter.sys.mjs:328-333`) are also sent to chrome only, with
  `windowUtils.dispatchEventToChromeOnly` (`PdfStreamConverter.sys.mjs:802-815`). A content-side
  chrome listener receives them: pdf.js's own test listens on `docShell.chromeEventHandler`
  (`toolkit/components/pdfjs/test/browser_pdfjs_chrome_events.js:47-70`), and a JSWindowActor's
  `events` are registered on that same window root (`dom/ipc/jsactor/JSActorService.cpp:227-233`,
  `dom/base/nsWindowRoot.cpp:448`). So Vimma's child can wake on `pagesloaded` without polling. The viewer's own code sends these
  through `FirefoxCom.request("dispatchGlobalEvent", …)` (viewer.mjs:2235-2237), so script running
  in a compromised viewer can fire them at will.
- Firefox's own actor `PdfJs` (`browser/components/DesktopActorRegistry.sys.mjs:771-780`) talks to
  the viewer only by dispatching DOM events on its window: `find*`, `zoomin`, `zoomout`,
  `zoomreset`, `save`, `editingaction` (`pdfjs/PdfJsChild.sys.mjs:23-48`; listeners at
  viewer.mjs:1681-1758). That set has no page, fit, spread, rotation, outline or presentation
  event.

### Principal, process and CSP

- The viewer document gets a content principal for `resource://pdf.js/web/viewer.html` with the
  PDF request's origin attributes, and the PDF's own principal is kept as `noPDFJSPrincipal`
  (`PdfStreamConverter.sys.mjs:1676-1685`). Its origin therefore carries the request's suffix: in
  a Vimma workspace, which is a container, it is `resource://pdf.js^userContextId=N`.
  `nsContentUtils::IsPDFJS` tests the scheme and the origin without its suffix
  (`SchemeIs("resource")` and `originNoSuffix == "resource://pdf.js"`,
  `dom/base/nsContentUtils.cpp:8726-8734`). A PDF in a frame of a web page is converted the same
  way, so a frame can hold a document with that principal too.
  A `resource://` principal may load in any content process
  (`dom/ipc/ProcessIsolation.cpp:1561-1566`), so the viewer runs in an ordinary, sandboxed web
  content process.
- The viewer's CSP is
  `default-src 'none'; script-src resource: chrome: 'wasm-unsafe-eval'; style-src resource: chrome:; …`
  (`pdfjs/web/viewer.html:30-33`): no inline style elements or attributes, but style sheets from
  `chrome:` URLs load. `chrome://browser/content/` is registered `contentaccessible=yes`
  (`browser/base/jar.mn:5`), so a content document may load a sheet from there, and Vimma's files
  live under it (`chrome://browser/content/vimma/`). Setting a style through the CSSOM and adding
  elements with the DOM are allowed too, which pdf.js does itself (viewer.mjs:13828-13830).
- A PDF's own JavaScript runs in a separate sandbox (`pdfjs/PdfSandbox.sys.mjs`), gated by
  `pdfjs.enableScripting` (`PdfStreamConverter.sys.mjs:390`), not in the viewer's compartment.
  The viewer's compartment holds pdf.js code only, but it parses attacker-controlled files, and a
  pdf.js bug can let a PDF run script there: CVE-2024-4367, "Arbitrary JavaScript execution in
  PDF.js", a missing type check when handling fonts, rated high and fixed in Firefox 126
  (Mozilla's advisory MFSA 2024-21, mozilla.org/security/advisories/mfsa2024-21). Vimma therefore treats everything read from
  the viewer as untrusted, as it treats any page.

### Page colours

- `pdfjs.forcePageColors` (default `false`), `pdfjs.pageColorsBackground` (`"Canvas"`) and
  `pdfjs.pageColorsForeground` (`"CanvasText"`)
  (`toolkit/components/pdfjs/PdfJsDefaultPrefs.js:57, 62-63`) are read once when the viewer
  starts (viewer.mjs:17751-17755), so a change applies to PDFs opened afterwards. The filter they make (`addHCMFilter`,
  `toolkit/components/pdfjs/content/build/pdf.mjs:12843-12895`) converts each page to grey and
  maps it to six steps between the two colours, applied to the whole canvas after drawing
  (pdf.mjs:10441-10450). Forced colours are also on when the system is in a forced-colours (high
  contrast) mode (viewer.mjs:17751).

### about:pdf

- `about:pdf` is `chrome://global/content/aboutPDF.html`
  (`docshell/base/nsAboutRedirector.cpp:169-172`), reached from Tools → Edit PDF and the app
  menu (`cmd_editPDF`, `browser/base/content/browser-sets.js:148-150`), the address bar's quick action "edit pdf"
  (`browser/components/urlbar/QuickActionsLoaderDefault.sys.mjs:125-130`) and a notification in
  the viewer (`PdfJsParent.sys.mjs:249-263`). Its text uses `-brand-short-name`
  (`toolkit/locales/en-US/toolkit/about/aboutPDF.ftl:5, 20-22, 30`), so in Vimma it reads
  "Vimma PDF editor", "Make Vimma your go-to PDF editor" and "Vimma PDF tools". The viewer's
  notification "PDFs just got easier in Vimma" (`toolkit/about/pdfFeaturesNotification.ftl:5-8`)
  is shown at most `pdfjs.featuresNotificationImpressionLimit` times (default 2, shared with
  about:pdf, `pdfjs/PdfJsFeaturesNotification.sys.mjs:5-35`). Vimma does not touch any of these
  today (no `pdfjs` or `about:pdf` in `src/` or `configs/`).

### Vimma's keymap today

- Modes are a closed list (`packages/vimma-core/src/modes.mjs`), each with its own trie;
  `dispatch(mode, chord)` resets a pending sequence when the mode changes
  (`dispatcher.mjs:93-96`). `[modal.<mode>]` tables merge user entries over defaults per
  sequence, and a modal binding shadows a `[keys]` binding with the same sequence in its mode
  (`keymap.mjs:223-262`). Chords with ctrl, alt or meta and function keys are bound in every mode
  (`keymap.mjs:185-198`).
- No binding depends on the page today. The side panel and the bookmarks panel share `panel`
  mode, and the host ignores the actions that do not apply to one of them (`defaults.mjs`, the
  `panel` table's comments).
- Keys the PDF layer shadows in normal mode: `d` half page down (`defaults.mjs:186`), `H` / `L`
  history (194-195), `r` reload (204), `F` element focus (208), `P` open the clipboard in a new
  tab (233); `[keys]` `reload` on `f5` (121; its `ctrl+r` stays), `find_forward` on `ctrl+f`
  (155).
  `J`, `K`, `w`, `a`, `s`, `D`, `c`, `R`, `m`, `'`, `+`, `-`, `=`, `z…` and `Tab` are unbound.
- The status bar's find text already formats a count, `/query [3/41]`
  (`packages/vimma-core/src/find.mjs:32-38`); it needs only `current` and `total`.

## Design

### The layers

- **pdf.js** renders, lays out, finds, prints, saves and fills forms. Vimma does not change it.
- **The adapter** `actors/pdf-view.mjs`, in the content process, is the only code that touches
  pdf.js. `VimmaChild` loads it only in a top-level document whose principal passes Firefox's own
  pdf.js test (`schemeIs("resource")` and `originNoSuffix === "resource://pdf.js"`, so that it
  holds in every container). It exposes a small fixed set of operations (go to a page, zoom by steps or
  to a value or a fit, spread, scroll mode, rotate, outline open, close, move and follow, mark
  read and restore, outline read and follow an entry, presentation, properties) and a state record
  (`{ page, pages, label, scale, scaleValue, rotation, spread, scroll, presentation, outline,
find: { current, total } }`), sent to the parent on the viewer's events.
- **Core** (`packages/vimma-core/src/pdf.mjs`, pure): parses and bounds the state record,
  computes page targets from counts, zoom targets (`10 %` per step, `{n}=`), the next spread and
  scroll mode and mark records; `pdfoutline.mjs` parses and bounds the outline and runs the
  outline panel's keys and filter.
- **The host** (`host/pdf-ops.mjs`): decides whether a tab is the PDF viewer from the parent's own
  view of its top document (`browser.browsingContext.currentWindowGlobal.documentPrincipal`, with
  the same test), never from a report of the child; runs the `pdf.*` actions by sending one
  operation to that top document's actor; accepts state only from that actor; feeds the status bar
  and find; keeps marks; and opens the outline panel.
- **The outline panel** (`ui/pdf-outline.mjs`): a chrome panel in the side panel's slot, drawn
  from the parsed outline with `textContent` only and styled with the theme's tokens like the
  side panel and the pickers.
- **The keymap**: a `pdf` context over normal mode, and an `index` mode (decision 4).

### Decisions

1. **Build on pdf.js; no PDF engine of Vimma's own.** Vimma adds keys and status to the pdf.js
   viewer that Firefox ships and renders nothing itself, because pdf.js comes with a security
   sandbox (the PDF's script in its own sandbox, a restricted principal and CSP, Research) and
   Mozilla's security fixes with every Firefox release Vimma rebases on, and with forms, digital
   signatures, an accessible text layer, printing and annotation editing that Vimma would
   otherwise have to rebuild and keep secure. A second engine (MuPDF or poppler compiled in, or a
   zathura window embedded) would mean a second parser of untrusted files to patch and a second
   upstream to rebase, against the one-person upkeep budget in `plan.md` §1. Rejected: an
   embedded native viewer, for the same reasons and because it would not run in Firefox's content
   sandbox.
2. **Reach pdf.js from Vimma's own actor, with no upstream patch.** The child takes
   `this.contentWindow.wrappedJSObject.PDFViewerApplication` (an Xray waiver) after checking the
   document's principal, because the actor already runs in the viewer (Research), pdf.js puts
   that object on its window as its application's global, and Firefox's own pdf.js tests and
   Vimma's drive it the same way. It is not a documented API, which decision 3 answers. It
   subscribes to the event bus with functions made by `Cu.exportFunction`, so that pdf.js
   calls back into the actor without polling, and wakes on the chrome-only `pagesloaded` event.
   Rejected: the DOM events Firefox's `PdfJs` actor uses, because they cover only find, zoom,
   save and editing (Research); synthesizing pdf.js's own keys (`r`, `n`, `ctrl+alt+p`), because
   they cover a few operations, report no state and change with pdf.js's keymap; an upstream
   patch adding a message API to `PdfJsChild`, because the waiver needs no patch and ADR-003 asks
   for none where our own files suffice.
3. **One adapter module, held to pdf.js by a contract test.** Every property and method of pdf.js
   that Vimma uses is named in `actors/pdf-view.mjs` and nowhere else, and a mochitest asserts
   each one exists with the expected type on the pdf.js that the build ships, so that a pdf.js
   update that renames one fails CI in the upstream bump's pull request instead of breaking keys
   silently. pdf.js is vendored into Firefox and updated with Firefox releases
   (`toolkit/components/pdfjs/update.sh`), so a change arrives only through a bump, which runs the
   suite. Rejected: reaching into private fields (`_pages`, `#…`), because they change without
   notice; the adapter uses only the members listed in Research.
4. **A `pdf` keymap context over normal mode, and an `index` mode.** The keymap gains contexts:
   `trie(mode, context)` where context is `page` or `pdf`, and the `pdf` trie of normal mode is
   normal's entries with `[modal.pdf]` merged over them, as `[modal.normal]` merges over
   `[keys]`. `dispatch(mode, chord, context)` resets a pending sequence when the context changes,
   as it does for a mode. The host passes `pdf` while the selected tab (the focused pane's) is the
   PDF viewer, as the parent decides it from the top document's principal (The layers), and the
   tab is in normal mode; a pdf.js document in a frame never sets it, so that a web page cannot
   change which bindings the user's keys have. Reason: the tab is still in normal mode, so insert
   mode, hints, copy mode, `Esc`, the status bar's `NORMAL` badge and every check of
   `mode === "normal"` in the host stay as they are; only which binding a key has changes. The
   outline is a real mode, `index`, like `panel`, because its keys mean something else and `Esc`
   leaves it. This changes the dispatcher's contract, so ADR-023 records it (`plan.md` §4,
   "Design"). Rejected: a `pdf` mode that replaces normal, because every host path that tests for
   normal mode would need a second case; host-side branching on the same actions (`G` meaning a
   page only in a PDF), because `d`, `r`, `H` and `L` would then need two names in one action and
   `ctrl+b ?` could not show which meaning applies where.
5. **zathura's meaning wins on the keys it shares, in the PDF viewer only.** Where zathura and
   Vimma's normal mode bind the same key differently (`d`, `H`, `L`, `r`, `P`, `F`, `ctrl+f`,
   `F5`), the `pdf` context takes zathura's, because a zathura user expects them in a PDF and
   each displaced action keeps a key there (`ctrl+d`, `ctrl+o` / `ctrl+i`, `R` and `ctrl+r`,
   `p`, `/`). `ctrl+r`, zathura's recolour, keeps Vimma's meaning, reload, because Vimma does not
   recolour pages (decision 12). `Tab`, unbound on pages, opens the outline; `shift+Tab` still
   moves focus through pdf.js's toolbar. The prefix layer and `ctrl+b` are never shadowed,
   because they must work in every mode. Keys free in both are given zathura's meaning, and any
   key is one `[modal.pdf]` line away. Rejected: Vimma's meaning on the shared keys, with dual
   page and rotation on other keys, because the viewer would then behave as zathura only in
   part; a `[pdf] keys = "zathura" | "vimma"` switch, because `[modal.pdf]` already lets a user
   change any key and a switch doubles the bindings to document and test.
6. **Counts are physical page numbers.** `{n}G`, `{n}gg` and `:{n}` go to the nth page, counting
   from 1, because zathura's do (Research, zathura table) and because a count is typed without
   knowing the labels. The status bar shows the label when it differs, so the number to type is
   visible. A count beyond the last page goes to the last page, as Vim's `G` does with a line
   number past the end.
7. **Zoom and fit use pdf.js's scale values.** `a` sets `page-fit` and `s` `page-width`, so
   that pdf.js keeps the fit on resize as zathura keeps its adjust mode; `+` / `-` step by a factor
   of 1.1 per count, pdf.js's own step and zathura's 10 %, and clamp to pdf.js's 10 % to 2500 %;
   `{n}=` sets `n / 100`. A manual zoom leaves the fit, as in zathura.
8. **Dual page is pdf.js's spread mode.** `d` toggles `NONE` and the last spread (`EVEN` the first
   time), and `D` toggles `EVEN` and `ODD`, so that the first page stands alone by default as in
   zathura's `first-page-column` "1:2". `w` toggles `scrollMode` `PAGE` and the previous mode.
   These are pdf.js's own view settings, which it remembers per document in its view history, so
   Vimma keeps no layout state.
9. **The jump list is session history.** pdf.js records link, outline and page jumps as
   same-document history entries (Research), so `ctrl+o` / `ctrl+i` (`history.back` /
   `history.forward`) already walk them and then leave the PDF. Vimma adds an entry before the
   jumps pdf.js does not record (a search hit from `n` / `N` or `Enter`, a mark, `H` / `L` / `P`
   do not jump), by calling `pdfHistory.pushCurrentPosition()` first, so that every jump zathura
   records is in the list. Reason: one history for the tab, which `H`, `L` and the back button
   already use on every other page. Rejected: a jump list of Vimma's own, because it would
   disagree with the back button.
10. **The outline is a Vimma panel, driven by `index` mode.** `Tab` asks the adapter for the
    outline and opens it in Vimma's outline panel, in the side panel's slot on the left of the
    window (one panel at a time there, as with the bookmarks panel), styled with the theme's
    tokens as the side panel and the pickers are; the tab enters `index` mode, whose default keys
    (`[modal.index]`) are zathura's index keys. `/` switches the panel to a filter that works as
    the pickers' search mode (`core/picker.mjs`): typed characters go to the query, matching is
    the pickers' fuzzy matching with highlight ranges, and `Esc` returns to the tree. Reason: the
    PDF viewer follows Vimma's design, so its outline looks and is keyed like Vimma's other panels
    and follows the Vimma or Omarchy theme, and a filter finds a section of a long outline faster
    than walking the tree, which zathura's index cannot. Rejected: pdf.js's sidebar driven by
    `index` mode, because it keeps pdf.js's look, has no filter, and marking its current entry
    needs a Vimma style sheet inside the viewer; a picker over the page, because zathura's index
    stays in view while it is used, and a panel beside the page is the closest Vimma has.
    - **Reading.** On the first `Tab` in a document the adapter calls `pdfDocument.getOutline()`,
      only after the principal check of decision 2, and walks the tree in the content process. It
      keeps each entry's target in the child and sends the parent, in document order, only
      `{ title, level, page, kind, collapsed }` per entry, plus `url` for a URL entry. `page` is
      the 1-based page the destination resolves to, resolved as pdf.js resolves its current entry
      (Research), or 0 when it does not resolve; `kind` is `dest`, `url`, `action`, `attachment`
      or `ocg`; `collapsed` is the entry's negative `count`. Destinations themselves (names and
      page references) never leave the content process, because the parent needs only a page
      number to select the current entry, and following an entry by its index keeps the parent's
      messages to operation names and numbers (V7).
    - **Bounds.** The child stops at 5000 entries, the hint reply's target limit
      (`HINT_REPLY_MAX_TARGETS`, `core/hints.mjs:255`), and at a nesting depth of 32, and marks
      the message truncated. Core's `parsePdfOutline` drops the whole message when any bound
      fails: more entries than the limit, a title over 512 characters (`HINT_REPLY_MAX_TEXT`), a
      URL over 8192 characters (`HINT_REPLY_MAX_HREF`), a page outside 0 to the page count, an
      unknown kind, or a level over 32 or more than one deeper than its predecessor's. It strips control and
      format characters (Unicode categories Cc and Cf) from titles, as from page labels (V6), and
      collapses runs of white space. A truncated outline ends with the row
      `outline truncated at 5000 entries`. Reason: an outline is text the PDF's author controls
      that now reaches chrome, so it is bounded as hint text is; real outlines stay well under
      these limits.
    - **Following.** `Enter` sends the entry's index, and the adapter follows it as pdf.js's own
      outline does: `goToDestination` for a destination, which records a history entry
      (decision 9), `executeNamedAction` for a named action, and `executeSetOCGState` for a layer
      change. The parent opens a URL entry under §4, as it opens a link chosen with `f`. An
      attachment entry shows the notice `open attachments from pdf.js's sidebar (F4)`, because
      opening an attachment goes through pdf.js's download path, which Vimma does not drive.
    - **Current entry and expansion.** On opening, the panel selects the deepest of the last
      entries whose page is at or before the current page, as pdf.js does, and expands the path to
      it; other entries start expanded or collapsed as the document's `count` says.
    - **Lifetime.** The parsed outline is kept in the parent, in memory, for the tab's current
      document, so that a second `Tab` opens at once; it is dropped when the tab navigates or
      closes, and never written. The panel closes when its tab stops being the selected tab of
      the focused pane, because the outline belongs to one document.
    - **pdf.js's sidebar stays.** Vimma neither hides nor changes pdf.js's sidebar, which keeps
      the thumbnails, attachments and layers views and pdf.js's own outline view for the mouse,
      reached with `F4` (which Vimma does not bind, so it reaches pdf.js) or the toolbar. Reason:
      Vimma has no thumbnails, attachments or layers views of its own, and hiding only the outline
      view would need a style sheet inside the viewer, which nothing else in this spec needs; with
      none, Vimma adds nothing to the viewer's document.
11. **Marks in memory, per document.** A mark stores `{ page, left, top, scale }` from pdf.js's
    current location, keyed by the document's URL without its fragment, in the host, for the
    session; `'x` restores it with `scrollPageIntoView` and an `XYZ` destination after a history
    entry. Reason: marks are reading positions, and Vimma keeps what it learns about a page in
    memory, as live grep keeps page text (`docs/security.md` §15). In the private workspace marks
    live with its windows and go when it closes. zathura saves marks and its jump list per file;
    Vimma does not, because saving them would keep a list of the PDFs read in the profile, a
    history Vimma keeps nowhere else, and Firefox's session restore already reopens a PDF at its
    page. Rejected: marks saved per PDF URL in the profile, for that reason.
12. **Pages are shown as the document draws them.** Vimma does not recolour PDF pages: it adds no
    filter or style to the viewer and sets no `pdfjs.*` colour pref, and `ctrl+r` keeps its
    meaning, reload (decision 5). Reason: a document's colours are its content (figures,
    highlights, colour-coded charts), and Vimma's theming applies to Vimma's own surfaces around
    it: the outline panel, the status bar and notices. pdf.js's forced page colours stay as
    Firefox ships them, so they still apply under the system's forced-colours (high contrast)
    mode (Research), an accessibility setting of the system rather than a theme. Rejected:
    zathura's recolour on `ctrl+r` in the theme's colours, for the reason above;
    `pdfjs.forcePageColors`, for the same reason, and because it is read once per viewer and
    posterizes pages to six grey steps (Research).
13. **Status bar and find.** The adapter reports the page, page count, label and match count on
    pdf.js's `pagechanging`, `updatefindmatchescount` and `updatefindcontrolstate` events; the
    status bar shows `page x/y` (or `page label (x/y)`) beside `tab` and `pane`, in Vimma's
    style rather than zathura's `[x/y]`, so that the bar reads the same in every tab, and the find
    segment gets `current` and `total` with the limit Firefox uses for pages
    (`accessibility.typeaheadfind.matchesCountLimit`, as `PdfJsParent.sys.mjs:48-49, 884-897`).
    Rejected: reading the find bar's localized label, or wrapping its `onMatchesCountResult`, because one
    parses translated text and the other changes a Firefox widget's method.
14. **SyncTeX is not in this spec.** Forward search (an editor asks the viewer to show a source
    line) would need a control-socket command that opens a PDF at a page and a rectangle, and a
    SyncTeX parser in core to map `line:column:file` to them; backward search (`ctrl+click`)
    would need Vimma to report a page position to the editor. Vimma runs no programs
    (Security), so backward search would go out through `vimma-ctl`, which needs its own design
    and security review. Reason: neither is needed for zathura's keys and both widen the
    control socket's surface, so they get a spec of their own once this one is built.
15. **Presentation is pdf.js's.** `F5` calls `requestPresentationMode()`, which pdf.js's
    principal may do without user activation (Research). Vimma calls it only for the user's `F5`
    (or its binding) in the PDF viewer, so that it gives no page a way to go full screen. While `isInPresentationMode`, the
    adapter turns Vimma's scroll and page actions into `nextPage` / `previousPage`, because pdf.js
    shows one page at a time there and scrolling has no meaning; `Esc` and `F5` leave it.
16. **Hints on PDF links.** pdf.js draws link annotations as `<a>` elements in its annotation
    layer, so `f` labels them with the existing collector; `F` and `c` are two hint actions,
    `hint.show_target` and `hint.copy_target`, which return the chosen link's `href` through the
    parser that already checks hint replies (`parseHintReply`, `core/hints.mjs:265`) and show or
    copy it as text. An internal link's target is shown as `page 12` from the destination pdf.js
    resolves. **Unverified:** that the collector labels pdf.js's internal links, whose `href` is
    a fragment with a click handler. Check: the links mochitest in Tests.
17. **about:pdf stays; the viewer's promotion is off.** `firefox-branding.js` sets
    `pdfjs.featuresNotificationImpressionLimit` to 0, so that the "PDFs just got easier" bar never
    covers a document; `about:pdf` and its menu entries stay as Firefox ships them, and the guide
    names pdf.js as Mozilla's viewer that Vimma drives. Reason: the notification is the only part
    that interrupts reading, the page's wording ("Vimma PDF tools") is true because Vimma ships
    those tools, and a pref costs no patch. The impression budget is shared, so the notification
    on `about:pdf` itself goes too (Research). Rejected: rewording `aboutPDF.ftl`, or hiding
    `about:pdf` and its entry points, because each needs an upstream patch rebased with every
    release for wording that is already accurate.

## Security and privacy

New surface: Vimma's content actor now reads from and calls into the pdf.js viewer through an Xray
waiver, and the viewer parses untrusted files. The outline panel brings text the PDF's author
controls (outline titles and URLs) into chrome, as page titles and hint text already are. The
design keeps the same trust model as for any page: the child runs in the sandboxed content
process, holds no chrome privilege beyond its own, and the parent believes nothing the child says
without a check. A compromised viewer (Research,
CVE-2024-4367) is treated as a hostile page that also controls every pdf.js function and event
the adapter touches.

`docs/security.md` gets a section in its format, with these rules and the tests that enforce them
(each listed under Tests):

> ## 18. The PDF viewer (`actors/pdf-view.mjs`, `host/pdf-ops.mjs`)
>
> Vimma drives Firefox's pdf.js viewer through its content actor. Spec:
> [pdf-mode](specs/pdf-mode.md).
>
> **Reach:** the PDF being viewed, through pdf.js, which it may compromise; web pages, which can
> define `PDFViewerApplication` or frame a PDF.
>
> - V1. The adapter **must** waive Xrays only in a top-level document whose principal passes
>   `schemeIs("resource")` and `originNoSuffix === "resource://pdf.js"`, in every container;
>   never on the content type, the URL or the presence of `window.PDFViewerApplication`.
>   `a_page_that_defines_PDFViewerApplication_gets_no_pdf_keys`,
>   `pdf_keys_work_in_a_workspace_container`
> - V2. The parent **must** decide the `pdf` context from the top `WindowGlobalParent`'s
>   `documentPrincipal` with the same test, and **must** accept state only from the actor of that
>   window global; a pdf.js document in a frame, `<embed>` or `<object>` **must not** set the
>   context or report state. `a_pdf_in_a_frame_gets_no_pdf_context`
> - V3. Objects the child passes into pdf.js **must** be made with `Cu.cloneInto` into the
>   viewer's window, as `PdfJsChild` does (`pdfjs/PdfJsChild.sys.mjs:24`), or be functions made
>   with `Cu.exportFunction`; no chrome object **may** be passed in.
>   `the_adapter_passes_only_cloned_options`
> - V4. Exported callbacks **must** read their arguments through Xrays, never waived, and only
>   the fields they need; the child **must** keep only values whose `typeof` is `number`,
>   `boolean` or `string` before `sendAsyncMessage`, and **must not** `await` a value returned by
>   pdf.js. An asynchronous result (the outline, a named destination's page) **must** come back
>   only through a `Cu.exportFunction` callback passed to that promise's `then` through Xrays,
>   read by the same rules as an event callback. `a_hostile_viewer_gets_only_primitives_through`
> - V5. Bursts of pdf.js callbacks and of chrome-only events (`pagesloaded` and the others, which
>   the viewer itself can fire through `FirefoxCom.request("dispatchGlobalEvent")`) **must** be
>   coalesced to at most one state message per 100 ms per tab.
>   `a_flood_of_pagesloaded_is_coalesced`
> - V6. The parent **must** parse every state record with `parsePdfState`, which bounds every
>   number, caps the page label at 32 characters and strips control and Unicode format characters
>   (category Cc and Cf: bidirectional overrides and isolates, zero-width characters), and the
>   status bar **must** draw it as text. `pdf state outside its bounds is dropped`,
>   `a page label cannot carry bidi or zero-width characters`
> - V7. The parent **must** send the child only operation names and numbers; no script, CSS text
>   or markup **may** go into the viewer; an outline entry is followed by its index, and its
>   destination stays in the child. `the_parent_sends_only_operations_and_numbers`
> - V8. The adapter **must** read the outline only on the user's `Tab` in the PDF viewer, and send
>   only each entry's title, level, page number, kind, collapsed flag and, for a URL entry, its
>   URL, never a destination. The parent **must** parse the message with `parsePdfOutline`, which
>   drops it when it holds more than 5000 entries, a level deeper than 32 or more than one step
>   below the previous entry's, a title over 512 characters, a URL over 8192, a page outside the
>   document or an unknown kind, and strips control and format characters (Cc, Cf) from titles.
>   The outline panel **must** set titles with `textContent` (§6, C1), and a URL entry, like a
>   link target from `F` or `c`, **must** be shown and copied as text and opened only under §4.
>   `the_outline_is_read_only_on_the_users_key`, `an_outline_outside_its_bounds_is_dropped`,
>   `outline_titles_with_html_stay_text`, `an_outline_url_opens_only_under_section_4`
> - V9. Presentation mode **may** go full screen without user activation, as Firefox allows the
>   pdf.js principal (`dom/base/Element.cpp:5151-5154`); Vimma **must** request it only for the
>   user's own key in the PDF viewer, so it adds no spoofing surface: a page cannot reach it, and
>   Firefox's full-screen warning still shows. `presentation_only_on_the_users_key`
> - V10. Vimma **must not** write any `pdfjs.*` pref other than
>   `pdfjs.featuresNotificationImpressionLimit`, which it sets to 0, and never one
>   that changes scripting, fetching or sandboxing (`pdfjs.enableScripting`, `pdfjs.disabled`).
>   `pdf_mode_writes_no_pdfjs_prefs`
> - V11. Marks and the parsed outline **must** stay in memory, and the outline **must** be dropped
>   when its tab navigates or closes. `pdf_marks_and_outlines_are_not_written`

Section 13's page-mode rules apply unchanged. The PR that adds the adapter and the PR that adds
the outline panel each get a review by a fresh agent before they merge, as every content-actor
change does. No new disk writes, and
`vimma-ctl state` does not report the page or its label unless a later spec adds them.

## Tests

- **Vitest** (`packages/vimma-core`):
  - `keymap.test.mjs`: a `pdf` trie is normal's with `[modal.pdf]` over it; a user's
    `[modal.normal]` binding shows in `pdf` unless `[modal.pdf]` binds the same sequence;
    `[unbind] pdf` removes only there; `[modal.pdf]` cannot shadow the prefix; `[modal.index]` is
    a mode table.
  - `dispatcher.test.mjs`: a context change resets a pending sequence and a count; the same key
    gives the `pdf` action with context `pdf` and the normal one with `page`.
  - `pdf.test.mjs`: `parsePdfState` accepts a full record and drops out-of-range numbers, a page
    past the count, a label over 32 characters (`pdf state outside its bounds is dropped`); it
    strips control and format characters from a label, such as U+202E and U+200B (`a page label
cannot carry bidi or zero-width characters`); page targets for
    `G`, `12G`, `12gg`, `99G` on 12 pages, `3J` near the end; zoom steps with counts and the
    clamps, `150=`; spread toggles `d` and `D` from each mode; mark records keyed without the
    fragment.
  - `pdfoutline.test.mjs`: `parsePdfOutline` accepts a full outline and drops one with 5001
    entries, a level of 33 or a skipped level, a 513-character title, an 8193-character URL, a
    page past the count or an unknown kind (`an outline outside its bounds is dropped`); it strips
    U+202E and U+200B from titles and collapses white space; the panel's keys: `j`, `k`, `l`, `h`,
    `zo`, `zc`, `zO`, `zC`, `L`, `H`, `zR`, `zM`, `gg`, `G`, `ctrl+d`, `ctrl+u`, `Enter`, `Esc`;
    the current entry for a page (the deepest of the last entries at or before it) with its path
    expanded; negative `count` starts collapsed; `/` filters fuzzily, best match first with
    ancestor titles, `Esc` returns to the tree; a truncated outline's last row.
  - `statusbar.test.mjs`: `page 3/12`, `page iv (4/120)`, nothing outside a PDF; the find
    segment with a PDF's count.
  - `help.test.mjs` and the help snapshot: `[pdf]` and `[index]` headings.
- **Mochitest** (`tests/browser/browser_vimma_pdf_*.js`, with `file_vimma_test.pdf` and a new
  `file_vimma_outline.pdf` with an outline, labels, two link kinds and a form field):
  - `the_adapter_matches_the_shipped_pdfjs`: every member `pdf-view.mjs` uses exists with its
    type (decision 3).
  - `a_page_that_defines_PDFViewerApplication_gets_no_pdf_keys`: an HTML page that defines the
    name gets no adapter and no `pdf` context.
  - `pdf_keys_work_in_a_workspace_container`: a PDF in a tab with a `userContextId` gets the
    adapter and `12G` works.
  - `a_pdf_in_a_frame_gets_no_pdf_context`: a web page with the PDF in an `<iframe>` and in an
    `<embed>` keeps the page's bindings, and a state message from the frame's actor is dropped.
  - `the_adapter_passes_only_cloned_options`, `a_hostile_viewer_gets_only_primitives_through`,
    `a_flood_of_pagesloaded_is_coalesced`: the test replaces pdf.js members with
    hostile ones (getters, objects with `then`, a callback argument with a chrome-looking
    object) and fires `pagesloaded` a thousand times; the parent receives only bounded
    primitives, at the coalesced rate.
  - `pages`: `J`, `K`, `3J`, `gg`, `G`, `2G`, `:2`, `H`, `L`, `P`, `Home`, `End`, `ctrl+f`,
    `space` and `shift+space` land on the expected page and position; the status bar follows.
  - `zoom_and_fit`: `+`, `-`, `zI`, `zO`, `zZ`, `2+`, `=`, `150=`, `a`, `s`, and the fit kept after
    a pane resize.
  - `layout`: `d`, `D`, `w`, `r`, `2r`.
  - `index_mode`: `Tab` opens the outline panel on the left with the current entry selected, in
    the side panel's slot (an open side panel or bookmarks panel gives way); `j`, `k`, arrows,
    `l`, `h`, `zo`, `zc`, `zO`, `zC`, `L`, `H`, `zR`, `zM`, `gg`, `G`, `ctrl+d`, `ctrl+u`;
    `Enter`, `space` and `ctrl+j` jump and close, and `ctrl+o` returns; `Tab`, `Esc`, `ctrl+[`,
    `ctrl+c` and `q` close without moving; `/` and a word filters and `Enter` jumps; a named
    destination, a named action and a URL entry are each followed; an attachment entry shows its
    notice; a PDF without an outline says so; switching tabs closes the panel;
    `the_outline_is_read_only_on_the_users_key` (no outline message before `Tab`);
    `outline_titles_with_html_stay_text` (a title `<img src=x onerror=…>` is text);
    `an_outline_url_opens_only_under_section_4` (a `javascript:` URL entry does not run);
    `the_parent_sends_only_operations_and_numbers`.
  - `outline_follows_the_theme`: the panel's colours are the theme's tokens with a built-in theme
    and with an Omarchy theme (screenshots of both in the PR).
  - `jumps`: `ctrl+o` after `2G`, after a link, after `n`, after `'a`, then leaving the PDF.
  - `marks`: `ma`, move, `'a`; `'b` unset; marks shared by two tabs of one PDF;
    `pdf_marks_and_outlines_are_not_written` (no new file in the profile).
  - `pages_keep_their_colours`: `ctrl+r` in the PDF viewer reloads, and after a theme change
    Vimma has added no element, attribute or style sheet to the viewer's document.
  - `find_count`: `/` in a PDF shows `[current/total]` and `n` updates it.
  - `links`: `f` labels an external and an internal link (decision 16's check), `F` shows the
    target, `c` copies it.
  - `presentation`: `F5` enters, `j` and `space` turn pages, `Esc` leaves; Firefox's
    full-screen notification is shown; `presentation_only_on_the_users_key` (a message from the
    content process asking for it does nothing).
  - `files_and_urls`: `ctrl+p` opens the print dialog for the PDF, `ctrl+s` starts pdf.js's save
    (its download, as the toolbar's button does), `yy` and `Y` copy the PDF's URL, and
    `:pdf_info` opens pdf.js's document properties.
  - `reload_keeps_the_position`: `R` reloads and pdf.js restores the page (the **unverified**
    row of the zathura table).
  - `form_fields_are_insert_mode`.
  - `pdf_mode_writes_no_pdfjs_prefs`, and the features notification is not shown in the viewer
    (`pdfjs.featuresNotificationImpressionLimit` is 0).
  - `keys_on_web_pages_are_unchanged`: `d`, `H`, `r`, `F5` keep their normal meanings on a page.
- **e2e:** one scenario that opens a PDF, sends `12G` and `Tab` through the control socket and
  checks the state and a screenshot baseline of the outline panel, with its changelog line.

## Docs and changelog

- `docs/guide.md`: a new section "PDF viewer" under "The two layers", with the keys of Behaviour,
  the zathura table's "not matched" rows in prose, and a line that pdf.js is Mozilla's viewer
  that Vimma drives; "Find" loses nothing and gains the PDF count; "Status bar" names the page
  segment; "Link hints" mentions PDF links; "Features at a glance" gets one line; the
  `config.toml` section documents `[modal.pdf]` and `[modal.index]`; a line says that pages are
  shown in the document's own colours.
- `docs/limits.md`: the Find line about the PDF count goes; new lines for the zathura features
  not matched that a user would look for (SyncTeX, saved marks and jumps, `ctrl+b` full-page
  up, recolouring), and for PDFs from `blob:` and `data:` URLs.
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml`: regenerated by each keymap PR.
- `docs/security.md`: section 18 (Security and privacy).
- `docs/adr/023-keymap-contexts.md`: new, with delivery PR 1.
- `CHANGELOG.md` [Unreleased]: added by the maintainer at merge time, except the lines for the
  help snapshot and the e2e baseline, which the PRs that change them add.

## Delivery

Keymap changes go one pull request at a time, each regenerating the bindings docs and the help
snapshot with a screenshot of the `ctrl+b ?` overlay (`plan.md` §6, item 8), so PRs 3 to 5 merge
in order and none runs beside another keymap PR.

1. **feat(keymap): keymap contexts.** Core only: `trie(mode, context)`, the dispatcher's context
   argument, `[modal.pdf]` and `[modal.index]` accepted (empty by default), the `index` mode,
   ADR-023. The host passes `page` everywhere. No binding changes.
2. **feat(pdf): page and match count in the status bar.** The adapter with its principal check
   and contract test, `parsePdfState`, the host's context switch to `pdf`, the status bar's page
   segment and the find count; `docs/limits.md` loses its PDF find line; `docs/security.md`
   section 18. Needs the fresh-agent review. No binding changes.
3. **feat(keys): zathura's page, zoom and layout keys in the PDF viewer.** `J`, `K`, `gg`, `G`,
   counts, `:{n}`, `H`, `L`, `P`, `ctrl+f`, `+`, `-`, `=`, `zi`, `zI`, `zo`, `zO`, `z0`, `zz`,
   `zZ`, `{n}=`, `a`, `s`, `d`, `D`, `w`, `r`, `R`, `Y`, `F5`, presentation, history entries
   before search jumps, the guide section.
4. **feat(keys): the outline panel on `Tab` (`index` mode).** The adapter's outline read and
   follow, `parsePdfOutline`, the panel with its filter, screenshots in a built-in and an Omarchy
   theme, and V8 in `docs/security.md` section 18. Needs the fresh-agent review.
5. **feat(keys): marks and link keys in the PDF viewer.** `m`, `'`, `F`, `c`.
6. **chore(branding): turn off the PDF viewer's features notification.**
   `pdfjs.featuresNotificationImpressionLimit = 0` (decision 17). Independent of the others.

The spec becomes `implemented` with the last of these.

## Open questions

None. The answers are decisions in Design: 5 (shared keys), 10 (the outline panel), 11 (marks in
memory), 12 (no recolouring) and 17 (about:pdf).

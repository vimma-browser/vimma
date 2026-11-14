## 20. The PDF viewer (`actors/pdf-view.mjs`, `host/pdf-ops.mjs`, `host/outline-ops.mjs`)

Vimma drives Firefox's pdf.js viewer through its content actor: it reads the page, page count,
page label and find count to show them in the status bar, chooses the PDF viewer's key
bindings, sends the viewer the page, zoom, layout and presentation operations those keys run,
reads the document's outline into a chrome panel (once when a PDF opens in the selected tab, and
on the user's `Tab`), gives the viewer's own toolbar, find bar and menus the theme's colours
through two style sheets, keeps marks (positions in
a document) in the parent's memory, and shows or copies a link's target on `F` and `c`. Spec:
[pdf-mode](../specs/pdf-mode.md).

**Reach:** the PDF being viewed, through pdf.js, which a malformed PDF may compromise (pdf.js
parses untrusted files, and CVE-2024-4367 let a PDF run script in the viewer); web pages, which
can define `PDFViewerApplication` or frame a PDF. A compromised viewer is treated as a hostile
page that also controls every pdf.js function and event the adapter touches. A compromised
content process can claim pdf.js's principal for its top document, as it can claim any
principal; that gives it no more than in-bounds status text and the user's own `[modal.pdf]`
bindings, so it is accepted here.

- V1. The adapter **must** waive Xrays only in a top-level document whose principal passes
  `schemeIs("resource")` and `originNoSuffix === "resource://pdf.js"`, Firefox's own test
  (`nsContentUtils::IsPDFJS`), so that it holds in every container; never on the content type,
  the URL or the presence of `window.PDFViewerApplication`.
  [`a_page_that_defines_PDFViewerApplication_gets_no_pdf_keys`](../../tests/browser/browser_vimma_pdf_status.js),
  [`pdf_keys_work_in_a_workspace_container`](../../tests/browser/browser_vimma_pdf_status.js)
- V2. The parent **must** decide the `pdf` keymap context from the top `WindowGlobalParent`'s
  `documentPrincipal` with the same test, and **must** accept state only from the actor of that
  window global; a pdf.js document in a frame or `<embed>` **must not** set the context or
  report state. A document that only inherits pdf.js's principal (an `about:blank`, `blob:` or
  `data:` page the viewer opens) is not the viewer: the parent also requires an `http`, `https`
  or `file` document URI, which the viewer keeps from the PDF it shows.
  [`a_pdf_in_a_frame_gets_no_pdf_context`](../../tests/browser/browser_vimma_pdf_status.js)
- V3. The adapter **must** pass pdf.js only functions made with `Cu.exportFunction`, arrays and
  objects of primitives made with `Cu.cloneInto` into the viewer's window as `PdfJsChild` does (a
  mark's `XYZ` destination and the history and scroll arguments that go with it, an internal
  link's explicit destination read from its fragment), or an outline entry's target
  that pdf.js itself gave it (V8); no chrome object **may** be passed in.
  [`a_hostile_viewer_gets_only_primitives_through`](../../tests/browser/browser_vimma_pdf_status.js)
- V4. Exported callbacks **must** read their arguments through Xrays, never waived, and only the
  fields they need; the child **must** keep only values whose `typeof` is `number`, `boolean` or
  `string` before `sendAsyncMessage`, and **must not** `await` a value returned by pdf.js. An
  asynchronous result (the outline, the named destinations, the page of a link's named
  destination) **must** come back only through a
  `Cu.exportFunction` callback passed to the promise's own `then` seen through Xrays, so that a
  viewer's object with a `then` of its own is never called; the result is read by the same rules.
  [`a_hostile_viewer_gets_only_primitives_through`](../../tests/browser/browser_vimma_pdf_status.js),
  [`a_hostile_outline_gets_only_primitives_through`](../../tests/browser/browser_vimma_pdf_outline.js)
- V5. Bursts of pdf.js callbacks and of chrome-only events (`pagesloaded`, which the viewer can
  fire at will through `FirefoxCom.request("dispatchGlobalEvent")`) **must** be coalesced to at
  most one state message per 100 ms per document.
  [`a_flood_of_pagesloaded_is_coalesced`](../../tests/browser/browser_vimma_pdf_status.js)
- V6. The parent **must** parse every state record with `parsePdfState`, which bounds every
  number, drops a page label over 32 characters and strips control and Unicode format characters
  (categories Cc and Cf: bidirectional overrides and isolates, zero-width characters), and the
  status bar **must** draw it as text. The record's `drawn` flag and size are read by the
  adapter from the viewer's DOM and window through Xrays (from the current page outward, each
  page's `data-loaded` attribute and `loadingIcon` class; `innerWidth`, `innerHeight` and
  `devicePixelRatio`), its operation count is the actor's own, and they feed only the control
  socket's `state.pdf` flag (S9). The record's `zoom` is the viewer's browsing-context
  `fullZoom` and **must** be a finite number from 0.01 to 100, or the record counts as not
  drawn; the parent takes a report as drawn only when that zoom equals its own
  `browser.browsingContext.fullZoom` exactly, so a forged zoom can only make `state.pdf` read
  not drawn. The adapter also reports no page as drawn until its resize listener has seen the
  window's present size and pixel ratio.
  [`pdf state outside its bounds is dropped`](../../packages/vimma-core/test/pdf.test.mjs),
  [`a page label cannot carry bidi or zero-width characters`](../../packages/vimma-core/test/pdf.test.mjs),
  [`a report with no usable zoom is never drawn`](../../packages/vimma-core/test/pdf.test.mjs),
  [`a_full_zoom_change_is_not_drawn_until_the_viewer_redraws`](../../tests/browser/browser_vimma_pdf_status.js)
- V7. The parent **must** send the viewer only operations: a name from `PDF_OPS` and one bounded
  integer, checked by `parsePdfOp` in the parent before sending and again in the child before the
  adapter touches pdf.js; `go` (a mark) also carries a position, exactly four bounded numbers
  (`parsePdfPosition`), which is also how the parent checks the position the viewer reports when a
  mark is set. No script, markup or object **may** go into the viewer, and no CSS text other than
  the theme's token sheet under V12. `F` asks for an
  internal link's page by the hint's generation and index only, and the parent keeps the answer only
  when it is a page of the document. The adapter passes pdf.js only those numbers and its own fixed
  strings (`page-fit`, `page-width`, a mark's `XYZ`, cloned under V3), and measures the page for `H`, `L`, `P` and `ctrl+f` through
  Xrays (the viewer's container and page elements), so none of the viewer's script runs for it. In
  presentation mode the scroll keys (`Vimma:Scroll`) turn pages through the same checked operations,
  and fall back to scrolling when the adapter applied none.
  Accepted: in the PDF viewer `ctrl+o` and `ctrl+i` step to a neighbouring entry of the same
  document without Firefox's user-interaction check (decision 9), so a compromised viewer that
  pushes many same-document entries makes them step through each; a count (`9ctrl+o`) or the
  toolbar's back button still leaves, so it is a nuisance, not a trap.
  [`the parent sends only operations and numbers`](../../packages/vimma-core/test/pdf.test.mjs),
  [`the_parent_sends_only_operations_and_numbers`](../../tests/browser/browser_vimma_pdf_keys.js),
  [`pdf marks`](../../packages/vimma-core/test/pdf.test.mjs),
  [`marks`](../../tests/browser/browser_vimma_pdf_marks.js)
- V8. The adapter **must** read the outline only when the parent asks (the `outline` operation):
  for the user's `Tab` in the PDF viewer, and once per document when the viewer reports its first
  state in the selected tab with `[ui] pdf_outline` shown (pdf-mode decision 19). That read is
  keyed by the top window global, never by the viewer's own count of documents, so a viewer cannot
  have it read or shown again by claiming a new document. An outline read that way is shown
  without focus, so it takes no key, only in normal mode, and never over another panel or under a
  picker. Accepted: a PDF's outline titles (at most 512 characters each) show in a chrome panel
  without a key press, under the panel's visible `Outline` heading, as page titles show in tabs. The adapter **must** send only each entry's title, level, page number, kind, collapsed flag
  and, for a URL entry, its URL, never a destination; it cuts titles to 512 characters and stops at
  5,000 entries and a depth of 32. The parent **must** take an outline message only from the top
  viewer's current actor after asking that document for it (for `Tab`, opening the panel only if no
  other key was pressed, the tab is still selected and at most 2 s passed; when the PDF opened,
  only if the tab is still selected and in normal mode), and **must** parse it with
  `parsePdfOutline`, which drops the whole message for more than 5,000 entries, a level deeper than
  32 or more than one step below the previous entry's, a title over 512 characters, a URL over
  8,192, a page outside the document, an unknown kind or an unknown field, and strips control and
  format characters (Cc, Cf) from titles. `Enter` names an entry by its index (V7); its destination,
  named action or layer change stays in the child, which hands pdf.js back its own object; a named
  action is followed only when it is one of pdf.js's navigation actions (not `Print` or `SaveAs`).
  The outline panel **must** set titles with `textContent` (§6, C1). A URL entry is opened in the
  tab only when it is `http` or `https` (`outlineUrlAllowed`), after `checkLoadURIWithPrincipal`
  against the viewer's principal, which triggers the load, with no referrer and no fixup, as a link
  chosen with `f` loads; never with the system principal, which would make it look typed and could
  route it to another workspace (§2). pdf.js already gives a `javascript:` link no URL, so such an
  entry follows nothing. A link target from `F` or `c` is shown in the notice or copied as text
  only when it parses as a URL, as the URL parser writes it, without control or format
  characters, and never followed.
  [`the_outline_is_read_only_on_the_users_key`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`the_outline_is_shown_when_a_pdf_with_one_opens`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`pdf_outline_hidden_keeps_it_closed`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`an outline outside its bounds is dropped`](../../packages/vimma-core/test/pdfoutline.test.mjs),
  [`each_kind_of_entry`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`outlineUrlAllowed`](../../packages/vimma-core/test/pdfoutline.test.mjs),
  [`links`](../../tests/browser/browser_vimma_pdf_marks.js)
- V9. Presentation mode **may** go full screen without user activation, as Firefox allows the
  pdf.js principal (`dom/base/Element.cpp`); Vimma **must** request it only for the user's own
  key or `:present` command in the PDF viewer, so it adds no spoofing surface: a page cannot
  reach it, the content process cannot ask the parent for it, and Firefox's full-screen warning
  still shows.
  [`presentation_only_on_the_users_key`](../../tests/browser/browser_vimma_pdf_keys.js),
  [`presentation`](../../tests/browser/browser_vimma_pdf_keys.js)

- V10. Vimma **must not** write any `pdfjs.*` pref other than the defaults
  `pdfjs.featuresNotificationImpressionLimit = 0` and `pdfjs.sidebarViewOnLoad = 0`
  (`firefox-branding.js`; the second only stops pdf.js opening its sidebar by itself), and never
  one that
  changes scripting, fetching or sandboxing (`pdfjs.enableScripting`, `pdfjs.disabled`).
  [`pdf_mode_writes_no_pdfjs_prefs`](../../tests/browser/browser_vimma_pdf_status.js)

- V11. The parsed outline **must** stay in the parent's memory, for the tab's current document
  only, and **must** be dropped when the tab navigates or closes, or pdf.js opens another PDF in
  the same viewer (the state message counts the documents the viewer opened); the panel closes
  with it. Marks **must** stay in the parent's memory too, by document URL without its
  fragment, at most 1,000 documents; a private window's marks are kept apart and dropped when
  the last private window closes. Neither is ever written.
  [`the_outline_is_read_only_on_the_users_key`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`another_pdf_in_the_same_viewer_drops_the_outline`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`a_read_under_way_does_not_outlive_its_document`](../../tests/browser/browser_vimma_pdf_outline.js),
  [`private_marks_go_with_the_private_windows`](../../tests/browser/browser_vimma_pdf_marks.js)

- V12. The viewer's look (pdf-mode decisions 18 and 20) **must** be CSS only: the child loads, with
  `windowUtils.loadSheetUsingURIString` as author sheets of the viewer's top document (after V1's
  check), the fixed `chrome://browser/skin/vimma/firefox-pdf.css` and a `data:text/css` sheet of
  the theme's tokens; it runs nothing in the viewer, passes pdf.js nothing and reads nothing back.
  The parent **must** send the token sheet only to the actor of the top viewer's current window
  global (V2's test), on that actor's request or on a theme change, and only the stylesheet
  `ThemeHost` built from validated colours (core `themeStylesheet`); the child takes only a string
  of at most 64 KiB. Accepted: script in a compromised viewer can read the theme's colours from its
  own computed style; they are the colours of the user's desktop theme, which any page shown under
  `prefers-color-scheme` already narrows down, and no web page can read the viewer's document
  (another principal).
  [`the_viewer_follows_the_theme`](../../tests/browser/browser_vimma_pdf_look.js),
  [`pdfjs_sidebar_stays_closed`](../../tests/browser/browser_vimma_pdf_look.js),
  [`the_theme_reaches_only_the_viewer`](../../tests/browser/browser_vimma_pdf_look.js)

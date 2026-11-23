// The pdf.js viewer's objects as the PDF viewer's adapter (src/browser/base/content/vimma/actors/
// pdf-view.mjs) reads them: only the members it reads, sets or calls, each one `unknown`. The
// adapter reaches them through PDFViewerApplication with Xrays waived, so every value is what the
// viewer's script left there, and a viewer that a malformed PDF compromised controls them all
// (docs/security/20-pdf-viewer.md, "Reach"); the outline items, find events and destinations come
// through Xrays instead, which show only own data properties. Either way, the adapter checks each
// value before it relies on its type. PDFJS_CONTRACT in pdf-view.mjs names the same members with
// the type pdf.js gives them, which a mochitest holds to the pdf.js this build ships.
//
// The mochitests' own view of these objects, read past the Xrays to drive and inspect the viewer,
// is in types/mochitest/firefox.d.ts (PdfJsApplication and the rest).

declare namespace PdfJs {
  /** An object of the viewer's: the members `K`, each whatever the viewer made it, or missing. */
  type Members<K extends string> = { [name in K]?: unknown };

  /** `PDFViewerApplication`, waived. */
  type App = Members<
    | "eventBus"
    | "page"
    | "pagesCount"
    | "pdfViewer"
    | "pdfLinkService"
    | "pdfHistory"
    | "pdfDocument"
    | "requestPresentationMode"
  >;
  /** `app.eventBus`, waived. */
  type EventBus = Members<"on" | "off">;
  /** `app.pdfViewer`, waived. */
  type Viewer = Members<
    | "currentPageLabel"
    | "currentScale"
    | "currentScaleValue"
    | "pagesRotation"
    | "spreadMode"
    | "scrollMode"
    | "isInPresentationMode"
    | "update"
    | "_location"
    | "scrollPageIntoView"
    | "pagesPromise"
  >;
  /** `app.pdfViewer._location`, waived: pdf.js's record of where the view is. */
  type Location = Members<"pageNumber" | "left" | "top">;
  /** `app.pdfLinkService`, waived. */
  type LinkService = Members<
    "goToPage" | "goToDestination" | "executeNamedAction" | "executeSetOCGState"
  >;
  /** `app.pdfHistory`, waived. */
  type History = Members<"push" | "pushCurrentPosition">;
  /** `app.pdfDocument`, waived. */
  type PdfDocument = Members<"getOutline" | "getDestination" | "cachedPageNumber">;
  /** The parts of `App` the adapter calls into, by name. */
  interface Parts {
    eventBus: EventBus;
    pdfViewer: Viewer;
    pdfLinkService: LinkService;
    pdfHistory: History;
    pdfDocument: PdfDocument;
  }
  /** A promise pdf.js returned, through Xrays. */
  type Thenable = Members<"then">;
  /** An entry of `getOutline()`'s tree, through Xrays. */
  type OutlineItem = Members<
    "title" | "count" | "url" | "action" | "attachment" | "setOCGState" | "dest" | "items"
  >;
  /** The event of `updatefindmatchescount` and `updatefindcontrolstate`, through Xrays. */
  type FindEvent = Members<"matchesCount">;
  /** `FindEvent.matchesCount`, through Xrays. */
  type MatchesCount = Members<"current" | "total">;
}

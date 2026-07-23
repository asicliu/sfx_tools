# PDF Fill & Sign: Automatic Text Box Insertion ("Detect blanks")

**Date:** 2026-07-22
**Tool:** `tools/pdf-fill-sign`
**Status:** Approved

## Goal

Let users fill flat (non-interactive) PDF forms faster: one click scans the
document's text layer for fillable blanks and places an editable text box over
each one, instead of the user manually clicking "Add text box" per field.

## Scope

- Detection is **text-layer only**, using the items returned by pdf.js
  `page.getTextContent()`. No AcroForm field reading, no vector/graphics-line
  parsing, no OCR.
- Trigger is an explicit **"Detect blanks" toolbar button**. No auto-run on
  document load, no suggestion/confirm UI.
- Applies to both uploaded PDFs and DOCX files after their in-browser
  conversion to PDF (detection always runs on the resulting PDF's text layer).

## Architecture

### New module: `src/detect-blanks.js` (DOM-free)

Pure geometry/text analysis so it is importable by the Node smoke test,
following the repo convention (like `src/pdf-export.js`).

```
detectBlankRegions(textItems, pageWidth, pageHeight) -> BlankRegion[]
```

- `textItems`: the `items` array from pdf.js `getTextContent()` — each item
  has `str`, `transform` (position in PDF units, y measured from the bottom),
  `width`, and `height`.
- `pageWidth` / `pageHeight`: page size in PDF units (from
  `page.getViewport({ scale: 1 })`).
- Returns regions in the app's normalized annotation coordinate space
  (top-left origin, 0–1 fractions):
  `{ x, y, width, height, fontSize }` where `fontSize` is in CSS px at
  zoom 1, matching manual text boxes.

### Detection heuristics

Items are first clustered into lines by baseline y (tolerance: a fraction of
the item height). Within each line, in reading order:

1. **Underscore runs** — a run of 3 or more consecutive underscores, including
   runs split across adjacent items on the same line (gap between the items
   must be small). The region covers the underscore span; per-character x
   offsets are interpolated from the item's total width.
2. **Dotted leaders** — a run of 5 or more consecutive dots (`......`),
   same treatment as underscores.
3. **Label-colon gaps** — an item whose visible text ends with `:` and that
   has empty horizontal space after it. The gap must be at least 1.5× the
   line's font size wide. The region spans from just after the colon to the
   next item on the line, or to the right content margin (page width minus a
   fixed margin) when the colon ends the line.

### Guards

- Skip regions narrower than 2% of the page width.
- Merge regions on the same line that overlap or touch.
- If an underscore/dot run already fills a label-colon gap, emit only the run
  region (no duplicate box for the same blank).
- Hard cap of **200 regions per document**; stop scanning further pages once
  reached and say so in the status message.

### Region → annotation

Each region becomes a standard `textbox` annotation (no new annotation type;
`applyAnnotations` in `src/pdf-export.js` is unchanged):

- `x`, `y`, `width` from the region, converted to normalized page fractions.
- `fontSize`: the detected line's font size converted to the app's px scale,
  clamped to 8–14.
- `height`: the box top is anchored at the detected span's baseline plus the
  7px top inset plus the clamped font size, so the exported first text line's
  baseline lands on the detected blank's baseline; the box height is sized
  from the line height (same 38 px-at-zoom-1 floor that `growTextBox`
  enforces) and extends below that anchored top; `autoGrow: true`.
- Boxes are immediately editable, draggable, resizable, and deletable exactly
  like manually placed ones.

### UI wiring (`main.js`, `index.html`)

- New toolbar button **"Detect blanks"** next to "Add text box"; disabled
  when no document is loaded or the app is busy (same rules as siblings in
  `updateActionState`).
- On click: set a busy status, loop over all pages with `getTextContent()`
  (no page rendering required), run the detector, then:
  - **Found N regions:** one `recordHistory()` call, push all annotations,
    `renderAnnotations()`, status
    `"N text boxes placed over detected blanks. One Undo removes them all."`
  - **Found none:** status `"No fillable blanks detected in this document."`
  - Detection failure: surface via the existing `setStatus(..., "error")`
    path; the document and any existing annotations are untouched.
- A second click runs detection again on the current document as-is
  (duplicates are possible if the user didn't undo; acceptable — Undo covers
  it).

## Error handling

- `getTextContent()` rejection on any page aborts the whole operation with an
  error status; no partial annotation insert (annotations are only pushed
  after all pages scan successfully).
- Scanned/image-only PDFs naturally yield zero text items → the "none
  detected" message, not an error.

## Testing

Extend `scripts/smoke-test.mjs`:

1. **Fixture round-trip:** build a PDF with pdf-lib containing
   `Name: ______`, a dotted-leader line, and a trailing `Date:` label; parse
   it in Node with the `pdfjs-dist` legacy build (`pdfjs-dist/legacy/build/pdf.mjs`);
   run `detectBlankRegions` and assert the expected number of regions with
   approximately correct positions (page-fraction tolerance).
2. **Synthetic-item cases** (direct calls with hand-built item arrays):
   underscore run split across two items, sliver region rejected, overlapping
   regions merged, colon with no meaningful gap ignored, 200-region cap.

## Out of scope

- AcroForm interactive field detection.
- Vector ruled-line and checkbox detection.
- Any suggestion/preview UI before placement.

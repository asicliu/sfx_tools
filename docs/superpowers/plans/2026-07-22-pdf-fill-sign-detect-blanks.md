# PDF Fill & Sign "Detect blanks" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Detect blanks" button to `tools/pdf-fill-sign` that scans the PDF text layer and auto-places editable text boxes over underscore runs, dotted leaders, and empty label-colon gaps.

**Architecture:** A new DOM-free module `src/detect-blanks.js` analyzes the text items pdf.js `getTextContent()` returns and yields normalized regions; `main.js` wires a toolbar button that runs it over all pages and pushes ordinary `textbox` annotations (one undo step for the whole batch). The Node smoke test covers the detector with synthetic items and a real fixture PDF parsed via the pdfjs legacy build.

**Tech Stack:** Vanilla JS ES modules, Vite, pdfjs-dist 4.8.69, pdf-lib 1.17.1 (both already installed — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-22-pdf-fill-sign-detect-blanks-design.md`

## Global Constraints

- Node >= 18; no new npm dependencies.
- `src/detect-blanks.js` must have **zero DOM/browser access** (importable by `scripts/smoke-test.mjs` in Node).
- Detection thresholds (from spec): underscore runs ≥ 3 chars; dotted leaders ≥ 5 chars; label-colon gap ≥ 1.5× font size; minimum region width 2% of page width; cap **200 regions per document**; output `fontSize` clamped to 8–14.
- Regions use the app's normalized annotation space: top-left origin, 0–1 fractions of page width/height; `fontSize` in CSS px at zoom 1 (equals PDF units at scale 1).
- Status copy (exact): success `"N text box(es) placed over detected blanks. One Undo removes them all."`, none `"No fillable blanks detected in this document."`
- All commands below run from `tools/pdf-fill-sign/` unless stated otherwise.
- Note (spec deviation, intended): the spec's "run already fills a label-colon gap → emit only the run" guard is satisfied structurally — a run item after a colon terminates the gap at its own x position, and the final same-line merge unions touching gap+run spans into one region. No separate dedup branch is needed; the smoke test asserts the observable behavior (exactly one region for `Name:` + `______` items).

---

### Task 1: Detector module `src/detect-blanks.js` with synthetic-item smoke tests

**Files:**
- Create: `tools/pdf-fill-sign/src/detect-blanks.js`
- Modify: `tools/pdf-fill-sign/scripts/smoke-test.mjs` (append a new section at the end)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `detectBlankRegions(textItems, pageWidth, pageHeight, { maxRegions } = {}) -> Array<{ x, y, width, height, fontSize }>` and `export const MAX_AUTO_REGIONS = 200`. Regions sorted top-to-bottom, then left-to-right. Tasks 2 and 3 import exactly these two names.

- [ ] **Step 1: Ensure a current build exists (the smoke test also checks `dist/`)**

Run: `npm ci && npm run build`
Expected: Vite build completes without errors.

- [ ] **Step 2: Write the failing tests — append to `scripts/smoke-test.mjs`**

Append at the end of the file:

```js
// --- Detect-blanks: synthetic text-item cases ---
const { detectBlankRegions, MAX_AUTO_REGIONS } = await import("../src/detect-blanks.js");

function syntheticItem(str, x, y, fontSize = 12) {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width: str.length * fontSize * 0.5,
    height: fontSize,
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

// Underscore run inside a single item.
{
  const regions = detectBlankRegions(
    [syntheticItem("Name: __________", 72, 700)],
    612,
    792,
  );
  assertEqual(regions.length, 1, "single-item underscore run count");
  // Run starts at char index 6 of 16; charWidth = width/16 = 6 → start = 72 + 36 = 108.
  assertApprox(regions[0].x, 108 / 612, 0.01, "single-item run x");
  assertApprox(regions[0].width, 60 / 612, 0.01, "single-item run width");
  assertEqual(regions[0].fontSize, 12, "single-item run fontSize");
  if (regions[0].y < 0 || regions[0].y + regions[0].height > 1) {
    throw new Error("single-item run region out of page bounds");
  }
}

// Underscore run split across two adjacent items on one line merges into one region.
{
  const first = syntheticItem("____", 100, 700); // width 24, ends at 124
  const second = syntheticItem("____", 126, 700); // 2pt gap ≤ 0.6em join threshold
  const regions = detectBlankRegions([first, second], 612, 792);
  assertEqual(regions.length, 1, "split-run merge count");
  assertApprox(regions[0].width, 50 / 612, 0.01, "split-run merged width");
}

// Sliver regions (narrower than 2% of page width) are rejected.
{
  const sliver = { str: "___", transform: [12, 0, 0, 12, 100, 700], width: 8, height: 12 };
  assertEqual(detectBlankRegions([sliver], 612, 792).length, 0, "sliver rejected");
}

// Dotted leader of ≥5 dots is detected; 4 dots are not.
{
  assertEqual(
    detectBlankRegions([syntheticItem("Phone ..........", 72, 700)], 612, 792).length,
    1,
    "dotted leader detected",
  );
  assertEqual(
    detectBlankRegions([syntheticItem("Phone ....", 72, 700)], 612, 792).length,
    0,
    "short dot run ignored",
  );
}

// Label-colon with a trailing gap to the right margin.
{
  const regions = detectBlankRegions([syntheticItem("Date:", 72, 700)], 612, 792);
  assertEqual(regions.length, 1, "colon-gap count");
  // Gap runs from end of "Date:" (72 + 30 = 102) to the right margin (612 - 40 = 572).
  assertApprox(regions[0].x, 102 / 612, 0.01, "colon-gap x");
  assertApprox(regions[0].width, (572 - 102) / 612, 0.01, "colon-gap width");
}

// Label-colon with no meaningful gap before the next item is ignored.
{
  const regions = detectBlankRegions(
    [syntheticItem("Name:", 72, 700), syntheticItem("John", 104, 700)],
    612,
    792,
  );
  assertEqual(regions.length, 0, "colon without gap ignored");
}

// Colon gap that touches a following underscore run merges into a single region.
{
  const regions = detectBlankRegions(
    [syntheticItem("Name:", 72, 700), syntheticItem("__________", 120, 700)],
    612,
    792,
  );
  assertEqual(regions.length, 1, "colon gap + run merged into one region");
  assertApprox(regions[0].x, 102 / 612, 0.01, "merged gap+run x");
  assertApprox(regions[0].width, (180 - 102) / 612, 0.01, "merged gap+run width");
}

// Items on different baselines are separate lines; regions sort top-to-bottom.
{
  const regions = detectBlankRegions(
    [syntheticItem("B: ______", 72, 600), syntheticItem("A: ______", 72, 700)],
    612,
    792,
  );
  assertEqual(regions.length, 2, "two lines detected");
  if (regions[0].y >= regions[1].y) {
    throw new Error("regions are not sorted top-to-bottom");
  }
}

// Rotated text is ignored.
{
  const rotated = { str: "______", transform: [0, 12, -12, 0, 100, 700], width: 36, height: 12 };
  assertEqual(detectBlankRegions([rotated], 612, 792).length, 0, "rotated text ignored");
}

// Region cap: 250 candidate lines yield exactly MAX_AUTO_REGIONS.
{
  const many = Array.from({ length: 250 }, (_, index) =>
    syntheticItem("__________", 72, 3900 - index * 15),
  );
  assertEqual(
    detectBlankRegions(many, 612, 4000).length,
    MAX_AUTO_REGIONS,
    "region cap enforced",
  );
  assertEqual(
    detectBlankRegions(many, 612, 4000, { maxRegions: 10 }).length,
    10,
    "maxRegions option respected",
  );
}

console.log("detect-blanks synthetic checks passed");
```

- [ ] **Step 3: Run the smoke test to verify it fails**

Run: `npm run smoke`
Expected: FAIL with `Cannot find module '.../src/detect-blanks.js'`

- [ ] **Step 4: Implement `src/detect-blanks.js`**

Create the file with exactly this content:

```js
const MIN_UNDERSCORE_RUN = 3;
const MIN_DOT_RUN = 5;
const MIN_WIDTH_FRACTION = 0.02;
const LABEL_GAP_MIN_EM = 1.5;
const RIGHT_CONTENT_MARGIN = 40;
const LINE_BASELINE_TOLERANCE_EM = 0.5;
const RUN_JOIN_GAP_EM = 0.6;
const SPAN_MERGE_EPSILON = 0.5;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 14;
const BOX_MIN_HEIGHT = 38;
const BOX_HEIGHT_FACTOR = 1.6;
const BASELINE_DROP_FACTOR = 0.25;

export const MAX_AUTO_REGIONS = 200;

const RUN_PATTERNS = [
  { pattern: /_{3,}/g, minLength: MIN_UNDERSCORE_RUN },
  { pattern: /\.{5,}/g, minLength: MIN_DOT_RUN },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toEntry(item) {
  if (!item || typeof item.str !== "string" || !item.str.trim()) return null;
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const [scaleX, skewY, skewX, scaleY, x, y] = transform;
  if (Math.abs(skewY) > 0.01 || Math.abs(skewX) > 0.01 || scaleX <= 0 || scaleY <= 0) {
    return null;
  }
  const width = Number(item.width) || 0;
  if (width <= 0) return null;
  return { str: item.str, x, y, width, fontSize: Math.abs(scaleY) };
}

function clusterLines(entries) {
  const lines = [];
  const sorted = [...entries].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const entry of sorted) {
    const tolerance = LINE_BASELINE_TOLERANCE_EM * entry.fontSize;
    const line = lines.find((candidate) => Math.abs(candidate.y - entry.y) <= tolerance);
    if (line) {
      line.entries.push(entry);
    } else {
      lines.push({ y: entry.y, entries: [entry] });
    }
  }
  for (const line of lines) line.entries.sort((a, b) => a.x - b.x);
  return lines;
}

function collectRunSpans(line) {
  const spans = [];
  for (const entry of line.entries) {
    const charWidth = entry.width / entry.str.length;
    for (const { pattern } of RUN_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(entry.str)) !== null) {
        spans.push({
          start: entry.x + match.index * charWidth,
          end: entry.x + (match.index + match[0].length) * charWidth,
          baseline: entry.y,
          fontSize: entry.fontSize,
        });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start - previous.end <= RUN_JOIN_GAP_EM * previous.fontSize) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function collectLabelGapSpans(line, pageWidth) {
  const spans = [];
  for (const [index, entry] of line.entries.entries()) {
    if (!entry.str.trimEnd().endsWith(":")) continue;
    const gapStart = entry.x + entry.width;
    const next = line.entries.slice(index + 1).find((candidate) => candidate.x >= gapStart);
    const gapEnd = next ? next.x : pageWidth - RIGHT_CONTENT_MARGIN;
    if (gapEnd - gapStart < LABEL_GAP_MIN_EM * entry.fontSize) continue;
    spans.push({
      start: gapStart,
      end: gapEnd,
      baseline: entry.y,
      fontSize: entry.fontSize,
    });
  }
  return spans;
}

function mergeLineSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end + SPAN_MERGE_EPSILON) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function toRegion(span, pageWidth, pageHeight) {
  const heightPdf = Math.max(BOX_HEIGHT_FACTOR * span.fontSize, BOX_MIN_HEIGHT);
  const bottomPdf = span.baseline - BASELINE_DROP_FACTOR * span.fontSize;
  const topPdf = Math.min(bottomPdf + heightPdf, pageHeight);
  const x = clamp(span.start / pageWidth, 0, 1);
  const width = clamp((span.end - span.start) / pageWidth, 0, 1 - x);
  const height = clamp(heightPdf / pageHeight, 0, 1);
  const y = clamp(1 - topPdf / pageHeight, 0, 1 - height);
  return {
    x,
    y,
    width,
    height,
    fontSize: Math.round(clamp(span.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE)),
  };
}

export function detectBlankRegions(textItems, pageWidth, pageHeight, options = {}) {
  const maxRegions = options.maxRegions ?? MAX_AUTO_REGIONS;
  if (!Array.isArray(textItems) || !(pageWidth > 0) || !(pageHeight > 0) || maxRegions <= 0) {
    return [];
  }

  const entries = textItems.map(toEntry).filter(Boolean);
  const regions = [];
  for (const line of clusterLines(entries)) {
    const spans = mergeLineSpans([
      ...collectRunSpans(line),
      ...collectLabelGapSpans(line, pageWidth),
    ]);
    for (const span of spans) {
      if (span.end - span.start < MIN_WIDTH_FRACTION * pageWidth) continue;
      regions.push(toRegion(span, pageWidth, pageHeight));
    }
  }

  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  return regions.slice(0, maxRegions);
}
```

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `npm run smoke`
Expected: PASS — output includes `detect-blanks synthetic checks passed` and exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/detect-blanks.js scripts/smoke-test.mjs
git commit -m "feat: add DOM-free blank-region detector for pdf-fill-sign"
```

---

### Task 2: Fixture-PDF round-trip smoke test (pdfjs legacy build)

**Files:**
- Modify: `tools/pdf-fill-sign/scripts/smoke-test.mjs` (append after the Task 1 section)

**Interfaces:**
- Consumes: `detectBlankRegions` from Task 1 (already imported in the smoke test).
- Produces: nothing new — verification only.

- [ ] **Step 1: Write the failing/verifying test — append to `scripts/smoke-test.mjs`**

```js
// --- Detect-blanks: real PDF round-trip via pdfjs legacy build ---
{
  const formDoc = await PDFDocument.create();
  const formPage = formDoc.addPage([612, 792]);
  const formFont = await formDoc.embedFont(StandardFonts.Helvetica);
  formPage.drawText("Name: ______________", { x: 72, y: 700, size: 12, font: formFont });
  formPage.drawText("Phone ..............", { x: 72, y: 660, size: 12, font: formFont });
  formPage.drawText("Date:", { x: 72, y: 620, size: 12, font: formFont });
  const formBytes = await formDoc.save();

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const parsed = await pdfjs.getDocument({ data: formBytes.slice(), verbosity: 0 }).promise;
  const parsedPage = await parsed.getPage(1);
  const viewport = parsedPage.getViewport({ scale: 1 });
  const { items } = await parsedPage.getTextContent();
  const regions = detectBlankRegions(items, viewport.width, viewport.height);
  await parsed.destroy();

  if (regions.length !== 3) {
    throw new Error(`fixture PDF: expected 3 regions, got ${regions.length}`);
  }
  // Top-to-bottom: underscore run (y≈700), dotted leader (y≈660), colon gap (y≈620).
  assertApprox(regions[0].x, 0.18, 0.03, "fixture underscore x");
  assertApprox(regions[0].y, 1 - 735 / 792, 0.03, "fixture underscore y");
  assertApprox(regions[1].y, 1 - 695 / 792, 0.03, "fixture dotted y");
  assertApprox(regions[2].y, 1 - 655 / 792, 0.03, "fixture colon-gap y");
  // The Date: gap extends to the right content margin.
  assertApprox(regions[2].x + regions[2].width, (612 - 40) / 612, 0.02, "fixture colon-gap right edge");
  for (const region of regions) {
    assertEqual(region.fontSize, 12, "fixture fontSize");
  }
  console.log("detect-blanks fixture PDF checks passed");
}
```

- [ ] **Step 2: Run the smoke test**

Run: `npm run smoke`
Expected: PASS — output includes `detect-blanks fixture PDF checks passed`.

If any assertion fails, the failure indicates a real coordinate-math bug in `src/detect-blanks.js` (most likely in `toRegion` or the char-width interpolation) — fix the detector, not the tolerances, unless the delta is a sub-1% rounding artifact.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-test.mjs
git commit -m "test: cover blank detection with a real fixture PDF"
```

---

### Task 3: Toolbar button and wiring in `main.js` / `index.html`

**Files:**
- Modify: `tools/pdf-fill-sign/index.html` (toolbar, after the `#add-text-box-button` element around line 74)
- Modify: `tools/pdf-fill-sign/src/main.js` (imports, `controls`, `updateActionState`, new handler, `initialize`)
- Modify: `tools/pdf-fill-sign/package.json` (version bump `1.1.0` → `1.2.0`)

**Interfaces:**
- Consumes: `detectBlankRegions(textItems, pageWidth, pageHeight, { maxRegions })` and `MAX_AUTO_REGIONS` from Task 1.
- Produces: user-facing feature; no exports.

- [ ] **Step 1: Add the button to `index.html`**

Directly after the closing tag of the `#add-text-box-button` button (`</button>` on the "Text box" tool), insert:

```html
                <button class="document-tool" id="detect-blanks-button" type="button" disabled>
                  <span aria-hidden="true">⌕</span>
                  Detect blanks
                </button>
```

- [ ] **Step 2: Wire the button in `src/main.js`**

2a. Extend the top import block:

```js
import { detectBlankRegions, MAX_AUTO_REGIONS } from "./detect-blanks.js";
```

2b. In the `controls` object, after the `addTextBoxButton` line, add:

```js
  detectBlanksButton: document.querySelector("#detect-blanks-button"),
```

2c. In `updateActionState()`, after `controls.addTextBoxButton.disabled = !hasDocument;`, add:

```js
  controls.detectBlanksButton.disabled = !hasDocument;
```

2d. Add this function next to `beginTextBoxPlacement` (after it):

```js
async function detectAndPlaceTextBoxes() {
  if (!state.pdf || state.busy) return;
  const pdf = state.pdf;
  state.pendingPlacement = null;
  state.inkMode = false;
  state.inkStroke = null;
  controls.detectBlanksButton.disabled = true;
  setStatus("Scanning for fillable blanks…");

  try {
    const found = [];
    for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
      if (found.length >= MAX_AUTO_REGIONS) break;
      const page = await pdf.getPage(pageNumber);
      if (state.pdf !== pdf) return;
      const viewport = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      if (state.pdf !== pdf) return;
      const regions = detectBlankRegions(items, viewport.width, viewport.height, {
        maxRegions: MAX_AUTO_REGIONS - found.length,
      });
      for (const region of regions) found.push({ pageNumber, region });
    }

    if (!found.length) {
      setStatus("No fillable blanks detected in this document.");
      return;
    }

    recordHistory();
    for (const { pageNumber, region } of found) {
      state.annotations.push({
        id: createId(),
        type: "textbox",
        page: pageNumber,
        text: "",
        fontSize: region.fontSize,
        width: region.width,
        height: region.height,
        autoGrow: true,
        x: region.x,
        y: region.y,
      });
    }
    state.selectedId = null;
    renderAnnotations();
    const capNote = found.length >= MAX_AUTO_REGIONS ? " Limit of 200 boxes reached." : "";
    setStatus(
      `${found.length} text box${found.length === 1 ? "" : "es"} placed over detected blanks. One Undo removes them all.${capNote}`,
      "success",
    );
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    updateActionState();
  }
}
```

2e. In `initialize()`, after the `controls.addTextBoxButton.addEventListener(...)` line, add:

```js
  controls.detectBlanksButton.addEventListener("click", () => void detectAndPlaceTextBoxes());
```

- [ ] **Step 3: Bump the tool version**

In `tools/pdf-fill-sign/package.json`, change `"version": "1.1.0"` to `"version": "1.2.0"` (the smoke test asserts the package version appears in the built bundle, and the hub displays it).

- [ ] **Step 4: Verify in the browser**

1. Generate a fixture form on disk (run from `tools/pdf-fill-sign/`):

```bash
node --input-type=module -e '
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFile } from "node:fs/promises";
const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("Name: ______________", { x: 72, y: 700, size: 12, font });
page.drawText("Phone ..............", { x: 72, y: 660, size: 12, font });
page.drawText("Date:", { x: 72, y: 620, size: 12, font });
await writeFile("/tmp/detect-blanks-fixture.pdf", await doc.save());
console.log("/tmp/detect-blanks-fixture.pdf");
'
```

2. Run `npm run dev`, open the printed URL, load `/tmp/detect-blanks-fixture.pdf`.
3. Click **Detect blanks**. Expected: three text boxes appear over the underscore run, the dotted leader, and the space after `Date:`; status reads `3 text boxes placed over detected blanks. One Undo removes them all.`; each box is editable/draggable; a single Undo removes all three.
4. Also verify the button is disabled before a document loads, and that a text-free PDF (or clicking again after Undo on a blank-free doc) shows `No fillable blanks detected in this document.`

(Use the `/browse` skill for this check if a headless verification with screenshots is preferred.)

- [ ] **Step 5: Full check**

Run: `npm run check`
Expected: build succeeds and the smoke test passes (including the version-in-bundle assertion against 1.2.0).

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.js package.json package-lock.json
git commit -m "feat: add Detect blanks button that auto-places text boxes"
```

(`package-lock.json` only if `npm` touched its version field; otherwise omit it.)

---

## Final verification (repo root)

- [ ] Run `npm run check` from the repository root — hub build plus every tool's smoke test must pass.

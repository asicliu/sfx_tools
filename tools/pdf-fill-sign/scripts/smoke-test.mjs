import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { access, readFile, readdir } from "node:fs/promises";
import { applyAnnotations } from "../src/pdf-export.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const distUrl = new URL("../dist/", import.meta.url);
const headers = await readFile(new URL("_headers", distUrl), "utf8");
if (
  !headers.includes("Cross-Origin-Opener-Policy: same-origin") ||
  !headers.includes("Cross-Origin-Embedder-Policy: require-corp")
) {
  throw new Error("Browser Office isolation headers are missing from the production build.");
}

await Promise.all([
  access(new URL("vendor/zetajs/zetaHelper.js", distUrl)),
  access(new URL("vendor/zetajs/zeta.js", distUrl)),
  access(new URL("docx-conversion-thread.js", distUrl)),
]);

const assetFiles = await readdir(new URL("assets/", distUrl));
const appBundles = await Promise.all(
  assetFiles
    .filter((name) => /^index-.*\.js$/.test(name))
    .map((name) => readFile(new URL(`assets/${name}`, distUrl), "utf8")),
);
if (!appBundles.some((bundle) => bundle.includes(packageJson.version))) {
  throw new Error("The package version is missing from the production app bundle.");
}

const source = await PDFDocument.create();
const page = source.addPage([612, 792]);
const font = await source.embedFont(StandardFonts.Helvetica);

page.drawText("PDF Fill & Sign smoke test", {
  x: 72,
  y: 720,
  size: 22,
  font,
  color: rgb(0, 0, 0),
});

const sourceBytes = await source.save();
const signaturePng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const output = await applyAnnotations(sourceBytes, [
  {
    id: "text-smoke",
    type: "text",
    page: 1,
    text: "Yang Liu",
    fontSize: 12,
    x: 0.18,
    y: 0.72,
  },
  {
    id: "signature-smoke",
    type: "signature",
    page: 1,
    imageData: signaturePng,
    width: 0.3,
    height: 0.08,
    x: 0.18,
    y: 0.78,
  },
  {
    id: "textbox-smoke",
    type: "textbox",
    page: 1,
    text: "Text typed directly into a wrapped box on the document.",
    fontSize: 12,
    width: 0.24,
    height: 0.1,
    x: 0.55,
    y: 0.58,
  },
  {
    id: "ink-smoke",
    type: "ink",
    page: 1,
    thickness: 1.8,
    points: [
      { x: 0.54, y: 0.78 },
      { x: 0.58, y: 0.73 },
      { x: 0.62, y: 0.8 },
      { x: 0.68, y: 0.72 },
      { x: 0.75, y: 0.78 },
    ],
  },
]);

const loaded = await PDFDocument.load(output, { updateMetadata: false });

if (loaded.getPageCount() !== 1 || output.length <= sourceBytes.length) {
  throw new Error("PDF annotation smoke test failed.");
}

if (loaded.getProducer() !== "SFX Tools PDF Fill & Sign") {
  throw new Error("PDF export metadata smoke test failed.");
}

console.log(
  `Smoke test passed: v${packageJson.version}, browser Office assets, and ${output.length} signed PDF bytes`,
);

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

// Colon gap where the next item starts slightly before the label's reported end
// (kerning/width overestimate) must not extend the gap over existing text.
{
  const regions = detectBlankRegions(
    [syntheticItem("Name:", 72, 700), syntheticItem("John Smith", 101, 700)],
    612,
    792,
  );
  assertEqual(regions.length, 0, "overlapping next item yields no colon gap");
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
  assertApprox(regions[0].y, 1 - 719 / 792, 0.03, "fixture underscore y");
  assertApprox(regions[1].y, 1 - 679 / 792, 0.03, "fixture dotted y");
  assertApprox(regions[2].y, 1 - 639 / 792, 0.03, "fixture colon-gap y");
  // The Date: gap extends to the right content margin.
  assertApprox(regions[2].x + regions[2].width, (612 - 40) / 612, 0.02, "fixture colon-gap right edge");
  for (const region of regions) {
    assertEqual(region.fontSize, 12, "fixture fontSize");
  }
  console.log("detect-blanks fixture PDF checks passed");
}

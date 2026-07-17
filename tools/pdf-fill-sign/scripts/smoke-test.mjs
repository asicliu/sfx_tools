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

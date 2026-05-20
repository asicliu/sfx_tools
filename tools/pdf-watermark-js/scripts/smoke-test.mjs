import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { applyWatermark } from "../src/watermark.js";

const source = await PDFDocument.create();
const page = source.addPage([612, 792]);
const font = await source.embedFont(StandardFonts.Helvetica);

page.drawText("Smoke test source PDF", {
  x: 72,
  y: 720,
  size: 24,
  font,
  color: rgb(0, 0, 0),
});

const output = await applyWatermark(await source.save(), {
  text: "CONFIDENTIAL",
  fontSize: 36,
  opacity: 0.2,
  rotation: 45,
  colorR: 0.2,
  colorG: 0.2,
  colorB: 0.2,
  repeat: true,
  spacingX: 250,
  spacingY: 200,
});

const loaded = await PDFDocument.load(output);

if (loaded.getPageCount() !== 1 || output.length === 0) {
  throw new Error("Watermark smoke test failed.");
}

console.log(`Smoke test passed: ${output.length} bytes`);

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { applyWatermark } from "../src/watermark.js";
import { computePermissions, encryptPdfPermissions } from "../src/encryption.js";
import { countSlideIds, parseSlideSizePoints } from "../src/convert/slide-size.js";

const slideIdXml =
  '<p:presentation xmlns:p="ns"><p:sldIdLst><p:sldId id="256" r:id="rId2"/>' +
  '<p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>';

if (countSlideIds(slideIdXml) !== 3 || countSlideIds("<p:presentation/>") !== 0) {
  throw new Error("Slide count smoke test failed.");
}

const widescreen = parseSlideSizePoints(
  '<p:presentation xmlns:p="ns"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
);
const fallback = parseSlideSizePoints('<p:presentation xmlns:p="ns"></p:presentation>');

if (widescreen.width !== 960 || widescreen.height !== 540) {
  throw new Error("Slide size parsing smoke test failed for 16:9 slides.");
}

if (fallback.width !== 720 || fallback.height !== 540) {
  throw new Error("Slide size parsing smoke test failed for the default size.");
}

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

const encrypted = encryptPdfPermissions(output, {
  ownerPassword: "smoke-owner-password",
  allowPrint: false,
  allowCopy: false,
  allowAnnotate: false,
  fileId: new Uint8Array(16).fill(1),
});
const encryptedText = Buffer.from(encrypted).toString("binary");
const expectedPermissions = String(
  computePermissions({ allowPrint: false, allowCopy: false, allowAnnotate: false }),
);

if (
  !encryptedText.includes("/Encrypt") ||
  !encryptedText.includes("/Standard") ||
  encryptedText.match(/\/P\s+(-?\d+)/)?.[1] !== expectedPermissions
) {
  throw new Error("Permission encryption smoke test failed.");
}

const encryptedLoaded = await PDFDocument.load(encrypted, { ignoreEncryption: true });
if (encryptedLoaded.getPageCount() !== 1) {
  throw new Error("Encrypted PDF smoke test failed.");
}

console.log(`Smoke test passed: ${output.length} watermarked bytes, ${encrypted.length} encrypted bytes`);

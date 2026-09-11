import assert from "node:assert/strict";
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from "pdf-lib";
import { applyWatermark, needsRasterText } from "../src/watermark.js";

if (
  needsRasterText("CONFIDENTIAL") ||
  needsRasterText("Café Draft") ||
  !needsRasterText("机密") ||
  !needsRasterText("社外秘") ||
  !needsRasterText("DRAFT — 机密")
) {
  throw new Error("Raster text detection smoke test failed.");
}
import { computePermissions, encryptPdfPermissions } from "../src/encryption.js";
import {
  contentTypesForSingleSlide,
  contentTypesForSlides,
  countSlideIds,
  describeSlideContent,
  findRelationshipTarget,
  isSlideHidden,
  parseSlideOrder,
  parseSlideSizePoints,
  prepareSlideForRendering,
  rewriteSvgBlips,
  sanitizeSlideXml,
} from "../src/convert/manifest.js";

const equationFallback = prepareSlideForRendering(
  '<p:sld><mc:AlternateContent><mc:Choice><m:oMath>equation</m:oMath></mc:Choice>' +
  '<mc:Fallback><p:pic>equation picture</p:pic></mc:Fallback></mc:AlternateContent></p:sld>', 7,
);
if (
  equationFallback.xml !== '<p:sld><p:pic>equation picture</p:pic></p:sld>' ||
  !equationFallback.warnings.some((warning) => warning.includes('Slide 7'))
) throw new Error('Equation fallback must be rendered and disclosed before preview.');

const missingContent = prepareSlideForRendering(
  '<p:sld><mc:AlternateContent><mc:Choice>drawing</mc:Choice></mc:AlternateContent>' +
  '<m:oMath>equation without fallback</m:oMath></p:sld>', 3,
);
if (
  !missingContent.warnings.some((warning) => warning.includes('omits unsupported content')) ||
  !missingContent.warnings.some((warning) => warning.includes('equation'))
) throw new Error('Potential content loss must not be reported as unconditional success.');

const nestedFallback = prepareSlideForRendering(
  '<p:sld><mc:AlternateContent><mc:Choice>outer</mc:Choice><mc:Fallback>' +
  '<mc:AlternateContent><mc:Choice>inner</mc:Choice><mc:Fallback><p:pic/></mc:Fallback>' +
  '</mc:AlternateContent></mc:Fallback></mc:AlternateContent></p:sld>', 2,
);
if (nestedFallback.xml !== '<p:sld><p:pic/></p:sld>') {
  throw new Error('Nested compatibility drawings must preserve valid slide XML.');
}
if (prepareSlideForRendering('<p:sld><p:sp/><p:pic/><a:tbl/></p:sld>', 1).warnings.length) {
  throw new Error('Ordinary shapes, images, and tables should not trigger content-loss warnings.');
}

if (
  !isSlideHidden('<p:sld show="0"><p:cSld/></p:sld>') ||
  !isSlideHidden("<p:sld show='false'/>") ||
  isSlideHidden('<p:sld show="1"/>') ||
  isSlideHidden('<p:sld show="true"/>') ||
  isSlideHidden('<p:sld><p:cSld show="0"/></p:sld>') ||
  isSlideHidden('<p:sld showMasterSp="0"/>')
) {
  throw new Error("Hidden-slide detection must use only the slide's show attribute.");
}

const svgSlideXml =
  '<p:pic><p:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541}">' +
  '<asvg:svgBlip xmlns:asvg="ns" r:embed="rId2"/></a:ext></a:extLst></a:blip>' +
  "</p:blipFill></p:pic>" +
  '<p:pic><p:blipFill><a:blip r:embed="rId9"><a:extLst><a:ext uri="{96DAC541}">' +
  '<asvg:svgBlip xmlns:asvg="ns" r:embed="rId3"/></a:ext></a:extLst></a:blip>' +
  "</p:blipFill></p:pic>";
const svgRewrite = rewriteSvgBlips(svgSlideXml);

if (
  svgRewrite.svgRelIds.join() !== "rId2" ||
  !svgRewrite.xml.includes('<a:blip r:embed="rId2">') ||
  !svgRewrite.xml.includes('<a:blip r:embed="rId9">') ||
  svgRewrite.xml.includes("svgBlip")
) {
  throw new Error("SVG blip rewrite smoke test failed.");
}

// A raster image followed by shapes and SVG-only images used to match as
// one blip, deleting shape dimensions and leaving SVG relationships unset.
const rasterPicture =
  '<p:pic><p:blipFill><a:blip r:embed="rId1" cstate="print"/>' +
  '<a:stretch><a:fillRect/></a:stretch></p:blipFill></p:pic>';
const interveningShape =
  '<p:sp><p:spPr><a:xfrm><a:off x="100" y="200"/>' +
  '<a:ext cx="300" cy="400"/></a:xfrm></p:spPr></p:sp>';
const svgOnlyPicture =
  '<p:pic><p:blipFill><a:blip><a:extLst><a:ext uri="svg">' +
  '<asvg:svgBlip r:embed="rId7"/></a:ext></a:extLst></a:blip>' +
  '</p:blipFill></p:pic>';
const mixedPictures = rasterPicture + interveningShape + svgOnlyPicture;
const mixedRewrite = rewriteSvgBlips(mixedPictures);
if (
  mixedRewrite.xml !== rasterPicture + interveningShape +
    '<p:pic><p:blipFill><a:blip r:embed="rId7"><a:extLst></a:extLst>' +
    '</a:blip></p:blipFill></p:pic>' ||
  mixedRewrite.svgRelIds.join() !== "rId7" ||
  rewriteSvgBlips(mixedRewrite.xml).xml !== mixedRewrite.xml
) {
  throw new Error("Mixed raster/SVG images must preserve intervening shapes.");
}

const preservedExtension = '<a:ext uri="other"/>';
const extensionRewrite = rewriteSvgBlips(
  svgOnlyPicture.replace('<a:ext uri="svg">', preservedExtension + '<a:ext uri="svg">'),
);
if (!extensionRewrite.xml.includes(preservedExtension)) {
  throw new Error("SVG rewriting must preserve unrelated self-closing extensions.");
}

const svgRelsXml =
  '<Relationships><Relationship Target="../media/image6.svg" Id="rId2" Type="t"/></Relationships>';

if (
  findRelationshipTarget(svgRelsXml, "rId2") !== "../media/image6.svg" ||
  findRelationshipTarget(svgRelsXml, "rId9") !== null
) {
  throw new Error("Relationship target smoke test failed.");
}

const sanitized = sanitizeSlideXml(
  "<p:sld><mc:AlternateContent><mc:Choice>new</mc:Choice>" +
    "<mc:Fallback xmlns='f'>old</mc:Fallback></mc:AlternateContent>" +
    '<p:graphicFrame><a:graphicData uri="http://x/diagram"><dgm:relIds/></a:graphicData></p:graphicFrame>' +
    "<p:timing>anim</p:timing></p:sld>",
);

if (
  sanitized.xml !== "<p:sld>old</p:sld>" ||
  sanitized.removed.join() !== "SmartArt diagram"
) {
  throw new Error("Slide sanitize smoke test failed.");
}

if (describeSlideContent(svgSlideXml).join() !== "SVG image,picture") {
  throw new Error("Slide content description smoke test failed.");
}

const slideIdXml =
  '<p:presentation xmlns:p="ns"><p:sldIdLst><p:sldId id="256" r:id="rId2"/>' +
  '<p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>';

if (countSlideIds(slideIdXml) !== 3 || countSlideIds("<p:presentation/>") !== 0) {
  throw new Error("Slide count smoke test failed.");
}

const relsXml =
  '<Relationships><Relationship Id="rId2" Type="t" Target="slides/slide2.xml"/>' +
  '<Relationship Id="rId3" Type="t" Target="slides/slide1.xml"/>' +
  '<Relationship Id="rId4" Type="t" Target="slides/slide3.xml"/></Relationships>';
const order = parseSlideOrder(slideIdXml, relsXml);

if (order.join() !== "ppt/slides/slide2.xml,ppt/slides/slide1.xml,ppt/slides/slide3.xml") {
  throw new Error("Slide order smoke test failed.");
}

if (parseSlideOrder(slideIdXml, "<Relationships/>").length !== 0) {
  throw new Error("Slide order smoke test failed for missing relationships.");
}

const slideType =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const contentTypesXml =
  `<Types><Override PartName="/ppt/presentation.xml" ContentType="p"/>` +
  `<Override PartName="/ppt/slides/slide1.xml" ContentType="${slideType}"/>` +
  `<Override PartName="/ppt/slides/slide2.xml" ContentType="${slideType}"/></Types>`;
const singleSlide = contentTypesForSingleSlide(contentTypesXml, "ppt/slides/slide2.xml");
const visibleSlides = contentTypesForSlides(contentTypesXml, ["ppt/slides/slide2.xml"]);
const noSlides = contentTypesForSlides(contentTypesXml, []);
if (
  visibleSlides !== singleSlide ||
  noSlides.includes(slideType) ||
  !noSlides.includes('/ppt/presentation.xml') ||
  contentTypesForSlides(contentTypesXml, ["ppt/slides/slide2.xml", "ppt/slides/slide1.xml"]) !== contentTypesXml
) {
  throw new Error("Hidden slide parts must be excluded without removing other parts.");
}

if (
  singleSlide.includes("slide1.xml") ||
  !singleSlide.includes("slide2.xml") ||
  !singleSlide.includes("/ppt/presentation.xml")
) {
  throw new Error("Single-slide content types smoke test failed.");
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

const hiddenId = "Recipient: 测试 😀 / ID-2026 (private)";
const sourceBytes = await source.save();
const hiddenOutput = await applyWatermark(sourceBytes, {
  visible: false,
  invisibleText: hiddenId,
});
const hiddenDoc = await PDFDocument.load(hiddenOutput);
const hiddenKey = PDFName.of("SFXInvisibleWatermark");
assert.equal(hiddenDoc.catalog.lookup(hiddenKey, PDFHexString).decodeText(), hiddenId);
assert.equal(hiddenDoc.getPage(0).node.lookup(hiddenKey, PDFHexString).decodeText(), hiddenId);
assert.equal(loaded.catalog.has(hiddenKey), false, "Visible-only output should not add hidden data");
const originalDoc = await PDFDocument.load(sourceBytes);
assert.equal(hiddenDoc.getPage(0).node.Contents().toString(), originalDoc.getPage(0).node.Contents().toString());
for (const ref of originalDoc.getPage(0).node.Contents().asArray()) {
  assert.deepEqual(hiddenDoc.context.lookup(ref).getContents(), originalDoc.context.lookup(ref).getContents(),
    "Invisible-only watermark must not change page content streams");
}
await assert.rejects(applyWatermark(sourceBytes, { visible: false, invisibleText: "  " }), /Enable/);

const combinedOutput = await applyWatermark(sourceBytes, {
  text: "VISIBLE", invisibleText: hiddenId, fontSize: 36, opacity: 0.2,
  rotation: 45, colorR: 0.2, colorG: 0.2, colorB: 0.2, repeat: false,
});
const combinedDoc = await PDFDocument.load(combinedOutput);
assert.equal(combinedDoc.catalog.lookup(hiddenKey, PDFHexString).decodeText(), hiddenId);
assert.ok(combinedDoc.getPage(0).node.Contents().size() > originalDoc.getPage(0).node.Contents().size());
const multiple = await PDFDocument.create();
multiple.addPage();
multiple.addPage();
const multipleDoc = await PDFDocument.load(await applyWatermark(await multiple.save(), {
  visible: false, invisibleText: hiddenId,
}));
for (const p of multipleDoc.getPages()) {
  assert.equal(p.node.lookup(hiddenKey, PDFHexString).decodeText(), hiddenId);
}

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

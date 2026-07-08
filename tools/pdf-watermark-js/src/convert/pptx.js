import JSZip from "jszip";
import { init } from "pptx-preview";
import {
  contentTypesForSingleSlide,
  countSlideIds,
  parseSlideOrder,
  parseSlideSizePoints,
} from "./manifest.js";
import {
  createOffscreenHost,
  pagesToPdf,
  rasterizePage,
  waitForRender,
} from "./rasterize.js";

const CSS_PX_PER_POINT = 96 / 72;

async function readZipText(zip, path) {
  try {
    return (await zip.file(path)?.async("string")) ?? null;
  } catch {
    return null;
  }
}

async function renderSlidesToHost(arrayBuffer, size) {
  const host = createOffscreenHost();
  try {
    const previewer = init(host, {
      width: Math.round(size.width * CSS_PX_PER_POINT),
      height: Math.round(size.height * CSS_PX_PER_POINT),
      mode: "list",
    });
    await previewer.preview(arrayBuffer);
    await waitForRender(host);
  } catch {
    return { host, slides: [] };
  }
  return { host, slides: [...host.querySelectorAll(".pptx-preview-slide-wrapper")] };
}

// pptx-preview renders slides sorted by the number in their part filename,
// so its output order only matches the presentation when sldIdLst order
// does too (untrue for decks whose slides were reordered in PowerPoint).
function filenameOrderMatches(slideOrder) {
  const numbers = slideOrder.map((partName) =>
    Number(partName.match(/(\d+)\.xml$/)?.[1]),
  );
  return numbers.every(
    (value, index) =>
      Number.isFinite(value) && (index === 0 || value > numbers[index - 1]),
  );
}

// Converts one slide at a time by declaring only that slide in
// [Content_Types].xml, so a slide pptx-preview cannot parse only loses
// itself instead of silently truncating every slide after it. Pages come
// out in true sldIdLst order, unlike the library's filename ordering.
async function convertSlideBySlide(zip, contentTypesXml, slideOrder, size) {
  const pages = [];
  const failedSlides = [];

  for (const [index, partName] of slideOrder.entries()) {
    zip.file("[Content_Types].xml", contentTypesForSingleSlide(contentTypesXml, partName));
    const singleSlideBuffer = await zip.generateAsync({ type: "arraybuffer" });
    const { host, slides } = await renderSlidesToHost(singleSlideBuffer, size);

    try {
      if (slides.length === 1) {
        pages.push(await rasterizePage(slides[0], size.width, size.height));
      } else {
        failedSlides.push(index + 1);
      }
    } finally {
      host.remove();
    }
  }

  if (failedSlides.length > 0) {
    throw new Error(
      `Slide${failedSlides.length > 1 ? "s" : ""} ${failedSlides.join(", ")} could not be ` +
        "converted in the browser. Remove or simplify that content, or export the deck " +
        "to PDF in PowerPoint and watermark that PDF instead.",
    );
  }

  return pagesToPdf(pages);
}

// Mirrors PowerPoint's own PDF export: every PDF page uses the exact slide
// dimensions from presentation.xml instead of being fit onto printer paper.
export async function convertPptxToPdf(arrayBuffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    zip = null;
  }
  const presentationXml = zip && (await readZipText(zip, "ppt/presentation.xml"));
  if (!presentationXml) {
    throw new Error("Could not read this file as a PowerPoint (.pptx) presentation.");
  }

  const size = parseSlideSizePoints(presentationXml);
  const relsXml = (await readZipText(zip, "ppt/_rels/presentation.xml.rels")) ?? "";
  const contentTypesXml = await readZipText(zip, "[Content_Types].xml");
  const slideOrder = parseSlideOrder(presentationXml, relsXml);
  const expectedSlides = slideOrder.length || countSlideIds(presentationXml);

  // pptx-preview swallows per-slide parse errors (silently truncating the
  // deck), so its all-at-once output is only trustworthy when the slide
  // count and slide order can both be confirmed against the manifest.
  const { host, slides } = await renderSlidesToHost(arrayBuffer, size);
  let renderedCount = slides.length;
  try {
    if (
      slides.length === expectedSlides &&
      slideOrder.length === expectedSlides &&
      filenameOrderMatches(slideOrder)
    ) {
      const pages = [];
      for (const slide of slides) {
        pages.push(await rasterizePage(slide, size.width, size.height));
      }
      return await pagesToPdf(pages);
    }
  } finally {
    host.remove();
  }

  if (slideOrder.length === 0 || !contentTypesXml) {
    throw new Error(
      `Converted only ${renderedCount} of ${expectedSlides} slides — this presentation ` +
        "uses content the in-browser converter cannot read. Export the deck to PDF in " +
        "PowerPoint, then watermark that PDF instead.",
    );
  }

  return convertSlideBySlide(zip, contentTypesXml, slideOrder, size);
}

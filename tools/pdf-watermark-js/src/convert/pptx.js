import JSZip from "jszip";
import { init } from "pptx-preview";
import { parseSlideSizePoints } from "./slide-size.js";
import {
  createOffscreenHost,
  pagesToPdf,
  rasterizePage,
  waitForRender,
} from "./rasterize.js";

const CSS_PX_PER_POINT = 96 / 72;

async function readSlideSizePoints(arrayBuffer) {
  let presentationXml;
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  } catch {
    presentationXml = null;
  }

  if (!presentationXml) {
    throw new Error("Could not read this file as a PowerPoint (.pptx) presentation.");
  }

  return parseSlideSizePoints(presentationXml);
}

// Mirrors PowerPoint's own PDF export: every PDF page uses the exact slide
// dimensions from presentation.xml instead of being fit onto printer paper.
export async function convertPptxToPdf(arrayBuffer) {
  const size = await readSlideSizePoints(arrayBuffer);
  const host = createOffscreenHost();

  try {
    const previewer = init(host, {
      width: Math.round(size.width * CSS_PX_PER_POINT),
      height: Math.round(size.height * CSS_PX_PER_POINT),
      mode: "list",
    });
    await previewer.preview(arrayBuffer);
    await waitForRender(host);

    const slides = [...host.querySelectorAll(".pptx-preview-slide-wrapper")];
    if (slides.length === 0) {
      throw new Error("No slides found in the presentation.");
    }

    const pages = [];
    for (const slide of slides) {
      pages.push(await rasterizePage(slide, size.width, size.height));
    }

    return pagesToPdf(pages);
  } finally {
    host.remove();
  }
}

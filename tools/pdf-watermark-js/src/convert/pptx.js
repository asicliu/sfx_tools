import JSZip from "jszip";
import { init } from "pptx-preview";
import { countSlideIds, parseSlideSizePoints } from "./slide-size.js";
import {
  createOffscreenHost,
  pagesToPdf,
  rasterizePage,
  waitForRender,
} from "./rasterize.js";

const CSS_PX_PER_POINT = 96 / 72;

async function readPresentationXml(arrayBuffer) {
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

  return presentationXml;
}

// Mirrors PowerPoint's own PDF export: every PDF page uses the exact slide
// dimensions from presentation.xml instead of being fit onto printer paper.
export async function convertPptxToPdf(arrayBuffer) {
  const presentationXml = await readPresentationXml(arrayBuffer);
  const size = parseSlideSizePoints(presentationXml);
  const expectedSlides = countSlideIds(presentationXml);
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

    // pptx-preview swallows per-slide parse errors and silently truncates
    // its slide list, so never trust it against the deck's own manifest.
    if (expectedSlides > 0 && slides.length !== expectedSlides) {
      throw new Error(
        `Converted only ${slides.length} of ${expectedSlides} slides — this presentation uses ` +
          "content the in-browser converter cannot read. Export the deck to PDF in PowerPoint, " +
          "then watermark that PDF instead.",
      );
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

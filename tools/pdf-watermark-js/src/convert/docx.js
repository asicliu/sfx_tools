import { renderAsync } from "docx-preview";
import {
  createOffscreenHost,
  pagesToPdf,
  rasterizePage,
  waitForRender,
} from "./rasterize.js";

const POINTS_PER_CSS_PX = 72 / 96;

function pageSizePoints(section) {
  // docx-preview writes the page size from w:sectPr onto the section
  // style in pt units; fall back to the laid-out size if absent.
  const width = Number.parseFloat(section.style.width);
  const height = Number.parseFloat(section.style.minHeight);

  return {
    width: Number.isFinite(width) && width > 0 ? width : section.offsetWidth * POINTS_PER_CSS_PX,
    height:
      Number.isFinite(height) && height > 0 ? height : section.offsetHeight * POINTS_PER_CSS_PX,
  };
}

export async function convertDocxToPdf(arrayBuffer) {
  const host = createOffscreenHost();

  try {
    try {
      await renderAsync(arrayBuffer, host, undefined, {
        inWrapper: false,
        breakPages: true,
      });
    } catch {
      throw new Error("Could not read this file as a Word (.docx) document.");
    }
    await waitForRender(host);

    const sections = [...host.querySelectorAll("section.docx")];
    if (sections.length === 0) {
      throw new Error("No pages found in the document.");
    }

    const pages = [];
    for (const section of sections) {
      const size = pageSizePoints(section);
      pages.push(await rasterizePage(section, size.width, size.height));
    }

    return { bytes: await pagesToPdf(pages), warnings: [] };
  } finally {
    host.remove();
  }
}

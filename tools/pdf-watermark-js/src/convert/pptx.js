import JSZip from "jszip";
import { init } from "pptx-preview";
import {
  contentTypesForSingleSlide,
  countSlideIds,
  describeSlideContent,
  findRelationshipTarget,
  parseSlideOrder,
  parseSlideSizePoints,
  rewriteSvgBlips,
  sanitizeSlideXml,
} from "./manifest.js";
import {
  createOffscreenHost,
  pagesToPdf,
  rasterizePage,
  waitForRender,
} from "./rasterize.js";

const CSS_PX_PER_POINT = 96 / 72;
const SVG_RASTER_SCALE = 4;
const SVG_FALLBACK_PX = 128;
const SVG_MAX_PX = 2048;

async function readZipText(zip, path) {
  try {
    return (await zip.file(path)?.async("string")) ?? null;
  } catch {
    return null;
  }
}

async function svgToPngBytes(svgText) {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Could not decode SVG image."));
      image.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.min(SVG_MAX_PX, (image.naturalWidth || SVG_FALLBACK_PX) * SVG_RASTER_SCALE);
    canvas.height = Math.min(SVG_MAX_PX, (image.naturalHeight || SVG_FALLBACK_PX) * SVG_RASTER_SCALE);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("Could not rasterize SVG."))),
        "image/png",
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function resolveMediaPath(target) {
  if (target.startsWith("/")) return target.slice(1);
  return `ppt/${target.replace(/^(\.\.\/)+/, "")}`;
}

// pptx-preview fails on pictures whose only source is an asvg:svgBlip
// extension (SVG-only, no raster fallback). Rasterize each such SVG to PNG
// inside the zip and point the picture at it so the slide keeps its images.
async function embedSvgFallbacks(zip) {
  const slidePaths = Object.keys(zip.files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  let changed = false;

  for (const partName of slidePaths) {
    const slideXml = await readZipText(zip, partName);
    if (!slideXml || !slideXml.includes("asvg:svgBlip")) continue;

    const { xml, svgRelIds } = rewriteSvgBlips(slideXml);
    const relsPath = partName.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    let relsXml = (await readZipText(zip, relsPath)) ?? "";

    for (const relId of svgRelIds) {
      const target = findRelationshipTarget(relsXml, relId);
      if (!target || !target.toLowerCase().endsWith(".svg")) continue;

      const mediaPath = resolveMediaPath(target);
      const svgText = await readZipText(zip, mediaPath);
      if (!svgText) continue;

      const pngPath = `${mediaPath}.png`;
      if (!zip.file(pngPath)) {
        try {
          zip.file(pngPath, await svgToPngBytes(svgText));
        } catch {
          continue;
        }
      }
      relsXml = relsXml.replace(`Target="${target}"`, `Target="${target}.png"`);
    }

    zip.file(relsPath, relsXml);
    zip.file(partName, xml);
    changed = true;
  }

  return changed;
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

async function renderSingleSlide(zip, contentTypesXml, partName, size) {
  zip.file("[Content_Types].xml", contentTypesForSingleSlide(contentTypesXml, partName));
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const { host, slides } = await renderSlidesToHost(buffer, size);
  try {
    if (slides.length !== 1) return null;
    return await rasterizePage(slides[0], size.width, size.height);
  } finally {
    host.remove();
  }
}

// Converts one slide at a time by declaring only that slide in
// [Content_Types].xml, so a slide pptx-preview cannot parse only loses
// itself instead of silently truncating every slide after it. Pages come
// out in true sldIdLst order, unlike the library's filename ordering.
async function convertSlideBySlide(zip, contentTypesXml, slideOrder, size) {
  const pages = [];
  const warnings = [];
  const failedSlides = [];

  for (const [index, partName] of slideOrder.entries()) {
    const slideNumber = index + 1;
    let page = await renderSingleSlide(zip, contentTypesXml, partName, size);

    if (!page) {
      const originalXml = await readZipText(zip, partName);
      const { xml: sanitizedXml, removed } = sanitizeSlideXml(originalXml ?? "");

      if (originalXml && sanitizedXml !== originalXml) {
        zip.file(partName, sanitizedXml);
        page = await renderSingleSlide(zip, contentTypesXml, partName, size);
        zip.file(partName, originalXml);
        if (page) {
          warnings.push(
            `Slide ${slideNumber} was converted without unsupported content` +
              `${removed.length > 0 ? ` (${removed.join(", ")})` : ""}.`,
          );
        }
      }

      if (!page) {
        failedSlides.push({
          number: slideNumber,
          contents: describeSlideContent(originalXml ?? ""),
        });
        continue;
      }
    }

    pages.push(page);
  }

  if (failedSlides.length > 0) {
    const details = failedSlides
      .map(({ number, contents }) =>
        contents.length > 0 ? `${number} (contains: ${contents.join(", ")})` : `${number}`,
      )
      .join("; ");
    throw new Error(
      `Slide${failedSlides.length > 1 ? "s" : ""} ${details} could not be converted in the ` +
        "browser. Remove or simplify that content, or export the deck to PDF in PowerPoint " +
        "and watermark that PDF instead.",
    );
  }

  return { bytes: await pagesToPdf(pages), warnings };
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

  let deckBuffer = arrayBuffer;
  if (await embedSvgFallbacks(zip)) {
    deckBuffer = await zip.generateAsync({ type: "arraybuffer" });
  }

  // pptx-preview swallows per-slide parse errors (silently truncating the
  // deck), so its all-at-once output is only trustworthy when the slide
  // count and slide order can both be confirmed against the manifest.
  const { host, slides } = await renderSlidesToHost(deckBuffer, size);
  const renderedCount = slides.length;
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
      return { bytes: await pagesToPdf(pages), warnings: [] };
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

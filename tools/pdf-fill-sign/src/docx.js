import { renderAsync } from "docx-preview";
import { toCanvas } from "html-to-image";
import { PDFDocument } from "pdf-lib";

const POINTS_PER_CSS_PX = 72 / 96;
const RASTER_PIXEL_RATIO = 2;
const JPEG_QUALITY = 0.92;

async function tryMicrosoftWordConversion(arrayBuffer) {
  let response;
  try {
    response = await fetch("/api/convert-docx", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "X-SFX-Local-Converter": "1",
      },
      body: arrayBuffer,
    });
  } catch {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("application/pdf")) return null;

  return {
    pdfBytes: new Uint8Array(await response.arrayBuffer()),
    conversionMode: "microsoft-word",
  };
}

function createOffscreenHost() {
  const host = document.createElement("div");
  host.className = "docx-conversion-stage";
  host.style.background = "#ffffff";
  document.body.append(host);
  return host;
}

async function waitForRender(host) {
  await document.fonts.ready;
  const images = [...host.querySelectorAll("img")];
  await Promise.all(
    images.map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          }),
    ),
  );
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function pageSizePoints(section) {
  const declaredWidth = Number.parseFloat(section.style.width);
  const declaredHeight = Number.parseFloat(section.style.minHeight);
  return {
    width:
      Number.isFinite(declaredWidth) && declaredWidth > 0
        ? declaredWidth
        : section.offsetWidth * POINTS_PER_CSS_PX,
    height:
      Number.isFinite(declaredHeight) && declaredHeight > 0
        ? declaredHeight
        : section.offsetHeight * POINTS_PER_CSS_PX,
  };
}

async function rasterizePage(section, size) {
  const canvas = await toCanvas(section, {
    pixelRatio: RASTER_PIXEL_RATIO,
    backgroundColor: "#ffffff",
  });
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) =>
        result ? resolve(result) : reject(new Error("Could not rasterize a Word page.")),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
  return { bytes: await blob.arrayBuffer(), ...size };
}

async function pagesToPdf(pages) {
  const pdf = await PDFDocument.create();
  for (const pageImage of pages) {
    const image = await pdf.embedJpg(pageImage.bytes);
    const page = pdf.addPage([pageImage.width, pageImage.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: pageImage.width,
      height: pageImage.height,
    });
  }
  pdf.setProducer("SFX Tools browser DOCX converter");
  return pdf.save();
}

async function convertInBrowser(arrayBuffer, onProgress) {
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
    if (!sections.length) throw new Error("No pages were found in this Word document.");

    const pages = [];
    for (const [index, section] of sections.entries()) {
      onProgress(`Rendering Word page ${index + 1} of ${sections.length}…`);
      pages.push(await rasterizePage(section, pageSizePoints(section)));
    }

    return {
      pdfBytes: new Uint8Array(await pagesToPdf(pages)),
      conversionMode: "browser",
    };
  } finally {
    host.remove();
  }
}

export async function convertDocxToPdf(arrayBuffer, onProgress = () => {}) {
  if (import.meta.env.DEV) {
    onProgress("Checking for the Microsoft Word converter…");
    const wordConversion = await tryMicrosoftWordConversion(arrayBuffer);
    if (wordConversion) return wordConversion;
  }

  onProgress("Rendering Word document privately in this browser…");
  return convertInBrowser(arrayBuffer, onProgress);
}

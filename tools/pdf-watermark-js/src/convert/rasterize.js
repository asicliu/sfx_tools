import { toCanvas } from "html-to-image";
import { PDFDocument } from "pdf-lib";

const RASTER_PIXEL_RATIO = 2;
const JPEG_QUALITY = 0.92;

export function createOffscreenHost() {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-100000px";
  host.style.top = "0";
  host.style.background = "#ffffff";
  document.body.append(host);
  return host;
}

export async function waitForRender(host) {
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

  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}

export async function rasterizePage(element, widthPoints, heightPoints) {
  const canvas = await toCanvas(element, {
    pixelRatio: RASTER_PIXEL_RATIO,
    backgroundColor: "#ffffff",
  });
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) =>
        result ? resolve(result) : reject(new Error("Could not rasterize page.")),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });

  return { bytes: await blob.arrayBuffer(), width: widthPoints, height: heightPoints };
}

export async function pagesToPdf(pages) {
  const pdfDoc = await PDFDocument.create();

  for (const pageImage of pages) {
    const image = await pdfDoc.embedJpg(pageImage.bytes);
    const page = pdfDoc.addPage([pageImage.width, pageImage.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: pageImage.width,
      height: pageImage.height,
    });
  }

  return pdfDoc.save();
}

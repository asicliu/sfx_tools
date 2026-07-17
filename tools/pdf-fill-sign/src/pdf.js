import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function isPdfFile(file) {
  return Boolean(file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name)));
}

export function isDocxFile(file) {
  return Boolean(
    file &&
      (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        /\.docx$/i.test(file.name)),
  );
}

export function signedFilename(filename) {
  const stem = (filename || "document").replace(/\.(pdf|docx)$/i, "") || "document";
  return `${stem}_signed.pdf`;
}

export function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export async function openPdfForPreview(bytes) {
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice() }).promise;
}

export async function renderPdfPage(pdf, pageNumber, canvas, zoom, previousTask) {
  if (previousTask) {
    try {
      previousTask.cancel();
      await previousTask.promise;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") throw error;
    }
  }

  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: zoom });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const context = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const renderTask = page.render({
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    background: "white",
  });

  await renderTask.promise;
  return { viewport, renderTask: null };
}

export function downloadPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

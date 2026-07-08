import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

// Pixels of canvas raster per PDF point (~288 dpi) for non-Latin watermarks.
const RASTER_SCALE = 4;

// Helvetica (WinAnsi) covers Latin-1 only; anything beyond needs the
// canvas-rasterized watermark path (CJK, emoji, etc.).
export function needsRasterText(text) {
  return /[^ -ÿ]/.test(text);
}

function* stampPositions(width, height, options) {
  if (options.repeat) {
    for (let x = -width; x < width * 2; x += options.spacingX) {
      for (let y = -height; y < height * 2; y += options.spacingY) {
        yield { x, y };
      }
    }
  } else {
    yield { x: width / 2, y: height / 2 };
  }
}

function drawCenteredText(page, text, font, options) {
  const textWidth = font.widthOfTextAtSize(text, options.fontSize);
  const radians = (options.rotation * Math.PI) / 180;
  const dx = -(textWidth / 2) * Math.cos(radians);
  const dy = -(textWidth / 2) * Math.sin(radians);

  page.drawText(text, {
    x: options.x + dx,
    y: options.y + dy,
    font,
    size: options.fontSize,
    color: options.color,
    opacity: options.opacity,
    rotate: degrees(options.rotation),
  });
}

function rasterizeWatermarkText(text, fontSize, colorHex) {
  const fontPx = fontSize * RASTER_SCALE;
  const fontSpec = `700 ${fontPx}px Helvetica, "PingFang SC", "Microsoft YaHei", sans-serif`;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = fontSpec;
  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent ?? fontPx * 0.8;
  const descent = metrics.actualBoundingBoxDescent ?? fontPx * 0.25;

  canvas.width = Math.max(1, Math.ceil(metrics.width));
  canvas.height = Math.max(1, Math.ceil(ascent + descent));
  ctx.font = fontSpec;
  ctx.fillStyle = colorHex;
  ctx.fillText(text, 0, ascent);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width / RASTER_SCALE,
    height: canvas.height / RASTER_SCALE,
  };
}

function drawCenteredImage(page, image, stamp, options) {
  const radians = (options.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfW = stamp.width / 2;
  const halfH = stamp.height / 2;

  page.drawImage(image, {
    x: options.x - (halfW * cos - halfH * sin),
    y: options.y - (halfW * sin + halfH * cos),
    width: stamp.width,
    height: stamp.height,
    opacity: options.opacity,
    rotate: degrees(options.rotation),
  });
}

export async function applyWatermark(pdfBytes, options) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const useRaster = needsRasterText(options.text);

  if (useRaster && typeof document === "undefined") {
    throw new Error("Non-Latin watermark text is only supported in the browser.");
  }

  let font = null;
  let stamp = null;
  let stampImage = null;

  if (useRaster) {
    stamp = rasterizeWatermarkText(options.text, options.fontSize, options.colorHex ?? "#333333");
    stampImage = await pdfDoc.embedPng(stamp.dataUrl);
  } else {
    font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  const color = rgb(options.colorR, options.colorG, options.colorB);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();

    for (const { x, y } of stampPositions(width, height, options)) {
      if (useRaster) {
        drawCenteredImage(page, stampImage, stamp, {
          x,
          y,
          opacity: options.opacity,
          rotation: options.rotation,
        });
      } else {
        drawCenteredText(page, options.text, font, {
          x,
          y,
          fontSize: options.fontSize,
          color,
          opacity: options.opacity,
          rotation: options.rotation,
        });
      }
    }
  }

  return pdfDoc.save();
}

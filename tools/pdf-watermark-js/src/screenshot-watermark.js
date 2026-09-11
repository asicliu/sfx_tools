import QRCode from 'qrcode';
import { rgb } from 'pdf-lib';

import { PREFIX, MAX_SCREENSHOT_TEXT_BYTES, checksum } from "./screenshot-payload.js";

export function createScreenshotCode(text) {
  text = text?.trim() || '';
  if (!text || new TextEncoder().encode(text).length > MAX_SCREENSHOT_TEXT_BYTES) {
    throw new Error('Screenshot watermark needs 1–64 UTF-8 bytes. Use a short recipient ID for longer text.');
  }
  return QRCode.create(`${PREFIX}${checksum(text)}:${text}`, { errorCorrectionLevel: 'H' }).modules;
}

// Include a four-module quiet zone; clipped tiles are deliberately avoided.
export function* screenshotTiles(width, height, modules) {
  const size = Math.min(156, width - 16, height - 16);
  if (size / (modules.size + 8) < 2) {
    throw new Error('Page is too small for this screenshot watermark. Use a shorter ID or larger page.');
  }
  const columns = Math.max(1, Math.floor((width - 16) / (size + 20)));
  const rows = Math.max(1, Math.floor((height - 16) / (size + 20)));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      yield { x: (col + 0.5) * width / columns - size / 2,
        y: (row + 0.5) * height / rows - size / 2, size };
    }
  }
}

export function drawScreenshotWatermark(pdfDoc, text, strength = 0.12) {
  if (!Number.isFinite(strength) || strength < 0.06 || strength > 0.25) {
    throw new Error('Screenshot watermark strength must be between 0.06 and 0.25.');
  }
  const modules = createScreenshotCode(text);
  for (const page of pdfDoc.getPages()) {
    const { x: left, y: bottom, width, height } = page.getCropBox();
    for (const tile of screenshotTiles(width, height, modules)) {
      const cell = tile.size / (modules.size + 8);
      for (let row = 0; row < modules.size; row++) {
        // Merge horizontal runs to reduce PDF drawing operations.
        for (let col = 0; col < modules.size; col++) {
          if (!modules.get(row, col)) continue;
          const start = col;
          while (col + 1 < modules.size && modules.get(row, col + 1)) col++;
          page.drawRectangle({ x: left + tile.x + (start + 4) * cell,
            y: bottom + tile.y + (modules.size + 3 - row) * cell,
            width: (col - start + 1) * cell, height: cell,
            color: rgb(0, 0, 0), opacity: strength, borderWidth: 0 });
        }
      }
    }
  }
}

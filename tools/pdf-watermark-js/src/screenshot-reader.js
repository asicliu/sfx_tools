import jsQR from 'jsqr';
import { readScreenshotPayload } from './screenshot-payload.js';

// Work on separate crops so multiple repeated finder patterns do not compete.
export function decodeScreenshot({ data, width, height }) {
  if (width < 32 || height < 32 || width * height > 6_000_000 || data.length !== width * height * 4) {
    throw new Error('Image dimensions are unsupported. Use a screenshot up to 6 megapixels.');
  }
  const found = new Set();
  function scan(x, y, w, h) {
    const raw = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      raw.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
    }
    // The narrow light bands amplify faint marks on light backgrounds and
    // suppress dark document text. A normal pass handles higher contrast crops.
    for (const threshold of [242, 232, 220, 205, null]) {
      const pixels = threshold === null ? raw : new Uint8ClampedArray(raw.length);
      if (threshold !== null) for (let i = 0; i < raw.length; i += 4) {
        const gray = (raw[i] + raw[i + 1] + raw[i + 2]) / 3;
        const value = gray >= 165 && gray < threshold ? 0 : 255;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
        pixels[i + 3] = 255;
      }
      const code = jsQR(pixels, w, h, { inversionAttempts: 'dontInvert' });
      const text = readScreenshotPayload(code?.data);
      if (text) { found.add(text); return; }
    }
  }
  scan(0, 0, width, height);
  // Stop at the first validated identifier; this is a reader, not a complete
  // inventory of all possible marks in a composite image.
  if (found.size) return [...found];
  for (const size of [256, 384, 576, 864]) {
    const w = Math.min(size, width), h = Math.min(size, height);
    const step = Math.floor(size / 2);
    for (let y = 0; ; y = Math.min(y + step, height - h)) {
      for (let x = 0; ; x = Math.min(x + step, width - w)) {
        scan(x, y, w, h);
        if (found.size) return [...found];
        if (x === width - w) break;
      }
      if (y === height - h) break;
    }
  }
  return [];
}

export const PREFIX = 'SFX-WM1:';
export const MAX_SCREENSHOT_TEXT_BYTES = 64;

// A checksum rejects damaged/unrelated payloads; it is not authentication.
export function checksum(text) {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function readScreenshotPayload(payload) {
  if (!payload?.startsWith(PREFIX)) return null;
  const hash = payload.slice(PREFIX.length, PREFIX.length + 8);
  const text = payload.slice(PREFIX.length + 9);
  if (payload[PREFIX.length + 8] !== ':' || !text ||
      new TextEncoder().encode(text).length > MAX_SCREENSHOT_TEXT_BYTES || checksum(text) !== hash) return null;
  return text;
}


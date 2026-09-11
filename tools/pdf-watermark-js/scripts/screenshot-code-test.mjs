import assert from 'node:assert/strict';
import { createScreenshotCode } from '../src/screenshot-watermark.js';
import { decodeScreenshot } from '../src/screenshot-reader.js';
import { checksum, readScreenshotPayload } from '../src/screenshot-payload.js';

function image(text, cell = 4, gray = 224) {
  const code = createScreenshotCode(text);
  const width = (code.size + 8) * cell;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < code.size; row++) for (let col = 0; col < code.size; col++) {
    if (!code.get(row, col)) continue;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const i = (((row + 4) * cell + y) * width + (col + 4) * cell + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
  }
  return { data, width, height: width };
}
for (const text of ['CONFIDENTIAL', 'Recipient 测试 😀', 'a'.repeat(64)]) {
  for (const gray of [239, 224, 191]) assert.deepEqual(decodeScreenshot(image(text, 3, gray)), [text]);
}
assert.equal(checksum('123456789'), 'cbf43926');
assert.equal(readScreenshotPayload('https://example.com'), null);
assert.equal(readScreenshotPayload('SFX-WM1:00000000:fake'), null);
assert.throws(() => createScreenshotCode('测'.repeat(22)), /1–64/);
assert.throws(() => createScreenshotCode('  '), /1–64/);
const blank = image('TEST');
blank.data.fill(255);
assert.deepEqual(decodeScreenshot(blank), []);
assert.throws(() => decodeScreenshot({data:[], width:5000, height:5000}), /dimensions/);
console.log('Screenshot code checks passed: Unicode, length limits, opacity, checksum, and negatives');

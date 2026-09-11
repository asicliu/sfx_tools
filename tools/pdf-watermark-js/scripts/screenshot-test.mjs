import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, rgb } from 'pdf-lib';
import { PNG } from 'pngjs';
import { applyWatermark } from '../src/watermark.js';
import { encryptPdfPermissions } from '../src/encryption.js';
import { decodeScreenshot } from '../src/screenshot-reader.js';
import { createScreenshotCode } from '../src/screenshot-watermark.js';

// Requires Poppler. JPEG/resize checks additionally use macOS sips.
const dir = mkdtempSync(join(tmpdir(), 'sfx-screenshot-'));
const id = 'Recipient 测试 / A-104';
const pdf = await PDFDocument.create();
const p = pdf.addPage([612, 792]);
p.drawText('Screenshot watermark recovery test', { x: 40, y: 730, size: 22 });
p.drawText('Document text stays selectable.', { x: 40, y: 690, size: 14 });
p.drawRectangle({ x: 40, y: 70, width: 240, height: 100, color: rgb(0.15, 0.4, 0.7) });
const original = await pdf.save();
const output = await applyWatermark(original, { visible: false, screenshotText: id });
writeFileSync(join(dir, 'watermarked.pdf'), encryptPdfPermissions(output, { ownerPassword: 'test-password' }));
writeFileSync(join(dir, 'original.pdf'), original);
function render(name, dpi) {
  const target = join(dir, `${name}-${dpi}`);
  execFileSync('pdftoppm', ['-r', String(dpi), '-singlefile', '-png', join(dir, `${name}.pdf`), target]);
  return `${target}.png`;
}
function check(path, expected = id) {
  const png = PNG.sync.read(readFileSync(path));
  const start = Date.now();
  assert.deepEqual(decodeScreenshot(png), expected ? [expected] : []);
  console.log(`PASS ${path} (${Date.now() - start}ms)`);
}
for (const dpi of [72, 96, 144]) check(render('watermarked', dpi));
check(render('original', 72), null);
const input = join(dir, 'watermarked-144.png');
if (process.platform === 'darwin') {
  const resized = join(dir, 'resized.png');
  execFileSync('sips', ['-Z', '900', input, '--out', resized]);
  check(resized);
  const jpeg = join(dir, 'compressed.jpg');
  const decoded = join(dir, 'compressed.png');
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '60', resized, '--out', jpeg]);
  execFileSync('sips', ['-s', 'format', 'png', jpeg, '--out', decoded]);
  check(decoded);
}
const full = PNG.sync.read(readFileSync(input));
// A partial-page screenshot retaining one entire tile.
const crop = new PNG({ width: 352, height: 400 });
PNG.bitblt(full, crop, 25, 421, crop.width, crop.height, 0, 0);
const cropped = join(dir, 'cropped.png');
writeFileSync(cropped, PNG.sync.write(crop));
check(cropped);
const rotated = new PNG({ width: crop.height, height: crop.width });
for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
  const src = (y * crop.width + x) * 4;
  const dst = (x * rotated.width + crop.height - 1 - y) * 4;
  rotated.data.set(crop.data.subarray(src, src + 4), dst);
}
const rotatedPath = join(dir, 'rotated.png');
writeFileSync(rotatedPath, PNG.sync.write(rotated));
check(rotatedPath);
assert.throws(() => createScreenshotCode(''), /1–64/);
assert.throws(() => createScreenshotCode('测'.repeat(22)), /1–64/);
console.log(`Screenshot artifacts: ${dir}`);

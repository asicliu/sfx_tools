import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

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

export async function applyWatermark(pdfBytes, options) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const color = rgb(options.colorR, options.colorG, options.colorB);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();

    if (options.repeat) {
      for (let x = -width; x < width * 2; x += options.spacingX) {
        for (let y = -height; y < height * 2; y += options.spacingY) {
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
    } else {
      drawCenteredText(page, options.text, font, {
        x: width / 2,
        y: height / 2,
        fontSize: options.fontSize,
        color,
        opacity: options.opacity,
        rotation: options.rotation,
      });
    }
  }

  return pdfDoc.save();
}

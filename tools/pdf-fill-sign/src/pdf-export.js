import { LineCapStyle, PDFDocument, StandardFonts, rgb } from "pdf-lib";

function normalizeText(text) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDataUrl(dataUrl) {
  const [, base64 = ""] = String(dataUrl).split(",", 2);
  if (typeof atob === "function") {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function wrapText(text, font, size, maxWidth) {
  const lines = [];
  const paragraphs = String(text || "").replace(/\r/g, "").split("\n");

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }

      let fragment = "";
      for (const character of word) {
        const next = `${fragment}${character}`;
        if (fragment && font.widthOfTextAtSize(next, size) > maxWidth) {
          lines.push(fragment);
          fragment = character;
        } else {
          fragment = next;
        }
      }
      line = fragment;
    }
    if (line) lines.push(line);
  }

  return lines;
}

export async function applyAnnotations(inputBytes, annotations) {
  const pdf = await PDFDocument.load(inputBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const embeddedSignatures = new Map();

  for (const annotation of annotations) {
    const page = pages[annotation.page - 1];
    if (!page) continue;

    const { width, height } = page.getSize();

    if (annotation.type === "text") {
      const text = normalizeText(annotation.text);
      if (!text) continue;

      const size = Number(annotation.fontSize) || 12;
      page.drawText(text, {
        x: annotation.x * width,
        y: height - annotation.y * height - size,
        size,
        font,
        color: rgb(0.07, 0.08, 0.1),
      });
      continue;
    }

    if (annotation.type === "textbox") {
      const text = String(annotation.text || "");
      if (!text.trim()) continue;
      const size = Number(annotation.fontSize) || 10;
      const leftInset = 7;
      const rightInset = 22;
      const topInset = 7;
      const boxWidth = Math.max(1, annotation.width * width - leftInset - rightInset);
      const lineHeight = size * 1.25;
      const lines = wrapText(text, font, size, boxWidth);
      let y = height - annotation.y * height - topInset - size;

      for (const line of lines) {
        if (line) {
          page.drawText(line, {
            x: annotation.x * width + leftInset,
            y,
            size,
            font,
            color: rgb(0.07, 0.08, 0.1),
          });
        }
        y -= lineHeight;
      }
      continue;
    }

    if (annotation.type === "ink" && annotation.points?.length) {
      const thickness = Number(annotation.thickness) || 1.8;
      const points = annotation.points.map((point) => ({
        x: point.x * width,
        y: height - point.y * height,
      }));

      if (points.length === 1) {
        page.drawCircle({
          x: points[0].x,
          y: points[0].y,
          size: thickness / 2,
          color: rgb(0.06, 0.07, 0.09),
        });
      } else {
        for (let index = 1; index < points.length; index += 1) {
          page.drawLine({
            start: points[index - 1],
            end: points[index],
            thickness,
            color: rgb(0.06, 0.07, 0.09),
            lineCap: LineCapStyle.Round,
          });
        }
      }
      continue;
    }

    if (annotation.type === "signature" && annotation.imageData) {
      let image = embeddedSignatures.get(annotation.imageData);
      if (!image) {
        image = await pdf.embedPng(decodeDataUrl(annotation.imageData));
        embeddedSignatures.set(annotation.imageData, image);
      }

      const imageWidth = annotation.width * width;
      const imageHeight = annotation.height * height;
      page.drawImage(image, {
        x: annotation.x * width,
        y: height - (annotation.y + annotation.height) * height,
        width: imageWidth,
        height: imageHeight,
      });
    }
  }

  pdf.setModificationDate(new Date());
  pdf.setProducer("SFX Tools PDF Fill & Sign");
  return pdf.save();
}

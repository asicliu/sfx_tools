import { jsPDF } from "jspdf";
import { marked } from "marked";

const PAGE_FORMATS = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  legal: [612, 1008],
};

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textFromInlineTokens(tokens = []) {
  return decodeEntities(
    tokens
      .map((token) => {
        if (token.type === "image") return token.text ? `[Image: ${token.text}]` : "[Image]";
        if (token.type === "link") return textFromInlineTokens(token.tokens);
        if (token.type === "br") return "\n";
        if (token.tokens) return textFromInlineTokens(token.tokens);
        return token.text || token.raw || "";
      })
      .join(""),
  );
}

function textFromBlockTokens(tokens = []) {
  return tokens
    .map((token) => {
      if (token.type === "space" || token.type === "hr") return "";
      if (token.type === "code") return token.text || "";
      if (token.type === "list") return token.items.map((item) => textFromBlockTokens(item.tokens)).join("\n");
      if (token.type === "table") {
        const header = token.header.map((cell) => textFromInlineTokens(cell.tokens)).join(" | ");
        const rows = token.rows
          .map((row) => row.map((cell) => textFromInlineTokens(cell.tokens)).join(" | "))
          .join("\n");
        return `${header}\n${rows}`;
      }
      if (token.tokens) return textFromInlineTokens(token.tokens);
      return token.text || token.raw || "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeFilename(filename) {
  const trimmed = (filename || "document.pdf").trim();
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
}

function createWriter(options) {
  const format = PAGE_FORMATS[options.pageSize] || PAGE_FORMATS.letter;
  const doc = new jsPDF({ unit: "pt", format });
  const margin = clamp(options.marginInches, 0.25, 2, 0.75) * 72;
  const bodySize = clamp(options.bodySize, 8, 18, 11);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  function bottom() {
    return pageHeight - margin;
  }

  function ensureSpace(height) {
    if (y + height <= bottom()) return;
    doc.addPage();
    y = margin;
  }

  function addGap(size) {
    y += size;
  }

  function writeLines(lines, config = {}) {
    const fontSize = config.fontSize || bodySize;
    const lineHeight = config.lineHeight || fontSize * 1.45;
    const x = margin + (config.indent || 0);
    const width = maxWidth - (config.indent || 0);
    const wrapped = Array.isArray(lines)
      ? lines.flatMap((line) => doc.splitTextToSize(line || " ", width))
      : doc.splitTextToSize(lines || " ", width);

    doc.setFont(config.font || "helvetica", config.style || "normal");
    doc.setFontSize(fontSize);
    doc.setTextColor(config.color || "#18202f");

    for (const line of wrapped) {
      ensureSpace(lineHeight);
      doc.text(line, x, y);
      y += lineHeight;
    }
  }

  function writeParagraph(text, config = {}) {
    writeLines(text, config);
    addGap(config.after ?? bodySize * 0.8);
  }

  function writeCode(text) {
    const fontSize = Math.max(8, bodySize - 1);
    const lineHeight = fontSize * 1.45;
    const lines = (text || "").split(/\r?\n/);
    const wrapped = lines.flatMap((line) => doc.splitTextToSize(line || " ", maxWidth - 24));

    for (const line of wrapped) {
      ensureSpace(lineHeight + 8);
      doc.setFillColor("#f1f5f9");
      doc.rect(margin, y - fontSize, maxWidth, lineHeight + 4, "F");
      doc.setFont("courier", "normal");
      doc.setFontSize(fontSize);
      doc.setTextColor("#1f2937");
      doc.text(line, margin + 12, y);
      y += lineHeight;
    }
    addGap(bodySize);
  }

  function writeList(token, depth = 0) {
    const indent = depth * 18;

    token.items.forEach((item, index) => {
      const bullet = token.ordered ? `${(token.start || 1) + index}.` : "•";
      const itemText = textFromBlockTokens(item.tokens).replace(/\s+/g, " ").trim();
      const bulletWidth = doc.getTextWidth(`${bullet} `) + 6;
      const lines = doc.splitTextToSize(itemText || " ", maxWidth - indent - bulletWidth);
      const lineHeight = bodySize * 1.45;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(bodySize);
      doc.setTextColor("#18202f");

      lines.forEach((line, lineIndex) => {
        ensureSpace(lineHeight);
        const x = margin + indent;
        if (lineIndex === 0) doc.text(bullet, x, y);
        doc.text(line, x + bulletWidth, y);
        y += lineHeight;
      });

      addGap(bodySize * 0.35);
    });
    addGap(bodySize * 0.4);
  }

  function writeTable(token) {
    const headers = token.header.map((cell) => textFromInlineTokens(cell.tokens));
    const rows = token.rows.map((row) => row.map((cell) => textFromInlineTokens(cell.tokens)));
    const colCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
    const colWidth = maxWidth / colCount;
    const fontSize = Math.max(8, bodySize - 1);
    const lineHeight = fontSize * 1.35;

    function drawRow(cells, isHeader = false) {
      const wrapped = Array.from({ length: colCount }, (_, index) =>
        doc.splitTextToSize(cells[index] || "", colWidth - 12),
      );
      const rowHeight = Math.max(...wrapped.map((cell) => cell.length), 1) * lineHeight + 12;

      ensureSpace(rowHeight);
      doc.setDrawColor("#cbd5e1");
      doc.setFillColor(isHeader ? "#e2e8f0" : "#ffffff");
      doc.rect(margin, y - fontSize, maxWidth, rowHeight, "FD");

      wrapped.forEach((cell, index) => {
        const x = margin + colWidth * index;
        if (index > 0) doc.line(x, y - fontSize, x, y - fontSize + rowHeight);
        doc.setFont("helvetica", isHeader ? "bold" : "normal");
        doc.setFontSize(fontSize);
        doc.setTextColor("#18202f");
        cell.forEach((line, lineIndex) => {
          doc.text(line, x + 6, y + lineIndex * lineHeight);
        });
      });

      y += rowHeight + 2;
    }

    drawRow(headers, true);
    rows.forEach((row) => drawRow(row));
    addGap(bodySize);
  }

  function writeToken(token) {
    if (token.type === "space") return;

    if (token.type === "heading") {
      const sizes = { 1: bodySize + 13, 2: bodySize + 9, 3: bodySize + 6, 4: bodySize + 3 };
      writeParagraph(textFromInlineTokens(token.tokens), {
        fontSize: sizes[token.depth] || bodySize + 1,
        lineHeight: (sizes[token.depth] || bodySize + 1) * 1.22,
        style: "bold",
        after: bodySize,
      });
      return;
    }

    if (token.type === "paragraph") {
      writeParagraph(textFromInlineTokens(token.tokens));
      return;
    }

    if (token.type === "blockquote") {
      const startY = y - bodySize;
      writeParagraph(textFromBlockTokens(token.tokens), {
        indent: 18,
        color: "#475569",
        after: bodySize,
      });
      doc.setDrawColor("#94a3b8");
      doc.setLineWidth(3);
      doc.line(margin + 4, startY, margin + 4, y - bodySize * 0.4);
      return;
    }

    if (token.type === "list") {
      writeList(token);
      return;
    }

    if (token.type === "code") {
      writeCode(token.text);
      return;
    }

    if (token.type === "table") {
      writeTable(token);
      return;
    }

    if (token.type === "hr") {
      ensureSpace(bodySize * 2);
      doc.setDrawColor("#cbd5e1");
      doc.line(margin, y, margin + maxWidth, y);
      addGap(bodySize * 1.5);
      return;
    }

    if (token.text || token.raw) {
      writeParagraph(token.text || token.raw);
    }
  }

  return {
    doc,
    write(tokens) {
      tokens.forEach(writeToken);
    },
  };
}

export function createMarkdownPdf(markdown, options = {}) {
  const tokens = marked.lexer(markdown || "", { gfm: true, breaks: false });
  const writer = createWriter(options);
  writer.write(tokens);
  return writer.doc;
}

export function downloadMarkdownPdf(markdown, options = {}) {
  const doc = createMarkdownPdf(markdown, options);
  doc.save(normalizeFilename(options.filename));
}

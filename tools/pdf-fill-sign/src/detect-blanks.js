const MIN_WIDTH_FRACTION = 0.02;
const LABEL_GAP_MIN_EM = 1.5;
const RIGHT_CONTENT_MARGIN = 40;
const LINE_BASELINE_TOLERANCE_EM = 0.5;
const RUN_JOIN_GAP_EM = 0.6;
const SPAN_MERGE_EPSILON = 0.5;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 14;
const BOX_MIN_HEIGHT = 38;
const BOX_HEIGHT_FACTOR = 1.6;
// Matches the export/textarea top inset (see pdf-export.js) so the exported first
// text line's baseline coincides with the detected span's baseline.
const TEXT_TOP_INSET = 7;

export const MAX_AUTO_REGIONS = 200;

const RUN_PATTERNS = [/_{3,}/g, /\.{5,}/g];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toEntry(item) {
  if (!item || typeof item.str !== "string" || !item.str.trim()) return null;
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const [scaleX, skewY, skewX, scaleY, x, y] = transform;
  if (Math.abs(skewY) > 0.01 || Math.abs(skewX) > 0.01 || scaleX <= 0 || scaleY <= 0) {
    return null;
  }
  const width = Number(item.width) || 0;
  if (width <= 0) return null;
  return { str: item.str, x, y, width, fontSize: Math.abs(scaleY) };
}

function clusterLines(entries) {
  const lines = [];
  const sorted = [...entries].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const entry of sorted) {
    const tolerance = LINE_BASELINE_TOLERANCE_EM * entry.fontSize;
    const line = lines.find((candidate) => Math.abs(candidate.y - entry.y) <= tolerance);
    if (line) {
      line.entries.push(entry);
    } else {
      lines.push({ y: entry.y, entries: [entry] });
    }
  }
  for (const line of lines) line.entries.sort((a, b) => a.x - b.x);
  return lines;
}

function collectRunSpans(line) {
  const spans = [];
  for (const entry of line.entries) {
    const charWidth = entry.width / entry.str.length;
    for (const pattern of RUN_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(entry.str)) !== null) {
        spans.push({
          start: entry.x + match.index * charWidth,
          end: entry.x + (match.index + match[0].length) * charWidth,
          baseline: entry.y,
          fontSize: entry.fontSize,
        });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start - previous.end <= RUN_JOIN_GAP_EM * previous.fontSize) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function collectLabelGapSpans(line, pageWidth) {
  const spans = [];
  for (const [index, entry] of line.entries.entries()) {
    if (!entry.str.trimEnd().endsWith(":")) continue;
    const gapStart = entry.x + entry.width;
    const next = line.entries[index + 1];
    const gapEnd = next ? next.x : pageWidth - RIGHT_CONTENT_MARGIN;
    if (gapEnd - gapStart < LABEL_GAP_MIN_EM * entry.fontSize) continue;
    spans.push({
      start: gapStart,
      end: gapEnd,
      baseline: entry.y,
      fontSize: entry.fontSize,
    });
  }
  return spans;
}

function mergeLineSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end + SPAN_MERGE_EPSILON) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function toRegion(span, pageWidth, pageHeight) {
  const fontSize = Math.round(clamp(span.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE));
  const heightPdf = Math.max(BOX_HEIGHT_FACTOR * span.fontSize, BOX_MIN_HEIGHT);
  const topPdf = Math.min(span.baseline + TEXT_TOP_INSET + fontSize, pageHeight);
  const x = clamp(span.start / pageWidth, 0, 1);
  const width = clamp((span.end - span.start) / pageWidth, 0, 1 - x);
  const height = clamp(heightPdf / pageHeight, 0, 1);
  const y = clamp(1 - topPdf / pageHeight, 0, 1 - height);
  return {
    x,
    y,
    width,
    height,
    fontSize,
  };
}

export function detectBlankRegions(textItems, pageWidth, pageHeight, options = {}) {
  const maxRegions = options.maxRegions ?? MAX_AUTO_REGIONS;
  if (!Array.isArray(textItems) || !(pageWidth > 0) || !(pageHeight > 0) || maxRegions <= 0) {
    return [];
  }

  const entries = textItems.map(toEntry).filter(Boolean);
  const regions = [];
  for (const line of clusterLines(entries)) {
    const spans = mergeLineSpans([
      ...collectRunSpans(line),
      ...collectLabelGapSpans(line, pageWidth),
    ]);
    for (const span of spans) {
      if (span.end - span.start < MIN_WIDTH_FRACTION * pageWidth) continue;
      regions.push(toRegion(span, pageWidth, pageHeight));
    }
  }

  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  return regions.slice(0, maxRegions);
}

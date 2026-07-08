const EMU_PER_POINT = 12700;

// ECMA-376 default when <p:sldSz> is omitted: 10in x 7.5in.
const DEFAULT_SLIDE_SIZE = { width: 720, height: 540 };

const SLIDE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

export function parseSlideSizePoints(presentationXml) {
  const tag = presentationXml.match(/<p:sldSz\b[^>]*\/?>/)?.[0];
  if (!tag) return DEFAULT_SLIDE_SIZE;

  const cx = Number(tag.match(/\bcx="(\d+)"/)?.[1]);
  const cy = Number(tag.match(/\bcy="(\d+)"/)?.[1]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) {
    return DEFAULT_SLIDE_SIZE;
  }

  return { width: cx / EMU_PER_POINT, height: cy / EMU_PER_POINT };
}

export function countSlideIds(presentationXml) {
  return (presentationXml.match(/<p:sldId\s/g) || []).length;
}

// Slide part names (e.g. "ppt/slides/slide4.xml") in true presentation
// order: sldIdLst r:id references resolved through presentation.xml.rels.
export function parseSlideOrder(presentationXml, relsXml) {
  const targets = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = match[0].match(/\bId="([^"]+)"/)?.[1];
    const target = match[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) targets.set(id, target);
  }

  const order = [];
  for (const match of presentationXml.matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const relId = match[0].match(/\br:id="([^"]+)"/)?.[1];
    const target = targets.get(relId);
    if (!target) return [];
    order.push(target.startsWith("/") ? target.slice(1) : `ppt/${target}`);
  }

  return order;
}

// Rewrites [Content_Types].xml so only one slide part is declared,
// which limits pptx-preview to loading exactly that slide.
export function contentTypesForSingleSlide(contentTypesXml, slidePartName) {
  return contentTypesXml.replace(/<Override\b[^>]*\/>/g, (override) => {
    if (!override.includes(SLIDE_CONTENT_TYPE)) return override;
    return override.includes(`PartName="/${slidePartName}"`) ? override : "";
  });
}

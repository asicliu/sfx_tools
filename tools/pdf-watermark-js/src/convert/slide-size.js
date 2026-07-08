const EMU_PER_POINT = 12700;

// ECMA-376 default when <p:sldSz> is omitted: 10in x 7.5in.
const DEFAULT_SLIDE_SIZE = { width: 720, height: 540 };

export function countSlideIds(presentationXml) {
  return (presentationXml.match(/<p:sldId\s/g) || []).length;
}

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

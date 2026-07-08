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

const CONTENT_MARKERS = [
  { pattern: /asvg:svgBlip/, label: "SVG image" },
  { pattern: /uri="[^"]*\/diagram"|<dgm:/, label: "SmartArt diagram" },
  { pattern: /<p:oleObj|uri="[^"]*\/ole(Object)?"/, label: "embedded object" },
  { pattern: /uri="[^"]*\/chart(ex)?"/, label: "chart" },
  { pattern: /<a:videoFile|<a:audioFile/, label: "audio/video" },
  { pattern: /<m:oMath/, label: "equation" },
  { pattern: /<mc:AlternateContent/, label: "modern drawing features" },
  { pattern: /<a:tbl/, label: "table" },
  { pattern: /<p:pic/, label: "picture" },
];

export function describeSlideContent(slideXml) {
  return CONTENT_MARKERS.filter(({ pattern }) => pattern.test(slideXml)).map(
    ({ label }) => label,
  );
}

const GRAPHIC_FRAME = /<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g;

const UNSUPPORTED_GRAPHIC_URIS = [
  { match: "/diagram", label: "SmartArt diagram" },
  { match: "/ole", label: "embedded object" },
];

// Last-resort rewrite for a slide pptx-preview failed to parse: resolve
// mc:AlternateContent to its spec-defined fallback branch and drop content
// classes the renderer cannot handle, so the rest of the slide survives.
export function sanitizeSlideXml(slideXml) {
  const removed = [];
  let xml = slideXml;

  xml = xml.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, (block) => {
    const fallback = block.match(/<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/)?.[1];
    if (fallback != null) return fallback;
    removed.push("unsupported drawing");
    return "";
  });

  xml = xml.replace(GRAPHIC_FRAME, (frame) => {
    const uri = frame.match(/<a:graphicData\b[^>]*\buri="([^"]*)"/)?.[1] ?? "";
    const unsupported = UNSUPPORTED_GRAPHIC_URIS.find(({ match }) => uri.includes(match));
    if (!unsupported) return frame;
    removed.push(unsupported.label);
    return "";
  });

  xml = xml.replace(/<p:timing>[\s\S]*?<\/p:timing>/g, "");
  xml = xml.replace(/<p:transition\b[^>]*\/>|<p:transition\b[\s\S]*?<\/p:transition>/g, "");

  return { xml, removed: [...new Set(removed)] };
}

// Modern PowerPoint stores vector images as an asvg:svgBlip extension; when
// the blip has no raster r:embed fallback, pptx-preview fails on the whole
// slide. Point the blip at the SVG relationship directly (the caller swaps
// the media for a PNG) and drop the extension the parser cannot handle.
export function rewriteSvgBlips(slideXml) {
  const svgRelIds = new Set();

  const xml = slideXml.replace(
    /<a:blip(\s[^>]*)?>([\s\S]*?)<\/a:blip>/g,
    (match, attrs = "", inner) => {
      const svgRelId = inner.match(/<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/)?.[1];
      if (!svgRelId) return match;

      const cleanedInner = inner.replace(/<a:ext\b[^>]*>[\s\S]*?<\/a:ext>/g, (ext) =>
        ext.includes("svgBlip") ? "" : ext,
      );

      if (/\br:embed=/.test(attrs)) {
        return `<a:blip${attrs}>${cleanedInner}</a:blip>`;
      }

      svgRelIds.add(svgRelId);
      return `<a:blip${attrs} r:embed="${svgRelId}">${cleanedInner}</a:blip>`;
    },
  );

  return { xml, svgRelIds: [...svgRelIds] };
}

// Relationship target for one rel id, attribute order independent.
export function findRelationshipTarget(relsXml, relId) {
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    if (match[0].match(/\bId="([^"]+)"/)?.[1] !== relId) continue;
    return match[0].match(/\bTarget="([^"]+)"/)?.[1] ?? null;
  }
  return null;
}

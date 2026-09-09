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

export function isSlideHidden(slideXml) {
  const tag = slideXml.match(/<p:sld\b[^>]*>/)?.[0] ?? "";
  return /\sshow\s*=\s*(["'])(?:0|false)\1/.test(tag);
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
  return contentTypesForSlides(contentTypesXml, [slidePartName]);
}

export function contentTypesForSlides(contentTypesXml, slidePartNames) {
  const included = new Set(slidePartNames.map((name) => `/${name}`));
  return contentTypesXml.replace(/<Override\b[^>]*\/>/g, (override) => {
    if (!override.includes(SLIDE_CONTENT_TYPE)) return override;
    return included.has(override.match(/\bPartName="([^"]+)"/)?.[1]) ? override : "";
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

// Resolve compatibility branches and report content the renderer cannot
// handle. The caller must surface these substitutions and omissions.
export function sanitizeSlideXml(slideXml) {
  const removed = [];
  let usedFallback = false;
  let xml = slideXml;

  // Resolve innermost blocks first so nested fallbacks cannot truncate XML.
  const alternateBlock = /<mc:AlternateContent\b(?:(?!<mc:AlternateContent\b)[\s\S])*?<\/mc:AlternateContent>/g;
  while (alternateBlock.test(xml)) {
    alternateBlock.lastIndex = 0;
    xml = xml.replace(alternateBlock, (block) => {
      const fallback = block.match(/<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/)?.[1];
      if (fallback != null) {
        usedFallback = true;
        return fallback;
      }
      removed.push("unsupported drawing");
      return "";
    });
  }

  xml = xml.replace(GRAPHIC_FRAME, (frame) => {
    const uri = frame.match(/<a:graphicData\b[^>]*\buri="([^"]*)"/)?.[1] ?? "";
    const unsupported = UNSUPPORTED_GRAPHIC_URIS.find(({ match }) => uri.includes(match));
    if (!unsupported) return frame;
    removed.push(unsupported.label);
    return "";
  });

  xml = xml.replace(/<p:timing>[\s\S]*?<\/p:timing>/g, "");
  xml = xml.replace(/<p:transition\b[^>]*\/>|<p:transition\b[\s\S]*?<\/p:transition>/g, "");

  return { xml, removed: [...new Set(removed)], usedFallback };
}

// Run before rendering, since a full page count does not prove that the
// preview library rendered every equation or drawing on those pages.
export function prepareSlideForRendering(slideXml, slideNumber) {
  const { xml, removed, usedFallback } = sanitizeSlideXml(slideXml);
  const warnings = [];
  if (usedFallback) {
    warnings.push(`Slide ${slideNumber} uses PowerPoint's compatibility drawings; check their appearance.`);
  }
  if (removed.length) {
    warnings.push(`Slide ${slideNumber} omits unsupported content (${removed.join(", ")}).`);
  }
  const risks = describeSlideContent(xml).filter((label) =>
    ["equation", "SmartArt diagram", "embedded object", "audio/video", "chart", "modern drawing features"].includes(label),
  );
  if (risks.length) {
    warnings.push(`Slide ${slideNumber} contains ${risks.join(", ")} that may be missing or rendered differently.`);
  }
  return { xml, warnings };
}

// Modern PowerPoint stores vector images as an asvg:svgBlip extension; when
// the blip has no raster r:embed fallback, pptx-preview fails on the whole
// slide. Point the blip at the SVG relationship directly (the caller swaps
// the media for a PNG) and drop the extension the parser cannot handle.
export function rewriteSvgBlips(slideXml) {
  const svgRelIds = new Set();

  // Self-closing raster blips must not consume a later SVG blip's closing
  // tag. Likewise, a:ext is also used for self-closing shape dimensions.
  const xml = slideXml.replace(
    /<a:blip\b(?![^>]*\/>)(\s[^>]*)?>([\s\S]*?)<\/a:blip>/g,
    (match, attrs = "", inner) => {
      const svgRelId = inner.match(/<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/)?.[1];
      if (!svgRelId) return match;

      const cleanedInner = inner.replace(/<a:ext\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/a:ext>/g, (ext) =>
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

import { convertPptxToPdf } from "./pptx.js";
import { convertDocxToPdf } from "./docx.js";

export async function convertOfficeToPdf(arrayBuffer, kind, onProgress = () => {}) {
  if (kind === "pptx") return convertPptxToPdf(arrayBuffer, onProgress);
  if (kind === "docx") return convertDocxToPdf(arrayBuffer, onProgress);
  throw new Error(`Unsupported file type: ${kind}`);
}

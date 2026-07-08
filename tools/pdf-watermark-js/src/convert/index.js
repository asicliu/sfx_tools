import { convertPptxToPdf } from "./pptx.js";
import { convertDocxToPdf } from "./docx.js";

export async function convertOfficeToPdf(arrayBuffer, kind) {
  if (kind === "pptx") return convertPptxToPdf(arrayBuffer);
  if (kind === "docx") return convertDocxToPdf(arrayBuffer);
  throw new Error(`Unsupported file type: ${kind}`);
}

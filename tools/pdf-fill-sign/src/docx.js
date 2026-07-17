const LAYOUT_CONVERTER_MESSAGE =
  "Layout-preserving DOCX conversion requires the local app on macOS with Microsoft Word installed.";

export async function convertDocxToPdf(arrayBuffer, onProgress = () => {}) {
  onProgress("Converting with Microsoft Word to preserve page layout…");

  let response;
  try {
    response = await fetch("/api/convert-docx", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "X-SFX-Local-Converter": "1",
      },
      body: arrayBuffer,
    });
  } catch {
    throw new Error(LAYOUT_CONVERTER_MESSAGE);
  }

  const contentType = response.headers.get("content-type") || "";
  if (response.ok && contentType.includes("application/pdf")) {
    return {
      pdfBytes: new Uint8Array(await response.arrayBuffer()),
      conversionMode: "microsoft-word",
    };
  }

  const message = (await response.text()).trim();
  if (response.status === 404 || response.status === 405 || response.ok) {
    throw new Error(LAYOUT_CONVERTER_MESSAGE);
  }

  throw new Error(message || "Microsoft Word could not convert this document.");
}

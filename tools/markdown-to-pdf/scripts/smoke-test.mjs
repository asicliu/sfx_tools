import { createMarkdownPdf } from "../src/pdf.js";

const doc = createMarkdownPdf(
  `# Smoke Test

This PDF was generated from Markdown.

- Alpha
- Beta

| Column | Value |
| --- | --- |
| Status | Ready |
`,
  {
    pageSize: "letter",
    bodySize: 11,
    marginInches: 0.75,
  },
);

const bytes = doc.output("arraybuffer");

if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 1000) {
  throw new Error("Markdown PDF smoke test failed.");
}

console.log(`Smoke test passed: ${bytes.byteLength} bytes`);

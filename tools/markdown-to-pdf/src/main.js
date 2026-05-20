import DOMPurify from "dompurify";
import { marked } from "marked";
import { downloadMarkdownPdf } from "./pdf.js";
import "./styles.css";

marked.use({
  gfm: true,
  breaks: false,
});

const sampleMarkdown = `# Quarterly Launch Notes

This document shows the Markdown to PDF converter.

## Highlights

- Client-side conversion
- GitHub-flavored Markdown preview
- Page size, font size, and margin controls

> Files stay in the browser. Nothing is uploaded.

### Checklist

1. Paste or drop a Markdown file.
2. Review the preview.
3. Export the PDF.

\`\`\`js
const status = "ready";
console.log(status);
\`\`\`

| Area | Owner | Status |
| --- | --- | --- |
| Copy | Alex | Done |
| Design | Mei | Ready |
| Build | Sam | In progress |
`;

const controls = {
  form: document.querySelector("#pdf-form"),
  fileInput: document.querySelector("#markdown-file"),
  dropZone: document.querySelector("#drop-zone"),
  dropLabel: document.querySelector("#drop-label"),
  fileSummary: document.querySelector("#file-summary"),
  filename: document.querySelector("#filename"),
  pageSize: document.querySelector("#page-size"),
  bodySize: document.querySelector("#body-size"),
  marginSize: document.querySelector("#margin-size"),
  markdownInput: document.querySelector("#markdown-input"),
  preview: document.querySelector("#preview"),
  status: document.querySelector("#status-line"),
  exportButton: document.querySelector("#export-button"),
};

function setStatus(message, tone = "neutral") {
  controls.status.textContent = message;
  controls.status.dataset.tone = tone;
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function filenameFromMarkdown(name) {
  return name.replace(/\.(md|markdown|txt)$/i, "") || "document";
}

function normalizePdfFilename(value) {
  const trimmed = (value || "document.pdf").trim();
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
}

function renderPreview() {
  const rawHtml = marked.parse(controls.markdownInput.value);
  controls.preview.innerHTML = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
  });
}

async function loadFile(file) {
  const isMarkdown =
    /\.(md|markdown|txt)$/i.test(file.name) ||
    ["text/markdown", "text/plain"].includes(file.type);

  if (!isMarkdown) {
    setStatus("Select a Markdown or text file.", "error");
    return;
  }

  const text = await file.text();
  controls.markdownInput.value = text;
  controls.fileSummary.textContent = file.name;
  controls.dropLabel.textContent = formatBytes(file.size);
  controls.dropZone.classList.add("has-file");
  controls.filename.value = `${filenameFromMarkdown(file.name)}.pdf`;
  setStatus("");
  renderPreview();
}

function getPdfOptions() {
  return {
    filename: normalizePdfFilename(controls.filename.value),
    pageSize: controls.pageSize.value,
    bodySize: Number(controls.bodySize.value),
    marginInches: Number(controls.marginSize.value),
  };
}

function handleExport(event) {
  event.preventDefault();

  const markdown = controls.markdownInput.value.trim();
  if (!markdown) {
    setStatus("Add Markdown before exporting.", "error");
    return;
  }

  controls.exportButton.disabled = true;
  controls.exportButton.textContent = "Exporting...";
  setStatus("Generating PDF...", "neutral");

  try {
    downloadMarkdownPdf(controls.markdownInput.value, getPdfOptions());
    setStatus("PDF exported.", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not export PDF.";
    setStatus(message, "error");
  } finally {
    controls.exportButton.disabled = false;
    controls.exportButton.textContent = "Export PDF";
  }
}

function initialize() {
  controls.markdownInput.value = sampleMarkdown;
  renderPreview();

  controls.fileInput.addEventListener("change", () => {
    const [file] = controls.fileInput.files;
    if (file) void loadFile(file);
  });

  controls.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    controls.dropZone.classList.add("is-over");
  });

  controls.dropZone.addEventListener("dragleave", () => {
    controls.dropZone.classList.remove("is-over");
  });

  controls.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    controls.dropZone.classList.remove("is-over");
    const [file] = event.dataTransfer.files;
    if (file) void loadFile(file);
  });

  controls.markdownInput.addEventListener("input", renderPreview);
  controls.form.addEventListener("submit", handleExport);
}

initialize();

import React from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { createExportHtml, evaluateJsx, normalizeHtmlFilename } from "./transform.js";
import "./styles.css";

document.querySelector("#app-version").textContent = `v${__APP_VERSION__}`;
document.documentElement.dataset.appVersion = __APP_VERSION__;
globalThis.__SFX_JSX_RENDERER_VERSION__ = __APP_VERSION__;

const sampleJsx = `import { useState } from "react";

export default function DemoCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <main style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: 620, margin: "0 auto", padding: 32 }}>
      <p style={{ margin: 0, color: "#64748b", fontSize: 13, textTransform: "uppercase", letterSpacing: 1.4 }}>Preview</p>
      <h1 style={{ margin: "8px 0 12px", fontSize: 34, letterSpacing: -0.8 }}>Rendered JSX</h1>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>Upload or paste a JSX file that exports a default React component.</p>
      <button onClick={() => setExpanded(!expanded)} style={{ border: 0, borderRadius: 8, padding: "10px 14px", color: "#fff", background: "#2563eb", fontWeight: 700 }}>
        {expanded ? "Hide details" : "Show details"}
      </button>
      {expanded && (
        <div style={{ marginTop: 18, padding: 18, border: "1px solid #dbe3ef", borderRadius: 10, background: "#f8fafc" }}>
          This interaction is running from the rendered component.
        </div>
      )}
    </main>
  );
}`;

const controls = {
  form: document.querySelector("#render-form"),
  fileInput: document.querySelector("#jsx-file"),
  dropZone: document.querySelector("#drop-zone"),
  dropLabel: document.querySelector("#drop-label"),
  fileSummary: document.querySelector("#file-summary"),
  title: document.querySelector("#html-title"),
  filename: document.querySelector("#html-filename"),
  input: document.querySelector("#jsx-input"),
  status: document.querySelector("#status-line"),
  frame: document.querySelector("#preview-frame"),
  exportButton: document.querySelector("#export-button"),
};

const modules = {
  react: React,
  reactDom: ReactDOM,
  reactDomClient: { createRoot },
};

let currentRoot = null;

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

function htmlNameFromSourceFile(name) {
  return `${name.replace(/\.(jsx|tsx|js|ts)$/i, "") || "rendered-jsx"}.html`;
}

function prepareFrame() {
  const frameDoc = controls.frame.contentDocument;

  if (currentRoot) {
    currentRoot.unmount();
    currentRoot = null;
  }

  frameDoc.open();
  frameDoc.write(`<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body { margin: 0; min-height: 100%; background: #fff; }
      #root { min-height: 100vh; }
    </style>
  </head>
  <body><div id="root"></div></body>
</html>`);
  frameDoc.close();

  return frameDoc.getElementById("root");
}

function renderJsx() {
  try {
    const source = controls.input.value.trim();
    if (!source) {
      setStatus("Add JSX before rendering.", "error");
      return;
    }

    const component = evaluateJsx(source, modules);
    const target = prepareFrame();
    currentRoot = createRoot(target);
    currentRoot.render(React.isValidElement(component) ? component : React.createElement(component));
    setStatus("Rendered.", "success");
  } catch (error) {
    const target = prepareFrame();
    const message = error instanceof Error ? error.stack || error.message : String(error);
    target.innerHTML = `<pre class="render-error"></pre>`;
    target.querySelector(".render-error").textContent = message;
    setStatus(error instanceof Error ? error.message : "Could not render JSX.", "error");
  }
}

function downloadHtml() {
  const source = controls.input.value.trim();
  if (!source) {
    setStatus("Add JSX before exporting.", "error");
    return;
  }

  try {
    evaluateJsx(source, modules);
    const html = createExportHtml(source, { title: controls.title.value });
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = normalizeHtmlFilename(controls.filename.value);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("HTML exported.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not export HTML.", "error");
  }
}

async function loadFile(file) {
  const isJsx = /\.(jsx|tsx|js|ts)$/i.test(file.name) || /javascript|typescript|plain/.test(file.type);
  if (!isJsx) {
    setStatus("Select a JSX, TSX, JS, or TS file.", "error");
    return;
  }

  controls.input.value = await file.text();
  controls.fileSummary.textContent = file.name;
  controls.dropLabel.textContent = formatBytes(file.size);
  controls.dropZone.classList.add("has-file");
  controls.title.value = file.name.replace(/\.(jsx|tsx|js|ts)$/i, "") || "Rendered JSX";
  controls.filename.value = htmlNameFromSourceFile(file.name);
  renderJsx();
}

function initialize() {
  controls.input.value = sampleJsx;

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

  controls.form.addEventListener("submit", (event) => {
    event.preventDefault();
    renderJsx();
  });

  controls.exportButton.addEventListener("click", downloadHtml);
  renderJsx();
}

initialize();

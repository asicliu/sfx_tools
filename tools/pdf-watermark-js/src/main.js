import { applyWatermark } from "./watermark.js";
import { encryptPdfPermissions, generatePermissionPassword } from "./encryption.js";
import "./styles.css";
import { createScreenshotCode, screenshotTiles } from "./screenshot-watermark.js";

document.querySelector("#app-version").textContent = `v${__APP_VERSION__}`;
document.documentElement.dataset.appVersion = __APP_VERSION__;
globalThis.__SFX_PDF_WATERMARK_JS_VERSION__ = __APP_VERSION__;

const controls = {
  form: document.querySelector("#watermark-form"),
  dropZone: document.querySelector("#drop-zone"),
  fileInput: document.querySelector("#pdf-file"),
  dropLabel: document.querySelector("#drop-label"),
  fileSummary: document.querySelector("#file-summary"),
  text: document.querySelector("#watermark-text"),
  visible: document.querySelector("#visible-watermark"),
  visiblePanel: document.querySelector("#visible-controls"),
  invisible: document.querySelector("#invisible-watermark"),
  invisibleSameText: document.querySelector("#invisible-same-text"),
  invisibleText: document.querySelector("#invisible-text"),
  screenshot: document.querySelector("#screenshot-watermark"),
  screenshotStrength: document.querySelector("#screenshot-strength"),
  fontSize: document.querySelector("#font-size"),
  opacity: document.querySelector("#opacity"),
  rotation: document.querySelector("#rotation"),
  color: document.querySelector("#watermark-color"),
  colorValue: document.querySelector("#color-value"),
  repeat: document.querySelector("#repeat-watermark"),
  spacingPanel: document.querySelector("#spacing-controls"),
  spacingX: document.querySelector("#spacing-x"),
  spacingY: document.querySelector("#spacing-y"),
  protectPermissions: document.querySelector("#protect-permissions"),
  permissionPassword: document.querySelector("#permission-password"),
  generatePassword: document.querySelector("#generate-password"),
  allowPrint: document.querySelector("#allow-print"),
  allowCopy: document.querySelector("#allow-copy"),
  allowAnnotate: document.querySelector("#allow-annotate"),
  status: document.querySelector("#status-line"),
  button: document.querySelector("#download-button"),
  canvas: document.querySelector("#preview-canvas"),
};

const state = {
  file: null,
};

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function getOptions() {
  const color = controls.color.value || "#333333";
  const hiddenText = controls.invisibleSameText.checked
    ? controls.text.value.trim() || "CONFIDENTIAL" : controls.invisibleText.value.trim();
  return {
    screenshotText: controls.screenshot.checked
      ? (controls.invisible.checked ? hiddenText : controls.text.value.trim() || "CONFIDENTIAL") : "",
    screenshotStrength: clamp(controls.screenshotStrength.value, 0.06, 0.25, 0.12),
    visible: controls.visible.checked,
    invisibleText: controls.invisible.checked
      ? (controls.invisibleSameText.checked
        ? controls.text.value.trim() || "CONFIDENTIAL"
        : controls.invisibleText.value.trim())
      : "",
    text: controls.text.value.trim() || "CONFIDENTIAL",
    fontSize: clamp(controls.fontSize.value, 6, 200, 36),
    opacity: clamp(controls.opacity.value, 0, 1, 0.1),
    rotation: clamp(controls.rotation.value, -180, 180, 45),
    colorHex: color,
    colorR: Number.parseInt(color.slice(1, 3), 16) / 255,
    colorG: Number.parseInt(color.slice(3, 5), 16) / 255,
    colorB: Number.parseInt(color.slice(5, 7), 16) / 255,
    repeat: controls.repeat.checked,
    spacingX: clamp(controls.spacingX.value, 10, 2000, 250),
    spacingY: clamp(controls.spacingY.value, 10, 2000, 200),
    protectPermissions: controls.protectPermissions.checked,
    permissionPassword: controls.permissionPassword.value.trim(),
    allowPrint: controls.allowPrint.checked,
    allowCopy: controls.allowCopy.checked,
    allowAnnotate: controls.allowAnnotate.checked,
  };
}

function fileKind(file) {
  if (!file) return null;
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".pptx")) return "pptx";
  if (name.endsWith(".docx")) return "docx";
  return null;
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function setStatus(message, tone = "neutral") {
  controls.status.textContent = message;
  controls.status.dataset.tone = tone;
}

function setBusy(isBusy) {
  controls.button.disabled = isBusy;
  controls.button.textContent = isBusy ? "Processing..." : "Download PDF";
}

function setFile(file) {
  const kind = fileKind(file);
  if (!kind) {
    setStatus("Select a PDF, PowerPoint (.pptx), or Word (.docx) file.", "error");
    return;
  }

  state.file = file;
  controls.dropZone.classList.add("has-file");
  controls.dropLabel.textContent = formatBytes(file.size);
  controls.fileSummary.textContent =
    kind === "pdf" ? file.name : `${file.name} (will convert to PDF)`;
  setStatus("");
}

function downloadPdf(bytes, sourceName) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = sourceName.replace(/\.(pdf|pptx|docx)$/i, "");

  link.href = url;
  link.download = `${baseName}_wm.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updatePreview() {
  const canvas = controls.canvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const options = getOptions();
  const scaleX = width / 612;
  const scaleY = height / 792;
  const previewFontSize = Math.max(8, options.fontSize * scaleX);
  const rotation = -(options.rotation * Math.PI) / 180;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d7dbe2";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  if (options.screenshotText) {
    try {
      const modules = createScreenshotCode(options.screenshotText);
      ctx.fillStyle = "#000000";
      ctx.globalAlpha = options.screenshotStrength;
      for (const tile of screenshotTiles(612, 792, modules)) {
        const cell = tile.size / (modules.size + 8);
        for (let row = 0; row < modules.size; row++) for (let col = 0; col < modules.size; col++) {
          if (modules.get(row, col)) ctx.fillRect((tile.x + (col + 4) * cell) * scaleX,
            (tile.y + (row + 4) * cell) * scaleY, cell * scaleX, cell * scaleY);
        }
      }
    } catch { /* Submit reports invalid/oversized text. */ }
    ctx.globalAlpha = 1;
  }
  if (!options.visible) return;

  ctx.font = `700 ${previewFontSize}px Helvetica, Arial, sans-serif`;
  ctx.fillStyle = controls.color.value;
  ctx.globalAlpha = options.opacity;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (options.repeat) {
    for (let x = -width; x < width * 2; x += options.spacingX * scaleX) {
      for (let y = -height; y < height * 2; y += options.spacingY * scaleY) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rotation);
        ctx.fillText(options.text, 0, 0);
        ctx.restore();
      }
    }
  } else {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(rotation);
    ctx.fillText(options.text, 0, 0);
    ctx.restore();
  }

  ctx.globalAlpha = 1;
}

async function handleSubmit(event) {
  event.preventDefault();

  if (!state.file) {
    setStatus("Select a PDF, PowerPoint (.pptx), or Word (.docx) file.", "error");
    return;
  }

  const options = getOptions();
  if (controls.invisible.checked && !options.invisibleText) {
    setStatus("Enter hidden text or a recipient ID for the invisible watermark.", "error");
    controls.invisibleText.focus();
    return;
  }
  if (!options.visible && !options.invisibleText && !options.screenshotText) {
    setStatus("Enable a visible, invisible, or screenshot-resistant watermark.", "error");
    return;
  }

  setBusy(true);
  setStatus("Processing PDF...", "neutral");

  try {
    if (controls.screenshot.checked) createScreenshotCode(options.screenshotText);
    let inputBytes = await state.file.arrayBuffer();
    const kind = fileKind(state.file);
    let conversionWarnings = [];

    if (kind === "pptx" || kind === "docx") {
      setStatus(
        kind === "pptx" ? "Converting PowerPoint to PDF..." : "Converting Word to PDF...",
        "neutral",
      );
      const { convertOfficeToPdf } = await import("./convert/index.js");
      const unitLabel = kind === "pptx" ? "slide" : "page";
      const conversion = await convertOfficeToPdf(inputBytes, kind, (current, total) => {
        setStatus(`Converting ${unitLabel} ${current} of ${total}...`, "neutral");
      });
      inputBytes = conversion.bytes;
      conversionWarnings = conversion.warnings;
      setStatus("Processing PDF...", "neutral");
    }

    let outputBytes = await applyWatermark(inputBytes, options);

    if (options.protectPermissions) {
      if (!options.permissionPassword) {
        options.permissionPassword = generatePermissionPassword();
        controls.permissionPassword.value = options.permissionPassword;
      }

      outputBytes = encryptPdfPermissions(outputBytes, {
        ownerPassword: options.permissionPassword,
        allowPrint: options.allowPrint,
        allowCopy: options.allowCopy,
        allowAnnotate: options.allowAnnotate,
      });
    }

    downloadPdf(outputBytes, state.file.name);
    const baseMessage = options.protectPermissions
      ? "Watermarked PDF downloaded with protected permissions."
      : "Watermarked PDF downloaded.";
    setStatus([baseMessage, ...conversionWarnings].join(" "), conversionWarnings.length ? "warning" : "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process PDF.";
    setStatus(message, "error");
  } finally {
    setBusy(false);
  }
}

function initialize() {
  controls.permissionPassword.value = generatePermissionPassword();

  controls.fileInput.addEventListener("change", () => {
    const [file] = controls.fileInput.files;
    if (file) setFile(file);
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
    if (file) setFile(file);
  });

  controls.form.addEventListener("submit", handleSubmit);
  controls.generatePassword.addEventListener("click", () => {
    controls.permissionPassword.value = generatePermissionPassword();
  });

  const syncPreviewControls = () => {
    controls.screenshotStrength.disabled = !controls.screenshot.checked;
    controls.visiblePanel.disabled = !controls.visible.checked;
    controls.invisibleSameText.disabled = !controls.invisible.checked;
    if (controls.invisibleSameText.checked) {
      controls.invisibleText.value = controls.text.value.trim() || "CONFIDENTIAL";
    }
    controls.invisibleText.disabled = !controls.invisible.checked || controls.invisibleSameText.checked;
    controls.invisibleText.required = controls.invisible.checked && !controls.invisibleSameText.checked;
    const repeat = controls.repeat.checked;
    const protectPermissions = controls.protectPermissions.checked;
    controls.colorValue.textContent = controls.color.value;
    controls.spacingPanel.classList.toggle("is-disabled", !repeat);
    controls.spacingX.disabled = !repeat;
    controls.spacingY.disabled = !repeat;
    controls.permissionPassword.disabled = !protectPermissions;
    controls.generatePassword.disabled = !protectPermissions;
    controls.allowPrint.disabled = !protectPermissions;
    controls.allowCopy.disabled = !protectPermissions;
    controls.allowAnnotate.disabled = !protectPermissions;
    updatePreview();
  };

  [
    controls.screenshot,
    controls.screenshotStrength,
    controls.visible,
    controls.invisible,
    controls.invisibleSameText,
    controls.invisibleText,
    controls.text,
    controls.fontSize,
    controls.opacity,
    controls.rotation,
    controls.color,
    controls.repeat,
    controls.spacingX,
    controls.spacingY,
    controls.protectPermissions,
    controls.permissionPassword,
    controls.allowPrint,
    controls.allowCopy,
    controls.allowAnnotate,
  ].forEach((control) => {
    control.addEventListener("input", syncPreviewControls);
  });

  syncPreviewControls();
}

initialize();

const readButton = document.querySelector('#read-screenshot');
const readerStatus = document.querySelector('#reader-status');
readButton.addEventListener('click', async () => {
  const file = document.querySelector('#screenshot-file').files[0];
  if (!file) { readerStatus.textContent = 'Choose a PNG or JPEG screenshot first.'; return; }
  if (file.size > 25 * 1024 * 1024) { readerStatus.textContent = 'Choose an image smaller than 25 MB.'; return; }
  readButton.disabled = true;
  readerStatus.textContent = 'Inspecting screenshot…';
  let worker;
  let timeout;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Image is too large. Crop to the page first.');
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    worker = new Worker(new URL('./screenshot-reader.worker.js', import.meta.url), { type: 'module' });
    const result = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Scan timed out. Crop to one complete pattern and try again.')), 30000);
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.texts);
      worker.onerror = () => reject(new Error('Could not start the screenshot reader.'));
      worker.postMessage({ data: image.data, width: image.width, height: image.height }, [image.data.buffer]);
    });
    readerStatus.textContent = result.length
      ? `Recovered watermark: ${result[0]}`
      : 'No readable watermark found. Try a larger screenshot or crop around one complete pattern. This does not prove a watermark is absent.';
  } catch (error) {
    readerStatus.textContent = error.message || 'Could not read this image.';
  } finally {
    clearTimeout(timeout);
    worker?.terminate();
    bitmap?.close();
    readButton.disabled = false;
  }
});

import { applyWatermark } from "./watermark.js";
import { encryptPdfPermissions, generatePermissionPassword } from "./encryption.js";
import "./styles.css";

const controls = {
  form: document.querySelector("#watermark-form"),
  dropZone: document.querySelector("#drop-zone"),
  fileInput: document.querySelector("#pdf-file"),
  dropLabel: document.querySelector("#drop-label"),
  fileSummary: document.querySelector("#file-summary"),
  text: document.querySelector("#watermark-text"),
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
  return {
    text: controls.text.value.trim() || "CONFIDENTIAL",
    fontSize: clamp(controls.fontSize.value, 6, 200, 36),
    opacity: clamp(controls.opacity.value, 0, 1, 0.2),
    rotation: clamp(controls.rotation.value, -180, 180, 45),
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

function isPdf(file) {
  return file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
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
  if (!isPdf(file)) {
    setStatus("Select a PDF file.", "error");
    return;
  }

  state.file = file;
  controls.dropZone.classList.add("has-file");
  controls.dropLabel.textContent = formatBytes(file.size);
  controls.fileSummary.textContent = file.name;
  setStatus("");
}

function downloadPdf(bytes, sourceName) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = sourceName.replace(/\.pdf$/i, "");

  link.href = url;
  link.download = `${baseName}_watermarked.pdf`;
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
    setStatus("Select a PDF file.", "error");
    return;
  }

  setBusy(true);
  setStatus("Processing PDF...", "neutral");

  try {
    const inputBytes = await state.file.arrayBuffer();
    const options = getOptions();
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
    setStatus(
      options.protectPermissions
        ? "Watermarked PDF downloaded with protected permissions."
        : "Watermarked PDF downloaded.",
      "success",
    );
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

import { convertDocxToPdf } from "./docx.js";
import { detectBlankRegions, MAX_AUTO_REGIONS } from "./detect-blanks.js";
import {
  downloadPdf,
  formatBytes,
  isDocxFile,
  isPdfFile,
  openPdfForPreview,
  renderPdfPage,
  signedFilename,
} from "./pdf.js";
import { applyAnnotations } from "./pdf-export.js";
import "./styles.css";

const DEFAULT_TEXT_SIZE = 10;
const TEXTBOX_BOUNDARY_MARGIN_PX = 32;
const MIN_TEXTBOX_SIZE_PX = 8;
const PASTE_OFFSET = 0.018;
const MAX_SIGNATURE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SIGNATURE_IMAGE_EDGE = 1600;

const controls = {
  appHeader: document.querySelector(".app-header"),
  appVersion: document.querySelector("#app-version"),
  fileInput: document.querySelector("#document-file"),
  dropZone: document.querySelector("#drop-zone"),
  replaceButton: document.querySelector("#replace-button"),
  fileCard: document.querySelector("#file-card"),
  fileType: document.querySelector("#file-type"),
  fileName: document.querySelector("#file-name"),
  fileMeta: document.querySelector("#file-meta"),
  fontSize: document.querySelector("#font-size"),
  undoButton: document.querySelector("#undo-button"),
  redoButton: document.querySelector("#redo-button"),
  removeButton: document.querySelector("#remove-button"),
  doneButton: document.querySelector("#done-button"),
  exportButton: document.querySelector("#export-button"),
  status: document.querySelector("#status-line"),
  addTextBoxButton: document.querySelector("#add-text-box-button"),
  detectBlanksButton: document.querySelector("#detect-blanks-button"),
  drawOnPageButton: document.querySelector("#draw-on-page-button"),
  drawOnPageLabel: document.querySelector("#draw-on-page-label"),
  uploadSignatureButton: document.querySelector("#upload-signature-button"),
  signatureFile: document.querySelector("#signature-file"),
  placementMessage: document.querySelector("#placement-message"),
  placementMessageText: document.querySelector("#placement-message-text"),
  previewToolbar: document.querySelector("#preview-toolbar"),
  pageControls: document.querySelector("#page-controls"),
  previousPage: document.querySelector("#previous-page"),
  nextPage: document.querySelector("#next-page"),
  pageNumber: document.querySelector("#page-number"),
  pageCount: document.querySelector("#page-count"),
  zoom: document.querySelector("#zoom-select"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  loadingTitle: document.querySelector("#loading-title"),
  loadingNote: document.querySelector("#loading-note"),
  previewViewport: document.querySelector("#preview-viewport"),
  pageWrap: document.querySelector("#page-wrap"),
};

controls.appVersion.textContent = `v${__APP_VERSION__}`;
document.documentElement.dataset.appVersion = __APP_VERSION__;
globalThis.__SFX_PDF_FILL_SIGN_VERSION__ = __APP_VERSION__;

function syncStickyHeaderHeight() {
  const height = Math.ceil(controls.appHeader.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--app-header-height", `${height}px`);
}

const state = {
  sourceFile: null,
  pdfBytes: null,
  pdf: null,
  currentPage: 1,
  pageCount: 0,
  zoom: 1,
  annotations: [],
  undoStack: [],
  redoStack: [],
  pendingPlacement: null,
  selectedId: null,
  drag: null,
  resize: null,
  inkMode: false,
  inkStroke: null,
  focusTextBoxId: null,
  editingTextId: null,
  busy: false,
  exportBusy: false,
  pageViews: new Map(),
  buildingViews: false,
  scrollFrame: null,
  annotationClipboard: null,
  pasteCount: 0,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `annotation-${Date.now()}-${Math.random()}`;
}

function setStatus(message, tone = "neutral") {
  controls.status.textContent = message;
  controls.status.dataset.tone = tone;
}

function setPlacementMessage(message, active = false) {
  controls.placementMessageText.textContent = message;
  controls.placementMessage.classList.toggle("is-active", active);
}

function setLoading(title, note = "This may take a moment.") {
  controls.loadingTitle.textContent = title;
  controls.loadingNote.textContent = note;
}

function updateActionState() {
  const hasDocument = Boolean(state.pdf && !state.busy);
  controls.addTextBoxButton.disabled = !hasDocument;
  controls.detectBlanksButton.disabled = !hasDocument;
  controls.drawOnPageButton.disabled = !hasDocument;
  controls.uploadSignatureButton.disabled = !hasDocument;
  controls.fontSize.disabled = !hasDocument;
  controls.addTextBoxButton.classList.toggle(
    "is-active",
    state.pendingPlacement?.type === "textbox",
  );
  controls.drawOnPageButton.classList.toggle("is-active", state.inkMode);
  controls.drawOnPageLabel.textContent = state.inkMode ? "Done drawing" : "Draw signature";
  controls.undoButton.disabled = state.undoStack.length === 0 || state.busy;
  controls.redoButton.disabled = state.redoStack.length === 0 || state.busy;
  controls.removeButton.disabled = !state.selectedId || state.busy;
  controls.doneButton.disabled = !hasDocument;
  controls.exportButton.disabled = !hasDocument || state.exportBusy;
  controls.exportButton.textContent = state.exportBusy ? "Preparing PDF…" : "Download signed PDF";

  for (const view of state.pageViews.values()) {
    view.stage.classList.toggle("is-drawing-signature", state.inkMode);
  }

  if (state.inkMode) {
    setPlacementMessage("Draw directly on the page. Use Undo last to retry, then choose Done drawing.", true);
  } else if (state.pendingPlacement) {
    const label = state.pendingPlacement.type === "signature" ? "signature" : state.pendingPlacement.label.toLowerCase();
    setPlacementMessage(`Click the page to place ${label}. Press Esc to cancel.`, true);
  } else if (state.pdf) {
    setPlacementMessage("Add a text box, draw, or upload a signature.");
  } else if (!state.busy) {
    setPlacementMessage("Choose a document to begin");
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  controls.fileInput.disabled = isBusy;
  controls.signatureFile.disabled = isBusy;
  controls.replaceButton.disabled = isBusy;
  controls.emptyState.hidden = isBusy || Boolean(state.pdf);
  controls.loadingState.hidden = !isBusy;
  if (isBusy) controls.pageWrap.hidden = true;
  updateActionState();
}

function resetDocumentState() {
  state.pdf?.destroy?.();
  state.sourceFile = null;
  state.pdfBytes = null;
  state.pdf = null;
  state.currentPage = 1;
  state.pageCount = 0;
  state.annotations = [];
  state.undoStack = [];
  state.redoStack = [];
  state.pendingPlacement = null;
  state.selectedId = null;
  state.drag = null;
  state.resize = null;
  state.inkMode = false;
  state.inkStroke = null;
  state.focusTextBoxId = null;
  state.editingTextId = null;
  state.annotationClipboard = null;
  state.pasteCount = 0;
  state.pageViews.clear();
  state.buildingViews = false;
  controls.pageWrap.replaceChildren();
  controls.previewToolbar.hidden = true;
  controls.pageControls.hidden = true;
  controls.pageWrap.hidden = true;
}

function showLoadedFile(file, converted) {
  controls.dropZone.hidden = true;
  controls.fileCard.hidden = false;
  controls.replaceButton.hidden = false;
  controls.fileType.textContent = converted ? "DOCX" : "PDF";
  controls.fileType.dataset.type = converted ? "docx" : "pdf";
  controls.fileName.textContent = file.name;
  controls.fileMeta.textContent = `${formatBytes(file.size)} · ${state.pageCount} page${state.pageCount === 1 ? "" : "s"}${converted ? " · converted locally" : ""}`;
}

function hideLoadedFile() {
  controls.dropZone.hidden = false;
  controls.fileCard.hidden = true;
  controls.replaceButton.hidden = true;
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : "Could not open this document.";
  if (/password|encrypted/i.test(message)) {
    return "Password-protected PDFs are not supported. Unlock the PDF, then try again.";
  }
  if (/invalid|format|pdf/i.test(message) && state.sourceFile && isPdfFile(state.sourceFile)) {
    return "This PDF could not be read. Try opening and re-saving it, then upload it again.";
  }
  return message;
}

async function loadDocument(file) {
  if (!isPdfFile(file) && !isDocxFile(file)) {
    setStatus("Choose a PDF or DOCX file.", "error");
    return;
  }

  resetDocumentState();
  hideLoadedFile();
  state.sourceFile = file;
  state.pendingPlacement = null;
  setStatus("");
  setLoading(isDocxFile(file) ? "Converting Word document…" : "Opening PDF…");
  setBusy(true);

  try {
    const fileBytes = await file.arrayBuffer();
    const converted = isDocxFile(file);
    const conversion = converted
      ? await convertDocxToPdf(fileBytes, (message) => setLoading(message, "Your file stays on this device."))
      : null;
    state.pdfBytes = conversion ? conversion.pdfBytes : new Uint8Array(fileBytes);
    state.pdf = await openPdfForPreview(state.pdfBytes);
    state.pageCount = state.pdf.numPages;
    state.currentPage = 1;

    showLoadedFile(file, converted);
    controls.previewToolbar.hidden = false;
    controls.pageControls.hidden = false;
    controls.pageCount.textContent = `of ${state.pageCount}`;
    controls.pageNumber.max = String(state.pageCount);
    controls.pageNumber.value = "1";
    controls.emptyState.hidden = true;
    controls.loadingState.hidden = true;
    setBusy(false);
    await buildPageViews();
    setCurrentPage(1, false);
    await renderPagesAround(1);
    scrollToPage(1, "auto");
    setStatus(
      converted
        ? conversion.conversionMode === "microsoft-word"
          ? "Word document converted with Microsoft Word. Scroll continuously through all pages."
          : conversion.conversionMode === "browser-office"
            ? "Word document converted privately with LibreOffice in this browser. Scroll continuously through all pages."
            : "Word document converted with the compatibility renderer. Complex Office-only formatting may differ slightly."
        : "Document ready. Scroll continuously through all pages.",
      "success",
    );
  } catch (error) {
    const message = errorMessage(error);
    resetDocumentState();
    hideLoadedFile();
    setBusy(false);
    setStatus(message, "error");
  } finally {
    controls.fileInput.value = "";
  }
}

function currentAnnotation(id) {
  return state.annotations.find((annotation) => annotation.id === id);
}

function cloneAnnotations(annotations = state.annotations) {
  return typeof structuredClone === "function"
    ? structuredClone(annotations)
    : JSON.parse(JSON.stringify(annotations));
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.decoding = "async";
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This signature image could not be read."));
    };
    image.src = objectUrl;
  });
}

async function prepareSignatureImage(file) {
  const supportedType = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
  const supportedName = /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!supportedType && !supportedName) {
    throw new Error("Choose a PNG, JPG, or WebP signature image.");
  }
  if (file.size > MAX_SIGNATURE_FILE_BYTES) {
    throw new Error("Signature images must be 10 MB or smaller.");
  }

  const image = await loadImageFile(file);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) {
    throw new Error("This signature image has invalid dimensions.");
  }

  const scale = Math.min(1, MAX_SIGNATURE_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the signature image.");
  context.drawImage(image, 0, 0, width, height);

  return {
    imageData: canvas.toDataURL("image/png"),
    aspectRatio: width / height,
  };
}

async function handleSignatureUpload() {
  const [file] = controls.signatureFile.files;
  if (!file || !state.pdf) return;

  controls.uploadSignatureButton.disabled = true;
  setStatus("Preparing uploaded signature…");
  try {
    const signature = await prepareSignatureImage(file);
    state.inkMode = false;
    state.inkStroke = null;
    state.selectedId = null;
    state.pendingPlacement = {
      type: "signature",
      label: "Signature",
      ...signature,
    };
    updateActionState();
    setStatus("Signature ready. Click a page to place it.", "success");
    state.pageViews.get(state.currentPage)?.stage.focus({ preventScroll: true });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not upload this signature.", "error");
  } finally {
    controls.signatureFile.value = "";
    updateActionState();
  }
}

function isEditableTarget(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function movementBounds(annotation, view) {
  const rect = view?.stage.getBoundingClientRect();
  const width = annotation.width || 0.03;
  const height = annotation.height || 0.03;
  const marginX = annotation.type === "textbox" && rect?.width
    ? TEXTBOX_BOUNDARY_MARGIN_PX / rect.width
    : 0;
  const marginY = annotation.type === "textbox" && rect?.height
    ? TEXTBOX_BOUNDARY_MARGIN_PX / rect.height
    : 0;

  return {
    minX: -marginX,
    minY: -marginY,
    maxX: 1 - width + marginX,
    maxY: 1 - height + marginY,
    marginX,
    marginY,
  };
}

function copySelectedAnnotation() {
  const annotation = currentAnnotation(state.selectedId);
  if (!annotation) return false;

  state.annotationClipboard = cloneAnnotations([annotation])[0];
  state.pasteCount = 0;
  setStatus("Selected item copied. Press Ctrl/Cmd+V to paste it.", "success");
  return true;
}

function pasteCopiedAnnotation() {
  if (!state.annotationClipboard || !state.pdf) return false;

  const annotation = cloneAnnotations([state.annotationClipboard])[0];
  annotation.id = createId();
  annotation.page = state.currentPage;
  state.pasteCount += 1;
  const offset = PASTE_OFFSET * Math.min(state.pasteCount, 5);

  if (annotation.type === "ink") {
    annotation.points = annotation.points.map((point) => ({
      x: clamp(point.x + offset, 0, 1),
      y: clamp(point.y + offset, 0, 1),
    }));
  } else {
    const view = state.pageViews.get(annotation.page);
    const bounds = movementBounds(annotation, view);
    annotation.x = clamp((annotation.x || 0) + offset, bounds.minX, bounds.maxX);
    annotation.y = clamp((annotation.y || 0) + offset, bounds.minY, bounds.maxY);
  }

  recordHistory();
  state.annotations.push(annotation);
  state.selectedId = annotation.id;
  state.pendingPlacement = null;
  state.inkMode = false;
  renderAnnotations();
  setStatus(`Item pasted on page ${annotation.page}.`, "success");
  return true;
}

function recordHistory() {
  state.undoStack.push(cloneAnnotations());
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
  updateActionState();
}

function inkPath(points, width, height) {
  if (!points.length) return "";
  if (points.length === 1) {
    const point = points[0];
    const x = point.x * width;
    const y = point.y * height;
    return `M ${x} ${y} L ${x + 0.01} ${y + 0.01}`;
  }

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x * width} ${point.y * height}`)
    .join(" ");
}

function growTextBox(textarea, annotation, element, stage) {
  if (annotation.autoGrow === false) return;
  const stageHeight = stage.getBoundingClientRect().height || 1;
  textarea.style.height = "1px";
  const nextHeight = Math.max(38, textarea.scrollHeight + 2);
  annotation.height = clamp(
    Math.max(annotation.height || 0, nextHeight / stageHeight),
    38 / stageHeight,
    0.95,
  );
  const bounds = movementBounds(annotation, state.pageViews.get(annotation.page));
  annotation.x = clamp(annotation.x, bounds.minX, bounds.maxX);
  annotation.y = clamp(annotation.y, bounds.minY, bounds.maxY);
  element.style.top = `${annotation.y * 100}%`;
  element.style.height = `${annotation.height * 100}%`;
  textarea.style.height = "100%";
}

function renderAnnotationsForPage(pageNumber) {
  const view = state.pageViews.get(pageNumber);
  if (!view) return;

  view.annotationLayer.replaceChildren();
  const pageAnnotations = state.annotations.filter(
    (annotation) => annotation.page === pageNumber,
  );

  for (const annotation of pageAnnotations) {
    if (annotation.type === "ink") {
      const width = view.stage.clientWidth || 1;
      const height = view.stage.clientHeight || 1;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.classList.add("ink-annotation");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      path.setAttribute("d", inkPath(annotation.points, width, height));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", annotation.id === state.selectedId ? "#2563eb" : "#101318");
      path.setAttribute("stroke-width", String((annotation.thickness || 1.8) * state.zoom));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.dataset.id = annotation.id;
      path.addEventListener("pointerdown", (event) => {
        if (state.inkMode) return;
        event.preventDefault();
        event.stopPropagation();
        setCurrentPage(annotation.page);
        state.selectedId = annotation.id;
        renderAnnotations();
      });
      svg.append(path);
      view.annotationLayer.append(svg);
      continue;
    }

    const element = document.createElement("div");
    element.setAttribute("role", "group");
    element.tabIndex = 0;
    element.className = `annotation annotation-${annotation.type}`;
    element.dataset.id = annotation.id;
    element.setAttribute(
      "aria-label",
      annotation.type === "signature"
        ? "Placed signature"
        : annotation.type === "textbox"
          ? "Editable text box"
          : `Placed text: ${annotation.text}`,
    );
    element.style.left = `${annotation.x * 100}%`;
    element.style.top = `${annotation.y * 100}%`;
    element.classList.toggle("is-selected", annotation.id === state.selectedId);

    if (annotation.type === "text") {
      element.textContent = annotation.text;
      element.style.fontSize = `${annotation.fontSize * state.zoom}px`;
      element.addEventListener("pointerdown", startDrag);
      element.addEventListener("keydown", handleAnnotationKeydown);
    } else if (annotation.type === "signature") {
      element.style.width = `${annotation.width * 100}%`;
      element.style.height = `${annotation.height * 100}%`;
      const image = document.createElement("img");
      image.src = annotation.imageData;
      image.alt = "";
      const resizeHandle = document.createElement("span");
      resizeHandle.className = "signature-resize";
      resizeHandle.title = "Resize signature";
      resizeHandle.dataset.id = annotation.id;
      resizeHandle.addEventListener("pointerdown", startResize);
      element.append(image, resizeHandle);
      element.addEventListener("pointerdown", startDrag);
      element.addEventListener("keydown", handleAnnotationKeydown);
    } else if (annotation.type === "textbox") {
      element.style.width = `${annotation.width * 100}%`;
      element.style.height = `${annotation.height * 100}%`;

      const moveHandle = document.createElement("span");
      moveHandle.className = "textbox-move";
      moveHandle.textContent = "••";
      moveHandle.title = "Drag text box";
      moveHandle.dataset.id = annotation.id;
      moveHandle.addEventListener("pointerdown", startDrag);

      const textarea = document.createElement("textarea");
      textarea.className = "textbox-editor";
      textarea.value = annotation.text;
      textarea.placeholder = "Type here…";
      textarea.setAttribute("aria-label", "Text box content");
      textarea.style.fontSize = `${annotation.fontSize * state.zoom}px`;
      textarea.style.padding = `${7 * state.zoom}px ${22 * state.zoom}px ${6 * state.zoom}px ${7 * state.zoom}px`;
      textarea.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        setCurrentPage(annotation.page);
        state.selectedId = annotation.id;
        controls.fontSize.value = String(annotation.fontSize);
        updateActionState();
      });
      textarea.addEventListener("input", () => {
        if (state.editingTextId !== annotation.id) recordHistory();
        state.editingTextId = annotation.id;
        annotation.text = textarea.value;
        growTextBox(textarea, annotation, element, view.stage);
      });
      textarea.addEventListener("focus", () => {
        setCurrentPage(annotation.page);
        state.selectedId = annotation.id;
        controls.fontSize.value = String(annotation.fontSize);
        element.classList.add("is-selected");
        updateActionState();
      });
      textarea.addEventListener("blur", () => {
        if (state.editingTextId === annotation.id) state.editingTextId = null;
      });
      textarea.addEventListener("keydown", (event) => {
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;
        const historyShortcut = modifier && (key === "z" || key === "y");
        if (!historyShortcut) event.stopPropagation();
      });

      const resizeHandle = document.createElement("span");
      resizeHandle.className = "textbox-resize";
      resizeHandle.title = "Resize text box";
      resizeHandle.dataset.id = annotation.id;
      resizeHandle.addEventListener("pointerdown", startResize);

      element.append(moveHandle, textarea, resizeHandle);
      requestAnimationFrame(() => growTextBox(textarea, annotation, element, view.stage));
    }

    view.annotationLayer.append(element);
  }
}

function renderAnnotations(pageNumber = null) {
  if (pageNumber) {
    renderAnnotationsForPage(pageNumber);
  } else {
    for (const number of state.pageViews.keys()) renderAnnotationsForPage(number);
  }

  updateActionState();

  if (state.focusTextBoxId) {
    const id = state.focusTextBoxId;
    state.focusTextBoxId = null;
    requestAnimationFrame(() => {
      const editor = controls.pageWrap.querySelector(
        `.annotation-textbox[data-id="${CSS.escape(id)}"] .textbox-editor`,
      );
      editor?.focus();
    });
  }
}

async function buildPageViews() {
  const pdf = state.pdf;
  const zoom = state.zoom;
  state.buildingViews = true;
  controls.pageWrap.hidden = true;
  state.pageViews.clear();
  controls.pageWrap.replaceChildren();

  try {
    for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      if (state.pdf !== pdf || state.zoom !== zoom) return;
      const viewport = page.getViewport({ scale: zoom });
      const wrap = document.createElement("div");
      const stage = document.createElement("div");
      const canvas = document.createElement("canvas");
      const annotationLayer = document.createElement("div");

      wrap.className = "page-wrap";
      wrap.dataset.page = String(pageNumber);
      stage.className = "page-stage";
      stage.dataset.page = String(pageNumber);
      stage.tabIndex = 0;
      stage.setAttribute("aria-label", `Document page ${pageNumber} of ${state.pageCount}`);
      stage.style.width = `${viewport.width}px`;
      stage.style.height = `${viewport.height}px`;
      canvas.className = "pdf-canvas";
      canvas.width = 1;
      canvas.height = 1;
      canvas.setAttribute("aria-hidden", "true");
      annotationLayer.className = "annotation-layer";
      stage.addEventListener("pointerdown", handlePagePointerDown);
      stage.append(canvas, annotationLayer);
      wrap.append(stage);
      controls.pageWrap.append(wrap);

      state.pageViews.set(pageNumber, {
        pageNumber,
        wrap,
        stage,
        canvas,
        annotationLayer,
        renderedZoom: null,
        renderPromise: null,
      });
    }
  } finally {
    state.buildingViews = false;
    controls.pageWrap.hidden = false;
  }

  updateActionState();
}

function renderPage(pageNumber) {
  const view = state.pageViews.get(pageNumber);
  if (!state.pdf || !view) return Promise.resolve();
  if (view.renderedZoom === state.zoom) return Promise.resolve();
  if (view.renderPromise) return view.renderPromise;

  const pdf = state.pdf;
  const zoom = state.zoom;
  view.stage.classList.add("is-rendering");
  view.renderPromise = renderPdfPage(pdf, pageNumber, view.canvas, zoom, null)
    .then(({ viewport }) => {
      if (state.pdf !== pdf || state.zoom !== zoom || state.pageViews.get(pageNumber) !== view) return;
      view.stage.style.width = `${viewport.width}px`;
      view.stage.style.height = `${viewport.height}px`;
      view.renderedZoom = zoom;
      renderAnnotations(pageNumber);
    })
    .catch((error) => setStatus(errorMessage(error), "error"))
    .finally(() => {
      view.stage.classList.remove("is-rendering");
      view.renderPromise = null;
    });
  return view.renderPromise;
}

function renderPagesAround(pageNumber) {
  const pages = [pageNumber, pageNumber + 1, pageNumber - 1]
    .filter((number) => number >= 1 && number <= state.pageCount);
  return Promise.all([...new Set(pages)].map(renderPage));
}

function setCurrentPage(pageNumber, renderAhead = true) {
  const nextPage = clamp(Math.round(Number(pageNumber) || 1), 1, state.pageCount || 1);
  state.currentPage = nextPage;
  controls.pageNumber.value = String(nextPage);
  controls.previousPage.disabled = nextPage <= 1;
  controls.nextPage.disabled = nextPage >= state.pageCount;
  if (renderAhead) void renderPagesAround(nextPage);
}

function scrollToPage(pageNumber, behavior = "smooth") {
  const view = state.pageViews.get(pageNumber);
  if (!view) return;
  const viewportRect = controls.previewViewport.getBoundingClientRect();
  const pageRect = view.wrap.getBoundingClientRect();
  const top = controls.previewViewport.scrollTop + pageRect.top - viewportRect.top - 20;
  controls.previewViewport.scrollTo({ top: Math.max(0, top), behavior });
}

function selectPage(pageNumber) {
  const nextPage = clamp(Math.round(Number(pageNumber) || 1), 1, state.pageCount || 1);
  setCurrentPage(nextPage);
  scrollToPage(nextPage);
}

function handleContinuousScroll() {
  if (state.scrollFrame || state.buildingViews || !state.pageViews.size) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = null;
    const viewportRect = controls.previewViewport.getBoundingClientRect();
    let activePage = state.currentPage;
    let bestVisibleArea = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const view of state.pageViews.values()) {
      const rect = view.wrap.getBoundingClientRect();
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top),
      );
      const distance = Math.abs(rect.top - viewportRect.top - 20);
      if (visibleHeight > bestVisibleArea || (visibleHeight === bestVisibleArea && distance < bestDistance)) {
        activePage = view.pageNumber;
        bestVisibleArea = visibleHeight;
        bestDistance = distance;
      }
    }

    if (activePage !== state.currentPage) setCurrentPage(activePage, false);
    void renderPagesAround(activePage);
  });
}

function beginTextBoxPlacement() {
  if (!state.pdf) return;
  state.inkMode = false;
  state.pendingPlacement = {
    type: "textbox",
    label: "Text box",
    fontSize: Number(controls.fontSize.value) || DEFAULT_TEXT_SIZE,
  };
  state.selectedId = null;
  setStatus("");
  updateActionState();
  state.pageViews.get(state.currentPage)?.stage.focus({ preventScroll: true });
}

async function detectAndPlaceTextBoxes() {
  if (!state.pdf || state.busy) return;
  const pdf = state.pdf;
  state.pendingPlacement = null;
  state.inkMode = false;
  state.inkStroke = null;
  controls.detectBlanksButton.disabled = true;
  setStatus("Scanning for fillable blanks…");

  try {
    const found = [];
    for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
      if (found.length >= MAX_AUTO_REGIONS) break;
      const page = await pdf.getPage(pageNumber);
      if (state.pdf !== pdf) return;
      const viewport = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      if (state.pdf !== pdf) return;
      const regions = detectBlankRegions(items, viewport.width, viewport.height, {
        maxRegions: MAX_AUTO_REGIONS - found.length,
      });
      for (const region of regions) found.push({ pageNumber, region });
    }

    if (!found.length) {
      setStatus("No fillable blanks detected in this document.");
      return;
    }

    recordHistory();
    for (const { pageNumber, region } of found) {
      state.annotations.push({
        id: createId(),
        type: "textbox",
        page: pageNumber,
        text: "",
        fontSize: region.fontSize,
        width: region.width,
        height: region.height,
        autoGrow: true,
        x: region.x,
        y: region.y,
      });
    }
    state.selectedId = null;
    renderAnnotations();
    const capNote = found.length >= MAX_AUTO_REGIONS ? " Limit of 200 boxes reached." : "";
    setStatus(
      `${found.length} text box${found.length === 1 ? "" : "es"} placed over detected blanks. One Undo removes them all.${capNote}`,
      "success",
    );
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    updateActionState();
  }
}

function toggleInkMode() {
  if (!state.pdf) return;
  state.inkMode = !state.inkMode;
  state.pendingPlacement = null;
  state.selectedId = null;
  state.inkStroke = null;
  setStatus(state.inkMode ? "Draw on the page. Undo the last stroke to retry." : "Drawing finished.", state.inkMode ? "neutral" : "success");
  renderAnnotations();
  state.pageViews.get(state.currentPage)?.stage.focus({ preventScroll: true });
}

function placePending(event, view) {
  if (!state.pendingPlacement || state.busy) {
    if (event.target === view.stage || event.target === view.canvas || event.target === view.annotationLayer) {
      state.selectedId = null;
      renderAnnotations();
    }
    return;
  }

  event.preventDefault();
  setCurrentPage(view.pageNumber);
  const rect = view.stage.getBoundingClientRect();
  const clickX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const clickY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
  const pending = state.pendingPlacement;
  let annotation;
  if (pending.type === "signature") {
    const maxWidth = 0.32;
    const maxHeight = 0.18;
    const aspectRatio = pending.aspectRatio || 2.5;
    let width = maxWidth;
    let height = (width * rect.width) / (aspectRatio * rect.height);
    if (height > maxHeight) {
      height = maxHeight;
      width = (height * aspectRatio * rect.height) / rect.width;
    }
    annotation = {
      id: createId(),
      type: "signature",
      page: view.pageNumber,
      imageData: pending.imageData,
      aspectRatio,
      width,
      height,
      x: clamp(clickX, 0, 1 - width),
      y: clamp(clickY, 0, 1 - height),
    };
  } else {
    const width = 0.36;
    const height = Math.max(44 / rect.height, 0.055);
    annotation = {
      id: createId(),
      type: "textbox",
      page: view.pageNumber,
      text: "",
      fontSize: pending.fontSize,
      width,
      height,
      autoGrow: true,
      x: clamp(clickX, 0, 1 - width),
      y: clamp(clickY, 0, 1 - height),
    };
  }

  recordHistory();
  state.annotations.push(annotation);
  state.selectedId = annotation.id;
  state.focusTextBoxId = annotation.type === "textbox" ? annotation.id : null;
  state.pendingPlacement = null;
  renderAnnotations();
  setStatus(
    annotation.type === "signature"
      ? "Signature placed. Drag it to move it or use the blue corner to resize it."
      : "Text box placed. Type directly in it; drag the dotted handle to move it or the blue corner to resize it.",
    "success",
  );
}

function applyTextSize() {
  const fontSize = Number(controls.fontSize.value) || DEFAULT_TEXT_SIZE;
  if (state.pendingPlacement?.type === "textbox") {
    state.pendingPlacement.fontSize = fontSize;
  }

  const annotation = currentAnnotation(state.selectedId);
  if (!annotation || annotation.type !== "textbox" || annotation.fontSize === fontSize) return;

  recordHistory();
  annotation.fontSize = fontSize;
  renderAnnotations();
  setStatus(`Text size changed to ${fontSize} pt.`, "success");
}

function pagePoint(event, view) {
  const rect = view.stage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function startInkStroke(event, view) {
  if (!state.inkMode || state.busy || event.button !== 0) return false;
  event.preventDefault();
  setCurrentPage(view.pageNumber);
  const annotation = {
    id: createId(),
    type: "ink",
    page: view.pageNumber,
    points: [pagePoint(event, view)],
    thickness: 1.8,
  };
  recordHistory();
  state.annotations.push(annotation);
  state.selectedId = annotation.id;
  state.inkStroke = { id: annotation.id, page: view.pageNumber, pointerId: event.pointerId };
  view.stage.setPointerCapture?.(event.pointerId);
  renderAnnotations();
  return true;
}

function continueInkStroke(event) {
  if (!state.inkStroke || event.pointerId !== state.inkStroke.pointerId) return false;
  const annotation = currentAnnotation(state.inkStroke.id);
  if (!annotation) return false;
  const view = state.pageViews.get(annotation.page);
  if (!view) return false;
  const point = pagePoint(event, view);
  const previous = annotation.points.at(-1);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0015) return true;
  annotation.points.push(point);
  renderAnnotations();
  return true;
}

function endInkStroke(event) {
  if (!state.inkStroke || (event.pointerId !== undefined && event.pointerId !== state.inkStroke.pointerId)) {
    return false;
  }
  state.inkStroke = null;
  setStatus("Stroke added. Keep drawing, choose Undo last to retry, or choose Done drawing.", "success");
  return true;
}

function handlePagePointerDown(event) {
  const view = state.pageViews.get(Number(event.currentTarget.dataset.page));
  if (!view) return;
  setCurrentPage(view.pageNumber);
  if (startInkStroke(event, view)) return;
  placePending(event, view);
}

function startDrag(event) {
  event.preventDefault();
  event.stopPropagation();
  const id = event.currentTarget.dataset.id;
  const annotation = currentAnnotation(id);
  if (!annotation) return;

  const view = state.pageViews.get(annotation.page);
  if (!view) return;
  const rect = view.stage.getBoundingClientRect();
  recordHistory();
  setCurrentPage(annotation.page);
  state.selectedId = id;
  state.pendingPlacement = null;
  state.inkMode = false;
  state.resize = null;
  state.drag = {
    id,
    page: annotation.page,
    pointerId: event.pointerId,
    offsetX: (event.clientX - rect.left) / rect.width - annotation.x,
    offsetY: (event.clientY - rect.top) / rect.height - annotation.y,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  renderAnnotations();
}

function startResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const id = event.currentTarget.dataset.id;
  const annotation = currentAnnotation(id);
  if (!annotation || !["textbox", "signature"].includes(annotation.type)) return;

  recordHistory();
  if (annotation.type === "textbox") annotation.autoGrow = false;
  setCurrentPage(annotation.page);
  state.selectedId = id;
  state.pendingPlacement = null;
  state.inkMode = false;
  state.drag = null;
  state.resize = { id, page: annotation.page, pointerId: event.pointerId };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  updateActionState();
}

function continueDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const annotation = currentAnnotation(state.drag.id);
  if (!annotation) return;

  const view = state.pageViews.get(annotation.page);
  if (!view) return;
  const rect = view.stage.getBoundingClientRect();
  const bounds = movementBounds(annotation, view);
  annotation.x = clamp(
    (event.clientX - rect.left) / rect.width - state.drag.offsetX,
    bounds.minX,
    bounds.maxX,
  );
  annotation.y = clamp(
    (event.clientY - rect.top) / rect.height - state.drag.offsetY,
    bounds.minY,
    bounds.maxY,
  );
  renderAnnotations();
}

function continueResize(event) {
  if (!state.resize || event.pointerId !== state.resize.pointerId) return false;
  const annotation = currentAnnotation(state.resize.id);
  if (!annotation) return false;

  const view = state.pageViews.get(annotation.page);
  if (!view) return false;
  const rect = view.stage.getBoundingClientRect();
  const pointerX = (event.clientX - rect.left) / rect.width;
  const pointerY = (event.clientY - rect.top) / rect.height;
  if (annotation.type === "signature") {
    const aspectRatio = annotation.aspectRatio || 2.5;
    const minWidth = 70 / rect.width;
    const maxWidth = 1 - annotation.x;
    const maxHeight = 1 - annotation.y;
    let width = clamp(pointerX - annotation.x, minWidth, maxWidth);
    let height = (width * rect.width) / (aspectRatio * rect.height);
    if (height > maxHeight) {
      height = maxHeight;
      width = (height * aspectRatio * rect.height) / rect.width;
    }
    annotation.width = width;
    annotation.height = height;
    renderAnnotations();
    return true;
  }

  const marginX = TEXTBOX_BOUNDARY_MARGIN_PX / rect.width;
  const marginY = TEXTBOX_BOUNDARY_MARGIN_PX / rect.height;
  annotation.width = clamp(
    pointerX - annotation.x,
    MIN_TEXTBOX_SIZE_PX / rect.width,
    1 - annotation.x + marginX,
  );
  annotation.height = clamp(
    pointerY - annotation.y,
    MIN_TEXTBOX_SIZE_PX / rect.height,
    1 - annotation.y + marginY,
  );
  renderAnnotations();
  return true;
}

function endPointerOperation(event) {
  if (endInkStroke(event)) return;
  if (state.resize && (event.pointerId === undefined || event.pointerId === state.resize.pointerId)) {
    state.resize = null;
  }
  if (state.drag && (event.pointerId === undefined || event.pointerId === state.drag.pointerId)) {
    state.drag = null;
  }
}

function handleAnnotationKeydown(event) {
  const annotation = currentAnnotation(event.currentTarget.dataset.id);
  if (!annotation) return;

  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    event.stopPropagation();
    removeSelected();
    return;
  }

  const movement = event.shiftKey ? 0.01 : 0.003;
  const directions = {
    ArrowLeft: [-movement, 0],
    ArrowRight: [movement, 0],
    ArrowUp: [0, -movement],
    ArrowDown: [0, movement],
  };
  const direction = directions[event.key];
  if (!direction) return;

  event.preventDefault();
  event.stopPropagation();
  const view = state.pageViews.get(annotation.page);
  const bounds = movementBounds(annotation, view);
  annotation.x = clamp(annotation.x + direction[0], bounds.minX, bounds.maxX);
  annotation.y = clamp(annotation.y + direction[1], bounds.minY, bounds.maxY);
  renderAnnotations();
}

function undoLast() {
  if (!state.undoStack.length) return;
  state.redoStack.push(cloneAnnotations());
  state.annotations = state.undoStack.pop();
  state.selectedId = null;
  state.editingTextId = null;
  renderAnnotations();
  setStatus("Undone.");
}

function redoLast() {
  if (!state.redoStack.length) return;
  state.undoStack.push(cloneAnnotations());
  state.annotations = state.redoStack.pop();
  state.selectedId = null;
  state.editingTextId = null;
  renderAnnotations();
  setStatus("Redone.");
}

function removeSelected() {
  if (!state.selectedId) return;
  recordHistory();
  state.annotations = state.annotations.filter((annotation) => annotation.id !== state.selectedId);
  state.selectedId = null;
  renderAnnotations();
  setStatus("Selected item removed.");
}

function finishEditing() {
  state.pendingPlacement = null;
  state.inkMode = false;
  state.inkStroke = null;
  state.drag = null;
  state.resize = null;
  state.selectedId = null;
  state.editingTextId = null;
  document.activeElement?.blur?.();
  renderAnnotations();
  setStatus("Editing complete. Download the signed PDF when ready.", "success");
}

async function exportSignedPdf() {
  if (!state.pdfBytes || !state.sourceFile) return;
  state.exportBusy = true;
  updateActionState();
  setStatus("Preparing your signed PDF…");

  try {
    const output = await applyAnnotations(state.pdfBytes, state.annotations);
    downloadPdf(output, signedFilename(state.sourceFile.name));
    setStatus(
      state.annotations.length
        ? `Signed PDF downloaded with ${state.annotations.length} placed item${state.annotations.length === 1 ? "" : "s"}.`
        : "PDF downloaded.",
      "success",
    );
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    state.exportBusy = false;
    updateActionState();
  }
}

function initialize() {
  syncStickyHeaderHeight();
  new ResizeObserver(syncStickyHeaderHeight).observe(controls.appHeader);

  controls.fileInput.addEventListener("change", () => {
    const [file] = controls.fileInput.files;
    if (file) void loadDocument(file);
  });
  controls.replaceButton.addEventListener("click", () => controls.fileInput.click());

  controls.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    controls.dropZone.classList.add("is-over");
  });
  controls.dropZone.addEventListener("dragleave", () => controls.dropZone.classList.remove("is-over"));
  controls.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    controls.dropZone.classList.remove("is-over");
    const [file] = event.dataTransfer.files;
    if (file) void loadDocument(file);
  });

  controls.addTextBoxButton.addEventListener("click", beginTextBoxPlacement);
  controls.detectBlanksButton.addEventListener("click", () => void detectAndPlaceTextBoxes());
  controls.drawOnPageButton.addEventListener("click", toggleInkMode);
  controls.uploadSignatureButton.addEventListener("click", () => controls.signatureFile.click());
  controls.signatureFile.addEventListener("change", () => void handleSignatureUpload());
  controls.fontSize.addEventListener("change", applyTextSize);

  window.addEventListener("pointermove", (event) => {
    if (continueInkStroke(event)) return;
    if (continueResize(event)) return;
    continueDrag(event);
  });
  window.addEventListener("pointerup", endPointerOperation);
  window.addEventListener("pointercancel", endPointerOperation);

  controls.previousPage.addEventListener("click", () => selectPage(state.currentPage - 1));
  controls.nextPage.addEventListener("click", () => selectPage(state.currentPage + 1));
  controls.pageNumber.addEventListener("change", () => selectPage(controls.pageNumber.value));
  controls.previewViewport.addEventListener("scroll", handleContinuousScroll, { passive: true });
  controls.zoom.addEventListener("change", () => {
    state.zoom = Number(controls.zoom.value) || 1;
    const pageNumber = state.currentPage;
    void buildPageViews()
      .then(() => renderPagesAround(pageNumber))
      .then(() => scrollToPage(pageNumber, "auto"));
  });

  controls.undoButton.addEventListener("click", undoLast);
  controls.redoButton.addEventListener("click", redoLast);
  controls.removeButton.addEventListener("click", removeSelected);
  controls.doneButton.addEventListener("click", finishEditing);
  controls.exportButton.addEventListener("click", () => void exportSignedPdf());

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;

    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    const undoShortcut = modifier && key === "z" && !event.shiftKey;
    const redoShortcut = modifier && (key === "y" || (key === "z" && event.shiftKey));
    if (undoShortcut && state.undoStack.length) {
      event.preventDefault();
      undoLast();
      return;
    }
    if (redoShortcut && state.redoStack.length) {
      event.preventDefault();
      redoLast();
      return;
    }

    if (isEditableTarget(event.target)) return;

    if (modifier && key === "c" && state.selectedId) {
      event.preventDefault();
      copySelectedAnnotation();
      return;
    }
    if (modifier && key === "v" && state.annotationClipboard) {
      event.preventDefault();
      pasteCopiedAnnotation();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && state.selectedId) {
      event.preventDefault();
      removeSelected();
      return;
    }

    if (event.key === "Escape" && (state.pendingPlacement || state.inkMode)) {
      state.pendingPlacement = null;
      state.inkMode = false;
      state.inkStroke = null;
      updateActionState();
      setStatus("Document tool cancelled.");
    }
  });

  updateActionState();
}

initialize();

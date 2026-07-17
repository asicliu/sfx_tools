import { ZetaHelperThread } from "/vendor/zetajs/zetaHelper.js";

const zetaThread = new ZetaHelperThread();
const zetajs = zetaThread.zetajs;
const office = zetaThread.css;
const hiddenProperty = new office.beans.PropertyValue({ Name: "Hidden", Value: true });
const overwriteProperty = new office.beans.PropertyValue({ Name: "Overwrite", Value: true });
const pdfExportProperty = new office.beans.PropertyValue({
  Name: "FilterName",
  Value: "writer_pdf_Export",
});

let openDocument;

function closeOpenDocument() {
  if (!openDocument) return;
  try {
    const closeable = openDocument.queryInterface(zetajs.type.interface(office.util.XCloseable));
    closeable?.close(false);
  } catch {
    // The next conversion uses fresh temporary paths, so cleanup failure is non-fatal.
  }
  openDocument = undefined;
}

function errorText(error) {
  try {
    return zetajs.catchUnoException(error)?.Message || String(error);
  } catch {
    return error instanceof Error ? error.message : String(error);
  }
}

zetaThread.thrPort.onmessage = (event) => {
  if (event.data.cmd !== "convert") {
    throw new Error(`Unknown browser Office command: ${event.data.cmd}`);
  }

  const { id, from, to } = event.data;
  try {
    closeOpenDocument();
    openDocument = zetaThread.desktop.loadComponentFromURL(
      `file://${from}`,
      "_blank",
      0,
      [hiddenProperty],
    );
    openDocument.storeToURL(`file://${to}`, [overwriteProperty, pdfExportProperty]);
    closeOpenDocument();
    zetajs.mainPort.postMessage({ cmd: "converted", id, from, to });
  } catch (error) {
    closeOpenDocument();
    zetajs.mainPort.postMessage({ cmd: "conversion-error", id, message: errorText(error) });
  }
};

zetaThread.thrPort.postMessage({ cmd: "start" });

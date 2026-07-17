const ZETA_HELPER_URL = "/vendor/zetajs/zetaHelper.js";
const CONVERSION_THREAD_URL = "/docx-conversion-thread.js";
const INITIALIZATION_TIMEOUT_MS = 180_000;
const CONVERSION_TIMEOUT_MS = 120_000;

let browserOfficePromise;

function removeTemporaryFile(fileSystem, path) {
  try {
    fileSystem.unlink(path);
  } catch {
    // The in-browser filesystem is discarded with the page, so cleanup is best effort.
  }
}

function withTimeout(promise, timeoutMs, message, onTimeout = () => {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function initializeBrowserOffice(onProgress) {
  if (!globalThis.crossOriginIsolated || typeof globalThis.SharedArrayBuffer === "undefined") {
    throw new Error("The browser Office engine requires cross-origin isolation headers.");
  }

  onProgress("Loading the private Word layout engine for the first time…");
  const { ZetaHelperMain } = await import(/* @vite-ignore */ ZETA_HELPER_URL);
  const helper = new ZetaHelperMain(CONVERSION_THREAD_URL, {
    threadJsType: "module",
    wasmPkg: "free",
    blockPageScroll: false,
  });
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    helper.start(() => {
      helper.thrPort.onmessage = (event) => {
        const message = event.data;
        if (message.cmd === "start") {
          resolve();
          return;
        }

        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.cmd === "converted") {
          request.resolve(message);
        } else if (message.cmd === "conversion-error") {
          request.reject(new Error(message.message || "Browser Office conversion failed."));
        }
      };
    });
  });

  await withTimeout(
    ready,
    INITIALIZATION_TIMEOUT_MS,
    "The private Word layout engine did not finish loading.",
  );

  return {
    async convert(arrayBuffer, onConversionProgress) {
      const requestId = globalThis.crypto?.randomUUID?.() || String(Date.now());
      const inputPath = `/tmp/input-${requestId}.docx`;
      const outputPath = `/tmp/output-${requestId}.pdf`;
      helper.FS.writeFile(inputPath, new Uint8Array(arrayBuffer));
      onConversionProgress("Preserving Word pages, tables, headers, and footers…");

      const conversion = new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        helper.thrPort.postMessage({
          cmd: "convert",
          id: requestId,
          from: inputPath,
          to: outputPath,
        });
      });

      try {
        await withTimeout(
          conversion,
          CONVERSION_TIMEOUT_MS,
          "The private Word layout engine did not finish converting this document.",
          () => pending.delete(requestId),
        );
        const output = helper.FS.readFile(outputPath);
        return new Uint8Array(output);
      } finally {
        removeTemporaryFile(helper.FS, inputPath);
        removeTemporaryFile(helper.FS, outputPath);
      }
    },
  };
}

function getBrowserOffice(onProgress) {
  if (!browserOfficePromise) {
    browserOfficePromise = initializeBrowserOffice(onProgress).catch((error) => {
      browserOfficePromise = undefined;
      throw error;
    });
  }
  return browserOfficePromise;
}

export async function convertWithBrowserOffice(arrayBuffer, onProgress = () => {}) {
  const browserOffice = await getBrowserOffice(onProgress);
  return {
    pdfBytes: await browserOffice.convert(arrayBuffer, onProgress),
    conversionMode: "browser-office",
  };
}

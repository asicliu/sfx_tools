import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineConfig } from "vite";

const execFileAsync = promisify(execFile);
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const WORD_APP_PATH = "/Applications/Microsoft Word.app";
const WORD_TEMP_PREFIX = path.join(
  homedir(),
  "Library/Containers/com.microsoft.Word/Data/tmp/TemporaryItems/sfx-pdf-fill-sign-",
);
const PROJECT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(
  readFileSync(path.join(PROJECT_DIRECTORY, "package.json"), "utf8"),
).version;
const CROSS_ORIGIN_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const ZETA_BROWSER_ASSETS = new Map([
  [
    "/vendor/zetajs/zetaHelper.js",
    path.join(PROJECT_DIRECTORY, "node_modules/zetajs/source/zetaHelper.js"),
  ],
  [
    "/vendor/zetajs/zeta.js",
    path.join(PROJECT_DIRECTORY, "node_modules/zetajs/source/zeta.js"),
  ],
  [
    "/docx-conversion-thread.js",
    path.join(PROJECT_DIRECTORY, "src/docx-conversion-thread.js"),
  ],
]);

let conversionQueue = Promise.resolve();

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_DOCX_BYTES) {
        const error = new Error("The Word document is larger than the 50 MB limit.");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function convertWithMicrosoftWord(docxBytes) {
  if (process.platform !== "darwin") {
    const error = new Error("Layout-preserving Word conversion requires macOS and Microsoft Word.");
    error.statusCode = 503;
    throw error;
  }

  try {
    await access(WORD_APP_PATH);
  } catch {
    const error = new Error("Microsoft Word is not installed on this Mac.");
    error.statusCode = 503;
    throw error;
  }

  // Keep conversion files inside Word's own sandbox so macOS never asks for file access.
  const workDirectory = await mkdtemp(WORD_TEMP_PREFIX);
  const docxPath = path.join(workDirectory, "source.docx");
  const pdfPath = path.join(workDirectory, "converted.pdf");

  try {
    await writeFile(docxPath, docxBytes);
    const script = [
      "on run argv",
      "set docPath to item 1 of argv",
      "set pdfPath to item 2 of argv",
      'tell application "Microsoft Word"',
      "open file name docPath",
      "try",
      "save as active document file name pdfPath file format format PDF",
      "on error errorMessage number errorNumber",
      "close active document saving no",
      "error errorMessage number errorNumber",
      "end try",
      "close active document saving no",
      "end tell",
      "end run",
    ];
    const args = script.flatMap((line) => ["-e", line]);
    args.push(docxPath, pdfPath);
    await execFileAsync("osascript", args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return await readFile(pdfPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function queueWordConversion(docxBytes) {
  const conversion = conversionQueue.then(
    () => convertWithMicrosoftWord(docxBytes),
    () => convertWithMicrosoftWord(docxBytes),
  );
  conversionQueue = conversion.catch(() => {});
  return conversion;
}

function installConversionEndpoint(server) {
  server.middlewares.use("/api/convert-docx", async (request, response) => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("Allow", "POST");
      response.end("Method not allowed");
      return;
    }

    if (request.headers["x-sfx-local-converter"] !== "1") {
      response.statusCode = 403;
      response.end("Local converter request header is required.");
      return;
    }

    try {
      const docxBytes = await readRequestBody(request);
      if (!docxBytes.length) {
        response.statusCode = 400;
        response.end("Choose a non-empty Word document.");
        return;
      }

      const pdfBytes = await queueWordConversion(docxBytes);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Length", String(pdfBytes.length));
      response.setHeader("Cache-Control", "no-store");
      response.end(pdfBytes);
    } catch (error) {
      response.statusCode = error.statusCode || 500;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(error instanceof Error ? error.message : "Word conversion failed.");
    }
  });
}

function localWordConversion() {
  return {
    name: "local-word-conversion",
    configureServer: installConversionEndpoint,
    configurePreviewServer: installConversionEndpoint,
  };
}

function zetaBrowserAssets() {
  return {
    name: "zeta-browser-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        for (const [header, value] of Object.entries(CROSS_ORIGIN_HEADERS)) {
          response.setHeader(header, value);
        }
        next();
      });
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        const sourcePath = ZETA_BROWSER_ASSETS.get(pathname);
        if (!sourcePath) {
          next();
          return;
        }

        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(await readFile(sourcePath));
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const [requestPath, sourcePath] of ZETA_BROWSER_ASSETS) {
        this.emitFile({
          type: "asset",
          fileName: requestPath.slice(1),
          source: await readFile(sourcePath),
        });
      }
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    headers: CROSS_ORIGIN_HEADERS,
  },
  preview: {
    headers: CROSS_ORIGIN_HEADERS,
  },
  plugins: [zetaBrowserAssets(), localWordConversion()],
});

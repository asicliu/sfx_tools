import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const PROJECT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(
  readFileSync(path.join(PROJECT_DIRECTORY, "package.json"), "utf8"),
).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
});

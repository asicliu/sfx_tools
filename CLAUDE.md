# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

A collection of small, privacy-focused browser utilities served from a static hub. Each tool under `tools/<slug>/` is a **self-contained Vite app with its own `package.json` and lockfile** — there are no npm workspaces and no shared dependencies. All document processing happens client-side in the browser; files must never be uploaded to a server (the one exception is noted under pdf-fill-sign below).

Current tools: `jsx-renderer` (React), `markdown-to-pdf`, `pdf-watermark-js`, `pdf-fill-sign` (all vanilla JS ES modules except jsx-renderer). Requires Node >= 18.

## Commands

From the repository root:

```sh
npm run build   # Build hub + all tools into dist/ (runs npm ci in each tool)
npm run smoke   # Run every tool's smoke test
npm run check   # build + smoke
```

Per tool (run inside `tools/<slug>/`, or via `npm --prefix tools/<slug> run <script>`):

```sh
npm install
npm run dev     # Vite dev server on 127.0.0.1 (npm start is an alias)
npm run build   # vite build
npm run smoke   # Run this tool's smoke test only (node scripts/smoke-test.mjs)
npm run check   # build + smoke
```

Deploy (Cloudflare Workers): `npm run build` then `npx wrangler deploy` from the root. Root `wrangler.jsonc` serves `dist/` as static assets; each tool also has its own `wrangler.jsonc` for standalone deploys.

## Architecture

### Hub build pipeline

`scripts/build-hub.mjs` is the composition point: it wipes `dist/`, copies the static `hub/` landing page to the dist root, then for each tool runs `npm ci` and `vite build --base=/<slug>/` and copies the tool's `dist/` to `dist/<slug>/`. It emits a single root Cloudflare `_headers` file: baseline security headers plus each tool's own `_headers` rules (from the tool's `public/_headers`) re-scoped under `/<slug>` — Cloudflare ignores non-root `_headers` files, so per-tool header needs (e.g. pdf-fill-sign's COOP/COEP) must ride along this merge rather than a file in the tool's build output.

**Adding a new tool requires touching three places:** the `tools` array in `scripts/build-hub.mjs`, a tool card in `hub/index.html`, and the tool list in `README.md`. The tool itself must follow the existing convention (Vite app with `dev`/`build`/`smoke`/`check` scripts and a `scripts/smoke-test.mjs`), and its build must respect the `--base` flag so assets resolve under `/<slug>/`.

### Smoke tests instead of a test framework

There is no test runner. Each tool has `scripts/smoke-test.mjs`, a plain Node script that imports modules from `src/` and throws on failure. This imposes a real constraint: **logic covered by smoke tests must be importable in Node** — keep DOM access out of those modules (e.g. `src/watermark.js`, `src/transform.js`, `src/convert/manifest.js`, `src/pdf-export.js`) and confine browser-only code to `main.js`/entry files.

### Tool-specific notes

- **pdf-fill-sign** converts DOCX→PDF through a three-tier fallback chain in `src/docx.js`:
  1. **Dev only (macOS + Microsoft Word installed):** the `local-word-conversion` Vite plugin in `vite.config.js` exposes `/api/convert-docx` and drives Word via `osascript` for layout-faithful conversion. Only attempted when `import.meta.env.DEV`.
  2. **Primary path everywhere:** LibreOffice compiled to WebAssembly via `zetajs` (`src/office-converter.js` + worker `src/docx-conversion-thread.js`). Requires cross-origin isolation — COOP/COEP headers are set in `vite.config.js` for dev/preview and in `public/_headers` for deploys; without them the engine refuses to start. The `zeta-browser-assets` Vite plugin serves the zetajs helper scripts from `node_modules` in dev and emits them into the bundle at fixed paths (`/vendor/zetajs/…`, `/docx-conversion-thread.js`). The WASM engine itself is fetched from ZetaOffice's CDN on first use (code download only — documents never leave the browser).
  3. **Compatibility fallback:** `docx-preview` + `html-to-image` rasterization. It deliberately refuses to produce a PDF when its rendered page count disagrees with the page count Word recorded in the document, to prevent silently distorted output.

  Changes to DOCX handling must keep all three paths working.
- **pdf-watermark-js** converts `.pptx`/`.docx` to PDF in the browser (`src/convert/`) before watermarking, rasterizing pages. Non-Latin-1 watermark text (CJK, emoji) is rasterized as an image; Latin text is drawn as vector text. Permission protection (`src/encryption.js`) applies a random owner password by default to lock print/copy permissions.

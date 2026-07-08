# PDF Watermark JS

Client-side browser app for adding text watermarks to PDF, PowerPoint (`.pptx`), and Word (`.docx`) files. All processing happens in the browser; there is no upload endpoint or server-side processing.

## Office File Conversion

PowerPoint and Word files are converted to PDF in the browser before watermarking:

- **PowerPoint (`.pptx`)** — slides are rendered with `pptx-preview` and each PDF page uses the exact slide dimensions from the presentation (like PowerPoint's own PDF export), so widescreen decks produce 13.33in x 7.5in pages instead of being fit onto printer paper.
- **Word (`.docx`)** — pages are rendered with `docx-preview` using the page size declared in the document.

Conversion progress is reported per slide/page in the status line. Converted pages are rasterized (rendered as images), so text in converted output is not selectable. Rendering fidelity is good for typical text, shapes, tables, and images, but complex charts, SmartArt, or custom fonts may differ from Microsoft Office output. Legacy binary formats (`.ppt`, `.doc`) are not supported; re-save them as `.pptx`/`.docx` first.

## Watermark Text

Latin watermark text is drawn as vector text (Helvetica Bold). Text outside Latin-1 — Chinese, Japanese, Korean, emoji, typographic dashes — is rasterized at high resolution (~288 dpi) with system fonts and stamped as an image, so any script the browser can render works.

## Permissions

Permission protection is enabled by default. A random permissions password is generated when the app opens, and print/copy permissions are disabled unless you explicitly allow them before export.

The password is an owner/permissions password: it locks the PDF permission settings while still allowing the document to open without an open password. PDF permission enforcement can vary by PDF viewer.

## Requirements

- Node.js 18 or newer
- npm

## Local Development

```sh
npm install
npm start
```

Then open the local URL printed by Vite.

## Production Build

```sh
npm run build
npm run preview
```

The static output is written to `dist/`.

## Cloudflare Workers Setup

This project includes `wrangler.jsonc` for Cloudflare Workers Static Assets. The Worker name is set to `tools`; if you use a different Cloudflare project name, update the `name` field in `wrangler.jsonc` to match.

Recommended setup:

- Project name: `tools`
- Root directory: `tools/pdf-watermark-js`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Production branch: `main`
- Non-production branch builds: optional

If Cloudflare does not show a root directory field and you configure it from the repository root, use:

```sh
cd tools/pdf-watermark-js && npm ci && npm run build
```

as the build command, and:

```sh
cd tools/pdf-watermark-js && npx wrangler deploy
```

as the deploy command.

## Cloudflare Pages Setup

If you choose Pages instead of Workers:

- Framework preset: none
- Root directory: `tools/pdf-watermark-js`
- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`

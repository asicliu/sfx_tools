# PDF Watermark JS

Local browser-based utility for adding text watermarks to PDF files. It runs a temporary server on `127.0.0.1`, opens the browser, and shuts down when the browser page closes.

The tool can also accept `.doc`, `.docx`, `.ppt`, and `.pptx` files on macOS when Microsoft Word or PowerPoint is installed locally, then output a watermarked PDF.

## Requirements

- Node.js 16 or newer
- npm
- Optional for Office conversion on macOS: Microsoft Word and Microsoft PowerPoint

## Run From Source

```sh
npm install
npm start
```

You can also run it directly:

```sh
node pdfwatermark_web.js
```

or from the repository root:

```sh
tools/pdf-watermark-js/bin/pdf-watermark-js
```

## Build The macOS App

```sh
npm install
npm run build:macos-app
```

The generated app is written to `tools/pdf-watermark-js/dist/PDF Watermark JS.app`.

If `node_modules` exists when you build the app, dependencies are bundled into the app. Otherwise, the app will install `pdf-lib` on first run.

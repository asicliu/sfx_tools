# PDF Fill & Sign

Local tool for filling and signing PDF and DOCX files. Files stay on the device and are not uploaded to an external service.

## Features

- Open PDF or DOCX files.
- Convert DOCX pages to a PDF locally before editing.
- Add resizable text boxes and type directly on the document.
- Draw signature strokes directly in place with a mouse, trackpad, or finger.
- Undo and redo text, movement, resizing, removal, and signature strokes.
- Finish editing with a single Done action, then download the PDF.
- Download the finished document as a PDF.

During local development on macOS, DOCX conversion uses Microsoft Word when available for maximum layout fidelity. Hosted deployments use LibreOffice compiled to WebAssembly through ZetaJS, so real pagination, tables, headers, footers, and images are converted to PDF without uploading the document. The browser downloads and caches the Office engine on the first DOCX conversion. If that engine is unavailable, `docx-preview` remains as a compatibility fallback and refuses to create a PDF when its page count differs from Word's stored page count.

The visible version next to the app title comes from `package.json`. The same version is also exposed as `document.documentElement.dataset.appVersion` and `window.__SFX_PDF_FILL_SIGN_VERSION__` so local and deployed builds can be compared directly.

## Local development

```sh
npm install
npm start
```

Then open the local URL printed by Vite.

## Checks

```sh
npm run check
```

The production build is written to `dist/`.

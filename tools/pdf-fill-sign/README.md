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

During local development on macOS, DOCX conversion uses Microsoft Word when available for maximum layout fidelity. In a hosted deployment, the app falls back to `docx-preview` and renders each declared Word page to PDF entirely in the browser. Typical text, tables, headers, footers, and images retain their page layout, though SmartArt, unavailable custom fonts, and other Office-only features can differ from Microsoft Word.

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

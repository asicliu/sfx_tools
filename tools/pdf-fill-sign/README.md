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

DOCX conversion uses Microsoft Word on macOS to preserve the original pagination, page size, margins, headers, footers, tables, and positioned content. The app does not silently fall back to browser reflow; if the local Word converter is unavailable, it stops and asks for the layout-preserving local setup.

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

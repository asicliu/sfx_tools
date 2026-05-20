# sfx_tools

Small utilities and local productivity tools.

## Hub

Build the complete utilities hub from the repository root:

```sh
npm run build
```

The generated site is written to `dist/` with the hub at `/`, Markdown to PDF at `/markdown-to-pdf/`, and PDF Watermark at `/pdf-watermark-js/`.

## Tools

- [Markdown to PDF](tools/markdown-to-pdf) - client-side browser app for converting Markdown documents to PDF.
- [PDF Watermark JS](tools/pdf-watermark-js) - client-side browser app for adding text watermarks to PDF files.

## Cloudflare Workers Setup

- Project name: `tools`
- Root directory: leave blank or use repository root
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

## Cloudflare Pages Setup

- Framework preset: none
- Root directory: leave blank or use repository root
- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`

# PDF Watermark JS

Client-side browser app for adding text watermarks to PDF files. PDF processing happens in the browser with `pdf-lib`; there is no upload endpoint or server-side PDF processing.

The Cloudflare-hosted version supports PDF input. Word and PowerPoint conversion and owner-password PDF permissions were removed because those depended on local macOS and Node.js APIs.

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

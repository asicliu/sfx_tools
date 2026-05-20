# Markdown to PDF

Client-side browser app for converting Markdown documents to PDF. Markdown parsing, preview rendering, and PDF generation all happen in the browser; there is no upload endpoint.

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

This project includes `wrangler.jsonc` for Cloudflare Workers Static Assets.

Recommended setup:

- Project name: `markdown-to-pdf`
- Root directory: `tools/markdown-to-pdf`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

If Cloudflare does not show a root directory field and you configure it from the repository root, use:

```sh
cd tools/markdown-to-pdf && npm ci && npm run build
```

as the build command, and:

```sh
cd tools/markdown-to-pdf && npx wrangler deploy
```

as the deploy command.

## Cloudflare Pages Setup

If you choose Pages instead of Workers:

- Framework preset: none
- Root directory: `tools/markdown-to-pdf`
- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`

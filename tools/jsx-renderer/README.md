# JSX Renderer

Client-side browser app for rendering React JSX files and exporting them to HTML. The renderer supports files that import from `react` and export a default component, for example:

```jsx
import { useState } from "react";

export default function App() {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(!open)}>{open ? "Open" : "Closed"}</button>;
}
```

The app executes JSX in your browser, so only render files you trust.

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

This utility is included in the root hub build. From the repository root:

```sh
npm run build
npx wrangler deploy
```

It will be served at `/jsx-renderer/`.

## Standalone Cloudflare Setup

If you deploy only this utility:

- Project name: `jsx-renderer`
- Root directory: `tools/jsx-renderer`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

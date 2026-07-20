import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const tools = [
  {
    name: "JSX Renderer",
    slug: "jsx-renderer",
    cwd: path.join(root, "tools", "jsx-renderer"),
  },
  {
    name: "Markdown to PDF",
    slug: "markdown-to-pdf",
    cwd: path.join(root, "tools", "markdown-to-pdf"),
  },
  {
    name: "PDF Watermark",
    slug: "pdf-watermark-js",
    cwd: path.join(root, "tools", "pdf-watermark-js"),
  },
  {
    name: "PDF Fill & Sign",
    slug: "pdf-fill-sign",
    cwd: path.join(root, "tools", "pdf-fill-sign"),
  },
];

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

async function collectToolHeaderRules(slug) {
  const toolHeadersPath = path.join(dist, slug, "_headers");
  let text;
  try {
    text = await readFile(toolHeadersPath, "utf8");
  } catch {
    return [];
  }
  // Cloudflare only honors the root _headers file; the copy inside the tool
  // build would be served as a plain static asset, so fold it into the root.
  await rm(toolHeadersPath);

  const lines = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      lines.push(line);
    } else {
      lines.push(line === "/" ? `/${slug}/` : `/${slug}${line}`);
    }
  }
  return lines;
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, "hub"), dist, { recursive: true });

  const headerLines = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
  ];

  for (const tool of tools) {
    console.log(`\nBuilding ${tool.name}`);
    run("npm", ["ci", "--ignore-scripts", "--audit=false", "--fund=false"], tool.cwd);
    run("npm", ["run", "build", "--", `--base=/${tool.slug}/`], tool.cwd);
    await cp(path.join(tool.cwd, "dist"), path.join(dist, tool.slug), { recursive: true });

    const toolRules = await collectToolHeaderRules(tool.slug);
    if (toolRules.length) headerLines.push("", ...toolRules);
  }

  await writeFile(path.join(dist, "_headers"), headerLines.join("\n") + "\n");

  console.log("\nHub built at dist/");
}

await build();

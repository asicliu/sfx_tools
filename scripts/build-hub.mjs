import { cp, mkdir, rm, writeFile } from "node:fs/promises";
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
];

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, "hub"), dist, { recursive: true });

  for (const tool of tools) {
    console.log(`\nBuilding ${tool.name}`);
    run("npm", ["ci", "--ignore-scripts", "--audit=false", "--fund=false"], tool.cwd);
    run("npm", ["run", "build", "--", `--base=/${tool.slug}/`], tool.cwd);
    await cp(path.join(tool.cwd, "dist"), path.join(dist, tool.slug), { recursive: true });
  }

  await writeFile(
    path.join(dist, "_headers"),
    [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      "",
    ].join("\n"),
  );

  console.log("\nHub built at dist/");
}

await build();

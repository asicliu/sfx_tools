import * as Babel from "@babel/standalone";

export function createRequire(modules) {
  return function requireModule(name) {
    if (name === "react") return modules.react;
    if (name === "react-dom") return modules.reactDom;
    if (name === "react-dom/client") return modules.reactDomClient;
    throw new Error(`Unsupported import: ${name}`);
  };
}

export function transformJsx(source) {
  return Babel.transform(source, {
    filename: "input.jsx",
    sourceType: "module",
    presets: [
      ["typescript", { isTSX: true, allExtensions: true }],
      ["react", { runtime: "classic" }],
    ],
    plugins: ["transform-modules-commonjs"],
  }).code;
}

export function evaluateJsx(source, modules) {
  const code = transformJsx(source);
  const module = { exports: {} };
  const exports = module.exports;
  const run = new Function(
    "exports",
    "module",
    "require",
    "React",
    `${code}\nreturn module.exports.default || exports.default || module.exports;`,
  );
  const component = run(exports, module, createRequire(modules), modules.react);

  if (typeof component !== "function" && !modules.react.isValidElement(component)) {
    throw new Error("JSX file must export a default React component or element.");
  }

  return component;
}

export function normalizeHtmlFilename(value) {
  const trimmed = (value || "rendered-jsx.html").trim();
  return trimmed.toLowerCase().endsWith(".html") ? trimmed : `${trimmed}.html`;
}

export function createExportHtml(source, options = {}) {
  const title = (options.title || "Rendered JSX").replace(/[<>&"]/g, (char) => {
    const map = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" };
    return map[char];
  });
  const sourceLiteral = JSON.stringify(source).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      html, body { margin: 0; min-height: 100%; background: #fff; }
      #root { min-height: 100vh; }
      #render-error { margin: 24px; padding: 16px; border: 1px solid #fecaca; border-radius: 8px; color: #991b1b; background: #fff1f2; font: 14px/1.5 system-ui, sans-serif; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <pre id="render-error" hidden></pre>
    <script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script>
      const source = ${sourceLiteral};
      const errorBox = document.getElementById("render-error");
      function require(name) {
        if (name === "react") return React;
        if (name === "react-dom") return ReactDOM;
        if (name === "react-dom/client") return ReactDOM;
        throw new Error("Unsupported import: " + name);
      }
      try {
        const module = { exports: {} };
        const exports = module.exports;
        const code = Babel.transform(source, {
          filename: "input.jsx",
          sourceType: "module",
          presets: [
            ["typescript", { isTSX: true, allExtensions: true }],
            ["react", { runtime: "classic" }]
          ],
          plugins: ["transform-modules-commonjs"]
        }).code;
        const component = new Function("exports", "module", "require", "React", code + "\\nreturn module.exports.default || exports.default || module.exports;")(exports, module, require, React);
        const root = ReactDOM.createRoot(document.getElementById("root"));
        root.render(React.isValidElement(component) ? component : React.createElement(component));
      } catch (error) {
        errorBox.hidden = false;
        errorBox.textContent = error && error.stack ? error.stack : String(error);
      }
    </script>
  </body>
</html>
`;
}

import React from "react";
import { evaluateJsx, createExportHtml } from "../src/transform.js";

const source = `import { useState } from "react";

export default function SmokeComponent() {
  const [open] = useState(true);
  return <main>{open ? "Ready" : "Closed"}</main>;
}`;

const component = evaluateJsx(source, { react: React, reactDomClient: {} });
const html = createExportHtml(source, { title: "Smoke Test" });

if (typeof component !== "function") {
  throw new Error("JSX smoke test did not return a component.");
}

if (!html.includes("Smoke Test") || !html.includes("ReactDOM.createRoot")) {
  throw new Error("JSX export HTML smoke test failed.");
}

console.log(`Smoke test passed: ${html.length} bytes`);

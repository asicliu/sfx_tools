import { decodeScreenshot } from './screenshot-reader.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ texts: decodeScreenshot(data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};

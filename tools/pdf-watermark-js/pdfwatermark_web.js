#!/usr/bin/env node
"use strict";

/*
 * pdfwatermark_web.js — Cross-platform PDF Watermark tool
 *
 * A local web-based GUI for adding text watermarks to PDF files.
 * Uses pdf-lib for PDF manipulation. Works on macOS, Linux, and Windows.
 *
 * Usage:
 *   node pdfwatermark_web.js
 *
 * Dependencies (pdf-lib) are auto-installed on first run.
 */

const http = require("http");
const { execSync, exec } = require("child_process");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const zlib = require("zlib");

// ── Auto-install pdf-lib if needed ────────────────────────────

function ensureDeps() {
  try {
    require.resolve("pdf-lib");
  } catch {
    console.log("Installing pdf-lib (one-time setup)…");
    execSync("npm install --no-save pdf-lib", {
      cwd: __dirname,
      stdio: "inherit",
    });
  }
}

ensureDeps();

const { PDFDocument, rgb, degrees, StandardFonts } = require("pdf-lib");

// ── PDF Encryption (Pure JS, 128-bit RC4, revision 3) ────────

const PDF_PADDING = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
  0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

function padPassword(pw) {
  const buf = Buffer.alloc(32);
  const src = Buffer.from(pw || "", "utf-8");
  src.copy(buf, 0, 0, Math.min(src.length, 32));
  PDF_PADDING.copy(buf, Math.min(src.length, 32), 0, 32 - Math.min(src.length, 32));
  return buf;
}

function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  let x = 0; j = 0;
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) & 255;
    j = (j + S[x]) & 255;
    [S[x], S[j]] = [S[j], S[x]];
    out[i] = data[i] ^ S[(S[x] + S[j]) & 255];
  }
  return Buffer.from(out);
}

function md5(data) {
  return crypto.createHash("md5").update(data).digest();
}

function computePermissions(allowPrint, allowCopy, allowAnnotate) {
  let p = 0xFFFFF0C0;
  if (allowPrint) p |= 4;
  if (allowCopy) p |= 16;
  if (allowAnnotate) p |= 32;
  return p | 0;
}

function computeOwnerEntry(ownerPw, userPw) {
  let hash = md5(padPassword(ownerPw));
  for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, 16);
  let result = Buffer.from(padPassword(userPw));
  result = rc4(key, result);
  for (let i = 1; i <= 19; i++) {
    const modKey = Buffer.alloc(key.length);
    for (let j = 0; j < key.length; j++) modKey[j] = key[j] ^ i;
    result = rc4(modKey, result);
  }
  return result;
}

function computeFileEncryptionKey(userPw, ownerEntry, permissions, fileId) {
  const permBuf = Buffer.alloc(4);
  permBuf.writeInt32LE(permissions);
  const input = Buffer.concat([padPassword(userPw), ownerEntry, permBuf, fileId]);
  let hash = md5(input);
  for (let i = 0; i < 50; i++) hash = md5(hash);
  return hash.subarray(0, 16);
}

function computeUserEntry(encKey, fileId) {
  const hash = md5(Buffer.concat([PDF_PADDING, fileId]));
  let result = rc4(encKey, hash);
  for (let i = 1; i <= 19; i++) {
    const modKey = Buffer.alloc(encKey.length);
    for (let j = 0; j < encKey.length; j++) modKey[j] = encKey[j] ^ i;
    result = rc4(modKey, result);
  }
  const padded = Buffer.alloc(32);
  result.copy(padded);
  return padded;
}

// ── PDF Parser ───────────────────────────────────────────────

function parsePdf(buf) {
  const src = buf.toString("binary");
  const objects = new Map();
  let trailerDict = null;

  // 1. Find startxref to locate the cross-reference
  const startxrefMatch = src.match(/startxref\s+(\d+)/);
  if (!startxrefMatch) throw new Error("No startxref found");
  const xrefOffset = parseInt(startxrefMatch[1]);

  // 2. Determine if it's a traditional xref table or an xref stream
  const objectOffsets = []; // [{num, gen, offset}]

  if (src.substring(xrefOffset, xrefOffset + 4) === "xref") {
    // Traditional xref table
    const trailerIdx = src.indexOf("trailer", xrefOffset);
    const xrefBody = src.substring(xrefOffset + 4, trailerIdx).trim();
    const lines = xrefBody.split(/[\r\n]+/);
    let currentFirst = 0;
    for (const line of lines) {
      const subsec = line.match(/^(\d+)\s+(\d+)\s*$/);
      if (subsec) { currentFirst = parseInt(subsec[1]); continue; }
      const entry = line.match(/^(\d{10})\s+(\d{5})\s+([nf])/);
      if (entry && entry[3] === "n") {
        objectOffsets.push({ num: currentFirst, gen: parseInt(entry[2]), offset: parseInt(entry[1]) });
      }
      currentFirst++;
    }
    // Parse trailer dict
    const tStart = src.indexOf("<<", trailerIdx);
    const tEnd = findMatchingClose(src, tStart);
    if (tStart >= 0 && tEnd >= 0) trailerDict = src.substring(tStart, tEnd + 2);
  } else {
    // Cross-reference stream — the xref is itself an object
    const xrefObjMatch = src.substring(xrefOffset).match(/^(\d+)\s+(\d+)\s+obj/);
    if (!xrefObjMatch) throw new Error("Invalid xref stream");

    // Parse this object to get the xref stream
    const xrefObj = parseObjectAt(buf, src, xrefOffset);
    if (!xrefObj || !xrefObj.stream) throw new Error("Cannot read xref stream");

    trailerDict = xrefObj.dict;

    // Decompress stream
    let streamData;
    if (xrefObj.dict.includes("/FlateDecode")) {
      streamData = zlib.inflateSync(xrefObj.stream);
    } else {
      streamData = xrefObj.stream;
    }

    // Parse /W array (field widths) and /Size
    const wMatch = xrefObj.dict.match(/\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    const sizeMatch = xrefObj.dict.match(/\/Size\s+(\d+)/);
    if (!wMatch || !sizeMatch) throw new Error("Invalid xref stream format");
    const w1 = parseInt(wMatch[1]), w2 = parseInt(wMatch[2]), w3 = parseInt(wMatch[3]);
    const entrySize = w1 + w2 + w3;
    const totalSize = parseInt(sizeMatch[1]);

    // Parse /Index array (optional, defaults to [0 Size])
    let indexPairs = [[0, totalSize]];
    const indexMatch = xrefObj.dict.match(/\/Index\s*\[([\d\s]+)\]/);
    if (indexMatch) {
      const nums = indexMatch[1].trim().split(/\s+/).map(Number);
      indexPairs = [];
      for (let i = 0; i < nums.length; i += 2) indexPairs.push([nums[i], nums[i + 1]]);
    }

    // Decode entries
    let pos = 0;
    for (const [firstObj, count] of indexPairs) {
      for (let i = 0; i < count; i++) {
        if (pos + entrySize > streamData.length) break;
        let type = 1; // default if w1 === 0
        if (w1 > 0) { type = readInt(streamData, pos, w1); }
        const field2 = readInt(streamData, pos + w1, w2);
        const field3 = readInt(streamData, pos + w1 + w2, w3);
        pos += entrySize;

        const objNum = firstObj + i;
        if (type === 1) {
          // Uncompressed object at byte offset field2
          objectOffsets.push({ num: objNum, gen: field3, offset: field2 });
        }
        // type 2 = compressed in ObjStm (handled by decompressObjectStreams)
        // type 0 = free entry (skip)
      }
    }
  }

  // 3. Parse each object at its known offset
  for (const { num, gen, offset } of objectOffsets) {
    if (offset === 0) continue; // skip null entries
    const obj = parseObjectAt(buf, src, offset);
    if (obj) {
      objects.set(`${num} ${gen}`, { num, gen, dict: obj.dict, stream: obj.stream });
    }
  }

  return { objects, trailerDict };
}

function readInt(buf, offset, width) {
  let val = 0;
  for (let i = 0; i < width; i++) val = (val << 8) | buf[offset + i];
  return val;
}

function parseObjectAt(buf, src, offset) {
  // Parse a single indirect object at the given byte offset
  const header = src.substring(offset, offset + 40).match(/^(\d+)\s+(\d+)\s+obj\b/);
  if (!header) return null;

  const bodyStart = offset + header[0].length;

  // Find stream keyword or endobj, being careful about binary content
  // First, check if there's a stream by looking for the dict end >> followed by stream
  let dictEnd = -1;
  let streamData = null;

  // Scan for the dict/stream boundary
  const bodyStr = src.substring(bodyStart);
  const streamMatch = bodyStr.match(/^([\s\S]*?)>>\s*\bstream\s*[\r\n]/);

  if (streamMatch) {
    // Has a stream
    const dictPart = (streamMatch[1] + ">>").trim();
    const streamStart = bodyStart + streamMatch[0].length;

    // Determine stream length from /Length in the dict
    const lengthMatch = dictPart.match(/\/Length\s+(\d+)/);
    let endStream;
    if (lengthMatch) {
      const streamLen = parseInt(lengthMatch[1]);
      endStream = streamStart + streamLen;
    } else {
      // Fallback: search for endstream
      endStream = src.indexOf("endstream", streamStart);
    }

    if (endStream >= 0) {
      streamData = buf.subarray(streamStart, endStream);
      // Trim trailing CR/LF
      while (streamData.length > 0 && (streamData[streamData.length - 1] === 0x0A || streamData[streamData.length - 1] === 0x0D)) {
        streamData = streamData.subarray(0, streamData.length - 1);
      }
    }
    return { dict: dictPart, stream: streamData };
  }

  // No stream — find endobj
  const endIdx = src.indexOf("endobj", bodyStart);
  if (endIdx < 0) return null;
  const body = src.substring(bodyStart, endIdx).trim();
  return { dict: body, stream: null };
}

function findMatchingClose(str, start) {
  if (start < 0 || str[start] !== "<" || str[start + 1] !== "<") return -1;
  let depth = 0;
  for (let i = start; i < str.length - 1; i++) {
    if (str[i] === "<" && str[i + 1] === "<") { depth++; i++; }
    else if (str[i] === ">" && str[i + 1] === ">") { depth--; i++; if (depth === 0) return i; }
  }
  return -1;
}

function decompressObjectStreams(objects) {
  const toRemove = [];
  for (const [key, obj] of objects) {
    if (!obj.dict.includes("/Type /ObjStm") && !obj.dict.includes("/Type/ObjStm")) continue;
    if (!obj.stream) continue;
    toRemove.push(key);

    let data;
    if (obj.dict.includes("/Filter /FlateDecode") || obj.dict.includes("/Filter/FlateDecode")) {
      try { data = zlib.inflateSync(obj.stream); } catch { continue; }
    } else {
      data = obj.stream;
    }

    const nMatch = obj.dict.match(/\/N\s+(\d+)/);
    const firstMatch = obj.dict.match(/\/First\s+(\d+)/);
    if (!nMatch || !firstMatch) continue;

    const n = parseInt(nMatch[1]);
    const first = parseInt(firstMatch[1]);
    const dataStr = data.toString("binary");

    const header = dataStr.substring(0, first).trim().split(/\s+/);
    for (let i = 0; i < n; i++) {
      const objNum = parseInt(header[i * 2]);
      const offset = parseInt(header[i * 2 + 1]);
      const nextOffset = (i + 1 < n) ? parseInt(header[(i + 1) * 2 + 1]) : dataStr.length - first;
      const objBody = dataStr.substring(first + offset, first + nextOffset).trim();
      objects.set(`${objNum} 0`, { num: objNum, gen: 0, dict: objBody, stream: null });
    }
  }

  for (const key of toRemove) objects.delete(key);

  // Remove xref stream objects — we re-serialize with traditional xref table
  const xrefKeys = [];
  for (const [key, obj] of objects) {
    if (obj.dict.includes("/Type /XRef") || obj.dict.includes("/Type/XRef")) {
      xrefKeys.push(key);
    }
  }
  for (const key of xrefKeys) objects.delete(key);
}

// ── PDF Serializer ───────────────────────────────────────────

function encryptString(data, encKey, objNum, objGen) {
  const ext = Buffer.alloc(5);
  ext[0] = objNum & 0xFF; ext[1] = (objNum >> 8) & 0xFF; ext[2] = (objNum >> 16) & 0xFF;
  ext[3] = objGen & 0xFF; ext[4] = (objGen >> 8) & 0xFF;
  const objKey = md5(Buffer.concat([encKey, ext])).subarray(0, Math.min(16, encKey.length + 5));
  return rc4(objKey, data);
}

function encryptObjectBody(body, encKey, objNum, objGen) {
  let result = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "(") {
      const strBytes = extractStringLiteral(body, i);
      if (strBytes !== null) {
        const encrypted = encryptString(strBytes.data, encKey, objNum, objGen);
        result += "<" + Buffer.from(encrypted).toString("hex") + ">";
        i = strBytes.endIdx;
        continue;
      }
    }
    if (body[i] === "<" && body[i + 1] !== "<") {
      const end = body.indexOf(">", i + 1);
      if (end >= 0) {
        const hexStr = body.substring(i + 1, end).replace(/\s/g, "");
        if (hexStr.length > 0 && /^[0-9a-fA-F]+$/.test(hexStr)) {
          const data = Buffer.from(hexStr.length % 2 ? hexStr + "0" : hexStr, "hex");
          const encrypted = encryptString(data, encKey, objNum, objGen);
          result += "<" + Buffer.from(encrypted).toString("hex") + ">";
          i = end + 1;
          continue;
        }
      }
    }
    result += body[i];
    i++;
  }
  return result;
}

function extractStringLiteral(str, start) {
  if (str[start] !== "(") return null;
  let depth = 1;
  const bytes = [];
  let i = start + 1;
  while (i < str.length) {
    if (str[i] === "\\") {
      i++;
      if (i >= str.length) break;
      if (str[i] === "n") bytes.push(0x0A);
      else if (str[i] === "r") bytes.push(0x0D);
      else if (str[i] === "t") bytes.push(0x09);
      else if (str[i] === "b") bytes.push(0x08);
      else if (str[i] === "f") bytes.push(0x0C);
      else if (str[i] === "(") bytes.push(0x28);
      else if (str[i] === ")") bytes.push(0x29);
      else if (str[i] === "\\") bytes.push(0x5C);
      else if (/[0-7]/.test(str[i])) {
        let oct = str[i];
        if (i + 1 < str.length && /[0-7]/.test(str[i + 1])) { oct += str[++i]; }
        if (i + 1 < str.length && /[0-7]/.test(str[i + 1])) { oct += str[++i]; }
        bytes.push(parseInt(oct, 8) & 0xFF);
      }
      else bytes.push(str.charCodeAt(i));
    } else if (str[i] === "(") {
      depth++;
      bytes.push(0x28);
    } else if (str[i] === ")") {
      depth--;
      if (depth === 0) return { data: Buffer.from(bytes), endIdx: i + 1 };
      bytes.push(0x29);
    } else {
      bytes.push(str.charCodeAt(i));
    }
    i++;
  }
  return null;
}

function serializeEncryptedPdf(objects, trailerDict, encKey, encryptObjNum, fileId, permissions, ownerEntry, userEntry) {
  const parts = [];
  const offsets = new Map();

  parts.push(Buffer.from("%PDF-1.6\n%\xE2\xE3\xCF\xD3\n"));

  const sortedKeys = [...objects.keys()].sort((a, b) => {
    const [aN] = a.split(" ").map(Number);
    const [bN] = b.split(" ").map(Number);
    return aN - bN;
  });

  let currentOffset = parts[0].length;

  for (const key of sortedKeys) {
    const obj = objects.get(key);
    offsets.set(key, currentOffset);

    const isEncryptDict = obj.num === encryptObjNum;
    let objBuf;

    if (isEncryptDict) {
      const encDict = `<< /Type /Encrypt /Filter /Standard /V 2 /R 3 /Length 128 /O <${ownerEntry.toString("hex")}> /U <${userEntry.toString("hex")}> /P ${permissions} >>`;
      objBuf = Buffer.from(`${obj.num} ${obj.gen} obj\n${encDict}\nendobj\n`);
    } else if (obj.stream) {
      const encStream = encryptString(obj.stream, encKey, obj.num, obj.gen);
      const encDict = encryptObjectBody(obj.dict, encKey, obj.num, obj.gen);
      let finalDict = encDict.replace(/\/Length\s+\d+/, `/Length ${encStream.length}`);
      objBuf = Buffer.from(`${obj.num} ${obj.gen} obj\n${finalDict}\nstream\n`, "binary");
      objBuf = Buffer.concat([objBuf, encStream, Buffer.from("\nendstream\nendobj\n")]);
    } else {
      const encBody = encryptObjectBody(obj.dict, encKey, obj.num, obj.gen);
      objBuf = Buffer.from(`${obj.num} ${obj.gen} obj\n${encBody}\nendobj\n`, "binary");
    }

    parts.push(objBuf);
    currentOffset += objBuf.length;
  }

  const xrefOffset = currentOffset;
  let maxObjNum = encryptObjNum;
  for (const o of objects.values()) if (o.num > maxObjNum) maxObjNum = o.num;
  maxObjNum += 1;

  const xrefLines = [`xref\n0 ${maxObjNum}\n`];
  xrefLines.push("0000000000 65535 f \n");
  for (let i = 1; i < maxObjNum; i++) {
    const key0 = `${i} 0`;
    if (offsets.has(key0)) {
      xrefLines.push(String(offsets.get(key0)).padStart(10, "0") + " 00000 n \n");
    } else {
      xrefLines.push("0000000000 00000 f \n");
    }
  }
  const xrefBuf = Buffer.from(xrefLines.join(""));
  parts.push(xrefBuf);
  currentOffset += xrefBuf.length;

  const sizeMatch = trailerDict.match(/\/Size\s+(\d+)/);
  const rootMatch = trailerDict.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  const infoMatch = trailerDict.match(/\/Info\s+(\d+\s+\d+\s+R)/);

  const size = Math.max(parseInt(sizeMatch ? sizeMatch[1] : "0"), maxObjNum);
  const root = rootMatch ? rootMatch[1] : "";
  const info = infoMatch ? `/Info ${infoMatch[1]}` : "";
  const idHex = fileId.toString("hex");

  let trailer = `trailer\n<< /Size ${size} /Root ${root} ${info} /Encrypt ${encryptObjNum} 0 R /ID [<${idHex}><${idHex}>] >>\n`;
  trailer += `startxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(trailer));

  return Buffer.concat(parts);
}

function encryptPDF(pdfBuffer, ownerPassword, permissions, fileId) {
  try {
    const { objects, trailerDict } = parsePdf(pdfBuffer);
    if (!trailerDict) throw new Error("No trailer found");

    decompressObjectStreams(objects);

    const ownerEntry = computeOwnerEntry(ownerPassword, "");
    const encKey = computeFileEncryptionKey("", ownerEntry, permissions, fileId);
    const userEntry = computeUserEntry(encKey, fileId);

    let maxObj = 0;
    for (const o of objects.values()) if (o.num > maxObj) maxObj = o.num;
    const encryptObjNum = maxObj + 1;
    objects.set(`${encryptObjNum} 0`, {
      num: encryptObjNum, gen: 0, dict: "", stream: null,
    });

    return serializeEncryptedPdf(
      objects, trailerDict, encKey, encryptObjNum,
      fileId, permissions, ownerEntry, userEntry
    );
  } catch (err) {
    console.error("Encryption failed:", err.message, err.stack);
    return null;
  }
}

// ── Office-to-PDF conversion (macOS AppleScript) ─────────────

const OFFICE_EXTENSIONS = new Set([".ppt", ".pptx", ".doc", ".docx"]);

function getOfficeExt(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return OFFICE_EXTENSIONS.has(ext) ? ext : null;
}

function convertToPdf(inputBuf, filename) {
  // Save to temp file, convert via Office 365, read result
  const ext = path.extname(filename).toLowerCase();
  const tmpDir = os.tmpdir();
  const baseName = `wm_convert_${Date.now()}`;
  const tmpInput = path.join(tmpDir, baseName + ext);
  const tmpOutput = path.join(tmpDir, baseName + ".pdf");

  require("fs").writeFileSync(tmpInput, inputBuf);

  try {
    let script;
    if (ext === ".ppt" || ext === ".pptx") {
      script = `
        tell application "Microsoft PowerPoint"
          open POSIX file "${tmpInput}"
          delay 1
          save active presentation in POSIX file "${tmpOutput}" as save as PDF
          close active presentation saving no
        end tell`;
    } else {
      // .doc / .docx
      script = `
        tell application "Microsoft Word"
          open POSIX file "${tmpInput}"
          delay 1
          set theDoc to active document
          save as theDoc file name POSIX file "${tmpOutput}" file format format PDF
          close theDoc saving no
        end tell`;
    }

    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 60000,
      stdio: "pipe",
    });

    if (!require("fs").existsSync(tmpOutput)) {
      throw new Error("Conversion produced no output");
    }

    const pdfBuf = require("fs").readFileSync(tmpOutput);
    return pdfBuf;
  } finally {
    // Cleanup temp files
    try { require("fs").unlinkSync(tmpInput); } catch {}
    try { require("fs").unlinkSync(tmpOutput); } catch {}
  }
}

// ── PDF watermark logic ───────────────────────────────────────

function drawCenteredText(page, text, font, opts) {
  const textWidth = font.widthOfTextAtSize(text, opts.fontSize);
  const rad = (opts.rotation * Math.PI) / 180;
  // Offset so the text is centred at (x, y) after rotation
  const dx = -(textWidth / 2) * Math.cos(rad);
  const dy = -(textWidth / 2) * Math.sin(rad);

  page.drawText(text, {
    x: opts.x + dx,
    y: opts.y + dy,
    font,
    size: opts.fontSize,
    color: opts.color,
    opacity: opts.opacity,
    rotate: degrees(opts.rotation),
  });
}

async function applyWatermark(pdfBuffer, opts) {
  const pdfDoc = await PDFDocument.load(pdfBuffer, {
    ignoreEncryption: true,
  });
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const color = rgb(opts.colorR, opts.colorG, opts.colorB);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();

    if (opts.repeat) {
      const spX = opts.spacingX > 0 ? opts.spacingX : 250;
      const spY = opts.spacingY > 0 ? opts.spacingY : spX;

      for (let x = -width; x < width * 2; x += spX) {
        for (let y = -height; y < height * 2; y += spY) {
          drawCenteredText(page, opts.text, font, {
            x,
            y,
            fontSize: opts.fontSize,
            color,
            opacity: opts.opacity,
            rotation: opts.rotation,
          });
        }
      }
    } else {
      drawCenteredText(page, opts.text, font, {
        x: width / 2,
        y: height / 2,
        fontSize: opts.fontSize,
        color,
        opacity: opts.opacity,
        rotation: opts.rotation,
      });
    }
  }

  return pdfDoc.save();
}

// ── HTML template ─────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF Watermark</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#f5f5f7;color:#1d1d1f;
  min-height:100vh;display:flex;justify-content:center;align-items:flex-start;
  padding:40px 20px;
}
.container{
  display:flex;max-width:900px;width:100%;
  background:#fff;border-radius:16px;
  box-shadow:0 4px 24px rgba(0,0,0,.08);
  overflow:hidden;align-self:flex-start;
}
.controls{
  flex:0 0 440px;padding:36px 32px;overflow-y:auto;
}
.preview-panel{
  flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;background:#e8e8ed;border-left:1px solid #d2d2d7;
  padding:32px 24px;gap:12px;
}
@media(max-width:700px){
  .container{flex-direction:column}
  .controls{flex:none;width:100%}
  .preview-panel{border-left:none;border-top:1px solid #d2d2d7;flex:none}
}
h1{font-size:22px;font-weight:600;text-align:center;margin-bottom:6px}
.subtitle{text-align:center;color:#86868b;font-size:13px;margin-bottom:28px}
label{display:block;font-size:13px;font-weight:500;color:#6e6e73;margin-bottom:4px;margin-top:16px}
label:first-of-type{margin-top:0}
input[type=text],input[type=number],input[type=password]{
  width:100%;padding:9px 12px;border:1px solid #d2d2d7;border-radius:8px;
  font-size:14px;outline:none;transition:border .15s;
}
input:focus{border-color:#0071e3}
.file-drop{
  border:2px dashed #d2d2d7;border-radius:12px;padding:32px 16px;
  text-align:center;cursor:pointer;transition:all .2s;position:relative;
  background:#fafafa;
}
.file-drop.over{border-color:#0071e3;background:#f0f5ff}
.file-drop.has-file{border-style:solid;border-color:#34c759;background:#f0faf2}
.file-drop p{font-size:14px;color:#86868b;pointer-events:none}
.file-drop .name{font-size:14px;color:#1d1d1f;font-weight:500}
.file-drop input{position:absolute;inset:0;opacity:0;cursor:pointer}
.row{display:flex;gap:10px}
.row>div{flex:1}
.section{
  margin-top:20px;padding:14px 16px;border:1px solid #e8e8ed;
  border-radius:10px;
}
.section-title{font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px}
.checks{display:flex;gap:16px;flex-wrap:wrap}
.checks label{
  display:flex;align-items:center;gap:6px;cursor:pointer;
  font-size:14px;color:#1d1d1f;font-weight:400;margin:0;
}
.checks input[type=checkbox]{width:16px;height:16px;accent-color:#0071e3}
.color-row{display:flex;align-items:center;gap:10px;margin-top:4px}
input[type=color]{
  width:40px;height:40px;padding:2px;border:1px solid #d2d2d7;
  border-radius:8px;cursor:pointer;background:none;
}
#color-hex{font-size:13px;color:#1d1d1f;font-family:monospace}
button[type=submit]{
  display:block;width:100%;margin-top:28px;padding:12px;
  background:#0071e3;color:#fff;border:none;border-radius:10px;
  font-size:15px;font-weight:600;cursor:pointer;transition:background .15s;
}
button[type=submit]:hover{background:#0077ed}
button[type=submit]:active{background:#006edb}
button[type=submit]:disabled{background:#a1c6f1;cursor:default}
.toast{
  position:fixed;top:24px;left:50%;transform:translateX(-50%);
  padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;
  box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:99;
  opacity:0;transition:opacity .3s;pointer-events:none;
}
.toast.show{opacity:1}
.toast.ok{background:#34c759;color:#fff}
.toast.err{background:#ff3b30;color:#fff}
.toast.warn{background:#ff9500;color:#fff}
.spinner{display:none;width:18px;height:18px;border:2.5px solid rgba(255,255,255,.4);
  border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;
  vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.note{font-size:11px;color:#86868b;margin-top:4px}
#preview{background:#fff;border-radius:4px;box-shadow:0 2px 16px rgba(0,0,0,.12)}
.preview-label{font-size:12px;color:#86868b;text-align:center}
</style>
</head>
<body>
<div class="container">
  <div class="controls">
    <h1>PDF Watermark</h1>
    <p class="subtitle">Add text watermark &amp; encrypt &mdash; cross-platform</p>

    <form id="wm-form" autocomplete="off">

      <label>File</label>
      <div class="file-drop" id="drop-zone">
        <input type="file" id="pdf-file" accept=".pdf,.ppt,.pptx,.doc,.docx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
        <p id="drop-label">Drop a PDF, PowerPoint, or Word file here</p>
      </div>

      <label for="wm-text">Watermark text</label>
      <input type="text" id="wm-text" value="CONFIDENTIAL" required>

      <label for="owner-pw">Owner password <span style="color:#86868b;font-weight:400">(optional &mdash; enables encryption)</span></label>
      <input type="password" id="owner-pw" placeholder="Leave blank for none">

      <div class="row">
        <div>
          <label for="font-size">Font size</label>
          <input type="number" id="font-size" value="36" min="6" max="200">
        </div>
        <div>
          <label for="opacity">Opacity (0&ndash;1)</label>
          <input type="number" id="opacity" value="0.2" min="0" max="1" step="0.05">
        </div>
        <div>
          <label for="rotation">Rotation&deg;</label>
          <input type="number" id="rotation" value="45" min="-180" max="180">
        </div>
      </div>

      <label>Color</label>
      <div class="color-row">
        <input type="color" id="wm-color" value="#333333">
        <span id="color-hex">#333333</span>
      </div>

      <div class="section">
        <div class="section-title">Permissions</div>
        <div class="checks">
          <label><input type="checkbox" id="perm-print"> Print</label>
          <label><input type="checkbox" id="perm-copy"> Copy</label>
          <label><input type="checkbox" id="perm-annot"> Annotate / Forms</label>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Tiling</div>
        <div class="checks" style="margin-bottom:10px">
          <label><input type="checkbox" id="tile" checked> Repeat across page</label>
        </div>
        <div class="row" id="tile-opts">
          <div><label for="sp-x">H spacing (pt)</label><input type="number" id="sp-x" value="250" min="10"></div>
          <div><label for="sp-y">V spacing (pt)</label><input type="number" id="sp-y" value="200" min="10"></div>
        </div>
      </div>

      <button type="submit" id="btn">
        <span class="spinner" id="spinner"></span>
        <span id="btn-text">Add Watermark</span>
      </button>
    </form>
  </div>

  <div class="preview-panel">
    <canvas id="preview" width="340" height="440"></canvas>
    <p class="preview-label">Live preview &mdash; updates as you type</p>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const $ = s => document.querySelector(s);
const dropZone = $('#drop-zone');
const fileInput = $('#pdf-file');
const dropLabel = $('#drop-label');

let pdfFile = null;

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setPDF(fileInput.files[0]);
});
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) {
    const ext = f.name.toLowerCase().split('.').pop();
    if (['pdf','ppt','pptx','doc','docx'].includes(ext)) setPDF(f);
  }
});

function setPDF(f) {
  pdfFile = f;
  const ext = f.name.toLowerCase().split('.').pop();
  const isPdf = ext === 'pdf';
  const typeLabel = isPdf ? '' : ' <span style="color:#0071e3;font-size:11px">(will convert to PDF)</span>';
  dropLabel.innerHTML = '<span class="name">' + f.name + '</span>' + typeLabel +
    '<br><span style="color:#86868b;font-size:12px">' +
    (f.size / 1024 / 1024).toFixed(1) + ' MB</span>';
  dropZone.classList.add('has-file');
}

function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 4000);
}

$('#tile').addEventListener('change', () => {
  $('#tile-opts').style.opacity = $('#tile').checked ? '1' : '.4';
});

// Heartbeat — lets the server know the page is still open
setInterval(() => fetch('/ping').catch(() => {}), 3000);

$('#wm-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!pdfFile) { toast('Please select a file.', 'err'); return; }

  const btn = $('#btn'), spinner = $('#spinner'), btnText = $('#btn-text');
  const fileExt = pdfFile.name.toLowerCase().split('.').pop();
  const isOffice = ['ppt','pptx','doc','docx'].includes(fileExt);
  btn.disabled = true; spinner.style.display = 'inline-block';
  btnText.textContent = isOffice ? 'Converting & watermarking\u2026' : 'Processing\u2026';

  try {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(pdfFile);
    });

    const hexColor = $('#wm-color').value || '#333333';
    const payload = {
      file_b64: b64,
      filename: pdfFile.name,
      text: $('#wm-text').value,
      owner_password: $('#owner-pw').value,
      font_size: parseInt($('#font-size').value) || 36,
      opacity: parseFloat($('#opacity').value) || 0.2,
      rotation: parseFloat($('#rotation').value) || 45,
      color_r: parseInt(hexColor.slice(1, 3), 16) / 255,
      color_g: parseInt(hexColor.slice(3, 5), 16) / 255,
      color_b: parseInt(hexColor.slice(5, 7), 16) / 255,
      allow_print: $('#perm-print').checked,
      allow_copy: $('#perm-copy').checked,
      allow_annotate: $('#perm-annot').checked,
      repeat: $('#tile').checked,
      spacing_x: parseFloat($('#sp-x').value) || 250,
      spacing_y: parseFloat($('#sp-y').value) || 200,
    };

    const resp = await fetch('/watermark', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({error: 'Server error'}));
      throw new Error(err.error || 'Unknown error');
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const outName = pdfFile.name.replace(/\.(pdf|pptx?|docx?)$/i, '') + '_watermarked.pdf';
    a.href = url; a.download = outName; a.click();
    URL.revokeObjectURL(url);

    const encWarning = resp.headers.get('X-Encryption-Warning');
    if (encWarning) {
      toast('Watermark applied, but encryption failed.', 'warn');
    } else if (payload.owner_password) {
      toast('Watermarked & encrypted PDF downloaded!', 'ok');
    } else {
      toast('Watermarked PDF downloaded!', 'ok');
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false; spinner.style.display = 'none'; btnText.textContent = 'Add Watermark';
  }
});

// ── Live Preview ─────────────────────────────────────────────
const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');

function updatePreview() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  const text = $('#wm-text').value || 'CONFIDENTIAL';
  const fontSize = Math.max(6, (parseInt($('#font-size').value) || 36) * (W / 612));
  const opacity = parseFloat($('#opacity').value) || 0.2;
  const rotation = (parseFloat($('#rotation').value) || 45) * Math.PI / 180;
  const color = $('#wm-color').value || '#333333';
  const repeat = $('#tile').checked;
  const spX = (parseFloat($('#sp-x').value) || 250) * (W / 612);
  const spY = (parseFloat($('#sp-y').value) || 200) * (H / 792);

  ctx.font = fontSize + 'px Helvetica, Arial, sans-serif';
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (repeat) {
    for (let x = -W; x < W * 2; x += spX) {
      for (let y = -H; y < H * 2; y += spY) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-rotation); // negative: canvas Y is inverted vs PDF coords
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
  } else {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-rotation);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

['wm-text', 'font-size', 'opacity', 'rotation', 'wm-color', 'sp-x', 'sp-y'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updatePreview);
});
$('#tile').addEventListener('change', updatePreview);

$('#wm-color').addEventListener('input', () => {
  const hex = $('#wm-color').value;
  const span = $('#color-hex');
  if (span) span.textContent = hex;
});

updatePreview();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────

function jsonError(res, code, msg) {
  if (!res.headersSent) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Unhandled server error:", err);
      jsonError(res, 500, err.message || "Internal server error");
    });
  });
}

async function handleRequest(req, res) {
  if (req.method === "GET" && req.url === "/ping") {
    lastPing = Date.now();
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    lastPing = Date.now();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === "POST" && req.url === "/watermark") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      jsonError(res, 400, "Invalid JSON");
      return;
    }

    const text = (data.text || "").trim();
    if (!text) {
      jsonError(res, 400, "Watermark text is required.");
      return;
    }

    let pdfBytes = Buffer.from(data.file_b64, "base64");
    const officeExt = getOfficeExt(data.filename);
    if (officeExt) {
      try {
        pdfBytes = convertToPdf(pdfBytes, data.filename);
      } catch (err) {
        const app = (officeExt === ".ppt" || officeExt === ".pptx")
          ? "Microsoft PowerPoint" : "Microsoft Word";
        jsonError(res, 400, `${app} is required to convert ${officeExt} files. Please install it or convert to PDF manually.`);
        return;
      }
    }
    const result = await applyWatermark(pdfBytes, {
      text,
      fontSize: parseInt(data.font_size) || 36,
      opacity: parseFloat(data.opacity) || 0.2,
      rotation: parseFloat(data.rotation) || 45,
      colorR: parseFloat(data.color_r) || 0.2,
      colorG: parseFloat(data.color_g) || 0.2,
      colorB: parseFloat(data.color_b) || 0.2,
      repeat: data.repeat !== false,
      spacingX: parseFloat(data.spacing_x) || 250,
      spacingY: parseFloat(data.spacing_y) || 200,
    });

    let outBuf = Buffer.from(result);
    let encryptionWarning = false;

    // Apply encryption if owner password is set
    const ownerPw = (data.owner_password || "").trim();
    if (ownerPw) {
      const fileId = crypto.randomBytes(16);
      const permissions = computePermissions(
        data.allow_print === true,
        data.allow_copy === true,
        data.allow_annotate === true
      );
      const encrypted = encryptPDF(outBuf, ownerPw, permissions, fileId);
      if (encrypted) {
        outBuf = encrypted;
      } else {
        encryptionWarning = true;
      }
    }

    const filename =
      (data.filename || "output").replace(/\.(pdf|pptx?|docx?)$/i, "") +
      "_watermarked.pdf";

    const headers = {
      "Content-Type": "application/pdf",
      "Content-Length": outBuf.length,
      "Content-Disposition": `attachment; filename="${filename}"`,
    };
    if (encryptionWarning) {
      headers["X-Encryption-Warning"] = "Encryption failed; PDF is unencrypted.";
    }

    res.writeHead(200, headers);
    res.end(outBuf);
    return;
  }

  jsonError(res, 404, "Not found");
}

// ── Cross-platform browser open ───────────────────────────────

function openBrowser(url) {
  const plat = os.platform();
  const cmd =
    plat === "darwin"
      ? "open"
      : plat === "win32"
        ? "start"
        : "xdg-open"; // Linux / FreeBSD
  exec(`${cmd} "${url}"`);
}

// ── Find a free port ──────────────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ── Main ──────────────────────────────────────────────────────

// Prevent the process from crashing on stray errors
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

let lastPing = Date.now();

async function main() {
  const port = await findFreePort();
  const server = createServer();
  const url = `http://127.0.0.1:${port}`;

  server.listen(port, "127.0.0.1", () => {
    console.log(`PDF Watermark GUI running at ${url}`);
    console.log("Press Ctrl-C to quit.\n");
    setTimeout(() => openBrowser(url), 300);
  });

  // Auto-quit when browser page is closed (no ping for 10s)
  setInterval(() => {
    if (Date.now() - lastPing > 10000) {
      console.log("\nBrowser page closed — shutting down.");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    }
  }, 5000);

  const shutdown = () => {
    console.log("\nShutting down…");
    server.close(() => process.exit(0));
    // Force exit after 2s if connections linger
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();

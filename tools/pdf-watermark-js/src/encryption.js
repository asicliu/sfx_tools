import { Buffer } from "buffer";
import { inflate } from "pako";
import SparkMD5 from "spark-md5";

const PDF_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function exactArrayBuffer(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function md5(data) {
  return Buffer.from(SparkMD5.ArrayBuffer.hash(exactArrayBuffer(toBuffer(data))), "hex");
}

function padPassword(password) {
  const buf = Buffer.alloc(32);
  const src = Buffer.from(password || "", "utf-8");
  src.copy(buf, 0, 0, Math.min(src.length, 32));
  PDF_PADDING.copy(buf, Math.min(src.length, 32), 0, 32 - Math.min(src.length, 32));
  return buf;
}

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }

  const out = new Uint8Array(data.length);
  let x = 0;
  j = 0;

  for (let i = 0; i < data.length; i += 1) {
    x = (x + 1) & 255;
    j = (j + s[x]) & 255;
    [s[x], s[j]] = [s[j], s[x]];
    out[i] = data[i] ^ s[(s[x] + s[j]) & 255];
  }

  return Buffer.from(out);
}

export function generatePermissionPassword(length = 18) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function computePermissions({ allowPrint = false, allowCopy = false, allowAnnotate = false } = {}) {
  let permissions = 0xfffff0c0;
  if (allowPrint) permissions |= 4;
  if (allowCopy) permissions |= 16;
  if (allowAnnotate) permissions |= 32;
  return permissions | 0;
}

function computeOwnerEntry(ownerPassword, userPassword) {
  let hash = md5(padPassword(ownerPassword));
  for (let i = 0; i < 50; i += 1) hash = md5(hash);

  const key = hash.subarray(0, 16);
  let result = Buffer.from(padPassword(userPassword));
  result = rc4(key, result);

  for (let i = 1; i <= 19; i += 1) {
    const modKey = Buffer.alloc(key.length);
    for (let j = 0; j < key.length; j += 1) modKey[j] = key[j] ^ i;
    result = rc4(modKey, result);
  }

  return result;
}

function computeFileEncryptionKey(userPassword, ownerEntry, permissions, fileId) {
  const permBuf = Buffer.alloc(4);
  permBuf.writeInt32LE(permissions);
  const input = Buffer.concat([padPassword(userPassword), ownerEntry, permBuf, fileId]);
  let hash = md5(input);
  for (let i = 0; i < 50; i += 1) hash = md5(hash);
  return hash.subarray(0, 16);
}

function computeUserEntry(encKey, fileId) {
  const hash = md5(Buffer.concat([PDF_PADDING, fileId]));
  let result = rc4(encKey, hash);

  for (let i = 1; i <= 19; i += 1) {
    const modKey = Buffer.alloc(encKey.length);
    for (let j = 0; j < encKey.length; j += 1) modKey[j] = encKey[j] ^ i;
    result = rc4(modKey, result);
  }

  const padded = Buffer.alloc(32);
  result.copy(padded);
  return padded;
}

function readInt(buf, offset, width) {
  let val = 0;
  for (let i = 0; i < width; i += 1) val = (val << 8) | buf[offset + i];
  return val;
}

function findMatchingClose(str, start) {
  if (start < 0 || str[start] !== "<" || str[start + 1] !== "<") return -1;

  let depth = 0;
  for (let i = start; i < str.length - 1; i += 1) {
    if (str[i] === "<" && str[i + 1] === "<") {
      depth += 1;
      i += 1;
    } else if (str[i] === ">" && str[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseObjectAt(buf, src, offset) {
  const header = src.substring(offset, offset + 40).match(/^(\d+)\s+(\d+)\s+obj\b/);
  if (!header) return null;

  const bodyStart = offset + header[0].length;
  const bodyStr = src.substring(bodyStart);
  const streamMatch = bodyStr.match(/^([\s\S]*?)>>\s*\bstream\s*[\r\n]/);

  if (streamMatch) {
    const dictPart = `${streamMatch[1]}>>`.trim();
    const streamStart = bodyStart + streamMatch[0].length;
    const lengthMatch = dictPart.match(/\/Length\s+(\d+)/);
    let endStream;

    if (lengthMatch) {
      endStream = streamStart + Number.parseInt(lengthMatch[1], 10);
    } else {
      endStream = src.indexOf("endstream", streamStart);
    }

    if (endStream < 0) return { dict: dictPart, stream: null };

    let streamData = buf.subarray(streamStart, endStream);
    while (
      streamData.length > 0 &&
      (streamData[streamData.length - 1] === 0x0a || streamData[streamData.length - 1] === 0x0d)
    ) {
      streamData = streamData.subarray(0, streamData.length - 1);
    }

    return { dict: dictPart, stream: streamData };
  }

  const endIdx = src.indexOf("endobj", bodyStart);
  if (endIdx < 0) return null;
  return { dict: src.substring(bodyStart, endIdx).trim(), stream: null };
}

function parsePdf(pdfBytes) {
  const buf = toBuffer(pdfBytes);
  const src = buf.toString("binary");
  const objects = new Map();
  let trailerDict = null;

  const startxrefMatch = src.match(/startxref\s+(\d+)/);
  if (!startxrefMatch) throw new Error("No startxref found");
  const xrefOffset = Number.parseInt(startxrefMatch[1], 10);
  const objectOffsets = [];

  if (src.substring(xrefOffset, xrefOffset + 4) === "xref") {
    const trailerIdx = src.indexOf("trailer", xrefOffset);
    const xrefBody = src.substring(xrefOffset + 4, trailerIdx).trim();
    const lines = xrefBody.split(/[\r\n]+/);
    let currentFirst = 0;

    for (const line of lines) {
      const subsec = line.match(/^(\d+)\s+(\d+)\s*$/);
      if (subsec) {
        currentFirst = Number.parseInt(subsec[1], 10);
        continue;
      }
      const entry = line.match(/^(\d{10})\s+(\d{5})\s+([nf])/);
      if (entry && entry[3] === "n") {
        objectOffsets.push({
          num: currentFirst,
          gen: Number.parseInt(entry[2], 10),
          offset: Number.parseInt(entry[1], 10),
        });
      }
      currentFirst += 1;
    }

    const tStart = src.indexOf("<<", trailerIdx);
    const tEnd = findMatchingClose(src, tStart);
    if (tStart >= 0 && tEnd >= 0) trailerDict = src.substring(tStart, tEnd + 2);
  } else {
    const xrefObjMatch = src.substring(xrefOffset).match(/^(\d+)\s+(\d+)\s+obj/);
    if (!xrefObjMatch) throw new Error("Invalid xref stream");

    const xrefObj = parseObjectAt(buf, src, xrefOffset);
    if (!xrefObj?.stream) throw new Error("Cannot read xref stream");

    trailerDict = xrefObj.dict;
    const streamData = xrefObj.dict.includes("/FlateDecode")
      ? Buffer.from(inflate(xrefObj.stream))
      : xrefObj.stream;

    const wMatch = xrefObj.dict.match(/\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    const sizeMatch = xrefObj.dict.match(/\/Size\s+(\d+)/);
    if (!wMatch || !sizeMatch) throw new Error("Invalid xref stream format");

    const w1 = Number.parseInt(wMatch[1], 10);
    const w2 = Number.parseInt(wMatch[2], 10);
    const w3 = Number.parseInt(wMatch[3], 10);
    const entrySize = w1 + w2 + w3;
    const totalSize = Number.parseInt(sizeMatch[1], 10);
    let indexPairs = [[0, totalSize]];
    const indexMatch = xrefObj.dict.match(/\/Index\s*\[([\d\s]+)\]/);

    if (indexMatch) {
      const nums = indexMatch[1].trim().split(/\s+/).map(Number);
      indexPairs = [];
      for (let i = 0; i < nums.length; i += 2) indexPairs.push([nums[i], nums[i + 1]]);
    }

    let pos = 0;
    for (const [firstObj, count] of indexPairs) {
      for (let i = 0; i < count; i += 1) {
        if (pos + entrySize > streamData.length) break;
        let type = 1;
        if (w1 > 0) type = readInt(streamData, pos, w1);
        const field2 = readInt(streamData, pos + w1, w2);
        const field3 = readInt(streamData, pos + w1 + w2, w3);
        pos += entrySize;

        if (type === 1) objectOffsets.push({ num: firstObj + i, gen: field3, offset: field2 });
      }
    }
  }

  for (const { num, gen, offset } of objectOffsets) {
    if (offset === 0) continue;
    const obj = parseObjectAt(buf, src, offset);
    if (obj) objects.set(`${num} ${gen}`, { num, gen, dict: obj.dict, stream: obj.stream });
  }

  return { objects, trailerDict };
}

function decompressObjectStreams(objects) {
  const toRemove = [];

  for (const [key, obj] of objects) {
    if (!obj.dict.includes("/Type /ObjStm") && !obj.dict.includes("/Type/ObjStm")) continue;
    if (!obj.stream) continue;
    toRemove.push(key);

    let data;
    if (obj.dict.includes("/Filter /FlateDecode") || obj.dict.includes("/Filter/FlateDecode")) {
      try {
        data = Buffer.from(inflate(obj.stream));
      } catch {
        continue;
      }
    } else {
      data = obj.stream;
    }

    const nMatch = obj.dict.match(/\/N\s+(\d+)/);
    const firstMatch = obj.dict.match(/\/First\s+(\d+)/);
    if (!nMatch || !firstMatch) continue;

    const n = Number.parseInt(nMatch[1], 10);
    const first = Number.parseInt(firstMatch[1], 10);
    const dataStr = data.toString("binary");
    const header = dataStr.substring(0, first).trim().split(/\s+/);

    for (let i = 0; i < n; i += 1) {
      const objNum = Number.parseInt(header[i * 2], 10);
      const offset = Number.parseInt(header[i * 2 + 1], 10);
      const nextOffset = i + 1 < n ? Number.parseInt(header[(i + 1) * 2 + 1], 10) : dataStr.length - first;
      const objBody = dataStr.substring(first + offset, first + nextOffset).trim();
      objects.set(`${objNum} 0`, { num: objNum, gen: 0, dict: objBody, stream: null });
    }
  }

  for (const key of toRemove) objects.delete(key);

  for (const [key, obj] of objects) {
    if (obj.dict.includes("/Type /XRef") || obj.dict.includes("/Type/XRef")) objects.delete(key);
  }
}

function encryptString(data, encKey, objNum, objGen) {
  const ext = Buffer.alloc(5);
  ext[0] = objNum & 0xff;
  ext[1] = (objNum >> 8) & 0xff;
  ext[2] = (objNum >> 16) & 0xff;
  ext[3] = objGen & 0xff;
  ext[4] = (objGen >> 8) & 0xff;
  const objKey = md5(Buffer.concat([encKey, ext])).subarray(0, Math.min(16, encKey.length + 5));
  return rc4(objKey, data);
}

function extractStringLiteral(str, start) {
  if (str[start] !== "(") return null;
  let depth = 1;
  const bytes = [];
  let i = start + 1;

  while (i < str.length) {
    if (str[i] === "\\") {
      i += 1;
      if (i >= str.length) break;
      if (str[i] === "n") bytes.push(0x0a);
      else if (str[i] === "r") bytes.push(0x0d);
      else if (str[i] === "t") bytes.push(0x09);
      else if (str[i] === "b") bytes.push(0x08);
      else if (str[i] === "f") bytes.push(0x0c);
      else if (str[i] === "(") bytes.push(0x28);
      else if (str[i] === ")") bytes.push(0x29);
      else if (str[i] === "\\") bytes.push(0x5c);
      else if (/[0-7]/.test(str[i])) {
        let oct = str[i];
        if (i + 1 < str.length && /[0-7]/.test(str[i + 1])) oct += str[++i];
        if (i + 1 < str.length && /[0-7]/.test(str[i + 1])) oct += str[++i];
        bytes.push(Number.parseInt(oct, 8) & 0xff);
      } else {
        bytes.push(str.charCodeAt(i));
      }
    } else if (str[i] === "(") {
      depth += 1;
      bytes.push(0x28);
    } else if (str[i] === ")") {
      depth -= 1;
      if (depth === 0) return { data: Buffer.from(bytes), endIdx: i + 1 };
      bytes.push(0x29);
    } else {
      bytes.push(str.charCodeAt(i));
    }
    i += 1;
  }

  return null;
}

function encryptObjectBody(body, encKey, objNum, objGen) {
  let result = "";
  let i = 0;

  while (i < body.length) {
    if (body[i] === "(") {
      const strBytes = extractStringLiteral(body, i);
      if (strBytes !== null) {
        const encrypted = encryptString(strBytes.data, encKey, objNum, objGen);
        result += `<${Buffer.from(encrypted).toString("hex")}>`;
        i = strBytes.endIdx;
        continue;
      }
    }

    if (body[i] === "<" && body[i + 1] !== "<") {
      const end = body.indexOf(">", i + 1);
      if (end >= 0) {
        const hexStr = body.substring(i + 1, end).replace(/\s/g, "");
        if (hexStr.length > 0 && /^[0-9a-fA-F]+$/.test(hexStr)) {
          const data = Buffer.from(hexStr.length % 2 ? `${hexStr}0` : hexStr, "hex");
          const encrypted = encryptString(data, encKey, objNum, objGen);
          result += `<${Buffer.from(encrypted).toString("hex")}>`;
          i = end + 1;
          continue;
        }
      }
    }

    result += body[i];
    i += 1;
  }

  return result;
}

function randomFileId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(bytes);
}

function serializeEncryptedPdf(objects, trailerDict, encKey, encryptObjNum, fileId, permissions, ownerEntry, userEntry) {
  const parts = [];
  const offsets = new Map();

  parts.push(Buffer.from("%PDF-1.6\n%\xe2\xe3\xcf\xd3\n", "binary"));
  let currentOffset = parts[0].length;

  const sortedKeys = [...objects.keys()].sort((a, b) => {
    const [aN] = a.split(" ").map(Number);
    const [bN] = b.split(" ").map(Number);
    return aN - bN;
  });

  for (const key of sortedKeys) {
    const obj = objects.get(key);
    offsets.set(key, currentOffset);

    let objBuf;
    if (obj.num === encryptObjNum) {
      const encDict = `<< /Type /Encrypt /Filter /Standard /V 2 /R 3 /Length 128 /O <${ownerEntry.toString("hex")}> /U <${userEntry.toString("hex")}> /P ${permissions} >>`;
      objBuf = Buffer.from(`${obj.num} ${obj.gen} obj\n${encDict}\nendobj\n`);
    } else if (obj.stream) {
      const encStream = encryptString(obj.stream, encKey, obj.num, obj.gen);
      const encDict = encryptObjectBody(obj.dict, encKey, obj.num, obj.gen);
      const finalDict = encDict.replace(/\/Length\s+\d+/, `/Length ${encStream.length}`);
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
  for (const obj of objects.values()) if (obj.num > maxObjNum) maxObjNum = obj.num;
  maxObjNum += 1;

  const xrefLines = [`xref\n0 ${maxObjNum}\n`, "0000000000 65535 f \n"];
  for (let i = 1; i < maxObjNum; i += 1) {
    const key0 = `${i} 0`;
    xrefLines.push(
      offsets.has(key0)
        ? `${String(offsets.get(key0)).padStart(10, "0")} 00000 n \n`
        : "0000000000 00000 f \n",
    );
  }

  const xrefBuf = Buffer.from(xrefLines.join(""));
  parts.push(xrefBuf);

  const rootMatch = trailerDict.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  const infoMatch = trailerDict.match(/\/Info\s+(\d+\s+\d+\s+R)/);
  const root = rootMatch ? rootMatch[1] : "";
  const info = infoMatch ? `/Info ${infoMatch[1]}` : "";
  const idHex = fileId.toString("hex");

  const trailer = [
    `trailer\n<< /Size ${maxObjNum} /Root ${root} ${info} /Encrypt ${encryptObjNum} 0 R /ID [<${idHex}><${idHex}>] >>`,
    `startxref\n${xrefOffset}`,
    "%%EOF\n",
  ].join("\n");
  parts.push(Buffer.from(trailer));

  return Buffer.concat(parts);
}

export function encryptPdfPermissions(pdfBytes, options = {}) {
  const ownerPassword = options.ownerPassword || generatePermissionPassword();
  const userPassword = options.userPassword || "";
  const permissions = computePermissions(options);
  const fileId = options.fileId ? toBuffer(options.fileId) : randomFileId();

  const { objects, trailerDict } = parsePdf(pdfBytes);
  if (!trailerDict) throw new Error("No PDF trailer found.");

  decompressObjectStreams(objects);

  const ownerEntry = computeOwnerEntry(ownerPassword, userPassword);
  const encKey = computeFileEncryptionKey(userPassword, ownerEntry, permissions, fileId);
  const userEntry = computeUserEntry(encKey, fileId);

  let maxObj = 0;
  for (const obj of objects.values()) if (obj.num > maxObj) maxObj = obj.num;
  const encryptObjNum = maxObj + 1;
  objects.set(`${encryptObjNum} 0`, { num: encryptObjNum, gen: 0, dict: "", stream: null });

  return serializeEncryptedPdf(
    objects,
    trailerDict,
    encKey,
    encryptObjNum,
    fileId,
    permissions,
    ownerEntry,
    userEntry,
  );
}

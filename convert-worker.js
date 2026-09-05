'use strict';

const { parentPort, workerData } = require('worker_threads');
const zlib = require('zlib');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');
const readExcelFile = require('read-excel-file/node');
const AdmZip = require('adm-zip');

// CONVERT_MAX_BYTES, passed in by convertService so the archive caps move
// with the configured upload/convert ceiling instead of a hardcoded constant.
const CONFIGURED_MAX_BYTES =
  Number(workerData && workerData.maxBytes) > 0 ? Number(workerData.maxBytes) : 104857600;

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MB
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function conversionInputError(message) {
  const err = new Error(message);
  err.code = 'CONVERSION_INPUT_ERROR';
  return err;
}

function decodeText(buffer) {
  return TEXT_DECODER.decode(Buffer.from(buffer));
}

// ── MIME / content sniffing ─────────────────────────────────────────────────

/**
 * Detect file type from magic bytes, then fall back to extension.
 * Returns { ext: '.pdf', mime: 'application/pdf' }
 */
function detectFileType(buffer, originalName, mimeType) {
  const buf = Buffer.from(buffer);
  const ext = (originalName && originalName.match(/\.([^.]+)$/) || [])[1] || '';
  const extL = ext.toLowerCase();

  // Magic-byte detection
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2D) {
    return { ext: '.pdf', mime: 'application/pdf' };
  }
  // ZIP container — inspect internal structure
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return detectZipType(buf, extL);
  }
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buf.length >= 6 &&
      (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return { ext: '.gif', mime: 'image/gif' };
  }

  // Fall back to extension (normalise aliases)
  const extMap = {
    txt: '.txt', text: '.txt', log: '.log',
    csv: '.csv', html: '.html', htm: '.html',
    json: '.json', xml: '.xml', yaml: '.yaml', yml: '.yml',
    pdf: '.pdf', docx: '.docx', xlsx: '.xlsx', pptx: '.pptx',
    jpg: '.jpg', jpeg: '.jpg', png: '.png', gif: '.gif',
  };
  const mapped = extMap[extL];
  if (mapped) return { ext: mapped, mime: mimeType || `application/octet-stream` };

  return { ext: `.${extL}`, mime: mimeType || 'application/octet-stream' };
}

function detectZipType(buf, fallbackExt) {
  try {
    const zip = new AdmZip(buf);
    const entries = new Set(zip.getEntries().map(e => e.entryName));
    if (entries.has('word/document.xml'))  return { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    if (entries.has('xl/workbook.xml'))     return { ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (entries.has('ppt/presentation.xml')) return { ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    // Unknown ZIP — fall back to extension hint
    if (['docx', 'xlsx', 'pptx'].includes(fallbackExt)) return { ext: `.${fallbackExt}`, mime: 'application/octet-stream' };
    return { ext: '.zip', mime: 'application/zip' };
  } catch {
    return { ext: '.zip', mime: 'application/zip' };
  }
}

// ── EXIF / image metadata ───────────────────────────────────────────────────

function readU16(buf, offset, le) { return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset); }
function readU32(buf, offset, le) { return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset); }

function readIfdValue(buf, offset, le, type, count, valueOffset) {
  const SIZES = { 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 10:8 };
  const sz = (SIZES[type] || 1) * count;
  if (sz <= 4) {
    if (type === 2) {
      return buf.toString('ascii', valueOffset, valueOffset + count).replace(/\0+$/, '');
    }
    if (type === 3) return readU16(buf, valueOffset, le);
    if (type === 4 || type === 9) return readU32(buf, valueOffset, le);
  }
  if (type === 2) {
    return buf.toString('ascii', valueOffset, valueOffset + Math.min(count, 256)).replace(/\0+$/, '');
  }
  if (type === 5 && count === 1) {
    const num = readU32(buf, valueOffset, le);
    const den = readU32(buf, valueOffset + 4, le);
    return den ? num / den : 0;
  }
  if (type === 10 && count === 1) {
    const num = le ? buf.readInt32LE(valueOffset) : buf.readInt32BE(valueOffset);
    const den = le ? buf.readInt32LE(valueOffset + 4) : buf.readInt32BE(valueOffset + 4);
    return den ? num / den : 0;
  }
  return undefined;
}

function parseIfd(buf, tiffStart, ifdOffset, le, result, depth) {
  if (depth > 3) return; // guard against circular/malicious IFD chains
  if (ifdOffset + 2 > buf.length) return;
  const count = readU16(buf, tiffStart + ifdOffset, le);
  if (count > 500) return; // safety guard
  for (let i = 0; i < count; i++) {
    const entryOff = tiffStart + ifdOffset + 2 + i * 12;
    if (entryOff + 12 > buf.length) break;
    const tag   = readU16(buf, entryOff, le);
    const type  = readU16(buf, entryOff + 2, le);
    const cnt   = readU32(buf, entryOff + 4, le);
    const vOff  = entryOff + 8;
    if (tag === 0x8769 || tag === 0x8825) {
      const subOff = readU32(buf, vOff, le);
      if (subOff < buf.length) {
        parseIfd(buf, tiffStart, subOff, le, result, depth + 1);
      }
    } else {
      const val = readIfdValue(buf, tiffStart, le, type, cnt, vOff);
      if (val !== undefined) result[tag] = val;
    }
  }
}

function extractJpegExif(buf) {
  if (buf.length < 12 || buf[0] !== 0xFF || buf[1] !== 0xD8) return {};
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xFF) break;
    const marker = buf[off + 1];
    if (marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) break;
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2) break; // malformed segment — stop parsing
    if (marker === 0xE1 && segLen > 10) {
      const hdr = buf.toString('ascii', off + 4, off + 10);
      if (hdr === 'Exif\0\0') {
        const tiffStart = off + 10;
        const bo = buf.toString('ascii', tiffStart, tiffStart + 2);
        const le = bo === 'II';
        const ifd0Off = readU32(buf, tiffStart + 4, le);
        const result = {};
        parseIfd(buf, tiffStart, ifd0Off, le, result, 0);
        // GPS: convert rational lat/lon → decimal degrees
        const rl = result[0x0002], rlo = result[0x0004];
        const ns = result[0x0001], ew = result[0x0003];
        if (Array.isArray(rl) && rl.length === 3 && Array.isArray(rlo) && rlo.length === 3) {
          const lat = rl[0] + rl[1]/60 + rl[2]/3600;
          const lon = rlo[0] + rlo[1]/60 + rlo[2]/3600;
          result.latitude  = (ns === 'S' ? -lat : lat).toFixed(6);
          result.longitude = (ew === 'W' ? -lon : lon).toFixed(6);
        }
        return {
          ...(result[0x010E] ? { description: result[0x010E] } : {}),
          ...(result[0x0131] ? { software: result[0x0131] } : {}),
          ...(result[0x013B] ? { artist: result[0x013B] } : {}),
          ...(result[0x9003] ? { createDate: result[0x9003] } : {}),
          ...(result[0x829A] ? { exposureTime: String(result[0x829A]) } : {}),
          ...(result[0x8827] ? { iso: result[0x8827] } : {}),
          ...(result.latitude  ? { latitude: result.latitude, longitude: result.longitude } : {}),
        };
      }
    }
    off += 2 + segLen;
  }
  return {};
}

function extractPngText(buf) {
  const result = {};
  let off = 8; // skip PNG signature
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) break; // bounds check for malformed PNG
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'tEXt' && len > 0) {
      const data = buf.slice(off + 8, off + 8 + len);
      const sep = data.indexOf(0);
      if (sep > 0) {
        const key = data.toString('utf8', 0, sep);
        const val = data.toString('utf8', sep + 1);
        if (key === 'Author')       result.artist = val;
        if (key === 'Description')  result.description = val;
        if (key === 'Creation Time') result.createDate = val;
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return result;
}

// ── Output helpers ──────────────────────────────────────────────────────────

function ensureOutputSize(markdown) {
  if (!markdown || typeof markdown !== 'string' || markdown.trim().length === 0) {
    throw new Error('Conversion returned empty result');
  }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new Error('Converted output exceeds maximum size');
  }
  return markdown;
}

// ── HTML → Markdown (hardened) ──────────────────────────────────────────────

function htmlToMarkdown(html) {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndown.use(gfm);

  // Strip dangerous elements entirely (including their text content for script/style)
  turndown.remove([
    'script', 'style', 'iframe', 'noscript',
    'object', 'embed', 'applet', 'form',
  ]);

  // Checkbox input → [x] / [ ]
  turndown.addRule('checkbox', {
    filter: (node) => node.nodeName === 'INPUT' &&
      node.getAttribute('type') === 'checkbox',
    replacement: (_, node) =>
      node.getAttribute('checked') !== null ? '[x]' : '[ ]',
  });

  // Strip dangerous href/src protocols
  turndown.addRule('safeLink', {
    filter: 'a',
    replacement: (content, node) => {
      const href = (node.getAttribute('href') || '').trim().toLowerCase();
      if (href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('vbscript:')) {
        return content || '';
      }
      const origHref = node.getAttribute('href') || '';
      return content ? `[${content}](${origHref})` : '';
    },
  });

  turndown.addRule('safeImage', {
    filter: 'img',
    replacement: (_, node) => {
      const src = (node.getAttribute('src') || '').trim().toLowerCase();
      if (src.startsWith('javascript:') || src.startsWith('data:') || src.startsWith('vbscript:')) {
        return '';
      }
      const alt = node.getAttribute('alt') || '';
      const origSrc = node.getAttribute('src') || '';
      return `![${alt}](${origSrc})`;
    },
  });

  let md = turndown.turndown(html || '');

  // Post-processing normalize
  md = md.replace(/[ \t]+$/gm, '');              // trailing whitespace
  md = md.replace(/\n{3,}/g, '\n\n');             // max 2 consecutive blank lines
  // Regex safety net for any dangerous URIs that slipped through
  md = md.replace(/\]\s*\(\s*(javascript|vbscript|data)\s*:/gi, '](blocked:');
  return md;
}

// ── Table / CSV helpers ─────────────────────────────────────────────────────

function escapeTableCell(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();
}

function rowsToMarkdownTable(rows, { keepBlankRows = false } = {}) {
  const cleaned = rows.map(row => row.map(escapeTableCell));
  // Blank-row policy: the shared table builder drops fully-blank rows (XLSX /
  // PPTX export artifacts). CSV callers pass keepBlankRows instead — they trim
  // OUTER blank rows and KEEP interior ones as empty table rows (the
  // markitdown#2303 policy; a blank CSV line may be part of the data).
  if (!keepBlankRows) {
    for (let i = cleaned.length - 1; i >= 0; i--) {
      if (!cleaned[i].some(cell => cell.length > 0)) cleaned.splice(i, 1);
    }
  }
  if (cleaned.length === 0) return '';

  const width = Math.max(...cleaned.map(row => row.length));
  for (const row of cleaned) {
    while (row.length < width) row.push('');
  }

  const header = cleaned[0];
  const body = cleaned.slice(1);
  const separator = Array.from({ length: width }, () => '---');
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function fenced(language, content) {
  return `\`\`\`${language}\n${content.trim()}\n\`\`\``;
}

// Excel and other tools prepend a UTF-8 BOM to CSV exports; strip it so it
// does not end up inside the first header cell. (Synced from markitdown#2303.)
function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Remove blank rows from the beginning and end, and immediately after the
// header, in place. Interior blank rows are KEPT — they render as empty table
// rows and may be part of the data. Same policy as markitdown#2303. A row is
// blank when no cell is non-empty; parseCsv yields `['']`-shaped rows for
// blank input lines, Python csv.reader yields `[]` — both are blank here.
function trimOuterBlankRows(rows) {
  const isBlank = row => !row.some(cell => String(cell).length > 0);
  while (rows.length > 0 && isBlank(rows[0])) rows.shift();
  while (rows.length > 1 && isBlank(rows[1])) rows.splice(1, 1);
  while (rows.length > 0 && isBlank(rows[rows.length - 1])) rows.pop();
}

// ── OOXML / PPTX helpers ────────────────────────────────────────────────────

function extractTexts(xml) {
  const texts = [];
  const re = /<a:t>([^<]*)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (t) texts.push(t);
  }
  return texts;
}

function extractTable(tableXml) {
  const rows = [];
  const trRe = /<a:tr[^>]*>([\s\S]*?)<\/a:tr>/g;
  let tr;
  while ((tr = trRe.exec(tableXml)) !== null) {
    const cells = [];
    const tcRe = /<a:tc[^>]*>([\s\S]*?)<\/a:tc>/g;
    let tc;
    while ((tc = tcRe.exec(tr[1])) !== null) {
      cells.push(extractTexts(tc[1]).join(' '));
    }
    rows.push(cells);
  }
  return rowsToMarkdownTable(rows);
}

function isTitleShape(shapeXml) {
  return /<p:ph[^>]*\btype\s*=\s*"(ctrTitle|title)"/.test(shapeXml);
}

// ── Individual converters ───────────────────────────────────────────────────

async function convertPdf(buffer) {
  // pdf-parse v2 exposes a PDFParse class (v1's default-export function was
  // removed). Construct with { data }, call getText(), then release resources.
  const parser = new PDFParse({ data: new Uint8Array(Buffer.from(buffer)) });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ── Archive bomb guard ─────────────────────────────────────────────────────
//
// OOXML files (.docx/.xlsx/.pptx) are ZIP containers, and the parse libraries
// decompress entries straight into memory — read-excel-file does it inside a
// nested worker (worker-f) this process holds no handle on. That memory is
// ArrayBuffer-backed external memory, so `resourceLimits` does NOT bound it:
// an OOM here kills the whole container, not just the offending worker.
//
// The uncompressed sizes recorded in the central directory are
// attacker-controlled and can lie, so a single cheap pre-flight can never be
// sufficient on its own. Two layers:
//
//   1. Declared-size pre-flight — central-directory uncompressed sizes are
//      capped per-entry and in total, with a compression-ratio check. Cheap:
//      getEntries() parses only the central directory, no decompression.
//   2. Actual-decompression verification — every entry is inflated through a
//      streaming pipe whose cumulative output is capped; chunks are counted
//      and discarded, never materialized. A declaration that lies about its
//      sizes is caught the moment real output crosses the cap, so the
//      libraries' later, un-instrumented decompression can never exceed what
//      we already measured.
//
// The cap is CONVERT_MAX_BYTES (workerData.maxBytes). Cost: OOXML archives
// are decompressed once for verification and once for parsing — acceptable
// inside a worker thread with a 60s timeout.
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ENTRY_COMPRESSION_RATIO = 200;
const MAX_ENTRY_UNCOMPRESSED_BYTES = CONFIGURED_MAX_BYTES;
const MAX_TOTAL_UNCOMPRESSED_BYTES = CONFIGURED_MAX_BYTES;

// ZIP local file header: fixed part is 30 bytes; data begins after the
// variable-length filename + extra fields, whose lengths are recorded in the
// header itself. Hardcoded instead of deep-requiring adm-zip internals.
const LOCHDR = 30;
const LOCSIG = 0x04034b50; // "PK\003\004"
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function localDataStart(buf, offset) {
  if (offset < 0 || offset + LOCHDR > buf.length) return null;
  if (buf.readUInt32LE(offset) !== LOCSIG) return null;
  const fnameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  return offset + LOCHDR + fnameLen + extraLen;
}

/**
 * Stream-inflate raw deflate data and count the output, discarding chunks.
 * Resolves with the real decompressed byte count; rejects with a
 * CONVERSION_INPUT_ERROR the moment output crosses `cap` — nothing is
 * materialized, so memory stays bounded regardless of what the entry
 * declared.
 */
function inflateRawCount(raw, cap) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const inflate = zlib.createInflateRaw();
    inflate.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        settled = true;
        inflate.destroy();
        reject(
          conversionInputError(`archive entry decompresses beyond ${cap} bytes`)
        );
      }
    });
    inflate.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });
    inflate.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(conversionInputError(`corrupt archive data: ${err.message}`));
    });
    inflate.end(raw);
  });
}

async function assertSafeArchive(buffer, label) {
  let zip;
  try {
    zip = new AdmZip(Buffer.from(buffer));
  } catch {
    throw conversionInputError(`${label}: not a readable ZIP archive`);
  }
  const buf = Buffer.from(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw conversionInputError(`${label}: too many archive entries (${entries.length})`);
  }
  let total = 0;
  for (const e of entries) {
    const declared = Number(e.header && e.header.size) || 0;
    const compressed = Number(e.header && e.header.compressedSize) || 0;

    // Layer 1 — declared sizes (cheap, no decompression).
    if (declared > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw conversionInputError(`${label}: entry declares ${declared} uncompressed bytes`);
    }
    if (declared && compressed && declared / compressed > MAX_ENTRY_COMPRESSION_RATIO) {
      throw conversionInputError(`${label}: entry has an implausible compression ratio`);
    }
    if (e.header.encrypted) {
      throw conversionInputError(`${label}: encrypted archive entries are not supported`);
    }

    // Layer 2 — measure the real size; declarations can lie.
    if (!compressed) continue; // directory or empty entry
    const start = localDataStart(buf, Number(e.header.offset));
    if (start == null) {
      throw conversionInputError(`${label}: corrupt local file header`);
    }
    const raw = buf.subarray(start, start + compressed);
    const method = Number(e.header.method);
    let real;
    if (method === METHOD_STORED) {
      real = raw.length;
    } else if (method === METHOD_DEFLATE) {
      real = await inflateRawCount(raw, MAX_ENTRY_UNCOMPRESSED_BYTES);
    } else {
      throw conversionInputError(`${label}: unsupported compression method ${method}`);
    }
    total += real;
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw conversionInputError(
        `${label}: archive decompresses beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes in total`
      );
    }
  }
}

async function convertDocx(buffer) {
  await assertSafeArchive(buffer, 'DOCX');
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(buffer) });
  return htmlToMarkdown(result.value);
}

async function convertXlsx(buffer) {
  await assertSafeArchive(buffer, 'XLSX');
  const sheetsResult = await readExcelFile(Buffer.from(buffer), { sheet: 'all' });
  return sheetsResult
    .map(({ sheet, data }) => {
      const table = rowsToMarkdownTable(data || []);
      return table ? `## ${sheet}\n\n${table}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

async function convertPptx(buffer) {
  await assertSafeArchive(buffer, 'PPTX');
  const zip = new AdmZip(Buffer.from(buffer));
  const entries = zip.getEntries();

  // Collect and sort slide entries
  const slideEntries = entries
    .filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/i))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)\.xml$/i)?.[1] || '0', 10);
      const numB = parseInt(b.entryName.match(/slide(\d+)\.xml$/i)?.[1] || '0', 10);
      return numA - numB;
    });

  if (slideEntries.length === 0) {
    throw new Error('No slide content found in PPTX');
  }

  const slides = [];

  for (const entry of slideEntries) {
    const xml = zip.readAsText(entry);
    const slideNum = entry.entryName.match(/slide(\d+)\.xml$/i)?.[1] || '?';
    const slide = { num: slideNum, title: '', tables: [], texts: [] };

    // 1) Extract tables from <a:tbl>
    const tblRe = /<a:tbl>[\s\S]*?<\/a:tbl>/g;
    let tblM;
    while ((tblM = tblRe.exec(xml)) !== null) {
      const table = extractTable(tblM[0]);
      if (table) slide.tables.push(table);
    }

    // 2) Extract title from title/ctrTitle placeholder shape
    const spRe = /<p:sp[\s>][\s\S]*?<\/p:sp>/g;
    let spM;
    while ((spM = spRe.exec(xml)) !== null) {
      if (isTitleShape(spM[0])) {
        slide.title = extractTexts(spM[0]).join(' ');
        break;
      }
    }

    // 3) Extract body text (skip tables and title shapes to avoid duplication)
    const allTexts = [];
    const allSpRe = /<p:sp[\s>][\s\S]*?<\/p:sp>/g;
    let allSp;
    while ((allSp = allSpRe.exec(xml)) !== null) {
      if (isTitleShape(allSp[0])) continue;
      const t = extractTexts(allSp[0]);
      allTexts.push(...t);
    }
    // Deduplicate title text from body
    slide.texts = slide.title
      ? allTexts.filter(t => t !== slide.title)
      : allTexts;

    slides.push(slide);
  }

  // 4) Extract notes from notesSlide files
  for (const slide of slides) {
    const notesEntry = entries.find(
      e => e.entryName === `ppt/notesSlides/notesSlide${slide.num}.xml`
    );
    if (notesEntry) {
      const nxml = zip.readAsText(notesEntry);
      const texts = [];
      const spRe = /<p:sp[\s>][\s\S]*?<\/p:sp>/g;
      let sp;
      while ((sp = spRe.exec(nxml)) !== null) {
        // Skip "Slide N" placeholder that PPT auto-inserts
        if (/<p:ph[^>]*\btype\s*=\s*"sldImg"/.test(sp[0])) continue;
        const t = extractTexts(sp[0]);
        for (const txt of t) {
          if (txt && !/^\d+$/.test(txt.trim())) texts.push(txt);
        }
      }
      if (texts.length) slide.notes = texts;
    }
  }

  // 5) Assemble markdown
  const sections = [];
  for (const s of slides) {
    const parts = [];
    if (s.title) {
      parts.push(`## ${s.title}\n`);
    } else {
      parts.push(`<!-- Slide ${s.num} -->\n`);
    }
    for (const table of s.tables) {
      parts.push(table);
    }
    if (s.texts.length) {
      parts.push(s.texts.join('\n\n'));
    }
    if (s.notes) {
      parts.push(`> **Notes:**\n> ${s.notes.join('\n> ')}`);
    }
    if (parts.length > 0) sections.push(parts.join('\n\n'));
  }

  if (sections.length === 0) {
    throw new Error('No readable text found in PPTX');
  }

  return sections.join('\n\n---\n\n');
}

function extractImageDimensions(buf) {
  // PNG: width & height in IHDR chunk at offset 16 and 20 (big-endian 32-bit uint)
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: width & height at offset 6 and 8 (little-endian 16-bit uint)
  if (
    buf.length >= 10 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG: scan SOF markers (SOF0=0xC0, SOF1=0xC1, SOF2=0xC2, SOF3=0xC3)
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let off = 2;
    let found = false;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) break;
      const marker = buf[off + 1];
      if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) break;
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3 && off + 9 <= buf.length) {
        return {
          type: 'jpg',
          height: buf.readUInt16BE(off + 5),
          width: buf.readUInt16BE(off + 7),
        };
      }
      off += 2 + len;
    }
    if (!found) {
      throw new Error('Invalid or truncated JPEG image');
    }
  }

  return { type: 'image', width: '?', height: '?' };
}

async function convertImage(buffer, originalName) {
  const buf = Buffer.from(buffer);
  const dims = extractImageDimensions(buf);

  const lines = [
    `# ${originalName || 'image'}`,
    '',
    `- **MIME**: ${dims.type || 'image'}`,
    `- **Dimensions**: ${dims.width || '?'} x ${dims.height || '?'}`,
  ];

  // EXIF metadata (JPEG) or tEXt chunks (PNG)
  let meta = {};
  try {
    if (dims.type === 'jpg' || dims.type === 'jpeg') {
      meta = extractJpegExif(buf);
    } else if (dims.type === 'png') {
      meta = extractPngText(buf);
    }
  } catch { /* EXIF is best-effort */ }

  if (meta.createDate)   lines.push(`- **Created**: ${meta.createDate}`);
  if (meta.artist)       lines.push(`- **Artist**: ${meta.artist}`);
  if (meta.description)  lines.push(`- **Description**: ${meta.description}`);
  if (meta.software)     lines.push(`- **Software**: ${meta.software}`);
  if (meta.iso)          lines.push(`- **ISO**: ${meta.iso}`);
  if (meta.exposureTime) lines.push(`- **Exposure**: ${meta.exposureTime}`);
  if (meta.latitude)     lines.push(`- **GPS**: ${meta.latitude}, ${meta.longitude}`);

  return lines.join('\n');
}

// ── Main converter dispatcher ───────────────────────────────────────────────

async function convert(buffer, ext, mimeType, originalName) {
  // Use content sniffing to determine actual file type
  const detected = detectFileType(buffer, originalName, mimeType);
  const effectiveExt = detected.ext;

  const text = () => decodeText(buffer);

  if (['.txt', '.text', '.log'].includes(effectiveExt)) return text();
  if (effectiveExt === '.csv') {
    // Synced from markitdown#2303: strip the UTF-8 BOM, trim outer blank rows
    // (and the one right after the header), and KEEP interior blank rows as
    // empty table rows.
    const csvRows = parseCsv(stripUtf8Bom(text()));
    trimOuterBlankRows(csvRows);
    return rowsToMarkdownTable(csvRows, { keepBlankRows: true });
  }
  if (effectiveExt === '.html') return htmlToMarkdown(text());
  if (effectiveExt === '.json') {
    try {
      return fenced('json', JSON.stringify(JSON.parse(text()), null, 2));
    } catch {
      return fenced('json', text());
    }
  }
  if (effectiveExt === '.xml') return fenced('xml', text());
  if (['.yaml', '.yml'].includes(effectiveExt)) return fenced('yaml', text());
  if (effectiveExt === '.pdf') {
    try { return await convertPdf(buffer); }
    catch (e) { throw conversionInputError(`PDF conversion failed: ${e.message}`); }
  }
  if (effectiveExt === '.docx') {
    try { return await convertDocx(buffer); }
    catch (e) { if (e.code === 'CONVERSION_INPUT_ERROR') throw e; throw conversionInputError(`DOCX conversion failed: ${e.message}`); }
  }
  if (effectiveExt === '.xlsx') {
    try { return await convertXlsx(buffer); }
    catch (e) { if (e.code === 'CONVERSION_INPUT_ERROR') throw e; throw conversionInputError(`XLSX conversion failed: ${e.message}`); }
  }
  if (effectiveExt === '.pptx') {
    try { return await convertPptx(buffer); }
    catch (e) { if (e.code === 'CONVERSION_INPUT_ERROR') throw e; throw conversionInputError(`PPTX conversion failed: ${e.message}`); }
  }
  if (['.jpg', '.jpeg', '.png', '.gif'].includes(effectiveExt)) {
    try { return convertImage(buffer, originalName); }
    catch (e) { throw conversionInputError(`Image conversion failed: ${e.message}`); }
  }

  throw new Error('UNSUPPORTED_FILE_TYPE');
}

(async () => {
  try {
    const { buffer, ext, mimeType, originalName } = workerData;
    const markdown = ensureOutputSize(await convert(buffer, ext, mimeType, originalName));
    parentPort.postMessage({ ok: true, markdown });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message, code: e.code || 'CONVERSION_FAILED' });
  }
})();

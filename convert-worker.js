'use strict';

const { parentPort, workerData } = require('worker_threads');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');
const readExcelFile = require('read-excel-file/node');
const AdmZip = require('adm-zip');

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

function rowsToMarkdownTable(rows) {
  const cleaned = rows
    .map(row => row.map(escapeTableCell))
    .filter(row => row.some(cell => cell.length > 0));
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
  const parser = new PDFParse({ data: Buffer.from(buffer) });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

async function convertDocx(buffer) {
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(buffer) });
  return htmlToMarkdown(result.value);
}

async function convertXlsx(buffer) {
  const sheets = await readExcelFile(Buffer.from(buffer));
  return sheets
    .map(({ sheet, data }) => {
      const table = rowsToMarkdownTable(data || []);
      return table ? `## ${sheet}\n\n${table}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

async function convertPptx(buffer) {
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

async function convertImage(buffer, originalName) {
  const { imageSize } = require('image-size');
  const buf = Buffer.from(buffer);
  const dims = imageSize(buf);

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
  if (effectiveExt === '.csv') return rowsToMarkdownTable(parseCsv(text()));
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
    catch (e) { throw conversionInputError(`DOCX conversion failed: ${e.message}`); }
  }
  if (effectiveExt === '.xlsx') {
    try { return await convertXlsx(buffer); }
    catch (e) { throw conversionInputError(`XLSX conversion failed: ${e.message}`); }
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

// What is in a file someone sent: text read straight out of it (plain text and code, PDF through Poppler's
// pdftotext, Word / Excel / PowerPoint / OpenDocument / EPUB by unzipping their XML), or what kind of media it is
// so the caller can look at it (pictures, scanned PDF pages, video frames) or listen to it (audio).
// Also the small process runner the media tools share (pdftotext, pdftoppm, ffmpeg).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import * as XLSX from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import {decodeEntities} from './core/QQCards.mjs';

XLSX.set_cptable(codepages);

const textExtensions = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'log', 'ini', 'cfg', 'conf', 'toml',
  'yaml', 'yml', 'xml', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'sql', 'lua', 'swift', 'dart', 'vue', 'svelte',
  'r', 'm', 'tex', 'bib', 'srt', 'ass', 'ssa', 'vtt', 'lrc', 'properties', 'gradle', 'env', 'gitignore', 'dockerfile', 'makefile', 'cmake',
  'proto', 'graphql', 'gql', 'diff', 'patch', 'svg', 'rst', 'adoc', 'org', 'nfo', 'reg', 'inf', 'vbs', 'pl', 'scala', 'clj', 'ex', 'exs',
  'erl', 'hs', 'ml', 'fs', 'nim', 'zig', 'v', 'sv', 'vhd', 'asm', 's', 'ipynb', 'har', 'plist', 'manifest', 'mcmeta', 'lang', 'cue']);
const htmlExtensions = new Set(['html', 'htm', 'xhtml', 'mhtml']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'ico', 'avif']);
const audioExtensions = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'amr', 'silk', 'slk', 'wma', 'ape']);
const videoExtensions = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg']);

export const extension = name => {
  const base = path.basename(String(name ?? '')).toLowerCase();
  if (['dockerfile', 'makefile', 'readme', 'license'].includes(base)) return base === 'readme' || base === 'license' ? 'txt' : base;
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1);
};

/** Bytes as text: UTF-8 (with or without BOM), UTF-16 with a BOM, else GB18030 (what Chinese Windows writes). */
export function decodeText(data) {
  const bytes = Buffer.from(data);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch {}
  try { return new TextDecoder('gb18030').decode(bytes); } catch {}
  return new TextDecoder('utf-8').decode(bytes);
}
/** Text-like when the start has no NUL bytes and few control characters. */
const looksLikeText = data => {
  const sample = Buffer.from(data).subarray(0, 8192);
  if (sample.length === 0) return true;
  if ((sample[0] === 0xFF && sample[1] === 0xFE) || (sample[0] === 0xFE && sample[1] === 0xFF)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length < 0.02;
};

/** The kind of bytes, by their first few bytes. */
export function sniff(data) {
  const bytes = Buffer.from(data);
  const at = (offset, text) => bytes.subarray(offset, offset + text.length).toString('latin1') === text;
  if (at(0, '%PDF')) return 'pdf';
  if (at(0, 'PK\x03\x04') || at(0, 'PK\x05\x06')) return 'zip';
  if (at(0, '\x89PNG') || at(0, '\xFF\xD8\xFF') || at(0, 'GIF8') || at(0, 'BM') || (at(0, 'RIFF') && at(8, 'WEBP'))) return 'image';
  if (at(4, 'ftypheic') || at(4, 'ftypheix') || at(4, 'ftypavif') || at(4, 'ftypmif1')) return 'image';
  if (at(0, '#!AMR') || at(0, '\x02#!SILK') || at(0, '#!SILK') || at(0, 'ID3') || at(0, 'OggS') || at(0, 'fLaC') || (at(0, 'RIFF') && at(8, 'WAVE'))) return 'audio';
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return 'audio';
  if (at(4, 'ftypM4A')) return 'audio';
  if (at(4, 'ftyp') || at(0, '\x1A\x45\xDF\xA3') || at(0, 'FLV') || (at(0, 'RIFF') && at(8, 'AVI '))) return 'video';
  if (at(0, '\xD0\xCF\x11\xE0')) return 'ole';
  if (at(0, 'Rar!') || at(0, '7z\xBC\xAF') || at(0, '\x1F\x8B')) return 'archive';
  if (at(0, '{\\rtf')) return 'rtf';
  return looksLikeText(bytes) ? 'text' : 'binary';
}

// MARK: Zip (docx, xlsx, pptx, odt, epub, plain zips): the central directory, entries inflated on demand.

export function zipEntries(data) {
  const bytes = Buffer.from(data);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return undefined;
  const total = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < total && offset + 46 <= bytes.length; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = flags & 0x800 ? rawName.toString('utf8') : decodeText(rawName);
    entries.push({name, method, compressed, size, local});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    entries,
    read(entry, limit = 64_000_000) {
      if (typeof entry === 'string') entry = entries.find(item => item.name === entry);
      if (!entry || bytes.readUInt32LE(entry.local) !== 0x04034b50) return undefined;
      const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
      const body = bytes.subarray(start, start + entry.compressed);
      if (entry.method === 0) return body;
      if (entry.method === 8) { try { return zlib.inflateRawSync(body, {maxOutputLength: limit}); } catch { return undefined; } }
      return undefined;
    }
  };
}

/** Text between XML tags, with paragraph and line-break tags turned into new lines. */
const xmlText = (xml, {paragraph = /<\/(?:w:p|a:p|text:p|text:h|p|div|h[1-6]|li|tr|br)\b[^>]*>|<(?:w:br|w:cr|a:br|text:line-break|br)\b[^>]*\/?>/giu, tab = /<(?:w:tab|text:tab)\b[^>]*\/>/giu} = {}) =>
  decodeEntities(String(xml).replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, '').replace(tab, '\t').replace(paragraph, '\n').replace(/<[^>]+>/gu, ''))
    .replace(/[ \t ]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
const numbered = (entries, pattern) => entries.map(entry => ({entry, match: entry.name.match(pattern)})).filter(item => item.match)
  .sort((a, b) => Number(a.match[1]) - Number(b.match[1])).map(item => item.entry);

function officeText(zip, ext) {
  const read = name => { const data = zip.read(name); return data ? data.toString('utf8') : undefined; };
  const names = zip.entries.map(entry => entry.name);
  if (names.includes('word/document.xml')) {
    const parts = ['word/document.xml', ...names.filter(name => /^word\/(footnotes|endnotes)\.xml$/u.test(name))];
    return parts.map(read).filter(Boolean).map(xml => xmlText(xml)).join('\n\n');
  }
  if (names.includes('xl/workbook.xml')) {
    const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)]
      .map(match => decodeEntities([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map(part => part[1]).join('')));
    const sheetNames = [...(read('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/gu)].map(match => decodeEntities(match[1]));
    return numbered(zip.entries, /^xl\/worksheets\/sheet(\d+)\.xml$/u).map((entry, index) => {
      const xml = zip.read(entry)?.toString('utf8') ?? '';
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)].map(row => [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)].map(cell => {
        const attributes = cell[1], inner = cell[2] ?? '';
        const type = attributes.match(/\bt="([^"]*)"/u)?.[1];
        const value = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/u)?.[1];
        if (type === 's' && value !== undefined) return shared[Number(value)] ?? '';
        if (type === 'inlineStr') return decodeEntities([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map(part => part[1]).join(''));
        return value === undefined ? '' : decodeEntities(value);
      }).join('\t').replace(/\t+$/u, '')).filter(line => line !== '');
      return `【工作表 ${sheetNames[index] ?? index + 1}】\n` + rows.join('\n');
    }).join('\n\n');
  }
  if (names.some(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))) {
    return numbered(zip.entries, /^ppt\/slides\/slide(\d+)\.xml$/u).map((entry, index) => {
      const notes = read(`ppt/notesSlides/notesSlide${entry.name.match(/(\d+)\.xml$/u)[1]}.xml`);
      return `【第 ${index + 1} 页】\n` + xmlText(zip.read(entry)?.toString('utf8') ?? '') + (notes ? '\n（备注）' + xmlText(notes).replace(/^\d+$/mu, '') : '');
    }).join('\n\n');
  }
  if (names.includes('content.xml') && names.includes('mimetype')) return xmlText(read('content.xml') ?? '');
  if (ext === 'epub' || names.includes('META-INF/container.xml')) {
    return zip.entries.filter(entry => /\.(x?html?)$/iu.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', {numeric: true}))
      .map(entry => xmlText(zip.read(entry)?.toString('utf8') ?? '')).filter(Boolean).join('\n\n');
  }
  return undefined;
}

function spreadsheetText(data) {
  try {
    const workbook = XLSX.read(data, {type: 'buffer'});
    const text = workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      const range = sheet['!ref'] ? `范围：${sheet['!ref']}\n` : '';
      const merges = sheet['!merges']?.map(merge => XLSX.utils.encode_range(merge)) ?? [];
      return `【工作表 ${name}】\n` + range + (merges.length ? `合并单元格：${merges.join('、')}\n` : '') +
        XLSX.utils.sheet_to_csv(sheet, {FS: '\t', RS: '\n', blankrows: true});
    }).join('\n\n');
    return {kind: 'text', text};
  } catch (error) {
    return {kind: 'unknown', note: 'Excel 工作簿打不开（可能加密或损坏）：' + error.message};
  }
}

/** Text in an old binary Office file (.doc/.ppt): runs of UTF-16 characters, a rough reading. */
function oleText(data) {
  const bytes = Buffer.from(data);
  const runs = [];
  let run = '';
  for (let at = 0; at + 1 < bytes.length; at += 2) {
    const code = bytes.readUInt16LE(at);
    const readable = code === 10 || code === 13 || code === 9 || (code >= 0x20 && code < 0x7F) || (code >= 0x3000 && code <= 0x9FFF) || (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0x2000 && code <= 0x206F);
    if (readable) run += String.fromCharCode(code);
    else { if (run.replace(/\s/gu, '').length >= 4 && /[㐀-鿿]|[A-Za-z]{4}/u.test(run)) runs.push(run.trim()); run = ''; }
  }
  if (run.replace(/\s/gu, '').length >= 4) runs.push(run.trim());
  return runs.join('\n').replace(/\r/gu, '\n').replace(/\n{3,}/gu, '\n\n');
}

const rtfText = rtf => rtf.replace(/\\par[d]?\b/gu, '\n').replace(/\\'([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/\\u(-?\d+)\??/gu, (_, code) => String.fromCharCode((Number(code) + 65536) % 65536)).replace(/\\[a-z]+-?\d* ?/giu, '').replace(/[{}]/gu, '').trim();

export class QQFileText {
  /** Command runner: {code, stdout, stderr} (Buffers); code -1 when the program could not be started. Replaceable in tests. */
  static run(command, args, {timeout = 120, input} = {}) {
    return new Promise(resolve => {
      let child;
      try { child = spawn(command, args, {windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']}); }
      catch (error) { resolve({code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error?.message ?? error))}); return; }
      const out = [], err = [];
      let outSize = 0;
      child.stdout.on('data', chunk => { if (outSize < 64_000_000) { out.push(chunk); outSize += chunk.length; } });
      child.stderr.on('data', chunk => { if (err.length < 200) err.push(chunk); });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout * 1000);
      child.on('error', error => { clearTimeout(timer); resolve({code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error?.message ?? error))}); });
      child.on('close', code => { clearTimeout(timer); resolve({code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err)}); });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  /**
   * What is in `data` (a file called `name`): {kind: 'text', text, note?} | {kind: 'image'} | {kind: 'pdf-scan'} |
   * {kind: 'audio', format} | {kind: 'video'} | {kind: 'unknown', note}. `directory` is a scratch folder for tools.
   */
  static async extract(data, name, directory) {
    const ext = extension(name), kind = sniff(data);
    if (kind === 'image' || (imageExtensions.has(ext) && kind !== 'text')) return {kind: 'image'};
    if (kind === 'pdf' || ext === 'pdf') {
      const file = path.join(directory, 'input.pdf');
      fs.writeFileSync(file, data);
      const result = await QQFileText.run(process.env.DAFEIYU_PDFTOTEXT || 'pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']);
      if (result.code === -1) return {kind: 'unknown', note: '这台电脑上没装 pdftotext（Poppler），读不了 PDF'};
      const text = result.stdout.toString('utf8').replace(/\f/gu, '\n\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim();
      if (result.code !== 0 && text === '') return {kind: 'unknown', note: 'PDF 打不开（可能加密或损坏）：' + result.stderr.toString('utf8').slice(0, 120)};
      return text.replace(/\s/gu, '') === '' ? {kind: 'pdf-scan', file} : {kind: 'text', text};
    }
    if (kind === 'zip') {
      const zip = zipEntries(data);
      if (!zip) return {kind: 'unknown', note: '压缩包结构读不出来'};
      const office = officeText(zip, ext);
      if (office !== undefined) return {kind: 'text', text: office};
      const listing = zip.entries.slice(0, 300).map(entry => `${entry.name}${entry.name.endsWith('/') ? '' : '（' + entry.size + ' 字节）'}`).join('\n');
      return {kind: 'text', note: `这是个压缩包，里面有 ${zip.entries.length} 项（只列文件名）`, text: listing};
    }
    // 2026-11-03: "Find the root cause and fix it in the code": BIFF records, not byte runs, associate courses with exam times.
    if (ext === 'xls' || ext === 'et') return spreadsheetText(data);
    if (kind === 'ole') {
      try {
        const container = XLSX.CFB.read(data, {type: 'buffer'});
        if (XLSX.CFB.find(container, '/Workbook') || XLSX.CFB.find(container, '/Book')) return spreadsheetText(data);
      } catch {}
    }
    if (kind === 'ole' || ['doc', 'ppt', 'wps', 'dps'].includes(ext)) {
      const text = oleText(data);
      return text === '' ? {kind: 'unknown', note: '老格式的 Office 文件，没读出文字'} : {kind: 'text', text, note: '老格式 Office 文件，按字节粗提的文字，排版没了，可能夹杂乱码'};
    }
    if (kind === 'rtf' || ext === 'rtf') return {kind: 'text', text: rtfText(decodeText(data))};
    if (kind === 'audio' || (audioExtensions.has(ext) && kind !== 'text')) return {kind: 'audio', format: ext === '' ? 'mp3' : ext === 'slk' ? 'silk' : ext};
    if (kind === 'video' || (videoExtensions.has(ext) && kind !== 'text')) return {kind: 'video'};
    if (kind === 'text' || textExtensions.has(ext) || htmlExtensions.has(ext)) {
      const text = decodeText(data);
      if (htmlExtensions.has(ext) || /^\s*<(!doctype html|html)\b/iu.test(text.slice(0, 200))) return {kind: 'text', text: xmlText(text)};
      return {kind: 'text', text};
    }
    if (kind === 'archive') return {kind: 'unknown', note: 'rar / 7z / gz 压缩包，这里解不开'};
    return {kind: 'unknown', note: '二进制文件，没有可读的文字'};
  }

  /** The first pages of a PDF as JPEG pictures (pdftoppm), for scanned documents. */
  static async pdfPages(file, pages = 3) {
    const base = path.join(path.dirname(file), 'page');
    const result = await QQFileText.run(process.env.DAFEIYU_PDFTOPPM || 'pdftoppm', ['-jpeg', '-r', '110', '-f', '1', '-l', String(pages), '-scale-to', '1400', file, base]);
    if (result.code !== 0) return [];
    return fs.readdirSync(path.dirname(file)).filter(name => /^page-\d+\.jpg$/u.test(name)).sort().map(name => fs.readFileSync(path.join(path.dirname(file), name)));
  }

  static ffmpeg() { return process.env.DAFEIYU_FFMPEG || 'ffmpeg'; }
  /**
   * A video's length in seconds and a few evenly spread frames (JPEG, at most 1280 px wide), through ffmpeg.
   * Throws when ffmpeg is missing or cannot read the file. Replaceable in tests.
   */
  static async videoFrames(file, count = 4) {
    const probe = await QQFileText.run(QQFileText.ffmpeg(), ['-hide_banner', '-i', file], {timeout: 60});
    if (probe.code === -1) throw new Error('这台电脑上找不到 ffmpeg（可以用 DAFEIYU_FFMPEG 指定位置）');
    const found = probe.stderr.toString('utf8').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u);
    const duration = found ? Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]) : 0;
    const frames = [];
    const times = duration > 0 ? Array.from({length: count}, (_, index) => duration * (index + 0.5) / count) : [0];
    for (const [index, time] of times.entries()) {
      const output = path.join(path.dirname(file), `frame-${index}.jpg`);
      const result = await QQFileText.run(QQFileText.ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', time.toFixed(2), '-i', file,
        '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', output], {timeout: 60});
      if (result.code === 0 && fs.existsSync(output)) frames.push(fs.readFileSync(output));
    }
    if (!frames.length) throw new Error('ffmpeg 没能从视频里取出画面');
    return {duration, frames};
  }
  /** A video's (or any media file's) sound as 16 kHz mono MP3, at most `seconds` long; undefined when it has none. */
  static async audioTrack(file, seconds = 600) {
    const output = path.join(path.dirname(file), 'sound.mp3');
    const result = await QQFileText.run(QQFileText.ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000',
      '-t', String(seconds), '-b:a', '48k', output], {timeout: 180});
    if (result.code !== 0 || !fs.existsSync(output) || fs.statSync(output).size < 1000) return undefined;
    return fs.readFileSync(output);
  }
}

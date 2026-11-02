// Shared helpers for the Node engine, which replaces the Swift engine in upstream/ (ported file by file).
// Swift Date values travel as seconds since 2001-01-01 (JSONEncoder's default), so qq-state.json written by
// the Swift engine reads unchanged; in memory they are JS Date objects.
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const SWIFT_EPOCH = 978307200;
export const dateFromSwift = value => value == null ? undefined : new Date((Number(value) + SWIFT_EPOCH) * 1000);
export const dateToSwift = date => date == null ? undefined : date.getTime() / 1000 - SWIFT_EPOCH;
/** Swift's Date().timeIntervalSince1970. */
export const now = () => Date.now() / 1000;
export const seconds = date => date.getTime() / 1000;
export const addSeconds = (date, value) => new Date(date.getTime() + value * 1000);
export const since = date => (Date.now() - date.getTime()) / 1000;
export const distantPast = new Date(-62135769600000);
export const distantFuture = new Date(64092211200000);

/** Swift's UUID().uuidString. */
export const uuid = () => crypto.randomUUID().toUpperCase();

export class AppFailure extends Error {
  constructor(message) { super(message); this.name = 'AppFailure'; }
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('cancelled'));
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('cancelled')); };
  signal?.addEventListener('abort', abort, {once: true});
});

export const root = path.resolve(import.meta.dirname, '..');
/** upstream/Resources (faces.json, sticker manifests, image-helper.py, the original panel). */
export const resources = () => process.env.DAFEIYU_RESOURCES || path.join(root, 'upstream', 'Resources');
/** The engine's state directory (qq-state.json, QQStickers/). */
export const dataDirectory = () => process.env.DAFEIYU_DATA_DIR || path.join(root, '.runtime', 'engine');
export const temporaryDirectory = () => process.env.TEMP || process.env.TMPDIR || os.tmpdir();

/** Swift's trimmingCharacters(in: .whitespacesAndNewlines). */
export const trim = value => String(value ?? '').replace(/^[\s\u0085\u2028\u2029\u3000]+|[\s\u0085\u2028\u2029\u3000]+$/gu, '');
/** Swift String.count counts grapheme clusters; prefix/suffix/count on user text must use these. */
const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});
export const graphemes = value => Array.from(segmenter.segment(String(value ?? '')), part => part.segment);
export const count = value => graphemes(value).length;
export const prefix = (value, length) => graphemes(value).slice(0, Math.max(0, length)).join('');
export const suffix = (value, length) => length <= 0 ? '' : graphemes(value).slice(-length).join('');
export const sha256 = value => crypto.createHash('sha256').update(value).digest();

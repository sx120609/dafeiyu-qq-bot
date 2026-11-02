// Port of QQStickerLibrary.swift (Linux branch). Manifests are the same JSON the Swift engine reads and writes,
// so bundled packs and the QQStickers data directory carry over unchanged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {AppFailure, count, dateFromSwift, dateToSwift, prefix, trim} from './swift.mjs';
import {LinuxImages} from './LinuxImages.mjs';
import {RuntimeResources} from './RuntimeResources.mjs';
import {QQEmotion} from './core/QQPersona.mjs';
import {DecodingError, isDictionary, parseDictionary, serialize, swiftURL} from './foundation.mjs';

const hex = data => crypto.createHash('sha256').update(data).digest('hex');
const lstat = file => { try { return fs.lstatSync(file); } catch { return undefined; } };
/** Data.write(to:options: .atomic) followed by setAttributes 0600. */
const writeAtomic = (file, data) => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, {mode: 0o600});
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}); } catch {}
    throw error;
  }
  fs.chmodSync(file, 0o600);
};
const required = (json, key, check, type) => {
  if (!check(json[key])) throw new DecodingError(`${type}.${key}`);
  return json[key];
};
const optional = (json, key, check, type) => {
  if (json[key] == null) return undefined;
  if (!check(json[key])) throw new DecodingError(`${type}.${key}`);
  return json[key];
};
const isString = value => typeof value === 'string';

class Item {
  constructor({id, title, emotion, file, sha256, source, context, author, license, publicSharing, character} = {}) {
    this.id = id; this.title = title; this.emotion = emotion; this.file = file; this.sha256 = sha256; this.source = source;
    this.context = context; this.author = author; this.license = license; this.publicSharing = publicSharing; this.character = character;
  }
  static decode(json) {
    if (!isDictionary(json)) throw new DecodingError('Item');
    return new Item({id: required(json, 'id', isString, 'Item'), title: required(json, 'title', isString, 'Item'),
      emotion: required(json, 'emotion', value => QQEmotion.from(value) !== undefined, 'Item'),
      file: required(json, 'file', isString, 'Item'), sha256: required(json, 'sha256', isString, 'Item'),
      source: required(json, 'source', isString, 'Item'), context: optional(json, 'context', isString, 'Item'),
      author: optional(json, 'author', isString, 'Item'), license: optional(json, 'license', isString, 'Item'),
      publicSharing: optional(json, 'publicSharing', value => typeof value === 'boolean', 'Item'),
      character: optional(json, 'character', isString, 'Item')});
  }
  toJSON() {
    return {id: this.id, title: this.title, emotion: this.emotion, file: this.file, sha256: this.sha256, source: this.source,
      context: this.context, author: this.author, license: this.license, publicSharing: this.publicSharing, character: this.character};
  }
  clone() { return new Item(this); }
}

class Use {
  constructor({sha256, at} = {}) { this.sha256 = sha256; this.at = at; }
  static decode(json) {
    if (!isDictionary(json) || typeof json.sha256 !== 'string' || typeof json.at !== 'number') throw new DecodingError('Use');
    return new Use({sha256: json.sha256, at: dateFromSwift(json.at)});
  }
  toJSON() { return {sha256: this.sha256, at: dateToSwift(this.at)}; }
  clone() { return new Use({sha256: this.sha256, at: new Date(this.at.getTime())}); }
}

const shuffled = values => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = crypto.randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

// Catalog IDs resolve to verified local bytes; model output can never supply a path.
export class QQStickerLibrary {
  static Item = Item;
  static Use = Use;
  /// Offered when someone sends or quotes a picture: lets the model keep it when asked to ("把这个表情存一下").
  static saveToolDefinition = {type: 'function', function: {
    name: 'save_sticker',
    description: '把对方这一轮引用的图（没有引用就用对方这一轮发的图）存进你的表情库，以后聊天合适时会发。只在对方明确让你存、收藏、记住这个表情时用。存之前看清画面：色情擦边、政治、血腥暴力、真人隐私、广告二维码一律不存，直接告诉对方不存。',
    parameters: {type: 'object', additionalProperties: false, required: ['title', 'emotion', 'context'], properties: {
      title: {type: 'string', description: '简短名字，写清画面和配字，例如“委屈小象耷拉眼睛”'},
      emotion: {type: 'string', enum: [...QQEmotion.all]},
      context: {type: 'string', description: '一句话：什么时候适合发这张'}
    }}
  }};
  /** saveToolArguments(_:) → {title, emotion, context} or undefined. */
  static saveToolArguments(args) {
    if (typeof args !== 'string' || Buffer.byteLength(args) > 4096) return undefined;
    const fields = parseDictionary(args);
    const title = typeof fields?.title === 'string' ? trim(fields.title) : undefined;
    const emotion = typeof fields?.emotion === 'string' ? QQEmotion.from(fields.emotion) : undefined;
    if (!title || emotion === undefined) return undefined;
    const context = trim(typeof fields.context === 'string' ? fields.context : '');
    return {title: prefix(title, 80), emotion, context: prefix(context === '' ? title : context, 300)};
  }

  /** init(directory:localDirectory:) — `{directory, localDirectory}` paths. Leaving `directory` out uses the bundled
   *  pack (Resources/QQStickers); passing it as undefined/null means none, as Swift's `directory: nil` does. */
  constructor(fields = {}) {
    this.directory = 'directory' in fields ? fields.directory ?? undefined : path.join(RuntimeResources.directory, 'QQStickers');
    this.localDirectory = fields.localDirectory ?? undefined;
    this.items = QQStickerLibrary.catalog(this.directory);
    const local = QQStickerLibrary.catalog(this.localDirectory);
    const bundledIDs = new Set(this.items.map(item => item.id)), bundledHashes = new Set(this.items.map(item => item.sha256));
    this.items.push(...local.filter(item => item.id.startsWith('local-') && !bundledIDs.has(item.id) && !bundledHashes.has(item.sha256)));
  }
  static catalog(directory) {
    if (!directory) return [];
    const folder = lstat(directory);
    if (!folder || folder.isSymbolicLink()) return [];
    const file = path.join(directory, 'manifest.json');
    const metadata = lstat(file);
    if (!metadata || metadata.isSymbolicLink() || !(metadata.size >= 1 && metadata.size < 1_000_000)) return [];
    let catalog;
    try {
      const data = fs.readFileSync(file);
      if (data.length !== metadata.size) return [];
      const json = JSON.parse(data.toString('utf8'));
      if (!Array.isArray(json)) return [];
      catalog = json.map(Item.decode);
    } catch { return []; }
    if (catalog.length > 500 || new Set(catalog.map(item => item.id)).size !== catalog.length ||
        new Set(catalog.map(item => item.sha256)).size !== catalog.length) return [];
    return catalog;
  }
  // Content cooldown is per account/conversation and survives restart.
  /** available(recent:now:repeatHours:) — `available({recent, now, repeatHours})` or `available(recent, now, repeatHours)`. */
  available(recent, now = new Date(), repeatHours = 24) {
    if (isDictionary(recent) && !Array.isArray(recent)) ({recent, now = new Date(), repeatHours = 24} = recent);
    const excluded = new Set(recent.filter(use => (now.getTime() - use.at.getTime()) / 1000 < repeatHours * 3600).map(use => use.sha256));
    return this.items.filter(item => !excluded.has(item.sha256));
  }
  // A bounded caption shortlist, then the existing semantic reviewer chooses or abstains.
  /// Someone plainly asking for a sticker: "发个表情", "来张表情包", "斗图", "表情呢".
  static requested(text) {
    return /(发|甩|丢|整|贴)(个|张|一个|一张|点|几张)?.{0,2}(表情|贴图|梗图)|(来|给我)(个|张|一个|一张|点|几张).{0,2}(表情|贴图|梗图)|斗图|表情(包)?呢/u.test(text);
  }
  /// When a sticker was asked for, a few of every mood rather than only the draft's, so one fits whatever was said.
  static broadShortlist(available) {
    return QQEmotion.all.flatMap(emotion => shuffled(available.filter(item => item.emotion === emotion)).slice(0, 3));
  }
  /** shortlist(_:emotion:) — `shortlist(available, emotion)` or `shortlist(available, {emotion})`. */
  static shortlist(available, emotion) {
    if (isDictionary(emotion)) emotion = emotion.emotion;
    const matching = shuffled(available.filter(item => item.emotion === emotion));
    const gentle = emotion === QQEmotion.neutral ? [] : shuffled(available.filter(item => item.emotion === QQEmotion.neutral));
    return [...matching.slice(0, 12), ...gentle.slice(0, 4)];
  }
  /** data(for:) → Buffer or undefined. */
  async data(item) {
    const directory = item.id.startsWith('local-') ? this.localDirectory : this.directory;
    // NSString.lastPathComponent only knows "/"; on Windows "\" and drive letters must not reach a path either.
    const file = item.file;
    if (!directory || typeof file !== 'string' || file !== path.posix.basename(file) || file !== path.win32.basename(file) ||
        file === '' || file === '.' || file === '..' || file.includes(':') ||
        !['png', 'webp', 'jpg', 'jpeg', 'gif'].includes(path.posix.extname(file).slice(1))) return undefined;
    const target = path.join(directory, file);
    const size = lstat(target);
    if (!size || size.isSymbolicLink() || !(size.size >= 1 && size.size <= 3_000_000)) return undefined;
    let data;
    try { data = fs.readFileSync(target); } catch { return undefined; }
    if (data.length !== size.size || hex(data) !== item.sha256) return undefined;
    try { await LinuxImages.process(data, 'sticker'); } catch { return undefined; }
    return data;
  }

  /// What an import may start from. Kept files stay within 3 MB: an animated GIF over that is shrunk (smaller
  /// frames, then fewer) so it still moves (11-01: a 3.6 MB 动画表情 was saved as its first frame).
  static importBytes = 16_000_000;
  /** importImage(_:title:emotion:context:source:author:license:publicSharing:) —
   *  `importImage(bytes, {title, emotion, context, source, author, license, publicSharing})`. Throws AppFailure. */
  async importImage(bytes, {title, emotion, context, source, author, license, publicSharing}) {
    const localDirectory = this.localDirectory;
    if (!localDirectory || !(bytes.length >= 1 && bytes.length <= QQStickerLibrary.importBytes) || trim(title) === '' ||
        count(title) > 80 || count(context) > 300 || count(source) > 500 || count(author) > 80 || count(license) > 100) {
      throw new AppFailure('图片最多 16 MB（存下来不超过 3 MB）；名称 1–80 字，情境最多 300 字');
    }
    const sourceURL = swiftURL(source);
    if (!(source === '' || (sourceURL?.scheme === 'https' && sourceURL.host !== undefined && sourceURL.user === undefined &&
        sourceURL.password === undefined && sourceURL.query === undefined && sourceURL.fragment === undefined))) {
      throw new AppFailure('来源请填写不含凭证、查询参数的公开 HTTPS 网页');
    }
    if (publicSharing && (author === '' || license === '' || source === '')) throw new AppFailure('公开分享需要作者、许可和来源；未确认的图片请仅保存在本机');
    const originalHash = hex(bytes);
    if (this.items.some(item => item.sha256 === originalHash)) throw new AppFailure('这张图片已存在，未重复导入');
    const normalized = (await LinuxImages.process(bytes, 'sticker-import'))[0];
    if (normalized.length > 3_000_000) throw new AppFailure('解码后的图片超过 3 MB，请缩小后导入');
    const hash = hex(normalized);
    if (this.items.some(item => item.sha256 === hash)) throw new AppFailure('这张图片已存在，未重复导入');
    if (this.items.length >= 500) throw new AppFailure('表情库最多 500 张');
    fs.mkdirSync(localDirectory, {recursive: true, mode: 0o700});
    if (fs.lstatSync(localDirectory).isSymbolicLink()) throw new AppFailure('表情目录不能是符号链接');
    // An animated GIF stays a GIF so it still moves when sent; everything else was re-encoded as PNG.
    const file = hash + (normalized.subarray(0, 4).toString('latin1') === 'GIF8' ? '.gif' : '.png');
    writeAtomic(path.join(localDirectory, file), normalized);
    const item = new Item({id: 'local-' + hash, title, emotion, file, sha256: hash, source, context, author, license, publicSharing});
    const catalog = [...this.items.filter(entry => entry.id.startsWith('local-')), item];
    writeAtomic(path.join(localDirectory, 'manifest.json'), serialize(catalog));
    this.items.push(item);
  }
}
export {Item as QQStickerLibrary_Item, Use as QQStickerLibrary_Use};

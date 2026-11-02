// Port of QQStickerPack.swift.
import crypto from 'node:crypto';
import {AppFailure, count, trim} from './swift.mjs';
import {QQEmotion} from './core/QQPersona.mjs';
import {DecodingError, decodeBase64, isDictionary, swiftURL} from './foundation.mjs';

class Item {
  constructor({title, emotion, context, source, author, license, data} = {}) {
    this.title = title; this.emotion = emotion; this.context = context; this.source = source;
    this.author = author; this.license = license; this.data = data;
  }
}
const wireKeys = ['title', 'emotion', 'context', 'source', 'author', 'license', 'sha256', 'imageBase64'];

// A resource pack contains bytes and descriptive metadata, never paths, URLs to fetch or runtime settings.
export class QQStickerPack {
  static Item = Item;
  /** decode(_ data: Data) → [Item]; throws. (Not a Codable decoder: it takes the pack file's bytes.) */
  static decode(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (!(bytes.length >= 1 && bytes.length <= 24_000_000)) throw new AppFailure('资源包最多 24 MB');
    // JSONDecoder().decode(Envelope.self, from: data): every listed field present with its type; others ignored.
    let pack;
    try { pack = JSON.parse(bytes.toString('utf8')); } catch { throw new DecodingError('Envelope'); }
    if (!isDictionary(pack) || typeof pack.format !== 'string' || !Number.isInteger(pack.version) || !Array.isArray(pack.items) ||
        !pack.items.every(item => isDictionary(item) && wireKeys.every(key => typeof item[key] === 'string') && QQEmotion.from(item.emotion) !== undefined)) {
      throw new DecodingError('Envelope');
    }
    if (pack.format !== 'dafeiyu-stickers' || pack.version !== 1 || !(pack.items.length >= 1 && pack.items.length <= 50)) {
      throw new AppFailure('请选择有效的表情资源包，每包 1–50 张');
    }
    const hashes = new Set();
    return pack.items.map(item => {
      const url = swiftURL(item.source);
      const image = Buffer.byteLength(item.imageBase64) <= 4_000_000 ? decodeBase64(item.imageBase64) : undefined;
      if (trim(item.title) === '' || count(item.title) > 80 || count(item.context) > 300 || count(item.author) > 80 ||
          count(item.license) > 100 || count(item.source) > 500 ||
          !(item.source === '' || (url?.scheme === 'https' && url.host !== undefined && url.user === undefined && url.password === undefined &&
            url.query === undefined && url.fragment === undefined)) ||
          !image || !(image.length >= 1 && image.length <= 3_000_000) ||
          crypto.createHash('sha256').update(image).digest('hex') !== item.sha256 || hashes.has(item.sha256)) {
        throw new AppFailure('资源包包含无效元数据、重复图片或校验不符的内容，未开始导入');
      }
      hashes.add(item.sha256);
      return new Item({title: item.title, emotion: item.emotion, context: item.context, source: item.source,
        author: item.author, license: item.license, data: image});
    });
  }
}
export {Item as QQStickerPack_Item};

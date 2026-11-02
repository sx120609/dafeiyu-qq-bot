// Port of QQIncomingImages.swift (Linux branch): QQ's own image CDNs only, bounded while receiving, decoded by the
// Python helper.
import {AppFailure} from './swift.mjs';
import {boundedData, checkCancellation, defaultSession} from './BoundedDownload.mjs';
import {LinuxImages} from './LinuxImages.mjs';
import {isDictionary, swiftURL} from './foundation.mjs';

const maxFramesOf = (value, fallback = 6) => typeof value === 'number' ? value : isDictionary(value) && value.maxFrames !== undefined ? value.maxFrames : fallback;

export class QQIncomingImages {
  /** `session` is a fetch-compatible function (see BoundedDownload.mjs). Node's fetch keeps no cache or cookies,
   *  which is what the Swift ephemeral session was configured for. */
  constructor({session = defaultSession} = {}) { this.session = session; }
  /// Phone photos and screenshots sent as originals run to 10–15 MB; they are decoded at reduced size.
  static maxBytes = 32_000_000;
  /** allowedURL(_:) → the parsed https URL (foundation.mjs swiftURL; `.href` is the string) or undefined. */
  static allowedURL(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) return undefined;
    const url = swiftURL(value);
    if (!url || !['http', 'https'].includes(url.scheme ?? '') || url.user !== undefined || url.password !== undefined || url.port !== undefined ||
        !['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'q.qlogo.cn'].includes(url.host ?? '')) return undefined;
    const rewritten = new URL(url.href);
    rewritten.protocol = 'https:'; rewritten.hash = '';
    return swiftURL(rewritten.href);
  }
  /** load(_:maxFrames:) — `load(value, maxFrames = 6, {signal})`; `load(value, {maxFrames, signal})` works too. */
  async load(value, maxFrames = 6, options = {}) {
    if (isDictionary(maxFrames)) options = maxFrames;
    return await QQIncomingImages.frames(await this.download(value, options), maxFramesOf(maxFrames));
  }
  /// The picture as it was sent, for saving a sticker: decoding it into frames would lose a GIF's animation.
  async download(value, {signal} = {}) {
    const url = QQIncomingImages.allowedURL(value);
    if (!url) throw new AppFailure('图片下载地址不受支持');
    const {data, response} = await boundedData(this.session, {url: url.href, timeoutInterval: 15, signal}, QQIncomingImages.maxBytes);
    if (response.statusCode !== 200 || response.expectedContentLength > QQIncomingImages.maxBytes) throw new AppFailure('图片暂时无法下载');
    checkCancellation(signal);
    return data;
  }
  /** frames(_:maxFrames:) — `frames(data, maxFrames = 6)` (or `{maxFrames}`); JPEG frames of at most 1280 px. */
  static async frames(data, maxFrames = 6) {
    return LinuxImages.process(data, 'frames', {maxFrames: maxFramesOf(maxFrames)});
  }
}

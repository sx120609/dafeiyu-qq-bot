import {container, decodeBool, decodeRaw, deepClone, deepEqual} from './_support.mjs';

/** Raw-value enum (String). */
export class QQVisionProvider {
  static deepseek = 'deepseek';
  static zhipu = 'zhipu';
  static all = ['deepseek', 'zhipu'];
  static from(raw) { return QQVisionProvider.all.includes(raw) ? raw : undefined; }
  static title(provider) { return provider === 'zhipu' ? '智谱 GLM-4.6V-Flash' : '聊天模型直接看图'; }
}

// No credentials in persisted settings. Existing installations retain their provider until changed.
export class QQVisualConfig {
  constructor({provider = 'deepseek', googleWebEnabled = false} = {}) { this.provider = provider; this.googleWebEnabled = googleWebEnabled; }
  static decode(json) {
    const c = container(json, 'QQVisualConfig');
    return new QQVisualConfig({provider: c.need('provider', decodeRaw(QQVisionProvider)), googleWebEnabled: c.need('googleWebEnabled', decodeBool)});
  }
  toJSON() { return {provider: this.provider, googleWebEnabled: this.googleWebEnabled}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

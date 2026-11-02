import {container, decodeBool, decodeRaw, decodeString, deepClone, deepEqual, ICU_END} from './_support.mjs';
import {CoreError} from './Domain.mjs';

const titles = {zhipu: '智谱 CogView-3-Flash', cloudflare: 'Cloudflare FLUX.1 schnell', codex: '模型网关生图（云端 API 或本机 Codex）'};

/** Raw-value enum (String). */
export class QQImageProvider {
  static zhipu = 'zhipu';
  static cloudflare = 'cloudflare';
  static codex = 'codex';
  static all = ['zhipu', 'cloudflare', 'codex'];
  static from(raw) { return QQImageProvider.all.includes(raw) ? raw : undefined; }
  static title(provider) { return titles[provider]; }
  static alternate(provider) { return provider === 'zhipu' ? 'cloudflare' : 'zhipu'; }
}

const accountPattern = new RegExp(`^[a-fA-F0-9]{32}${ICU_END}`, 'u');

// Credentials are deliberately excluded from Codable settings.
export class QQImageGenerationConfig {
  constructor({enabled = false, primary = 'zhipu', fallbackEnabled = true, cloudflareAccountID = ''} = {}) {
    this.enabled = enabled; this.primary = primary; this.fallbackEnabled = fallbackEnabled; this.cloudflareAccountID = cloudflareAccountID;
  }
  validate() {
    if (!(this.cloudflareAccountID === '' || accountPattern.test(this.cloudflareAccountID))) {
      throw CoreError.invalid('Cloudflare Account ID 应为 32 位十六进制字符（不是 API Token）');
    }
  }
  static decode(json) {
    const c = container(json, 'QQImageGenerationConfig');
    return new QQImageGenerationConfig({enabled: c.need('enabled', decodeBool), primary: c.need('primary', decodeRaw(QQImageProvider)),
      fallbackEnabled: c.need('fallbackEnabled', decodeBool), cloudflareAccountID: c.need('cloudflareAccountID', decodeString)});
  }
  toJSON() { return {enabled: this.enabled, primary: this.primary, fallbackEnabled: this.fallbackEnabled, cloudflareAccountID: this.cloudflareAccountID}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

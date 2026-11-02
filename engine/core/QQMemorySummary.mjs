import {prefix} from '../swift.mjs';
import {asString, container, decodeDate, decodeString, deepClone, deepEqual, encodeDate, ICU_DOT, ICU_SPACE, isObject} from './_support.mjs';
import {CoreError} from './Domain.mjs';

const redaction = new RegExp(`(sk-[a-z0-9_-]+|bearer[${ICU_SPACE}]+[a-z0-9._-]+|(?:密码|口令|密钥|token|api${ICU_DOT}?key)[${ICU_SPACE}]*[:：=][${ICU_SPACE}]*[^${ICU_SPACE}，。；;]+|https?://[^${ICU_SPACE}]+[?][^${ICU_SPACE}]+)`, 'giu');

/** A bounded, untrusted summary; never a system instruction or a credential store. */
export class QQMemorySummary {
  constructor({text, updatedAt} = {}) { this.text = text; this.updatedAt = updatedAt; }
  get expired() { return (Date.now() - this.updatedAt.getTime()) / 1000 > 90 * 86400; }
  /**
   * With a string: Swift's `decode(_ raw: String, now:)`, which checks and redacts a model's output.
   * With an object: the synthesized Codable decoder (the legacy `memories` in qq-state.json).
   */
  static decode(raw, now = new Date()) {
    if (typeof raw !== 'string') {
      const c = container(raw, 'QQMemorySummary');
      return new QQMemorySummary({text: c.need('text', decodeString), updatedAt: c.need('updatedAt', decodeDate)});
    }
    // An over-long text is refused outright; text that is not JSON at all throws the parser's own error, as
    // JSONSerialization's does in Swift.
    const parsed = Buffer.byteLength(raw) <= 24000 ? JSON.parse(raw) : undefined;
    const object = isObject(parsed) ? parsed : undefined;
    const value = asString(object?.summary);
    if (!object || Object.keys(object).length !== 1 || value === undefined || value === '') throw CoreError.invalid('记忆摘要格式无效');
    const redacted = value.replace(redaction, '[敏感信息已省略]');
    return new QQMemorySummary({text: prefix(redacted, 2000), updatedAt: now});
  }
  toJSON() { return {text: this.text, updatedAt: encodeDate(this.updatedAt)}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

// Port of QQRuntimeRecord.swift.
import {graphemes} from './swift.mjs';
import {QQMemoryBook} from './core/QQMemoryBook.mjs';
import {icuBoundary} from './foundation.mjs';

const titles = {queued: '等待处理', generating: '正在生成', sending: '正在发送', confirmed: '已获发送确认', skipped: '已跳过',
  failed: '处理失败', uncertain: '发送结果未知', cancelled: '已取消'};
const addresses = new RegExp(String.raw`(?:https?|wss?|file)://[^\s<>]+|(?:/Users/|/home/|[A-Z]:\\)[^\s<>]+|${icuBoundary}[0-9a-f]{32}\.[a-z0-9_-]+${icuBoundary}`, 'giu');
// CharacterSet.controlCharacters is the Cc and Cf categories.
const control = /[\p{Cc}\p{Cf}]/u;

/// A bounded display projection shared by the native panel and authenticated Web API.
/// It is not another log store and must never include message bodies or credential fields.
export class QQRuntimeRecord {
  /** init(_ entry: LogEntry, target: QQTarget?, secrets: [String]) — `new QQRuntimeRecord(entry, target, secrets)`
   *  or `new QQRuntimeRecord(entry, {target, secrets})`; `QQRuntimeRecord.from(...)` is the same. */
  constructor(entry, target, secrets) {
    if (target !== null && typeof target === 'object' && !Array.isArray(target) && ('secrets' in target || 'target' in target) && secrets === undefined) {
      ({target, secrets} = target);
    }
    secrets = secrets ?? [];
    this.id = entry.id; this.timestamp = entry.date.getTime() / 1000; this.state = entry.state;
    this.title = titles[entry.state];
    // Error descriptions can contain URLs or credentials. Mask loaded values
    // before truncation, and also mask recognizable historical credential forms.
    const display = (raw, limit) => {
      let value = raw;
      const known = [...new Set(secrets.filter(secret => secret !== ''))].sort((a, b) => graphemes(b).length - graphemes(a).length);
      for (const secret of known) value = value.replaceAll(secret, '[凭证已隐藏]');
      value = QQMemoryBook.redact(value);
      value = value.replace(addresses, '[地址或凭证已隐藏]');
      const characters = graphemes(value).filter(character => ![...character].some(scalar => control.test(scalar) && scalar !== '\n' && scalar !== '\t'));
      return characters.slice(0, limit).join('') + (characters.length > limit ? '…' : '');
    };
    this.target = target ? (target.group ? '群 · ' : '好友 · ') + display(target.name, 80)
      : (entry.chatID == null ? '引擎' : '历史会话（当前名单外）');
    this.detail = display(entry.detail, 500);
  }
  static from(entry, target, secrets) { return new QQRuntimeRecord(entry, target, secrets); }
  toJSON() {
    return {id: this.id, timestamp: this.timestamp, state: this.state, title: this.title, target: this.target, detail: this.detail};
  }
}

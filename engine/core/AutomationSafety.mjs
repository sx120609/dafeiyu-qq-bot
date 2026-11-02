import fs from 'node:fs';
import path from 'node:path';
import {container, decodeDate, decodeString, deepClone, deepEqual, encodeDate, encodeJSON, trimmed} from './_support.mjs';
import {CoreError, MessagePolicy} from './Domain.mjs';

export class SafetyStop {
  constructor({reason, date = new Date()} = {}) { this.reason = reason; this.date = date; }
  static decode(json) {
    const c = container(json, 'SafetyStop');
    return new SafetyStop({reason: c.need('reason', decodeString), date: c.need('date', decodeDate)});
  }
  toJSON() { return {reason: this.reason, date: encodeDate(this.date)}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

/** Shared by desktop and diagnostic entry points. A malformed/unreadable latch fails closed. */
export class AutomationInterlock {
  /** `file` is a path (Swift: URL). */
  constructor(fields = {}) { this.file = typeof fields === 'string' ? fields : fields.file; this.volatileStop = undefined; }
  currentStop() {
    if (this.volatileStop) return this.volatileStop;
    let data;
    try { data = fs.readFileSync(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    return SafetyStop.decode(JSON.parse(data));
  }
  requireClear() {
    const stop = this.currentStop();
    if (stop) throw CoreError.invalid('微信自动操作已锁定：' + stop.reason);
  }
  trip(reason) {
    const stop = new SafetyStop({reason});
    this.volatileStop = stop; // Remain stopped even when persistence fails.
    fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, encodeJSON(stop), {mode: 0o600});
      fs.renameSync(temporary, this.file);
    } catch (error) { try { fs.rmSync(temporary, {force: true}); } catch {} throw error; }
    fs.chmodSync(this.file, 0o600);
  }
  /** Explicit local user action only. Clearing never starts automation. */
  clear() {
    try { fs.rmSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.volatileStop = undefined;
  }
}

export class SendVerification {
  static matches(expected, observed, ocr) {
    const normalize = text => {
      const value = text.normalize('NFC').replaceAll('\r\n', '\n');
      // OCR line wrapping is not semantic; spaces and punctuation must remain exact.
      return ocr ? value.replaceAll('\n', '') : value;
    };
    return trimmed(expected) !== '' && normalize(expected) === normalize(observed);
  }
  static hasNewLocalEcho(expected, before, after, ocr) {
    const delta = MessagePolicy.delta(before, after);
    if (delta.case !== 'appended') return false;
    const outgoing = delta._0.filter(m => m.direction === 'outgoing');
    return outgoing.length === 1 && outgoing[0].isText && !outgoing[0].deliveryFailed &&
      SendVerification.matches(expected, outgoing[0].text, ocr);
  }
}

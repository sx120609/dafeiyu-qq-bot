import {container, decodeArray, decodeBool, decodeDict, decodeDouble, decodeInt, decodeString, deepClone, deepEqual, validTimeZone,
  Calendar} from './_support.mjs';
import {CoreError} from './Domain.mjs';

const within = (value, low, high) => value >= low && value <= high;

/**
 * Settings for starting private conversations: after a quiet spell the bot may send one message
 * that follows up on something it remembers, or a light greeting. Off by default.
 */
export class QQOutreachConfig {
  constructor({enabled = false, idleMinutes = 24 * 60, cooldownMinutes = 48 * 60, quietStartHour = 23, quietEndHour = 9,
    timeZone = 'Asia/Shanghai', excluded = []} = {}) {
    this.enabled = enabled;
    /** Quiet time with this friend before the bot considers writing first. */
    this.idleMinutes = idleMinutes;
    /** Minimum time between two messages the bot starts with the same friend. */
    this.cooldownMinutes = cooldownMinutes;
    /** No outreach from quietStartHour until quietEndHour (local time in `timeZone`). */
    this.quietStartHour = quietStartHour;
    this.quietEndHour = quietEndHour;
    this.timeZone = timeZone;
    /** Private chats (target keys) left out even when outreach is on. */
    this.excluded = excluded;
  }
  validate() {
    if (!(within(this.idleMinutes, 1, 43200) && within(this.cooldownMinutes, 1, 43200) &&
      within(this.quietStartHour, 0, 23) && within(this.quietEndHour, 0, 23) &&
      validTimeZone(this.timeZone) && this.excluded.length <= 50)) {
      throw CoreError.invalid('主动聊天：间隔 1 分钟到 30 天，免打扰时段 0–23 点，时区必须有效');
    }
  }
  quiet(date) { return QQQuietHours.within(date, this.quietStartHour, this.quietEndHour, this.timeZone); }
  static decode(json) {
    const c = container(json, 'QQOutreachConfig');
    return new QQOutreachConfig({enabled: c.need('enabled', decodeBool), idleMinutes: c.need('idleMinutes', decodeInt),
      cooldownMinutes: c.need('cooldownMinutes', decodeInt), quietStartHour: c.need('quietStartHour', decodeInt),
      quietEndHour: c.need('quietEndHour', decodeInt), timeZone: c.need('timeZone', decodeString), excluded: c.need('excluded', decodeArray(decodeString))});
  }
  toJSON() {
    return {enabled: this.enabled, idleMinutes: this.idleMinutes, cooldownMinutes: this.cooldownMinutes, quietStartHour: this.quietStartHour,
      quietEndHour: this.quietEndHour, timeZone: this.timeZone, excluded: this.excluded};
  }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

/**
 * Hours in which the bot keeps to itself in groups: no joining conversations and no emoji reactions
 * unprompted. Direct @ mentions, replies to it and commands are answered as usual.
 */
export class QQQuietHours {
  constructor({enabled = false, startHour = 2, endHour = 8, timeZone = 'Asia/Shanghai'} = {}) {
    /** Off until the owner turns it on, so behaviour (and the test suite) does not depend on the clock. */
    this.enabled = enabled;
    this.startHour = startHour; this.endHour = endHour; this.timeZone = timeZone;
  }
  validate() {
    if (!(within(this.startHour, 0, 23) && within(this.endHour, 0, 23) && validTimeZone(this.timeZone))) {
      throw CoreError.invalid('安静时段的小时数或时区无效');
    }
  }
  quiet(date) { return this.enabled && QQQuietHours.within(date, this.startHour, this.endHour, this.timeZone); }
  static within(date, start, end, timeZone) {
    if (start === end || !validTimeZone(timeZone)) return false;
    const hour = new Calendar(timeZone).component('hour', date);
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }
  static decode(json) {
    const c = container(json, 'QQQuietHours');
    return new QQQuietHours({enabled: c.need('enabled', decodeBool), startHour: c.need('startHour', decodeInt),
      endHour: c.need('endHour', decodeInt), timeZone: c.need('timeZone', decodeString)});
  }
  toJSON() { return {enabled: this.enabled, startHour: this.startHour, endHour: this.endHour, timeZone: this.timeZone}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

/** What the bot remembers about each private chat's rhythm. Persisted with the engine state. */
export class QQOutreachLedger {
  constructor({lastIncoming = {}, lastSent = {}, awaitingReply = [], lastConsidered = {}} = {}) {
    /** Last time the friend wrote (or the first time the chat was observed, which starts the clock). */
    this.lastIncoming = lastIncoming;
    this.lastSent = lastSent;
    /** Chats where the bot wrote first and the friend has not answered yet. */
    this.awaitingReply = awaitingReply;
    /** Last time the model was asked; a decision not to write is respected for a while. */
    this.lastConsidered = lastConsidered;
  }
  considered(key, time) { this.lastConsidered[key] = time; }
  observe(key, now) { if (this.lastIncoming[key] === undefined) this.lastIncoming[key] = now; }
  incoming(key, time) {
    this.lastIncoming[key] = Math.max(this.lastIncoming[key] ?? 0, time);
    this.awaitingReply = this.awaitingReply.filter(item => item !== key);
  }
  sent(key, time) {
    this.lastSent[key] = time;
    if (!this.awaitingReply.includes(key)) this.awaitingReply.push(key);
  }
  /**
   * Due when the chat has been quiet long enough, the cooldown has passed, it is not quiet hours,
   * and the last message the bot started was answered. One unanswered message is the limit.
   */
  due(key, now, config) {
    const incoming = this.lastIncoming[key];
    if (!config.enabled || config.excluded.includes(key) || this.awaitingReply.includes(key) || incoming === undefined) return false;
    const lastActivity = Math.max(incoming, this.lastSent[key] ?? 0);
    // After a "not now" the chat is reconsidered at most every six hours (or the cooldown, if shorter).
    const retry = Math.min(config.cooldownMinutes, 360) * 60;
    if (!(now - lastActivity >= config.idleMinutes * 60 &&
      now - (this.lastSent[key] ?? 0) >= config.cooldownMinutes * 60 &&
      now - (this.lastConsidered[key] ?? 0) >= retry)) return false;
    return !config.quiet(new Date(now * 1000));
  }
  static decode(json) {
    const c = container(json, 'QQOutreachLedger');
    return new QQOutreachLedger({lastIncoming: c.need('lastIncoming', decodeDict(decodeDouble)), lastSent: c.need('lastSent', decodeDict(decodeDouble)),
      awaitingReply: c.need('awaitingReply', decodeArray(decodeString)), lastConsidered: c.need('lastConsidered', decodeDict(decodeDouble))});
  }
  toJSON() { return {lastIncoming: this.lastIncoming, lastSent: this.lastSent, awaitingReply: this.awaitingReply, lastConsidered: this.lastConsidered}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

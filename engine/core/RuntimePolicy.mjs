import {uuid} from '../swift.mjs';
import {container, decodeArray, decodeDate, decodeDict, decodeDouble, decodeInt, decodeString, decodeUUID, deepClone, deepEqual,
  encodeDate, Calendar} from './_support.mjs';
import {CoreError} from './Domain.mjs';

/** Monotonic scheduling: AX events coalesce; missing events are covered by bounded idle probes. */
export class ReadSchedule {
  constructor() { this.lastRead = undefined; this.nextProbe = 0; this.idleSeconds = 1; this.pendingEvent = false; }
  isDue(now, event) {
    this.pendingEvent = this.pendingEvent || event;
    if (this.lastRead === undefined) return true;
    return now >= this.nextProbe || (this.pendingEvent && now - this.lastRead >= 1);
  }
  didRead(now, changed) {
    this.lastRead = now; this.pendingEvent = false;
    this.idleSeconds = changed ? 1 : Math.min(8, this.idleSeconds * 2);
    this.nextProbe = now + this.idleSeconds;
  }
  clone() { return deepClone(this); }
}

export class SendLimits {
  // The counts are kept for the console's numbers; nothing is refused on them any more (11-03: "把乱七八糟的过度防护全拆了").
  constructor({daily = 100, perChatDaily = 30, globalIntervalSeconds = 1, hourly} = {}) {
    this.daily = daily; this.perChatDaily = perChatDaily; this.globalIntervalSeconds = globalIntervalSeconds;
    /** Most messages in any one hour, across all chats (a person does not keep up a steady stream for hours). */
    this.hourly = hourly;
  }
  get effectiveHourly() { return this.hourly ?? 90; }
  validate() {
    const within = (value, low, high) => value >= low && value <= high;
    if (!(within(this.daily, 1, 10000) && within(this.perChatDaily, 1, 10000) && within(this.globalIntervalSeconds, 1, 300) &&
      within(this.effectiveHourly, 1, 1000))) throw CoreError.invalid('发送限额或间隔超出范围');
  }
  static decode(json) {
    const c = container(json, 'SendLimits');
    return new SendLimits({daily: c.need('daily', decodeInt), perChatDaily: c.need('perChatDaily', decodeInt),
      globalIntervalSeconds: c.need('globalIntervalSeconds', decodeInt), hourly: c.maybe('hourly', decodeInt)});
  }
  toJSON() { return {daily: this.daily, perChatDaily: this.perChatDaily, globalIntervalSeconds: this.globalIntervalSeconds, hourly: this.hourly}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

/** A plain enum (no raw values in Swift): the case name stands for it. */
export class SendAllowance {
  static allowed = 'allowed';
  static globalLimit = 'globalLimit';
  static chatLimit = 'chatLimit';
  static cooldown = 'cooldown';
  static hourlyLimit = 'hourlyLimit';
  static all = ['allowed', 'globalLimit', 'chatLimit', 'cooldown', 'hourlyLimit'];
}

/** Counts reserved send attempts, including uncertain submissions; never refunds an unknown result. */
export class SendUsage {
  constructor({day = '', attempts = 0, confirmed = 0, uncertain = 0, byChat = {}, pending = new Set(), lastGlobal, lastByChat = {},
    recent, jitter} = {}) {
    this.day = day; this.attempts = attempts; this.confirmed = confirmed; this.uncertain = uncertain; this.byChat = byChat;
    /** Set of ticket UUIDs. */
    this.pending = pending;
    this.lastGlobal = lastGlobal;
    /** chat UUID -> Date. */
    this.lastByChat = lastByChat;
    /** Sends of the last hour (seconds since 1970) and the jitter drawn for the next gap. */
    this.recent = recent;
    this.jitter = jitter;
  }
  /** Sends in the last `seconds`. */
  sent(seconds, now = new Date()) { return (this.recent ?? []).filter(time => now.getTime() / 1000 - time < seconds).length; }
  /**
   * The gap before the next message: the configured interval, longer when the last ten minutes were busy, up to
   * half a minute. QQ's risk control watches for a steady machine rhythm (11-01: kicked again after a busy night).
   */
  static pacedGap(base, lastTenMinutes) { return Math.min(30, base * (1 + Math.max(0, lastTenMinutes - 8) / 4)); }
  rollover(now = new Date(), calendar = Calendar.current) {
    const c = calendar.dateComponents(now);
    const today = `${c.year}-${c.month}-${c.day}`;
    if (this.day !== today) { this.day = today; this.attempts = 0; this.confirmed = 0; this.uncertain = 0; this.byChat = {}; this.pending = new Set(); }
  }
  /** `chat` is the chat's UUID string. */
  /** Only the plain gap between two messages and the per-chat cooldown: no daily, per-chat or hourly cap, no
   *  slowing down when busy and no random jitter (11-03: the owner had all of it removed). */
  allowance(chat, limits, chatCooldown, now = new Date()) {
    this.rollover(now);
    if (this.lastGlobal && (now - this.lastGlobal) / 1000 < limits.globalIntervalSeconds) return SendAllowance.cooldown;
    const last = this.lastByChat[chat];
    if (last && (now - last) / 1000 < chatCooldown) return SendAllowance.cooldown;
    return SendAllowance.allowed;
  }
  reserve(chat, limits, chatCooldown, now = new Date()) {
    if (this.allowance(chat, limits, chatCooldown, now) !== SendAllowance.allowed) {
      throw CoreError.invalid('发送额度或冷却条件不满足，未提交发送');
    }
    const ticket = uuid(); this.attempts += 1; this.byChat[chat] = (this.byChat[chat] ?? 0) + 1;
    this.lastGlobal = now; this.lastByChat[chat] = now; this.pending.add(ticket);
    const seconds = now.getTime() / 1000;
    this.recent = [...(this.recent ?? []).filter(time => seconds - time < 3600), seconds];
    return ticket;
  }
  finish(ticket, confirmed, now = new Date()) {
    this.rollover(now);
    if (!this.pending.delete(ticket)) return;
    if (confirmed) this.confirmed += 1; else this.uncertain += 1;
  }
  /**
   * QQ refused the message (muted, for example): nothing went out, so it is neither confirmed nor
   * uncertain. The attempt still counts toward the limits.
   */
  refused(ticket, now = new Date()) {
    this.rollover(now); this.pending.delete(ticket);
  }
  recoverInterrupted(now = new Date()) {
    this.rollover(now); this.uncertain += this.pending.size; this.pending = new Set();
  }
  static decode(json) {
    const c = container(json, 'SendUsage');
    return new SendUsage({day: c.need('day', decodeString), attempts: c.need('attempts', decodeInt), confirmed: c.need('confirmed', decodeInt),
      uncertain: c.need('uncertain', decodeInt), byChat: c.need('byChat', decodeDict(decodeInt)),
      pending: new Set(c.need('pending', decodeArray(decodeUUID))), lastGlobal: c.maybe('lastGlobal', decodeDate),
      lastByChat: c.need('lastByChat', decodeDict(decodeDate)), recent: c.maybe('recent', decodeArray(decodeDouble)),
      jitter: c.maybe('jitter', decodeDouble)});
  }
  toJSON() {
    return {day: this.day, attempts: this.attempts, confirmed: this.confirmed, uncertain: this.uncertain, byChat: this.byChat,
      pending: [...this.pending], lastGlobal: encodeDate(this.lastGlobal),
      lastByChat: Object.fromEntries(Object.entries(this.lastByChat).map(([key, date]) => [key, encodeDate(date)])),
      recent: this.recent, jitter: this.jitter};
  }
  clone() { return deepClone(this); }
}

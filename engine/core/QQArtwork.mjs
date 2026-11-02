import {count, graphemes} from '../swift.mjs';
import {compareStrings, container, decodeArray, decodeBool, decodeDate, decodeDict, decodeInt, decodeString, decodeType, decodeUUID,
  deepClone, deepEqual, encodeDate, hasControlCharacters, iso8601, isNumber, parseURL, trimmed, validTimeZone, Calendar,
  ICU_END, ICU_SPACE} from './_support.mjs';
import {CoreError} from './Domain.mjs';
import {QQConfig} from './QQPolicy.mjs';

const within = (value, low, high) => value >= low && value <= high;
const pixivHosts = ['www.pixiv.net', 'pixiv.net'];
const languages = ['en', 'zh', 'zh-tw', 'ja', 'ko'];
// Swift's split(separator:) leaves out empty pieces.
const pieces = (value, separator) => value.split(separator).filter(part => part !== '');

export class QQArtworkConfig {
  constructor({enabled = false, agentEnabled = true, dailyPerChat = 20, networkDailyLimit = 300, minLongEdge = 1400, minShortEdge = 720,
    repeatDays = 7, searchMinBookmarks, pixivArtistIDs = ['688570', '212801', '17429', '1039353', '1554775', '27517'], artistNames,
    imagePermissions = {'688570': 'https://www.pixiv.net/users/688570'}, scheduleEnabled = false, scheduleTargets = [], scheduleHour = 19,
    scheduleMinute = 0, scheduleTimeZone = 'Asia/Shanghai', scheduleMode = 'hot', scheduleFrequency} = {}) {
    this.enabled = enabled; this.agentEnabled = agentEnabled; this.dailyPerChat = dailyPerChat; this.networkDailyLimit = networkDailyLimit;
    this.minLongEdge = minLongEdge; this.minShortEdge = minShortEdge; this.repeatDays = repeatDays;
    this.searchMinBookmarks = searchMinBookmarks;
    this.pixivArtistIDs = pixivArtistIDs;
    // Optional for compatibility with configurations saved before artist management.
    this.artistNames = artistNames;
    // Legacy operator-supplied evidence retained for compatibility; no longer gates public-image retrieval.
    this.imagePermissions = imagePermissions;
    this.scheduleEnabled = scheduleEnabled; this.scheduleTargets = scheduleTargets; this.scheduleHour = scheduleHour;
    this.scheduleMinute = scheduleMinute; this.scheduleTimeZone = scheduleTimeZone; this.scheduleMode = scheduleMode;
    this.scheduleFrequency = scheduleFrequency;
  }
  get effectiveSearchMinBookmarks() { return this.searchMinBookmarks ?? 1000; }
  set effectiveSearchMinBookmarks(value) { this.searchMinBookmarks = value; }
  get effectiveScheduleFrequency() { return this.scheduleFrequency ?? 'daily'; }
  validate() {
    const names = Object.entries(this.artistNames ?? {}), permissions = Object.entries(this.imagePermissions);
    if (!(within(this.dailyPerChat, 1, 1000) && within(this.networkDailyLimit, 10, 2000) &&
      within(this.minLongEdge, 0, 4096) && within(this.minShortEdge, 0, 4096) && this.minLongEdge >= this.minShortEdge &&
      within(this.repeatDays, 1, 7) && within(this.effectiveSearchMinBookmarks, 1, 1_000_000) && this.pixivArtistIDs.length <= 20 &&
      new Set(this.pixivArtistIDs).size === this.pixivArtistIDs.length && this.pixivArtistIDs.every(QQConfig.validID) &&
      names.length <= 20 && names.every(([key, value]) => this.pixivArtistIDs.includes(key) && value !== '' && count(value) <= 80 && !hasControlCharacters(value)) &&
      permissions.length <= 20 && permissions.every(([key, value]) => QQConfig.validID(key) && QQArtworkConfig.evidenceURL(value)) &&
      within(this.scheduleHour, 0, 23) && within(this.scheduleMinute, 0, 59) && validTimeZone(this.scheduleTimeZone) &&
      ['hot', 'featured'].includes(this.scheduleMode) && ['daily', 'hourly'].includes(this.effectiveScheduleFrequency) && this.scheduleTargets.length <= 20 &&
      new Set(this.scheduleTargets).size === this.scheduleTargets.length &&
      this.scheduleTargets.every(key => { const p = pieces(key, ':'); return p.length === 2 && ['private', 'group'].includes(p[0]) && QQConfig.validID(p[1]); }))) {
      throw CoreError.invalid('插画配置无效：检查尺寸、收藏门槛（1–1000000）、额度、画师 ID、许可链接或定时时间与目标');
    }
  }
  static artistID(input) {
    const value = trimmed(input);
    if (QQConfig.validID(value)) return value;
    const url = count(value) <= 500 ? parseURL(value) : undefined;
    if (!(url && url.scheme === 'https' && pixivHosts.includes(url.host ?? '') &&
      url.user === undefined && url.password === undefined && url.port === undefined)) {
      throw CoreError.invalid('请输入 Pixiv 画师数字 ID 或 https://www.pixiv.net/users/ID 主页链接');
    }
    const parts = pieces(url.path, '/');
    if (parts.length === 3 && languages.includes(parts[0])) parts.shift();
    if (!(parts.length === 2 && parts[0] === 'users' && QQConfig.validID(parts[1]))) {
      throw CoreError.invalid('需要画师主页链接，不能使用作品链接');
    }
    return parts[1];
  }
  static evidenceURL(value) {
    const u = count(value) <= 1000 ? parseURL(value) : undefined;
    if (!(u && u.scheme === 'https' && u.host && u.host.includes('.') && u.user === undefined && u.password === undefined && u.port === undefined)) return false;
    return true; // Stored evidence only; never fetched by the downloader.
  }
  dueDate(now, since) {
    if (!this.enabled || !this.scheduleEnabled || !validTimeZone(this.scheduleTimeZone)) return undefined;
    const calendar = new Calendar(this.scheduleTimeZone);
    const due = this.effectiveScheduleFrequency === 'hourly'
      ? new Date(calendar.startOfHour(now).getTime() + this.scheduleMinute * 60_000)
      : calendar.dateBySetting(this.scheduleHour, this.scheduleMinute, 0, now);
    if (!(due >= since && now >= due && (now - due) / 1000 < 60)) return undefined;
    return due;
  }
  scheduleKey(account, target, due) {
    const calendar = new Calendar(validTimeZone(this.scheduleTimeZone) ? this.scheduleTimeZone : undefined);
    // Hourly slots use the absolute hour, keeping repeated DST hours distinct.
    if (this.effectiveScheduleFrequency === 'hourly') {
      const hour = calendar.startOfHour(due);
      return `${account}:${target}:hour:${Math.trunc(hour.getTime() / 1000)}`;
    }
    const p = calendar.dateComponents(due);
    return `${account}:${target}:${p.year}-${p.month}-${p.day}`;
  }
  static decode(json) {
    const c = container(json, 'QQArtworkConfig');
    return new QQArtworkConfig({enabled: c.need('enabled', decodeBool), agentEnabled: c.need('agentEnabled', decodeBool),
      dailyPerChat: c.need('dailyPerChat', decodeInt), networkDailyLimit: c.need('networkDailyLimit', decodeInt),
      minLongEdge: c.need('minLongEdge', decodeInt), minShortEdge: c.need('minShortEdge', decodeInt), repeatDays: c.need('repeatDays', decodeInt),
      searchMinBookmarks: c.maybe('searchMinBookmarks', decodeInt), pixivArtistIDs: c.need('pixivArtistIDs', decodeArray(decodeString)),
      artistNames: c.maybe('artistNames', decodeDict(decodeString)), imagePermissions: c.need('imagePermissions', decodeDict(decodeString)),
      scheduleEnabled: c.need('scheduleEnabled', decodeBool), scheduleTargets: c.need('scheduleTargets', decodeArray(decodeString)),
      scheduleHour: c.need('scheduleHour', decodeInt), scheduleMinute: c.need('scheduleMinute', decodeInt),
      scheduleTimeZone: c.need('scheduleTimeZone', decodeString), scheduleMode: c.need('scheduleMode', decodeString),
      scheduleFrequency: c.maybe('scheduleFrequency', decodeString)});
  }
  toJSON() {
    return {enabled: this.enabled, agentEnabled: this.agentEnabled, dailyPerChat: this.dailyPerChat, networkDailyLimit: this.networkDailyLimit,
      minLongEdge: this.minLongEdge, minShortEdge: this.minShortEdge, repeatDays: this.repeatDays, searchMinBookmarks: this.searchMinBookmarks,
      pixivArtistIDs: this.pixivArtistIDs, artistNames: this.artistNames, imagePermissions: this.imagePermissions, scheduleEnabled: this.scheduleEnabled,
      scheduleTargets: this.scheduleTargets, scheduleHour: this.scheduleHour, scheduleMinute: this.scheduleMinute, scheduleTimeZone: this.scheduleTimeZone,
      scheduleMode: this.scheduleMode, scheduleFrequency: this.scheduleFrequency};
  }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

const commandPattern = new RegExp(`^/(artists|artist|search|next|hot|art|id)(?=${ICU_END}|[${ICU_SPACE}]|[\\u{3400}-\\u{9fff}])`, 'iu');

export class QQArtworkRequest {
  constructor({mode, query = '', prompt} = {}) { this.mode = mode; this.query = query; this.prompt = prompt; }
  static navigation = `────────\n【继续操作】\n• /next [新关键词] → 下一张\n• /search 关键词或作品ID → 搜图\n• /hot [关键词] → 日榜\n• /persona → 会话性格\n• /search help → 完整用法`;
  static help = `【插画命令】
不调用大模型 · 仅已启用会话可用
────────
01｜统一搜图
/search 关键词
优先收藏达标作品；本轮无达标图时按真实热度选保底图，并注明降级。

02｜作品直查
/search 作品ID或Pixiv作品链接
/id 作品ID
直接查询指定作品，不要求收藏门槛；仍检查图片可用性、画质与去重。

03｜每日榜单
/hot [关键词]
从第1名按序取图，不限画师与题材；填写关键词则在榜内筛选。

04｜继续看图
/next [新关键词]
沿用上次搜索或榜单；填写新关键词则替换条件。
ID查询没有下一张，可用 /next 新关键词 开始搜索。
────────
【输入示例】
• /search 白发 猫耳 -黑丝
• /search https://www.pixiv.net/artworks/53325959

【小提示】
• /art 是 /search 的兼容别名，无需选择两个入口。
• /artist 与 /artists 已退役；发图仍附画师署名。
• 支持常见标签译名、多关键词和 -词 排除。
• 收藏是热度参考；保底只放宽热度，不保证总有结果。
• /search help → 再看帮助`;
  /** Parse an identifier into a canonical Pixiv work ID; never fetch user-supplied URLs. */
  static artworkID(input) {
    if (QQConfig.validID(input)) return input;
    const url = count(input) <= 500 ? parseURL(input) : undefined;
    if (!(url && url.scheme === 'https' && pixivHosts.includes(url.host ?? '') &&
      url.user === undefined && url.password === undefined && url.port === undefined)) return undefined;
    const parts = pieces(url.path, '/');
    if (parts.length === 3 && languages.includes(parts[0])) parts.shift();
    if (!(parts.length === 2 && parts[0] === 'artworks' && QQConfig.validID(parts[1]))) return undefined;
    return parts[1];
  }
  static parse(text) {
    const value = trimmed(text);
    const match = commandPattern.exec(value);
    if (!match) return undefined;
    const verb = match[0].toLowerCase();
    const query = trimmed(value.slice(match[0].length));
    if (!(count(query) <= 500 && !hasControlCharacters(query) && !query.includes('[CQ:'))) return new QQArtworkRequest({mode: 'help'});
    if (['/artist', '/artists'].includes(verb)) return new QQArtworkRequest({mode: 'retiredArtist'});
    if (['help', '帮助', '?'].includes(query.toLowerCase())) return new QQArtworkRequest({mode: 'help'});
    if (['/search', '/art', '/id'].includes(verb)) {
      const id = QQArtworkRequest.artworkID(query);
      if (id !== undefined) return new QQArtworkRequest({mode: 'id', query: id});
      if (!(verb !== '/id' && query !== '' && !graphemes(query).every(isNumber) && !query.includes('://') && count(query) <= 80)) return new QQArtworkRequest({mode: 'help'});
      return new QQArtworkRequest({mode: 'search', query});
    }
    if (!(count(query) <= 80 && !query.includes('://'))) return new QQArtworkRequest({mode: 'help'});
    return new QQArtworkRequest({mode: verb === '/hot' ? 'hot' : 'next', query});
  }
  static decode(json) {
    const c = container(json, 'QQArtworkRequest');
    return new QQArtworkRequest({mode: c.need('mode', decodeString), query: c.need('query', decodeString), prompt: c.maybe('prompt', decodeString)});
  }
  toJSON() { return {mode: this.mode, query: this.query, prompt: this.prompt}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

export class QQArtworkDelivery {
  constructor({ticket, scope, artworkID, hash, at, state} = {}) {
    this.ticket = ticket; this.scope = scope; this.artworkID = artworkID; this.hash = hash; this.at = at; this.state = state;
  }
  static decode(json) {
    const c = container(json, 'QQArtworkDelivery');
    return new QQArtworkDelivery({ticket: c.need('ticket', decodeUUID), scope: c.need('scope', decodeString), artworkID: c.need('artworkID', decodeString),
      hash: c.maybe('hash', decodeString), at: c.need('at', decodeDate), state: c.need('state', decodeString)});
  }
  toJSON() { return {ticket: this.ticket, scope: this.scope, artworkID: this.artworkID, hash: this.hash, at: encodeDate(this.at), state: this.state}; }
  clone() { return deepClone(this); }
}

const WEEK = 7 * 86400;
export class QQArtworkLedger {
  constructor({deliveries = [], continuation = {}, schedules = {}, networkDay = '', networkCalls = 0} = {}) {
    this.deliveries = deliveries;
    /** scope -> QQArtworkRequest. */
    this.continuation = continuation;
    /** schedule key -> Date. */
    this.schedules = schedules;
    this.networkDay = networkDay; this.networkCalls = networkCalls;
  }
  excludes(scope, id, hash, days, now = new Date()) {
    return this.deliveries.some(d => d.scope === scope && (now - d.at) / 1000 < Math.min(days, 7) * 86400 &&
      (d.artworkID === id || (hash !== undefined && d.hash === hash)));
  }
  allowed(scope, limit, now = new Date()) {
    const calendar = Calendar.current;
    return this.deliveries.filter(d => d.scope === scope && calendar.isDate(d.at, now)).length < limit;
  }
  reserve(ticket, scope, id, hash, request, now = new Date()) {
    this.deliveries.push(new QQArtworkDelivery({ticket, scope, artworkID: id, hash, at: now, state: 'sending'}));
    this.continuation[scope] = request;
    this.trim(now);
  }
  finish(ticket, confirmed) {
    const delivery = this.deliveries.find(d => d.ticket === ticket);
    if (delivery) delivery.state = confirmed ? 'confirmed' : 'unknown';
  }
  recover() {
    for (const delivery of this.deliveries) if (delivery.state === 'sending') delivery.state = 'unknown';
    this.trim();
  }
  reserveNetwork(limit, now = new Date()) {
    const day = iso8601(Calendar.current.startOfDay(now));
    if (this.networkDay !== day) { this.networkDay = day; this.networkCalls = 0; }
    if (!(this.networkCalls < limit)) throw CoreError.invalid('今日插画来源请求额度已用完，未调用模型');
    this.networkCalls += 1;
  }
  trim(now = new Date()) {
    this.deliveries = this.deliveries.filter(d => (now - d.at) / 1000 < WEEK).slice(-20000);
    this.schedules = Object.fromEntries(Object.entries(this.schedules).filter(([, date]) => (now - date) / 1000 < WEEK));
    // An empty result still establishes a search intent for /next; no delivery is required.
    const entries = Object.entries(this.continuation);
    if (entries.length > 100) {
      this.continuation = Object.fromEntries(entries.sort((a, b) => compareStrings(a[0], b[0])).slice(0, 100));
    }
  }
  static decode(json) {
    const c = container(json, 'QQArtworkLedger');
    return new QQArtworkLedger({deliveries: c.need('deliveries', decodeArray(decodeType(QQArtworkDelivery))),
      continuation: c.need('continuation', decodeDict(decodeType(QQArtworkRequest))), schedules: c.need('schedules', decodeDict(decodeDate)),
      networkDay: c.need('networkDay', decodeString), networkCalls: c.need('networkCalls', decodeInt)});
  }
  toJSON() {
    return {deliveries: this.deliveries, continuation: this.continuation,
      schedules: Object.fromEntries(Object.entries(this.schedules).map(([key, date]) => [key, encodeDate(date)])),
      networkDay: this.networkDay, networkCalls: this.networkCalls};
  }
  clone() { return deepClone(this); }
}


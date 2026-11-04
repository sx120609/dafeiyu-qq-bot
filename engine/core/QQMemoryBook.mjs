import {count, graphemes, prefix, sha256, uuid} from '../swift.mjs';
import {asInt, asObjects, asString, asStrings, compareStrings, container, decodeArray, decodeDate, decodeInt, decodeString, decodeType,
  deepClone, deepEqual, encodeDate, encodeJSON, iso8601, ICU_DOT, ICU_SPACE, jsonObject, trimmed} from './_support.mjs';
import {CoreError} from './Domain.mjs';

const DAY = 86400;
const addDays = (date, days) => new Date(date.getTime() + days * DAY * 1000);
const secondsBetween = (later, earlier) => (later.getTime() - earlier.getTime()) / 1000;

export class QQMemoryOptions {
  constructor({messageThreshold = 20, characterThreshold = 6000, intervalMinutes = 10, retrievalCharacters = 1800} = {}) {
    this.messageThreshold = messageThreshold; this.characterThreshold = characterThreshold;
    this.intervalMinutes = intervalMinutes; this.retrievalCharacters = retrievalCharacters;
  }
  validate() {
    const within = (value, low, high) => value >= low && value <= high;
    if (!(within(this.messageThreshold, 4, 100) && within(this.characterThreshold, 1000, 20000) &&
      within(this.intervalMinutes, 1, 120) && within(this.retrievalCharacters, 600, 4000))) {
      throw CoreError.invalid('记忆整理范围：4–100 条、1000–20000 字符、1–120 分钟；检索预算 600–4000 字符');
    }
  }
  static decode(json) {
    const c = container(json, 'QQMemoryOptions');
    return new QQMemoryOptions({messageThreshold: c.need('messageThreshold', decodeInt), characterThreshold: c.need('characterThreshold', decodeInt),
      intervalMinutes: c.need('intervalMinutes', decodeInt), retrievalCharacters: c.need('retrievalCharacters', decodeInt)});
  }
  toJSON() {
    return {messageThreshold: this.messageThreshold, characterThreshold: this.characterThreshold, intervalMinutes: this.intervalMinutes,
      retrievalCharacters: this.retrievalCharacters};
  }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

export class QQMemoryEvent {
  /** The init redacts and bounds the text; decoding keeps the stored text as it is (synthesized Codable). */
  constructor({id, subject, text, at, userID} = {}) {
    this.id = id; this.subject = subject; this.text = prefix(QQMemoryBook.redact(text), 1200); this.at = at; this.userID = userID;
  }
  static decode(json) {
    const c = container(json, 'QQMemoryEvent');
    const event = Object.create(QQMemoryEvent.prototype);
    event.id = c.need('id', decodeString); event.subject = c.need('subject', decodeString);
    event.text = c.need('text', decodeString); event.at = c.need('at', decodeDate);
    event.userID = c.maybe('userID', decodeString);
    return event;
  }
  toJSON() { return {id: this.id, subject: this.subject, text: this.text, at: encodeDate(this.at), userID: this.userID}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

export class QQMemoryItem {
  constructor({id = uuid(), subject, kind, text, keywords, importance, sourceIDs, updatedAt, expiresAt, invalidatedAt, scope = 'session'} = {}) {
    this.id = id; this.subject = subject; this.kind = kind; this.text = text; this.keywords = keywords; this.importance = importance;
    this.sourceIDs = sourceIDs; this.updatedAt = updatedAt; this.expiresAt = expiresAt; this.invalidatedAt = invalidatedAt;
    this.scope = scope;
  }
  current(now) { return this.invalidatedAt === undefined && this.expiresAt > now; }
  static decode(json) {
    const c = container(json, 'QQMemoryItem');
    return new QQMemoryItem({id: c.need('id', decodeString), subject: c.need('subject', decodeString), kind: c.need('kind', decodeString),
      text: c.need('text', decodeString), keywords: c.need('keywords', decodeArray(decodeString)), importance: c.need('importance', decodeInt),
      sourceIDs: c.need('sourceIDs', decodeArray(decodeString)), updatedAt: c.need('updatedAt', decodeDate),
      expiresAt: c.need('expiresAt', decodeDate), invalidatedAt: c.maybe('invalidatedAt', decodeDate), scope: c.maybe('scope', decodeString) ?? 'session'});
  }
  toJSON() {
    return {id: this.id, subject: this.subject, kind: this.kind, text: this.text, keywords: this.keywords, importance: this.importance,
      sourceIDs: this.sourceIDs, updatedAt: encodeDate(this.updatedAt), expiresAt: encodeDate(this.expiresAt), invalidatedAt: encodeDate(this.invalidatedAt), scope: this.scope};
  }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

class Change {
  constructor({operation, replaces, subject, kind, text, keywords, importance, sourceID, evidence, days, scope = 'session'} = {}) {
    this.operation = operation; this.replaces = replaces; this.subject = subject; this.kind = kind; this.text = text;
    this.keywords = keywords; this.importance = importance; this.sourceID = sourceID; this.evidence = evidence; this.days = days;
    this.scope = scope;
  }
  /**
   * Swift's `init?(_ fields: [String: Any])`. Optional fields fall back to defaults: one change missing `replaces` or
   * `days` used to fail the whole batch. Returns undefined when subject, kind or sourceID is missing.
   */
  static fromFields(fields) {
    const subject = asString(fields.subject), kind = asString(fields.kind);
    const number = asInt(fields.sourceID);
    const sourceID = asString(fields.sourceID) ?? (number === undefined ? undefined : String(number));
    if (subject === undefined || kind === undefined || sourceID === undefined) return undefined;
    return new Change({operation: asString(fields.operation) ?? 'upsert', replaces: asStrings(fields.replaces) ?? [], subject, kind, sourceID,
      text: asString(fields.text) ?? '', keywords: (asStrings(fields.keywords) ?? []).slice(0, 6), importance: asInt(fields.importance) ?? 2,
      evidence: asString(fields.evidence) ?? '', days: asInt(fields.days) ?? 90, scope: asString(fields.scope) ?? 'session'});
  }
  /** Synthesized Decodable (every key required). */
  static decode(json) {
    const c = container(json, 'QQMemoryDelta.Change');
    return new Change({operation: c.need('operation', decodeString), replaces: c.need('replaces', decodeArray(decodeString)),
      subject: c.need('subject', decodeString), kind: c.need('kind', decodeString), text: c.need('text', decodeString),
      keywords: c.need('keywords', decodeArray(decodeString)), importance: c.need('importance', decodeInt), sourceID: c.need('sourceID', decodeString),
      evidence: c.need('evidence', decodeString), days: c.need('days', decodeInt), scope: c.maybe('scope', decodeString) ?? 'session'});
  }
}

export class QQMemoryDelta {
  static Change = Change;
  constructor({summary, changes} = {}) { this.summary = summary; this.changes = changes; }
  /**
   * Lenient on shape, strict on content: a code fence, an extra field, an over-long summary or a thirteenth change
   * used to reject the batch, and the same batch then failed every 60 seconds. Each change is still checked
   * against its evidence when it is applied.
   * With a string this is Swift's `decode(_ raw: String)`; with an object it is the synthesized Decodable.
   */
  static decode(raw) {
    if (typeof raw !== 'string') {
      const c = container(raw, 'QQMemoryDelta');
      return new QQMemoryDelta({summary: c.need('summary', decodeString), changes: c.need('changes', decodeArray(decodeType(Change)))});
    }
    if (Buffer.byteLength(raw) > 24000) throw CoreError.invalid('记忆整理输出过长');
    let body = trimmed(raw);
    const characters = graphemes(body), open = characters.indexOf('{'), close = characters.lastIndexOf('}');
    if (open >= 0 && close >= 0 && open < close) body = characters.slice(open, close + 1).join('');
    const fields = jsonObject(body);
    if (!fields) throw CoreError.invalid('记忆整理输出不是 JSON：' + prefix(raw, 60));
    const summary = prefix(asString(fields.summary) ?? '', 400);
    const changes = (asObjects(fields.changes) ?? []).map(Change.fromFields).filter(Boolean).slice(0, 12);
    return new QQMemoryDelta({summary, changes});
  }
}
export {Change as QQMemoryDelta_Change};

const allowedKinds = ['preference', 'fact', 'task', 'event', 'cue'];
const redaction = new RegExp(`(sk-[a-z0-9_-]+|cfut_[a-z0-9_-]+|bearer[${ICU_SPACE}]+[a-z0-9._-]+|(?:密码|口令|密钥|token|api${ICU_DOT}?key)[${ICU_SPACE}]*[:：=][${ICU_SPACE}]*[^${ICU_SPACE}，。；;]+|https?://[^${ICU_SPACE}]+[?][^${ICU_SPACE}]+)`, 'giu');
const dropped = /[\p{Z}\t\n\v\f\r\u0085\p{P}\p{S}]/gu;

/** Session journals and separate user books share a format; only explicit user facts cross chats. */
export class QQMemoryBook {
  constructor({pending = [], recent = [], items = [], knownIDs = [], lastCompactedAt, droppedEvents = 0} = {}) {
    this.pending = pending; this.recent = recent; this.items = items; this.knownIDs = knownIDs;
    this.lastCompactedAt = lastCompactedAt; this.droppedEvents = droppedEvents;
  }
  static subject(account, target, sender) {
    if (sender === account) return 'OWNER';
    if (target.startsWith('private:')) return 'PEER';
    const digest = sha256(Buffer.from(account + ':' + target + ':' + sender, 'utf8'));
    return 'MEMBER_' + digest.subarray(0, 6).toString('hex');
  }
  static userKey(account, user) { return account + ':' + user; }
  // 2026-11-04: "只共享以该用户为主体的记忆"; episodes, group events and taught cues stay local.
  static scope(scope, kind) { return scope === 'global' && ['preference', 'fact', 'task'].includes(kind) ? 'global' : 'session'; }
  static redact(text) { return text.replace(redaction, '[敏感信息省略]'); }
  /** @discardableResult */
  append(event) {
    if (event.text === '' || this.knownIDs.includes(event.id)) return false;
    this.knownIDs.push(event.id); this.knownIDs = this.knownIDs.slice(-1024);
    this.recent.push(event); this.recent = this.recent.sort((a, b) => a.at - b.at).slice(-24);
    if (!['BOT', 'SELF_UNKNOWN'].includes(event.subject)) {
      this.pending.push(event); this.pending.sort((a, b) => a.at - b.at);
      if (this.pending.length > 128) { this.droppedEvents += this.pending.length - 128; this.pending = this.pending.slice(-128); }
    }
    return true;
  }
  due(options, now = new Date()) {
    const oldest = this.pending[0];
    if (!oldest) return false;
    return this.pending.length >= options.messageThreshold || this.pending.reduce((sum, event) => sum + count(event.text), 0) >= options.characterThreshold ||
      secondsBetween(now, oldest.at) >= options.intervalMinutes * 60;
  }
  batch() {
    const result = [];
    let size = 0;
    for (const event of this.pending.slice(0, 32)) {
      // JSONEncoder with .iso8601 dates.
      const cost = count(encodeJSON(event, {dates: 'iso8601'})) + 1;
      if (size + cost > 7500) break;
      result.push(event); size += cost;
    }
    return result;
  }
  /**
   * A fact the agent was told to keep, written at once instead of waiting for the next consolidation. The
   * caller checks that `subject` and `sourceID` belong to this batch.
   */
  remember(subject, kind, text, keywords, sourceID, now = new Date(), scope = 'session') {
    const clean = QQMemoryBook.redact(trimmed(text));
    if (!(allowedKinds.includes(kind) && clean !== '' && count(clean) <= 180)) throw CoreError.invalid('记忆内容无效');
    if (this.items.some(item => item.subject === subject && item.text === clean && item.current(now))) return;
    const days = kind === 'event' ? 90 : kind === 'task' ? 30 : 365;
    this.items.push(new QQMemoryItem({subject, kind, text: clean, keywords: keywords.slice(0, 6).map(word => QQMemoryBook.redact(prefix(word, 20))).filter(word => word !== ''),
      importance: kind === 'cue' ? 3 : 2, sourceIDs: [sourceID], updatedAt: now, expiresAt: addDays(now, days), scope: QQMemoryBook.scope(scope, kind)}));
  }
  /** Validate every mutation against supplied evidence and candidates, then apply atomically. `candidateIDs` is a Set. */
  apply(delta, batch, candidateIDs, now = new Date(), userBooks = new Map()) {
    if (!(candidateIDs instanceof Set)) candidateIDs = new Set(candidateIDs ?? []);
    const sources = new Map(batch.map(event => [event.id, event]));
    const pendingIDs = new Set(this.pending.map(event => event.id));
    if (batch.length === 0 || ![...sources.keys()].every(id => pendingIDs.has(id))) throw CoreError.invalid('记忆批次已变化');
    // Each change is checked on its own: one that cites the wrong evidence or person is dropped, the
    // rest still count. Rejecting the whole batch for one slip lost memories whenever a model phrased
    // things a little differently, and retried the same batch forever.
    // Only who it is about is strict: a fact must belong to the person whose message it came from. Everything
    // else is repaired rather than thrown away (11-01: "把硬丢弃都拿掉"): unknown replaces are left out,
    // lengths and numbers are clamped, a misquoted evidence line no longer costs the memory.
    const changes = delta.changes.flatMap(item => {
      const source = sources.get(item.sourceID);
      if (!source || source.subject !== item.subject) return [];
      // A paraphrased quote is fine; a quote sharing almost nothing with what was said is an invented fact.
      const spoken = QQMemoryBook.squeezed(source.text), said = new Set(graphemes(spoken)), quoted = QQMemoryBook.squeezed(item.evidence);
      const quotedCharacters = graphemes(quoted);
      if (!(quoted === '' || spoken.includes(quoted) || quotedCharacters.filter(c => said.has(c)).length >= quotedCharacters.length * 0.6)) return [];
      const scope = userBooks.has(item.subject) ? QQMemoryBook.scope(item.scope, item.kind) : 'session';
      const destination = scope === 'global' ? userBooks.get(item.subject) : this;
      const subject = scope === 'global' ? 'USER' : item.subject;
      const replaces = item.replaces.filter(id => candidateIDs.has(id) && destination.items.some(entry => entry.id === id && entry.subject === subject && entry.current(now))).slice(0, 6);
      const operation = item.operation === 'forget' ? 'forget' : 'upsert';
      const text = prefix(trimmed(item.text), 180);
      if (!(operation === 'forget' ? replaces.length > 0 : text !== '')) return [];
      return [new Change({operation, replaces, subject: item.subject, scope,
        kind: allowedKinds.includes(item.kind) ? item.kind : 'fact', text: operation === 'forget' ? '' : text,
        keywords: item.keywords.map(word => prefix(word, 20)).filter(word => word !== '').slice(0, 6),
        importance: Math.min(3, Math.max(1, item.importance)), sourceID: item.sourceID,
        evidence: prefix(item.evidence, 200), days: Math.min(365, Math.max(1, item.days))})];
    });
    // Old versions remain marked as historical.
    for (const change of changes) {
      const destination = change.scope === 'global' ? userBooks.get(change.subject) : this;
      const subject = change.scope === 'global' ? 'USER' : change.subject;
      const obsoleteSources = new Set(destination.items.filter(item => change.replaces.includes(item.id)).flatMap(item => item.sourceIDs));
      for (const item of destination.items) {
        if (change.replaces.includes(item.id) || (item.kind === 'episode' && item.sourceIDs.some(id => obsoleteSources.has(id)))) item.invalidatedAt = now;
      }
      if (change.operation !== 'upsert') continue;
      const text = QQMemoryBook.redact(change.text);
      if (destination.items.some(item => item.subject === subject && item.text === text && item.current(now))) continue;
      const days = Math.min(change.days, change.kind === 'event' ? 90 : change.kind === 'task' ? 30 : 365);
      destination.items.push(new QQMemoryItem({subject, kind: change.kind, text, keywords: change.keywords.map(QQMemoryBook.redact),
        importance: change.importance, sourceIDs: [change.sourceID], updatedAt: now, expiresAt: addDays(now, days), scope: change.scope}));
    }
    if (trimmed(delta.summary) !== '') {
      this.items.push(new QQMemoryItem({subject: 'CONVERSATION', kind: 'episode', text: QQMemoryBook.redact(delta.summary), keywords: [], importance: 1,
        sourceIDs: batch.map(event => event.id), updatedAt: now, expiresAt: addDays(now, 90)}));
    }
    const active = this.items.filter(item => item.kind !== 'episode' && item.current(now))
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt).slice(0, 256);
    const historical = this.items.filter(item => !item.current(now) && secondsBetween(now, item.invalidatedAt ?? item.expiresAt) < 90 * DAY).slice(-64);
    const episodes = this.items.filter(item => item.kind === 'episode' && item.current(now)).slice(-64);
    this.items = [...active, ...historical, ...episodes];
    this.pending = this.pending.filter(event => !sources.has(event.id)); this.lastCompactedAt = now;
  }
  /**
   * Catchphrases the chat taught the bot ("有人说「老王开播了」就接「真的假的」") whose trigger, one of the
   * item's keywords of three characters or more, appears in `text`, ignoring spaces and punctuation.
   */
  cues(text, now = new Date()) {
    const said = QQMemoryBook.squeezed(text);
    if (said === '') return [];
    return this.items.filter(item => item.kind === 'cue' && item.current(now) &&
      item.keywords.some(keyword => { const trigger = QQMemoryBook.squeezed(keyword); return count(trigger) >= 3 && said.includes(trigger); }));
  }
  static squeezed(text) { return text.toLowerCase().replace(dropped, ''); }
  /** What is currently remembered about one person, newest first (for "/记忆"). */
  remembered(subject, now = new Date()) {
    return this.items.filter(item => item.subject === subject && item.kind !== 'episode' && item.current(now)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  /**
   * "/忘记 关键词": the person's current memories mentioning the keyword stop counting (kept as history
   * only until they age out, like any corrected memory). `remove` also erases historical versions,
   * so a globally forgotten fact cannot surface in another chat's historical search. Returns the texts.
   */
  forget(subject, keyword, now = new Date(), remove = false) {
    const needle = keyword.toLowerCase();
    const forgotten = [];
    for (const item of this.items) {
      if (item.subject === subject && item.kind !== 'episode' && (remove || item.current(now)) &&
        (item.text.toLowerCase().includes(needle) || item.keywords.some(word => word.toLowerCase().includes(needle)))) {
        item.invalidatedAt = now; forgotten.push(item.text);
      }
    }
    if (remove) this.items = this.items.filter(item => !(item.subject === subject && forgotten.includes(item.text)));
    return forgotten;
  }
  importLegacy(text, subject, at) {
    const characters = graphemes(prefix(QQMemoryBook.redact(text), 2000));
    for (let offset = 0; offset < characters.length; offset += 600) {
      const fragment = characters.slice(offset, Math.min(offset + 600, characters.length)).join('');
      this.items.push(new QQMemoryItem({subject, kind: 'legacy', text: fragment, keywords: [], importance: 1, sourceIDs: [], updatedAt: at, expiresAt: addDays(at, 90)}));
    }
  }
  static decode(json) {
    const c = container(json, 'QQMemoryBook');
    return new QQMemoryBook({pending: c.need('pending', decodeArray(decodeType(QQMemoryEvent))), recent: c.need('recent', decodeArray(decodeType(QQMemoryEvent))),
      items: c.need('items', decodeArray(decodeType(QQMemoryItem))), knownIDs: c.need('knownIDs', decodeArray(decodeString)),
      lastCompactedAt: c.maybe('lastCompactedAt', decodeDate), droppedEvents: c.need('droppedEvents', decodeInt)});
  }
  toJSON() {
    return {pending: this.pending, recent: this.recent, items: this.items, knownIDs: this.knownIDs, lastCompactedAt: encodeDate(this.lastCompactedAt),
      droppedEvents: this.droppedEvents};
  }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

/** Inverted lexical index: rebuilt only on compaction/migration, never calls an embedding service. */
export class QQMemoryIndex {
  /** Swift: QQMemoryIndex(_ items:). Takes the item array (or {items}). */
  constructor(items = []) {
    if (!Array.isArray(items)) items = items.items ?? [];
    this.records = new Map(items.map(item => [item.id, item]));
    this.postings = new Map();
    for (const item of items) {
      for (const term of QQMemoryIndex.terms(item.text + ' ' + item.keywords.join(' '))) {
        if (!this.postings.has(term)) this.postings.set(term, new Set());
        this.postings.get(term).add(item.id);
      }
    }
  }
  static terms(text) {
    const scalars = Array.from(text.toLowerCase()).slice(0, 12000);
    const words = new Set();
    let word = '', chinese;
    for (const c of scalars) {
      const value = c.codePointAt(0);
      if (value >= 0x3400 && value <= 0x9fff) {
        if (word) { words.add(word); word = ''; }
        if (chinese !== undefined) words.add(chinese + c);
        chinese = c;
      } else {
        chinese = undefined;
        if (/[\p{L}\p{M}\p{N}]/u.test(c)) word += c;
        else if (word) { words.add(word); word = ''; }
      }
    }
    if (word) words.add(word);
    return words;
  }
  search(query, subject, limit = 12, now = new Date(), history = false) {
    const scores = new Map();
    const add = (id, value) => scores.set(id, (scores.get(id) ?? 0) + value);
    for (const term of QQMemoryIndex.terms(query)) {
      const matches = this.postings.get(term) ?? new Set();
      const weight = Math.log(1 + (this.records.size + 1) / (matches.size + 1));
      for (const id of matches) add(id, weight);
    }
    // Small persistent context even without word overlap: what is known about the current speaker,
    // and the latest conversation summaries, so "还记得我吗" or a new model still finds its footing.
    const subjects = new Set(Array.isArray(subject) ? subject : [subject]);
    for (const item of this.records.values()) if (subjects.has(item.subject) && ['preference', 'task', 'fact', 'legacy'].includes(item.kind)) add(item.id, 1);
    for (const item of [...this.records.values()].filter(item => item.kind === 'episode' && item.current(now)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2)) add(item.id, 0.8);
    const scored = [];
    for (const [id, score] of scores) {
      const item = this.records.get(id);
      if (!item || !(item.current(now) || (history && secondsBetween(now, item.invalidatedAt ?? item.expiresAt) < 90 * DAY))) continue;
      const freshness = 1 / (1 + Math.max(0, secondsBetween(now, item.updatedAt)) / DAY);
      scored.push([item, score + item.importance * 0.15 + freshness * 0.3 + (subjects.has(item.subject) ? 0.5 : 0)]);
    }
    return scored.sort((a, b) => a[1] === b[1] ? compareStrings(a[0].id, b[0].id) : b[1] - a[1]).slice(0, Math.max(0, limit)).map(([item]) => item);
  }
  context(query, subject, characters, now = new Date()) {
    const historical = ['以前', '过去', '之前', '曾经', '改前'].some(word => query.includes(word));
    const lines = [];
    let used = 0;
    for (const item of this.search(query, subject, 12, now, historical)) {
      const state = !item.current(now) ? '历史/已失效，不能当作现在' : item.kind === 'legacy' ? '旧摘要/未经逐条核验' : item.kind === 'episode' ? '历史片段/当时状态' : '已记录';
      const line = `[${item.subject}·${item.scope === 'global' ? '全局用户' : '本会话'}·${item.kind}·${iso8601(item.updatedAt).slice(0, 10)}·${state}] ${item.text}`;
      if (used + count(line) + 1 > characters) continue;
      lines.push(line); used += count(line) + 1;
    }
    return lines.join('\n');
  }
}

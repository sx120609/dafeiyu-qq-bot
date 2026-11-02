// Types and small helpers of QQEngine.swift, shared by QQEngine.mjs and QQEngine.agent.mjs (both re-export them).
import {AppFailure, uuid, dateFromSwift, dateToSwift} from './swift.mjs';
import {CancellationError} from './BoundedDownload.mjs';
import {QQRepair} from './QQRepair.mjs';
import {QQPolicy} from './core/QQPolicy.mjs';

/** `Int64(value) != nil` */
export const isInt64 = value => typeof value === 'string' && /^[+-]?\d+$/.test(value) && BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n;
/** The local time zone's identifier (TimeZone.current.identifier). */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// MARK: Small Foundation stand-ins

export const identifier = value => QQPolicy.identifier(value);
/** `(value as? NSNumber)?.intValue`: JSON numbers (truncated) and booleans. */
export const intValue = value => typeof value === 'number' ? Math.trunc(value) : typeof value === 'boolean' ? Number(value) : undefined;
/** `(value as? NSNumber)?.doubleValue` */
export const doubleValue = value => typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : undefined;
/** `error.localizedDescription` */
export const describe = error => error?.message ?? String(error);
export const isCancellation = error => error instanceof CancellationError || error?.name === 'AbortError';
/** Swift's DateFormatter with a fixed pattern (yyyy MM M dd d HH mm), in the given or the local time zone. */
export function formatDate(date, pattern, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric',
    minute: 'numeric', hourCycle: 'h23'}).formatToParts(date).map(part => [part.type, part.value]));
  const pad = value => String(value).padStart(2, '0');
  return pattern.replace(/yyyy|MM|M|dd|d|HH|mm/g, token => ({yyyy: parts.year, MM: pad(parts.month), M: String(Number(parts.month)),
    dd: pad(parts.day), d: String(Number(parts.day)), HH: pad(Number(parts.hour) % 24), mm: pad(parts.minute)})[token]);
}
/** ISO8601DateFormatter().string(from:) */
export const iso8601 = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Runs work the way `Task { }` does on the main actor: after the current job, errors caught. */
// A fault in a background task is reported for repair as well as logged (QQRepair, 11-03).
export const task = work => { Promise.resolve().then(work).catch(error => { if (!isCancellation(error)) { console.error(error); QQRepair.capture(error); } }); };
export const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// No plaintext fallback for macOS Keychain. Windows / Linux credentials are deliberately session-only (LinuxSupport).
export const Keychain = {
  load() { return ''; },
  save() { throw new AppFailure('Windows / Linux 版仅支持本次运行凭证，请取消保存到钥匙串'); }
};

export const required = (json, key) => {
  if (json[key] === undefined || json[key] === null) throw new TypeError(`缺少字段 ${key}`);
  return json[key];
};
export const mapValues = (object, transform) => Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [key, transform(value)]));

// MARK: Stored state

/// One time QQ forced the account offline, with how busy the bot had been in the hour before.
export class QQKick {
  constructor({at, sendsLastHour, sendsLastTenMinutes}) { this.at = at; this.sendsLastHour = sendsLastHour; this.sendsLastTenMinutes = sendsLastTenMinutes; }
  static decode(json) { return new QQKick({at: dateFromSwift(required(json, 'at')), sendsLastHour: required(json, 'sendsLastHour'), sendsLastTenMinutes: required(json, 'sendsLastTenMinutes')}); }
  toJSON() { return {at: dateToSwift(this.at), sendsLastHour: this.sendsLastHour, sendsLastTenMinutes: this.sendsLastTenMinutes}; }
}
/// A line in the agent's own notebook: for one chat (`key`), or for every chat when `key` is empty.
export class QQAgentNote {
  constructor({id, key, at, text}) { this.id = id; this.key = key; this.at = at; this.text = text; }
  static decode(json) { return new QQAgentNote({id: required(json, 'id'), key: required(json, 'key'), at: dateFromSwift(required(json, 'at')), text: required(json, 'text')}); }
  toJSON() { return {id: this.id, key: this.key, at: dateToSwift(this.at), text: this.text}; }
}
/// Something the agent set itself to come back to (a reminder, a follow-up question). Kept across restarts.
export class QQAgentReminder {
  constructor({id, key, chat, due, setAt, about, say}) {
    this.id = id; this.key = key; this.chat = chat; this.due = due; this.setAt = setAt; this.about = about;
    /// Sent as it is when the chat has no recent context to think it over with (after a restart, say).
    this.say = say;
  }
  static decode(json) {
    return new QQAgentReminder({id: required(json, 'id'), key: required(json, 'key'), chat: required(json, 'chat'), due: dateFromSwift(required(json, 'due')),
      setAt: dateFromSwift(required(json, 'setAt')), about: required(json, 'about'), say: required(json, 'say')});
  }
  toJSON() { return {id: this.id, key: this.key, chat: this.chat, due: dateToSwift(this.due), setAt: dateToSwift(this.setAt), about: this.about, say: this.say}; }
}
/// Something that happened to the bot rather than a message: being poked, a quiet friend due a hello.
export class QQAgentEvent {
  constructor({text, sender, outreach = false}) { this.text = text; this.sender = sender; this.outreach = outreach; }
}
/// A slow tool call that outlived its turn: it carries on, and its result wakes the chat's agent.
export class QQAgentJob {
  constructor({tool, detail, id = uuid(), started = new Date(), result = ''}) { this.id = id; this.tool = tool; this.detail = detail; this.started = started; this.result = result; }
  clone() { return new QQAgentJob(this); }
}
/// The tools the agent wrote for itself, as offered in one turn; refreshed when it writes another.
export class QQAgentToolBox {
  constructor() { this.definitions = []; }
  get names() { return new Set(this.definitions.map(item => item?.function?.name).filter(name => typeof name === 'string')); }
}
/// Lets only the first of several racing callers through.
export class QQAgentGate {
  constructor() { this.used = false; }
  open() { const first = !this.used; this.used = true; return first; }
}
/// What one agent turn may act on and what it has done so far; grows as messages arrive during the turn.
export class QQAgentTurnState {
  constructor() {
    this.messages = new Set();
    this.members = {};
    this.inputs = {};
    this.calling = false;
    /// Something anyone can read went out (a message, sticker, voice, picture).
    this.spoke = false;
    this.nudged = false;
    this.lateLooks = 0;
    this.sent = [];
    this.consumed = [];
    this.lastSentAt = undefined;
    this.previous = '';
    this.ownerChecked = false;
    this.ownerAnswered = false;
    /// When the first message of the turn went out.
    this.firstSentAt = undefined;
  }
}
/// One agent-mode turn, for the console's agent page: what came in, what it looked up, what it decided and did.
export class QQAgentTurn {
  static Errand = class Errand {
    constructor({tool, detail, result}) { this.tool = tool; this.detail = detail; this.result = result; }
    static decode(json) { return new QQAgentTurn.Errand({tool: required(json, 'tool'), detail: required(json, 'detail'), result: required(json, 'result')}); }
    toJSON() { return {tool: this.tool, detail: this.detail, result: this.result}; }
  };
  constructor({id = uuid(), at, chat, key, batch, errands = [], decision = 'thinking', sent = [], note = '', seconds = 0, tokens = 0,
    rounds, roundUsage, modelSeconds, toolSeconds, waitSeconds, firstSendSeconds}) {
    this.id = id; this.at = at; this.chat = chat; this.key = key;
    this.batch = batch;
    this.errands = errands;
    /// thinking, reply, silence, wait or failed.
    this.decision = decision;
    this.sent = sent;
    this.note = note;
    this.seconds = seconds;
    this.tokens = tokens;
    // Where a turn's time and tokens go (11-03, measured to make it faster); optional, so older saved turns load.
    /// Director rounds (model calls), and each round's seconds, input/output/cached tokens and tool calls.
    this.rounds = rounds;
    this.roundUsage = roundUsage;
    /// Seconds waiting for the model, and carrying out tools (including the typing pauses between messages).
    this.modelSeconds = modelSeconds;
    this.toolSeconds = toolSeconds;
    /// From the batch's first message to the start of the turn, and from the start to the first message sent.
    this.waitSeconds = waitSeconds;
    this.firstSendSeconds = firstSendSeconds;
  }
  static decode(json) {
    return new QQAgentTurn({id: required(json, 'id'), at: dateFromSwift(required(json, 'at')), chat: required(json, 'chat'), key: required(json, 'key'),
      batch: required(json, 'batch'), errands: required(json, 'errands').map(QQAgentTurn.Errand.decode), decision: required(json, 'decision'),
      sent: required(json, 'sent'), note: required(json, 'note'), seconds: required(json, 'seconds'), tokens: required(json, 'tokens'),
      ...QQAgentTurn.timings(json)});
  }
  static timings(json) {
    const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const rows = Array.isArray(json.roundUsage) ? json.roundUsage.filter(row => row && typeof row === 'object').map(row =>
      ({seconds: number(row.seconds) ?? 0, input: number(row.input) ?? 0, output: number(row.output) ?? 0, cached: number(row.cached) ?? 0, calls: number(row.calls) ?? 0})) : undefined;
    return {rounds: number(json.rounds), roundUsage: rows, modelSeconds: number(json.modelSeconds), toolSeconds: number(json.toolSeconds),
      waitSeconds: number(json.waitSeconds), firstSendSeconds: number(json.firstSendSeconds)};
  }
  toJSON() { return this.encode(dateToSwift(this.at)); }
  /** The control page's encoder (dateEncodingStrategy = .secondsSince1970) writes the date as Unix seconds. */
  toJSONSince1970() { return this.encode(this.at.getTime() / 1000); }
  encode(at) {
    return {id: this.id, at, chat: this.chat, key: this.key, batch: this.batch,
      errands: this.errands.map(errand => errand.toJSON()), decision: this.decision, sent: this.sent, note: this.note, seconds: this.seconds, tokens: this.tokens,
      // Optional timing fields, left out while unknown (a turn still thinking, or one saved before 11-03).
      ...Object.fromEntries(['rounds', 'roundUsage', 'modelSeconds', 'toolSeconds', 'waitSeconds', 'firstSendSeconds']
        .filter(name => this[name] !== undefined).map(name => [name, this[name]]))};
  }
}
export const QQAgentTurn_Errand = QQAgentTurn.Errand;
/// Why one group message did or did not get an answer, so "为什么没回我" can be answered afterwards.
export class QQDecision {
  constructor({at, chat, speaker, text, outcome}) { this.at = at; this.chat = chat; this.speaker = speaker; this.text = text; this.outcome = outcome; }
  static decode(json) {
    return new QQDecision({at: dateFromSwift(required(json, 'at')), chat: required(json, 'chat'), speaker: required(json, 'speaker'), text: required(json, 'text'), outcome: required(json, 'outcome')});
  }
  toJSON() { return {at: dateToSwift(this.at), chat: this.chat, speaker: this.speaker, text: this.text, outcome: this.outcome}; }
}
export class QQContact {
  constructor({number, name, group}) { this.number = number; this.name = name; this.group = group; }
  get id() { return `${this.group ? 'group' : 'private'}:${this.number}`; }
}
// Explicit credentials supplied by the panel or stdin. Never part of QQStored.
export class QQRuntimeCredentials {
  constructor({oneBotToken, deepSeekKey}) { this.oneBotToken = oneBotToken; this.deepSeekKey = deepSeekKey; }
  static decode(json) { return new QQRuntimeCredentials({oneBotToken: required(json, 'oneBotToken'), deepSeekKey: required(json, 'deepSeekKey')}); }
}


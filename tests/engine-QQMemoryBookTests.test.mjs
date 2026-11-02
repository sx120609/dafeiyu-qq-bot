import test from 'node:test';
import assert from 'node:assert/strict';
import {count} from '../engine/swift.mjs';
import {QQMemoryBook, QQMemoryDelta, QQMemoryEvent, QQMemoryIndex, QQMemoryOptions} from '../engine/core/QQMemoryBook.mjs';
import {decodeJSON, deepEqual, encodeJSON} from '../engine/core/_support.mjs';

const now = new Date(1_790_000_000 * 1000);
const later = (date, seconds) => new Date(date.getTime() + seconds * 1000);
const delta = (source, {text = '喜欢清淡的晚饭', replaces = [], operation = 'upsert', subject, evidence} = {}) => QQMemoryDelta.decode(JSON.stringify({summary: '',
  changes: [{operation, replaces, subject: subject ?? source.subject, kind: 'preference', text, keywords: ['晚饭', '饮食', '口味'], importance: 3,
    sourceID: source.id, evidence: evidence ?? source.text, days: 365}]}));
const required = value => { assert.notEqual(value, undefined); return value; };

test('rememberWritesAFactAtOnceWithoutDuplicates', () => {
  const book = new QQMemoryBook();
  book.remember('MEMBER_a', 'cue', '群友教的：有人说「康神开播了」就接「真的假的」', ['康神开播了'], '9', now);
  book.remember('MEMBER_a', 'cue', '群友教的：有人说「康神开播了」就接「真的假的」', [], '9', now);
  assert.ok(book.items.length === 1 && book.items[0].importance === 3);
  assert.equal(book.cues('康神开播了！', now).length, 1);
  assert.throws(() => book.remember('MEMBER_a', 'secret', 'x', [], '9', now));
});

test('decodingToleratesFencesExtraFieldsAndOverlongOutput', () => {
  const change = '{"subject":"PEER","kind":"fact","text":"下周三考有机化学","sourceID":"7","evidence":"下周三考有机"}';
  const many = Array(15).fill(change).join(',');
  const raw = '```json\n{"summary":"' + '长'.repeat(500) + '","changes":[' + many + ',{"text":"缺主体"}],"note":"多余"}\n```';
  const decoded = QQMemoryDelta.decode(raw);
  assert.equal(count(decoded.summary), 400);
  assert.equal(decoded.changes.length, 12);
  assert.ok(decoded.changes[0].replaces.length === 0 && decoded.changes[0].days === 90 && decoded.changes[0].operation === 'upsert');
  assert.throws(() => QQMemoryDelta.decode('好的'));
});

test('taughtCatchphrasesAreKeptAndMatchTheTriggerPhrase', () => {
  const book = new QQMemoryBook();
  const taught = new QQMemoryEvent({id: 't', subject: 'MEMBER_a', text: '我教你一个，以后别人说老王开播了，你就接“真的假的”或者“zdjd”', at: now});
  book.append(taught);
  const data = JSON.stringify({summary: '', changes: [{operation: 'upsert', replaces: [], subject: 'MEMBER_a', kind: 'cue',
    text: '有人说「老王开播了」时接「真的假的」或「zdjd」（MEMBER_a 教的）', keywords: ['老王开播了', '老王'], importance: 3, sourceID: 't',
    evidence: '以后别人说老王开播了', days: 365}]});
  book.apply(QQMemoryDelta.decode(data), [taught], new Set(), now);
  assert.equal(book.cues('老王 开播了！', now).length, 1);
  assert.equal(book.cues('@某人 老王开播了', now).length, 1);
  assert.equal(book.cues('老王今天没播', now).length, 0); // a two-character name alone is no trigger
  assert.equal(book.cues('老王开播了', later(now, 366 * 86400)).length, 0);
});

test('timeCountAndLengthRotateAndPendingSurvivesReload', () => {
  const options = new QQMemoryOptions(); options.messageThreshold = 4; options.characterThreshold = 1000; options.intervalMinutes = 1;
  const book = new QQMemoryBook();
  const e = new QQMemoryEvent({id: '1', subject: 'PEER', text: '我喜欢清淡的晚饭', at: now});
  const added = book.append(e), duplicate = book.append(e); assert.ok(added); assert.ok(!duplicate); assert.ok(!book.due(options, now));
  assert.ok(book.due(options, later(now, 61)));
  const loaded = decodeJSON(QQMemoryBook, encodeJSON(book));
  assert.ok(deepEqual(loaded.pending, [e])); assert.deepEqual(loaded.knownIDs, ['1']);
  for (let n = 2; n <= 4; n++) book.append(new QQMemoryEvent({id: `${n}`, subject: 'PEER', text: '普通问候', at: now}));
  assert.ok(book.due(options, now));
  const long = new QQMemoryBook(); long.append(new QQMemoryEvent({id: '5', subject: 'PEER', text: '长'.repeat(1001), at: now}));
  assert.ok(long.due(options, now));
  book.apply(QQMemoryDelta.decode('{"summary":"","changes":[]}'), book.batch(), new Set(), now);
  assert.equal(book.pending.length, 0); const repeated = book.append(e); assert.ok(!repeated); assert.equal(book.recent.length, 4);
});

test('correctionKeepsHistoryAndRejectsWrongSpeakerOrFabricatedEvidence', () => {
  const book = new QQMemoryBook();
  const original = new QQMemoryEvent({id: '1', subject: 'PEER', text: '我喜欢清淡的晚饭', at: now});
  book.append(original); book.apply(delta(original), [original], new Set(), now);
  const first = required(book.items[0]);
  const correction = new QQMemoryEvent({id: '2', subject: 'PEER', text: '我改口了，现在晚饭喜欢吃辣', at: later(now, 10)});
  book.append(correction);
  // A change with the wrong speaker or made-up evidence is dropped on its own.
  const facts = b => b.items.filter(item => item.kind !== 'episode');
  for (const [bad, candidates] of [[delta(correction, {subject: 'OWNER'}), new Set([first.id])], [delta(correction, {evidence: '没有说过的内容'}), new Set([first.id])]]) {
    const copy = book.clone();
    copy.apply(bad, [correction], candidates, now);
    assert.ok(deepEqual(facts(copy), facts(book)));
  }
  // An out-of-scope replacement or a paraphrased quote no longer costs the memory: it is kept, replacing nothing.
  const loose = book.clone();
  loose.apply(delta(correction, {text: '晚饭改吃辣', replaces: [first.id], evidence: '现在晚饭喜欢辣'}), [correction], new Set(), now);
  assert.ok(facts(loose).length === facts(book).length + 1 && loose.items.some(item => item.id === first.id && item.current(now)));
  book.apply(delta(correction, {text: '现在晚饭喜欢吃辣', replaces: [first.id]}), [correction], new Set([first.id]), later(now, 10));
  const index = new QQMemoryIndex(book.items);
  const current = index.context('晚饭口味', 'PEER', 500, later(now, 20));
  assert.ok(current.includes('现在晚饭喜欢吃辣')); assert.ok(!current.includes('清淡'));
  const history = index.context('以前的晚饭口味', 'PEER', 600, later(now, 20));
  assert.ok(history.includes('历史/已失效')); assert.ok(history.includes('清淡'));
  assert.ok(count(current) <= 500);
  const forget = new QQMemoryEvent({id: '3', subject: 'PEER', text: '撤销我刚才的晚饭喜好记录', at: later(now, 30)});
  book.append(forget); const latest = required(book.items.find(item => item.current(later(now, 30))));
  book.apply(delta(forget, {text: '', replaces: [latest.id], operation: 'forget'}), [forget], new Set([latest.id]), later(now, 30));
  assert.equal(new QQMemoryIndex(book.items).search('晚饭', 'PEER', undefined, later(now, 31)).length, 0);
});

test('isolatedSubjectsSecretRedactionAndBoundedJournal', () => {
  const member = QQMemoryBook.subject('12345', 'group:99999', '54321');
  assert.notEqual(member, QQMemoryBook.subject('12345', 'group:88888', '54321'));
  assert.ok(!member.includes('54321')); assert.equal(QQMemoryBook.subject('12345', 'group:99999', '12345'), 'OWNER');
  const a = new QQMemoryBook(), b = new QQMemoryBook();
  const event = new QQMemoryEvent({id: '1', subject: member, text: '喜欢清淡的晚饭', at: now});
  a.append(event); a.apply(delta(event), [event], new Set(), now);
  assert.equal(new QQMemoryIndex(b.items).search('晚饭', member, undefined, now).length, 0);
  b.append(new QQMemoryEvent({id: 'secret', subject: 'PEER', text: 'API key: sk-syntheticsecret token: cfut_syntheticsecret', at: now}));
  assert.ok(!encodeJSON(b).includes('syntheticsecret'));
  b.append(new QQMemoryEvent({id: 'bot', subject: 'BOT', text: 'BOT 猜测', at: now}));
  assert.equal(b.pending.length, 1);
  for (let i = 0; i < 140; i++) b.append(new QQMemoryEvent({id: `bulk${i}`, subject: 'PEER', text: '合成消息', at: now}));
  assert.equal(b.pending.length, 128); assert.equal(b.recent.length, 24); assert.equal(b.droppedEvents, 13);
});

test('retrievalBenchmarkAndExpiration', () => {
  const book = new QQMemoryBook();
  for (let i = 0; i < 256; i++) {
    const event = new QQMemoryEvent({id: `${i}`, subject: `MEMBER_${i}`, text: `第${i}位成员喜欢清淡晚饭`, at: now});
    book.append(event); book.apply(delta(event, {text: event.text}), [event], new Set(), now);
  }
  const index = new QQMemoryIndex(book.items), start = performance.now();
  for (let i = 0; i < 200; i++) assert.ok(index.search('晚饭', 'MEMBER_42', undefined, now).length > 0);
  const milliseconds = (performance.now() - start) / 200;
  console.log(`QQ memory retrieval benchmark: 256 facts, mean ${milliseconds} ms/query`);
  assert.ok(milliseconds < 50);
  assert.equal(index.search('晚饭', 'MEMBER_42', undefined, later(now, 366 * 86400)).length, 0);
});

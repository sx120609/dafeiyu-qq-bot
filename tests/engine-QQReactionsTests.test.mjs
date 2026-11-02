import test from 'node:test';
import assert from 'node:assert/strict';
import {count} from '../engine/swift.mjs';
import {QQReactionCatalog, QQReactionConfig, QQReactionEmoji} from '../engine/core/QQReactions.mjs';
import {QQTimelineDigest, QQTimelineSummary} from '../engine/core/QQTimelineDigest.mjs';
import {QQGroupContext} from '../engine/core/QQGroupContext.mjs';
import {QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {QQPolicy} from '../engine/core/QQPolicy.mjs';
import {decodeJSON} from '../engine/core/_support.mjs';

const required = value => { assert.notEqual(value, undefined); return value; };

test('savedPreferencesFillTheCatalogueAndBadSettingsAreRejected', () => {
  let config = new QQReactionConfig();
  config.validate();
  // An older saved list (nine faces) still gets the rest of the catalogue, with its own weights kept.
  config.emojis = [new QQReactionEmoji({id: '128051', name: '鲸鱼', weight: 9}), new QQReactionEmoji({id: '999', name: '自定义', weight: 3})];
  const effective = config.effectiveEmojis;
  assert.equal(effective.length, QQReactionConfig.catalog.length + 1);
  assert.equal(effective.find(item => item.id === '128051')?.weight, 9);
  assert.equal(effective.find(item => item.id === '128051')?.hint === '', false);
  assert.equal(effective.at(-1)?.id, '999');
  config.emojis[0].weight = 11;
  assert.throws(() => config.validate());
  config = new QQReactionConfig(); config.emojis[0].id = 'abc';
  assert.throws(() => config.validate());
  // The catalogue itself is a value each config copies, not shared state.
  assert.equal(QQReactionConfig.catalog[0].id, '147');
  // Settings saved by the old small-moves version still decode; only the favourites are kept.
  const old = decodeJSON(QQReactionConfig, '{"enabled":true,"chance":20,"cooldownSeconds":45,"emojis":[{"id":"147","name":"棒棒糖","weight":5}]}');
  assert.deepEqual(old.emojis.map(item => item.id), ['147']);
});

test('olderLinesGiveWayToTheRollingSummary', () => {
  const start = new Date(Date.now() - 600_000);
  const events = Array.from({length: 30}, (_, i) => new QQMemoryEvent({id: `m${i}`, subject: i % 3 === 0 ? 'BOT' : 'MEMBER_a', text: `第${i}句`,
    at: new Date(start.getTime() + i * 10_000)}));
  // Nothing is due until ten lines have left the last dozen.
  assert.equal(QQTimelineDigest.due(events.slice(0, 21), undefined), undefined);
  const batch = required(QQTimelineDigest.due(events, undefined));
  assert.ok(batch.length === 18 && batch.at(-1)?.id === 'm17');
  const summary = new QQTimelineSummary({text: 'MEMBER_a 在数数', throughID: 'm17', at: new Date()});
  assert.equal(QQTimelineDigest.due(events, summary), undefined);
  assert.equal(QQTimelineDigest.carried(new QQTimelineSummary({text: '旧', throughID: 'm1', at: new Date(Date.now() - 3 * 3600_000)})), '');
  assert.equal(QQTimelineDigest.decode('{"summary":"  大家在聊考试  "}'), '大家在聊考试');
  assert.equal(QQTimelineDigest.decode('{"summary":""}'), undefined);
  assert.ok(QQTimelineDigest.lines([events[1]], {m1: '小王'}).includes('MEMBER_a（小王）：第1句'));

  const context = required(QQGroupContext.fromEvents(events, 'm29'));
  const full = context.context(20000);
  const short = context.context(20000, undefined, summary);
  assert.ok(full.includes('第3句') && full.includes('第29句'));
  assert.ok(short.startsWith('[前情摘要]') && short.includes('MEMBER_a 在数数'));
  assert.ok(!short.includes('"第3句"') && !short.includes('第17句') && short.includes('第18句') && short.includes('第29句'));
  assert.ok(count(short) < count(full));
  // A summary that ends outside this timeline is not used.
  assert.ok(!context.context(20000, undefined, new QQTimelineSummary({text: '别处', throughID: 'gone', at: new Date()})).includes('前情摘要'));
});

/** The agent reacts with any QQ face or emoji, written by name; favourites come first and a 0 keeps one out. */
test('everyFaceAndEmojiCanBeNamed', () => {
  const saved = QQPolicy.faceNames;
  try {
    QQPolicy.faceNames = {'271': '吃瓜', '264': '捂脸', '356': '666', '179': 'doge', '8': '睡'};
    const favourites = [new QQReactionEmoji({id: '128051', name: '鲸鱼', weight: 5, hint: '打招呼'}), new QQReactionEmoji({id: '8', name: '睡', weight: 0})];
    const items = QQReactionCatalog.all(favourites);
    assert.ok(items[0]?.id === '128051' && !items.some(item => item.id === '8'));
    assert.equal(items.filter(item => item.id === '128051').length, 1); // the emoji list has it too, under another name
    assert.equal(QQReactionCatalog.resolve('吃瓜', items)?.id, '271');
    assert.equal(QQReactionCatalog.resolve('[捂脸]', items)?.id, '264');
    assert.equal(QQReactionCatalog.resolve('🔥', items)?.id, '128293');
    assert.equal(QQReactionCatalog.resolve('火', items)?.id, '128293');
    assert.equal(QQReactionCatalog.resolve('DOGE', items)?.id, '179');
    assert.equal(QQReactionCatalog.resolve('356', items)?.id, '356');
    assert.equal(QQReactionCatalog.resolve('睡', items), undefined);
    assert.equal(QQReactionCatalog.resolve('不存在的表情', items), undefined);
    assert.equal(QQReactionCatalog.search('吃瓜', items)[0]?.id, '271');
    assert.equal(QQReactionCatalog.search('打招呼', items)[0]?.id, '128051');
  } finally { QQPolicy.faceNames = saved; }
});

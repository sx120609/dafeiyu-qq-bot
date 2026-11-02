import test from 'node:test';
import assert from 'node:assert/strict';
import {QQAdminCommand} from '../engine/core/QQAdminCommand.mjs';
import {QQMemoryBook, QQMemoryDelta, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {QQConfig} from '../engine/core/QQPolicy.mjs';

const C = QQAdminCommand;
const is = (actual, expected) => assert.deepEqual(actual, expected);

test('parsesCommandsAndArguments', () => {
  is(C.parse('/new'), C.newTopic());
  is(C.parse(' /重置 '), C.newTopic());
  is(C.parse('/clear'), C.clear());
  is(C.parse('/help'), C.help());
  is(C.parse('/黑名单'), C.blocklist());
  is(C.parse('/blocklist'), C.blocklist());
  is(C.parse('/拉黑 123456'), C.block('123456'));
  is(C.parse('/拉黑123456'), C.block('123456'));
  is(C.parse('/block 123456'), C.block('123456'));
  is(C.parse('/解除拉黑 123456'), C.unblock('123456'));
  is(C.parse('/unblock 123456'), C.unblock('123456'));
  is(C.parse('/拉黑 @某人', ['654321']), C.block('654321'));
  is(C.parse('/拉黑', ['654321']), C.block('654321'));
  is(C.parse('/记忆'), C.memories()); is(C.parse('/memory'), C.memories());
  is(C.parse('/忘记 生日'), C.forget('生日')); is(C.parse('/忘记生日'), C.forget('生日'));
  assert.equal(C.parse('/忘记')?.case, 'invalid');
  assert.equal(C.parse('/记忆力怎么练'), undefined);
  assert.ok(!C.requiresAdmin(C.memories(), true)); assert.ok(!C.requiresAdmin(C.forget('x'), true));
});

test('peopleCanSeeAndRemoveWhatIsRememberedAboutThem', () => {
  const book = new QQMemoryBook();
  const now = new Date(1_790_000_000 * 1000);
  const event = new QQMemoryEvent({id: '1', subject: 'PEER', text: '我生日是三月五号，喜欢吃辣', at: now});
  book.append(event);
  try {
    book.apply(QQMemoryDelta.decode('{"summary":"","changes":[{"operation":"upsert","replaces":[],"subject":"PEER","kind":"fact","text":"生日是三月五号","keywords":["生日"],"importance":2,"sourceID":"1","evidence":"我生日是三月五号","days":365},{"operation":"upsert","replaces":[],"subject":"PEER","kind":"preference","text":"喜欢吃辣","keywords":["口味"],"importance":2,"sourceID":"1","evidence":"喜欢吃辣","days":365}]}'),
      [event], new Set(), now);
  } catch {}
  assert.equal(book.remembered('PEER', now).length, 2);
  assert.deepEqual(book.forget('PEER', '生日', now), ['生日是三月五号']);
  assert.deepEqual(book.remembered('PEER', now).map(item => item.text), ['喜欢吃辣']);
  assert.equal(book.forget('OWNER', '辣', now).length, 0);
});

test('ignoresOrdinaryTextAndRejectsBadArguments', () => {
  for (const value of ['新的一天', '/newspaper', '/blockchain 是什么', '/persona', '/model', '我想 /new 一下', '/new\n/clear']) {
    assert.equal(C.parse(value), undefined, value);
  }
  assert.equal(C.parse('/拉黑 abc')?.case, 'invalid');
  assert.equal(C.parse('/拉黑 0123')?.case, 'invalid');
  assert.equal(C.parse('/new 123')?.case, 'invalid');
});

test('groupResetsNeedAdmins', () => {
  assert.ok(!C.requiresAdmin(C.newTopic(), false));
  assert.ok(C.requiresAdmin(C.newTopic(), true));
  assert.ok(C.requiresAdmin(C.block('123456'), false));
  assert.ok(!C.requiresAdmin(C.help(), true));
});

test('configRejectsOverlappingLists', () => {
  const config = new QQConfig();
  config.expectedSelfID = '20002';
  config.adminIDs = ['123456']; config.blockedIDs = ['654321'];
  config.validate();
  assert.ok(config.isAdmin('123456') && config.isBlocked('654321') && !config.isBlocked('123456'));
  config.blockedIDs = ['123456'];
  assert.throws(() => config.validate());
  config.blockedIDs = ['abc'];
  assert.throws(() => config.validate());
});

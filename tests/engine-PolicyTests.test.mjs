import test from 'node:test';
import assert from 'node:assert/strict';
import {BotConfig, ChatRule, MessagePolicy, ObservedMessage, RunFence, SnapshotDelta, Usage} from '../engine/core/Domain.mjs';
import {Calendar, encodeJSON} from '../engine/core/_support.mjs';

const m = (text, direction = 'incoming') => new ObservedMessage({text, direction});
const same = (a, b) => assert.ok(SnapshotDelta.equals(a, b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

test('testInitialHistoryDoesNotBecomeNewMessages', () => {
  same(MessagePolicy.delta([], [m('旧消息')]), SnapshotDelta.resync());
});
test('testRepeatedTextPreservesOccurrenceOrder', () => {
  same(MessagePolicy.delta([m('锚点'), m('你好')], [m('锚点'), m('你好'), m('你好')]), SnapshotDelta.appended([m('你好')]));
});
test('testScrollingKeepsOverlapWithoutReplayingOldContent', () => {
  same(MessagePolicy.delta([m('a'), m('b'), m('c')], [m('b'), m('c'), m('d')]), SnapshotDelta.appended([m('d')]));
  same(MessagePolicy.delta([m('b'), m('c')], [m('a'), m('b')]), SnapshotDelta.resync());
});
test('testMissingAnchorNeverRepliesToLastMessageAsFallback', () => {
  same(MessagePolicy.delta([m('a')], [m('旧内容')]), SnapshotDelta.resync());
});
test('testOwnAndUnknownDirectionsRejected', () => {
  const rule = new ChatRule({name: '测试', enabled: true, bound: true});
  assert.notEqual(MessagePolicy.rejection(m('我自己的消息', 'outgoing'), rule), undefined);
  assert.notEqual(MessagePolicy.rejection(m('无法确认', 'unknown'), rule), undefined);
  assert.equal(MessagePolicy.rejection(m('正常收到'), rule), undefined);
});
test('testGroupTextMentionNotEnough', () => {
  const rule = new ChatRule({name: '测试群', kind: 'group', enabled: true, selfName: '小明', bound: true});
  assert.notEqual(MessagePolicy.rejection(new ObservedMessage({text: '@小明 你好', direction: 'incoming', mention: 'textOnly'}), rule), undefined);
  assert.equal(MessagePolicy.rejection(new ObservedMessage({text: '@小明 你好', direction: 'incoming', mention: 'verified'}), rule), undefined);
});
test('testMentionRequiresExactBoundaryAndEscapesRegex', () => {
  assert.ok(MessagePolicy.hasMentionText('@小明 你好', '小明'));
  assert.ok(MessagePolicy.hasMentionText('@A.B 你好', 'A.B'));
  assert.ok(!MessagePolicy.hasMentionText('@小明同学 你好', '小明'));
  assert.ok(!MessagePolicy.hasMentionText('@AxB 你好', 'A.B'));
  assert.ok(!MessagePolicy.hasMentionText('@其他人 你好', ''));
});
test('testUnboundAndDisabledChatsNeverSend', () => {
  assert.notEqual(MessagePolicy.rejection(m('hello'), new ChatRule({name: '测试', enabled: true})), undefined);
  assert.notEqual(MessagePolicy.rejection(m('hello'), new ChatRule({name: '测试', bound: true})), undefined);
});
test('testNonTextRejected', () => {
  assert.notEqual(MessagePolicy.rejection(new ObservedMessage({text: '[语音]', direction: 'incoming', isText: false}),
    new ChatRule({name: '测试', enabled: true, bound: true})), undefined);
});
test('testPauseAndRestartInvalidateInFlightReplies', () => {
  const fence = new RunFence(); fence.start(); const epoch = fence.epoch;
  assert.ok(fence.permits(epoch)); fence.stop(); assert.ok(!fence.permits(epoch));
  fence.start(); assert.ok(!fence.permits(epoch)); assert.ok(fence.permits(fence.epoch));
});
test('testDailyBudgetCountsEachAttemptAndResets', () => {
  const usage = new Usage(), today = new Date();
  const first = usage.reserve(2, today), second = usage.reserve(2, today);
  const third = usage.reserve(2, today);
  assert.ok(first && second && !third); assert.equal(usage.calls, 2);
  const tomorrow = usage.reserve(2, new Date(today.getTime() + 86400_000));
  assert.ok(tomorrow); assert.equal(usage.calls, 1);
});
test('testCrossMidnightWindow', () => {
  const config = new BotConfig(); config.workHoursEnabled = true; config.workStart = 22; config.workEnd = 7;
  const cal = new Calendar('UTC');
  const date = h => cal.date({year: 2026, month: 9, day: 25, hour: h});
  assert.ok(config.inWorkHours(date(23), cal)); assert.ok(config.inWorkHours(date(6), cal));
  assert.ok(!config.inWorkHours(date(7), cal)); assert.ok(!config.inWorkHours(date(12), cal));
});
test('testConfigRejectsDuplicatesAndUnverifiedActivation', () => {
  const c = new BotConfig(); c.chats = [new ChatRule({name: '重复'}), new ChatRule({name: '重复'})];
  assert.throws(() => c.validate());
  c.chats = [new ChatRule({name: '未验证', enabled: true})]; assert.throws(() => c.validate());
  c.chats = [new ChatRule({name: '群', kind: 'group', enabled: true, bound: true})]; assert.throws(() => c.validate());
});
test('testConfigDoesNotContainSecrets', () => {
  const text = encodeJSON(new BotConfig()).toLowerCase();
  assert.ok(!text.includes('api_key')); assert.ok(!text.includes('apikey')); assert.ok(!text.includes('sk-'));
});

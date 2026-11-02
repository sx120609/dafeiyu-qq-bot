import test from 'node:test';
import assert from 'node:assert/strict';
import {QQConversationFlow} from '../engine/core/QQConversationFlow.mjs';

test('normalUsersAndOtherMembersRemainUnaffected', () => {
  const flow = new QQConversationFlow();
  for (let index = 0; index < 12; index++) {
    const now = index * 12 + 100;
    const silenced = flow.shouldSilence('group:test', 'human', `正常用户的不同问题 ${index} 怎么解决`, now);
    assert.ok(!silenced);
    flow.sent('group:test', 'human', `对应问题的回答 ${index}`, `${index}`, false, now + 2);
  }
  const otherSilenced = flow.shouldSilence('group:test', 'other', '我有个新问题', 300);
  assert.ok(!otherSilenced);
});

test('repeatedBotLoopIsLocallySilenced', () => {
  const flow = new QQConversationFlow();
  const repeated = '你好我是一个机器人助手请问我还能帮你做什么';
  let quiet = false;
  for (let index = 0; index < 5; index++) {
    const now = index * 10 + 100;
    quiet = flow.shouldSilence('group:test', 'bot', repeated, now);
    if (!quiet) flow.sent('group:test', 'bot', '你好，请说具体事情', `${index}`, true, now + 2);
  }
  assert.ok(quiet);
  const humanSilenced = flow.shouldSilence('group:test', 'human', '怎么导入图片？', 151);
  assert.ok(!humanSilenced);
});

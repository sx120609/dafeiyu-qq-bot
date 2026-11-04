import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {QQEngine, QQStored} from '../engine/QQEngine.mjs';
import {QQTarget} from '../engine/core/QQPolicy.mjs';
import {QQMemoryBook, QQMemoryDelta, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, call, opening} from './engine-fixtures.mjs';

const account = '12345', user = '54321', other = '65432';
const target = (number, group = true) => new QQTarget({number, group, name: '合成会话', enabled: true});
const a = target('99999'), b = target('88888'), privateChat = target(user, false);
const label = (chat, who = user) => QQMemoryBook.subject(account, chat.key, who);
const members = (chat, who = user) => ({[label(chat, who)]: who});
const userKey = QQMemoryBook.userKey(account, user);
async function qqFixture() {
  const fixture = await new OneBotFixture({shape: 'group'}).start();
  const request = fixture.request.bind(fixture);
  fixture.request = value => value.action === 'get_group_list'
    ? fixture.ok(value, [a, b].map(chat => ({group_id: +chat.number, group_name: chat.name}))) : request(value);
  return fixture;
}
function rig(t, fields = {}) {
  const directory = tempDirectory();
  const engine = new QQEngine({storageDirectory: directory, allowAuthenticationUI: false, ...fields});
  engine.config.expectedSelfID = account;
  engine.config.memoryEnabled = true;
  engine.config.targets = [a, b, privateChat];
  t.after(() => { engine.pause(); engine.disconnect(); removeDirectory(directory); });
  return {engine, directory};
}
function remember(engine, chat, text, scope = 'global', who = user, kind = 'fact') {
  return engine.agentRemember(JSON.stringify({about: label(chat, who), kind, text, keywords: ['合成'], source: '1', scope}),
    ['1'], {'1': {sender: who, text}}, members(chat, who), chat);
}
const change = (event, fields = {}) => ({operation: 'upsert', replaces: [], subject: event.subject, scope: 'global', kind: 'fact',
  text: '喜欢合成乌龙茶', keywords: ['合成', '乌龙茶'], importance: 2, sourceID: event.id, evidence: event.text, days: 365, ...fields});

test('globalRememberFollowsQQAcrossGroupsAndPrivateChatsWithoutSharingJournals', t => {
  const {engine, directory} = rig(t);
  assert.match(remember(engine, a, '喜欢合成乌龙茶'), /全局用户记忆/);
  remember(engine, b, '喜欢合成乌龙茶');
  assert.equal(engine.userMemoryBooks[userKey].items.length, 1);
  remember(engine, a, '合成群内约定：周三讨论', 'session');
  remember(engine, a, '合成群内接梗', 'global', user, 'cue');
  remember(engine, a, '合成群活动', 'global', user, 'event');
  engine.agentRemember(JSON.stringify({about: label(a), kind: 'fact', text: '合成旧工具调用', source: '1'}),
    ['1'], {'1': {sender: user}}, members(a), a);
  const local = engine.memoryBooks[account + ':' + a.key];
  const event = new QQMemoryEvent({id: 'raw', subject: label(a), userID: user, text: '合成群的聊天原文', at: new Date()});
  local.append(event);
  local.apply(new QQMemoryDelta({summary: '合成群的摘要', changes: []}), [event], new Set());
  for (const chat of [b, privateChat]) {
    const recalled = engine.memoryContext(chat, '合成', members(chat));
    assert.match(recalled, /喜欢合成乌龙茶/);
    assert.ok(recalled.includes(label(chat)));
    assert.doesNotMatch(recalled, /群内约定|群内接梗|群活动|聊天原文|群的摘要|旧工具调用/);
    assert.ok(!recalled.includes(user));
  }
  assert.equal(engine.memoryContext(b, '合成', members(b, other)), '');
  assert.equal(engine.memoryContext(b, '合成', {[label(b)]: other}), '');
  engine.config.expectedSelfID = '22222';
  assert.equal(engine.memoryContext(privateChat, '合成'), '');
  engine.config.expectedSelfID = account;
  engine.config.memoryEnabled = false;
  assert.equal(engine.memoryContext(privateChat, '合成'), '');
  engine.config.memoryEnabled = true;
  engine.persist();
  const reloaded = new QQEngine({storageDirectory: directory, allowAuthenticationUI: false});
  assert.match(reloaded.memoryContext(privateChat, '还记得我吗'), /乌龙茶/);
  assert.equal(reloaded.memoryBooks[account + ':' + a.key].recent[0].userID, user);
  assert.equal(reloaded.userMemoryBooks[userKey].recent.length, 0);
  assert.equal(reloaded.userMemoryBooks[userKey].pending.length, 0);
});

test('commandsShowBothScopesForgetOnlyTheAskerAndPreserveGlobalsOnSessionClear', t => {
  const {engine, directory} = rig(t);
  remember(engine, a, '喜欢合成乌龙茶');
  remember(engine, a, '别人的合成乌龙茶偏好', 'global', other);
  remember(engine, b, '本群合成约定', 'session');
  let shown = engine.performAdminCommand({case: 'memories'}, b, user, false).text;
  assert.match(shown, /\[全局\].*乌龙茶/);
  assert.match(shown, /\[本会话\].*本群合成约定/);
  assert.doesNotMatch(shown, /别人的/);
  engine.resetContext(a, true);
  assert.match(engine.memoryContext(privateChat, ''), /乌龙茶/);
  const forgotten = engine.performAdminCommand({case: 'forget', _0: '乌龙茶'}, privateChat, user, false).text;
  assert.match(forgotten, /忘掉了 1 条/);
  for (const chat of [a, b, privateChat]) assert.doesNotMatch(engine.memoryContext(chat, '以前的乌龙茶', members(chat)), /乌龙茶/);
  assert.equal(engine.userMemoryBooks[QQMemoryBook.userKey(account, other)].items.length, 1);
  engine.persist();
  const reloaded = new QQEngine({storageDirectory: directory, allowAuthenticationUI: false});
  assert.equal(reloaded.userMemoryBooks[userKey].items.length, 0);
  assert.match(reloaded.performAdminCommand({case: 'memories'}, b, user, false).text, /本群合成约定/);
});

test('hotReloadedEngineWithoutNewStateCanRememberAndRecallMultipleCurrentUsers', t => {
  const {engine} = rig(t);
  delete engine.userMemoryBooks;
  assert.equal(engine.memoryContext(privateChat, '你好'), '');
  remember(engine, a, '喜欢合成乌龙茶');
  remember(engine, a, '习惯被称为合成同学', 'global', other);
  const recalled = engine.memoryContext(b, '你好', {...members(b), ...members(b, other)});
  assert.match(recalled, /乌龙茶/);
  assert.match(recalled, /合成同学/);
  engine.config.blockedIDs = [other];
  assert.doesNotMatch(engine.memoryContext(b, '你好', {...members(b), ...members(b, other)}), /合成同学/);
});

test('scopedCompactionCorrectsTheSameUserAcrossChatsAndKeepsSummaryLocal', () => {
  const global = new QQMemoryBook(), first = new QQMemoryBook(), second = new QQMemoryBook();
  const event = new QQMemoryEvent({id: '1', subject: label(a), userID: user, text: '我喜欢合成乌龙茶', at: new Date()});
  first.append(event);
  first.apply(QQMemoryDelta.decode(JSON.stringify({summary: '只有甲群能看到的合成摘要', changes: [change(event)]})), [event], new Set(), new Date(), new Map([[label(a), global]]));
  assert.equal(global.items.length, 1);
  assert.equal(global.items[0].subject, 'USER');
  assert.equal(global.items[0].scope, 'global');
  assert.deepEqual(first.items.map(item => item.kind), ['episode']);
  const old = global.items[0];
  const correction = new QQMemoryEvent({id: '2', subject: label(b), userID: user, text: '现在改喝合成红茶', at: new Date()});
  second.append(correction);
  const delta = QQMemoryDelta.decode(JSON.stringify({summary: '', changes: [
    change(correction, {text: '现在喜欢合成红茶', replaces: [old.id]}),
    change(correction, {text: '合成群内事实', scope: 'session', replaces: [old.id]}),
    change(correction, {text: '不可串到别人的记忆', subject: 'MEMBER_wrong'}),
    change(correction, {text: '合成群活动', kind: 'event'})
  ]}));
  second.apply(delta, [correction], new Set([old.id]), new Date(), new Map([[label(b), global]]));
  assert.ok(old.invalidatedAt instanceof Date);
  assert.deepEqual(global.remembered('USER').map(item => item.text), ['现在喜欢合成红茶']);
  assert.deepEqual(second.items.map(item => item.scope), ['session', 'session']);
  assert.ok(!global.items.some(item => item.text.includes('群')));
});

test('oldBooksAndLegacySummariesRemainLocalAndMissingIdentityCannotBecomeGlobal', t => {
  const {engine, directory} = rig(t);
  const book = new QQMemoryBook();
  book.remember(label(a), 'fact', '合成旧事实', [], 'old');
  const event = new QQMemoryEvent({id: 'old-event', subject: label(a), text: '合成旧片段', at: new Date()});
  book.append(event);
  const stored = JSON.parse(JSON.stringify(new QQStored({config: engine.config, memoryBooks: {[account + ':' + a.key]: book}})));
  delete stored.memoryBooks[account + ':' + a.key].items[0].scope;
  fs.writeFileSync(path.join(directory, 'qq-state.json'), JSON.stringify(stored));
  const reloaded = new QQEngine({storageDirectory: directory, allowAuthenticationUI: false});
  assert.equal(reloaded.memoryBooks[account + ':' + a.key].items[0].scope, 'session');
  assert.match(reloaded.memoryContext(a, '合成', members(a)), /旧事实/);
  assert.equal(reloaded.memoryContext(b, '合成', members(b)), '');
  assert.deepEqual(reloaded.memoryMembers(a, [event]), {});
  const local = reloaded.memoryBooks[account + ':' + a.key];
  local.apply(QQMemoryDelta.decode(JSON.stringify({summary: '', changes: [change(event)]})), [event], new Set());
  assert.ok(local.items.every(item => item.scope === 'session'));
  delete stored.memoryBooks;
  stored.memories = {[account + ':' + a.key + ':' + user]: {text: '合成最早摘要', updatedAt: (Date.now() - Date.UTC(2001, 0, 1)) / 1000}};
  stored.userMemoryBooks = {};
  fs.writeFileSync(path.join(directory, 'qq-state.json'), JSON.stringify(stored));
  const legacy = new QQEngine({storageDirectory: directory, allowAuthenticationUI: false});
  assert.match(legacy.memoryContext(a, '合成', members(a)), /合成最早摘要/);
  assert.equal(legacy.memoryContext(b, '合成', members(b)), '');
});

test('backgroundLearningPersistsGlobalFactsAndUsesCrossChatCandidates', async t => {
  const fixture = await qqFixture();
  t.after(() => fixture.stop());
  let supplied;
  const model = new ModelScript((purpose, messages) => {
    assert.match(messages[0].content, /QQ_MEMORY_V2/);
    const input = JSON.parse(messages.at(-1).content); supplied = input;
    const event = input.events[0];
    return {content: JSON.stringify({summary: '仅此群的合成摘要', changes: [change(event, {text: '合成新偏好', replaces: input.existing.filter(item => item.scope === 'global').map(item => item.id)})]})};
  });
  const {engine, directory} = rig(t, {modelClient: new DeepSeekClient({session: model.session})});
  remember(engine, a, '合成旧偏好');
  engine.config.endpoint = fixture.endpoint;
  engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key');
  await engine.connect(); assert.ok(engine.connected);
  const local = new QQMemoryBook();
  local.append(new QQMemoryEvent({id: 'learn', subject: label(b), userID: user, text: '现在合成新偏好', at: new Date(Date.now() - 700_000)}));
  engine.memoryBooks[account + ':' + b.key] = local;
  engine.start();
  assert.ok(engine.running, engine.error);
  assert.ok(await wait(() => !engine.memoryBusy));
  assert.match(engine.memoryStatus, /记忆整理完成/);
  assert.equal(supplied.events[0].globalEligible, true);
  assert.ok(!JSON.stringify(supplied).includes(user));
  assert.equal(supplied.existing.find(item => item.scope === 'global').subject, label(b));
  assert.deepEqual(engine.userMemoryBooks[userKey].remembered('USER').map(item => item.text), ['合成新偏好']);
  assert.doesNotMatch(engine.memoryContext(privateChat, '合成'), /仅此群/);
  const reloaded = new QQEngine({storageDirectory: directory, allowAuthenticationUI: false});
  assert.match(reloaded.memoryContext(privateChat, '合成'), /合成新偏好/);
});

test('actualAgentTurnsAndHistorySearchRecallGlobalFactsWithoutALocalBook', async t => {
  const fixture = await qqFixture();
  t.after(() => fixture.stop());
  const prompts = [];
  const model = new ModelScript((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    prompts.push(opening(messages));
    return call('send_message', {text: '收到', end_turn: true});
  });
  const {engine} = rig(t, {modelClient: new DeepSeekClient({session: model.session})});
  remember(engine, a, '喜欢合成乌龙茶');
  remember(engine, a, '甲群合成秘密上下文', 'session');
  engine.config.endpoint = fixture.endpoint;
  engine.config.effectiveVisionEnabled = false;
  engine.config.effectivePersona.stickersEnabled = false;
  engine.agentQuietSeconds = 0.1;
  engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key');
  await engine.connect(); assert.ok(engine.connected);
  engine.start();
  for (const [index, chat] of [b, privateChat].entries()) {
    const event = {post_type: 'message', self_id: +account, user_id: +user, sender: {user_id: +user},
      message_type: chat.group ? 'group' : 'private', sub_type: chat.group ? 'normal' : 'friend', message_id: 101 + index,
      message: [{type: 'text', data: {text: '还记得我吗'}}]};
    if (chat.group) event.group_id = +chat.number;
    fixture.inject([event]);
    assert.ok(await wait(() => fixture.payloads.length > index));
  }
  for (const prompt of prompts) {
    assert.match(prompt, /相关长期记忆[\s\S]*乌龙茶/);
    assert.doesNotMatch(prompt, /甲群合成秘密上下文/);
  }
  const searched = await engine.agentErrand('search_chat_history', JSON.stringify({query: '合成乌龙茶'}), b);
  assert.match(searched, /喜欢合成乌龙茶/);
  assert.doesNotMatch(searched, /秘密上下文/);
});

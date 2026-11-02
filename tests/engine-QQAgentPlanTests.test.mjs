import test from 'node:test';
import assert from 'node:assert/strict';
import {QQAgentLevel, QQAgentPlan} from '../engine/core/QQAgentPlan.mjs';
import {QQConfig} from '../engine/core/QQPolicy.mjs';

const B = QQAgentPlan.Bubble;
const messages = new Set(['11', '12', '13']), members = new Set(['MEMBER_a']), emojis = new Set(['76', '147']);
const everything = QQAgentLevel.bubbleKinds('full');
const decode = (raw, kinds = everything, own, reminders) => QQAgentPlan.decode(raw, messages, members, emojis, kinds, own, reminders);
const required = value => { assert.notEqual(value, undefined); return value; };
const superset = (a, b) => [...b].every(x => a.has(x));

test('aReplyKeepsOnlyWhatWasOffered', () => {
  const raw = [
    '好的，我的决定：```json',
    '{"action":"reply","target":12,"quote":true,"bubbles":[',
    '  {"kind":"text","text":"  第一句  "},{"kind":"text","text":""},{"kind":"text","text":"第二句"},{"kind":"text","text":"第三句"},{"kind":"text","text":"第四句"},',
    '  {"kind":"sticker","describe":"得意叉腰"},{"kind":"sticker","describe":"第二张"},',
    '  {"kind":"reaction","message":"11","emoji":"76"},{"kind":"reaction","message":"11","emoji":"147"},{"kind":"reaction","message":"99","emoji":"76"},',
    '  {"kind":"poke","member":"MEMBER_x"},{"kind":"image","prompt":"一只猫"}],',
    ' "note":"接住玩笑"}',
    '```'
  ].join('\n');
  const plan = required(decode(raw));
  assert.ok(plan.action === 'reply' && plan.target === '12' && plan.quote && plan.note === '接住玩笑');
  // Everything offered is kept; only what was not offered (an unknown message or member) is left out.
  assert.deepEqual(plan.bubbles, [B.text('第一句'), B.text('第二句'), B.text('第三句'), B.text('第四句'), B.sticker('得意叉腰'), B.sticker('第二张'),
    B.reaction('11', '76'), B.image('一只猫')]);
  // Past five messages, the rest joins the fifth instead of being lost.
  const chatty = required(decode('{"action":"reply","bubbles":[{"kind":"text","text":"1"},{"kind":"text","text":"2"},{"kind":"text","text":"3"},{"kind":"text","text":"4"},{"kind":"text","text":"5"},{"kind":"text","text":"6"}]}'));
  assert.deepEqual(chatty.bubbles.at(-1), B.text('5\n6'));
});

test('silenceWaitAndEmptyReplies', () => {
  assert.ok(new QQAgentPlan({action: 'silence', note: '别人在聊'}).equals(decode('{"action":"silence","note":"别人在聊"}')));
  const wait = required(decode('{"action":"wait","wait_seconds":900}'));
  assert.ok(wait.action === 'wait' && wait.waitSeconds === 120);
  // Nothing sendable left: that is silence, not an empty reply.
  const empty = required(decode('{"action":"reply","bubbles":[{"kind":"poke","member":"MEMBER_zz"}],"note":"x"}'));
  assert.equal(empty.action, 'silence');
  // A target outside the batch is dropped, and with it the quote.
  const loose = required(decode('{"action":"reply","target":"404","quote":true,"bubbles":[{"kind":"text","text":"在"},{"kind":"poke","member":"MEMBER_a"},{"kind":"image","prompt":"猫"},{"kind":"artwork"}]}'));
  assert.ok(loose.target === undefined && !loose.quote);
  assert.deepEqual(loose.bubbles, [B.text('在'), B.poke('MEMBER_a'), B.image('猫'), B.artwork()]);
  assert.equal(decode('不是 JSON'), undefined);
  assert.equal(decode('{"action":"dance"}'), undefined);
  assert.ok(QQAgentPlan.pause('') === 1.2 && QQAgentPlan.pause('字'.repeat(500)) === 4);
});

/** The level decides what may be done: bubbles above it are dropped whatever the model writes. */
test('permissionLevelsBoundWhatTheAgentMayDo', () => {
  const raw = '{"action":"reply","bubbles":[{"kind":"text","text":"好"},{"kind":"poke","member":"MEMBER_a"},{"kind":"image","prompt":"猫"},{"kind":"artwork"},{"kind":"reaction","message":"11","emoji":"76"}]}';
  const basic = required(decode(raw, QQAgentLevel.bubbleKinds('basic')));
  assert.deepEqual(basic.bubbles, [B.text('好'), B.reaction('11', '76')]);
  const standard = required(decode(raw, QQAgentLevel.bubbleKinds('standard')));
  assert.deepEqual(standard.bubbles, [B.text('好'), B.poke('MEMBER_a'), B.reaction('11', '76')]);
  assert.ok(QQAgentLevel.answersOnlyWhenCalled('basic') && !QQAgentLevel.answersOnlyWhenCalled('standard'));
  assert.ok(!QQAgentLevel.tools('basic').has('ask_helper') && QQAgentLevel.tools('standard').has('browse_bilibili'));
  assert.ok(!QQAgentLevel.tools('basic').has('watch_bilibili_live') && QQAgentLevel.tools('standard').has('watch_bilibili_live'));
  assert.ok(!QQAgentLevel.tools('standard').has('save_sticker') && superset(QQAgentLevel.tools('full'), QQAgentLevel.tools('standard')));
  // Management is offered at every level; who may do what is checked against the person asking.
  assert.ok(QQAgentLevel.all.every(level => QQAgentLevel.tools(level).has('manage_chat') && QQAgentLevel.tools(level).has('model_info')));
});

/** Mentions, taking back its own messages, reminders and likes: each only with what the program offered. */
test('mentionsRecallsRemindersAndLikes', () => {
  const raw = '{"action":"reply","bubbles":[{"kind":"text","text":"好","at":"MEMBER_a"},{"kind":"text","text":"嗯","at":"MEMBER_zz"},{"kind":"recall","message":"501"},{"kind":"recall","message":"11"},{"kind":"later","minutes":5000,"about":"提醒 MEMBER_a 取快递","say":"快递！"},{"kind":"later","cancel":"r1"},{"kind":"later","cancel":"r9"},{"kind":"like","member":"MEMBER_a","times":30}]}';
  const plan = required(decode(raw, everything, new Set(['501']), new Set(['r1'])));
  assert.deepEqual(plan.bubbles, [B.text('好', 'MEMBER_a'), B.text('嗯'), B.recall('501'), B.later(1440, '提醒 MEMBER_a 取快递', '快递！'), B.cancelLater('r1'), B.like('MEMBER_a', 10)]);
  assert.ok(!plan.wordless);
  // At the basic level there are no reminders or likes; recall stays.
  const basic = required(decode(raw, QQAgentLevel.bubbleKinds('basic'), new Set(['501']), new Set(['r1'])));
  assert.deepEqual(basic.bubbles, [B.text('好', 'MEMBER_a'), B.text('嗯'), B.recall('501')]);
  // Silence, or only a reaction or a poke, is wordless: nobody can read anything.
  const react = required(decode('{"action":"reply","bubbles":[{"kind":"reaction","message":"11","emoji":"76"},{"kind":"poke","member":"MEMBER_a"}]}'));
  assert.ok(react.wordless && new QQAgentPlan({action: 'silence'}).wordless && !new QQAgentPlan({action: 'wait'}).wordless);
  // Action tools map onto the same checked bubbles.
  const sent = required(QQAgentPlan.toolBubble('send_message', '{"text":"好","at":"MEMBER_a","quote":"11"}'));
  assert.ok(sent.quote === '11' && sent.bubble.kind === 'text' && sent.bubble.at === 'MEMBER_a');
  assert.equal(QQAgentPlan.toolBubble('send_sticker', '{"id":"local-abc"}')?.bubble.describe, 'local-abc');
  assert.equal(QQAgentPlan.toolBubble('cancel_reminder', '{"id":"r1"}')?.bubble.cancel, 'r1');
  assert.equal(QQAgentPlan.toolBubble('search_chat_history', '{}'), undefined);
  assert.ok(QQAgentPlan.nudge.includes('send_message'));
  assert.ok(superset(QQAgentLevel.tools('standard'), ['group_info', 'remember', 'member_info']) && QQAgentLevel.tools('basic').has('member_info'));
  assert.ok(QQAgentLevel.groupAdmin('full') && !QQAgentLevel.groupAdmin('standard'));
  // A voice message counts as saying something; the basic level has none.
  const voice = '{"action":"reply","bubbles":[{"kind":"voice","text":"哼，叫我干嘛"}]}';
  assert.deepEqual(required(decode(voice)).bubbles, [B.voice('哼，叫我干嘛')]);
  assert.ok(!required(decode(voice)).wordless);
  assert.equal(required(decode(voice, QQAgentLevel.bubbleKinds('basic'))).action, 'silence');
});

test('permissionLevelsPerChat', () => {
  const config = new QQConfig();
  config.expectedSelfID = '12345';
  config.agentLevels = {'group:99999': 'basic', 'group:88888': 'standard'};
  config.validate();
  assert.ok(config.agentLevel('group:99999') === 'basic' && config.agentLevel('group:88888') === 'standard' && config.agentLevel('private:77777') === 'full');
  config.agentLevels = {'group:99999': 'god'};
  assert.throws(() => config.validate());
  config.agentLevels = {'channel:1': 'basic'};
  assert.throws(() => config.validate());
});

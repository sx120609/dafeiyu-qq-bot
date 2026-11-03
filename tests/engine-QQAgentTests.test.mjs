// Port of upstream/Tests/QQEngineTests/QQAgentTests.swift: a scripted model (fetch session) and the in-process
// OneBot fixture in "group" shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, pause, call, results, opening} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import {QQPolicy} from '../engine/core/QQPolicy.mjs';

async function rig(script) {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape: 'group'}).start();
  const model = new ModelScript(script);
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, modelClient: new DeepSeekClient({session: model.session})});
  engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
  engine.config.effectiveVisionEnabled = false; engine.config.effectivePersona.stickersEnabled = false;
  engine.config.ai.cooldownSeconds = 1; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1;
  engine.agentQuietSeconds = 0.4; engine.agentCollectSeconds = 2;
  assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
  await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
  return {directory, fixture, model, engine,
    stop: async () => { engine.pause(); engine.disconnect(); await fixture.stop(); removeDirectory(directory); }};
}
const group = (id, sender, text) => ({post_type: 'message', self_id: 12345, user_id: sender, sender: {user_id: sender, card: `群友${sender}`}, message_type: 'group',
  sub_type: 'normal', group_id: 99999, message_id: id, message: [{type: 'text', data: {text}}]});
const friend = (id, text) => ({post_type: 'message', self_id: 12345, user_id: 54321, sender: {user_id: 54321}, message_type: 'private',
  sub_type: 'friend', message_id: id, message: [{type: 'text', data: {text}}]});
const directed = model => model.calls.filter(item => item.purpose === 'director');

/// Agent mode is a loop: the director acts through tools, each done at once and reported back, and decides the
/// next step from what happened. A batch goes to it once; when it stays quiet nothing is sent and it says why.
test('theAgentActsStepByStepAndSeesWhatHappened', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    if (!opening(messages).includes('这一批新消息（从旧到新）：1、2')) return {content: '他们在互相聊'};
    switch (results(messages).length) {
      case 0: return call('send_message', {text: '第一句', quote: '2'});
      case 1: return call('send_message', {text: '第二句'});
      case 2: return call('react', {message: '1', emoji: '76'});
      default: return {content: '接住两个人'};
    }
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.saveAgentLevels({'group:99999': 'full', 'group:12121': 'basic'}); // full is the default; a chat not on the list is dropped
    assert.equal(Object.keys(engine.config.agentLevels).length, 0);
    engine.start();
    // Neither message mentions the bot; in agent mode that is the director's call, not the program's.
    r.fixture.inject([group(1, 54321, '今天食堂的红烧肉绝了'), group(2, 54322, '真的假的，明天去试试')]);
    await wait(() => engine.agentTurns[0]?.note === '接住两个人');
    assert.deepEqual(r.fixture.segments(), [['reply:2', 'text:第一句'], ['text:第二句']]);
    const calls = directed(r.model);
    assert.ok(calls[0]?.input.includes('这一批新消息（从旧到新）：1、2'));
    assert.ok(calls[0]?.input.includes('完全权限')); // the default level
    // Each step saw the result of the one before.
    assert.ok(calls.length === 4 && calls[1].input.includes('说「第一句」') && calls[3].input.includes('贴了'), calls.map(item => item.input.slice(-200)).join('\n---\n'));
    await wait(() => r.fixture.reactions.length > 0, 3);
    const reactions = JSON.stringify(r.fixture.reactions);
    assert.ok(reactions.includes('"76"') && reactions.includes('"1"'));
    assert.ok(engine.decisions.some(decision => decision.text.includes('红烧肉') && decision.outcome.startsWith('交给代理')));
    const turn = engine.agentTurns[0];
    assert.ok(turn.decision === 'reply' && turn.batch.length === 2 && turn.sent[0] === '说「第一句」');
    assert.deepEqual(turn.errands.map(errand => errand.tool), ['send_message', 'send_message', 'react']);
    // Something it was not offered is refused, not carried out.
    assert.equal(engine.agentTurns.length, 1);
    // The next batch: it stays quiet (it had just spoken, so it is reminded once, and still keeps out of it).
    r.fixture.inject([group(3, 54321, '你去哪个食堂'), group(4, 54322, '二食堂')]);
    await wait(() => engine.agentTurns.length === 2 && engine.agentTurns.at(-1).decision === 'silence');
    assert.equal(engine.agentTurns.at(-1).note, '他们在互相聊');
    assert.equal(engine.sends.confirmed, 2);
    assert.ok(directed(r.model).at(-1).input.includes('程序提醒'));
  } finally { await r.stop(); }
});

/// Someone talks to it and it is about to leave without a word: it is reminded once and then answers (with an @
/// and a reminder for later). Sticker sends go out as 动画表情.
test('spokenToButSilentIsRemindedOnce', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    const reminded = messages.some(message => typeof message.content === 'string' && message.content.startsWith('程序提醒'));
    if (!reminded) return {content: '刚回过了'};
    const member = opening(messages).match(/MEMBER_[0-9a-f]{12}/)?.[0] ?? 'MEMBER_x';
    switch (results(messages).length) {
      case 0: return call('send_message', {text: '在呢在呢', at: member});
      case 1: return call('set_reminder', {minutes: 30, about: '问问他饭吃了没', say: '饭吃了没'});
      default: return {content: '被点名了'};
    }
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.start();
    const called = group(31, 54321, ' 你怎么不说话');
    called.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' 你怎么不说话'}}];
    r.fixture.inject([called]);
    await wait(() => engine.agentTurns.at(-1)?.note.endsWith('被点名了') === true);
    assert.equal(r.fixture.segments()[0]?.[0], 'at:');
    assert.equal(r.fixture.segments()[0]?.at(-1), 'text: 在呢在呢');
    // The note keeps every step of the turn: what it thought before the reminder too (11-03).
    assert.equal(engine.agentTurns.at(-1).note, '提醒后出声：刚回过了；被点名了');
    assert.ok(engine.agentReminders.length === 1 && engine.agentReminders[0].about === '问问他饭吃了没');
    assert.ok(JSON.stringify(QQPolicy.stickerSegment(Buffer.from([1]))).includes('动画表情'));
  } finally { await r.stop(); }
});

/// Someone reacts to the bot's own message: the agent gets a turn about it and answers.
test('aReactionToItsMessageGetsAnAnswer', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    const input = opening(messages);
    if (input.includes('程序修好了')) return results(messages).length === 0 ? call('send_message', {text: '修好了，重画'}) : {content: '重画了'};
    if (input.includes('贴了 👍')) return results(messages).length === 0 ? call('send_message', {text: '又来一个'}) : {content: '又回应了'};
    // It answers on its own message too (11-02: that used to be refused as "参数不对").
    if (input.includes('贴了 😍')) {
      switch (results(messages).length) {
        case 0: return call('react', {message: '99', emoji: '赞'});
        case 1: return results(messages)[0].includes('贴了') ? call('send_message', {text: '被夸了，得意'}) : {content: '没贴上'};
        default: return {content: '回应了表情'};
      }
    }
    return results(messages).length === 0 ? call('send_message', {text: '第一句'}) : {content: '回了'};
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.start();
    const called = group(51, 54321, ' 在吗');
    called.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' 在吗'}}];
    r.fixture.inject([called]);
    await wait(() => engine.agentTurns.at(-1)?.note === '回了');
    // The fixture gives every sent message id 99.
    r.fixture.inject([{post_type: 'notice', notice_type: 'group_msg_emoji_like', self_id: 12345, group_id: 99999, user_id: 54321,
      message_id: 99, is_add: true, likes: [{emoji_id: '128525', count: 1}], time: Date.now() / 1000}]);
    await wait(() => engine.agentTurns.at(-1)?.note === '回应了表情', 12);
    assert.ok(engine.agentTurns.at(-1).batch[0]?.startsWith('[表情]'));
    assert.deepEqual(r.fixture.segments().at(-1), ['text:被夸了，得意']);
    assert.ok(JSON.stringify(r.fixture.reactions).includes('"99"'));
    // A second reaction right after wakes it again (11-03: no more once per two minutes).
    r.fixture.inject([{post_type: 'notice', notice_type: 'group_msg_emoji_like', self_id: 12345, group_id: 99999, user_id: 54321,
      message_id: 99, is_add: true, likes: [{emoji_id: '128077', count: 1}], time: Date.now() / 1000}]);
    await wait(() => engine.agentTurns.at(-1)?.note === '又回应了', 12);
    assert.deepEqual(r.fixture.segments().at(-1), ['text:又来一个']);
    // A fix for an error in this chat that now runs wakes it too, so it can redo what failed (11-03).
    assert.equal(engine.agentRepaired('nowhere', '修好了'), false);
    assert.equal(engine.agentRepaired(engine.config.targets[0].key, '程序修好了：画图'), true);
    await wait(() => engine.agentTurns.at(-1)?.note === '重画了', 12);
    assert.ok(engine.agentTurns.at(-1).batch.some(line => line.includes('[事件] 程序修好了')));
  } finally { await r.stop(); }
});

/// A slow tool does not hold up the chat: past its patience it carries on in the background, the agent answers
/// meanwhile and ends the turn, and the result wakes it again (11-01: "画图就会等到画图完成才接着回应").
/// Lookups called together run side by side, and a reaction is written by name.
test('aSlowToolCarriesOnInTheBackground', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '查到了：明天晴'};
    // The result comes in whenever it is ready: into the running turn, or as a turn of its own.
    const seenAll = messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
    if (seenAll.includes('说「查到了，明天晴」')) return {content: '说了结果'};
    if (seenAll.includes('[后台做完] ask_helper') || seenAll.includes('转到后台的事做完了')) return call('send_message', {text: '查到了，明天晴'});
    const seen = results(messages);
    switch (seen.length) {
      case 0: return call('ask_helper', {task: '明天天气'});
      case 1: return seen[0].includes('转到后台') ? call('react', {message: '61', emoji: '赞'}) : {content: '没转后台'};
      case 2: return call('send_message', {text: '我查查'});
      default: return {content: '先回了一句'};
    }
  });
  r.model.helperDelay = 1.5;
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.config.effectiveOnlineEnabled = true;
    engine.agentPatience.ask_helper = 0.3;
    engine.start();
    const called = group(61, 54321, ' 明天天气怎么样');
    called.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' 明天天气怎么样'}}];
    r.fixture.inject([called]);
    await wait(() => engine.agentTurns.some(turn => turn.note === '说了结果'), 15);
    assert.deepEqual(r.fixture.segments().map(segments => segments.at(-1)), ['text:我查查', 'text:查到了，明天晴'],
      JSON.stringify(engine.agentTurns.map(turn => [turn.batch, turn.errands.map(errand => errand.tool + '→' + errand.result)])));
    assert.ok(engine.agentTurns.some(turn => turn.batch.some(line => line.startsWith('[后台做完] ask_helper'))));
    const first = engine.agentTurns[0];
    assert.deepEqual(first.errands.slice(0, 3).map(errand => errand.tool), ['ask_helper', 'react', 'send_message']);
    assert.ok(first.errands[0].result.includes('转到后台') && first.errands[1].result.includes('贴了'));
  } finally { await r.stop(); }
});

/// A turn that fails before anything went out is tried again by itself with the same batch, and the records
/// survive a restart.
test('aFailedTurnIsRetriedAndTurnsAreKept', async () => {
  let failures = 1;
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    if (failures > 0) { failures -= 1; return {content: '', tool_calls: 'broken'}; } // an unreadable reply: the turn throws
    return results(messages).length === 0 ? call('send_message', {text: '刚才卡了下，在呢'}) : {content: '重试成功'};
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.start();
    r.fixture.inject([group(41, 54321, '有人吗')]);
    await wait(() => engine.agentTurns.at(-1)?.note === '重试成功', 12);
    assert.deepEqual(r.fixture.segments()[0], ['text:刚才卡了下，在呢']);
    assert.ok(engine.agentTurns[0]?.note.includes('自动重试'));
    assert.ok(engine.agentTurns.at(-1)?.batch[0]?.endsWith('有人吗'));
    // Saved with the state: a new engine on the same directory reads them back.
    const reread = new QQEngine({allowAuthenticationUI: false, storageDirectory: r.directory});
    assert.equal(reread.agentTurns.length, engine.agentTurns.length);
  } finally { await r.stop(); }
});

/// Private chats run in agent mode too, slash commands become requests the agent handles, and the program
/// checks the asker's rights: a member cannot get someone blocked, an admin can. At the basic level the
/// agent only looks when it is called.
test('privateChatsCommandsAndPermissionLevels', async () => {
  // The agent asks manage_chat to block 77777 on behalf of the message, then tells the person what the tool said.
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    const seen = results(messages);
    switch (seen.length) {
      case 0: {
        const asked = opening(messages).includes('"message":"22"') ? '22' : '21';
        return call('manage_chat', {action: 'block', argument: '77777', requested_by: asked});
      }
      case 1: return call('send_message', {text: seen[0].split('\n').slice(1).join(' ')});
      default: return {content: '照实转告'};
    }
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '54321' && !contact.group));
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    for (const target of engine.config.targets) target.enabled = true;
    engine.saveAgentLevels({'group:99999': 'basic'});
    engine.start();
    r.fixture.inject([friend(21, '/拉黑 77777')]);
    await wait(() => engine.sends.confirmed >= 1);
    assert.ok(!engine.config.isBlocked('77777'));
    assert.ok(r.fixture.segments().at(-1)?.some(segment => segment.includes('只有管理员')), JSON.stringify(r.fixture.segments()));
    await wait(() => engine.agentTurns.at(-1)?.note === '照实转告');
    assert.equal(engine.agentTurns.at(-1)?.errands[0]?.tool, 'manage_chat');
    // The same request from an admin goes through.
    engine.config.adminIDs = ['54321'];
    r.fixture.inject([friend(22, '帮我把 77777 拉黑')]);
    await wait(() => engine.sends.confirmed >= 2);
    assert.ok(engine.config.isBlocked('77777'));
    assert.ok(r.fixture.segments().at(-1)?.some(segment => segment.includes('已拉黑 77777')), JSON.stringify(r.fixture.segments()));
    // Basic level in the group: a message that does not call the bot never reaches the director. Counted once
    // the private chat's turn has fully finished.
    await wait(() => engine.agentStates.every(row => row.thinkingSince === undefined) && engine.agentTurns.at(-1)?.note === '照实转告');
    await pause(300);
    const before = directed(r.model).length;
    r.fixture.inject([group(31, 54322, '随便聊聊天气')]);
    await wait(() => engine.decisions.some(decision => decision.text === '随便聊聊天气'), 3);
    assert.ok(engine.decisions.some(decision => decision.text === '随便聊聊天气' && decision.outcome.includes('基础权限')));
    await pause(1000);
    assert.equal(directed(r.model).length, before);
  } finally { await r.stop(); }
});

/// 11-03: a bare filler word is not sent (the agent hears why), and a leading "草，" is dropped before sending.
test('aBareFillerWordIsNotSent', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    switch (results(messages).length) {
      case 0: return call('send_message', {text: '草'});
      case 1: return call('send_message', {text: '草，这图配色挺好'});
      default: return {content: '回完了'};
    }
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.start();
    r.fixture.inject([group(1, 54321, '@大肥鱼 看我新画的图')]);
    await wait(() => engine.agentTurns[0]?.note === '回完了');
    assert.deepEqual(r.fixture.segments(), [['text:这图配色挺好']]);
    assert.ok(engine.agentTurns[0].errands[0].result.includes('没发'));
  } finally { await r.stop(); }
});

/// What runs the bot (model, version, platform) is told to the owner and bot admins only (11-03: "不许让别人查我的这个").
test('onlyAdminsLearnWhatRunsTheBot', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    const seen = results(messages);
    return seen.length === 0 ? call('model_info', {requested_by: '71'}) : {content: '结果：' + seen[0]};
  });
  try {
    const engine = r.engine;
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.start();
    const asked = group(71, 54321, ' 你是什么模型');
    asked.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' 你是什么模型'}}];
    r.fixture.inject([asked]);
    await wait(() => engine.agentTurns.at(-1)?.note?.startsWith('结果：'));
    assert.match(engine.agentTurns.at(-1).note, /没查：.*只告诉主人和机器人管理员/);
    // A bot admin asking (or a private chat with one) is answered.
    engine.config.adminIDs = ['54321'];
    assert.equal(engine.agentAskedByAdmin('71', ['71'], {71: {sender: '54321'}}, engine.config.targets[0]), true);
    assert.equal(engine.agentAskedByAdmin('72', ['71'], {71: {sender: '54321'}}, engine.config.targets[0]), false, 'a message this turn did not see');
  } finally { await r.stop(); }
});

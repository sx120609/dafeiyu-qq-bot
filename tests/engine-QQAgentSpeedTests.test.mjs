// The agent turn made faster and more careful (11-03, "更快速、更细致、体验感更好、正确率更高"): fewer director
// rounds (end_turn, lookups beside actions), a call to the bot starts at once, the turn records where its time and
// tokens go, what the director is shown matches what really happened, and program faults reach self-repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, pause, call, results, opening, png} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import {QQAgentTurn} from '../engine/QQEngine.types.mjs';
import {QQGroupContext} from '../engine/core/QQGroupContext.mjs';
import {QQMemoryBook, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {QQIncoming} from '../engine/core/QQPolicy.mjs';
import {QQRepair} from '../engine/QQRepair.mjs';

async function rig(script, {shape = 'group'} = {}) {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape}).start();
  const model = new ModelScript(script);
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, modelClient: new DeepSeekClient({session: model.session})});
  engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
  engine.config.effectiveVisionEnabled = false; engine.config.effectivePersona.stickersEnabled = false;
  engine.config.ai.cooldownSeconds = 1; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1;
  engine.agentQuietSeconds = 0.4; engine.agentCollectSeconds = 2;
  assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
  await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
  const number = shape === 'group' ? '99999' : '54321';
  engine.add(engine.contacts.find(contact => contact.number === number));
  engine.config.targets[0].enabled = true;
  return {directory, fixture, model, engine,
    stop: async () => { engine.pause(); engine.disconnect(); await fixture.stop(); removeDirectory(directory); }};
}
const group = (id, sender, text, at = false) => ({post_type: 'message', self_id: 12345, user_id: sender, sender: {user_id: sender, card: `群友${sender}`}, message_type: 'group',
  sub_type: 'normal', group_id: 99999, message_id: id, message: [...(at ? [{type: 'at', data: {qq: '12345'}}] : []), {type: 'text', data: {text}}]});
const directed = model => model.calls.filter(item => item.purpose === 'director');
const calls = (...list) => ({content: '', tool_calls: list.map(([name, args]) => call(name, args).tool_calls[0])});

/// end_turn beside the last action ends the turn without one more round; the turn records rounds and timings.
test('endTurnBesideTheLastActionSavesTheEmptyRound', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    return calls(['send_message', {text: '红烧肉确实香'}], ['end_turn', {note: '接了一句'}]);
  });
  try {
    r.engine.start();
    r.fixture.inject([group(1, 54321, '今天食堂的红烧肉绝了')]);
    await wait(() => r.engine.agentTurns[0]?.decision === 'reply');
    await pause(300);
    const turn = r.engine.agentTurns[0];
    assert.equal(directed(r.model).length, 1);
    assert.equal(turn.note, '接了一句');
    assert.deepEqual(turn.sent, ['说「红烧肉确实香」']);
    assert.equal(turn.rounds, 1);
    assert.equal(turn.roundUsage.length, 1);
    assert.equal(turn.roundUsage[0].calls, 2);
    assert.ok(turn.modelSeconds >= 0 && turn.toolSeconds >= 0 && turn.firstSendSeconds >= 0 && turn.waitSeconds >= 0.3, JSON.stringify(turn));
    // The timing fields reach the disk and come back; turns saved before them still load.
    const json = JSON.parse(JSON.stringify(turn));
    assert.equal(json.rounds, 1);
    assert.equal(QQAgentTurn.decode({...json, at: 0}).firstSendSeconds, turn.firstSendSeconds);
    const old = QQAgentTurn.decode({id: 'x', at: 0, chat: 'c', key: 'k', batch: [], errands: [], decision: 'reply', sent: [], note: '', seconds: 1, tokens: 2});
    assert.equal(old.rounds, undefined);
    assert.equal(JSON.stringify(old.toJSON()).includes('rounds'), false);
  } finally { await r.stop(); }
});

/// An action that did not go through, beside end_turn, goes back to the director, which can put it right.
test('endTurnWaitsWhenAnActionFailed', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    const seen = results(messages);
    if (seen.length === 0) return calls(['react', {message: '404', emoji: '赞'}], ['end_turn', {note: '贴个表情'}]);
    if (seen.length === 2) return calls(['react', {message: '1', emoji: '赞'}], ['end_turn', {note: '改贴到对的那条'}]);
    return {content: '多了一轮'};
  });
  try {
    r.engine.start();
    r.fixture.inject([group(1, 54321, '今天食堂的红烧肉绝了')]);
    await wait(() => r.engine.agentTurns[0]?.decision !== undefined && r.engine.agentTurns[0].decision !== 'thinking');
    const second = directed(r.model)[1];
    assert.ok(second, 'the failed action came back to the director');
    assert.equal(directed(r.model).length, 2);
    assert.ok(r.fixture.reactions.length === 1);
    assert.equal(r.engine.agentTurns[0].note, '改贴到对的那条');
  } finally { await r.stop(); }
});

/// A refused message is not counted as sent: the turn is silence, not a reply.
test('aRefusalIsNotASentMessage', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    return results(messages).length === 0 ? call('send_message', {text: '草'}) : {content: '算了'};
  });
  try {
    r.engine.start();
    r.fixture.inject([group(1, 54321, '今天食堂的红烧肉绝了')]);
    await wait(() => ['silence', 'reply'].includes(r.engine.agentTurns[0]?.decision));
    assert.equal(r.engine.agentTurns[0].decision, 'silence');
    assert.deepEqual(r.engine.agentTurns[0].sent, []);
    assert.equal(r.fixture.payloads.length, 0);
  } finally { await r.stop(); }
});

/// Lookups in a reply start at once, beside the actions written before them.
test('lookupsRunBesideActions', async () => {
  let historyAsked = 0, sendDoneBeforeLookup;
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    return results(messages).length === 0
      ? calls(['send_message', {text: '我翻翻'}], ['search_chat_history', {query: '红烧肉'}])
      : {content: '翻完了'};
  });
  try {
    const original = r.engine.agentErrand.bind(r.engine);
    r.engine.agentErrand = async (name, ...rest) => {
      if (name === 'search_chat_history') { historyAsked += 1; sendDoneBeforeLookup = r.fixture.payloads.length > 0; }
      return original(name, ...rest);
    };
    r.engine.start();
    r.fixture.inject([group(1, 54321, '上次说的红烧肉是哪家')]);
    await wait(() => r.engine.agentTurns[0]?.note === '翻完了');
    assert.equal(historyAsked, 1);
    assert.equal(sendDoneBeforeLookup, false, 'the lookup did not wait for the message before it');
    assert.equal(directed(r.model).length, 2);
  } finally { await r.stop(); }
});

/// A message calling the bot starts its turn at once; group chatter still waits for the batch to close.
test('aCallStartsTheTurnAtOnceChatterWaits', async () => {
  const r = await rig((purpose) => purpose === 'director' ? {content: '看了'} : {content: '不用'});
  try {
    r.engine.agentQuietSeconds = 3; r.engine.agentCollectSeconds = 6;
    r.engine.start();
    const injected = Date.now();
    r.fixture.inject([group(1, 54321, ' 在吗', true)]);
    await wait(() => r.engine.agentTurns.length === 1, 3);
    assert.ok(r.engine.agentTurns.length === 1 && r.engine.agentTurns[0].at.getTime() - injected < 1500, 'the call was looked at at once');
    await wait(() => r.engine.agentTurns[0].decision !== 'thinking');
    r.fixture.inject([group(2, 54322, '今天好热')]);
    await pause(1500);
    assert.equal(r.engine.agentTurns.length, 1, 'chatter still waits for the quiet period');
    await wait(() => r.engine.agentTurns.length === 2, 6);
  } finally { await r.stop(); }
});

/// Its group card is its name: it is told, and a message using it counts as calling it.
test('itsGroupCardIsItsName', async () => {
  const r = await rig((purpose) => purpose === 'director' ? {content: '看了'} : {content: '不用'});
  try {
    r.fixture.selfCard = '蓝鲸一号';
    r.engine.start();
    r.fixture.inject([group(1, 54321, '今天好热')]);
    await wait(() => r.engine.agentTurns[0]?.decision === 'silence');
    assert.ok(directed(r.model)[0].input.includes('你在这个群的群名片是「蓝鲸一号」'));
    r.engine.agentQuietSeconds = 3; r.engine.agentCollectSeconds = 6;
    const injected = Date.now();
    r.fixture.inject([group(2, 54321, '蓝鲸一号你说呢')]);
    await wait(() => r.engine.agentTurns.length === 2, 3);
    assert.ok(r.engine.agentTurns.length === 2 && r.engine.agentTurns[1].at.getTime() - injected < 1500);
  } finally { await r.stop(); }
});

/// Someone only @-mentioned can be acted on by label, like someone who spoke.
test('aMentionedMemberCanBePoked', async () => {
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    const mentioned = QQMemoryBook.subject('12345', 'group:99999', '66666');
    assert.ok(opening(messages).includes(mentioned));
    return results(messages).length === 0 ? call('poke', {member: mentioned}) : {content: results(messages)[0]};
  });
  try {
    r.engine.start();
    const message = group(1, 54321, ' 戳他一下');
    message.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' 戳'}}, {type: 'at', data: {qq: '66666'}}, {type: 'text', data: {text: ' 一下'}}];
    r.fixture.inject([message]);
    await wait(() => r.engine.agentTurns[0]?.decision === 'silence' || r.engine.agentTurns[0]?.decision === 'reply');
    assert.ok(r.engine.agentTurns[0].note.includes('戳了戳'), r.engine.agentTurns[0].note + ' / ' + directed(r.model)[0].input.slice(-600));
    assert.ok(r.fixture.calls.some(item => item.action === 'group_poke' && String(item.params.user_id) === '66666'));
  } finally { await r.stop(); }
});

/// The timeline calls a picture attached only when it really goes along this turn.
test('theTimelineOnlyCallsAttachedWhatIsAttached', () => {
  const at = new Date();
  const events = [new QQMemoryEvent({id: '1', subject: 'MEMBER_aaaaaaaaaaaa', text: '看图', at})];
  const inputs = {1: new QQIncoming({id: '1', sender: '54321', target: '99999', group: true, text: '看图', time: at.getTime() / 1000, images: [{url: 'https://example.invalid/a.png'}]})};
  const context = QQGroupContext.fromEvents(events, '1', inputs, '12345');
  assert.ok(context.context(7000, []).includes('这次没重新附上画面'));
  assert.ok(context.context(7000, [{label: '群消息 1，'}]).includes('画面随本轮附上'));
  assert.ok(context.context(7000).includes('画面随本轮附上')); // the old callers, unchanged
});

/// A bug in a tool reaches self-repair, and the director is told instead of the turn failing; report_bug posts
/// what the agent saw. Outages are not reported.
test('programFaultsReachSelfRepair', async () => {
  const reports = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url !== '/v1/repair/report') { res.statusCode = 404; res.end('{}'); return; }
      reports.push({url: req.url, auth: req.headers.authorization, body: JSON.parse(body)}); res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let restore = () => {};
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    switch (results(messages).length) {
      case 0: return call('member_info', {member: 'MEMBER_x'});
      case 1: return call('report_bug', {description: 'member_info 查自己返回了别人的资料', tool: 'member_info'});
      default: return {content: results(messages).join(' | ')};
    }
  });
  try {
    const base = QQRepair.base;
    QQRepair.base = () => `http://127.0.0.1:${server.address().port}/v1`;
    restore = () => { QQRepair.base = base; };
    QQRepair.sent.clear();
    r.engine.agentMemberInfo = async () => { const missing = undefined; return missing.card; }; // a TypeError
    r.engine.start();
    r.fixture.inject([group(1, 54321, ' 我是谁', true)]);
    await wait(() => r.engine.agentTurns[0]?.decision === 'silence', 8);
    await wait(() => reports.length === 2, 3);
    assert.equal(reports.length, 2, JSON.stringify(r.engine.agentTurns[0]));
    const [fault, agent] = reports;
    assert.equal(fault.url, '/v1/repair/report');
    assert.equal(fault.auth, 'Bearer synthetic-key');
    assert.equal(fault.body.source, 'engine');
    assert.equal(fault.body.kind, 'tool');
    assert.ok(fault.body.message.startsWith('TypeError'));
    assert.ok(fault.body.stack.length > 0);
    assert.equal(fault.body.context.tool, 'member_info');
    assert.equal(fault.body.context.chatKey, 'group:99999');
    assert.equal(fault.body.context.turnId, r.engine.agentTurns[0].id);
    assert.equal(agent.body.kind, 'agent');
    assert.equal(agent.body.message, 'member_info 查自己返回了别人的资料');
    assert.ok(r.engine.agentTurns[0].note.includes('程序错误') && r.engine.agentTurns[0].note.includes('报告了'), r.engine.agentTurns[0].note);
    // The same fault again within ten minutes is not posted twice; outages are never posted.
    assert.equal(QQRepair.capture(new TypeError('missing.card')), 'sent');
    assert.equal(QQRepair.capture(new TypeError('missing.card')), 'duplicate');
    assert.equal(QQRepair.capture(new TypeError('fetch failed')), 'ignored');
    assert.equal(QQRepair.capture(Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'})), 'ignored');
    assert.equal(QQRepair.capture(new SyntaxError('Unexpected token < in JSON at position 0')), 'ignored');
    assert.equal(QQRepair.isBug(new ReferenceError('x is not defined')), true);
    assert.equal(QQRepair.isBug(Object.assign(new Error('expected'), {name: 'AssertionError'})), true);
  } finally {
    restore();
    await r.stop(); server.close();
  }
});

/// Drawing from pictures (11-03, "不能根据用户发的图片进行修改"): "last" changes its own previous picture, the options
/// reach the generator, several pictures go out in one message, and a reference that is not there is said, not guessed.
test('aDrawingIsChangedFromItsLastPicture', async () => {
  const {ModelToolResult} = await import('../engine/QQOnlineTools.mjs');
  const picture = png(), calls = [];
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: JSON.stringify({action: 'generate', prompt: opening(messages).includes('红色') ? '把鱼改成红色' : '一条蓝色的鱼', note: ''})};
    const seen = results(messages);
    switch (seen.length) {
      case 0: return call('draw_image', {prompt: '一条蓝色的鱼', size: 'portrait'});
      case 1: return call('draw_image', {prompt: '把鱼改成红色，别的不变', images: ['last'], count: 2, quality: 'high'});
      case 2: return call('draw_image', {prompt: '照着画', images: ['424242']});
      default: return {content: "画完了：" + seen.join(" | ")};
    }
  }, {shape: 'private'});
  try {
    r.engine.imageGenerator = {execute: async ({references, options}) => {
      calls.push({references, options});
      return new ModelToolResult({content: '已生成', image: picture, images: options.count > 1 ? [picture, picture] : [picture], imageStatus: '生成成功'});
    }};
    r.engine.config.effectiveImageGeneration.enabled = true;
    // A cold image helper can take seconds; the drawings stay in the turn instead of moving to the background.
    r.engine.agentPatience.draw_image = 60;
    r.engine.start();
    r.engine.receivePoke({notice_type: 'notify', sub_type: 'poke', target_id: 12345, user_id: 54321}, Date.now() / 1000);
    await wait(() => r.engine.agentTurns[0]?.note?.includes('画完了'), 15);
    assert.equal(calls.length, 2, r.engine.agentTurns[0]?.note);
    assert.equal(calls[0].references.length, 0); assert.equal(calls[0].options.size, 'portrait');
    assert.equal(calls[1].references.length, 1, 'its last picture is the reference'); assert.equal(calls[1].options.count, 2); assert.equal(calls[1].options.quality, 'high');
    // The reference went through the image helper: a JPEG, not the PNG it drew.
    assert.equal(calls[1].references[0][0], 0xFF);
    const pictures = r.fixture.segments().map(row => row.filter(segment => segment.startsWith('image:')).length);
    assert.deepEqual(pictures.filter(count => count > 0), [1, 2]);
    assert.ok(r.engine.agentTurns[0].note.includes('照着参考图画了 2 张图'), r.engine.agentTurns[0].note);
    assert.ok(r.engine.agentTurns[0].note.includes('没画：没找到消息 424242'), r.engine.agentTurns[0].note);
  } finally { await r.stop(); }
});

/// A turn woken without a message (a poke here) still draws, and a failed drawing says why.
test('aWokenTurnDrawsAndAFailedDrawingSaysWhy', async () => {
  const {ModelToolResult} = await import('../engine/QQOnlineTools.mjs');
  let drawn = 0;
  const r = await rig((purpose, messages) => {
    if (purpose !== 'director') return {content: JSON.stringify({action: 'generate', prompt: '一条蓝色的鱼', note: ''})}; // the drawing planner
    return results(messages).length === 0 ? call('draw_image', {prompt: '一条蓝色的鱼'}) : {content: results(messages)[0]};
  }, {shape: 'private'});
  try {
    r.engine.imageGenerator = {execute: async () => { drawn += 1; return new ModelToolResult({content: '本次未生成图片', imageStatus: '图片接口超时'}); }};
    r.engine.config.effectiveImageGeneration.enabled = true;
    r.engine.start();
    r.engine.receivePoke({notice_type: 'notify', sub_type: 'poke', target_id: 12345, user_id: 54321}, Date.now() / 1000);
    await wait(() => ['silence', 'reply'].includes(r.engine.agentTurns[0]?.decision), 8);
    assert.equal(drawn, 1, 'the drawing was tried: ' + JSON.stringify(r.engine.agentTurns[0]?.errands));
    assert.ok(r.engine.agentTurns[0].note.includes('没画出来：图片接口超时'), r.engine.agentTurns[0].note);
  } finally { await r.stop(); }
});

// Port of upstream/Tests/QQEngineTests/QQEngineTests.swift. The URLProtocol stub is a scripted fetch session and
// onebot_fixture.py the in-process OneBotFixture; no real API, QQ or credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, pause, same} from './engine-fixtures.mjs';
import {QQEngine, QQContact} from '../engine/QQEngine.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import '../engine/QQMemoryLearning.mjs';
import {QQTarget, QQConfig} from '../engine/core/QQPolicy.mjs';
import {QQMemoryBook, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {addSeconds} from '../engine/swift.mjs';

const engineAt = (directory, fields = {}) => new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, ...fields});

/** DelayedModelProtocol: requests wait until completePending(); memory requests get a synthetic delta. */
function delayedModel() {
  const model = new ModelScript(() => ({hold: true}));
  model.completePending = () => model.release(call => {
    if (call.body.includes('[QQ_MEMORY_V2]')) {
      const request = JSON.parse(call.body);
      const input = JSON.parse(request.messages.at(-1).content);
      const source = input.events[0];
      const delta = {summary: '当前会话中的合成资料', changes: [{operation: 'upsert', replaces: [], subject: source.subject, kind: 'fact', text: '当前会话的合成测试事实',
        keywords: ['合成', 'synthetic'], importance: 2, sourceID: source.id, evidence: source.text.slice(0, 100), days: 90}]};
      return {content: JSON.stringify(delta)};
    }
    return {content: JSON.stringify({text: '好耶，给本鱼加饭！', emotion: 'joy', intensity: 3})};
  });
  return model;
}

test('disconnectReleasesRuntimeLockEvenWhenDescriptorWasDuplicated', async () => {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape: 'private'}).start();
  const engine = engineAt(directory);
  try {
    engine.save({endpoint: fixture.endpoint, expectedSelfID: '12345'});
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
    await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
    const other = engineAt(directory);
    other.save({endpoint: 'ws://127.0.0.1:3102'});
    assert.notEqual(other.error, undefined); // An active owner must still exclude other writers.
    // The lock is a file holding the owner's pid (flock has no Windows equivalent); a dead owner's lock is stale.
    const lock = path.join(directory, 'qq-engine.lock');
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
    engine.disconnect();
    assert.ok(!fs.existsSync(lock));
    const reopened = engineAt(directory);
    reopened.save({endpoint: 'ws://127.0.0.1:3102'});
    assert.equal(reopened.error, undefined);
    assert.equal(engineAt(directory).config.endpoint, 'ws://127.0.0.1:3102');
    assert.ok(!engine.running && engine.usage.calls === 0 && engine.sends.attempts === 0);
  } finally { engine.disconnect(); await fixture.stop(); removeDirectory(directory); }
});

test('staleLockFromAnExitedEngineIsTakenOver', () => {
  const directory = tempDirectory();
  try {
    // A pid that cannot be running: the engine that wrote it is gone.
    fs.writeFileSync(path.join(directory, 'qq-engine.lock'), '2147483646');
    const engine = engineAt(directory);
    engine.save({expectedSelfID: '12345'});
    assert.equal(engine.error, undefined);
    assert.equal(engineAt(directory).config.expectedSelfID, '12345');
    assert.ok(!fs.existsSync(path.join(directory, 'qq-engine.lock')));
  } finally { removeDirectory(directory); }
});

test('savedReplyScopeAndWorkHoursSurviveReopeningWithoutStarting', () => {
  const directory = tempDirectory();
  try {
    const engine = engineAt(directory);
    engine.config.expectedSelfID = '12345';
    engine.config.targets = [new QQTarget({number: '54321', name: '合成好友', group: false}), new QQTarget({number: '99999', name: '合成群', group: true})];
    const ai = engine.config.ai.clone();
    ai.workHoursEnabled = true; ai.workStart = 22; ai.workEnd = 7;
    engine.saveReplySettings({ai, persona: engine.config.effectivePersona, enabledTargets: new Set(['group:99999'])});
    assert.equal(engine.error, undefined);
    const reopened = engineAt(directory);
    assert.deepEqual(reopened.config.targets.filter(target => target.enabled).map(target => target.key), ['group:99999']);
    assert.ok(reopened.config.ai.workHoursEnabled && reopened.config.ai.workStart === 22 && reopened.config.ai.workEnd === 7);
    assert.ok(!engine.running && !reopened.running && engine.sends.attempts === 0);
    const saved = engine.config.clone();
    engine.saveReplySettings({ai, persona: engine.config.effectivePersona, enabledTargets: new Set(['group:11111'])});
    assert.notEqual(engine.error, undefined); assert.ok(same(engine.config, saved));
    engine.saveReplySettings({ai, persona: engine.config.effectivePersona, enabledTargets: new Set()});
    assert.equal(engine.error, undefined); assert.ok(engine.config.targets.every(target => !target.enabled));
  } finally { removeDirectory(directory); }
});

test('rejectedConnectionAndStaleReplySaveRestoreInMemoryConfiguration', () => {
  const directory = tempDirectory();
  try {
    const engine = engineAt(directory);
    engine.save({endpoint: 'ws://127.0.0.1:3101', expectedSelfID: '12345'});
    assert.equal(engine.error, undefined);
    const saved = engine.config.clone();
    engine.save({endpoint: 'ws://example.invalid:3101', expectedSelfID: '54321'});
    assert.notEqual(engine.error, undefined); assert.ok(same(engine.config, saved));
    const other = engineAt(directory);
    other.save({endpoint: 'ws://127.0.0.1:3102'});
    assert.equal(other.error, undefined);
    const ai = saved.ai.clone(); ai.dailyLimit = 17;
    engine.saveReplySettings({ai, persona: saved.effectivePersona});
    assert.notEqual(engine.error, undefined); assert.ok(same(engine.config, saved));
    const reopened = engineAt(directory);
    assert.equal(reopened.config.endpoint, 'ws://127.0.0.1:3102');
    assert.equal(reopened.config.ai.dailyLimit, saved.ai.dailyLimit);
  } finally { removeDirectory(directory); }
});

for (const operation of ['add', 'remove']) {
  test(`staleRosterEditDoesNotChangeDisplayedOrSavedTargets(${operation})`, () => {
    const directory = tempDirectory();
    try {
      const engine = engineAt(directory);
      engine.save({expectedSelfID: '12345'});
      engine.add(new QQContact({number: '54321', name: '合成好友', group: false}));
      assert.equal(engine.error, undefined);
      const targets = engine.config.targets.map(target => target.clone());
      const other = engineAt(directory);
      other.save({endpoint: 'ws://127.0.0.1:3102'});
      assert.equal(other.error, undefined);
      if (operation === 'add') engine.add(new QQContact({number: '99999', name: '合成群', group: true}));
      else engine.remove(targets[0].id);
      assert.notEqual(engine.error, undefined);
      assert.ok(same(engine.config.targets, targets));
      const reopened = engineAt(directory);
      assert.ok(same(reopened.config.targets, targets));
      assert.equal(reopened.config.endpoint, 'ws://127.0.0.1:3102');
    } finally { removeDirectory(directory); }
  });
}

for (const mode of ['capture', 'pause', 'clear', 'timed']) {
  test(`structuredMemoryLearnsWithoutSendingAndSurvivesPause(${mode})`, async () => {
    const directory = tempDirectory();
    if (mode === 'timed') {
      const seed = engineAt(directory);
      seed.config.expectedSelfID = '12345'; seed.save();
      const file = path.join(directory, 'qq-state.json');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      const book = new QQMemoryBook();
      book.append(new QQMemoryEvent({id: '-10', subject: 'OWNER', text: '合成的昨日约定', at: addSeconds(new Date(), -601)}));
      stored.memoryBooks = {'12345:group:99999': JSON.parse(JSON.stringify(book))};
      fs.writeFileSync(file, JSON.stringify(stored));
    }
    const fixture = await new OneBotFixture({shape: 'groupParticipation'}).start();
    const model = delayedModel();
    const engine = engineAt(directory, {modelClient: new DeepSeekClient({session: model.session})});
    try {
      engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
      engine.config.memoryEnabled = true; engine.config.effectiveMemoryOptions.messageThreshold = 4;
      engine.config.agentLevels = {'group:99999': 'basic'};
      assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
      await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
      engine.add(engine.contacts.find(contact => contact.number === '99999' && contact.group));
      engine.config.targets[0].enabled = true; engine.start(); assert.ok(engine.running, engine.error);
      if (mode !== 'timed') {
        fixture.inject([1, 2, 3, 4].map(id => {
          const sender = id === 2 ? 12345 : 54321;
          return {post_type: id === 2 ? 'message_sent' : 'message', self_id: 12345, user_id: sender, sender: {user_id: sender}, message_type: 'group', sub_type: 'normal',
            group_id: 99999, message_id: id, message: [{type: 'text', data: {text: `合成测试资料 ${id}`}}]};
        }));
      }
      await wait(() => model.held.length > 0, 4);
      assert.equal(model.calls.length, 1);
      assert.ok(model.calls[0].body.includes('QQ_MEMORY_V2'));
      assert.ok(model.calls[0].body.includes('OWNER'));
      if (mode === 'pause') engine.pause();
      if (mode === 'clear') engine.clearMemory(engine.config.targets[0].id);
      if (['pause', 'clear'].includes(mode)) assert.ok(await wait(() => model.cancelled > 0, 2));
      model.completePending();
      if (['capture', 'timed'].includes(mode)) await wait(() => engine.memoryBooks['12345:group:99999']?.pending.length === 0, 3);
      await pause(50);
      assert.equal(engine.sends.attempts, 0); assert.equal(engine.usage.calls, 1);
      engine.disconnect();
      const reloaded = engineAt(directory);
      if (mode === 'pause') assert.equal(reloaded.memoryBooks['12345:group:99999']?.pending.length, 4);
      else if (mode === 'clear') assert.equal(Object.keys(reloaded.memoryBooks).length, 0);
      else {
        assert.equal(reloaded.memoryBooks['12345:group:99999']?.items.length, 2);
        assert.equal(reloaded.memoryBooks['12345:group:99999']?.pending.length, 0);
      }
    } finally { engine.disconnect(); await fixture.stop(); removeDirectory(directory); }
  });
}

test('learningPayloadIsCompleteAndCandidateAuthorityMatchesSuppliedBudget', async () => {
  const model = delayedModel();
  const book = new QQMemoryBook();
  for (let i = 0; i < 32; i++) book.append(new QQMemoryEvent({id: String(i), subject: 'PEER', text: '"'.repeat(1200), at: new Date()}));
  for (let i = 0; i < 48; i++) book.importLegacy('旧记忆'.repeat(200), 'PEER', new Date());
  const batch = book.batch(), candidates = book.items;
  assert.ok(batch.length < 32);
  const running = new DeepSeekClient({session: model.session}).learnQQMemory({key: 'synthetic', config: new QQConfig().ai, events: batch, candidates, reserve: async () => {}});
  await wait(() => model.calls.length > 0, 3);
  const request = JSON.parse(model.calls[0].body);
  const payload = request.messages.at(-1).content;
  assert.ok([...payload].length <= 11500);
  const fields = JSON.parse(payload);
  assert.equal(fields.events.length, batch.length);
  const supplied = fields.existing;
  assert.ok(supplied.length < candidates.length);
  model.completePending();
  const [, , ids] = await running;
  assert.deepEqual([...ids].sort(), supplied.map(item => item.id).sort());
});

test('removingTargetPersistsWithoutStarting', () => {
  const directory = tempDirectory();
  try {
    const engine = engineAt(directory);
    engine.config.expectedSelfID = '12345';
    engine.add(new QQContact({number: '54321', name: 'fixture', group: false}));
    const target = engine.config.targets[0];
    assert.ok(target);
    engine.remove(target.id);
    assert.equal(engine.error, undefined);
    const reloaded = engineAt(directory);
    assert.equal(reloaded.config.targets.length, 0);
    assert.equal(reloaded.sends.attempts, 0);
  } finally { removeDirectory(directory); }
});

test('stalePanelCannotOverwriteNewerConfiguration', () => {
  const directory = tempDirectory();
  try {
    const owner = engineAt(directory);
    owner.config.expectedSelfID = '12345'; owner.save();
    assert.equal(owner.error, undefined);
    const stale = engineAt(directory);
    owner.config.ai.prompt = 'newer configuration'; owner.save();
    assert.equal(owner.error, undefined);
    const file = path.join(directory, 'qq-state.json'), before = fs.readFileSync(file);
    stale.save();
    assert.notEqual(stale.error, undefined);
    assert.ok(fs.readFileSync(file).equals(before));
  } finally { removeDirectory(directory); }
});

/** qq-state.json written by the Swift engine loads unchanged and is written back in the same shape. */
test('swiftWrittenStateLoadsAndIsWrittenBackInTheSameShape', () => {
  const directory = tempDirectory();
  try {
    const at = 783_000_000.25; // seconds since 2001, as Swift's JSONEncoder writes a Date
    const target = {id: 'C2B1A4F0-6D3B-4E29-9A41-2F7C3D9E5B10', number: '99999', name: '合成群', group: true, enabled: true, personaStyle: 'gentle'};
    const swift = {
      config: {endpoint: 'ws://127.0.0.1:3001', expectedSelfID: '12345', targets: [target],
        ai: {model: 'dafeiyu-active', prompt: 'p', maxTokens: 500, dailyLimit: 200, cooldownSeconds: 5, workHoursEnabled: false, workStart: 9, workEnd: 22, chats: []},
        memoryEnabled: true, agentLevels: {'group:99999': 'standard'}},
      usage: {day: '2026-11-2', calls: 3, tokens: 1200},
      sends: {day: '2026-11-2', attempts: 2, confirmed: 2, uncertain: 0, byChat: {[target.id]: 2}, pending: [], lastByChat: {}, recent: [1793000000.5], jitter: 1.25, lastGlobal: at},
      logs: [{id: '0E0C2C33-3A63-4E7B-8E0F-8F8C8B0C9A11', date: (Date.now() / 1000) - 978307200 - 60, chatID: target.id, state: 'confirmed', detail: '代理发言：合成'}],
      seen: {'group:99999:5': Date.now() / 1000 - 30},
      memoryBooks: {'12345:group:99999': {pending: [], recent: [{id: '5', subject: 'PEER', text: '合成', at}], items: [], knownIDs: ['5'], droppedEvents: 0}},
      botMessageIDs: {'12345:group:99999:99': Date.now() / 1000 - 30},
      ownershipSince: 1793000000,
      stickerHistory: {}, artworkLedger: {deliveries: [], continuation: {}, schedules: {}, networkDay: '', networkCalls: 0},
      contextResetAt: {}, outreachLedger: {lastIncoming: {}, lastSent: {}, awaitingReply: [], lastConsidered: {}},
      removedTargets: [], decisions: [{at, chat: '合成群', speaker: '群友', text: '你好', outcome: '交给代理：攒完这一批一起看'}],
      timelineSummaries: {'group:99999': {text: '前情', throughID: '4', at}},
      agentReminders: [{id: 'rabc123', key: 'group:99999', chat: '群·合成群', due: at + 3600, setAt: at, about: '问问', say: '饭吃了没'}],
      agentTurns: [{id: '8D1D2F20-5B7E-4C83-A0B2-0D9A1F3C4E55', at, chat: '群·合成群', key: 'group:99999', batch: ['群友：你好'], errands: [{tool: 'send_message', detail: '{}', result: '说「好」'}],
        decision: 'reply', sent: ['说「好」'], note: '回了', seconds: 2.5, tokens: 10}],
      agentNotes: [{id: 'nabc123', key: '', at, text: '记一下'}],
      kicks: [{at, sendsLastHour: 3, sendsLastTenMinutes: 1}]
    };
    fs.writeFileSync(path.join(directory, 'qq-state.json'), JSON.stringify(swift));
    const engine = engineAt(directory);
    assert.equal(engine.error, undefined);
    assert.equal(engine.config.targets[0].personaStyle, 'gentle');
    assert.equal(engine.agentTurns[0].note, '回了');
    assert.equal(engine.agentReminders[0].due.getTime(), (at + 3600 + 978307200) * 1000);
    assert.equal(engine.kicks[0].sendsLastHour, 3);
    engine.save();
    assert.equal(engine.error, undefined);
    const written = JSON.parse(fs.readFileSync(path.join(directory, 'qq-state.json'), 'utf8'));
    for (const key of Object.keys(swift)) assert.ok(key in written, key);
    assert.deepEqual(written.agentTurns, swift.agentTurns);
    assert.deepEqual(written.agentReminders, swift.agentReminders);
    assert.deepEqual(written.agentNotes, swift.agentNotes);
    assert.deepEqual(written.kicks, swift.kicks);
    assert.deepEqual(written.decisions, swift.decisions);
    assert.deepEqual(written.timelineSummaries, swift.timelineSummaries);
    assert.deepEqual(written.memoryBooks, swift.memoryBooks);
    assert.deepEqual(written.config.targets, swift.config.targets);
    assert.equal(written.ownershipSince, swift.ownershipSince);
    // And the Node engine reads its own file back.
    assert.equal(engineAt(directory).agentTurns.length, 1);
  } finally { removeDirectory(directory); }
});

// The running engine moved onto a new generation of its code (engine/main.mjs reload): same object, same QQ
// connection and chat state, new methods, and it keeps answering.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {HotReload} from '../engine/HotReload.mjs';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, call, results} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';

const engineDir = path.join(import.meta.dirname, '..', 'engine');
const friend = (id, text) => ({post_type: 'message', self_id: 12345, user_id: 54321, sender: {user_id: 54321}, message_type: 'private',
  sub_type: 'friend', message_id: id, message: [{type: 'text', data: {text}}]});

test('the engine runs on reloaded code without reconnecting or losing its chats', async () => {
  const hot = new HotReload({dirs: [engineDir], fixed: [path.join(engineDir, 'main.mjs'), path.join(engineDir, 'HotReload.mjs')]});
  // This test imported the engine before the hook existed: count those modules as generation 0.
  for (const file of hot.files()) hot.loaded.get(0).add(pathToFileURL(file).href);
  await hot.snapshot(0);
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape: 'private'}).start();
  const model = new ModelScript((purpose, messages) => {
    if (purpose !== 'director') return {content: '不用'};
    return results(messages).length === 0 ? call('send_message', {text: '收到' + messages.length}) : {content: '回了'};
  });
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, modelClient: new DeepSeekClient({session: model.session})});
  try {
    engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
    engine.config.effectiveVisionEnabled = false; engine.config.effectivePersona.stickersEnabled = false;
    engine.config.ai.cooldownSeconds = 0; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1;
    engine.agentQuietSeconds = 0.3; engine.agentCollectSeconds = 1;
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
    await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
    engine.add(engine.contacts.find(contact => contact.number === '54321'));
    engine.config.targets[0].enabled = true;
    engine.start();
    fixture.inject([friend(1, '在吗')]);
    await wait(() => engine.agentTurns.length === 1 && engine.agentThinking.size === 0, 10);
    const connection = engine.connection, turns = engine.agentTurns.length;

    await hot.next(hot.files());
    const map = await hot.classes(0, hot.generation);
    const moved = HotReload.adopt([engine], map);
    const fresh = (await import(pathToFileURL(path.join(engineDir, 'QQEngine.mjs')).href + '?hot=' + hot.generation)).QQEngine;
    assert.ok(moved > 10, `moved ${moved}`);
    assert.ok(engine instanceof fresh && !(engine instanceof QQEngine), 'the engine runs the new generation');
    assert.equal(engine.connection, connection, 'same QQ connection'); assert.ok(engine.connected);
    assert.equal(engine.agentTurns.length, turns, 'its chats and turns are kept');

    fixture.inject([friend(2, '再说一句')]);
    await wait(() => engine.agentTurns.length === turns + 1 && engine.agentThinking.size === 0, 10);
    assert.equal(engine.agentTurns.at(-1).decision, 'reply', JSON.stringify(engine.agentTurns.at(-1)));
    assert.equal(fixture.segments().length, 2, 'it answered before and after');
  } finally { engine.pause(); engine.disconnect(); await fixture.stop(); removeDirectory(directory); }
});

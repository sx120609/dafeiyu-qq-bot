import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {AgentTools} from '../bridge/agent-tools.mjs';
import {Settings, createGateway} from '../bridge/gateway.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import {QQCustomTools} from '../engine/QQCustomTools.mjs';
import {swiftURL} from '../engine/foundation.mjs';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, call, results} from './engine-fixtures.mjs';

const voice = [{type: 'record', data: {file: 'https://example.test/voice.mp3'}}];

test('a custom voice tool inherits the current group through the engine, gateway and QQ broker', async () => {
  const runtime = tempDirectory();
  const previousURL = process.env.DAFEIYU_CODEX_URL;
  const calls = [];
  const tools = new AgentTools({runtime, qq: async (action, params) => {
    calls.push({action, params});
    if (!params.group_id) throw new Error('group_id is required');
    return {status: 'ok', data: {message_id: 101}};
  }});
  const fixture = await new OneBotFixture({shape: 'group'}).start();
  const settings = await new Settings(path.join(runtime, 'providers.json')).load();
  const gateway = createGateway({token: 'synthetic-key', consoleToken: 'synthetic-console'}, settings, {runtime, agentTools: tools});
  const model = new ModelScript((purpose, messages) => {
    if (purpose !== 'director') return {content: 'unused'};
    return results(messages).length ? {content: 'finished'} : call('my_sing_voice', {});
  });
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: runtime, modelClient: new DeepSeekClient({session: model.session})});
  try {
    const made = await tools.create({name: 'my_sing_voice', description: 'Voice fixture',
      parameters: {type: 'object', properties: {}}, test_arguments: {dry_run: true},
      code: `if (args.dry_run) return 'ready'; return tools.qq('send_group_msg', {message: ${JSON.stringify(voice)}});`});
    assert.equal(made.saved, true, made.test.error);
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    process.env.DAFEIYU_CODEX_URL = `http://127.0.0.1:${gateway.address().port}/v1`;
    engine.modelClient.base = swiftURL(process.env.DAFEIYU_CODEX_URL);
    engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
    engine.config.effectiveVisionEnabled = false; engine.config.effectivePersona.stickersEnabled = false;
    engine.agentQuietSeconds = 0.01; engine.agentCollectSeconds = 0.02;
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
    await engine.connect();
    assert.ok(engine.connected, engine.error);
    engine.add(engine.contacts.find(contact => contact.number === '99999'));
    engine.config.targets[0].enabled = true;
    engine.start();
    fixture.inject([{post_type: 'message', self_id: 12345, user_id: 54321, sender: {user_id: 54321},
      message_type: 'group', sub_type: 'normal', group_id: 99999, message_id: 71,
      message: [{type: 'text', data: {text: 'voice fixture'}}]}]);
    assert.ok(await wait(() => engine.agentTurns.at(-1)?.note === 'finished'), JSON.stringify({turns: engine.agentTurns, error: engine.error, calls: model.calls.length}));
    const errand = engine.agentTurns.at(-1).errands.find(item => item.tool === 'my_sing_voice');
    assert.ok(errand);
    assert.doesNotMatch(errand.result, /group_id is required/);
    assert.deepEqual(calls, [{action: 'send_group_msg', params: {group_id: '99999', message: voice}}]);

    const created = await QQCustomTools.create(JSON.stringify({name: 'my_group_probe', description: 'Group fixture',
      parameters: {type: 'object', properties: {}}, code: "return tools.qq('get_group_info');"}),
    {chat: 'fixture', key: 'synthetic-key', target: {group: true, number: '88888'}});
    assert.ok(tools.find('my_group_probe'), created);
    assert.deepEqual(calls.at(-1), {action: 'get_group_info', params: {group_id: '88888'}});
  } finally {
    engine.pause(); engine.disconnect();
    await fixture.stop();
    gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
    if (previousURL === undefined) delete process.env.DAFEIYU_CODEX_URL;
    else process.env.DAFEIYU_CODEX_URL = previousURL;
    removeDirectory(runtime);
  }
});

test('QQ group defaults are per invocation and preserve explicit destinations and unrelated parameters', async () => {
  const runtime = tempDirectory();
  try {
    const tools = new AgentTools({runtime, qq: async (action, params) => ({action, params})});
    const code = "return tools.qq(args.action, args.params);";
    const cases = [
      [{action: 'send_group_msg', params: {message: voice}}, {group_id: '99999'}, {group_id: '99999', message: voice}],
      [{action: 'get_group_info'}, {group_id: '88888'}, {group_id: '88888'}],
      [{action: 'send_group_msg', params: {group_id: '77777', message: voice}}, {group_id: '99999'}, {group_id: '77777', message: voice}],
      [{action: 'send_private_msg', params: {user_id: '54321', message: voice}}, {group_id: '99999'}, {user_id: '54321', message: voice}],
      [{action: 'get_login_info'}, {group_id: '99999'}, {}],
      [{action: 'send_group_msg', params: {message: voice}}, {}, {message: voice}],
    ];
    await Promise.all(cases.map(async ([args, context, expected]) => {
      const result = await tools.execute(code, args, 'my_context', context);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(JSON.parse(result.output), {action: args.action, params: expected});
    }));
  } finally { removeDirectory(runtime); }
});

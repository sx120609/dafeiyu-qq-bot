// The local Antigravity CLI as a model connection (bridge/antigravity.mjs): one long-running `agy acp`, a session per
// call with its own system prompt and model, director turns continued, pictures as image blocks, nothing allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {AgyServer, AgySessions, antigravityModels, envelopeOf} from '../bridge/antigravity.mjs';

/** A fake `agy acp`: answers the protocol and replies with whatever `answers` holds next. */
function fakeAgy(answers) {
  const seen = {launches: 0, calls: [], replies: []};
  const launch = (file, args, options) => {
    seen.launches++; seen.args = args; seen.cwd = options.cwd;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const send = message => setImmediate(() => child.stdout.emit('data', JSON.stringify({jsonrpc: '2.0', ...message}) + '\n'));
    child.kill = () => setImmediate(() => child.emit('exit', 0));
    let session = 0;
    child.stdin = {on() {}, write(line) {
      const message = JSON.parse(line);
      if (!message.method) { seen.replies.push(message); return; }
      seen.calls.push(message);
      if (message.method === 'initialize') send({id: message.id, result: {protocolVersion: 1, agentCapabilities: {promptCapabilities: {image: true}}}});
      else if (message.method === 'session/new') send({id: message.id, result: {sessionId: 's' + ++session}});
      else if (message.method === 'session/prompt') {
        const text = answers.shift() ?? '{"content":"好","tool_calls":[]}';
        // It asks for a permission first; the gateway must refuse.
        send({id: 900 + message.id, method: 'session/request_permission', params: {sessionId: message.params.sessionId}});
        send({method: 'session/update', params: {sessionId: message.params.sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}}}});
        send({id: message.id, result: {stopReason: 'end_turn', usage: {inputTokens: 1000, cachedReadTokens: 400, outputTokens: 20, thoughtTokens: 10}}});
      } else if (message.id !== undefined) send({id: message.id, result: {}});
    }};
    return child;
  };
  return {launch, seen};
}

test('one agy acp serves every call: its own system prompt and model, pictures, continued turns, nothing allowed', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-'));
  const answers = ['{"content":"","tool_calls":[{"name":"look","arguments":"{\\"x\\":1}"}]}', '```json\n{"content":"看完了","tool_calls":[]}\n```'];
  const {launch, seen} = fakeAgy(answers);
  const sessions = new AgySessions({server: new AgyServer({launch})});
  const config = {tempRoot, antigravity: 'C:/agy/agy.exe'};
  try {
    const tools = [{type: 'function', function: {name: 'look', parameters: {type: 'object'}}}];
    const system = {role: 'system', content: '你是大肥鱼。'};
    const user = {role: 'user', content: [{type: 'text', text: '看看这个'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}]};
    const meta = {dafeiyu_session: 'turn', dafeiyu_purpose: 'director'};
    const one = await sessions.run({messages: [system, user], tools, metadata: meta}, config, {model: 'gemini-4-neon-low'});
    assert.deepEqual(seen.args, ['acp', '--agent', 'dafeiyu-acp']);
    const agent = await fs.readFile(path.join(seen.cwd, '.agents', 'agents', 'dafeiyu-acp.md'), 'utf8');
    assert.match(agent, /tools: \[\]/, 'the agent has no tools');
    const created = seen.calls.find(c => c.method === 'session/new');
    assert.match(created.params._meta.antigravity.systemPrompt.append, /你是大肥鱼。/);
    assert.equal(seen.calls.find(c => c.method === 'session/set_model').params.modelId, 'gemini-4-neon-low');
    const prompt = seen.calls.find(c => c.method === 'session/prompt').params.prompt;
    assert.deepEqual(prompt[1], {type: 'image', mimeType: 'image/png', data: 'AAAA'}, 'the picture goes as an image block');
    assert.ok(JSON.parse(prompt[0].text).conversation, 'the first round carries the conversation');
    assert.deepEqual(seen.replies[0].result, {outcome: {outcome: 'cancelled'}}, 'a permission request is refused');
    const call = one.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'look'); assert.equal(one.usage.prompt_tokens, 1000); assert.equal(one.usage.cached_tokens, 400);
    // The next round continues the same session with only what is new.
    const two = await sessions.run({messages: [system, user, one.choices[0].message, {role: 'tool', tool_call_id: call.id, content: '看到了'}], tools, metadata: meta},
      config, {model: 'gemini-4-neon-low'});
    assert.equal(two.choices[0].message.content, '看完了', 'a fenced JSON reply is read');
    assert.equal(seen.calls.filter(c => c.method === 'session/new').length, 1, 'same session');
    const second = JSON.parse(seen.calls.filter(c => c.method === 'session/prompt')[1].params.prompt[0].text);
    assert.equal(second.available_tools, 'unchanged'); assert.equal(second.new_messages[0].for_call.name, 'look');
    // A lone call: a session of its own on the same process, closed afterwards.
    answers.push('不是 JSON 的回答', '{"content":"好的","tool_calls":[]}');
    const lone = await sessions.run({messages: [{role: 'user', content: '你好'}], tools}, config, {model: 'gemini-4-neon-low'});
    assert.equal(lone.choices[0].message.content, '好的', 'a reply in the wrong shape is asked for again once');
    assert.equal(seen.launches, 1, 'no restart');
    assert.ok(seen.calls.some(c => c.method === 'session/close'));
    // When the process ends, the next call starts it again.
    sessions.server.child.emit('exit', 1);
    await sessions.run({messages: [{role: 'user', content: '在吗'}]}, config, {model: 'gemini-4-neon-low'});
    assert.equal(seen.launches, 2);
  } finally { sessions.server.stop(); await fs.rm(tempRoot, {recursive: true, force: true}); }
});

test('the reply envelope is read from text, and the model list from agy models', async () => {
  assert.deepEqual(envelopeOf('好的：{"content":"嗯","tool_calls":[]} 完'), {content: '嗯', tool_calls: []});
  assert.equal(envelopeOf('就是一句话'), undefined);
  const models = await antigravityModels({}, {run: async () => ({code: 0, err: '', out: 'gemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n'})});
  assert.deepEqual(models.map(m => m.id), ['gemini-4-neon-high', 'claude-opus-5-5-low']);
});

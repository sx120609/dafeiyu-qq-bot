// A director turn on Claude Code is one Agent SDK session (11-03): the first round sends the conversation, later
// rounds only what is new, the cost is metered per round, and anything that does not continue the session (a
// retried turn, another model) starts a new one. A fake SDK `query` stands in for Claude Code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeSessions, sessionNote} from '../bridge/claude-session.mjs';
import {runClaude, claudeSessionOptions} from '../bridge/providers.mjs';

function fakeSDK(answer) {
  const sessions = [];
  const query = ({prompt, options}) => {
    const session = {options, inputs: [], closed: false};
    sessions.push(session);
    let cost = 0;
    const iterator = (async function* () {
      for await (const message of prompt) {
        if (session.closed) return;
        session.inputs.push(message);
        const text = message.message.content[0].text;
        const reply = await answer(JSON.parse(text), session);
        if (reply.stderr) { options.stderr(reply.stderr); await new Promise(resolve => setTimeout(resolve, 50)); continue; }
        if (reply.hang) { await new Promise(resolve => options.abortController.signal.addEventListener('abort', resolve, {once: true})); return; }
        cost += 0.01;
        yield {type: 'system', subtype: 'init'};
        yield reply.result ?? {type: 'result', subtype: 'success', is_error: false, structured_output: reply, total_cost_usd: cost,
          usage: {input_tokens: 3, cache_read_input_tokens: 1000 * session.inputs.length, cache_creation_input_tokens: 50, output_tokens: 20}, modelUsage: {'claude-test': {}}};
      }
    })();
    iterator.close = () => { session.closed = true; };
    return iterator;
  };
  return {query, sessions};
}
const tool = name => ({type: 'function', function: {name, description: name, parameters: {type: 'object', properties: {}}}});
const director = (messages, session = 'turn-1', tools = [tool('send_message'), tool('end_turn')]) =>
  ({model: 'gpt-6-astra', messages, tools, metadata: {dafeiyu_purpose: 'director', dafeiyu_session: session}});
const options = {model: 'opus', effort: 'medium', tools: []};

test('a director turn keeps one session and sends only what is new', async () => {
  const sdk = fakeSDK(input => input.conversation ? {content: '', tool_calls: [{name: 'send_message', arguments: '{"text":"hi"}'}]} : {content: '说完了', tool_calls: []});
  const sessions = new ClaudeSessions({query: sdk.query, spares: 0});
  const first = [{role: 'user', content: '本轮情况'}];
  const one = await sessions.run({key: 'turn-1', system: 'SYSTEM', rest: first, body: director([{role: 'system', content: 'SYSTEM'}, ...first]), options, model: 'opus'});
  const call = one.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, 'send_message');
  assert.equal(one.usage.cost_usd, 0.01);
  assert.equal(one.usage.prompt_tokens, 3 + 50 + 1000);
  assert.equal(one.model, 'claude-test');
  assert.equal(sdk.sessions[0].options.systemPrompt, 'SYSTEM' + sessionNote);
  // The engine's next round: the same conversation, the reply it got, and the tool result.
  const second = [...first, {role: 'assistant', content: '', tool_calls: [call]}, {role: 'tool', tool_call_id: call.id, content: '说「hi」'}];
  const two = await sessions.run({key: 'turn-1', system: 'SYSTEM', rest: second, body: director([{role: 'system', content: 'SYSTEM'}, ...second]), options, model: 'opus'});
  assert.equal(two.choices[0].message.content, '说完了');
  assert.equal(sdk.sessions.length, 1, 'no new process for the second round');
  const sent = JSON.parse(sdk.sessions[0].inputs[1].message.content[0].text);
  assert.deepEqual(sent.new_messages, [{role: 'tool', for_call: {name: 'send_message', arguments: '{"text":"hi"}'}, content: '说「hi」'}]);
  assert.equal(sent.available_tools, 'unchanged');
  assert.equal(sent.conversation, undefined);
  assert.ok(Math.abs(two.usage.cost_usd - 0.01) < 1e-9, 'each round is metered with its own share of the session cost');
  // A conversation that does not continue it (a retried turn starts over) gets a new session.
  await sessions.run({key: 'turn-1', system: 'SYSTEM', rest: first, body: director([{role: 'system', content: 'SYSTEM'}, ...first]), options, model: 'opus'});
  assert.equal(sdk.sessions.length, 2);
  assert.equal(sdk.sessions[0].closed, true);
  // Another model is another session too.
  const third = [...first, {role: 'assistant', content: '', tool_calls: [{id: 'x', type: 'function', function: {name: 'send_message', arguments: '{}'}}]}, {role: 'tool', tool_call_id: 'x', content: 'ok'}];
  await sessions.run({key: 'turn-1', system: 'SYSTEM', rest: third, body: director([{role: 'system', content: 'SYSTEM'}, ...third]), options: {...options, model: 'sonnet'}, model: 'sonnet'});
  assert.equal(sdk.sessions.length, 3);
  sessions.closeAll();
  assert.equal(sessions.size, 0);
});

test('the next turn of a chat finds a session that has already started', async () => {
  const sdk = fakeSDK(() => ({content: '', tool_calls: [{name: 'end_turn', arguments: '{}'}]}));
  const sessions = new ClaudeSessions({query: sdk.query, spares: 1});
  const rest = [{role: 'user', content: '本轮'}];
  await sessions.run({key: 'turn-1', system: 'S', rest, body: director(rest, 'turn-1'), options, model: 'opus'});
  assert.equal(sdk.sessions.length, 2, 'a spare was started for the next turn');
  assert.equal(sdk.sessions[1].inputs.length, 0);
  await sessions.run({key: 'turn-2', system: 'S', rest, body: director(rest, 'turn-2'), options, model: 'opus'});
  assert.equal(sdk.sessions[1].inputs.length, 1, 'the next turn used it');
  assert.equal(sdk.sessions.length, 3, 'and another spare waits');
  // Another chat (another system prompt) starts its own; only `spares` of them wait.
  await sessions.run({key: 'turn-3', system: 'OTHER', rest, body: director(rest, 'turn-3'), options, model: 'opus'});
  assert.equal(sessions.spares.size, 1);
  assert.equal(sdk.sessions[2].closed, true);
  sessions.closeAll();
  assert.equal(sessions.spares.size, 0);
});

test('images go along as Claude image blocks, and new tools are sent when they change', async () => {
  const sdk = fakeSDK(() => ({content: '', tool_calls: [{name: 'send_message', arguments: '{}'}]}));
  const sessions = new ClaudeSessions({query: sdk.query, spares: 0});
  const first = [{role: 'user', content: [{type: 'text', text: '看图'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}]}];
  const one = await sessions.run({key: 't', system: 'S', rest: first, body: director(first), options, model: 'opus'});
  const content = sdk.sessions[0].inputs[0].message.content;
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.data, 'AAAA');
  assert.ok(content[0].text.includes('[附件图片 1]'));
  const call = one.choices[0].message.tool_calls[0];
  const next = [...first, {role: 'assistant', content: '', tool_calls: [call]}, {role: 'tool', tool_call_id: call.id, content: 'ok'}];
  await sessions.run({key: 't', system: 'S', rest: next, body: director(next, 't', [tool('send_message'), tool('my_new_tool')]), options, model: 'opus'});
  const sent = JSON.parse(sdk.sessions[0].inputs[1].message.content[0].text);
  assert.deepEqual(sent.available_tools.map(item => item.function.name), ['send_message', 'my_new_tool']);
  sessions.closeAll();
});

test('a cancelled round, a 429 and a failed result end the session with the error', async () => {
  let mode = 'hang';
  const sdk = fakeSDK(() => mode === 'hang' ? {hang: true} : mode === '429' ? {stderr: 'API Error: 429 Too Many Requests, retry after 30s'}
    : {result: {type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0}});
  const sessions = new ClaudeSessions({query: sdk.query, spares: 0});
  const rest = [{role: 'user', content: 'x'}];
  const controller = new AbortController();
  const pending = sessions.run({key: 'a', system: 'S', rest, body: director(rest), options, signal: controller.signal, model: 'opus'});
  setTimeout(() => controller.abort(new Error('请求已取消')), 50);
  await assert.rejects(pending, /请求已取消/);
  assert.equal(sdk.sessions[0].closed, true);
  assert.equal(sessions.size, 0);
  mode = '429';
  await assert.rejects(sessions.run({key: 'b', system: 'S', rest, body: director(rest), options, model: 'opus'}), error => error.status === 429 && error.retryAfter === 30);
  mode = 'error';
  await assert.rejects(sessions.run({key: 'c', system: 'S', rest, body: director(rest), options, model: 'opus'}), /Claude 未返回有效结构化回复/);
  assert.equal(sessions.size, 0);
});

test('runClaude uses a session only for a named director turn, with Claude Code restricted as before', async () => {
  const seen = [];
  const sessions = {run: async request => { seen.push(request); return {choices: [{message: {content: 'ok'}}]}; }};
  const config = {claude: 'claude.exe', tempRoot: 'D:\\temp', claudeSessions: true};
  const body = director([{role: 'system', content: '人设'}, {role: 'user', content: '本轮'}]);
  await runClaude(body, config, {model: 'opus'}, undefined, {sessions});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'turn-1');
  assert.ok(seen[0].system.includes('人设'));
  assert.deepEqual(seen[0].rest, [{role: 'user', content: '本轮'}]);
  const restricted = claudeSessionOptions(config, {model: 'opus'}, {webSearch: false});
  assert.deepEqual(restricted.tools, []);
  assert.deepEqual(restricted.disallowedTools, ['mcp__*']);
  assert.equal(restricted.persistSession, false);
  assert.deepEqual(restricted.settingSources, []);
  assert.deepEqual(restricted.mcpServers, {});
  assert.equal(restricted.outputFormat.type, 'json_schema');
  assert.deepEqual(claudeSessionOptions(config, {model: 'opus'}, {webSearch: true}).tools, ['WebSearch']);
  // Without a session name, or with sessions turned off, it is the one-shot process as before (not run here).
  await assert.rejects(runClaude({...body, metadata: {dafeiyu_purpose: 'director'}}, {...config, claude: ''}, {model: 'opus'}, undefined, {sessions}), /未检测到/);
  assert.equal(seen.length, 1);
});

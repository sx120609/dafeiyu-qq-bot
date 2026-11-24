// The local Antigravity CLI as a model connection (bridge/antigravity.mjs): a custom agent with only `finish`, the
// request on stdin, the structured reply and usage read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAntigravity, antigravityModels} from '../bridge/antigravity.mjs';

test('a reply goes through a custom agent with only finish, the request on stdin, pictures left out', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-'));
  let call;
  const run = async (file, args, options) => {
    call = {file, args, ...options};
    const result = {status: 'SUCCESS', structured_output: {content: '', tool_calls: [{name: 'look', arguments: '{"x":1}'}]},
      usage: {input_tokens: 2100, output_tokens: 30, thinking_tokens: 20, cache_read_tokens: 100}};
    return {code: 0, err: '', out: JSON.stringify({event: 'progress'}) + '\n' + JSON.stringify({event: 'result', result}) + '\n'};
  };
  try {
    const body = {messages: [{role: 'system', content: '你是大肥鱼。'}, {role: 'user', content: [{type: 'text', text: '看看这个'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}]}],
      tools: [{type: 'function', function: {name: 'look', parameters: {type: 'object'}}}]};
    const reply = await runAntigravity(body, {tempRoot, antigravity: 'C:/agy/agy.exe'}, {model: 'gemini-4-neon-low'}, undefined, {run});
    const flag = name => call.args[call.args.indexOf(name) + 1];
    assert.equal(call.file, 'C:/agy/agy.exe'); assert.equal(flag('--model'), 'gemini-4-neon-low');
    assert.equal(flag('--input-format'), 'stream-json'); assert.ok(flag('--json-schema').includes('tool_calls'));
    const agent = await fs.readFile(path.join(call.cwd, '.agents', 'agents', flag('--agent') + '.md'), 'utf8');
    assert.match(agent, /tools: \[finish\]/); assert.match(agent, /你是大肥鱼。/); assert.match(agent, /Pictures in the conversation are not visible/);
    const line = JSON.parse(call.input);
    assert.equal(line.event, 'user'); assert.equal(line.message.content[0].type, 'text');
    const envelope = JSON.parse(line.message.content[0].text);
    assert.ok(!JSON.stringify(envelope).includes('AAAA'), 'no picture data'); assert.ok(JSON.stringify(envelope).includes('看不到图片'));
    assert.equal(envelope.conversation.length, 1, 'the system text is in the agent, not the request');
    assert.equal(reply.choices[0].message.tool_calls[0].function.name, 'look');
    assert.equal(reply.usage.prompt_tokens, 2100); assert.equal(reply.usage.cached_tokens, 100); assert.equal(reply.model, 'gemini-4-neon-low');
    const failed = async () => ({code: 1, err: '', out: JSON.stringify({event: 'result', result: {status: 'ERROR', error: 'quota exhausted'}})});
    await assert.rejects(runAntigravity(body, {tempRoot}, {model: 'x'}, undefined, {run: failed}), /quota exhausted/);
    await assert.rejects(runAntigravity(body, {tempRoot}, {model: ''}, undefined, {run}), /还没选/);
    const models = await antigravityModels({}, {run: async () => ({code: 0, err: 'Fetching available models...', out: 'gemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n'})});
    assert.deepEqual(models.map(m => m.id), ['gemini-4-neon-high', 'claude-opus-5-5-low']);
  } finally { await fs.rm(tempRoot, {recursive: true, force: true}); }
});

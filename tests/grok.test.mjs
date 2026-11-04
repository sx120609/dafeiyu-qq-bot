// Grok Build as the bot's X and web search (bridge/grok.mjs): only its web search tool, its answer and cost read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {grokSearch, grokPrompt} from '../bridge/grok.mjs';

test('Grok searches with web_search alone and its answer, links and cost come back', async () => {
  let call;
  const run = async (file, args, options) => {
    call = {file, args, env: options.env, cwd: options.cwd};
    return {code: 0, err: '', out: JSON.stringify({text: '结论：发了新功能。\n1. 2026-11-02 https://x.com/someone/status/1 （转发）', stopReason: 'end_turn',
      usage: {input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40}, total_cost_usd: 0.3, modelUsage: {'grok-4.7-build': {inputTokens: 100, outputTokens: 20}}})};
  };
  const config = {tempRoot: os.tmpdir(), grok: 'C:/grok/grok.exe'};
  const found = await grokSearch({query: '@someone 最近发了什么', scope: 'x'}, config, {run});
  assert.equal(call.file, 'C:/grok/grok.exe');
  const flag = name => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag('--tools'), 'web_search', 'its only tool');
  for (const tool of ['run_terminal_cmd', 'task', 'web_fetch', 'read_file', 'write']) assert.ok(flag('--disallowed-tools').split(',').includes(tool), tool);
  assert.ok(call.args.includes('--no-subagents')); assert.equal(flag('--output-format'), 'json');
  assert.match(flag('-p'), /只在 X/); assert.match(flag('-p'), /@someone 最近发了什么/);
  assert.ok(call.env.GROK_WEB_SEARCH_MODEL, 'web search gets a model even when the config leaves it empty');
  assert.equal(found.model, 'grok-4.7-build'); assert.deepEqual(found.sources, ['https://x.com/someone/status/1']);
  assert.equal(found.usage.cost_usd, 0.3); assert.equal(found.usage.prompt_tokens_details.cached_tokens, 40);
  assert.match(grokPrompt('x'), /X（推特）和全网/, 'the default searches X and the web');
  await assert.rejects(grokSearch({query: ''}, config, {run}), /1–500/);
  await assert.rejects(grokSearch({query: 'x'}, config, {run: async () => ({out: 'You are not authenticated.', err: ''})}), /grok login/);
  await assert.rejects(grokSearch({query: 'x'}, config, {run: async () => ({out: JSON.stringify({text: '', stopReason: 'max_turn_requests'}), err: ''})}), /没收住/);
});

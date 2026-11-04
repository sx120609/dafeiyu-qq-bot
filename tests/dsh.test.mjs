// The models of the local DeepSeek Harness (bridge/dsh.mjs): read from dsh's own settings and keys, called directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {dshCatalog, dshModels, dshProfile, runDsh} from '../bridge/dsh.mjs';
import {dispatch} from '../bridge/providers.mjs';

async function home(baseUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-home-'));
  await fs.writeFile(path.join(dir, 'settings.yaml'), [
    'llm-pi-ai:', '  providers:',
    '    gateway:', '      displayName: Synthetic Gateway', '      apiKeyEnv: SYNTHETIC_KEY', '      api: openai-completions', `      baseURL: ${baseUrl}`,
    '      models:', '        - id: model-a', '          name: Model A', '        - id: model-b',
    '    native:', '      displayName: Some Other API', '      apiKeyEnv: OTHER_KEY', '      api: google-generative-ai', '      baseURL: https://example.invalid',
    '      models:', '        - id: model-c',
    '    keyless:', '      apiKeyEnv: MISSING_KEY', '      api: openai-completions', '      baseURL: https://example.invalid', '      models:', '        - id: model-d', ''].join('\n'));
  await fs.writeFile(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  SYNTHETIC_KEY: "stored-key"\n  OTHER_KEY: "other"\n');
  await fs.writeFile(path.join(dir, '.env'), 'MISSING_KEY=\n');
  return dir;
}

test('dsh models come from its settings, with the keys it keeps; only callable ones are listed', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks))});
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({model: 'model-a', choices: [{finish_reason: 'tool_calls', message: {content: '', tool_calls: [{id: 'c1', type: 'function', function: {name: 'look', arguments: '{"x":1}'}}]}}], usage: {prompt_tokens: 3, completion_tokens: 2}}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = await home(`http://127.0.0.1:${server.address().port}/v1`);
  try {
    const catalog = await dshCatalog({home: dir, env: {}});
    assert.deepEqual(catalog.map(p => [p.id, p.protocol, !!p.apiKey]), [['gateway', 'openai', true], ['native', null, true], ['keyless', 'openai', false]]);
    const models = await dshModels({home: dir, env: {}});
    assert.deepEqual(models.map(m => m.id), ['gateway/model-a', 'gateway/model-b'], 'an unsupported API and a provider without a key are left out');
    assert.equal(models[0].description, 'Synthetic Gateway');
    // The environment comes before dsh's stored key, as in dsh itself.
    assert.equal((await dshProfile('gateway/model-a', {home: dir, env: {SYNTHETIC_KEY: 'env-key'}})).apiKey, 'env-key');
    const result = await runDsh({messages: [{role: 'user', content: 'hi'}], tools: [{type: 'function', function: {name: 'look', parameters: {type: 'object'}}}]},
      {model: 'gateway/model-a'}, undefined, {home: dir, env: {}});
    assert.equal(seen[0].url, '/v1/chat/completions'); assert.equal(seen[0].auth, 'Bearer stored-key'); assert.equal(seen[0].body.model, 'model-a');
    assert.equal(seen[0].body.tools[0].function.name, 'look');
    assert.equal(result.model, 'gateway/model-a'); assert.equal(result.choices[0].message.tool_calls[0].function.name, 'look');
    await assert.rejects(dshProfile('keyless/model-d', {home: dir, env: {}}), /没存/);
    await assert.rejects(dshProfile('native/model-c', {home: dir, env: {}}), /不支持/);
    await assert.rejects(dshProfile('model-a', {home: dir, env: {}}), /服务商\/模型/);
    await assert.rejects(dshCatalog({home: path.join(dir, 'nowhere'), env: {}}), /没找到本机 dsh/);
    // The gateway's dispatch hands provider 'dsh' to it (default home: none here, so it says so).
    await assert.rejects(dispatch({messages: [{role: 'user', content: 'x'}]}, {}, 'dsh', {model: 'gateway/model-a'}).catch(error => { throw error; }), /dsh/);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir, {recursive: true, force: true}); }
});

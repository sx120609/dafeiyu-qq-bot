// The image API of its own (11-07): drawing on an address and key apart from the chat connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {Settings, createGateway} from '../bridge/gateway.mjs';
import {ConsoleAuth} from '../bridge/auth.mjs';
import {png} from './engine-fixtures.mjs';

test('drawing uses the image API first, keeps its key private, and the chat connection can be Anthropic', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'image-api-'));
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks))});
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({data: [{b64_json: png().toString('base64')}]}));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const settings = await new Settings(path.join(temp, 'providers.json')).load();
  // Chat goes to an Anthropic connection, whose image model cannot draw.
  Object.assign(settings.value.profiles.cloud, {protocol: 'anthropic', apiKey: 'chat-key', imageModel: 'gpt-image-2.6-sunburst'});
  assert.equal(settings.imageSource(), null, 'an Anthropic connection is not an image source');
  assert.equal(settings.view().image.source, '本机 Codex');
  const auth = await new ConsoleAuth({runtime: temp, secret: 'console-secret'}).load();
  const gateway = createGateway({token: 'x'.repeat(40), consoleToken: 'console-secret', tempRoot: temp}, settings, {runtime: temp, auth, autostart: {status: async () => ({})}});
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const post = (route, body, key = 'console-secret') => fetch(base + route, {method: 'POST', headers: {Authorization: 'Bearer ' + key, Origin: base, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  try {
    const saved = await (await post('/console/api/image-api', {revision: settings.value.revision, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'image-key', model: 'gpt-image-2.6-sunburst'})).json();
    assert.equal(saved.image.hasApiKey, true); assert.equal(saved.image.apiKey, undefined, 'the key never goes back to the page');
    assert.equal(saved.image.source, '生图接口');
    assert.equal((await post('/console/api/image-api', {revision: 'stale', model: 'x'})).status, 409);
    // The engine's own call: the model token, no Origin.
    const drawn = await (await fetch(base + '/v1/images/generations', {method: 'POST', headers: {Authorization: 'Bearer ' + 'x'.repeat(40), 'Content-Type': 'application/json'},
      body: JSON.stringify({prompt: '一只鲸鱼', animated: true, frame_count: 4})})).json();
    assert.ok(seen.length, JSON.stringify(drawn).slice(0, 300));
    assert.equal(seen[0].url, '/v1/images/generations'); assert.equal(seen[0].auth, 'Bearer image-key');
    assert.equal(seen[0].body.model, 'gpt-image-2.6-sunburst'); assert.equal(seen[0].body.output_format, 'gif');
    // Clearing the key falls back to the cloud API (if it can draw) or the local Codex.
    const cleared = await (await post('/console/api/image-api', {revision: settings.value.revision, clearKey: true})).json();
    assert.equal(cleared.image.hasApiKey, false); assert.equal(cleared.image.source, '本机 Codex');
  } finally {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]);
    await fs.rm(temp, {recursive: true, force: true});
  }
});

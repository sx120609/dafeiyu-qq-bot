// Port of upstream/Tests/QQEngineTests/QQSharedPanelTests.swift, plus the HTTP checks of
// upstream/scripts/test-control-panel.py that concern the control server itself (raw loopback HTTP).
// Not ported: the two `weak` release checks (JS has no deinit; a server is closed by stop()).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {OneBotFixture, tempDirectory, removeDirectory, wait} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {QQControlServer} from '../engine/QQControlServer.mjs';

/** One raw HTTP/1.1 exchange; returns {code, headers, body}. */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const data = Buffer.concat(chunks), end = data.indexOf('\r\n\r\n');
      const head = data.subarray(0, end < 0 ? data.length : end).toString('utf8').split('\r\n');
      const headers = Object.fromEntries(head.slice(1).map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      resolve({code: Number(head[0].split(' ')[1]), status: head[0], headers, body: end < 0 ? Buffer.alloc(0) : data.subarray(end + 4)});
    });
    socket.write(text);
  });
}
function request(server, {action, token, origin, path: pathname, method, body, contentType, host} = {}) {
  const url = new URL(server.controlURL), port = Number(url.port);
  const payload = body ?? (action ? Buffer.from(JSON.stringify(action)) : Buffer.alloc(0));
  const lines = [`${method ?? (action ? 'POST' : 'GET')} ${pathname ?? (action ? '/api/action' : '/api/status')} HTTP/1.1`, `Host: ${host ?? `127.0.0.1:${port}`}`];
  if (token !== null) lines.push(`X-QQ-Control: ${token ?? url.hash.slice(1)}`);
  if (origin !== null) lines.push(`Origin: ${origin ?? `http://127.0.0.1:${port}`}`);
  if (contentType !== null && (action || body)) lines.push(`Content-Type: ${contentType ?? 'application/json'}`);
  lines.push(`Content-Length: ${payload.length}`);
  return raw(port, Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n'), payload])).then(result => {
    let json = {};
    try { json = JSON.parse(result.body.toString('utf8')); } catch {}
    return {...result, json};
  });
}
async function requireClosedPort(controlURL) {
  const port = Number(new URL(controlURL).port);
  const deadline = Date.now() + 1000;
  while (true) {
    const refused = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); resolve(false); });
      socket.on('error', error => resolve(error.code === 'ECONNREFUSED'));
    });
    if (refused) return;
    if (Date.now() > deadline) assert.fail('Closed control port did not refuse TCP connections within one second');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('nativeAndWebShareConfigurationAndRejectStaleEdits', async () => {
  const directory = tempDirectory();
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
  engine.save({expectedSelfID: '12345'});
  const server = await QQControlServer.create(engine); server.start(false);
  try {
    const initial = await request(server);
    assert.ok(initial.code === 200 && server.isRunning);
    const oldRevision = initial.json.configurationRevision;
    assert.equal(typeof oldRevision, 'string');
    // Native saves through the same engine that owns the live Web surface.
    engine.save({endpoint: 'ws://127.0.0.1:3199'});
    const current = (await request(server)).json;
    assert.equal(current.config.endpoint, engine.config.endpoint);
    const stale = (await request(server, {action: {action: 'saveConnection', configurationRevision: oldRevision, endpoint: 'ws://127.0.0.1:3188'}})).json;
    assert.ok(stale.error);
    assert.equal(engine.config.endpoint, 'ws://127.0.0.1:3199');
    const saved = (await request(server, {action: {action: 'saveConnection', configurationRevision: current.configurationRevision, endpoint: 'ws://127.0.0.1:3177'}})).json;
    assert.equal(saved.error, '');
    assert.equal(engine.config.endpoint, 'ws://127.0.0.1:3177');
    const reopened = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    assert.ok(reopened.config.equals(engine.config));
    assert.ok(!engine.connected && !engine.running && engine.usage.calls === 0 && engine.sends.attempts === 0);
  } finally { server.stop(); removeDirectory(directory); }
});

test('closingSurfaceRevokesAccessButPreservesEngineAndCredentials', async () => {
  const engine = new QQEngine({preview: true, allowAuthenticationUI: false});
  assert.ok(engine.useTemporaryCredentials('synthetic-token', 'synthetic-key'));
  const server = await QQControlServer.create(engine);
  const oldURL = server.controlURL;
  server.start(false); server.start(false);
  assert.equal((await request(server)).code, 200);
  server.stop(); server.stop();
  assert.ok(!server.isRunning && engine.usesTemporaryCredentials);
  assert.equal(engine.status, '临时凭证已就绪，仅在本次应用运行期间使用');
  // A stopped object cannot resurrect its old token/listener.
  server.start(false); assert.ok(!server.isRunning);
  await requireClosedPort(oldURL);
  const next = await QQControlServer.create(engine); next.start(false);
  try {
    assert.notEqual(new URL(next.controlURL).hash, new URL(oldURL).hash);
    assert.equal((await request(next, {token: new URL(oldURL).hash.slice(1)})).code, 403);
    assert.equal((await request(next)).code, 200);
  } finally { next.stop(); }
});

test('unstartedSurfaceCanBeStoppedAndReleased', async () => {
  const engine = new QQEngine({preview: true, allowAuthenticationUI: false});
  const server = await QQControlServer.create(engine);
  server.stop();
  await requireClosedPort(server.controlURL);
});

test('closingAndReopeningWebPreservesRunningEngineUntilExplicitPause', async () => {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape: 'private'}).start();
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
  try {
    engine.save({endpoint: fixture.endpoint, expectedSelfID: '12345'});
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
    await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
    engine.add(engine.contacts.find(contact => !contact.group));
    engine.saveReplySettings({ai: engine.config.ai, persona: engine.config.effectivePersona, enabledTargets: new Set(['private:54321'])});
    engine.start({duration: 120}); assert.ok(engine.running, engine.error ?? engine.status);
    const deadline = engine.runDeadline;
    assert.ok(deadline);
    // No ready marker is written: the synthetic peer emits no messages.
    const server = await QQControlServer.create(engine); server.start(false);
    assert.equal((await request(server)).json.running, true);
    server.stop();
    assert.ok(engine.running && engine.connected && engine.usesTemporaryCredentials);
    assert.equal(engine.runDeadline, deadline);
    await requireClosedPort(server.controlURL);
    const reopened = await QQControlServer.create(engine); reopened.start(false);
    try {
      assert.notEqual(new URL(reopened.controlURL).hash, new URL(server.controlURL).hash);
      assert.equal((await request(reopened)).json.running, true);
      assert.equal(engine.runDeadline, deadline);
      const paused = (await request(reopened, {action: {action: 'pause'}})).json;
      assert.equal(paused.running, false);
      assert.ok(!engine.running && engine.connected && engine.runDeadline === undefined && engine.queuedCount === 0);
      assert.ok(engine.usage.calls === 0 && engine.sends.attempts === 0);
      assert.ok(!fixture.actions.includes('send_private_msg') && !fixture.actions.includes('send_group_msg'));
    } finally { reopened.stop(); }
  } finally { engine.disconnect(); await fixture.stop(); removeDirectory(directory); }
});

/// From test-control-panel.py: assets, authentication, Origin/Host, malformed requests, stale editors, records.
test('controlPanelProtocolMatchesTheSwiftServer', async () => {
  const directory = tempDirectory();
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
  const server = await QQControlServer.create(engine); server.start(false);
  const port = Number(new URL(server.controlURL).port), host = `127.0.0.1:${port}`;
  try {
    assert.equal((await request(server, {path: '/', token: null, origin: null})).code, 200);
    for (const [asset, mime] of [['/style.css', 'text/css'], ['/logo.png', 'image/png'], ['/sticker-pack.js', 'text/javascript']]) {
      const response = await request(server, {path: asset, token: null, origin: null});
      assert.equal(response.code, 200);
      assert.equal(response.headers['content-type'], mime + '; charset=utf-8');
      assert.ok(response.body.length && (asset !== '/logo.png' || response.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));
      assert.ok(response.headers['content-security-policy'].includes("style-src 'self'"));
      assert.equal(response.status, 'HTTP/1.1 200 Response');
    }
    assert.equal((await request(server, {path: '/../logo.png', token: null, origin: null})).code, 403);
    assert.equal((await request(server, {token: null, origin: null})).code, 403);
    const state = (await request(server)).json;
    assert.ok(!state.connected && !state.running);
    assert.deepEqual(state.configurationHints, []);
    assert.deepEqual(state.runtimeRecords, []);
    assert.ok(state.calls === 0 && state.confirmed === 0);
    assert.equal((await request(server, {origin: 'https://invalid.example'})).code, 403);
    assert.equal((await request(server, {host: 'invalid.example'})).code, 400);
    // The social panel is authenticated; the Node engine does not run it.
    assert.equal((await request(server, {path: '/api/social-panel', method: 'POST', token: null, body: Buffer.from('{"platform":"bilibili"}')})).code, 403);
    assert.equal((await request(server, {path: '/api/social-panel', method: 'POST', body: Buffer.from('{"platform":"unknown"}')})).code, 400);
    assert.equal((await request(server, {path: '/api/social-panel', method: 'POST', body: Buffer.from('{"platform":"bilibili"}')})).code, 503);
    assert.equal((await request(server, {action: {action: 'pause'}, contentType: null})).code, 403);
    assert.equal((await request(server, {action: {action: 'pause'}})).code, 200);
    let revision = state.configurationRevision;
    const action = async payload => {
      payload.configurationRevision ??= revision;
      const response = await request(server, {action: payload});
      assert.equal(response.code, 200);
      revision = response.json.configurationRevision;
      return response.json;
    };
    let saved = await action({action: 'saveConnection', expectedSelfID: '12345', endpoint: 'ws://127.0.0.1:3101'});
    assert.ok(saved.configurationSaved && !saved.error && saved.config.endpoint === 'ws://127.0.0.1:3101');
    let invalid = await action({action: 'saveConnection', expectedSelfID: '54321', endpoint: 'ws://example.invalid:3101'});
    assert.ok(invalid.error); assert.deepEqual(invalid.config, saved.config);
    const ai = {...saved.config.ai, workHoursEnabled: true, workStart: 22, workEnd: 7};
    const oldRevision = saved.configurationRevision;
    saved = await action({action: 'save', ai, enabled: []});
    assert.ok(!saved.error && saved.config.ai.workStart === 22 && !saved.running);
    assert.notEqual(saved.configurationRevision, oldRevision);
    const conflict = await action({action: 'save', ai: {...ai, dailyLimit: 17}, configurationRevision: oldRevision});
    assert.ok(conflict.error); assert.deepEqual(conflict.config, saved.config);
    // Safety operations are intentionally available even with a stale editor.
    const paused = await action({action: 'pause', configurationRevision: oldRevision});
    assert.ok(!paused.error && !paused.running); assert.deepEqual(paused.config, saved.config);
    invalid = await action({action: 'save', enabled: ['group:99999']});
    assert.ok(invalid.error); assert.deepEqual(invalid.config, saved.config);
    const custom = {...saved.persona, style: 'custom', customName: 'synthetic character', customPrompt: 'Use concise, patient replies.'};
    saved = await action({action: 'save', persona: custom});
    assert.ok(!saved.error); assert.deepEqual(saved.persona, custom);
    for (const prompt of ['', 'x'.repeat(4001)]) {
      invalid = await action({action: 'save', persona: {...custom, customPrompt: prompt}});
      assert.ok(invalid.error); assert.deepEqual(invalid.config, saved.config);
    }
    const priorAI = saved.config.ai;
    const image = {...saved.imageGeneration, enabled: true, fallbackEnabled: false};
    saved = await action({action: 'saveImageGeneration', imageGeneration: image, persistImageCredentials: false});
    assert.ok(saved.configurationSaved && !saved.error); assert.deepEqual(saved.imageGeneration, image); assert.deepEqual(saved.config.ai, priorAI);
    invalid = await action({action: 'saveImageGeneration', imageGeneration: {...image, cloudflareAccountID: 'invalid'}});
    assert.ok(invalid.error); assert.deepEqual(invalid.config, saved.config);
    const visual = {...saved.visualTools, provider: 'zhipu', googleWebEnabled: true};
    saved = await action({action: 'saveVisualTools', visualTools: visual, persistVisualCredentials: false});
    assert.ok(saved.configurationSaved && !saved.error); assert.deepEqual(saved.visualTools, visual);
    assert.ok(saved.configurationHints.some(hint => hint.includes('启用识图')));
    const artwork = {...saved.artwork, scheduleMinute: 19};
    saved = await action({action: 'saveArtwork', artwork});
    assert.ok(!saved.error && saved.artwork.scheduleMinute === 19);
    invalid = await action({action: 'saveArtwork', artwork: {...artwork, scheduleTargets: ['group:99999']}});
    assert.ok(invalid.error); assert.deepEqual(invalid.config, saved.config);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'qq-state.json'), 'utf8')).config, saved.config);
    for (const text of [`GET /api/status HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\n\r\n`,
      `POST /api/action HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\n\r\n`,
      `POST /api/action HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 9999999\r\n\r\n`]) {
      assert.ok((await raw(port, text)).status.startsWith('HTTP/1.1 400'));
    }
    // Configuration changes must be saved explicitly before connecting.
    invalid = await action({action: 'connect', endpoint: 'ws://127.0.0.1:3199', expectedSelfID: '12345'});
    assert.ok(invalid.error && !invalid.connected); assert.deepEqual(invalid.config, saved.config);
    assert.equal(saved.calls, 0); assert.equal(saved.confirmed, 0);
  } finally { server.stop(); }
  // Reopen with synthetic historical outcomes: records are bounded, newest first, redacted.
  const file = path.join(directory, 'qq-state.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.logs = Array.from({length: 35}, (_, index) => ({id: crypto.randomUUID(), date: Date.now() / 1000 - 978307200,
    state: index === 34 ? 'uncertain' : 'skipped', detail: `合成结果 ${index}；token=synthetic-private-secret https://example.invalid/?key=hidden`}));
  fs.writeFileSync(file, JSON.stringify(stored));
  const reopened = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
  const again = await QQControlServer.create(reopened); again.start(false);
  try {
    const response = await request(again);
    const records = response.json.runtimeRecords;
    assert.ok(response.code === 200 && records.length === 30);
    assert.ok(records[0].title === '发送结果未知' && records.at(-1).detail.startsWith('合成结果 5；'));
    assert.ok(Math.abs(records[0].timestamp - Date.now() / 1000) < 10);
    assert.deepEqual(new Set(Object.keys(records[0])), new Set(['id', 'timestamp', 'state', 'title', 'target', 'detail']));
    const text = response.body.toString('utf8');
    assert.ok(!text.includes('synthetic-private-secret') && !text.includes('example.invalid'));
    assert.ok(response.json.calls === 0 && response.json.confirmed === 0 && !response.json.running);
  } finally { again.stop(); removeDirectory(directory); }
});

/// engine/main.mjs as the supervisor and qq-host start it: the first stdout line is QQ_CONTROL_URL=..., the
/// credentials file loads as temporary credentials, and the gateway model is selected (LinuxMain.swift).
test('mainPrintsTheControlURLAndLoadsTheCredentialsFile', async () => {
  const {spawn} = await import('node:child_process');
  const readline = await import('node:readline');
  const directory = tempDirectory();
  const credentials = path.join(directory, 'credentials.json');
  fs.writeFileSync(credentials, JSON.stringify({token: 'synthetic-test-token', key: 'synthetic-key'}));
  // An unused loopback port: nothing calls the gateway until replies start.
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../engine/main.mjs'), '--qq-control-panel'], {cwd: directory,
    env: {...process.env, DAFEIYU_DATA_DIR: directory, DAFEIYU_CODEX_URL: 'http://127.0.0.1:9/v1', DAFEIYU_CREDENTIALS_FILE: credentials}, stdio: ['ignore', 'pipe', 'pipe']});
  try {
    const line = await new Promise((resolve, reject) => {
      readline.createInterface({input: child.stdout}).once('line', resolve);
      child.once('exit', code => reject(new Error('exited ' + code)));
    });
    assert.ok(line.startsWith('QQ_CONTROL_URL=http://127.0.0.1:'), line);
    const url = new URL(line.slice('QQ_CONTROL_URL='.length));
    const response = await request({controlURL: url.href});
    assert.equal(response.code, 200);
    assert.ok(response.json.temporaryCredentials && !response.json.connected && !response.json.running);
    assert.equal(response.json.config.ai.model, 'dafeiyu-active');
    assert.equal(response.json.config.loopProtectionEnabled, true);
    assert.ok(response.json.config.visionEnabled && response.json.config.memoryEnabled && response.json.config.onlineEnabled);
    const index = await request({controlURL: url.href}, {path: '/', token: null, origin: null});
    assert.ok(index.body.toString('utf8').includes('dafeiyu-active') || !index.body.toString('utf8').includes('deepseek-flash'));
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); removeDirectory(directory); }
});

test('qqCheckVerifiesTheLoginWithoutReadingChats', async () => {
  const {spawn} = await import('node:child_process');
  const fixture = await new OneBotFixture({shape: 'private'}).start();
  const directory = tempDirectory();
  try {
    const run = (account, token) => new Promise(resolve => {
      const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../engine/main.mjs'), '--qq-check', fixture.endpoint, account],
        {cwd: directory, env: {...process.env, DAFEIYU_DATA_DIR: directory}, stdio: ['pipe', 'pipe', 'pipe']});
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('exit', code => resolve({code, output}));
      child.stdin.end(token + '\n');
    });
    const ok = await run('12345', 'synthetic-test-token');
    assert.equal(ok.code, 0, ok.output);
    assert.ok(ok.output.includes('QQ 账号与在线状态核对成功；未读取聊天或发送消息'));
    const wrong = await run('54321', 'synthetic-test-token');
    assert.equal(wrong.code, 1);
    assert.ok(wrong.output.includes('启动失败：QQ 账号或在线状态未通过核对'), wrong.output);
    assert.deepEqual([...new Set(fixture.actions)].sort(), ['get_login_info', 'get_status']);
  } finally { await fixture.stop(); removeDirectory(directory); }
});

/// Ten events make one agent batch whose turn waits on a held history request; pausing stops it and a restart
/// ignores the late answer (test-control-panel.py's queue scenario, zero model or send calls).
test('pauseStopsAHeldTurnAndRestartIgnoresTheLateHistory', async () => {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape: 'private'}).start();
  const held = [];
  const original = fixture.request.bind(fixture);
  fixture.request = request => { if (request.action === 'get_friend_msg_history') { fixture.actions.push(request.action); held.push(request); return; } original(request); };
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
  try {
    engine.save({endpoint: fixture.endpoint, expectedSelfID: '12345'});
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-test-key'));
    await engine.connect(); assert.ok(engine.connected, engine.error);
    engine.add(engine.contacts.find(contact => contact.id === 'private:54321'));
    engine.saveReplySettings({ai: engine.config.ai, persona: engine.config.effectivePersona, memoryEnabled: false, visionEnabled: false, onlineEnabled: false,
      enabledTargets: new Set(['private:54321'])});
    engine.start({duration: 60}); assert.ok(engine.running, engine.error);
    fixture.inject(Array.from({length: 10}, (_, index) => ({post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 12345, user_id: 54321,
      sender: {user_id: 54321}, message_id: index + 1, message: [{type: 'text', data: {text: 'synthetic queue check'}}]})));
    await wait(() => held.length === 1, 5);
    assert.ok(engine.running && engine.queuedCount === 0 && held.length === 1);
    assert.ok(engine.usage.calls === 0 && engine.sends.confirmed === 0);
    engine.pause();
    assert.ok(engine.connected && !engine.running && engine.queuedCount === 0 && engine.runDeadline === undefined);
    // Start a new epoch before releasing the previous worker's response.
    engine.start({duration: 60}); assert.ok(engine.running);
    for (const request of held) fixture.ok(request, {messages: []});
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      assert.ok(engine.connected && engine.running && engine.queuedCount === 0);
      assert.ok(engine.usage.calls === 0 && engine.sends.confirmed === 0 && engine.sends.uncertain === 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(held.length, 1);
  } finally { engine.disconnect(); await fixture.stop(); removeDirectory(directory); }
});

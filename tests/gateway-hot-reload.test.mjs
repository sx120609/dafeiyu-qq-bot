// The gateway reloaded in place (bridge/gateway.mjs Reloader): the open port keeps answering, the state objects are
// the same ones on the new code, and a file that does not load leaves the running generation alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {HotReload} from '../engine/HotReload.mjs';
import {composeGateway, Reloader, fixedFiles, scriptFiles, Settings} from '../bridge/gateway.mjs';
import {ConsoleAuth} from '../bridge/auth.mjs';
import {partOf} from '../bridge/self-repair.mjs';

const bridge = path.join(import.meta.dirname, '..', 'bridge');

test('the gateway reloads in place: same port, same state, new code', async () => {
  const hot = new HotReload({dirs: [bridge], fixed: fixedFiles, scripts: scriptFiles});
  // This test imported the gateway before the hook existed: count those modules as generation 0.
  for (const file of hot.files()) hot.loaded.get(0).add(pathToFileURL(file).href);
  await hot.snapshot(0);
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-hot-'));
  const config = {token: 'x'.repeat(40), consoleToken: 'console-secret', tempRoot: runtime};
  const configFile = path.join(runtime, 'bridge.json');
  const auth = await new ConsoleAuth({runtime, secret: config.consoleToken}).load();
  const reload = new Reloader({config, configFile, hot, host: null});
  reload.shared = {host: null, auth, reload};
  reload.current = await composeGateway(config, configFile, reload.shared);
  const front = http.createServer((req, res) => reload.current.server.emit('request', req, res));
  await new Promise(r => front.listen(0, '127.0.0.1', r));
  const health = async () => (await fetch(`http://127.0.0.1:${front.address().port}/healthz`)).status;
  try {
    assert.equal(await health(), 200);
    const {settings, usage, agentTools} = reload.current.state, before = reload.current.server;
    const result = await reload.gateway();
    assert.equal(result.generation, 1); assert.ok(result.moved >= 3, JSON.stringify(result));
    assert.notEqual(reload.current.server, before, 'a new generation of routes');
    assert.equal(reload.current.state.settings, settings, 'the same settings object');
    assert.equal(reload.current.state.usage, usage); assert.equal(reload.current.state.agentTools, agentTools);
    const fresh = await import(pathToFileURL(path.join(bridge, 'gateway.mjs')).href + '?hot=1');
    assert.ok(settings instanceof fresh.Settings && !(settings instanceof Settings), 'on the new code');
    assert.equal(await health(), 200, 'the port keeps answering');
    assert.equal(reload.status.gateway.generation, 1);
  } finally { front.closeAllConnections(); await new Promise(r => front.close(r)); await fs.rm(runtime, {recursive: true, force: true}); }
});

test('what a changed file needs', () => {
  assert.equal(partOf('bridge/providers.mjs'), 'gateway');
  assert.equal(partOf('bridge\\qq-host.mjs'), 'shell');
  assert.equal(partOf('engine/QQEngine.agent.mjs'), 'engine');
  assert.equal(partOf('engine/core/QQAgentPlan.mjs'), 'engine');
  assert.equal(partOf('engine/main.mjs'), 'engine-process');
  assert.equal(partOf('console/app.js'), null); assert.equal(partOf('tests/x.test.mjs'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentTools} from '../bridge/agent-tools.mjs';
import {QQCustomTools} from '../engine/QQCustomTools.mjs';
import {mediaMethods} from '../engine/QQAgentMedia.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import '../engine/QQAgent.mjs';
import {ModelScript, call, results, png, tempDirectory, removeDirectory} from './engine-fixtures.mjs';

test('a large screenshot survives sandbox, gateway, director and send_image without losing bytes', async () => {
  const runtime = tempDirectory();
  const previous = {url: process.env.DAFEIYU_CODEX_URL, session: QQCustomTools.session};
  process.env.DAFEIYU_CODEX_URL = 'http://127.0.0.1:9/v1';
  try {
    const image = Buffer.concat([png(), Buffer.alloc(256_000, 123)]);
    const source = 'base64://' + image.toString('base64');
    const tools = new AgentTools({runtime});
    const made = await tools.create({name: 'my_chat_screenshot', description: 'Screenshot fixture',
      parameters: {type: 'object', properties: {}},
      code: 'return {ok:true,image:args.image,tail:"complete"};', test_arguments: {image: source}});
    assert.equal(made.saved, true, made.test.error);
    assert.doesNotThrow(() => JSON.parse(made.test.output));
    assert.ok(made.test.output.length < 2000, `screenshot output has ${made.test.output.length} characters`);
    const saved = JSON.parse(made.test.output);
    assert.equal(saved.tail, 'complete');
    assert.match(saved.image, /^file:\/\//);
    assert.ok(fileURLToPath(saved.image).startsWith(path.join(runtime, 'agent-tool-files') + path.sep));
    assert.deepEqual(await fs.readFile(new URL(saved.image)), image);

    QQCustomTools.session = async (url, init) => {
      assert.ok(url.endsWith('/agent-tools/run'));
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(await tools.run(body.name, body.arguments)));
    };
    let delivered;
    const media = {...mediaMethods, agentDeliver: async (_context, payload) => { delivered = payload; }};
    const model = new ModelScript((_purpose, messages) => {
      const seen = results(messages);
      if (!seen.length) return call('my_chat_screenshot', {image: source});
      if (seen.length === 1) {
        const output = JSON.parse(seen[0].slice(seen[0].indexOf('\n') + 1));
        assert.deepEqual(output, saved);
        return call('send_image', {url: output.image});
      }
      assert.match(seen[1], /图发出去了/);
      return call('end_turn', {});
    });
    await new DeepSeekClient({session: model.session}).operateAgent({key: 'synthetic-key', config: {model: 'test'},
      rule: {prompt: 'Test'}, input: 'Screenshot', images: [], tools: tools.definitions(), chat: 'test',
      reserve: async () => {}, finish: async () => undefined,
      handler: async (name, args) => name === 'my_chat_screenshot'
        ? QQCustomTools.run(name, args, 'synthetic-key')
        : media.agentMedia(name, args, {target: {}})});
    assert.deepEqual(Buffer.from(delivered.segments[0].data.file.slice(9), 'base64'), image);
    assert.equal((await fs.readdir(path.join(runtime, 'agent-tool-files'))).length, 1);
  } finally {
    QQCustomTools.session = previous.session;
    if (previous.url === undefined) delete process.env.DAFEIYU_CODEX_URL;
    else process.env.DAFEIYU_CODEX_URL = previous.url;
    removeDirectory(runtime);
  }
});

test('binary references work in nested results and bare strings while ordinary output stays unchanged', async () => {
  const runtime = tempDirectory();
  try {
    const tools = new AgentTools({runtime});
    const image = png();
    const source = 'base64://' + image.toString('base64');
    const bare = await tools.execute('return args.source;', {source});
    assert.equal(bare.ok, true, bare.error);
    assert.match(bare.output, /^file:\/\//);
    assert.deepEqual(await fs.readFile(new URL(bare.output)), image);
    const nested = await tools.execute('return {images:[args.source,{file:args.source}],ok:true,count:2,missing:null};', {source});
    assert.equal(nested.ok, true, nested.error);
    assert.deepEqual(JSON.parse(nested.output), {images: [bare.output, {file: bare.output}], ok: true, count: 2, missing: null});
    const quoted = await tools.execute('return JSON.stringify(args.source);', {source});
    assert.equal(JSON.parse(quoted.output), bare.output);
    for (const output of ['ordinary text', '{ "value": 42, "items": [null, true] }', 'x'.repeat(300_000)]) {
      const result = await tools.execute('return args.output;', {output});
      assert.equal(result.ok, true, result.error);
      assert.equal(result.output, output);
    }
  } finally { removeDirectory(runtime); }
});

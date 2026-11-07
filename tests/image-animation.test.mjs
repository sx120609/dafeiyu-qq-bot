import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {generateCloudImage} from '../bridge/providers.mjs';
import {png} from './engine-fixtures.mjs';

const python = (code, input) => execFileSync(process.env.DAFEIYU_PYTHON || 'python', ['-P', '-c', code], {input, windowsHide: true});
const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
const sheet = () => python(`
import io, sys
from PIL import Image
image = Image.new('RGB', (48, 32), 'black')
for i, color in enumerate(${JSON.stringify(colors)}):
    x, y = (i % 3) * 16, (i // 3) * 16
    image.paste(tuple(color), (x, y, x + 16, y + 16))
image.save(sys.stdout.buffer, format='PNG')
`);
const inspect = bytes => JSON.parse(python(`
import io, json, sys
from PIL import Image, ImageSequence
image = Image.open(io.BytesIO(sys.stdin.buffer.read()))
print(json.dumps({'format': image.format, 'size': image.size, 'loop': image.info.get('loop'),
    'frames': [{'color': frame.convert('RGB').getpixel((8, 8)), 'duration': frame.info.get('duration')}
               for frame in ImageSequence.Iterator(image)]}))
`, bytes));

test('GIF-disabled image APIs produce real looping animations through frame sheets', async t => {
  const picture = sheet(), reference = png();
  for (const edit of [false, true]) await t.test(edit ? 'reference edit' : 'text generation', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks), type = req.headers['content-type'];
      const form = type.startsWith('multipart/') ? await new Response(raw, {headers: {'Content-Type': type}}).formData() : null;
      const fields = form ? Object.fromEntries(form) : JSON.parse(raw);
      seen.push({url: req.url, fields, reference: form ? Buffer.from(await form.get('image[]').arrayBuffer()) : null});
      res.setHeader('Content-Type', 'application/json');
      if (fields.output_format === 'gif') {
        res.writeHead(400); return res.end(JSON.stringify({error: {message: 'GIF output is not enabled for this request.'}}));
      }
      res.end(JSON.stringify({data: Array.from({length: Number(fields.n)}, () => ({b64_json: picture.toString('base64')})), usage: {input_tokens: 9}}));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const profile = {protocol: 'openai', apiKey: 'test-key', imageModel: 'synthetic-image', baseUrl: `http://127.0.0.1:${server.address().port}/v1`};
    try {
      const result = await generateCloudImage('A whale waving in a loop', profile, undefined, {
        animated: true, frame_count: 5, frame_duration_ms: 123, n: 2, quality: 'high', transparent: true,
        ...(edit ? {images: [reference.toString('base64')]} : {})});
      assert.equal(seen.length, 2, 'the same disabled GIF request must not be retried');
      const fallback = seen[1];
      assert.equal(fallback.url, edit ? '/v1/images/edits' : '/v1/images/generations');
      assert.notEqual(fallback.fields.output_format, 'gif');
      assert.equal(fallback.fields.frame_count, undefined); assert.equal(fallback.fields.frame_duration_ms, undefined);
      assert.equal(fallback.fields.quality, 'high'); assert.equal(fallback.fields.background, undefined);
      assert.match(fallback.fields.prompt, /A whale waving in a loop/);
      assert.match(fallback.fields.prompt, /3 columns.*2 rows/);
      if (edit) assert.deepEqual(fallback.reference, reference);
      assert.equal(result.animated, true); assert.equal(result.edited, edit); assert.equal(result.data.length, 2);
      assert.deepEqual(result.usage, {input_tokens: 9});
      for (const row of result.data) assert.deepEqual(inspect(Buffer.from(row.b64_json, 'base64')), {
        format: 'GIF', size: [16, 16], loop: 0, frames: colors.map(color => ({color, duration: 120}))});
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
});

test('optional-field retries preserve native GIFs and can still recover when GIF access is denied afterward', async t => {
  const picture = sheet();
  for (const native of [true, false]) await t.test(native ? 'native output' : 'frame sheet output', async () => {
    const seen = [];
    const animation = Buffer.from('R0lGODlhEAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEUAAEALAAAAAAQABAAgQAA/wAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAOw==', 'base64');
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const fields = JSON.parse(Buffer.concat(chunks)); seen.push(fields);
      res.setHeader('Content-Type', 'application/json');
      const message = fields.complexity ? 'Unknown parameter: complexity'
        : !native && fields.output_format === 'gif' ? 'GIF output is not enabled for this request.' : '';
      if (message) { res.writeHead(400); return res.end(JSON.stringify({error: {message}})); }
      res.end(JSON.stringify({data: [{b64_json: (native ? animation : picture).toString('base64')}]}));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const profile = {apiKey: 'test-key', imageModel: 'synthetic-image', baseUrl: `http://127.0.0.1:${server.address().port}/v1`};
    try {
      const result = await generateCloudImage('Wave', profile, undefined, {animated: true, frame_count: 5, complexity: 'high'});
      assert.equal(seen.length, native ? 2 : 4);
      assert.equal(seen[1].output_format, 'gif'); assert.equal(seen[1].frame_count, 5);
      if (native) assert.deepEqual(Buffer.from(result.data[0].b64_json, 'base64'), animation);
      else {
        assert.equal(seen[3].output_format, undefined); assert.equal(seen[3].complexity, undefined);
        assert.equal(seen[3].prompt, seen[2].prompt);
        assert.equal(inspect(Buffer.from(result.data[0].b64_json, 'base64')).frames.length, 5);
      }
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
});

test('unrelated API errors never turn into a frame-sheet generation', async t => {
  for (const status of [400, 401, 429, 500]) await t.test(String(status), async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: {message: 'Invalid image request'}}));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(generateCloudImage('Wave', {apiKey: 'test-key', imageModel: 'synthetic-image',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`}, undefined, {animated: true}), new RegExp(String(status)));
      assert.equal(seen.length, status === 400 ? 2 : 1);
      assert.ok(seen.every(fields => fields.output_format === 'gif' && fields.prompt === 'Wave'));
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
});

test('cancelling after a GIF-disabled response does not start another image request', async t => {
  const controller = new AbortController(), seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    init.signal.throwIfAborted();
    seen.push(JSON.parse(init.body));
    controller.abort(new Error('cancelled drawing'));
    return new Response(JSON.stringify({error: {message: 'GIF output is not enabled for this request.'}}), {status: 400});
  });
  await assert.rejects(generateCloudImage('Wave', {apiKey: 'test-key', imageModel: 'synthetic-image',
    baseUrl: 'http://127.0.0.1:9/v1'}, controller.signal, {animated: true}), /cancelled drawing/);
  assert.equal(seen.length, 1);
});

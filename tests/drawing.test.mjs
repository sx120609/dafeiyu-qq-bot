// Drawing from reference images, with a size, detail, a transparent background and several pictures (11-03: "画图接口
// 不够完善，缺少很多特性，比如不能根据用户发的图片进行修改").
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {generateCloudImage, imageOptions} from '../bridge/providers.mjs';
import {QQImageCredentials, QQImageGenerator} from '../engine/QQImageGenerator.mjs';
import {QQImageGenerationConfig} from '../engine/core/QQImageGenerationConfig.mjs';
import {QQAgentPlan} from '../engine/core/QQAgentPlan.mjs';
import {png} from './engine-fixtures.mjs';

test('the gateway edits with reference images, asks for size, quality and count, and retries without fields an API does not know', async () => {
  const picture = png(), seen = [];
  let strict = true;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('latin1');
    seen.push({url: req.url, type: req.headers['content-type'] ?? '', raw});
    res.setHeader('Content-Type', 'application/json');
    // An API that does not know input_fidelity refuses it once.
    if (strict && raw.includes('name="input_fidelity"')) { strict = false; res.writeHead(400); return res.end(JSON.stringify({error: {message: 'Unknown parameter: input_fidelity'}})); }
    res.end(JSON.stringify({data: [{b64_json: picture.toString('base64')}, {b64_json: picture.toString('base64')}], usage: {input_tokens: 9}}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = {protocol: 'openai', apiKey: 'test-key', imageModel: 'synthetic-image', baseUrl: `http://127.0.0.1:${server.address().port}/v1`};
  try {
    const result = await generateCloudImage('把衣服换成红色', profile, undefined, {images: [picture.toString('base64')], size: 'portrait', quality: 'high', n: 2});
    assert.equal(seen[0].url, '/v1/images/edits'); assert.match(seen[0].type, /multipart\/form-data/);
    for (const field of ['image[]', 'input_fidelity', 'moderation', 'quality']) assert.ok(seen[0].raw.includes(`name="${field}"`), field);
    assert.ok(seen[0].raw.includes('1024x1536'), 'portrait');
    // The second try keeps the picture, the prompt, the size and the count, and drops the optional fields.
    assert.equal(seen.length, 2); assert.ok(seen[1].raw.includes('name="image[]"') && seen[1].raw.includes('1024x1536'));
    assert.ok(!seen[1].raw.includes('name="input_fidelity"'));
    assert.equal(result.data.length, 2); assert.equal(result.edited, true);
    // Without references it is still a plain generation, now with a transparent background.
    await generateCloudImage('一只猫', profile, undefined, {background: 'transparent', size: 'landscape'});
    const plain = JSON.parse(seen.at(-1).raw);
    assert.equal(seen.at(-1).url, '/v1/images/generations'); assert.equal(plain.background, 'transparent'); assert.equal(plain.size, '1536x1024');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  assert.throws(() => imageOptions({images: [Buffer.from('not a picture').toString('base64')]}), e => e.status === 400);
  assert.deepEqual(imageOptions({n: 9, size: 'huge'}), {images: [], size: '1024x1024', quality: undefined, background: undefined, n: 4,
    animated: false, frames: undefined, frameMs: undefined, complexity: undefined});
});

test('the generator sends reference images and options to the gateway and gets several pictures back; text-only providers step aside', async t => {
  const previous = process.env.DAFEIYU_CODEX_URL;
  t.after(() => { if (previous === undefined) delete process.env.DAFEIYU_CODEX_URL; else process.env.DAFEIYU_CODEX_URL = previous; });
  process.env.DAFEIYU_CODEX_URL = 'http://127.0.0.1:9/v1';
  const picture = png();
  let body;
  const session = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({data: [{b64_json: picture.toString('base64')}, {b64_json: picture.toString('base64')}]})); };
  const settings = new QQImageGenerationConfig();
  settings.enabled = true; settings.primary = 'codex'; settings.fallbackEnabled = true;
  const result = await new QQImageGenerator({session}).execute({arguments: '{"prompt":"把衣服换成红色"}', settings,
    credentials: new QQImageCredentials({codexToken: 'synthetic-image-token', zhipuKey: 'synthetic-zhipu'}), beforeAttempt: async () => {},
    references: [picture], options: {size: 'portrait', quality: 'high', transparent: true, count: 2}});
  assert.equal(result.images.length, 2, result.content); assert.deepEqual(result.image, picture);
  assert.deepEqual(body.images, [picture.toString('base64')]);
  assert.equal(body.size, 'portrait'); assert.equal(body.quality, 'high'); assert.equal(body.background, 'transparent'); assert.equal(body.n, 2);
  // Zhipu draws from text only: with a reference image it is not tried.
  settings.primary = 'zhipu'; settings.fallbackEnabled = false;
  const refused = await new QQImageGenerator({session: async () => { throw new Error('Zhipu must not be called'); }}).execute({arguments: '{"prompt":"x"}', settings,
    credentials: new QQImageCredentials({zhipuKey: 'synthetic-zhipu'}), beforeAttempt: async () => {}, references: [picture]});
  assert.equal(refused.image, undefined); assert.match(refused.imageStatus, /不能照着参考图画/);
});

test('a drawing keeps the options that make sense', () => {
  assert.deepEqual(QQAgentPlan.drawing({images: ['123', ' last ', '', 456, 'a', 'b'], size: 'portrait', quality: 'ultra', transparent: 'yes', count: 9}),
    {images: ['123', 'last', '456', 'a'], size: 'portrait', count: 4});
  assert.deepEqual(QQAgentPlan.drawing({images: 'avatar:MEMBER_a', transparent: true, count: 1}), {images: ['avatar:MEMBER_a'], transparent: true});
});

// GPT Image 2.6 draws animated GIFs (11-07, "加入新模型特性如原生动图"): two red/blue 16x16 frames.
const gif = Buffer.from('R0lGODlhEAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEUAAEALAAAAAAQABAAgQAA/wAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAOw==', 'base64');

test('an animated drawing asks for a GIF with its frames, lets the API size the frames, and must get a GIF back', async () => {
  let body, reply = gif;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({data: [{b64_json: reply.toString('base64')}]}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = {protocol: 'openai', apiKey: 'k', imageModel: 'gpt-image-2.6-sunburst', baseUrl: `http://127.0.0.1:${server.address().port}/v1`};
  try {
    const result = await generateCloudImage('鲸鱼娘挥手', profile, undefined, {animated: true, frame_count: 30, frame_duration_ms: 123, size: 'portrait', transparent: true, complexity: 'medium'});
    assert.equal(body.output_format, 'gif'); assert.equal(body.frame_count, 16, 'at most 16 frames'); assert.equal(body.frame_duration_ms, 120, 'rounded to 10 ms');
    assert.equal(body.size, 'auto', 'GIF frames share one budget'); assert.equal(body.background, undefined, 'no transparency for GIF');
    assert.equal(body.complexity, 'medium'); assert.equal(result.animated, true);
    assert.deepEqual(Buffer.from(result.data[0].b64_json, 'base64'), gif);
    // A model that sends back a still for an animated request is an error, not a silent still.
    reply = png();
    await assert.rejects(generateCloudImage('x', profile, undefined, {animated: true}), /没画出动图/);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  assert.deepEqual(QQAgentPlan.drawing({animated: true, frames: 40, frame_ms: 5}), {animated: true, frames: 16, frameMs: 20});
});

test('the generator asks the gateway for a GIF and accepts the animated result; text-only providers cannot animate', async t => {
  const previous = process.env.DAFEIYU_CODEX_URL;
  t.after(() => { if (previous === undefined) delete process.env.DAFEIYU_CODEX_URL; else process.env.DAFEIYU_CODEX_URL = previous; });
  process.env.DAFEIYU_CODEX_URL = 'http://127.0.0.1:9/v1';
  let body;
  const session = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({data: [{b64_json: gif.toString('base64')}]})); };
  const settings = new QQImageGenerationConfig();
  settings.enabled = true; settings.primary = 'codex'; settings.fallbackEnabled = false;
  const result = await new QQImageGenerator({session}).execute({arguments: '{"prompt":"挥手"}', settings, credentials: new QQImageCredentials({codexToken: 't'}),
    beforeAttempt: async () => {}, options: {animated: true, frames: 6, frameMs: 150}});
  assert.equal(body.output_format, 'gif'); assert.equal(body.frame_count, 6); assert.equal(body.frame_duration_ms, 150);
  assert.deepEqual(result.image, gif, result.content);
  settings.primary = 'zhipu';
  const refused = await new QQImageGenerator({session: async () => { throw new Error('not called'); }}).execute({arguments: '{"prompt":"x"}', settings,
    credentials: new QQImageCredentials({zhipuKey: 'z'}), beforeAttempt: async () => {}, options: {animated: true}});
  assert.match(refused.imageStatus, /不会画动图/);
});

// Port of upstream/Tests/QQEngineTests/QQVisualToolsTests.swift. The URLProtocol fixture is an injected fetch.
// visualSecretsNeverEnterConfigOrStoredState saves through QQEngine; only its configuration-default checks are here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CancellationError} from '../engine/BoundedDownload.mjs';
import {QQIncomingImages} from '../engine/QQIncomingImages.mjs';
import {QQVisualTools} from '../engine/QQVisualTools.mjs';
import {QQConfig} from '../engine/core/QQPolicy.mjs';

delete process.env.DAFEIYU_CODEX_URL;
const animatedFixture = () => {
  const file = path.resolve(import.meta.dirname, '..', 'upstream', 'Tests', 'QQEngineTests', 'synthetic-images.json');
  return Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).animated, 'base64');
};

function fixture(mode) {
  const captured = [];
  const session = (raw, init = {}) => {
    const url = new URL(raw), body = typeof init.body === 'string' ? init.body : '';
    captured.push({url, headers: new Headers(init.headers), body});
    if (mode === 'hold' && url.host === 'open.bigmodel.cn') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
    }
    if (url.host === 'gchat.qpic.cn') return Promise.resolve(new Response(mode === 'unread' ? Buffer.from('not an image') : animatedFixture(), {status: 200}));
    const content = '{"description":"蓝色圆点","visibleText":"","motion":"向右移动","emotionCandidates":"无明确情绪","uncertainty":"无"}';
    let object = url.host === 'vision.googleapis.com' ? {responses: [{webDetection: {bestGuessLabels: [{label: 'blue circle'}]}}]}
      : {choices: [{finish_reason: mode === 'length' ? 'length' : 'stop', message: {content: mode === 'badJSON' ? 'not json' : content}}]};
    if (url.host === 'api.deepseek.com') {
      const answer = {text: '蓝色圆点向右移动了。', emotion: 'neutral', intensity: 0};
      if (body.includes('[QQ_PARTICIPATION]')) answer.participate = true;
      object = {choices: [{finish_reason: 'stop', message: {content: JSON.stringify(answer)}}]};
    }
    const capacity = mode === 'capacity' && body.includes('glm-4.6v-flash');
    if (capacity) object = {error: {code: '1305'}};
    if (mode === 'error200') object = {responses: [{error: {code: 7}}], error: {code: 7}};
    return Promise.resolve(new Response(JSON.stringify(object), {status: capacity ? 429 : mode === 'denied' ? 403 : 200}));
  };
  return {session, captured};
}

test('googleRanksEvidenceAndDoesNotConfuseErrorsWithNoMatches', () => {
  const result = QQVisualTools.searchResult({responses: [{webDetection: {pagesWithMatchingImages: [
    {url: 'https://example.com/partial', pageTitle: 'partial', partialMatchingImages: [{url: 'https://example.com/a'}]},
    {url: 'http://127.0.0.1/private', fullMatchingImages: [{url: 'x'}]},
    {url: 'https://example.org/full', pageTitle: '<b>full</b>', fullMatchingImages: [{url: 'https://example.org/b'}]}
  ], webEntities: [{description: 'candidate', score: 1.5}]}}]});
  assert.deepEqual(result.sources, ['https://example.org/full', 'https://example.com/partial']);
  assert.equal(result.image, undefined); assert.ok(!result.content.includes('127.0.0.1')); assert.ok(!result.content.includes('<b>'));
  const empty = QQVisualTools.searchResult({responses: [{}]}); assert.equal(empty.sources.length, 0); assert.ok(empty.content.includes('未返回匹配'));
  for (const object of [{}, {responses: []}, {responses: [{error: {code: 7}}]}]) assert.throws(() => QQVisualTools.searchResult(object));
  assert.ok(QQVisualTools.wantsWebSearch('用谷歌搜图，查这个角色出处'));
  assert.ok(!QQVisualTools.wantsWebSearch('哈哈，晚安啦'));
});

for (const mode of ['ok', 'capacity', 'length', 'badJSON', 'error200', 'denied']) {
  test(`officialRequestsAreBoundedAndAuthenticated(${mode})`, async () => {
    const {session, captured} = fixture(mode);
    const frames = QQIncomingImages.frames(animatedFixture());
    try {
      const text = await new QQVisualTools({session}).describe({images: frames, context: '合成动图', key: 'synthetic-zhipu'});
      assert.ok(['ok', 'capacity'].includes(mode)); assert.ok(text.includes('向右移动'));
      assert.equal(captured.length, mode === 'capacity' ? 2 : 1);
    } catch (error) {
      assert.ok(!['ok', 'capacity'].includes(mode), String(error));
    }
    const request = captured[0];
    assert.ok(request);
    assert.equal(request.url.host, 'open.bigmodel.cn');
    assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-zhipu');
    assert.ok(!request.body.includes('synthetic-zhipu'));
    assert.equal(JSON.parse(request.body).model, 'glm-4.6v-flash');
    if (mode === 'ok') {
      await new QQVisualTools({session}).search({image: frames[0], key: 'synthetic-google'});
      const google = captured.at(-1);
      assert.equal(google.url.href, 'https://vision.googleapis.com/v1/images:annotate');
      assert.equal(google.headers.get('X-Goog-Api-Key'), 'synthetic-google');
      assert.equal(google.headers.get('Authorization'), null);
    }
  });
}

test('cancellationAndMissingKeysDoNotProduceObservations', async () => {
  const {session, captured} = fixture('hold');
  const tool = new QQVisualTools({session}), frame = QQIncomingImages.frames(animatedFixture())[0];
  const missing = await tool.search({image: frame, key: ''}); assert.equal(missing.sources.length, 0); assert.equal(captured.length, 0);
  const controller = new AbortController();
  const task = tool.describe({images: [frame], context: 'synthetic', key: 'fixture', signal: controller.signal});
  for (let i = 0; i < 100 && captured.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(task);
});

test('fallbackReservesQuotaBeforeSecondRequest', async () => {
  const {session, captured} = fixture('capacity');
  const frame = QQIncomingImages.frames(animatedFixture())[0];
  let calls = 0;
  const reserve = async () => { calls += 1; if (calls > 1) throw new CancellationError(); };
  await assert.rejects(new QQVisualTools({session}).describe({images: [frame], context: 'synthetic', key: 'fixture', beforeAttempt: reserve}), CancellationError);
  assert.equal(captured.length, 1);
});

test('visualSecretsNeverEnterConfigOrStoredState', () => {
  assert.equal(new QQConfig().effectiveVisualTools.provider, 'deepseek');
  assert.ok(!new QQConfig().effectiveVisualTools.googleWebEnabled);
});

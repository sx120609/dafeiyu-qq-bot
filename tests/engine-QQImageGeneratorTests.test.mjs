// Port of upstream/Tests/QQEngineTests/QQImageGeneratorTests.swift. The URLProtocol fixture is an injected fetch.
// imageCredentialsStayOutOfPersistedState drives QQEngine and lives with its tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CancellationError, URLError} from '../engine/BoundedDownload.mjs';
import {QQImageCredentials, QQImageGenerator} from '../engine/QQImageGenerator.mjs';
import {QQImagePromptPlan} from '../engine/QQImagePromptPlan.mjs';
import {QQImageGenerationConfig} from '../engine/core/QQImageGenerationConfig.mjs';
import {QQConfig} from '../engine/core/QQPolicy.mjs';

delete process.env.DAFEIYU_CODEX_URL;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

function fixture(mode) {
  const requests = [];
  const session = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    requests.push({url: new URL(url), headers, body: init.body});
    const host = new URL(url).host;
    let status = 200, object = {}, data;
    if (host === 'open.bigmodel.cn') {
      if (mode === 'timeout') throw new URLError(URLError.timedOut);
      if (['fallback', 'bothFail', 'quota'].includes(mode)) { status = 429; object = {error: {code: '1302', message: 'rate limit'}}; }
      else if (['refusal', 'refusal200'].includes(mode)) { status = mode === 'refusal' ? 400 : 200; object = {error: {code: '1301', message: 'blocked'}}; }
      else if (mode === 'unknown403') { status = 403; object = {error: {code: 'unknown', message: 'forbidden'}}; }
      else if (mode === 'filtered') object = {content_filter: [{role: 'assistant', level: 0}], data: [{url: 'https://sfile.chatglm.cn/fixture.png'}]};
      else if (mode === 'malformed') object = {};
      else if (mode === 'falseSuccess') object = {success: false};
      else object = {data: [{url: mode === 'badURL' ? 'http://127.0.0.1/secret' : 'https://maas-watermark-prod-new.cn-wlcb.ufileos.com/fixture.png'}]};
    } else if (host === 'api.cloudflare.com') {
      if (['bothFail', 'reverse'].includes(mode)) { status = 503; object = {success: false, errors: [{code: 3040, message: 'busy'}]}; }
      else object = {success: true, result: {image: png.toString('base64')}};
    } else if (host === 'maas-watermark-prod-new.cn-wlcb.ufileos.com') data = mode === 'invalidImage' ? Buffer.from('not an image') : png;
    else throw new URLError(URLError.badURL);
    return new Response(data ?? JSON.stringify(object), {status});
  };
  return {session, requests};
}
const settings = () => {
  const value = new QQImageGenerationConfig(); value.enabled = true; value.cloudflareAccountID = 'a'.repeat(32); return value;
};
const credentials = new QQImageCredentials({zhipuKey: 'synthetic-zhipu', cloudflareToken: 'synthetic-cloudflare'});

test('imagePlansRequireBoundedTypedDecisions', () => {
  assert.equal(QQImagePromptPlan.decode('{"action":"generate","prompt":"成年动漫角色","note":""}').action, 'generate');
  assert.equal(QQImagePromptPlan.decode('{"action":"none","prompt":"","note":""}').action, 'none');
  for (const invalid of ['{}', '{"action":"generate","prompt":" ","note":""}', '{"action":"decline","prompt":"still generate","note":""}', '{"action":"retry","prompt":"","note":""}']) {
    assert.throws(() => QQImagePromptPlan.decode(invalid), undefined, invalid);
  }
});

for (const mode of ['success', 'fallback', 'timeout', 'malformed', 'falseSuccess', 'invalidImage', 'badURL', 'bothFail', 'reverse', 'refusal', 'refusal200', 'filtered', 'unknown403']) {
  test(`providerFallbackUsesOfficialSchemasAndPreservesRefusals(${mode})`, async () => {
    const {session, requests} = fixture(mode);
    const config = settings(); if (mode === 'reverse') config.primary = 'cloudflare';
    let attempts = 0;
    const result = await new QQImageGenerator({session}).execute({arguments: '{"prompt":"cute whale"}', settings: config, credentials, beforeAttempt: async () => { attempts += 1; }});
    const terminal = ['refusal', 'refusal200', 'filtered', 'unknown403'].includes(mode);
    assert.equal(result.image !== undefined, !terminal && mode !== 'bothFail', result.content);
    assert.equal(attempts, mode === 'success' || terminal ? 1 : 2);
    assert.ok(requests.every(r => ['open.bigmodel.cn', 'api.cloudflare.com', 'maas-watermark-prod-new.cn-wlcb.ufileos.com'].includes(r.url.host)));
    for (const r of requests.filter(r => r.url.host === 'maas-watermark-prod-new.cn-wlcb.ufileos.com')) assert.equal(r.headers.get('Authorization'), null);
    for (const r of requests.filter(r => r.url.host === 'open.bigmodel.cn')) {
      const body = JSON.parse(r.body);
      assert.equal(body.model, 'cogview-3-flash');
      assert.equal(body.watermark_enabled, true);
      assert.equal(r.headers.get('Authorization'), 'Bearer synthetic-zhipu');
    }
    assert.ok(!result.content.includes('synthetic-zhipu')); assert.ok(!result.content.includes('synthetic-cloudflare'));
    if (result.image !== undefined) { assert.deepEqual(result.image, png); assert.deepEqual(result.sources, [], 'no caption line on a drawn picture'); }
  });
}

test('disabledInvalidMissingKeysAndFallbackOffDoNotSpendUnexpectedly', async () => {
  const {session, requests} = fixture('fallback');
  let attempts = 0;
  const config = settings();
  const beforeAttempt = async () => { attempts += 1; };
  config.enabled = false;
  await new QQImageGenerator({session}).execute({arguments: '{}', settings: config, credentials, beforeAttempt});
  config.enabled = true;
  for (const input of ['{}', '{"prompt":"sk-syntheticsecretkey"}', '{"prompt":"x","url":"x"}']) {
    await new QQImageGenerator({session}).execute({arguments: input, settings: config, credentials, beforeAttempt});
  }
  assert.equal(requests.length, 0); assert.equal(attempts, 0);
  config.fallbackEnabled = false;
  const failed = await new QQImageGenerator({session}).execute({arguments: '{"prompt":"cat"}', settings: config, credentials, beforeAttempt});
  assert.equal(failed.image, undefined); assert.equal(attempts, 1);
  config.fallbackEnabled = true;
  const result = await new QQImageGenerator({session}).execute({arguments: '{"prompt":"cat"}', settings: config,
    credentials: new QQImageCredentials({cloudflareToken: 'synthetic-cloudflare'}), beforeAttempt});
  assert.ok(result.image !== undefined); assert.equal(attempts, 2);
});

test('quotaOrScopeFailureDoesNotBecomeProviderFailover', async () => {
  const {session, requests} = fixture('fallback');
  let attempts = 0;
  await assert.rejects(new QQImageGenerator({session}).execute({arguments: '{"prompt":"cat"}', settings: settings(), credentials,
    beforeAttempt: async () => { attempts += 1; if (attempts === 2) throw new CancellationError(); }}), CancellationError);
  assert.equal(requests.length, 1);
});

test('legacyConfigurationDefaultsToDisabledAndRejectsInvalidAccount', () => {
  const config = new QQConfig(); config.expectedSelfID = '12345';
  const restored = QQConfig.decode(JSON.parse(JSON.stringify(config)));
  assert.ok(!restored.effectiveImageGeneration.enabled);
  assert.equal(restored.effectiveImageGeneration.primary, 'zhipu');
  const images = settings(); images.cloudflareAccountID = '../../other-account';
  assert.throws(() => images.validate());
});

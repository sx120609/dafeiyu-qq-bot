import test from 'node:test';
import assert from 'node:assert/strict';
import {count} from '../engine/swift.mjs';
import {QQMemorySummary} from '../engine/core/QQMemorySummary.mjs';
import {QQPersona} from '../engine/core/QQPersona.mjs';

test('boundedRedactedAndExpired', () => {
  const raw = JSON.stringify({summary: '喜欢蓝色，API key: sk-syntheticsecret 密码：synthetic123 https://example.org/?token=synthetic ' + '鱼'.repeat(3000)});
  const summary = QQMemorySummary.decode(raw, new Date(Date.now() - 91 * 86400_000));
  assert.equal(count(summary.text), 2000);
  assert.ok(!summary.text.includes('synthetic')); assert.ok(summary.expired);
  assert.throws(() => QQMemorySummary.decode('{"summary":"x","instruction":"x"}'));
});

test('fencedReplyAndFallbackClassification', () => {
  const p = new QQPersona();
  assert.ok(!p.decode('```json\n{"text":"你好呀","emotion":"joy","intensity":1}\n```', '你好').isFallback);
  assert.ok(p.decode('plain invalid', '你好').isFallback);
});

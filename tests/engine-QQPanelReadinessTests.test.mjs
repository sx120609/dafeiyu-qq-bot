// Port of upstream/Tests/QQEngineTests/QQPanelReadinessTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import {tempDirectory, removeDirectory} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {QQTarget} from '../engine/core/QQPolicy.mjs';
import {QQVisualConfig} from '../engine/core/QQVisualConfig.mjs';
import {QQImageGenerationConfig} from '../engine/core/QQImageGenerationConfig.mjs';

test('disabledFeaturesDoNotProduceCredentialWarnings', () => {
  const engine = new QQEngine({preview: true, allowAuthenticationUI: false});
  assert.deepEqual(engine.configurationHints, []);
  engine.config.effectiveVisualTools.googleWebEnabled = true;
  const hints = engine.configurationHints.join('\n');
  assert.ok(hints.includes('启用识图') && hints.includes('联网开关未启用'));
  assert.ok(hints.includes('Google 搜图凭证当前未载入'));
  assert.ok(!hints.includes('Cloudflare'));
});

test('loadedCredentialsAndSavedSwitchesResolveToolDependencies', () => {
  const directory = tempDirectory();
  try {
    const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    engine.save({expectedSelfID: '12345'});
    assert.equal(engine.error, undefined, engine.error);
    const visual = new QQVisualConfig(); visual.provider = 'zhipu'; visual.googleWebEnabled = true;
    engine.saveVisualTools(visual, 'synthetic-google', false);
    assert.equal(engine.error, undefined, engine.error);
    engine.config.effectiveVisionEnabled = true; engine.config.effectiveOnlineEnabled = true;
    const image = new QQImageGenerationConfig(); image.enabled = true; image.fallbackEnabled = false;
    engine.saveImageGeneration(image, 'synthetic-zhipu', '', false);
    assert.equal(engine.error, undefined, engine.error);
    assert.deepEqual(engine.configurationHints, []);
    image.fallbackEnabled = true;
    engine.saveImageGeneration(image.clone(), '', '', false);
    assert.equal(engine.error, undefined, engine.error);
    assert.ok(engine.configurationHints.some(hint => hint.includes('Account ID')));
    assert.ok(engine.configurationHints.some(hint => hint.includes('Cloudflare 生图凭证当前未载入')));
    image.cloudflareAccountID = 'a'.repeat(32);
    engine.saveImageGeneration(image.clone(), '', 'synthetic-cloudflare', false);
    assert.equal(engine.error, undefined, engine.error);
    assert.deepEqual(engine.configurationHints, []);
    assert.ok(!engine.running && engine.sends.attempts === 0);
  } finally { removeDirectory(directory); }
});

test('scheduleRequiresEnabledTargets', () => {
  const engine = new QQEngine({preview: true, allowAuthenticationUI: false});
  engine.config.effectiveArtwork.scheduleEnabled = true;
  assert.ok(engine.configurationHints.some(hint => hint.includes('插画功能未启用')));
  assert.ok(engine.configurationHints.some(hint => hint.includes('没有已启用的目标')));
  const group = new QQTarget({number: '99999', name: '合成群', group: true}); group.enabled = true;
  const friend = new QQTarget({number: '54321', name: '合成好友', group: false});
  engine.config.targets = [group, friend];
  engine.config.effectiveArtwork.enabled = true;
  engine.config.effectiveArtwork.scheduleTargets = [group.key, friend.key];
  assert.equal(engine.configurationHints.length, 1);
  assert.ok(engine.configurationHints[0].includes('部分定时目标'));
  engine.config.targets[1].enabled = true;
  assert.deepEqual(engine.configurationHints, []);
});

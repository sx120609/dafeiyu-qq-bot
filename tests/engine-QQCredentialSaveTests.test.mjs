// Port of upstream/Tests/QQEngineTests/QQCredentialSaveTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempDirectory, removeDirectory, same} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {AppFailure} from '../engine/swift.mjs';
import {QQVisualConfig} from '../engine/core/QQVisualConfig.mjs';
import {QQImageGenerationConfig} from '../engine/core/QQImageGenerationConfig.mjs';

test('partialImageCredentialSaveReportsCommittedConfigAndCanRetry', () => {
  const directory = tempDirectory();
  try {
    const saved = {};
    let failCloudflare = true;
    const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, credentialWriter: (value, account) => {
      if (account === 'qq-image-cloudflare' && failCloudflare) throw new AppFailure('合成钥匙串拒绝');
      saved[account] = value;
    }});
    engine.save({expectedSelfID: '12345'});
    const settings = engine.config.effectiveImageGeneration.clone(); settings.enabled = true;
    const committed = engine.saveImageGeneration(settings.clone(), 'synthetic-zhipu-value', 'synthetic-cloudflare-value', true);
    assert.ok(committed && engine.error !== undefined);
    assert.ok(engine.hasZhipuImageKey && !engine.hasCloudflareImageToken);
    assert.ok(saved['qq-image-zhipu'] === 'synthetic-zhipu-value' && saved['qq-image-cloudflare'] === undefined);
    assert.ok(engine.error.includes('已保存并载入：智谱'));
    assert.ok(!engine.error.includes('synthetic-zhipu-value'));
    const reopened = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    assert.ok(same(reopened.config.effectiveImageGeneration, settings));
    failCloudflare = false;
    assert.ok(engine.saveImageGeneration(settings.clone(), 'synthetic-zhipu-value', 'synthetic-cloudflare-value', true));
    assert.ok(engine.error === undefined && engine.hasZhipuImageKey && engine.hasCloudflareImageToken);
    const disk = fs.readFileSync(path.join(directory, 'qq-state.json'), 'utf8');
    assert.ok(!disk.includes('synthetic-zhipu-value') && !disk.includes('synthetic-cloudflare-value'));
    assert.ok(!engine.running && engine.sends.attempts === 0);
  } finally { removeDirectory(directory); }
});

for (const mode of ['connection', 'visual', 'image']) {
  test(`failedCredentialWriteKeepsCommittedSettingsAndInputsCanBeRetried(${mode})`, () => {
    const directory = tempDirectory();
    try {
      let reject = true, attempts = 0;
      const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, credentialWriter: () => {
        attempts += 1;
        if (reject) throw new AppFailure('合成钥匙串拒绝');
      }});
      engine.save({expectedSelfID: '12345'});
      const submit = () => {
        switch (mode) {
          case 'connection': return engine.save({token: 'synthetic-token', endpoint: 'ws://127.0.0.1:3101'});
          case 'visual': { const settings = new QQVisualConfig(); settings.provider = 'zhipu'; return engine.saveVisualTools(settings, 'synthetic-google', true); }
          default: { const settings = new QQImageGenerationConfig(); settings.enabled = true; return engine.saveImageGeneration(settings, 'synthetic-zhipu', '', true); }
        }
      };
      assert.ok(submit() && engine.error !== undefined && attempts === 1);
      assert.ok(engine.error.includes('已保存'));
      assert.ok(!engine.hasGoogleVisionKey && !engine.hasZhipuImageKey);
      const reopened = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
      assert.ok(same(reopened.config, engine.config));
      reject = false;
      assert.ok(submit() && engine.error === undefined && attempts === 2);
      assert.ok(!engine.running);
    } finally { removeDirectory(directory); }
  });
}

for (const mode of ['connection', 'visual', 'image']) {
  test(`configurationConflictNeverTouchesCredentialStore(${mode})`, () => {
    const directory = tempDirectory();
    try {
      let writes = 0;
      const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, credentialWriter: () => { writes += 1; }});
      engine.save({expectedSelfID: '12345'});
      const original = engine.config.clone();
      const other = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
      other.save({endpoint: 'ws://127.0.0.1:3102'});
      let committed;
      switch (mode) {
        case 'connection': committed = engine.save({token: 'synthetic-token', endpoint: 'ws://127.0.0.1:3101'}); break;
        case 'visual': committed = engine.saveVisualTools(new QQVisualConfig(), 'synthetic-google', true); break;
        default: committed = engine.saveImageGeneration(new QQImageGenerationConfig(), 'synthetic-zhipu', '', true);
      }
      assert.ok(!committed && engine.error !== undefined && writes === 0);
      assert.ok(same(engine.config, original));
    } finally { removeDirectory(directory); }
  });
}

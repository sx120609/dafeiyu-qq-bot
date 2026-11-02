// Port of upstream/Tests/QQEngineTests/QQPanelDraftTests.swift. Not here (they save through QQEngine and belong with
// its tests): replyLimitTextKeepsInvalidDraftAndPersistsAllCorrectedFieldsTogether and
// artworkTextDraftValidatesBeforePersistingAndSurvivesRefresh. editingDoesNotMutateRuntimeAndUnrelatedSettingsDoNotConflict
// used a preview QQEngine only for its default configuration; it runs on QQConfig() here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {QQArtworkForm, QQConnectionForm, QQPanelDraft, QQPanelState, QQReplyForm} from '../engine/QQPanelDraft.mjs';
import {QQConfig, QQTarget} from '../engine/core/QQPolicy.mjs';
import {QQPersona} from '../engine/core/QQPersona.mjs';
import {QQPersonality} from '../engine/core/QQPersonality.mjs';
import {QQMemoryOptions} from '../engine/core/QQMemoryBook.mjs';
import {QQArtworkConfig} from '../engine/core/QQArtwork.mjs';
import {QQImageGenerationConfig} from '../engine/core/QQImageGenerationConfig.mjs';
import {QQVisualConfig} from '../engine/core/QQVisualConfig.mjs';
import {SendLimits} from '../engine/core/RuntimePolicy.mjs';

const equal = (a, b, message) => assert.ok(typeof a?.equals === 'function' ? a.equals(b) : JSON.stringify(a) === JSON.stringify(b), message);
const regexEscape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('firstPaintWebDefaultsMatchNativeSettings', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'upstream', 'Resources', 'QQControl', 'index.html'), 'utf8');
  const config = new QQConfig(), persona = new QQPersona(), memory = new QQMemoryOptions(), art = new QQArtworkConfig(), limits = new SendLimits();
  const values = {maxCharacters: persona.maxCharacters, stickerEveryReplies: persona.effectiveStickerEveryReplies,
    stickerIntervalSeconds: persona.stickerIntervalSeconds,
    daily: config.ai.dailyLimit, cooldown: config.ai.cooldownSeconds, sendDaily: limits.daily,
    chatDaily: limits.perChatDaily, globalInterval: limits.globalIntervalSeconds,
    workStart: config.ai.workStart, workEnd: config.ai.workEnd,
    memoryMessages: memory.messageThreshold, memoryCharacters: memory.characterThreshold,
    memoryMinutes: memory.intervalMinutes, memoryBudget: memory.retrievalCharacters,
    artDaily: art.dailyPerChat, artNetwork: art.networkDailyLimit, artRepeat: art.repeatDays,
    artBookmarks: art.effectiveSearchMinBookmarks, artLong: art.minLongEdge, artShort: art.minShortEdge,
    artHour: art.scheduleHour, artMinute: art.scheduleMinute};
  for (const [id, value] of Object.entries(values)) {
    const pattern = new RegExp(`<input\\b[^>]*\\bid="${regexEscape(id)}"[^>]*\\bvalue="${regexEscape(value)}"`);
    assert.ok(pattern.test(html), `Missing or mismatched default: ${id}`);
  }
  assert.ok(html.includes(`<option value="teasing" selected>${QQPersonality.name(persona.effectiveStyle)}</option>`));
  assert.ok(html.includes(`<option value="${persona.banter}" selected>`));
  assert.ok(html.includes('id="stickersEnabled" type="checkbox" checked'));
  assert.ok(html.includes(`value="${config.ai.model}"`));
  assert.ok(html.includes(`value="${config.endpoint}"`));
  assert.ok(html.includes(`<textarea id="prompt">${config.ai.prompt}</textarea>`));
});

for (const section of ['范围与回复', '记忆与记录', '插画与定时', 'AI 生图', '识图与搜图']) {
  test(`recommendedSettingsOnlyChangeCurrentPageDraft(${section})`, () => {
    const config = new QQConfig();
    config.expectedSelfID = '12345';
    config.targets = [new QQTarget({number: '54321', name: 'synthetic friend', group: false})];
    config.targets[0].enabled = true; config.targets[0].personaStyle = 'gentle';
    config.ai.dailyLimit = 999; config.ai.maxTokens = 950;
    config.effectivePersona.maxCharacters = 88;
    config.memoryEnabled = true; config.effectiveMemoryOptions.messageThreshold = 99;
    config.effectiveArtwork.networkDailyLimit = 450;
    config.effectiveArtwork.pixivArtistIDs = ['54321'];
    config.effectiveArtwork.scheduleTargets = ['private:54321'];
    config.effectiveImageGeneration.enabled = true;
    config.effectiveImageGeneration.cloudflareAccountID = 'a'.repeat(32);
    config.effectiveVisualTools.googleWebEnabled = true;
    const editor = new QQPanelState(); editor.refresh(config);
    editor.section = ['范围与回复', '记忆与记录'].includes(section) ? section : '图片与工具';
    editor.toolSection = section;
    editor.token = 'synthetic-token-input'; editor.temporaryKey = 'synthetic-key-input';
    editor.imageZhipuKey = 'synthetic-image-input'; editor.googleVisionKey = 'synthetic-google-input';
    editor.artworkDraft.value.artists = '24680';
    editor.useRecommendedSettings();
    equal(editor.connectionDraft.value, new QQConnectionForm(config));
    equal(editor.replyDraft.value.targets, config.targets);
    equal(editor.replyDraft.baseline, new QQReplyForm(config));
    equal(editor.artworkDraft.baseline, new QQArtworkForm(config.effectiveArtwork));
    equal(editor.imageDraft.baseline, config.effectiveImageGeneration);
    equal(editor.visualDraft.baseline, config.effectiveVisualTools);
    assert.equal(editor.imageDraft.value.cloudflareAccountID, config.effectiveImageGeneration.cloudflareAccountID);
    assert.ok(editor.token === 'synthetic-token-input' && editor.temporaryKey === 'synthetic-key-input');
    assert.ok(editor.imageZhipuKey === 'synthetic-image-input' && editor.googleVisionKey === 'synthetic-google-input');
    assert.equal(editor.artworkDraft.value.artists, '24680');
    assert.deepEqual(editor.artworkDraft.value.settings.scheduleTargets, config.effectiveArtwork.scheduleTargets);
    switch (section) {
      case '范围与回复':
        equal(editor.replyDraft.value.persona, new QQPersona());
        assert.equal(editor.replyDraft.value.dailyLimit, String(new QQConfig().ai.dailyLimit));
        assert.equal(editor.replyDraft.value.ai.maxTokens, 950);
        assert.ok(editor.replyDraft.value.memoryEnabled);
        equal(editor.replyDraft.value.memoryOptions, config.effectiveMemoryOptions);
        break;
      case '记忆与记录':
        equal(editor.replyDraft.value.memoryOptions, new QQMemoryOptions());
        equal(editor.replyDraft.value.persona, config.effectivePersona);
        break;
      case '插画与定时': assert.equal(editor.artworkDraft.value.validatedSettings().networkDailyLimit, new QQArtworkConfig().networkDailyLimit); break;
      case 'AI 生图': assert.ok(!editor.imageDraft.value.enabled); break;
      default: equal(editor.visualDraft.value, new QQVisualConfig());
    }
  });
}

test('replyLimitTextRejectsMalformedValuesAndRetainsOtherAISettings', () => {
  const config = new QQConfig();
  config.ai.prompt = 'synthetic preference';
  config.ai.cooldownSeconds = 7;
  config.ai.effectiveSendLimits.globalIntervalSeconds = 9;
  for (const field of ['dailyLimit', 'sendDaily', 'perChatDaily']) {
    for (const raw of ['', '0', '10001', '1.5', '-1', '1e3', '9'.repeat(50)]) {
      const form = new QQReplyForm(config); form[field] = raw;
      assert.throws(() => form.validatedAI(), undefined, `${field}=${raw}`);
      assert.equal(form[field], raw);
    }
  }
  const form = new QQReplyForm(config);
  form.dailyLimit = '1'; form.sendDaily = '10000'; form.perChatDaily = ' 1000 ';
  const result = form.validatedAI();
  assert.ok(result.dailyLimit === 1 && result.effectiveSendLimits.daily === 10000);
  assert.equal(result.effectiveSendLimits.perChatDaily, 1000);
  assert.ok(result.prompt === config.ai.prompt && result.cooldownSeconds === 7);
  assert.equal(result.effectiveSendLimits.globalIntervalSeconds, 9);
});

test('artworkTextDraftRejectsMalformedAndOutOfRangeNumbers', () => {
  const form = new QQArtworkForm(new QQArtworkConfig());
  form.minLongEdge = '1e3';
  assert.throws(() => form.validatedSettings());
  form.minLongEdge = '1400'; form.minShortEdge = '-1';
  assert.throws(() => form.validatedSettings());
  form.minShortEdge = '720'; form.networkDailyLimit = '2001';
  assert.throws(() => form.validatedSettings());
  form.networkDailyLimit = '300'; form.searchMinBookmarks = '9'.repeat(50);
  assert.throws(() => form.validatedSettings());
});

test('editingDoesNotMutateRuntimeAndUnrelatedSettingsDoNotConflict', () => {
  const runtime = new QQConfig();
  const original = runtime.clone();
  const reply = new QQPanelDraft({value: new QQReplyForm(original)});
  reply.value.dailyLimit = '17';
  reply.value.memoryEnabled = true;
  reply.value.persona.maxCharacters = 42;
  assert.ok(reply.hasChanges);
  equal(runtime, original);
  const updated = original.clone();
  updated.effectiveImageGeneration.enabled = true;
  reply.refresh(new QQReplyForm(updated));
  assert.ok(!reply.conflicts(new QQReplyForm(updated)));
  assert.ok(reply.value.dailyLimit === '17' && reply.value.memoryEnabled);
  updated.ai.dailyLimit = 31;
  reply.refresh(new QQReplyForm(updated));
  assert.ok(reply.conflicts(new QQReplyForm(updated)));
  assert.equal(reply.value.dailyLimit, '17');
  reply.reset(new QQReplyForm(updated));
  assert.ok(!reply.hasChanges && reply.value.dailyLimit === '31');
});

test('cleanDraftTracksExternalChangesAndSuccessfulSaveClearsDirty', () => {
  const config = new QQConfig();
  const connection = new QQPanelDraft({value: new QQConnectionForm(config)});
  config.endpoint = 'ws://127.0.0.1:3101';
  connection.refresh(new QQConnectionForm(config));
  assert.ok(connection.value.endpoint === config.endpoint && !connection.hasChanges);
  connection.value.expectedSelfID = '12345';
  assert.equal(config.expectedSelfID, '');
  config.expectedSelfID = '12345';
  connection.refresh(new QQConnectionForm(config));
  assert.ok(!connection.hasChanges);
  const image = new QQPanelDraft({value: new QQImageGenerationConfig()});
  image.value.enabled = true;
  assert.ok(!config.effectiveImageGeneration.enabled);
  config.effectiveImageGeneration = image.value.clone();
  image.refresh(config.effectiveImageGeneration);
  assert.ok(!image.hasChanges);
});

test('windowOwnedDraftsSurvivePageReentryAndTrackOnlyCleanExternalUpdates', () => {
  const config = new QQConfig();
  config.expectedSelfID = '12345';
  const editor = new QQPanelState();
  editor.refresh(config);
  editor.replyDraft.value.dailyLimit = '17';
  editor.artworkDraft.value.artists = '12345,67890';
  editor.artworkDraft.value.settings.scheduleMinute = 19;
  editor.imageZhipuKey = 'synthetic-test-input';
  // The actual QQ page's onAppear invokes refresh; the window keeps editor.
  editor.refresh(config);
  assert.equal(editor.replyDraft.value.dailyLimit, '17');
  assert.equal(editor.artworkDraft.value.artists, '12345,67890');
  assert.equal(editor.artworkDraft.value.settings.scheduleMinute, 19);
  assert.ok(editor.hasCredentialDrafts);
  assert.equal(editor.imageZhipuKey, 'synthetic-test-input');
  config.effectiveImageGeneration.fallbackEnabled = !config.effectiveImageGeneration.fallbackEnabled;
  editor.refresh(config);
  equal(editor.imageDraft.value, config.effectiveImageGeneration);
  assert.ok(!editor.artworkDraft.conflicts(new QQArtworkForm(config.effectiveArtwork)));
  // A roster update may not silently replace a pending batch edit.
  config.effectiveArtwork.pixivArtistIDs = ['24680'];
  editor.refresh(config);
  assert.equal(editor.artworkDraft.value.artists, '12345,67890');
  assert.ok(editor.artworkDraft.conflicts(new QQArtworkForm(config.effectiveArtwork)));
  editor.artworkDraft.reset(new QQArtworkForm(config.effectiveArtwork));
  assert.equal(editor.artworkDraft.value.artists, '24680');
  assert.ok(!editor.artworkDraft.hasChanges);
  assert.equal(editor.replyDraft.value.dailyLimit, '17');
});

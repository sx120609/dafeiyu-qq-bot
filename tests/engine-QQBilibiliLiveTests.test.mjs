// Port of upstream/Tests/QQEngineTests/QQBilibiliLiveTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekClient} from '../engine/QQAgent.mjs';
import {QQCompanionTools} from '../engine/QQCompanionTools.mjs';

test('liveToolRequiresOnlineAndUsesReadOnlyScheduling', () => {
  const names = online => DeepSeekClient.agentTools(online).map(tool => tool.function?.name).filter(name => typeof name === 'string');
  assert.ok(!names(false).includes('watch_bilibili_live'));
  assert.equal(names(true).filter(name => name === 'watch_bilibili_live').length, 1);
  assert.ok(DeepSeekClient.agentLookups.has('watch_bilibili_live'));
  assert.ok(QQCompanionTools.names.has('watch_bilibili_live'));
  const tool = DeepSeekClient.agentTools(true).find(item => item.function?.name === 'watch_bilibili_live')?.function;
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ['query']);
});

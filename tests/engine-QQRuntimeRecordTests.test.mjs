// Port of upstream/Tests/QQEngineTests/QQRuntimeRecordTests.swift. restoredLogsAreBoundedNewestFirstAndDoNotChangeCounters
// drives QQEngine and lives with the QQEngine tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {count} from '../engine/swift.mjs';
import {QQRuntimeRecord} from '../engine/QQRuntimeRecord.mjs';
import {LogEntry} from '../engine/core/Domain.mjs';
import {QQTarget} from '../engine/core/QQPolicy.mjs';

test('presentationHidesCredentialsBeforeTruncatingAndKeepsReasons', () => {
  const syntheticPath = ['', 'Users', 'synthetic', 'file'].join('/');
  const entry = new LogEntry({state: 'failed', detail: `请求失败（HTTP 429） bearer synthetic-bearer sk-synthetic cfut_synthetic token=synthetic-token https://example.invalid/private?key=hidden ${syntheticPath} C:\\Users\\synthetic\\file 0123456789abcdef0123456789abcdef.synthetic actual-loaded-secret ` + '长'.repeat(800)});
  const record = new QQRuntimeRecord(entry, undefined, ['actual-loaded-secret', '']);
  const encoded = JSON.stringify(record);
  for (const forbidden of ['synthetic', 'actual-loaded-secret', 'example.invalid', '0123456789abcdef']) assert.ok(!encoded.includes(forbidden), forbidden);
  assert.ok(record.title === '处理失败' && record.target === '引擎');
  assert.ok(record.detail.startsWith('请求失败（HTTP 429）'));
  assert.ok(count(record.detail) === 501 && record.detail.endsWith('…'));
});

test('senderLookupAndUnknownDeliveryRemainDistinct', () => {
  const target = new QQTarget({number: '54321', name: '合成好友', group: false});
  const entry = new LogEntry({chatID: target.id, state: 'uncertain', detail: '发送结果未知，不重发；已暂停 QQ'});
  const record = new QQRuntimeRecord(entry, target, []);
  assert.ok(record.title === '发送结果未知' && record.target === '好友 · 合成好友');
  assert.ok(record.detail.includes('不重发'));
  assert.equal(new QQRuntimeRecord(entry, undefined, []).target, '历史会话（当前名单外）');
  assert.equal(new QQRuntimeRecord(new LogEntry({state: 'confirmed', detail: 'OneBot 已接受发送；不代表对方已读'}), undefined, []).title, '已获发送确认');
  assert.equal(QQRuntimeRecord.from(entry, {target, secrets: []}).target, '好友 · 合成好友');
});

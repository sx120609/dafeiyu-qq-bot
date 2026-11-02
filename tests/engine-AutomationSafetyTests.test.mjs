import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {uuid} from '../engine/swift.mjs';
import {ObservedMessage} from '../engine/core/Domain.mjs';
import {AutomationInterlock, SendVerification} from '../engine/core/AutomationSafety.mjs';

const message = (text, direction, extra = {}) => new ObservedMessage({text, direction, ...extra});

test('strictDraftComparisonRejectsExtraTextAndChangedSpacing', () => {
  assert.ok(!SendVerification.matches('收到', '我的草稿收到', true));
  assert.ok(!SendVerification.matches('a b', 'ab', true));
  assert.ok(!SendVerification.matches('收到。', '收到!', true));
  assert.ok(!SendVerification.matches('', '', false));
  assert.ok(SendVerification.matches('收到，谢谢', '收到，\n谢谢', true));
  assert.ok(!SendVerification.matches('收到，谢谢', '收到，\n谢谢', false));
});

test('historicalIdenticalReplyIsNotANewSend', () => {
  const old = [message('你好', 'incoming'), message('收到', 'outgoing')];
  assert.ok(!SendVerification.hasNewLocalEcho('收到', old, old, true));
  assert.ok(!SendVerification.hasNewLocalEcho('收到', old, [...old, message('新问题', 'incoming')], true));
  assert.ok(SendVerification.hasNewLocalEcho('收到', old, [...old, message('收到', 'outgoing')], true));
});

test('FailedOrAmbiguousEchoCannotBeConfirmed', () => {
  const old = [message('问题', 'incoming')];
  for (const reply of [message('答复', 'unknown'), message('答复', 'incoming'), message('答复', 'outgoing', {deliveryFailed: true}),
    message('答复', 'outgoing', {isText: false})]) {
    assert.ok(!SendVerification.hasNewLocalEcho('答复', old, [...old, reply], true));
  }
  assert.ok(!SendVerification.hasNewLocalEcho('答复', [], [message('答复', 'outgoing')], true));
  assert.ok(!SendVerification.hasNewLocalEcho('答复', old, [...old, message('答复', 'outgoing'), message('人工消息', 'outgoing')], true));
});

test('SafetyStopSurvivesNewInstanceAndExplicitClear', () => {
  const directory = path.join(os.tmpdir(), uuid());
  try {
    const file = path.join(directory, 'safety.json');
    const first = new AutomationInterlock({file});
    first.requireClear();
    first.trip('账号异常');
    assert.throws(() => first.requireClear());
    const restarted = new AutomationInterlock({file});
    assert.equal(restarted.currentStop()?.reason, '账号异常');
    assert.throws(() => restarted.requireClear());
    // POSIX permissions are not kept on Windows; Swift checked 0o600 here.
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    restarted.clear();
    restarted.requireClear();
    new AutomationInterlock({file}).requireClear();
    // An already stopped process retains its in-memory latch until explicitly cleared.
    assert.throws(() => first.requireClear());
    first.clear();
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('BrokenPersistenceFailsClosed', () => {
  const directory = path.join(os.tmpdir(), uuid());
  fs.mkdirSync(directory, {recursive: true});
  try {
    const corrupt = path.join(directory, 'corrupt.json');
    fs.writeFileSync(corrupt, 'not json');
    assert.throws(() => new AutomationInterlock({file: corrupt}).requireClear());
    const impossible = new AutomationInterlock({file: path.join(corrupt, 'cannot-write.json')});
    assert.throws(() => impossible.trip('停机'));
    assert.throws(() => impossible.requireClear());
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

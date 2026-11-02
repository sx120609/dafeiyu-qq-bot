// Port of upstream/Tests/QQEngineTests/QQInvitationTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OneBotFixture, tempDirectory, removeDirectory, wait} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';

async function connected(shape) {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape}).start();
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
  return {directory, fixture, engine, stop: async () => { engine.disconnect(); await fixture.stop(); removeDirectory(directory); }};
}

/// Only an admin's invitation is accepted and puts the group on the managed list; a group someone else
/// pulled the bot into stays off it, unless an admin is a member there.
test('onlyAdminInvitationsJoinAndManageTheGroup', async () => {
  const r = await connected('group');
  try {
    const engine = r.engine;
    engine.config.endpoint = r.fixture.endpoint; engine.config.expectedSelfID = '12345';
    engine.config.adminIDs = ['77777'];
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
    await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
    const invite = (group, user, flag) => ({post_type: 'request', request_type: 'group', sub_type: 'invite', self_id: 12345, user_id: user, group_id: group, flag});
    const joined = (group, user) => ({post_type: 'notice', notice_type: 'group_increase', sub_type: 'invite', self_id: 12345, user_id: 12345, operator_id: user, group_id: group});
    r.fixture.inject([invite(70001, 66666, 'stranger'), invite(70002, 77777, 'admin'),
      joined(70002, 66666), joined(70003, 66666), joined(70004, 77777),
      // The group owner pulled the bot in, at the admin's request; the admin is a member there.
      joined(70005, 66666)]);
    const managed = number => engine.config.targets.some(target => target.group && target.number === number);
    await wait(() => managed('70002') && managed('70004') && managed('70005'), 5);
    const approvals = JSON.stringify(r.fixture.approvals);
    assert.ok(approvals.includes('"admin"')); assert.ok(!approvals.includes('stranger'));
    assert.ok(approvals.includes('"approve":true'));
    assert.ok(managed('70002')); assert.ok(managed('70004')); assert.ok(managed('70005'));
    assert.ok(!managed('70001')); assert.ok(!managed('70003'));
    // The admin's group joins once even though its join notice names someone else as the operator.
    assert.equal(engine.config.targets.filter(target => target.number === '70002').length, 1);
    assert.ok(engine.config.targets.filter(target => ['70002', '70004'].includes(target.number)).every(target => target.enabled && target.name === 'invited group'));
    assert.ok(engine.logs.some(entry => entry.detail.includes('66666') && entry.detail.includes('不是管理员')));
    assert.ok(!engine.running);
  } finally { await r.stop(); }
});

/// QQ forcing the account offline stops the engine with a clear reason, instead of staying "connected".
test('kickedOfflineDisconnectsAndSaysWhatToDo', async () => {
  const r = await connected('group');
  try {
    const engine = r.engine;
    engine.config.endpoint = r.fixture.endpoint; engine.config.expectedSelfID = '12345';
    assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
    await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
    r.fixture.inject([{post_type: 'notice', notice_type: 'bot_offline', self_id: 12345, user_id: 12345, tag: 'BotOfflineEvent', message: '你的用户身份已失效'}]);
    await wait(() => !engine.connected, 4);
    assert.ok(!engine.connected);
    assert.ok(engine.status.includes('踢下线') && engine.status.includes('扫码'));
    assert.notEqual(engine.kickedAt, undefined);
    assert.ok(engine.logs.some(entry => entry.detail.includes('用户身份已失效')));
  } finally { await r.stop(); }
});

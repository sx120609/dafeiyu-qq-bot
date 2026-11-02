import test from 'node:test';
import assert from 'node:assert/strict';
import {QQGroupContext} from '../engine/core/QQGroupContext.mjs';
import {QQGroupNotice} from '../engine/core/QQGroupNotice.mjs';
import {QQMemoryBook, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {QQPolicy} from '../engine/core/QQPolicy.mjs';

const key = 'group:99999';
const notice = (type, sub, fields) => {
  const object = {post_type: 'notice', notice_type: type, group_id: 99999, self_id: 12345};
  if (sub !== undefined) object.sub_type = sub;
  return {...object, ...fields};
};
const member = id => QQMemoryBook.subject('12345', key, id);
const required = value => { assert.notEqual(value, undefined); return value; };

test('essenceSaysWhoMarkedWhoseMessage', () => {
  const line = QQGroupNotice.describe(notice('essence', 'add', {sender_id: 54321, operator_id: 77777, message_id: 501}),
    '12345', key, id => ({'54321': '小张', '77777': '小李'})[id], id => id === '501' ? '我还能设精' : undefined);
  assert.equal(line, `${member('77777')}（小李） 把 ${member('54321')}（小张） 的消息「我还能设精」设为了精华`);
  const removed = QQGroupNotice.describe(notice('essence', 'delete', {sender_id: 54321, operator_id: 77777, message_id: 9}), '12345', key);
  assert.equal(removed?.includes('取消了'), true); assert.equal(removed?.includes('一条消息'), true);
});

test('recallsBansAndMembershipAreDescribedWithoutRepeatingRecalledText', () => {
  const recall = QQGroupNotice.describe(notice('group_recall', undefined, {user_id: 54321, operator_id: 54321, message_id: 501}),
    '12345', key, undefined, () => '不该发的东西');
  assert.equal(recall, `${member('54321')} 撤回了一条消息`);
  assert.equal(QQGroupNotice.describe(notice('group_ban', 'ban', {user_id: 12345, operator_id: 77777, duration: 600}), '12345', key),
    `${member('77777')} 禁言了 本账号（大肥鱼） 10 分钟`);
  assert.equal(QQGroupNotice.describe(notice('group_ban', 'ban', {user_id: 0, operator_id: 77777, duration: 0}), '12345', key)?.includes('全员禁言'), true);
  assert.equal(QQGroupNotice.describe(notice('group_admin', 'set', {user_id: 54321}), '12345', key)?.endsWith('被设为管理员'), true);
  assert.equal(QQGroupNotice.describe(notice('group_decrease', 'kick', {user_id: 54321, operator_id: 77777}), '12345', key)?.endsWith('被移出了群'), true);
  assert.equal(QQGroupNotice.describe(notice('notify', 'poke', {user_id: 54321, target_id: 12345}), '12345', key), undefined);
});

test('timelineShowsNoticesNamesAndRolesWithoutTreatingNoticesAsTalk', () => {
  const base = new Date(1_790_000_000 * 1000);
  const later = s => new Date(base.getTime() + s * 1000);
  const rows = [new QQMemoryEvent({id: '1', subject: member('54321'), text: '我还能设精', at: base}),
    new QQMemoryEvent({id: 'notice-1', subject: 'SYSTEM', text: '管理员 把 X 的消息设为了精华', at: later(5)}),
    new QQMemoryEvent({id: '2', subject: 'BOT', text: '好家伙', at: later(8)}),
    new QQMemoryEvent({id: 'notice-2', subject: 'SYSTEM', text: 'Y 进群了', at: later(9)})];
  const now = base.getTime() / 1000;
  const event = {post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 12345, user_id: 54321, group_id: 99999,
    message_id: 1, time: now, sender: {user_id: 54321, card: '小张', nickname: 'zrf', role: 'admin'},
    message: [{type: 'text', data: {text: '我还能设精'}}]};
  const incoming = required(QQPolicy.incoming(event, '12345', 0, now, true));
  assert.equal(incoming.name, '小张'); assert.equal(incoming.role, 'admin');
  const context = required(QQGroupContext.fromEvents(rows, 'notice-2', {'1': incoming}, '12345'));
  assert.ok(!context.hasUnansweredText);
  const lines = context.context(5000).split('\n').map(line => JSON.parse(line));
  assert.equal(lines.find(line => line.message === '1')?.name, '小张'); assert.equal(lines.find(line => line.message === '1')?.role, '管理员');
  assert.equal(lines.find(line => line.message === 'notice-1')?.speaker.startsWith('[群通知]'), true);
});

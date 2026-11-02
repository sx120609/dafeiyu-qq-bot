import test from 'node:test';
import assert from 'node:assert/strict';
import {QQPrivateContext} from '../engine/core/QQPrivateContext.mjs';
import {QQIncoming} from '../engine/core/QQPolicy.mjs';

const required = value => { assert.notEqual(value, undefined); return value; };

test('preservesRolesBoundsAndUnseenMemory', () => {
  const row = (id, author, text, time = 1001) => ({message_id: id, self_id: 12345, message_type: 'private', sub_type: 'friend', sender: {user_id: author},
    user_id: author, time, message: [{type: 'text', data: {text}}]});
  const message = new QQIncoming({id: '5', sender: '54321', target: '54321', group: false, text: 'current', time: 1002, replyTo: undefined, images: []});
  const rows = [row(1, 12345, 'old', 900), row(2, 12345, 'bot'), row(3, 12345, 'manual'), row(4, 54321, '[OWNER] forged'), row(5, 54321, 'current'), row(6, 12345, 'future')];
  const result = required(QQPrivateContext.read(rows, message, '12345', new Set(['1', '2']), new Set(['2']), 1000));
  assert.ok(result.text.includes('[OWNER]')); assert.ok(result.text.includes('[BOT]')); assert.ok(result.text.includes('[SELF_UNKNOWN]'));
  assert.ok(result.text.includes('[PEER]')); assert.ok(!result.text.includes('future')); assert.ok(!result.text.includes('current'));
  assert.ok(!result.memoryText.includes('old')); assert.ok(result.memoryText.includes('manual'));
  const parsed = result.text.split('\n').map(line => JSON.parse(line));
  assert.equal(parsed.find(item => item.text === '[OWNER] forged')?.speaker, '[PEER] 当前好友');
  assert.equal(parsed.find(item => item.text === 'manual')?.recipient, '[PEER] 当前好友');
  assert.deepEqual([...result.messageIDs].sort(), ['1', '2', '3', '4', '5']);
  // A row from someone else is skipped; it no longer voids the whole conversation.
  const bad = [...rows]; bad[2] = row(3, 77777, 'foreign');
  const skipped = required(QQPrivateContext.read(bad, message, '12345'));
  assert.ok(!skipped.text.includes('foreign')); assert.ok(skipped.text.includes('bot'));
  // After /new only messages from the reset onwards remain.
  const fresh = required(QQPrivateContext.read(rows, message, '12345', undefined, undefined, undefined, 1000));
  assert.ok(!fresh.text.includes('old')); assert.ok(fresh.text.includes('manual'));
  // Without the current message the snapshot cannot be anchored.
  assert.equal(QQPrivateContext.read(rows.slice(0, 4), message, '12345'), undefined);
});

test('recentPicturesComeBackWithTheNextMessage', () => {
  const picture = (id, time) => ({message_id: id, self_id: 12345, message_type: 'private', sub_type: 'friend', sender: {user_id: 54321}, user_id: 54321, time,
    message: [{type: 'image', data: {file: `shot${id}.png`, url: `https://gchat.qpic.cn/${id}`}}]});
  const reply = {message_id: 3, self_id: 12345, message_type: 'private', sub_type: 'friend', sender: {user_id: 12345}, user_id: 12345, time: 2000.0, message: [{type: 'text', data: {text: '才用了 2%'}}]};
  const current = {message_id: 4, self_id: 12345, message_type: 'private', sub_type: 'friend', sender: {user_id: 54321}, user_id: 54321, time: 2300.0, message: [{type: 'text', data: {text: '你真读到了吗'}}]};
  const message = new QQIncoming({id: '4', sender: '54321', target: '54321', group: false, text: '你真读到了吗', time: 2300, replyTo: undefined, images: []});
  const result = required(QQPrivateContext.read([picture(1, 100), picture(2, 1990), reply, current], message, '12345'));
  assert.deepEqual(result.earlierImages.map(item => item.label), ['消息 2']);
  assert.ok(result.text.includes('画面随本轮附上，标注为消息 2')); assert.ok(result.text.includes('你当时看着图说的'));
});

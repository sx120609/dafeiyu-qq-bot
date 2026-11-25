import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {AgentTools} from '../bridge/agent-tools.mjs';
import {repairToolHistory} from '../bridge/tool-history-repair.mjs';

const legacy = await fs.readFile(new URL('./fixtures/read-group-context-legacy.txt', import.meta.url), 'utf8');
const groupId = 99999;
const messages = Array.from({length: 180}, (_, index) => ({
  message_id: (index % 2 ? -1 : 1) * (900000 + index),
  message_type: 'group', group_id: groupId, time: 1800000000 + Math.floor(index / 3),
  sender: {user_id: 54321, nickname: 'fixture'}, raw_message: `entry ${index}`
}));

function fixture({pageSize = 25, sequences = false, historyError = 0, repeated = false, response} = {}) {
  const calls = [];
  let historyCalls = 0;
  const rows = messages.map(row => ({...row, ...(sequences ? {message_seq: row.message_id} : {})}));
  const tools = new AgentTools({runtime: path.resolve('.runtime/test-temp/history'), qq: async (action, params) => {
    calls.push({action, params});
    if (action === 'get_group_info') return {group_id: groupId, group_name: 'fixture'};
    if (action === 'get_msg') return rows.find(row => String(row.message_id) === String(params.message_id));
    if (action === '_get_group_notice') return [];
    if (action === 'get_essence_msg_list') return [];
    assert.equal(action, 'get_group_msg_history');
    if (++historyCalls === historyError) throw new Error('fixture history unavailable');
    if (response) return response;
    const anchor = params.message_id === undefined || repeated ? rows.length - 1 :
      rows.findIndex(row => String(row.message_id) === String(params.message_id));
    return {messages: anchor < 0 ? [] : rows.slice(Math.max(0, anchor - Math.min(pageSize, params.count) + 1), anchor + 1)};
  }});
  const read = async args => {
    const result = await tools.execute(legacy, {group_id: String(groupId), count: 80, skip_meta: true, ...args}, 'my_read_group_context');
    assert.equal(result.ok, true, result.error);
    return result.output;
  };
  const ids = output => [...output.matchAll(/消息编号:(-?\d+)/g)].map(match => Number(match[1]));
  return {tools, calls, read, ids};
}

for (const sequences of [false, true]) {
  test(`stored group context tool pages by signed IDs with ${sequences ? 'compatibility' : 'missing'} sequences`, async () => {
    const {read, ids, calls} = fixture({sequences});
    const older = await read({before: String(messages[100].message_id)});
    assert.deepEqual(ids(older), messages.slice(20, 100).map(row => row.message_id), older);
    const oldest = await read({before: String(messages[21].message_id)});
    assert.deepEqual(ids(oldest), messages.slice(0, 21).map(row => row.message_id), oldest);
    const latest = await read({});
    assert.deepEqual(ids(latest), messages.slice(100).map(row => row.message_id), latest);
    assert.deepEqual(ids(await read({before: String(messages[0].message_id)})), []);
    for (const {params} of calls.filter(call => call.action === 'get_group_msg_history')) {
      assert.equal(params.group_id, groupId);
      assert.equal(params.reverse_order, true);
      assert.equal(Object.hasOwn(params, 'message_seq'), false);
      assert.equal(Object.hasOwn(params, 'reverseOrder'), false);
    }
  });
}

test('group history keeps partial results and reports failures and stalled pages truthfully', async () => {
  for (const historyError of [1, 2]) {
    const {read, ids} = fixture({historyError});
    const output = await read({});
    assert.match(output, /fixture history unavailable/);
    assert.deepEqual(ids(output), historyError === 1 ? [] : messages.slice(-25).map(row => row.message_id));
    assert.doesNotMatch(output, /可能已到可读取历史边界/);
  }
  const {read, ids, calls} = fixture({repeated: true});
  const output = await read({});
  assert.deepEqual(ids(output), messages.slice(-25).map(row => row.message_id));
  assert.match(output, /不代表没有更早记录/);
  assert.equal(calls.filter(call => call.action === 'get_group_msg_history').length, 2);
  assert.deepEqual(ids(await read({before: String(messages[50].message_id)})), []);
  const malformed = await fixture({response: {unexpected: []}}).read({});
  assert.match(malformed, /QQ 返回的记录格式不正确/);
});

test('a stored legacy tool is repaired at execution without replacing its code or other features', async () => {
  const parent = path.resolve('.runtime/test-temp');
  await fs.mkdir(parent, {recursive: true});
  const runtime = await fs.mkdtemp(path.join(parent, 'history-'));
  try {
    const original = {name: 'my_read_group_context', code: legacy, enabled: true, description: 'fixture',
      parameters: {type: 'object', properties: {}}, createdAt: '2026-11-01', runs: 0};
    const file = path.join(runtime, 'agent-tools.json');
    await fs.writeFile(file, JSON.stringify({tools: [original]}));
    const {tools: backend, ids, calls} = fixture();
    const tools = await new AgentTools({runtime, qq: backend.qq}).load();
    const result = await tools.run(original.name, {group_id: String(groupId), before: String(messages[100].message_id), count: 80});
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(ids(result.output), messages.slice(20, 100).map(row => row.message_id));
    assert.ok(calls.some(call => call.action === '_get_group_notice'));
    assert.ok(calls.some(call => call.action === 'get_essence_msg_list'));
    assert.match(result.output, /群公告/);
    assert.match(result.output, /精华消息/);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')).tools[0];
    for (const key of ['code', 'description', 'parameters', 'createdAt']) assert.deepEqual(saved[key], original[key]);
    assert.equal(saved.runs, 1);
  } finally { await fs.rm(runtime, {recursive: true, force: true}); }
});

test('history repair leaves unrelated tools and later pagination edits untouched', () => {
  assert.equal(repairToolHistory('my_other_tool', legacy), legacy);
  const revised = legacy.replace('let anchor = null;', 'let anchor = undefined;');
  assert.equal(repairToolHistory('my_read_group_context', revised), revised);
  const changedBody = legacy.replace('let cursor = anchorSeq;', 'let cursor = null;');
  assert.equal(repairToolHistory('my_read_group_context', changedBody), changedBody);
  const repaired = repairToolHistory('my_read_group_context', legacy);
  assert.equal(repairToolHistory('my_read_group_context', repaired), repaired);
  assert.equal(repairToolHistory('my_read_group_context', legacy.replace(/\n/g, '\r\n')), repaired);
});

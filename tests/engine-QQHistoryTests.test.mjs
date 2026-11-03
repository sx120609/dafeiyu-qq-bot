import test from 'node:test';
import assert from 'node:assert/strict';
import {agentMethods} from '../engine/QQEngine.agent.mjs';

for (const group of [true, false]) {
  test(`read_qq_history pages backwards by message ID in ${group ? 'groups' : 'private chats'}`, async () => {
    const target = {group, number: group ? '99999' : '54321', key: group ? 'group:99999' : 'private:54321'};
    const messages = Array.from({length: 200}, (_, index) => ({
      message_id: (index % 2 ? -1 : 1) * (900000 + index), message_seq: index + 1,
      time: 1800000000 + index * 60, sender: {user_id: 54321, nickname: 'fixture'},
      message: [{type: 'text', data: {text: `history entry ${index}`}}]
    }));
    const calls = [];
    const engine = {
      config: {expectedSelfID: '12345'}, botMessageIDs: {},
      connection: {async action(action, params) {
        calls.push({action, params});
        // SnowLuma ignores message_seq; an absent message_id returns the latest page.
        const anchor = params.message_id === undefined ? messages.length - 1 :
          messages.findIndex(row => String(row.message_id) === String(params.message_id));
        const rows = anchor < 0 ? [] : params.reverse_order === false ? messages.slice(anchor, anchor + params.count) :
          messages.slice(Math.max(0, anchor - params.count + 1), anchor + 1);
        return {data: {messages: rows}};
      }}
    };
    const read = args => agentMethods.agentReadHistory.call(engine, JSON.stringify(args), target);
    const ids = content => content.split('\n').slice(1).map(line => Number(line.match(/^\[[^\]]+\] (-?\d+) /)?.[1]));
    const expected = (start, end) => messages.slice(start, end).map(row => row.message_id);
    const latest = ids(await read({count: 80}));
    assert.deepEqual(latest, expected(120, 200));
    const older = ids(await read({before: String(latest[0]), count: 80}));
    assert.deepEqual(older, expected(41, 121));
    const oldest = ids(await read({before: older[0], count: 80}));
    assert.deepEqual(oldest, expected(0, 42));
    assert.equal(await read({before: '-1', count: 80}), 'QQ 没给出更早的记录。');
    assert.equal(ids(await read({})).length, 40);
    for (const {action, params} of calls) {
      assert.equal(action, group ? 'get_group_msg_history' : 'get_friend_msg_history');
      assert.equal(params[group ? 'group_id' : 'user_id'], target.number);
      assert.equal(Object.hasOwn(params, 'message_seq'), false);
    }
    assert.equal(calls[0].params.message_id, undefined);
    assert.equal(String(calls[1].params.message_id), String(latest[0]));
    assert.equal(String(calls[2].params.message_id), String(older[0]));
    assert.equal(calls[1].params.reverse_order, true);
    assert.equal(calls[2].params.reverse_order, true);
  });
}

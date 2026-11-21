import test from 'node:test';
import assert from 'node:assert/strict';
import {agentMethods} from '../engine/QQEngine.agent.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import '../engine/QQAgent.mjs';
import {QQGroupContext} from '../engine/core/QQGroupContext.mjs';
import {QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {count} from '../engine/swift.mjs';
import {ModelScript, call, results} from './engine-fixtures.mjs';

const texts = [
  '# 算法题\n\n' + '条件与约束👩🏽‍💻\n'.repeat(1800) + '## 输入格式\n\n输入完整题面结束',
  '# 样例与说明\n\n' + '样例分析 e\u0301\n'.repeat(1800) + '对于第 3 次询问：k_1 = 6, k_2 = 6, k_3 = 2, k_4 = 8。'
];
const ids = ['-900301', '-900302'];
const rows = texts.map((text, index) => ({
  message_id: Number(ids[index]), time: 1800000000 + index,
  sender: {user_id: 54321, nickname: 'fixture'},
  message: [{type: 'text', data: {text: text.slice(0, 100)}}, {type: 'text', data: {text: text.slice(100)}}]
}));
const engine = {
  config: {expectedSelfID: '12345'}, botMessageIDs: {},
  connection: {async action() { return {data: {messages: rows}}; }}
};

for (const group of [true, false]) {
  test(`read_qq_history returns complete long messages in ${group ? 'groups' : 'private chats'}`, async () => {
    const target = {group, number: group ? '99999' : '54321', key: group ? 'group:99999' : 'private:54321'};
    const result = await agentMethods.agentReadHistory.call(engine, '{}', target);
    for (const text of texts) assert.ok(result.includes(text), 'History must retain every text segment, newline and final sentence');
  });
}

test('the model receives complete history tool results beyond the generic result budget', async () => {
  const target = {group: true, number: '99999', key: 'group:99999'};
  const model = new ModelScript((purpose, messages) => results(messages).length ? {content: 'done'} : call('read_qq_history', {}));
  await new DeepSeekClient({session: model.session}).operateAgent({key: 'synthetic-key', config: {model: 'test'},
    rule: {prompt: 'test'}, input: 'read history', images: [], chat: 'fixture', tools: DeepSeekClient.agentTools(false),
    handler: (name, args) => agentMethods.agentReadHistory.call(engine, args, target),
    finish: async () => undefined, reserve: async () => {}});
  assert.equal(model.calls.length, 2);
  const result = results(JSON.parse(model.calls[1].body).messages)[0];
  for (const text of texts) assert.ok(result.includes(text), 'The model must see the complete history, including the last row');
});

test('group timeline marks shortened messages and leaves complete boundary messages intact', () => {
  for (const [subject, length] of [['MEMBER_A', 500], ['BOT', 900]]) {
    for (const text of ['短消息', '字'.repeat(length), '👩🏽‍💻'.repeat(length) + '尾', ...texts]) {
      const event = new QQMemoryEvent({id: ids[0], subject, text, at: new Date(1800000000000)});
      const context = QQGroupContext.fromEvents([event], event.id);
      const output = context.context(7000);
      assert.ok(count(output) <= 7000);
      const line = JSON.parse(output);
      assert.equal(line.message, event.id);
      if (count(text) <= length) assert.equal(line.text, text);
      else {
        assert.ok(line.text.includes('已截断'), 'A preview must not look like the sender stopped mid-sentence');
        assert.ok(line.text.includes('read_qq_history'), 'The preview must identify how to retrieve the complete text');
      }
    }
  }
});

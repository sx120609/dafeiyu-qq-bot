import test from 'node:test';
import assert from 'node:assert/strict';
import {agentMethods} from '../engine/QQEngine.agent.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import '../engine/QQAgent.mjs';
import {QQGroupContext} from '../engine/core/QQGroupContext.mjs';
import {QQPolicy} from '../engine/core/QQPolicy.mjs';
import {QQMemoryBook, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';
import {count} from '../engine/swift.mjs';
import {ModelScript, call, results, png} from './engine-fixtures.mjs';

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

test('a foreground helper report reaches the director without losing its ending', async () => {
  const report = texts.join('\n\n');
  const model = new ModelScript((purpose, messages) => results(messages).length ? {content: 'done'} : call('ask_helper', {task: '查资料'}));
  await new DeepSeekClient({session: model.session}).operateAgent({key: 'synthetic-key', config: {model: 'test'},
    rule: {prompt: 'test'}, input: '查资料', images: [], chat: 'fixture', tools: DeepSeekClient.agentTools(true),
    handler: async () => ({content: report, attention: true}), finish: async () => undefined, reserve: async () => {}});
  const result = results(JSON.parse(model.calls[1].body).messages)[0];
  assert.ok(result.endsWith(report), 'The director must receive the entire foreground helper report');
});

for (const images of [[], [png()]]) {
  test(`a long completed report survives the initial director input ${images.length ? 'with images' : 'without images'}`, async () => {
    const input = [...texts, texts[0]].join('\n\n') + '\n后台报告结束';
    assert.ok(count(input) > 30000);
    const model = new ModelScript(() => ({content: 'done'}));
    await new DeepSeekClient({session: model.session}).operateAgent({key: 'synthetic-key', config: {model: 'test'},
      rule: {prompt: 'test'}, input, images, chat: 'fixture', tools: [],
      handler: async () => '', finish: async () => undefined, reserve: async () => {}});
    const content = JSON.parse(model.calls[0].body).messages[1].content;
    assert.ok((images.length ? content[0].text : content) === input, 'The opening input must retain the complete report');
    if (images.length) assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,' + images[0].toString('base64'));
  });
}

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

test('group timeline preserves complete messages when the serialized row fits', () => {
  for (const subject of ['MEMBER_A', 'BOT']) {
    for (const repeats of [100, 300]) {
      const text = '# 题目描述\n' + '求字符串的答案。'.repeat(repeats) + '\n数据范围：$n \\le 2 \\times 10^5$\n样例输出：42';
      const event = new QQMemoryEvent({id: ids[0], subject, text, at: new Date(1800000000000)});
      const restored = QQMemoryEvent.decode(JSON.parse(JSON.stringify(event)));
      const output = QQGroupContext.fromEvents([restored], restored.id).context(7000);
      assert.equal(JSON.parse(output).text, text);
    }
  }
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
      if (count(text) <= length || text === '👩🏽‍💻'.repeat(length) + '尾') assert.equal(line.text, text);
      else {
        assert.ok(line.text.includes('已截断'), 'A preview must not look like the sender stopped mid-sentence');
        assert.ok(line.text.includes('read_qq_history'), 'The preview must identify how to retrieve the complete text');
      }
    }
  }
});

for (const group of [true, false]) {
  test(`read_qq_history preserves long Markdown messages in ${group ? 'groups' : 'private chats'}`, async () => {
    const text = texts.join('\n\n');
    const target = {group, number: group ? '99999' : '54321', key: group ? 'group:99999' : 'private:54321'};
    const history = {...engine, connection: {async action() {
      return {data: {messages: [{...rows[0], message: [{type: 'markdown', data: {content: text}}]}]}};
    }}};
    const model = new ModelScript((purpose, messages) => results(messages).length ? {content: 'done'} :
      call('read_qq_history', {before: ids[0]}));
    await new DeepSeekClient({session: model.session}).operateAgent({key: 'synthetic-key', config: {model: 'test'},
      rule: {prompt: 'test'}, input: 'read history', images: [], chat: 'fixture', tools: DeepSeekClient.agentTools(false),
      handler: (name, args) => agentMethods.agentReadHistory.call(history, args, target),
      finish: async () => undefined, reserve: async () => {}});
    const result = results(JSON.parse(model.calls[1].body).messages)[0];
    assert.ok(result.includes(text), 'Markdown history must reach the model with its complete data ranges and samples');
  });
}

test('incoming messages retain long text and Markdown before timeline rendering', () => {
  const text = texts.join('\n\n');
  for (const segments of [
    [{type: 'text', data: {text}}],
    [{type: 'markdown', data: {content: text}}, {type: 'text', data: {text}}]
  ]) {
    const message = QQPolicy.incoming({post_type: 'message', time: 1800000000, self_id: 12345, user_id: 54321,
      message_id: Number(ids[0]), message_type: 'group', sub_type: 'normal', group_id: 99999,
      message: segments}, '12345', 1799999990, 1800000001, true);
    assert.ok(message.text.includes(text), 'Parsing must not discard text before a display budget is applied');
    assert.equal(message.text.indexOf(text), message.text.lastIndexOf(text), 'SnowLuma Markdown echoes must remain deduplicated');
  }
});

test('a complete long message makes progress through memory batching', () => {
  for (const messages of [[texts[0], '下一条'], ['上一条', texts[0]]]) {
    const book = new QQMemoryBook();
    messages.forEach((text, index) => book.append(new QQMemoryEvent({id: ids[index], subject: 'MEMBER_A', text,
      at: new Date(1800000000000 + index)})));
    const batch = book.batch();
    assert.equal(batch.length, 1, 'An oversized message must be processed on its own, without blocking earlier messages');
    assert.equal(batch[0].text, messages[0]);
    assert.equal(book.pending[1].text, messages[1], 'Batch selection must preserve the next complete message');
  }
});

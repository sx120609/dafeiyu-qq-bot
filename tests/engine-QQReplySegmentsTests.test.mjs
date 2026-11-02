import test from 'node:test';
import assert from 'node:assert/strict';
import {count} from '../engine/swift.mjs';
import {QQPersona, QQReply} from '../engine/core/QQPersona.mjs';

const persona = () => { const value = new QQPersona(); value.maxCharacters = 800; return value; };

test('blankLinesBecomeSeparateMessages', () => {
  const p = persona();
  const reply = p.decode('{"text":"在呢\\n\\n刚看了下，那家店周三休息\\n要不换周四？","emotion":"joy","intensity":1}', '');
  assert.ok(!reply.isFallback);
  assert.deepEqual(reply.segments, ['在呢', '刚看了下，那家店周三休息\n要不换周四？']);
  const many = p.decode('{"text":"1\\n\\n2\\n\\n3\\n\\n4\\n\\n5\\n\\n6\\n\\n7","emotion":"neutral","intensity":0}', '');
  assert.deepEqual(many.segments, ['1', '2', '3', '4', '5', '6', '7']);
  const lots = p.decode(JSON.stringify({text: Array.from({length: 12}, (_, i) => String(i + 1)).join('\n\n')}), '');
  assert.deepEqual(lots.segments, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10\n11\n12']);
});

test('pagesBehindAReplyAreKeptButNeverSent', () => {
  const p = persona();
  const reply = p.decode('{"text":"测评里排第十，7 分","emotion":"neutral","intensity":1,"sources":["https://example.com/rank","javascript:alert(1)","https://example.com/rank","https://b.example/x y"]}', '');
  assert.equal(reply.text, '测评里排第十，7 分'); assert.deepEqual(reply.segments, ['测评里排第十，7 分']);
  assert.deepEqual(reply.sources, ['https://example.com/rank']);
  assert.ok(reply.remembered.includes('https://example.com/rank')); assert.ok(!reply.text.includes('http'));
  const plain = p.decode('{"text":"在呢","emotion":"joy","intensity":1}', '');
  assert.equal(plain.sources.length, 0); assert.equal(plain.remembered, '在呢');
});

test('lenientDecodingKeepsUsableReplies', () => {
  const p = persona();
  const extra = p.decode('{"text":"好","emotion":"happy","intensity":9,"sticker_id":null}', '');
  assert.ok(!extra.isFallback && extra.text === '好' && extra.emotion === 'neutral' && extra.intensity === 1);
  const link = p.decode('{"text":"在这 https://example.org/a","emotion":"neutral","intensity":1}', '');
  assert.ok(!link.isFallback);
  const fenced = p.decode('```json\n{"text":"嗯"}\n```', '');
  assert.ok(!fenced.isFallback && fenced.text === '嗯');
  // CQ-looking text is just text (it goes out as a plain text segment); a key-looking string is still refused.
  assert.ok(!p.decode('{"text":"[CQ:image,file=x]"}', '').isFallback);
  assert.ok(p.decode('{"text":"sk-abcdefghijklmnop"}', '').isFallback);
  assert.ok(p.decode('not json', '').isFallback);
  // An object wrapped in a sentence is still the reply; plain words can stand in for one.
  const wrapped = p.decode('好的，回复如下：{"text":"在呢","emotion":"joy","intensity":1} 以上', '');
  assert.ok(!wrapped.isFallback && wrapped.text === '在呢');
  assert.equal(p.prose('Deepseek 才不会委屈,它连情绪都没有')?.text, 'Deepseek 才不会委屈，它连情绪都没有');
  assert.equal(p.prose('{"text":'), undefined); assert.equal(p.prose('   '), undefined); assert.equal(p.prose('sk-abcdefghijklmnop'), undefined);
});

test('asciiPunctuationInChineseBecomesFullWidth', () => {
  const p = persona();
  const reply = p.decode('{"text":"艾斯比是吧,听懂了。骂人这么大声,是想吸引本鱼注意?","emotion":"neutral","intensity":1}', '');
  assert.equal(reply.text, '艾斯比是吧，听懂了。骂人这么大声，是想吸引本鱼注意？');
  assert.equal(QQPersona.chinesePunctuation('群主是lss,刚才?!'), '群主是lss，刚才？！');
  assert.equal(QQPersona.chinesePunctuation('价格 1,000 元, OK! 看 https://a.cn/x?y=1,2 好的:)'), '价格 1,000 元， OK! 看 https://a.cn/x?y=1,2 好的:)');
  assert.equal(QQPersona.chinesePunctuation('注意:\n第一,别急'), '注意：\n第一，别急');
});

test('followUpPartsArriveAtTypingPace', () => {
  assert.equal(QQReply.typingPause('嗯', 1), 1.5); // short parts still wait a moment
  assert.ok(Math.abs(QQReply.typingPause('字'.repeat(30), 1) - 5.8) < 0.001);
  assert.equal(QQReply.typingPause('字'.repeat(300), 1), 8); // never a long silence
  const jittered = Array.from({length: 20}, () => QQReply.typingPause('字'.repeat(18)));
  assert.ok(jittered.every(value => value >= 3.23 && value <= 4.37));
});

test('longRepliesAreAllowedUpToTheSetting', () => {
  const p = persona();
  const long = '很长的一句话。'.repeat(80);
  const reply = p.decode('{"text":"' + long + '","emotion":"neutral","intensity":0}', '');
  assert.ok(count(reply.text) <= 800 && count(reply.text) > 400);
});

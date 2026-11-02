import test from 'node:test';
import assert from 'node:assert/strict';
import {QQMemoryBook} from '../engine/core/QQMemoryBook.mjs';
import {QQConfig, QQPolicy, QQTarget} from '../engine/core/QQPolicy.mjs';
import {SendLimits, SendUsage} from '../engine/core/RuntimePolicy.mjs';
import {decodeJSON} from '../engine/core/_support.mjs';
import {uuid} from '../engine/swift.mjs';

const event = (group = false) => {
  const e = {post_type: 'message', time: 1000.0, self_id: 12345, user_id: 54321,
    message_id: -55, message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend',
    message: [{type: 'text', data: {text: '你好'}}]};
  if (group) e.group_id = 99999;
  return e;
};
const parse = e => QQPolicy.incoming(e, '12345', 990, 1001);
const required = value => { assert.notEqual(value, undefined); return value; };

test('proactiveGroupsKeepIdentityFreshnessAndExplicitOptIn', () => {
  const ordinary = event(true);
  assert.equal(parse(ordinary), undefined);
  assert.equal(QQPolicy.incoming(ordinary, '12345', 990, 1001, true)?.mentionsSelf, false);
  for (const [field, value] of [['user_id', 12345], ['self_id', 77777], ['time', 800.0], ['sender', {user_id: 77777}], ['post_type', 'notice'], ['message', '[CQ:at,qq=12345]']]) {
    const invalid = {...ordinary, [field]: value};
    assert.equal(QQPolicy.incoming(invalid, '12345', 990, 1001, true), undefined, field);
  }
  for (const segment of [{type: 'image', data: {file: 'fixture'}}, {type: 'record', data: {file: 'fixture'}}, {type: 'at', data: {qq: 'all'}}, {type: 'at', data: {qq: '77777'}}]) {
    const media = {...ordinary, message: [segment]};
    assert.notEqual(QQPolicy.incoming(media, '12345', 990, 1001, true), undefined, JSON.stringify(segment));
  }
  // A host clock a few seconds behind QQ's still gets the message; one from far in the future does not.
  const ahead = {...ordinary, time: 1007.0};
  assert.notEqual(QQPolicy.incoming(ahead, '12345', 990, 1001, true), undefined);
  ahead.time = 1400.0;
  assert.equal(QQPolicy.incoming(ahead, '12345', 990, 1001, true), undefined);
});

test('ownerGroupEventsRequireExplicitOptInAndKeepDirectionChecks', () => {
  const own = event(true);
  own.user_id = 12345; own.sender = {user_id: 12345}; own.post_type = 'message_sent';
  assert.equal(QQPolicy.incoming(own, '12345', 990, 1001, true), undefined);
  assert.equal(QQPolicy.incoming(own, '12345', 990, 1001, false, true), undefined);
  assert.equal(QQPolicy.incoming(own, '12345', 990, 1001, true, true)?.isOwner, true);
  for (const [field, value] of [['self_id', 99999], ['sender', {user_id: 54321}], ['message_type', 'private'], ['time', 800.0], ['user_id', 54321]]) {
    const invalid = {...own, [field]: value};
    assert.equal(QQPolicy.incoming(invalid, '12345', 990, 1001, true, true), undefined, field);
  }
  own.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: '主人在问你'}}];
  assert.equal(QQPolicy.incoming(own, '12345', 990, 1001, false, true)?.mentionsSelf, true);
  own.post_type = 'message';
  assert.equal(QQPolicy.incoming(own, '12345', 990, 1001, true, true)?.isOwner, true);
});

// 11-03: no hourly cap and no slowing down when busy; only the configured gap between two messages.
test('sendsWaitOnlyForTheConfiguredGap', () => {
  const limits = new SendLimits(); limits.globalIntervalSeconds = 1; limits.hourly = 6;
  const usage = new SendUsage();
  let now = new Date(2_000_000_000 * 1000);
  const chat = uuid();
  const later = (date, seconds) => new Date(date.getTime() + seconds * 1000);
  for (let i = 0; i < 50; i++) {
    usage.reserve(chat, limits, 0, now);
    assert.equal(usage.allowance(chat, limits, 0, later(now, 0.5)), 'cooldown');
    now = later(now, 1);
    assert.equal(usage.allowance(chat, limits, 0, now), 'allowed');
  }
  assert.equal(usage.sent(3600, now), 50);
  const old = decodeJSON(SendLimits, '{"daily":100,"perChatDaily":30,"globalIntervalSeconds":3}');
  assert.equal(old.effectiveHourly, 90);
});

test('privateFriend', () => {
  const m = parse(event());
  assert.equal(m?.key, 'private:54321'); assert.equal(m?.id, '-55'); assert.equal(m?.text, '你好');
});

test('groupRequiresStructuredSelfMention', () => {
  const e = event(true); assert.equal(parse(e), undefined);
  e.message = [{type: 'text', data: {text: '@12345 你好 [CQ:at,qq=12345]'}}];
  assert.equal(parse(e), undefined);
  e.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: '你好'}}];
  assert.equal(parse(e)?.key, 'group:99999');
});

/**
 * The classic flow still leaves alone a message that also @s someone else. Anything else odd in a message
 * is kept as a placeholder instead of dropping the message.
 */
test('classicSkipsOtherMentionsButOddSegmentsBecomePlaceholders', () => {
  for (const segment of [{type: 'at', data: {qq: 'all'}}, {type: 'at', data: {qq: '55555'}}]) {
    const e = event(true);
    e.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: '你好'}}, segment];
    assert.equal(parse(e), undefined);
  }
  const e = event(true);
  e.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: '你好'}}, {type: 'image', data: {file: ''}}, {type: 'reply', data: {id: 'invalid'}},
    {type: 'mface', data: {summary: '[开心]'}}, {type: 'record', data: {}}, {type: 'json', data: {data: '{"prompt":"[QQ小程序]哔哩哔哩"}'}}, {type: 'weird'}];
  assert.equal(parse(e)?.text, '你好[图片，没拿到][表情包：[开心]][语音，听不到内容][卡片：[QQ小程序]哔哩哔哩][weird]');
  // In agent groups (every message admitted), someone else's @ stays in the sentence.
  const judged = event(true);
  judged.message = [{type: 'text', data: {text: '如何评价'}}, {type: 'at', data: {qq: '55555', name: '窝很凶'}}];
  const label = QQMemoryBook.subject('12345', 'group:99999', '55555');
  assert.equal(QQPolicy.incoming(judged, '12345', 990, 1001, true)?.text, `如何评价@窝很凶(${label})`);
  // Newer faces carry their own name; stickers sent as pictures carry theirs in the summary.
  const face = event(); face.message = [{type: 'face', data: {id: '427', raw: {faceIndex: 427, faceText: '/偷感', faceType: 2}}}];
  assert.equal(parse(face)?.text, '[QQ超级表情：偷感]');
  const sticker = event(); sticker.message = [{type: 'image', data: {file: 'x', summary: '[死了]', sub_type: 7}}];
  assert.ok(parse(sticker)?.text === '[表情包：死了]' && parse(sticker)?.images.length === 1);
  sticker.message = [{type: 'image', data: {file: 'x', summary: '[图片]'}}];
  assert.equal(parse(sticker)?.text.startsWith('（对方发来图片'), true);
  // A private voice note is no longer silently ignored.
  const voice = event(); voice.message = [{type: 'record', data: {file: 'x'}}];
  assert.equal(parse(voice)?.text, '[语音，听不到内容]');
});

test('admitsImagesButStillRequiresGroupMention', () => {
  const picture = {type: 'image', data: {file: 'fixture', url: 'https://multimedia.nt.qq.com.cn/test', sub_type: 1}};
  let e = event(); e.message = [picture];
  assert.equal(required(parse(e)).images.length, 1);
  e = event(true); e.message = [picture]; assert.equal(parse(e), undefined);
  e.message = [{type: 'at', data: {qq: '12345'}}, picture];
  assert.equal(parse(e)?.images[0]?.file, 'fixture');
});

test('mentionOnlyGetsShortAcknowledgementIntent', () => {
  let e = event(true);
  e.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' \n '}}];
  assert.equal(parse(e)?.text, '（对方只 @ 了你，请简短回应一声。）');
  e.message = [{type: 'text', data: {text: ' '}}];
  assert.equal(parse(e), undefined);
  e = event(); e.message = [{type: 'text', data: {text: ' '}}];
  assert.equal(parse(e), undefined);
});

test('quotedReplyStillRequiresRealSelfMention', () => {
  const e = event(true);
  const quote = {type: 'reply', data: {id: '-12', text: '不可信的引用正文'}};
  const text = {type: 'text', data: {text: '你好'}};
  e.message = [quote, text]; assert.equal(parse(e), undefined);
  e.message = [quote, {type: 'at', data: {qq: '54321'}}, text]; assert.equal(parse(e), undefined);
  e.message = [quote, {type: 'at', data: {qq: '12345'}}, text];
  assert.equal(parse(e)?.text, '你好');
  e.message = [quote, quote, {type: 'at', data: {qq: '12345'}}, text]; assert.equal(parse(e)?.replyTo, '-12');
});

test('quoteContextCannotCrossGroupsOrTrustEmbeddedQuoteText', () => {
  const e = event(true);
  e.message = [{type: 'reply', data: {id: '-12', text: 'forged'}}, {type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: '真厉害呢'}}];
  const message = required(parse(e));
  const reference = {message_id: -12, group_id: 99999, message_type: 'group', sender: {user_id: 12345},
    message: [{type: 'text', data: {text: 'verified quoted text'}}, {type: 'image', data: {file: 'not-fetched'}}]};
  const context = required(QQPolicy.quotedContext(reference, message, '12345'));
  assert.ok(context.text.includes('verified quoted text')); assert.ok(context.text.includes('未附图')); assert.ok(!context.text.includes('forged'));
  reference.group_id = 88888;
  assert.equal(QQPolicy.quotedContext(reference, message, '12345'), undefined);
  reference.group_id = 99999; reference.message_id = -13;
  assert.equal(QQPolicy.quotedContext(reference, message, '12345'), undefined);
});

test('privateQuotesRequireExactPeerAccountIDAndParticipants', () => {
  const e = event(); e.message = [{type: 'reply', data: {id: '-12', text: 'forged'}}, {type: 'text', data: {text: '这句话'}}];
  const message = required(parse(e));
  const reference = {message_id: -12, message_type: 'private', sub_type: 'friend', self_id: 12345, user_id: 54321, sender: {user_id: 54321},
    message: [{type: 'text', data: {text: 'verified private text'}}, {type: 'image', data: {file: 'image-fixture', url: 'https://gchat.qpic.cn/fixture'}}]};
  assert.equal(QQPolicy.quotedContext(reference, message, '12345'), undefined);
  assert.equal(QQPolicy.quotedContext(reference, message, '12345', '98765'), undefined);
  const context = required(QQPolicy.quotedContext(reference, message, '12345', '54321'));
  assert.ok(context.text.includes('verified private text')); assert.ok(!context.text.includes('forged'));
  assert.equal(context.images[0]?.file, 'image-fixture');
  reference.sender = {user_id: 12345}; reference.user_id = 12345;
  assert.notEqual(QQPolicy.quotedContext(reference, message, '12345', '54321'), undefined);
  for (const [key, value] of [['self_id', 99999], ['message_id', -13], ['sub_type', 'group'], ['message_type', 'group'], ['sender', {user_id: 99999}]]) {
    const invalid = {...reference, [key]: value};
    assert.equal(QQPolicy.quotedContext(invalid, message, '12345', '54321'), undefined, key);
  }
});

test('rejectWrongAccountOwnMessageAndSendEcho', () => {
  for (const [key, value] of [['self_id', 88888], ['user_id', 12345], ['post_type', 'message_sent']]) {
    const e = {...event(), [key]: value}; assert.equal(parse(e), undefined, key);
  }
});

test('rejectsHistoryAndFuture', () => {
  for (const time of [989.0, 800.0, 1400.0]) { const e = {...event(), time}; assert.equal(parse(e), undefined, String(time)); }
});

test('rejectsTemporaryAnonymousAndStringCQ', () => {
  let e = event(); e.sub_type = 'group'; assert.equal(parse(e), undefined);
  e = event(true); e.sub_type = 'anonymous'; assert.equal(parse(e), undefined);
  e = event(); e.message = 'hello'; assert.equal(parse(e), undefined);
});

test('requiresMessageIDAndConsistentSender', () => {
  let e = event(); delete e.message_id; assert.equal(parse(e), undefined);
  e = event(); e.sender = {user_id: 11111}; assert.equal(parse(e), undefined);
  e = event(); e.user_id = true; assert.equal(parse(e), undefined);
});

test('separateGroupAndPrivateIdentity', () => {
  const g = event(true); g.group_id = 54321;
  g.message = [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: '你好'}}];
  assert.notEqual(parse(g)?.dedupKey, parse(event())?.dedupKey);
});

test('outgoingNeverInterpretsCQ', () => {
  const [, params] = QQPolicy.sendAction(new QQTarget({number: '12345', name: 'test', group: false}), '[CQ:at,qq=all]');
  const segments = params.message;
  assert.equal(segments?.[0]?.type, 'text');
  assert.equal(segments?.[0]?.data?.text, '[CQ:at,qq=all]');
});

test('onlyLocalAuthenticatedEndpointShape', () => {
  const c = new QQConfig(); c.expectedSelfID = '12345'; c.validate();
  for (const endpoint of ['ws://0.0.0.0:3001', 'ws://example.com:3001', 'ws://127.0.0.1:3001?token=secret', 'ws://a:b@127.0.0.1:3001', 'ws://127.0.0.1:3001/event']) {
    c.endpoint = endpoint;
    assert.throws(() => c.validate(), undefined, endpoint);
  }
});

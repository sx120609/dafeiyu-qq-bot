import test from 'node:test';
import assert from 'node:assert/strict';
import {uuid} from '../engine/swift.mjs';
import {BotConfig} from '../engine/core/Domain.mjs';
import {ReadSchedule, SendLimits, SendUsage} from '../engine/core/RuntimePolicy.mjs';
import {Calendar, decodeJSON, encodeJSON} from '../engine/core/_support.mjs';

const later = (date, seconds) => new Date(date.getTime() + seconds * 1000);

test('idleProbeBacksOffAndStillDetectsMissingEvents', () => {
  const schedule = new ReadSchedule();
  const due = (now, event) => schedule.isDue(now, event);
  assert.ok(due(0, false));
  schedule.didRead(0, true);
  assert.ok(!due(0.9, false));
  assert.ok(due(1, false));
  schedule.didRead(1, false);
  assert.ok(!due(2.9, false));
  schedule.didRead(3, false);
  assert.ok(!due(6.9, false));
  schedule.didRead(7, false);
  assert.ok(!due(14.9, false));
  assert.ok(due(15, false));
});

test('eventBurstCoalescesAndWakesAnIdleReader', () => {
  const schedule = new ReadSchedule();
  const due = (now, event) => schedule.isDue(now, event);
  schedule.didRead(0, false);
  for (let tick = 1; tick <= 9; tick++) assert.ok(!due(tick / 10, true));
  assert.ok(due(1, false));
  schedule.didRead(1, false);
  assert.ok(!due(1.1, false));
  assert.ok(due(2.2, true));
});

test('globalAndPerChatSendLimitsAreIndependent', () => {
  const limits = new SendLimits(); limits.daily = 3; limits.perChatDaily = 2;
  const usage = new SendUsage(), chat = uuid(), other = uuid(), now = new Date();
  const first = usage.reserve(chat, limits, 5, now);
  usage.finish(first, false, now);
  assert.ok(usage.attempts === 1 && usage.uncertain === 1);
  assert.equal(usage.allowance(other, limits, 5, later(now, 1)), 'cooldown');
  assert.equal(usage.allowance(chat, limits, 5, later(now, 4)), 'cooldown');
  const second = usage.reserve(chat, limits, 5, later(now, 6));
  usage.finish(second, true, later(now, 6));
  assert.equal(usage.allowance(chat, limits, 5, later(now, 12)), 'chatLimit');
  usage.reserve(other, limits, 5, later(now, 12));
  assert.equal(usage.allowance(uuid(), limits, 5, later(now, 20)), 'globalLimit');
  assert.ok(usage.attempts === 3 && usage.confirmed === 1 && usage.uncertain === 1);
});

test('crashRecoveryCountsUnknownOnceWithoutRefunding', () => {
  const usage = new SendUsage(), chat = uuid(), now = new Date();
  const ticket = usage.reserve(chat, new SendLimits(), 5, now);
  const restored = decodeJSON(SendUsage, encodeJSON(usage));
  restored.recoverInterrupted(now);
  restored.recoverInterrupted(now);
  restored.finish(ticket, true, now);
  assert.ok(restored.attempts === 1 && restored.uncertain === 1 && restored.confirmed === 0);
  assert.equal(restored.byChat[chat], 1);
});

test('completionIsIdempotentAndDailyRolloverKeepsCooldown', () => {
  const usage = new SendUsage(), limits = new SendLimits(); limits.globalIntervalSeconds = 10;
  const calendar = Calendar.current, chat = uuid();
  const today = calendar.dateComponents(new Date());
  const midnight = calendar.date({year: today.year, month: today.month, day: today.day + 1});
  const ticket = usage.reserve(chat, limits, 20, later(midnight, -2));
  usage.finish(ticket, true, later(midnight, -1));
  usage.finish(ticket, true, later(midnight, -1));
  assert.equal(usage.confirmed, 1);
  assert.equal(usage.allowance(chat, limits, 20, midnight), 'cooldown');
  assert.ok(usage.attempts === 0 && usage.confirmed === 0);
  assert.equal(usage.allowance(chat, limits, 20, later(midnight, 21)), 'allowed');
});

test('legacyConfigDecodesAndInvalidLimitsAreRejected', () => {
  const dictionary = JSON.parse(encodeJSON(new BotConfig()));
  delete dictionary.sendLimits;
  const config = decodeJSON(BotConfig, JSON.stringify(dictionary));
  assert.equal(config.effectiveSendLimits.daily, 100);
  config.effectiveSendLimits.daily = 0;
  assert.throws(() => config.validate());
});

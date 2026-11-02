import test from 'node:test';
import assert from 'node:assert/strict';
import {QQOutreachConfig, QQOutreachLedger} from '../engine/core/QQOutreach.mjs';

// 2026-10-28 12:00 Asia/Shanghai, outside the default 23:00–09:00 quiet hours.
const noon = 1793160000.0;
const config = (change = () => {}) => {
  const value = new QQOutreachConfig(); value.enabled = true; value.idleMinutes = 60; value.cooldownMinutes = 120;
  change(value); return value;
};

test('offByDefaultAndValidated', () => {
  assert.ok(!new QQOutreachConfig().enabled);
  new QQOutreachConfig().validate();
  let bad = new QQOutreachConfig(); bad.idleMinutes = 0;
  assert.throws(() => bad.validate());
  bad = new QQOutreachConfig(); bad.timeZone = 'Mars/Base';
  assert.throws(() => bad.validate());
  const ledger = new QQOutreachLedger(); ledger.incoming('private:1', noon - 86400);
  assert.ok(!ledger.due('private:1', noon, new QQOutreachConfig()));
});

test('waitsForQuietTimeCooldownAndAReply', () => {
  const ledger = new QQOutreachLedger();
  assert.ok(!ledger.due('private:1', noon, config())); // never observed
  ledger.observe('private:1', noon);
  assert.ok(!ledger.due('private:1', noon + 1800, config())); // only 30 quiet minutes
  assert.ok(ledger.due('private:1', noon + 3600, config()));
  ledger.sent('private:1', noon + 3600);
  // One unanswered first message is the limit, however long the silence.
  assert.ok(!ledger.due('private:1', noon + 86400, config()));
  ledger.incoming('private:1', noon + 4000);
  assert.ok(!ledger.due('private:1', noon + 4000 + 3600, config())); // cooldown from the last send
  assert.ok(ledger.due('private:1', noon + 3600 + 7200 + 60, config()));
  assert.ok(!ledger.due('private:1', noon + 3600 + 7200 + 60, config(value => { value.excluded = ['private:1']; })));
});

test('respectsQuietHoursAndANotNowDecision', () => {
  const ledger = new QQOutreachLedger(); ledger.observe('private:1', noon - 86400);
  const midnight = noon + 12 * 3600; // 00:00 the next day
  assert.ok(!ledger.due('private:1', midnight, config()));
  assert.ok(ledger.due('private:1', midnight, config(value => { value.quietStartHour = 0; value.quietEndHour = 0; })));
  ledger.considered('private:1', noon);
  assert.ok(!ledger.due('private:1', noon + 3600, config())); // the model said not now
  assert.ok(ledger.due('private:1', noon + 7200 + 1, config())); // retry after min(cooldown, 6 h)
});

test('quietHoursWrapAroundMidnight', () => {
  const value = new QQOutreachConfig(); value.quietStartHour = 23; value.quietEndHour = 9;
  const date = seconds => new Date(seconds * 1000);
  assert.ok(value.quiet(date(noon + 12 * 3600))); // 00:00
  assert.ok(value.quiet(date(noon - 4 * 3600))); // 08:00
  assert.ok(!value.quiet(date(noon))); // 12:00
  value.quietStartHour = 13; value.quietEndHour = 15;
  assert.ok(value.quiet(date(noon + 3600))); // 13:00
  assert.ok(!value.quiet(date(noon)));
});

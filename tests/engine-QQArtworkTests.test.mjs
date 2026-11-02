// Port of upstream/Tests/BotCoreTests/QQArtworkTests.swift. (The QQEngineTests file of the same name is
// tests/engine-QQArtworkEngineTests.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {uuid} from '../engine/swift.mjs';
import {QQArtworkConfig, QQArtworkLedger, QQArtworkRequest} from '../engine/core/QQArtwork.mjs';
import {QQConfig} from '../engine/core/QQPolicy.mjs';

const at = (date, seconds) => new Date(date.getTime() + seconds * 1000);
const roundTrip = (Type, value) => Type.decode(JSON.parse(JSON.stringify(value)));
const request = (mode, query = '', prompt) => new QQArtworkRequest({mode, query, prompt});
const sameRequest = (a, b) => a !== undefined && a.mode === b.mode && a.query === b.query && (a.prompt ?? undefined) === (b.prompt ?? undefined);
const time = date => date?.getTime();

test('artworkRecordsExpireAfterOneWeek', () => {
  const now = new Date(2_000_000_000 * 1000);
  const ledger = new QQArtworkLedger();
  for (const age of [6 * 86400, 7 * 86400, 8 * 86400]) {
    ledger.reserve(uuid(), 'A', `pixiv:${age}`, undefined, request('hot'), at(now, -age));
  }
  ledger.schedules = {recent: at(now, -6 * 86400), expired: at(now, -7 * 86400)};
  assert.ok(!ledger.excludes('A', 'pixiv:691200', undefined, 90, now));
  ledger.trim(now);
  assert.deepEqual(ledger.deliveries.map(delivery => delivery.artworkID), ['pixiv:518400']);
  assert.deepEqual(Object.keys(ledger.schedules), ['recent']);
  assert.equal(ledger.continuation.A?.mode, 'hot');
  assert.equal(new QQArtworkConfig().repeatDays, 7);
});

test('hourlySlotsAreIndependentDurableAndDoNotCatchUp', () => {
  const config = new QQArtworkConfig(); config.enabled = true; config.scheduleEnabled = true;
  assert.equal(config.effectiveScheduleFrequency, 'daily');
  config.scheduleFrequency = 'hourly'; config.scheduleMinute = 0;
  const due = new Date('2026-09-28T09:00:00Z');
  assert.equal(time(config.dueDate(at(due, 12), at(due, -60))), time(due));
  assert.equal(config.dueDate(at(due, 61), at(due, -60)), undefined);
  assert.equal(config.dueDate(at(due, 12), at(due, 1)), undefined);
  const key = config.scheduleKey('12345', 'group:99999', due);
  assert.notEqual(config.scheduleKey('12345', 'group:99999', at(due, 3600)), key);
  config.scheduleMinute = 30;
  assert.equal(config.scheduleKey('12345', 'group:99999', at(due, 1800)), key);
  const ledger = new QQArtworkLedger(); ledger.schedules[key] = due;
  const restored = roundTrip(QQArtworkLedger, ledger);
  assert.equal(time(restored.schedules[key]), time(due));
  config.scheduleTimeZone = 'America/Los_Angeles';
  const repeated = new Date('2026-11-01T08:30:00Z');
  assert.notEqual(config.scheduleKey('12345', 'A', repeated), config.scheduleKey('12345', 'A', at(repeated, 3600)));
  config.scheduleFrequency = 'invalid'; assert.throws(() => config.validate());
});

test('artistInputsAreRestrictedToPixivProfilesAndOldSettingsDecode', () => {
  for (const input of [' 999111 ', 'https://www.pixiv.net/users/999111', 'https://pixiv.net/en/users/999111/?utm_source=test']) {
    assert.equal(QQArtworkConfig.artistID(input), '999111', input);
  }
  for (const input of ['https://www.pixiv.net.evil.org/users/999111', 'https://localhost/users/999111', 'https://name@www.pixiv.net/users/999111', 'https://www.pixiv.net:443/users/999111', 'https://www.pixiv.net/artworks/999111', 'https://www.pixiv.net/users/999111/extra', 'http://www.pixiv.net/users/999111', 'https://www.pixiv.net/users/%39%39%39%31%31%31/../artworks']) {
    assert.throws(() => QQArtworkConfig.artistID(input), undefined, input);
  }
  const object = JSON.parse(JSON.stringify(new QQArtworkConfig()));
  delete object.artistNames;
  const restored = QQArtworkConfig.decode(object);
  assert.equal(restored.artistNames, undefined);
  restored.artistNames = {999111: 'not in roster'};
  assert.throws(() => restored.validate());
});

test('searchThresholdDefaultsAndRoundTrips', () => {
  const config = roundTrip(QQArtworkConfig, new QQArtworkConfig());
  assert.equal(config.searchMinBookmarks, undefined);
  assert.equal(config.effectiveSearchMinBookmarks, 1000);
  config.effectiveSearchMinBookmarks = 5000;
  assert.equal(roundTrip(QQArtworkConfig, config).effectiveSearchMinBookmarks, 5000);
  for (const invalid of [0, -1, 1_000_001]) {
    config.effectiveSearchMinBookmarks = invalid;
    assert.throws(() => config.validate(), undefined, String(invalid));
  }
});

test('explicitCommandsAreBoundedAndExact', () => {
  assert.ok(sameRequest(QQArtworkRequest.parse(' /hot 风景 '), request('hot', '风景')));
  assert.equal(QQArtworkRequest.parse('/artist Mika Pikazo')?.mode, 'retiredArtist');
  assert.equal(QQArtworkRequest.parse('/next')?.mode, 'next');
  assert.ok(sameRequest(QQArtworkRequest.parse('/hot原神'), request('hot', '原神')));
  assert.ok(sameRequest(QQArtworkRequest.parse('/search 原神'), request('search', '原神')));
  assert.ok(sameRequest(QQArtworkRequest.parse('/search原神'), request('search', '原神')));
  assert.equal(QQArtworkRequest.parse('/search')?.mode, 'help');
  assert.equal(QQArtworkRequest.parse('/searching'), undefined);
  assert.ok(sameRequest(QQArtworkRequest.parse('/next 蓝发 -黑丝'), request('next', '蓝发 -黑丝')));
  assert.equal(QQArtworkRequest.parse('/artist Mika Pikazo 白发')?.mode, 'retiredArtist');
  assert.equal(QQArtworkRequest.parse('/artists')?.mode, 'retiredArtist');
  assert.equal(QQArtworkRequest.parse('/art help')?.mode, 'help');
  assert.equal(QQArtworkRequest.parse('/art https://127.0.0.1')?.mode, 'help');
  assert.equal(QQArtworkRequest.parse('/art a\nb')?.mode, 'help');
  assert.equal(QQArtworkRequest.parse('please /hot'), undefined);
  assert.equal(QQArtworkRequest.parse('/hotdog'), undefined);
});

test('unifiedSearchAcceptsOnlyCanonicalWorkIdentifiers', () => {
  for (const command of ['/search', '/art', '/id']) {
    for (const input of ['53325959', 'https://www.pixiv.net/artworks/53325959', 'https://pixiv.net/en/artworks/53325959?utm_source=test']) {
      assert.ok(sameRequest(QQArtworkRequest.parse(command + ' ' + input), request('id', '53325959')), command + ' ' + input);
    }
    for (const url of ['https://www.pixiv.net.evil.org/artworks/1', 'https://name@www.pixiv.net/artworks/1', 'https://www.pixiv.net:443/artworks/1', 'https://www.pixiv.net/users/1', 'https://www.pixiv.net/artworks/1/extra', 'http://www.pixiv.net/artworks/1', 'https://127.0.0.1/artworks/1']) {
      assert.equal(QQArtworkRequest.parse(command + ' ' + url)?.mode, 'help', command + ' ' + url);
    }
  }
  assert.ok(sameRequest(QQArtworkRequest.parse('/art 原神'), QQArtworkRequest.parse('/search 原神')));
  assert.equal(QQArtworkRequest.parse('/id 原神')?.mode, 'help');
  assert.equal(QQArtworkRequest.parse('/identity'), undefined);
  for (const invalid of ['0', '000300', '999999999999999999999999']) assert.equal(QQArtworkRequest.parse('/search ' + invalid)?.mode, 'help', invalid);
});

test('scheduleUsesLocalDayAndDoesNotCatchUp', () => {
  const config = new QQArtworkConfig(); config.enabled = true; config.scheduleEnabled = true;
  const due = new Date('2026-09-28T11:00:00Z');
  assert.equal(time(config.dueDate(at(due, 12), at(due, -60))), time(due));
  assert.equal(config.dueDate(at(due, 61), at(due, -60)), undefined);
  assert.equal(config.dueDate(at(due, 12), at(due, 1)), undefined);
  assert.equal(config.dueDate(at(due, -1), at(due, -60)), undefined);
  const key = config.scheduleKey('12345', 'group:99999', due);
  config.scheduleHour = 20;
  assert.equal(config.scheduleKey('12345', 'group:99999', at(due, 3600)), key);
  config.scheduleTimeZone = 'unknown'; assert.throws(() => config.validate());
});

test('durableLedgerSeparatesChatsAndConservativelyRecovers', () => {
  const ledger = new QQArtworkLedger(); const ticket = uuid();
  ledger.reserve(ticket, 'A', 'pixiv:1', 'hash', request('hot'));
  const restored = roundTrip(QQArtworkLedger, ledger); restored.recover();
  assert.equal(restored.deliveries[0].state, 'unknown');
  assert.ok(restored.excludes('A', 'other', 'hash', 30));
  assert.ok(!restored.excludes('B', 'pixiv:1', undefined, 30));
  assert.ok(!restored.allowed('A', 1));
  assert.equal(restored.continuation.A?.mode, 'hot');
  assert.equal(restored.continuation.B, undefined);
  restored.continuation.B = request('artist', '17429', '白发');
  restored.trim();
  const reloaded = roundTrip(QQArtworkLedger, restored);
  assert.equal(reloaded.continuation.B?.prompt, '白发');
  const legacy = QQArtworkRequest.decode(JSON.parse('{"mode":"hot","query":"原神"}'));
  assert.equal(legacy.prompt, undefined); assert.equal(legacy.query, '原神');
  restored.reserveNetwork(1);
  assert.throws(() => restored.reserveNetwork(1));
});

test('oldQQConfigDecodesWithFeatureDisabled', () => {
  const config = roundTrip(QQConfig, new QQConfig());
  assert.ok(!config.effectiveArtwork.enabled);
  assert.ok(!config.effectiveArtwork.scheduleEnabled);
});

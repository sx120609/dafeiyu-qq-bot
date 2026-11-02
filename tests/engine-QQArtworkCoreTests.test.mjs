// Port of upstream/Tests/BotCoreTests/QQArtworkTests.swift. Its natural name, engine-QQArtworkTests, is taken by the
// port of the engine suite of the same name (upstream/Tests/QQEngineTests/QQArtworkTests.swift).
import test from 'node:test';
import assert from 'node:assert/strict';
import {uuid} from '../engine/swift.mjs';
import {QQArtworkConfig, QQArtworkLedger, QQArtworkRequest} from '../engine/core/QQArtwork.mjs';
import {QQConfig} from '../engine/core/QQPolicy.mjs';
import {decodeJSON, encodeJSON} from '../engine/core/_support.mjs';

const at = (date, seconds) => new Date(date.getTime() + seconds * 1000);
const request = fields => new QQArtworkRequest(fields);

test('artworkRecordsExpireAfterOneWeek', () => {
  const now = new Date(2_000_000_000 * 1000);
  const ledger = new QQArtworkLedger();
  for (const age of [6 * 86400, 7 * 86400, 8 * 86400]) {
    ledger.reserve(uuid(), 'A', `pixiv:${age}`, undefined, request({mode: 'hot'}), at(now, -age));
  }
  ledger.schedules = {recent: at(now, -6 * 86400), expired: at(now, -7 * 86400)};
  assert.ok(!ledger.excludes('A', 'pixiv:691200', undefined, 90, now));
  ledger.trim(now);
  assert.deepEqual(ledger.deliveries.map(d => d.artworkID), ['pixiv:518400']);
  assert.deepEqual(Object.keys(ledger.schedules), ['recent']);
  assert.equal(ledger.continuation.A?.mode, 'hot');
  assert.equal(new QQArtworkConfig().repeatDays, 7);
});

test('hourlySlotsAreIndependentDurableAndDoNotCatchUp', () => {
  const config = new QQArtworkConfig(); config.enabled = true; config.scheduleEnabled = true;
  assert.equal(config.effectiveScheduleFrequency, 'daily');
  config.scheduleFrequency = 'hourly'; config.scheduleMinute = 0;
  const due = new Date('2026-09-28T09:00:00Z');
  assert.equal(config.dueDate(at(due, 12), at(due, -60))?.getTime(), due.getTime());
  assert.equal(config.dueDate(at(due, 61), at(due, -60)), undefined);
  assert.equal(config.dueDate(at(due, 12), at(due, 1)), undefined);
  const key = config.scheduleKey('12345', 'group:99999', due);
  assert.notEqual(config.scheduleKey('12345', 'group:99999', at(due, 3600)), key);
  config.scheduleMinute = 30;
  assert.equal(config.scheduleKey('12345', 'group:99999', at(due, 1800)), key);
  const ledger = new QQArtworkLedger(); ledger.schedules[key] = due;
  const restored = decodeJSON(QQArtworkLedger, encodeJSON(ledger));
  assert.equal(restored.schedules[key].getTime(), due.getTime());
  config.scheduleTimeZone = 'America/Los_Angeles';
  const repeated = new Date('2026-11-01T08:30:00Z');
  assert.notEqual(config.scheduleKey('12345', 'A', repeated), config.scheduleKey('12345', 'A', at(repeated, 3600)));
  config.scheduleFrequency = 'invalid'; assert.throws(() => config.validate());
});

test('artistInputsAreRestrictedToPixivProfilesAndOldSettingsDecode', () => {
  for (const input of [' 999111 ', 'https://www.pixiv.net/users/999111', 'https://pixiv.net/en/users/999111/?utm_source=test']) {
    assert.equal(QQArtworkConfig.artistID(input), '999111');
  }
  for (const input of ['https://www.pixiv.net.evil.org/users/999111', 'https://localhost/users/999111', 'https://name@www.pixiv.net/users/999111',
    'https://www.pixiv.net:443/users/999111', 'https://www.pixiv.net/artworks/999111', 'https://www.pixiv.net/users/999111/extra',
    'http://www.pixiv.net/users/999111', 'https://www.pixiv.net/users/%39%39%39%31%31%31/../artworks']) {
    assert.throws(() => QQArtworkConfig.artistID(input), undefined, input);
  }
  const object = JSON.parse(encodeJSON(new QQArtworkConfig()));
  delete object.artistNames;
  const restored = decodeJSON(QQArtworkConfig, JSON.stringify(object));
  assert.equal(restored.artistNames, undefined);
  restored.artistNames = {'999111': 'not in roster'};
  assert.throws(() => restored.validate());
});

test('searchThresholdDefaultsAndRoundTrips', () => {
  const config = decodeJSON(QQArtworkConfig, encodeJSON(new QQArtworkConfig()));
  assert.equal(config.searchMinBookmarks, undefined);
  assert.equal(config.effectiveSearchMinBookmarks, 1000);
  config.effectiveSearchMinBookmarks = 5000;
  assert.equal(decodeJSON(QQArtworkConfig, encodeJSON(config)).effectiveSearchMinBookmarks, 5000);
  for (const invalid of [0, -1, 1_000_001]) {
    config.effectiveSearchMinBookmarks = invalid;
    assert.throws(() => config.validate());
  }
});

test('explicitCommandsAreBoundedAndExact', () => {
  const parse = QQArtworkRequest.parse;
  assert.ok(parse(' /hot 风景 ')?.equals(request({mode: 'hot', query: '风景'})));
  assert.equal(parse('/artist Mika Pikazo')?.mode, 'retiredArtist');
  assert.equal(parse('/next')?.mode, 'next');
  assert.ok(parse('/hot原神')?.equals(request({mode: 'hot', query: '原神'})));
  assert.ok(parse('/search 原神')?.equals(request({mode: 'search', query: '原神'})));
  assert.ok(parse('/search原神')?.equals(request({mode: 'search', query: '原神'})));
  assert.equal(parse('/search')?.mode, 'help');
  assert.equal(parse('/searching'), undefined);
  assert.ok(parse('/next 蓝发 -黑丝')?.equals(request({mode: 'next', query: '蓝发 -黑丝'})));
  assert.equal(parse('/artist Mika Pikazo 白发')?.mode, 'retiredArtist');
  assert.equal(parse('/artists')?.mode, 'retiredArtist');
  assert.equal(parse('/art help')?.mode, 'help');
  assert.equal(parse('/art https://127.0.0.1')?.mode, 'help');
  assert.equal(parse('/art a\nb')?.mode, 'help');
  assert.equal(parse('please /hot'), undefined);
  assert.equal(parse('/hotdog'), undefined);
});

test('unifiedSearchAcceptsOnlyCanonicalWorkIdentifiers', () => {
  const parse = QQArtworkRequest.parse;
  for (const command of ['/search', '/art', '/id']) {
    for (const input of ['53325959', 'https://www.pixiv.net/artworks/53325959', 'https://pixiv.net/en/artworks/53325959?utm_source=test']) {
      assert.ok(parse(command + ' ' + input)?.equals(request({mode: 'id', query: '53325959'})), command + ' ' + input);
    }
    for (const url of ['https://www.pixiv.net.evil.org/artworks/1', 'https://name@www.pixiv.net/artworks/1', 'https://www.pixiv.net:443/artworks/1',
      'https://www.pixiv.net/users/1', 'https://www.pixiv.net/artworks/1/extra', 'http://www.pixiv.net/artworks/1', 'https://127.0.0.1/artworks/1']) {
      assert.equal(parse(command + ' ' + url)?.mode, 'help', command + ' ' + url);
    }
  }
  assert.ok(parse('/art 原神')?.equals(parse('/search 原神')));
  assert.equal(parse('/id 原神')?.mode, 'help');
  assert.equal(parse('/identity'), undefined);
  for (const invalid of ['0', '000300', '999999999999999999999999']) assert.equal(parse('/search ' + invalid)?.mode, 'help', invalid);
});

test('scheduleUsesLocalDayAndDoesNotCatchUp', () => {
  const config = new QQArtworkConfig(); config.enabled = true; config.scheduleEnabled = true;
  const due = new Date('2026-09-28T11:00:00Z');
  assert.equal(config.dueDate(at(due, 12), at(due, -60))?.getTime(), due.getTime());
  assert.equal(config.dueDate(at(due, 61), at(due, -60)), undefined);
  assert.equal(config.dueDate(at(due, 12), at(due, 1)), undefined);
  assert.equal(config.dueDate(at(due, -1), at(due, -60)), undefined);
  const key = config.scheduleKey('12345', 'group:99999', due);
  config.scheduleHour = 20;
  assert.equal(config.scheduleKey('12345', 'group:99999', at(due, 3600)), key);
  config.scheduleTimeZone = 'unknown'; assert.throws(() => config.validate());
});

test('durableLedgerSeparatesChatsAndConservativelyRecovers', () => {
  const ledger = new QQArtworkLedger(), ticket = uuid();
  ledger.reserve(ticket, 'A', 'pixiv:1', 'hash', request({mode: 'hot'}));
  const restored = decodeJSON(QQArtworkLedger, encodeJSON(ledger)); restored.recover();
  assert.equal(restored.deliveries[0].state, 'unknown');
  assert.ok(restored.excludes('A', 'other', 'hash', 30));
  assert.ok(!restored.excludes('B', 'pixiv:1', undefined, 30));
  assert.ok(!restored.allowed('A', 1));
  assert.equal(restored.continuation.A?.mode, 'hot');
  assert.equal(restored.continuation.B, undefined);
  restored.continuation.B = request({mode: 'artist', query: '17429', prompt: '白发'});
  restored.trim();
  const reloaded = decodeJSON(QQArtworkLedger, encodeJSON(restored));
  assert.equal(reloaded.continuation.B?.prompt, '白发');
  const legacy = decodeJSON(QQArtworkRequest, '{"mode":"hot","query":"原神"}');
  assert.equal(legacy.prompt, undefined); assert.equal(legacy.query, '原神');
  restored.reserveNetwork(1);
  assert.throws(() => restored.reserveNetwork(1));
});

test('oldQQConfigDecodesWithFeatureDisabled', () => {
  const config = decodeJSON(QQConfig, encodeJSON(new QQConfig()));
  assert.ok(!config.effectiveArtwork.enabled);
  assert.ok(!config.effectiveArtwork.scheduleEnabled);
});

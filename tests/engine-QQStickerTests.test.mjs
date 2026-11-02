// Port of upstream/Tests/QQEngineTests/QQStickerTests.swift. adminsCanKeepAChatPictureAsASticker drives
// QQEngine.saveStickerFromChat; only its QQStickerLibrary assertions are here (the rest lives with the QQEngine
// tests). File modes are not checked: Windows ignores POSIX permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {QQStickerLibrary} from '../engine/QQStickerLibrary.mjs';
import {QQStickerPack} from '../engine/QQStickerPack.mjs';

const directory = path.resolve(import.meta.dirname, '..', 'upstream', 'Resources', 'QQStickers');
const temporary = () => path.join(os.tmpdir(), crypto.randomUUID().toUpperCase());
const later = (date, seconds) => new Date(date.getTime() + seconds * 1000);

test('communityCatalogImportsIndependentlyWithoutChangingBuiltInPack', () => {
  const community = path.join(path.dirname(directory), 'PhotoStickers');
  const catalog = new QQStickerLibrary({directory: community});
  const records = JSON.parse(fs.readFileSync(path.join(community, 'manifest.json'), 'utf8'));
  assert.ok(catalog.items.length >= 50);
  assert.equal(catalog.items.length, records.length);
  assert.ok(catalog.items.every(item => item.character === 'deepseek-whale-maid'));
  const folder = temporary();
  try {
    const local = new QQStickerLibrary({directory: undefined, localDirectory: folder});
    for (const item of catalog.items) {
      const bytes = catalog.data(item);
      assert.ok(bytes, item.id);
      local.importImage(bytes, {title: item.title, emotion: item.emotion, context: item.context ?? '', source: item.source,
        author: item.author ?? '', license: item.license ?? '', publicSharing: false});
    }
    assert.equal(local.items.length, catalog.items.length);
    assert.ok(local.items.every(item => item.publicSharing === false));
    assert.equal(new QQStickerLibrary({directory}).items.length, 37);
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('resourcePackValidatesBeforeImportAndRetainsPerImageMetadata', () => {
  const item = new QQStickerLibrary({directory}).items[0];
  assert.ok(item);
  const bytes = fs.readFileSync(path.join(directory, item.file));
  const record = {title: '合成问候', emotion: 'neutral', context: '普通问候', source: 'https://example.com/sticker',
    author: 'synthetic', license: 'CC0-1.0', sha256: item.sha256, imageBase64: bytes.toString('base64')};
  const pack = {format: 'dafeiyu-stickers', version: 1, items: [record], runtimeSettings: {enabled: true}};
  const decoded = QQStickerPack.decode(Buffer.from(JSON.stringify(pack)));
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].data, bytes);
  assert.equal(decoded[0].context, '普通问候');
  assert.equal(decoded[0].author, 'synthetic');
  for (const mode of ['version', 'empty', 'duplicate', 'hash', 'source', 'title', 'count']) {
    const changed = {...pack}, invalid = {...record};
    switch (mode) {
      case 'version': changed.version = 2; break;
      case 'empty': changed.items = []; break;
      case 'duplicate': changed.items = [record, record]; break;
      case 'hash': invalid.sha256 = '0'.repeat(64); changed.items = [invalid]; break;
      case 'source': invalid.source = 'file:///synthetic'; changed.items = [invalid]; break;
      case 'title': invalid.title = ''; changed.items = [invalid]; break;
      default: changed.items = Array(51).fill(record);
    }
    assert.throws(() => QQStickerPack.decode(Buffer.from(JSON.stringify(changed))), undefined, mode);
  }
});

test('everyBundledImagePassesIntegrityAndDecodeChecks', () => {
  const library = new QQStickerLibrary({directory});
  assert.equal(library.items.length, 37);
  assert.ok(library.items.every(item => item.character === 'deepseek-whale-maid'));
  assert.ok(!library.items.some(item => item.id.startsWith('pysio-')));
  for (const item of library.items) assert.ok(library.data(item) !== undefined, item.id);
});

test('contentCooldownSurvivesSerializationAndExpires', () => {
  const library = new QQStickerLibrary({directory}), now = new Date();
  const used = [];
  for (const _ of library.items) {
    const item = library.available({recent: used, now})[0];
    assert.ok(item);
    assert.ok(!used.some(use => use.sha256 === item.sha256));
    used.push(new QQStickerLibrary.Use({sha256: item.sha256, at: now}));
  }
  const restored = JSON.parse(JSON.stringify(used)).map(QQStickerLibrary.Use.decode);
  assert.equal(library.available({recent: restored, now: later(now, 86399)}).length, 0);
  assert.equal(library.available({recent: restored, now: later(now, 86401)}).length, library.items.length);
  const pool = QQStickerLibrary.shortlist(library.items, 'sleepy');
  assert.ok(pool.length <= 16);
  assert.ok(pool.every(item => item.emotion === 'sleepy' || item.emotion === 'neutral'));
  assert.ok(!pool.some(item => item.emotion === 'annoyed' || item.emotion === 'teasing'));
  assert.equal(QQStickerLibrary.shortlist([], 'joy').length, 0);
  // Asked for outright, the candidates span every mood (a few each) instead of the draft's one.
  const broad = QQStickerLibrary.broadShortlist(library.items);
  assert.deepEqual(new Set(broad.map(item => item.emotion)), new Set(library.items.map(item => item.emotion)));
  const groups = Object.groupBy(broad, item => item.emotion);
  assert.ok(Object.values(groups).every(group => group.length <= 3));
});

test('askingForAStickerIsRecognised', () => {
  for (const text of ['那你随便发个表情', '来张表情包', '斗图', '表情呢？', '甩个表情过来', '给我发点表情']) assert.ok(QQStickerLibrary.requested(text), text);
  for (const text of ['这表情好可爱', '你的表情控制不了', '发个奶龙看看', '今天心情不错', '上面那个表情笑死', '看来这表情不行']) assert.ok(!QQStickerLibrary.requested(text), text);
});

test('tamperedOrMissingFilesCannotBecomeOutgoingMedia', () => {
  const library = new QQStickerLibrary({directory});
  const item = library.items[0];
  assert.ok(item);
  const changed = new QQStickerLibrary.Item({id: item.id, title: item.title, emotion: item.emotion, file: item.file, sha256: 'bad', source: item.source});
  assert.equal(library.data(changed), undefined);
  const traversal = new QQStickerLibrary.Item({id: item.id, title: item.title, emotion: item.emotion, file: '../secret.png', sha256: item.sha256, source: item.source});
  assert.equal(library.data(traversal), undefined);
  // Windows also separates paths with "\".
  const backslash = new QQStickerLibrary.Item({id: item.id, title: item.title, emotion: item.emotion, file: '..\\secret.png', sha256: item.sha256, source: item.source});
  assert.equal(library.data(backslash), undefined);
  assert.equal(new QQStickerLibrary({directory: undefined}).items.length, 0);
  const bundled = new QQStickerLibrary({directory, localDirectory: os.tmpdir()});
  const bytes = fs.readFileSync(path.join(directory, item.file));
  assert.throws(() => bundled.importImage(bytes, {title: '重复的内置图', emotion: 'joy', context: '', source: '', author: '', license: '', publicSharing: false}));
});

test('localImportPersistsMetadataAndRejectsDuplicatesAndUnsafeFiles', () => {
  const folder = temporary();
  try {
    const library = new QQStickerLibrary({directory: undefined, localDirectory: folder});
    const bytes = fs.readFileSync(path.join(directory, 'neutral.png'));
    assert.throws(() => library.importImage(Buffer.from('not an image'), {title: '测试', emotion: 'joy', context: '轻松庆祝', source: '', author: '', license: '', publicSharing: false}));
    assert.throws(() => library.importImage(bytes, {title: '测试', emotion: 'joy', context: '', source: 'file:///secret', author: '', license: '', publicSharing: false}));
    assert.throws(() => library.importImage(bytes, {title: '测试', emotion: 'joy', context: '', source: '', author: '', license: '', publicSharing: true}));
    library.importImage(bytes, {title: '测试招呼', emotion: 'neutral', context: '普通问候', source: '', author: '', license: '', publicSharing: false});
    const item = library.items[0];
    assert.ok(item);
    assert.ok(library.data(item) !== undefined);
    assert.equal(item.publicSharing, false);
    assert.throws(() => library.importImage(bytes, {title: '换个文件名仍是同图', emotion: 'joy', context: '', source: '', author: '', license: '', publicSharing: false}));
    const restored = new QQStickerLibrary({directory: undefined, localDirectory: folder});
    assert.equal(restored.items.length, 1);
    assert.equal(restored.items[0]?.context, '普通问候');
    assert.ok(fs.statSync(path.join(folder, 'manifest.json')).isFile());
    const use = [new QQStickerLibrary.Use({sha256: item.sha256, at: new Date()})];
    assert.equal(restored.available({recent: use, now: later(new Date(), 7201), repeatHours: 1}).length, 1);
    assert.equal(restored.available({recent: use, now: later(new Date(), 7201), repeatHours: 24}).length, 0);
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('adminsCanKeepAChatPictureAsASticker', () => {
  assert.equal(QQStickerLibrary.saveToolArguments('{"title":"  ","emotion":"joy"}'), undefined);
  assert.equal(QQStickerLibrary.saveToolArguments('{"title":"开心","emotion":"joy"}')?.context, '开心');
});

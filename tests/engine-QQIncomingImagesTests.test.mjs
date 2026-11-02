// Port of upstream/Tests/QQEngineTests/QQIncomingImagesTests.swift (the Linux fixture; the ImageIO pixel-size checks
// are macOS-only in the original too).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {QQIncomingImages} from '../engine/QQIncomingImages.mjs';
import {QQStickerLibrary} from '../engine/QQStickerLibrary.mjs';

const root = path.resolve(import.meta.dirname, '..', 'upstream');
const animatedFixture = () => {
  const images = JSON.parse(fs.readFileSync(path.join(root, 'Tests', 'QQEngineTests', 'synthetic-images.json'), 'utf8'));
  return Buffer.from(images.animated, 'base64');
};

test('animatedFramesCoverMotionAndRespectSharedBudget', async () => {
  const gif = animatedFixture();
  const frames = await QQIncomingImages.frames(gif);
  assert.ok(frames.length >= 4 && frames.length <= 6);
  assert.notDeepEqual(frames[0], frames.at(-1));
  assert.equal((await QQIncomingImages.frames(gif, 2)).length, 2);
  assert.equal((await QQIncomingImages.frames(gif, 1)).length, 1);
  const still = frames[0];
  assert.equal((await QQIncomingImages.frames(still)).length, 1);
});

test('restrictsSourceAndDecodesToBoundedJPEG', async () => {
  for (const url of ['file:///secret', 'https://127.0.0.1/x', 'https://multimedia.nt.qq.com.cn.evil.org/a', 'https://x:y@gchat.qpic.cn/a', 'https://gchat.qpic.cn:123/a']) {
    assert.equal(QQIncomingImages.allowedURL(url), undefined, url);
  }
  assert.equal(QQIncomingImages.allowedURL('http://gchat.qpic.cn/a')?.scheme, 'https');
  await assert.rejects(QQIncomingImages.frames(Buffer.from('invalid')));
  const library = new QQStickerLibrary({directory: path.join(root, 'Resources', 'QQStickers')});
  const data = await library.data(library.items[0]);
  assert.ok(data);
  const frames = await QQIncomingImages.frames(data);
  assert.ok(frames.length >= 1 && frames.length <= 3);
  for (const frame of frames) {
    assert.deepEqual([...frame.subarray(0, 2)], [255, 216]);
    assert.ok(frame.length <= 2_000_000);
  }
});

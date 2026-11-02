// Port of upstream/Tests/QQEngineTests/QQArtworkSuggestiveTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import {QQArtworkLibrary} from '../engine/QQArtworkLibrary.mjs';

test('borderlineWorksAreSkippedInEveryMode', () => {
  for (const tags of [['オリジナル', '水着'], ['女の子', 'R-15'], ['swimsuit'], ['原神', '巨乳'], ['涩图合集'], ['夏日福利']]) {
    assert.ok(QQArtworkLibrary.suggestive(tags), JSON.stringify(tags));
  }
  for (const tags of [['オリジナル', '女の子', '風景'], ['初音ミク', 'VOCALOID'], ['猫', 'ねこ'], []]) {
    assert.ok(!QQArtworkLibrary.suggestive(tags), JSON.stringify(tags));
  }
});

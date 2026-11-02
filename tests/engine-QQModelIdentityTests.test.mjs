import test from 'node:test';
import assert from 'node:assert/strict';
import {QQModelIdentity} from '../engine/core/QQModelIdentity.mjs';

test('recognizesPublicModelQuestions', () => {
  for (const value of ['/model', '你用的什么模型？', '你的具体模型是什么', '大肥鱼，你底层是什么模型', 'what model are you using?']) {
    assert.ok(QQModelIdentity.isQuestion(value), value);
  }
  for (const value of ['你推荐什么模型？', '对比两个模型', '今天吃什么', '我在训练模型']) {
    assert.ok(!QQModelIdentity.isQuestion(value), value);
  }
});

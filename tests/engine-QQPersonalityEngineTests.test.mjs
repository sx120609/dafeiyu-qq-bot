// Port of the engine suite in upstream/Tests/QQEngineTests/QQPersonalityTests.swift (QQPersonalityEngineTests).
// Named after the suite: BotCore's QQPersonalityTests.swift becomes tests/engine-QQPersonalityTests.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempDirectory, removeDirectory, same} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {QQTarget} from '../engine/core/QQPolicy.mjs';
import {QQMemoryBook, QQMemoryEvent} from '../engine/core/QQMemoryBook.mjs';

test('panelPersistenceKeepsMemoryAndRollsBackStaleWrites', () => {
  const directory = tempDirectory();
  try {
    const seed = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    seed.config.expectedSelfID = '12345';
    seed.config.targets = [new QQTarget({number: '54321', name: 'peer', group: false}), new QQTarget({number: '99999', name: 'group', group: true})];
    seed.save();
    const file = path.join(directory, 'qq-state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const book = new QQMemoryBook();
    book.append(new QQMemoryEvent({id: '1', subject: 'PEER', text: 'synthetic preference blue', at: new Date()}));
    raw.memoryBooks = JSON.parse(JSON.stringify({'12345:private:54321': book}));
    fs.writeFileSync(file, JSON.stringify(raw));
    const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    engine.setPersonaStyle('gentle', 'private:54321');
    assert.equal(engine.error, undefined); assert.ok(same(engine.memoryBooks['12345:private:54321'], book));
    const restored = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    assert.equal(restored.config.personaFor('private:54321').effectiveStyle, 'gentle');
    assert.ok(same(restored.memoryBooks['12345:private:54321'], book));
    engine.setPersonaStyle('invalid', 'group:99999');
    assert.notEqual(engine.error, undefined); assert.equal(engine.config.personaFor('group:99999').effectiveStyle, 'teasing');
    engine.setPersonaStyle('calm', 'group:77777');
    assert.notEqual(engine.error, undefined); assert.equal(engine.config.targets.length, 2);
    // A second legitimate panel changes the file; this stale panel must not override it.
    restored.setPersonaStyle('butler', 'group:99999');
    engine.setPersonaStyle('calm', 'private:54321');
    assert.notEqual(engine.error, undefined); assert.equal(engine.config.personaFor('private:54321').effectiveStyle, 'gentle');
    const latest = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
    assert.equal(latest.config.personaFor('group:99999').effectiveStyle, 'butler');
    assert.ok(same(latest.memoryBooks['12345:private:54321'], book));
  } finally { removeDirectory(directory); }
});

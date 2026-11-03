// Hot reload (engine/HotReload.mjs): new code without restarting the process, live objects keep their state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {HotReload} from '../engine/HotReload.mjs';

test('a new generation runs new code, live objects move onto it with their state, fixed modules stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-reload-'));
  try {
    const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
    write('shape.mjs', "export class Shape { static made = 0; static limit = 3; constructor() { this.sides = 3; Shape.made++; } describe() { return 'old ' + this.sides; } }\n");
    write('box.mjs', "import {Shape} from './shape.mjs';\nexport class Box { constructor() { this.items = new Map([['a', new Shape()]]); } first() { return this.items.get('a'); } }\n");
    write('fixed.mjs', 'export const born = Math.random();\n');
    write('uses-fixed.mjs', "export {born} from './fixed.mjs';\n");
    const hot = new HotReload({dirs: [dir], fixed: [path.join(dir, 'fixed.mjs')]});
    const {Box} = await import(pathToFileURL(path.join(dir, 'box.mjs')).href);
    const {born} = await import(pathToFileURL(path.join(dir, 'uses-fixed.mjs')).href);
    await hot.snapshot(0);
    const box = new Box();
    const shape = box.first();
    assert.equal(shape.describe(), 'old 3');
    shape.sides = 5; // state set while running
    const {Shape: OldShape} = await import(pathToFileURL(path.join(dir, 'shape.mjs')).href);

    write('shape.mjs', "export class Shape { static made = 0; static limit = 9; constructor() { this.sides = 3; Shape.made++; } describe() { return 'new ' + this.sides; } }\n");
    const [fresh, freshFixed] = await hot.next([path.join(dir, 'box.mjs'), path.join(dir, 'uses-fixed.mjs')]);
    assert.equal(freshFixed.born, born, 'a fixed module is shared by every generation');
    assert.equal(new fresh.Box().first().describe(), 'new 3', 'the new generation runs the new code');
    assert.equal(shape.describe(), 'old 5', 'nothing changes until adopt');

    const map = await hot.classes(0, hot.generation);
    assert.ok(HotReload.adopt([box], map) >= 2);
    assert.equal(box.first().describe(), 'new 5', 'the live object runs new code and keeps its state');
    const {Shape: NewShape} = await import(pathToFileURL(path.join(dir, 'shape.mjs')).href + '?hot=' + hot.generation);
    assert.ok(box.first() instanceof NewShape);
    assert.equal(NewShape.made, 1, 'static data changed while running is carried over');
    assert.equal(NewShape.limit, 9, 'static data the code defines is the new code\'s');
    assert.equal(OldShape.made, 1);

    // A broken file fails the import and changes nothing.
    write('shape.mjs', 'export class Shape { describe( { }\n');
    await assert.rejects(hot.next([path.join(dir, 'box.mjs')]));
    assert.equal(box.first().describe(), 'new 5');
    assert.equal(hot.generation, 1);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

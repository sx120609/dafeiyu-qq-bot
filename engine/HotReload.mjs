// Hot reload (11-03: "插件 工具等绝大部分服务都要做成热加载…不一定非要重启整个系统"). A new generation of a
// directory's modules is imported beside the running one: a resolve hook gives every module of that generation its
// own URL (?hot=N), and a module resolves its imports in its importer's generation, so old code keeps running on old
// modules while new requests use the new ones. Fixed files (the ones holding processes, sockets or sessions) are
// loaded once and shared by every generation.
//
// adopt() moves live objects onto the new code: every object reachable from the roots whose class is one of the old
// generation's gets the same class of the new generation as its prototype, so its state stays and its methods (and
// instanceof) are the new ones. Static data set while running (a key, a counter) is carried over; static data the
// code itself defines (a tool definition, a limit) is the new code's.
import module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const base = url => url.split('?')[0];
const generationOf = url => { try { return Number(new URL(url).searchParams.get('hot') ?? 0) || 0; } catch { return 0; } };

export class HotReload {
  /** dirs: the directories whose modules are reloaded; fixed: files inside them loaded once; scripts: files run as
   *  their own processes (never imported here, and new code each time they start anyway). */
  constructor({dirs, fixed = [], scripts = []}) {
    this.dirs = dirs.map(dir => pathToFileURL(path.resolve(dir) + path.sep).href);
    this.fixed = new Set(fixed.map(file => pathToFileURL(path.resolve(file)).href));
    this.scripts = new Set(scripts.map(file => pathToFileURL(path.resolve(file)).href));
    this.generation = 0;
    /** generation → the module URLs (without the query) it loaded */
    this.loaded = new Map([[0, new Set()]]);
    /** class → its static data values right after its generation loaded */
    this.initial = new Map();
    module.registerHooks({resolve: (specifier, context, next) => {
      const result = next(specifier, context);
      const url = base(result.url);
      if (!url.startsWith('file:') || !this.dirs.some(dir => url.startsWith(dir)) || this.fixed.has(url)) return result;
      // A generation's entry carries its number; everything else is in its importer's generation.
      const generation = generationOf(result.url) || (context.parentURL ? generationOf(context.parentURL) : 0);
      this.loaded.get(generation)?.add(url);
      return {...result, url: generation ? `${url}?hot=${generation}` : url};
    }});
  }
  owns(file) { const url = pathToFileURL(path.resolve(file)).href; return this.dirs.some(dir => url.startsWith(dir)) && !this.fixed.has(url) && !this.scripts.has(url); }

  /** Imports the given files in a new generation (a syntax error throws here, before anything changes). */
  async next(files) {
    const generation = this.generation + 1;
    this.loaded.set(generation, new Set());
    try {
      const modules = [];
      for (const file of files) {
        const url = pathToFileURL(path.resolve(file)).href;
        this.loaded.get(generation).add(url);
        modules.push(await import(this.fixed.has(url) ? url : `${url}?hot=${generation}`));
      }
      this.generation = generation;
      await this.snapshot(generation);
      return modules;
    } catch (error) { this.loaded.delete(generation); throw error; }
  }
  /** Every module file under the reloaded directories, for importing a whole generation at once. */
  files() {
    const found = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'resources'].includes(entry.name)) walk(file); }
      else if (entry.name.endsWith('.mjs') && this.owns(file)) found.push(file);
    } };
    for (const dir of this.dirs) walk(new URL(dir).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return found;
  }

  /** The module namespaces a generation loaded, by URL. */
  async namespaces(generation) {
    const result = new Map();
    for (const url of this.loaded.get(generation) ?? []) {
      try { result.set(url, await import(this.fixed.has(url) || !generation ? url : `${url}?hot=${generation}`)); } catch {}
    }
    return result;
  }
  /** Records the classes' static data as loaded; call it once for generation 0 after start-up. */
  async snapshot(generation = 0) {
    for (const namespace of (await this.namespaces(generation)).values()) for (const value of Object.values(namespace)) {
      if (typeof value !== 'function' || !value.prototype || this.initial.has(value)) continue;
      this.initial.set(value, new Map(Object.getOwnPropertyNames(value).map(key => [key, Object.getOwnPropertyDescriptor(value, key)?.value])));
    }
  }
  /** Old prototype → new prototype for every exported class two generations share. */
  async classes(from, to) {
    const before = await this.namespaces(from), after = await this.namespaces(to), map = new Map();
    for (const [url, old] of before) {
      const fresh = after.get(url);
      if (!fresh || old === fresh) continue;
      for (const [name, value] of Object.entries(old)) {
        const replacement = fresh[name];
        if (typeof value !== 'function' || typeof replacement !== 'function' || !value.prototype || !replacement.prototype || value === replacement) continue;
        map.set(value.prototype, replacement.prototype);
        // Static data changed while running goes with the class; what the code defines, and functions, are the new ones.
        const initial = this.initial.get(value);
        for (const key of Object.getOwnPropertyNames(value)) {
          if (['length', 'name', 'prototype'].includes(key) || !initial?.has(key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !('value' in descriptor) || typeof descriptor.value === 'function' || !descriptor.writable) continue;
          if (descriptor.value === initial.get(key)) continue;
          try { replacement[key] = descriptor.value; } catch {}
        }
      }
    }
    return map;
  }
  /** Moves every object reachable from the roots onto the new classes. Returns how many objects changed. */
  static adopt(roots, map) {
    const seen = new WeakSet(), stack = [...roots];
    const ours = new Set([...map.keys(), ...map.values()]);
    const walkable = value => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return false;
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
      const proto = Object.getPrototypeOf(value);
      if (proto === null || proto === Object.prototype || Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
      // Instances of our classes (and their subclasses); other classes (sockets, processes, dates) are left alone.
      for (let p = proto; p; p = Object.getPrototypeOf(p)) if (ours.has(p)) return true;
      return false;
    };
    let moved = 0;
    while (stack.length) {
      const value = stack.pop();
      if (!walkable(value)) continue;
      seen.add(value);
      const proto = Object.getPrototypeOf(value);
      if (map.has(proto)) { Object.setPrototypeOf(value, map.get(proto)); moved++; }
      if (value instanceof Map) for (const [key, item] of value) { stack.push(key, item); }
      else if (value instanceof Set) for (const item of value) stack.push(item);
      else for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor) stack.push(descriptor.value);
      }
    }
    return moved;
  }
}

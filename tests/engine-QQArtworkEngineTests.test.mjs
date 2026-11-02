// The Pixiv tool (engine/QQArtworkLibrary.mjs, rewritten 11-03): the whole site, only R-18/R-18G and political works
// skipped. A fake Pixiv answers every endpoint; nothing here reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {QQArtworkLibrary} from '../engine/QQArtworkLibrary.mjs';
import {QQArtworkConfig, QQArtworkLedger, QQArtworkRequest} from '../engine/core/QQArtwork.mjs';

const photo = (() => {
  const file = path.resolve(import.meta.dirname, '..', 'upstream', 'Tests', 'QQEngineTests', 'synthetic-images.json');
  return Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).artwork, 'base64');
})();
const request = (mode, query = '', prompt) => new QQArtworkRequest({mode, query, prompt});

// Works: 1 male character, 2 AI, 3 a small manga page set, 4 R-18, 5 political, 6 swimsuit, 7 R-18G.
const works = {
  1: {title: '少年と夕日', tags: ['男の子', 'オリジナル'], width: 600, height: 400},
  2: {title: 'AI 風景', tags: ['風景'], aiType: 2},
  3: {title: '四コマ', tags: ['漫画'], illustType: 1, pageCount: 3},
  4: {title: 'R18 作品', tags: ['R-18'], xRestrict: 1},
  5: {title: '政治漫画', tags: ['習近平', '風刺']},
  6: {title: '夏の海', tags: ['水着', '女の子']},
  7: {title: 'R18G', tags: ['R-18G'], xRestrict: 2}
};
function pixiv() {
  const calls = [];
  const session = async raw => {
    const u = new URL(raw);
    calls.push(u.pathname + u.search);
    let object = {}, data;
    const id = u.pathname.match(/\/ajax\/illust\/(\d+)/)?.[1];
    if (u.pathname.startsWith('/ajax/search/artworks/')) {
      assert.equal(u.searchParams.get('mode'), 'safe');
      const rows = [6, 1, 4, 5, 2, 3].map(n => ({id: String(n), xRestrict: works[n].xRestrict ?? 0}));
      object = {error: false, body: {illustManga: {data: rows, lastPage: 1}, popular: {permanent: [], recent: []}}};
    } else if (u.pathname === '/ranking.php') {
      object = {date: '20261103', mode: u.searchParams.get('mode'), contents: [5, 1, 2].map((n, i) => ({illust_id: n, rank: i + 1, title: works[n].title, tags: works[n].tags}))};
    } else if (u.pathname.endsWith('/profile/all')) {
      object = {error: false, body: {illusts: {1: null, 2: null}, manga: {3: null}}};
    } else if (u.pathname.endsWith('/recommend/init')) {
      object = {error: false, body: {illusts: [{id: '6'}, {id: '2'}]}};
    } else if (u.pathname.endsWith('/pages')) {
      object = {error: false, body: [1, 2, 3].map(p => ({urls: {original: `https://i.pximg.net/img-original/${id}_p${p - 1}.jpg`}}))};
    } else if (id) {
      const w = works[id];
      object = !w ? {error: true, body: {}} : {error: false, body: {id, illustTitle: w.title, userName: '画师' + id, userId: '9' + id, xRestrict: w.xRestrict ?? 0,
        aiType: w.aiType ?? 1, illustType: w.illustType ?? 0, pageCount: w.pageCount ?? 1, width: w.width ?? 1600, height: w.height ?? 900,
        bookmarkCount: 10, likeCount: 5, viewCount: 100, tags: {tags: w.tags.map(tag => ({tag}))},
        urls: {original: `https://i.pximg.net/img-original/${id}_p0.jpg`, regular: `https://i.pximg.net/img-master/${id}_p0.jpg`}}};
    } else if (u.host === 'i.pximg.net') data = photo;
    else return new Response('', {status: 404});
    return new Response(data ?? JSON.stringify(object), {status: 200});
  };
  return {library: new QQArtworkLibrary({session, spacing: 0}), calls};
}
const config = (changes = {}) => Object.assign(new QQArtworkConfig(), {enabled: true}, changes);
const options = (ledger = new QQArtworkLedger()) => ({config: config(), scope: 'bot:group:1', ledger});

test('a search reaches the whole site: male characters, AI works, small pictures, swimsuits; R-18 and political works are skipped', async () => {
  const {library} = pixiv();
  const first = await library.prepare(request('search', '任何'), options());
  assert.ok(first.image, first.caption);
  assert.match(first.caption, /《夏の海》/, 'a swimsuit picture is fine');
  const listed = first.caption.split('其他候选')[1] ?? '';
  for (const id of ['1', '2', '3']) assert.match(listed, new RegExp(`^${id}《`, 'm'), `work ${id} is offered`);
  assert.doesNotMatch(first.caption, /R18 作品|政治漫画/);
  assert.match(listed, /3《四コマ》.*3 页/);
});

test('rankings: any list, filtered by words, first rank first, political works skipped', async () => {
  const {library, calls} = pixiv();
  const weekly = await library.prepare(request('hot', '', 'weekly'), options());
  assert.ok(calls.some(call => call.includes('mode=weekly')));
  assert.match(weekly.caption, /周榜[\s\S]*《少年と夕日》[\s\S]*第 2 名/);
  const filtered = await library.prepare(request('hot', '風景'), options());
  assert.match(filtered.caption, /日榜（筛选：風景）[\s\S]*《AI 風景》[\s\S]*AI 作品/);
});

test('a work by id, any page of it; R-18, R-18G and political ids are refused plainly', async () => {
  const {library} = pixiv();
  const page = await library.prepare(request('id', '3 p2'), options());
  assert.ok(page.image); assert.match(page.caption, /第 2\/3 页/);
  for (const id of ['4', '5', '7']) assert.match((await library.prepare(request('id', id), options())).caption, /R-18 \/ 涉政/);
  assert.match((await library.prepare(request('id', 'https://www.pixiv.net/artworks/1'), options())).caption, /《少年と夕日》/);
});

test('an artist\'s works and works related to one', async () => {
  const {library} = pixiv();
  const artist = await library.prepare(request('artist', 'https://www.pixiv.net/users/91'), options());
  assert.match(artist.caption, /画师 91 的作品[\s\S]*《四コマ》/, 'newest first');
  const related = await library.prepare(request('related', '1'), options());
  assert.match(related.caption, /和作品 1 相似的[\s\S]*《夏の海》/);
});

test('next continues the last request without repeating what this chat already got', async () => {
  const {library} = pixiv();
  const ledger = new QQArtworkLedger();
  const first = await library.prepare(request('search', '任何'), options(ledger));
  ledger.reserve('t1', 'bot:group:1', first.id, first.hash, first.request);
  const next = await library.prepare(request('next'), options(ledger));
  assert.ok(next.image); assert.notEqual(next.id, first.id);
});

test('the agent\'s arguments become requests; rankings default to daily', () => {
  assert.deepEqual({...QQArtworkLibrary.toolRequest('{"mode":"ranking"}')}, {mode: 'hot', query: '', prompt: 'daily'});
  assert.deepEqual({...QQArtworkLibrary.toolRequest('{"mode":"ranking","ranking":"male","query":"原神"}')}, {mode: 'hot', query: '原神', prompt: 'male'});
  assert.equal(QQArtworkLibrary.toolRequest('{"mode":"search"}'), undefined);
  assert.equal(QQArtworkLibrary.toolRequest('{"mode":"draw","query":"x"}'), undefined);
  assert.equal(QQArtworkLibrary.political(['習近平']), true);
  assert.equal(QQArtworkLibrary.political(['水着', 'メイド', 'AI']), false);
});

test('old saved featured requests become the daily ranking or a search', async () => {
  const {library, calls} = pixiv();
  await library.prepare(request('featured'), options());
  assert.ok(calls.some(call => call.startsWith('/ranking.php?mode=daily')));
  await library.prepare(request('featured', '女の子'), options());
  assert.ok(calls.some(call => call.startsWith('/ajax/search/artworks/')));
});

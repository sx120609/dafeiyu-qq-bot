// Port of upstream/Tests/QQEngineTests/QQArtworkTests.swift, named ...EngineTests because BotCoreTests has a
// QQArtworkTests.swift too (that one is tests/engine-QQArtworkTests.test.mjs). The URLProtocol fixture is an injected fetch; checks made
// inside it are collected and asserted after each test. artistManagementPersistsListsAndResolvesNamesWithoutModelCalls
// drives QQEngine and lives with its tests. The live probes run only when their environment switch is set, as in Swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {uuid} from '../engine/swift.mjs';
import {CancellationError, URLError} from '../engine/BoundedDownload.mjs';
import {QQArtworkLibrary} from '../engine/QQArtworkLibrary.mjs';
import {QQArtworkConfig, QQArtworkLedger, QQArtworkRequest} from '../engine/core/QQArtwork.mjs';

const photo = (() => {
  const file = path.resolve(import.meta.dirname, '..', 'upstream', 'Tests', 'QQEngineTests', 'synthetic-images.json');
  return Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).artwork, 'base64');
})();
const request = (mode, query, prompt) => new QQArtworkRequest({mode, query, prompt});
const sameRequest = (a, b) => a.mode === b.mode && a.query === b.query && (a.prompt ?? undefined) === (b.prompt ?? undefined);

function client() {
  const state = {calls: [], problems: [], holdImage: false, badImage: false, originalStatus: 200, paginated: false,
    longPortfolio: false, qualityPopular: false, deepSearch: false};
  const expect = (condition, message) => { if (!condition) state.problems.push(message); };
  const session = async (raw, init = {}) => {
    const u = new URL(raw);
    state.calls.push(raw);
    const headers = new Headers(init.headers);
    if (u.host === 'i.pximg.net' && state.holdImage) return new Promise(() => {});
    let object = {}, data, code = 200;
    const params = u.searchParams;
    const lastPathComponent = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? '');
    if (u.host === 'api.deepseek.com') {
      state.problems.push('Unexpected model call');
    } else if (u.pathname === '/ranking.php') {
      object = {date: '20260927', contents: [101, 105, 106, 107].map((id, index) => ({illust_id: id, title: '测试插画', rank: index + 1,
        user_id: id === 101 ? 17429 : id === 107 ? 27517 : 688570, tags: ['女の子', 'オリジナル'], illust_content_type: {sexual: 0, lo: false, grotesque: false}}))};
      if (state.paginated) {
        const second = params.get('p') === '2';
        object.next = second ? false : 2;
        if (second) object.contents = [{illust_id: 108, title: '原神 白发猫耳', rank: 51, user_id: 999888, tags: ['女の子', '原神', '白髪', '猫耳'], illust_content_type: {sexual: 0, lo: false, grotesque: false}}];
      }
      object.contents = [...object.contents].reverse();
    } else if (u.pathname.includes('/illusts/tag') || u.pathname.startsWith('/ajax/search/illustrations/')) {
      const search = u.pathname.startsWith('/ajax/search/illustrations/');
      const word = params.get(search ? 'word' : 'tag') ?? '';
      const offset = Number(params.get('offset') ?? '0') || 0;
      let ids = search ? (word === '初音ミク' ? [53325959] : [300, 301]) : u.pathname.includes('688570') ? [53325959] : u.pathname.includes('999111') ? [103] : [102, 101];
      if (word.includes('不存在') || (!search && word === '白髪')) ids = [];
      if (state.deepSearch && search) ids = Array.from({length: 20}, (_, i) => 300 + i);
      if (state.longPortfolio && !search) ids = offset === 0 ? Array.from({length: 30}, (_, i) => 230 - i) : [200];
      const rows = ids.map(id => ({id: String(id), title: '测试作品', userId: id === 103 ? '999111' : id >= 300 && id < 400 ? '999888' : id === 53325959 ? '688570' : '17429',
        userName: 'Fixture Artist', illustType: 0, xRestrict: 0, aiType: 1, isUnlisted: false, width: 1600, height: 900, tags: ['女の子', 'オリジナル']}));
      if (search) {
        const body = {illust: {data: rows, total: rows.length, lastPage: 1}};
        if (state.qualityPopular && rows[0]) {
          const recommendations = [302, 303, 304, 300].map(id => ({...rows[0], id: String(id), tags: ['原神100000users入り']}));
          body.popular = {permanent: recommendations, recent: recommendations};
        }
        object = {error: false, body};
        expect(params.get('mode') === 'safe', 'mode=safe');
        expect(params.get('ai_type') === '1', 'ai_type=1');
      } else {
        object = {error: false, body: {works: rows, total: state.longPortfolio ? 31 : rows.length}};
      }
    } else if (u.pathname.startsWith('/ajax/illust/')) {
      const id = lastPathComponent;
      const body = {id, illustTitle: `风景 ${id}`, userName: 'Fixture Artist',
        userId: id === '103' ? '999111' : QQArtworkLibrary.featuredIDs.includes(id) || ['105', '106'].includes(id) ? '688570' : '17429',
        xRestrict: 0, aiType: 1, illustType: 0, isUnlisted: false, width: 1600, height: 900,
        urls: {original: `https://i.pximg.net/img-original/${id}.jpg`, regular: `https://i.pximg.net/img-master/${id}.jpg`},
        tags: {tags: [{tag: '女の子'}, {tag: 'オリジナル'}]}};
      object = {error: false, body};
      if (id === '108') { body.userId = '999888'; body.tags = {tags: ['女の子', '原神', '白髪', '猫耳'].map(tag => ({tag}))}; }
      if (['101', '300', '301'].includes(id)) {
        body.tags = {tags: [{tag: '男性'}, {tag: '風景'}]};
        if (id === '101') { body.width = 900; body.height = 600; }
        if (id !== '101') body.userId = '999888';
      }
      const counts = {300: 2500, 301: 3500, 303: 999, 304: 1000, 319: 5000};
      if (counts[id] !== undefined) { body.bookmarkCount = counts[id]; body.likeCount = 800; body.viewCount = 10000; }
      if (id === '404') object = {error: true, body: {}};
      if (id === '666') body.xRestrict = 1;
      if (state.longPortfolio && Number(id) > 200) body.xRestrict = 1;
    } else if (u.pathname.startsWith('/ajax/user/')) {
      object = {error: u.pathname.includes('999112'), body: {userId: lastPathComponent, name: '新增画师', comment: u.pathname.includes('688570')
        ? '商業目的ではない場合、2次加工が可能です。ソースくらいは残してください！' : u.pathname.includes('999111') ? 'Noncommercial sharing with credit allowed.' : 'Reprint is prohibited.'}};
    } else if (u.host === 'i.pximg.net') {
      expect(headers.get('Referer') === 'https://www.pixiv.net/', 'Referer');
      expect(headers.get('Cookie') === null, 'no Cookie');
      const original = u.pathname.startsWith('/img-original/');
      const status = state.originalStatus;
      if (status === -6 || (original && [-3, -4, -5].includes(status))) {
        throw new URLError([-3, -6].includes(status) ? URLError.networkConnectionLost : status === -4 ? URLError.timedOut : URLError.cancelled);
      }
      code = original && status > 0 ? status : 200;
      data = original && status === -2 ? Buffer.alloc(20_000_001) : state.badImage || (original && status === -1) ? Buffer.from('not an image') : photo;
    } else { code = 500; state.problems.push('Unexpected artwork endpoint ' + raw); }
    return new Response(data ?? JSON.stringify(object), {status: code});
  };
  const library = new QQArtworkLibrary({session, spacing: 0});
  return {library, state};
}
const enabled = (changes = {}) => Object.assign(new QQArtworkConfig(), {enabled: true}, changes);

test('sourceSearchSelectsReturnedResultsWithoutScanningArtists', async () => {
  const {library, state} = client();
  const config = enabled({pixivArtistIDs: []});
  const ledger = new QQArtworkLedger();
  let count = 0;
  assert.equal(QQArtworkLibrary.searchQuery('初音未来 白发 不要黑丝'), '初音ミク 白髪 -黒タイツ');
  const first = await library.prepare(request('featured', '白发 猫耳'), {config, scope: 'A', ledger, beforeFetch: () => { count += 1; }});
  assert.equal(first.id, 'pixiv:300'); assert.ok(first.image !== undefined); assert.equal(count, 3);
  // Fixture details intentionally lack these keywords and contain a male/landscape subject.
  assert.ok(state.calls.some(call => call.includes('/ajax/search/illustrations/')));
  assert.equal(state.calls.filter(call => call.includes('/ajax/illust/')).length, 1);
  assert.ok(!state.calls.some(call => call.includes('/ajax/user/') || call.includes('ranking.php')));
  ledger.reserve(uuid(), 'A', first.id, undefined, first.request);
  const next = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => { count += 1; }});
  assert.equal(next.id, 'pixiv:301'); assert.equal(count, 5); // Cached result page, only next detail + image.
  assert.equal(next.request.query, '白发 猫耳');
  assert.equal(QQArtworkLibrary.allowedURL('https://www.pixiv.net.evil.org/ajax/search/illustrations/a'), undefined);
  assert.deepEqual(state.problems, []);
});

test('qualitySearchVerifiesCountsBeforeDownloadingAndContinues', async () => {
  const {library, state} = client();
  state.qualityPopular = true;
  const config = enabled({pixivArtistIDs: []});
  const ledger = new QQArtworkLedger();
  const result = await library.prepare(request('search', '原神'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(result.id, 'pixiv:304'); assert.ok(result.image !== undefined);
  assert.ok(result.caption.includes('收藏 1000 · 点赞 800 · 浏览 10000'));
  assert.ok(!state.calls.some(call => call.includes('ranking.php') || call.includes('/ajax/user/')));
  assert.equal(state.calls.filter(call => call.includes('pximg.net')).length, 1);
  assert.equal(state.calls.filter(call => call.includes('/ajax/illust/')).length, 3); // Missing count and exaggerated user tag cannot qualify.
  ledger.reserve(uuid(), 'A', result.id, undefined, result.request);
  const next = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(next.id, 'pixiv:300'); assert.ok(sameRequest(next.request, result.request));
  const other = await library.prepare(request('search', '原神'), {config, scope: 'B', ledger, beforeFetch: () => {}});
  assert.equal(other.id, 'pixiv:304');
  config.effectiveSearchMinBookmarks = 5000;
  const empty = await library.prepare(result.request, {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.ok(empty.id === 'pixiv:301' && empty.image !== undefined); assert.ok(empty.caption.includes('保底结果')); assert.ok(empty.caption.includes('收藏 ≥ 5000'));
  config.effectiveSearchMinBookmarks = 3000;
  const lower = await library.prepare(result.request, {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(lower.id, 'pixiv:301'); // Threshold changes must invalidate rejection decisions.
  assert.equal(QQArtworkLibrary.toolRequest('{"mode":"search","query":"原神"}')?.mode, 'search');
  assert.deepEqual(state.problems, []);
});

test('qualitySearchBudgetContinuesWithoutRepeatingRejectedDetails', async () => {
  const {library, state} = client();
  state.deepSearch = true;
  const config = enabled({searchMinBookmarks: 4000});
  const ledger = new QQArtworkLedger();
  const first = await library.prepare(request('search', '原神'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.ok(first.id === 'pixiv:301' && first.image !== undefined); assert.ok(first.caption.includes('保底结果')); assert.ok(first.caption.includes('4000'));
  assert.equal(state.calls.filter(call => call.includes('/ajax/illust/')).length, 12);
  assert.equal(state.calls.filter(call => call.includes('pximg.net')).length, 1);
  // Once this bounded candidate window has been delivered, /next reaches later results.
  for (let id = 300; id <= 311; id++) ledger.reserve(uuid(), 'A', `pixiv:${id}`, undefined, first.request);
  ledger.continuation.A = first.request;
  const next = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(next.id, 'pixiv:319');
  const details = state.calls.filter(call => call.includes('/ajax/illust/'));
  assert.equal(details.length, 20); assert.equal(new Set(details).size, 20);
  assert.deepEqual(state.problems, []);
});

test('idLookupAndContinuationDoNotSearchOrChangeTheRequestedWork', async () => {
  const {library, state} = client();
  const config = enabled({searchMinBookmarks: 1_000_000});
  const ledger = new QQArtworkLedger();
  const result = await library.prepare(request('id', '300'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.ok(result.id === 'pixiv:300' && result.image !== undefined);
  assert.equal(state.calls.length, 2);
  for (const id of ['404', '666', '101']) {
    const unavailable = await library.prepare(request('id', id), {config, scope: 'A', ledger, beforeFetch: () => {}});
    assert.ok(unavailable.image === undefined && unavailable.request.query === id);
  }
  assert.equal(state.calls.filter(call => call.includes('pximg.net')).length, 1);
  ledger.reserve(uuid(), 'A', result.id, undefined, result.request);
  const repeated = await library.prepare(result.request, {config, scope: 'A', ledger, beforeFetch: () => { state.problems.push('Duplicate ID must not fetch'); }});
  assert.ok(repeated.image === undefined && repeated.caption.includes('去重'));
  const next = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => { state.problems.push('ID continuation is a local hint'); }});
  assert.ok(next.image === undefined && next.caption.includes('没有可续看的列表'));
  const changed = await library.prepare(request('next', '原神'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.ok(sameRequest(changed.request, request('search', '原神'))); assert.equal(changed.id, 'pixiv:301');
  const other = await library.prepare(result.request, {config, scope: 'B', ledger, beforeFetch: () => {}});
  assert.ok(other.id === 'pixiv:300' && other.image !== undefined);
  assert.ok(sameRequest(QQArtworkLibrary.toolRequest('{"mode":"id","query":"https://www.pixiv.net/artworks/300"}'), result.request));
  assert.equal(QQArtworkLibrary.toolRequest('{"mode":"artist","query":"LAM"}'), undefined);
  assert.deepEqual(state.problems, []);
});

test('fallbackKeepsUnknownMetricsHonestAndDoesNotRelaxImageRequirements', async () => {
  const {library, state} = client();
  const config = enabled();
  const unknown = await library.prepare(request('search', '初音未来'), {config, scope: 'A', ledger: new QQArtworkLedger(), beforeFetch: () => {}});
  assert.ok(unknown.image !== undefined && unknown.caption.includes('来源未提供收藏数'));
  config.minLongEdge = 2000;
  const tooSmall = await library.prepare(request('search', '原神'), {config, scope: 'B', ledger: new QQArtworkLedger(), beforeFetch: () => {}});
  assert.equal(tooSmall.image, undefined);
  const none = await library.prepare(request('search', '不存在的角色'), {config, scope: 'C', ledger: new QQArtworkLedger(), beforeFetch: () => {}});
  assert.ok(none.image === undefined && none.request.query === '不存在的角色');
  assert.ok(!state.calls.some(call => call.includes('/ajax/user/') || call.includes('ranking.php') || call.includes('deepseek')));
  assert.deepEqual(state.problems, []);
});

test('liveQualitySearchWhenExplicitlyRequested', {skip: process.env.QQ_QUALITY_SEARCH_PROBE !== '1'}, async () => {
  const config = enabled({pixivArtistIDs: []});
  let calls = 0;
  const budget = () => { calls += 1; if (calls > 18) throw new Error('Live probe budget exhausted'); };
  const start = Date.now();
  const result = await new QQArtworkLibrary().prepare(request('search', '原神'), {config, scope: 'probe', ledger: new QQArtworkLedger(), beforeFetch: budget});
  assert.ok(result.image !== undefined);
  assert.ok(result.caption.includes('收藏 ≥ 1000'));
  const id = result.id.replace('pixiv:', '');
  const beforeID = calls;
  const direct = await new QQArtworkLibrary().prepare(request('id', id), {config, scope: 'id-probe', ledger: new QQArtworkLedger(), beforeFetch: budget});
  assert.ok(direct.id === result.id && direct.image !== undefined);
  console.log(`DIRECT_ID_PROBE sourceRequests=${calls - beforeID} imageBytes=${direct.image?.length ?? 0} noQQ=true noModel=true`);
  console.log(`QUALITY_SEARCH_PROBE sourceRequests=${calls} seconds=${((Date.now() - start) / 1000).toFixed(2)} imageBytes=${result.image.length} threshold=1000 noQQ=true noModel=true`);
});

test('liveFastSearchAndFirstRankWhenExplicitlyRequested', {skip: process.env.QQ_FAST_ART_PROBE !== '1'}, async () => {
  const library = new QQArtworkLibrary();
  const config = enabled({pixivArtistIDs: []});
  const ledger = new QQArtworkLedger();
  let count = 0;
  for (const [index, item] of [request('hot'), request('next'), request('featured', '原神')].entries()) {
    const start = Date.now(), before = count;
    const result = await library.prepare(item, {config, scope: 'probe', ledger, beforeFetch: () => { count += 1; if (count > 15) throw new Error('Live probe budget exhausted'); }});
    assert.ok(result.image !== undefined); assert.ok(result.id !== undefined);
    if (index === 0) assert.ok(result.caption.includes('第 1 名'));
    if (index === 1) assert.ok(result.caption.includes('第 2 名'));
    if (index === 2) assert.ok(result.caption.includes('关键词搜索'));
    ledger.reserve(uuid(), 'probe', result.id, result.hash, result.request);
    console.log(`FAST_ART_PROBE step=${index} sourceRequests=${count - before} seconds=${((Date.now() - start) / 1000).toFixed(2)} imageBytes=${result.image.length} noQQ=true noModel=true`);
  }
});

test('nextSkipsAlreadyRejectedPortfolioCandidates', async () => {
  const {library, state} = client();
  state.longPortfolio = true;
  const config = enabled();
  const ledger = new QQArtworkLedger();
  const first = await library.prepare(request('artist', 'LAM'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(first.image, undefined); assert.ok(first.caption.includes('30 个候选'));
  ledger.continuation.A = first.request;
  const before = state.calls.length;
  const next = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(next.id, 'pixiv:200'); assert.ok(next.image !== undefined);
  assert.equal(state.calls.length - before, 2); // One new detail and one picture; no rescanning the rejected head.
  assert.deepEqual(state.problems, []);
});

test('nextContinuesPastFeaturedAndRankingWithoutChangingIntent', async () => {
  const {library, state} = client();
  const config = enabled({pixivArtistIDs: ['17429']});
  const ledger = new QQArtworkLedger();
  for (const id of QQArtworkLibrary.featuredIDs) ledger.reserve(uuid(), 'A', 'pixiv:' + id, undefined, request('featured'));
  const next = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.ok(['pixiv:101', 'pixiv:102'].includes(next.id ?? '')); assert.ok(next.image !== undefined);
  assert.ok(sameRequest(next.request, request('featured')));
  const unmatched = await library.prepare(request('next', '不存在的角色'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(unmatched.image, undefined); assert.equal(unmatched.request.query, '不存在的角色');
  state.paginated = true;
  for (const id of [101, 105, 106, 107]) ledger.reserve(uuid(), 'B', `pixiv:${id}`, undefined, request('hot'));
  // Ranking artist 999888 is not configured; it must still be available at rank 51.
  const ranked = await library.prepare(request('next'), {config, scope: 'B', ledger, beforeFetch: () => {}});
  assert.equal(ranked.id, 'pixiv:108'); assert.ok(ranked.image !== undefined); assert.equal(ranked.request.mode, 'hot');
  assert.ok(ranked.caption.includes('第 51 名')); assert.ok(ranked.caption.includes('作品 ID：108'));
  assert.ok(state.calls.some(call => call.includes('p=2&date=20260927')));
  assert.ok(!state.calls.some(call => call.includes('deepseek')));
  assert.deepEqual(state.problems, []);
});

test('promptsAreConjunctiveAndArtistContinuationStaysScoped', async () => {
  assert.ok(QQArtworkLibrary.matches('来一张白发猫耳的美少女', ['白髪', '猫耳', '女の子']));
  assert.ok(!QQArtworkLibrary.matches('白发 猫耳', ['黒髪', '猫耳']));
  assert.ok(QQArtworkLibrary.matches('白发 不要黑丝', ['白髪', 'メイド']));
  assert.ok(!QQArtworkLibrary.matches('白发 -黑丝', ['白髪', '黒タイツ']));
  assert.ok(QQArtworkLibrary.matches('初音未来', ['初音ミク']));
  assert.ok(!QQArtworkLibrary.matches('不存在的角色', ['女の子', '原神']));
  const {library, state} = client();
  const config = enabled();
  const ledger = new QQArtworkLedger();
  const first = await library.prepare(request('artist', 'LAM オリジナル'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(first.id, 'pixiv:102'); assert.equal(first.request.query, '17429'); assert.equal(first.request.prompt, 'オリジナル');
  ledger.reserve(uuid(), 'A', first.id, undefined, first.request);
  const blocked = await library.prepare(request('next', '白发'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(blocked.image, undefined); assert.equal(blocked.request.query, '17429'); assert.equal(blocked.request.prompt, '白发');
  assert.ok(!state.calls.some(call => call.includes('ranking.php') || call.includes('user/688570')));
  assert.deepEqual(state.problems, []);
});

test('hotNeverFallsBackToConfiguredPortfolios', async () => {
  const {library, state} = client();
  const config = enabled();
  const ledger = new QQArtworkLedger();
  for (const id of [101, 105, 106, 107]) ledger.reserve(uuid(), 'A', `pixiv:${id}`, undefined, request('hot'));
  const result = await library.prepare(request('next'), {config, scope: 'A', ledger, beforeFetch: () => {}});
  assert.equal(result.image, undefined); assert.ok(result.caption.includes('不限制画师'));
  assert.ok(!state.calls.some(call => call.includes('/ajax/user/') || call.includes('pximg.net')));
  assert.deepEqual(state.problems, []);
});

test('liveRankingContinuationWhenExplicitlyRequested', {skip: process.env.QQ_NEXT_ART_PROBE !== '1'}, async () => {
  const config = enabled({pixivArtistIDs: []});
  const ledger = new QQArtworkLedger();
  let calls = 0;
  const budget = () => { calls += 1; if (calls > 70) throw new Error('Probe budget exhausted'); };
  const library = new QQArtworkLibrary();
  const first = await library.prepare(request('hot'), {config, scope: 'probe', ledger, beforeFetch: budget});
  assert.ok(first.image !== undefined && first.id !== undefined);
  ledger.reserve(uuid(), 'probe', first.id, first.hash, first.request);
  const second = await library.prepare(request('next'), {config, scope: 'probe', ledger, beforeFetch: budget});
  assert.ok(second.image !== undefined); assert.notEqual(second.id, first.id);
  assert.ok(first.caption.includes('Pixiv 日榜')); assert.ok(second.caption.includes('Pixiv 日榜'));
  console.log(`LIVE_HOT_NEXT distinctImages=2 configuredArtists=0 requests=${calls} noQQ=true noModel=true`);
});

for (const status of [200, 404, 410, -1, -2, -3, -4, -5, -6, 401, 403, 429, 500]) {
  test(`publicAssetVariantsAreBoundedAndRespectAccessFailures(${status})`, async () => {
    const {library, state} = client();
    state.originalStatus = status;
    const config = enabled({imagePermissions: {}});
    if ([-2, -5, -6, 401, 403, 429, 500].includes(status)) {
      await assert.rejects(library.prepare(request('artist', 'LAM'), {config, scope: 'A', ledger: new QQArtworkLedger(), beforeFetch: () => {}}),
        error => !(error instanceof CancellationError));
      assert.equal(state.calls.some(call => call.includes('/img-master/')), status === -6);
      assert.equal(state.calls.filter(call => call.includes('pximg.net')).length, status === -6 ? 2 : 1);
    } else {
      const result = await library.prepare(request('artist', 'LAM'), {config, scope: 'A', ledger: new QQArtworkLedger(), beforeFetch: () => {}});
      assert.ok(result.image !== undefined); assert.equal(result.id, 'pixiv:102');
      assert.equal(state.calls.filter(call => call.includes('pximg.net')).length, status === 200 ? 1 : 2);
      assert.equal(state.calls.some(call => call.includes('/img-master/')), status !== 200);
    }
    assert.ok(!state.calls.some(call => call.includes('?full=1') || call.includes('deepseek')));
    assert.equal(QQArtworkLibrary.allowedURL('https://i.pximg.net.evil.org/img-master/1.jpg'), undefined);
    assert.equal(QQArtworkLibrary.allowedURL('https://127.0.0.1/img-master/1.jpg'), undefined);
    assert.deepEqual(state.problems, []);
  });
}

test('livePublicArtistPictureWhenExplicitlyRequested', {skip: process.env.QQ_PUBLIC_ART_PROBE !== '1'}, async () => {
  const config = enabled({imagePermissions: {}});
  let calls = 0;
  const result = await new QQArtworkLibrary().prepare(request('artist', 'Anmi'), {config, scope: 'probe', ledger: new QQArtworkLedger(), beforeFetch: () => { calls += 1; }});
  assert.ok(result.image !== undefined);
  assert.ok(result.caption.includes('/next')); assert.ok(result.caption.includes('作品 ID：'));
  console.log(`PUBLIC_ARTIST_PROBE imageBytes=${result.image.length} sourceRequests=${calls} noLicenseRegistry=true noQQ=true noModel=true`);
});

test('realSchemaRankingIsDatedAndNextIsScoped', async () => {
  const {library, state} = client();
  const settings = enabled();
  const ledger = new QQArtworkLedger();
  let requests = 0;
  const first = await library.prepare(request('hot'), {config: settings, scope: 'A', ledger, beforeFetch: () => { requests += 1; }});
  assert.equal(first.id, 'pixiv:101'); assert.ok(first.image !== undefined);
  assert.ok(first.caption.includes('20260927 · 第 1 名')); assert.ok(first.caption.includes('/next')); assert.ok(first.caption.includes('Fixture Artist'));
  ledger.reserve(uuid(), 'A', first.id, undefined, first.request);
  const next = await library.prepare(request('next'), {config: settings, scope: 'A', ledger, beforeFetch: () => { requests += 1; }});
  assert.equal(next.id, 'pixiv:105'); assert.ok(next.image !== undefined);
  const isolated = await library.prepare(request('next'), {config: settings, scope: 'B', ledger, beforeFetch: () => { state.problems.push('No network for absent continuation'); }});
  assert.equal(isolated.id, undefined);
  assert.ok(!state.calls.some(call => call.includes('?full=1')));
  assert.deepEqual(state.problems, []);
});

test('publicPortfolioDoesNotRequireLicenseRegistry', async () => {
  const {library, state} = client();
  const settings = enabled({imagePermissions: {}});
  const result = await library.prepare(request('artist', 'LAM'), {config: settings, scope: 'A', ledger: new QQArtworkLedger(), beforeFetch: () => {}});
  assert.ok(result.image !== undefined); assert.equal(result.id, 'pixiv:102');
  assert.ok(!state.calls.some(call => call.includes('?full=1')));
  assert.deepEqual(state.problems, []);
});

test('publicImagesHaveAttributionAndStrictInputs', async () => {
  const {library, state} = client();
  const settings = enabled();
  const result = await library.prepare(request('featured', '初音未来'), {config: settings, scope: 'A', ledger: new QQArtworkLedger(), beforeFetch: () => {}});
  assert.ok(result.image !== undefined); assert.equal(result.hash?.length, 64);
  assert.ok(result.caption.includes('Fixture Artist')); assert.ok(result.caption.includes('https://www.pixiv.net/artworks/'));
  assert.equal(QQArtworkLibrary.allowedURL('https://www.peppercarrot.com.evil.org/0_sources/0ther/artworks/hi-res/a.jpg'), undefined);
  assert.equal(QQArtworkLibrary.allowedURL('https://127.0.0.1/a.jpg'), undefined);
  assert.equal(QQArtworkLibrary.toolRequest('{"mode":"hot","query":"x","target":"other"}'), undefined);
  assert.ok(QQArtworkLibrary.excludedTags(['R-18']));
  assert.ok(!QQArtworkLibrary.illustrationTitle('【新刊】東方衣替画録'));
  assert.ok(QQArtworkLibrary.animeGirl({tags: ['女の子', '原神'], artist: '999', id: '999'}));
  assert.ok(!QQArtworkLibrary.animeGirl({tags: ['風景', '空'], artist: '17429', id: '999'}));
  assert.ok(!QQArtworkLibrary.animeGirl({tags: ['女の子', '写真', '原神'], artist: '17429', id: '999'}));
  assert.ok(!QQArtworkLibrary.animeGirl({tags: ['男性', '原神'], artist: '17429', id: '999'}));
  await assert.rejects(QQArtworkLibrary.normalized(Buffer.from('bad image'), settings));
  assert.deepEqual(state.problems, []);
});

test('liveScheduledPictureWhenExplicitlyRequested', {skip: process.env.QQ_HOURLY_LIVE_PROBE !== '1'}, async () => {
  const config = enabled();
  let calls = 0;
  const result = await new QQArtworkLibrary().prepare(request('featured'), {config, scope: 'probe', ledger: new QQArtworkLedger(), randomArtist: true, beforeFetch: () => { calls += 1; }});
  assert.ok(result.image !== undefined);
  assert.ok(result.caption.includes('/next')); assert.ok(result.caption.includes('/search')); assert.ok(!result.caption.includes('/artist '));
  console.log(`HOURLY_PICTURE_PROBE imageBytes=${result.image.length} sourceRequests=${calls} noQQ=true noModel=true`);
});

test('liveArtistLookupWhenExplicitlyRequested', {skip: process.env.QQ_ARTIST_LIVE_PROBE !== '1'}, async () => {
  let requests = 0;
  const name = await new QQArtworkLibrary().lookupArtist('212801', {beforeFetch: () => { requests += 1; }});
  // Public display names can include current exhibition/publication suffixes.
  assert.ok(name !== ''); assert.equal(requests, 1);
  console.log(`ARTIST_PUBLIC_PROBE verified=true sourceRequests=${requests} noQQ=true noModel=true`);
});

test('livePublicSourcesWhenExplicitlyRequested', {skip: process.env.QQ_ARTWORK_LIVE_PROBE !== '1'}, async () => {
  const settings = enabled();
  const library = new QQArtworkLibrary();
  let networkCalls = 0;
  const art = await library.prepare(request('featured', '初音未来'), {config: settings, scope: 'probe', ledger: new QQArtworkLedger(), beforeFetch: () => { networkCalls += 1; }});
  assert.ok(art.image !== undefined);
  const hot = await library.prepare(request('hot'), {config: settings, scope: 'probe', ledger: new QQArtworkLedger(), beforeFetch: () => { networkCalls += 1; }});
  assert.equal(hot.id === undefined, hot.image === undefined);
  if (hot.id !== undefined) assert.ok(hot.caption.includes('Pixiv 日榜'));
  else assert.ok(!hot.caption.includes('https://'));
  console.log(`ARTWORK_PUBLIC_PROBE network=${networkCalls} licensedImageBytes=${art.image?.length ?? 0} hot=${hot.id ?? 'none'} noQQ=true noModel=true`);
});

// Pixiv pictures for the agent (find_artwork / send_artwork) and the scheduled artwork posts. Rewritten 11-03 from the
// port of QQArtworkLibrary.swift: the whole site is available ("不要限定那些什么作者和来源了，全站可得，只限制r18就行"):
// no artist roster or hand-picked works, no "anime girl" filter, no bookmark or size threshold, AI works, manga and
// multi-page works allowed. Only R-18/R-18G works and political ones ("如果涉政还是要限制的") are skipped.
// Public website JSON, no login cookies.
import crypto from 'node:crypto';
import {AppFailure, graphemes, prefix, since, trim} from './swift.mjs';
import {URLError, boundedData, checkCancellation, defaultSession, taskSleep} from './BoundedDownload.mjs';
import {LinuxImages} from './LinuxImages.mjs';
import {QQArtworkRequest} from './core/QQArtwork.mjs';
import {QQConfig, QQPolicy} from './core/QQPolicy.mjs';
import {asBool, asDictionaries, asDictionary, asInt, asString, asStrings, jsonObject, swiftURL, urlPath, urlQuery} from './foundation.mjs';

const hex = data => crypto.createHash('sha256').update(data).digest('hex');
const copyRequest = request => new QQArtworkRequest({mode: request.mode, query: request.query, prompt: request.prompt});
const excludes = (ledger, scope, id, days, hash) => ledger.excludes(scope, id, hash, days);
const dropFirst = (value, length) => graphemes(value).slice(length).join('');
const shuffled = values => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) { const other = crypto.randomInt(index + 1); [copy[index], copy[other]] = [copy[other], copy[index]]; }
  return copy;
};
const metric = value => { const number = asInt(value); return number !== undefined && number >= 0 ? number : undefined; };
export const rankings = ['daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female', 'daily_ai'];
const rankingNames = {daily: '日榜', weekly: '周榜', monthly: '月榜', rookie: '新人榜', original: '原创榜', male: '男性向榜', female: '女性向榜', daily_ai: 'AI 日榜'};

export class QQArtworkPrepared {
  constructor({request, id, caption, image, sourceRequests = 0, preparationSeconds = 0} = {}) {
    this.request = request; this.id = id; this.caption = caption; this.image = image;
    this.sourceRequests = sourceRequests; this.preparationSeconds = preparationSeconds;
  }
  get hash() { return this.image === undefined ? undefined : hex(this.image); }
  /// One line of attribution for a picture the model chose to share: title, artist and source.
  static credit(caption) {
    const lines = caption.split('\n');
    const title = lines.find(line => line.startsWith('《'));
    const artist = lines.find(line => line.startsWith('画师：'));
    const sourceLine = lines.find(line => line.startsWith('原帖：'));
    const source = sourceLine === undefined ? undefined : dropFirst(sourceLine, 3);
    return [title, artist, source].filter(value => value !== undefined).join(' · ');
  }
}

class ArtworkAssetMissing extends Error {
  constructor() { super('artwork asset missing'); this.name = 'ArtworkAssetMissing'; }
}
class Work {
  constructor({id, title, author, artistID, url, imageURLs, pages = 1, page = 1, tags = [], rank, date, bookmarks, likes, views, ai = false}) {
    Object.assign(this, {id, title, author, artistID, url, imageURLs, pages, page, tags, rank, date, bookmarks, likes, views, ai});
  }
}

export class QQArtworkLibrary {
  static Work = Work;
  static get definition() {
    return {type: 'function', function: {name: 'find_artwork',
      description: '在 Pixiv 全站找现成的插画（不是画新图）：search 按关键词搜（标签、角色、作品名都行，中日英都可以，-词 排除），ranking 看榜单（日榜、周榜、月榜、新人榜、原创榜、男性向、女性向、AI 日榜），id 直接查作品号或作品链接（多页作品在 query 后加 p2 看第二页），artist 看某个画师（画师 ID 或主页链接）的作品，related 找和某个作品相似的，next 接着上一次再来一张。找到后先准备好一张，结果里还列出其他候选的作品号，想换就用 id 再查；要发就调用 send_artwork。R-18 和涉政的作品会跳过。',
      parameters: {type: 'object', additionalProperties: false, required: ['mode'], properties: {
        mode: {type: 'string', enum: ['search', 'ranking', 'id', 'artist', 'related', 'next']},
        query: {type: 'string', description: 'search 的关键词；id/related 的作品号或链接；artist 的画师 ID 或主页链接；ranking 时可填关键词在榜内筛选；next 可留空或填新关键词'},
        ranking: {type: 'string', enum: rankings, description: 'ranking 模式用哪个榜，默认 daily'}
      }}}};
  }
  /** The agent's find_artwork arguments as a request: {mode, query, prompt} (prompt carries the ranking). */
  static toolRequest(args) {
    let object;
    try { object = typeof args === 'string' ? jsonObject(args) : args; } catch { return undefined; }
    const mode = asString(object?.mode), query = trim(asString(object?.query) ?? '');
    if (!['search', 'ranking', 'hot', 'id', 'artist', 'related', 'next'].includes(mode)) return undefined;
    if (mode === 'ranking' || mode === 'hot') {
      const ranking = rankings.includes(object?.ranking) ? object.ranking : 'daily';
      return new QQArtworkRequest({mode: 'hot', query, prompt: ranking});
    }
    if (['id', 'related', 'artist', 'search'].includes(mode) && query === '') return undefined;
    return new QQArtworkRequest({mode, query});
  }

  constructor({session, spacing = 0.3} = {}) {
    this.session = session ?? defaultSession;
    this.spacing = spacing;
    this.cache = new Map(); // url → {at, object}
    this.images = new Map(); // work id + page → Buffer
    this.imageOrder = [];
    this.blockedUntil = new Map(); // host → Date (Pixiv answered 403/429)
    this.lastFetch = new Date(0);
  }
  /** Shown by the console's artwork settings for saved artist IDs (the roster itself no longer limits anything). */
  static artistName(id, config) { return config.artistNames?.[id] ?? `画师 ${id}`; }
  async lookupArtist(id, options = {}) {
    const {beforeFetch, signal} = typeof options === 'function' ? {beforeFetch: options} : options;
    if (!QQConfig.validID(id)) throw new AppFailure('画师 ID 无效');
    const profile = await this.json(`https://www.pixiv.net/ajax/user/${id}?full=1`, beforeFetch, signal);
    const name = asString(asDictionary(profile.body)?.name);
    if (asBool(profile.error) !== false || name === undefined || trim(name) === '') throw new AppFailure('没找到这个 Pixiv 画师');
    return QQArtworkLibrary.clean(name);
  }

  /** One prepared picture (and other candidates in its caption) for a request. `beforeFetch` runs before every
   *  network request; whatever it throws stops the preparation. */
  async prepare(raw, {config, scope, ledger, beforeFetch = () => {}, signal} = {}) {
    let request = copyRequest(raw);
    const done = fields => new QQArtworkPrepared({...fields, request: copyRequest(fields.request ?? request)});
    if (raw.mode === 'next') {
      const previous = ledger.continuation?.[scope];
      if (!previous) return done({caption: '这个会话还没找过插画，先 search 或 ranking 一次。'});
      request = copyRequest(previous);
      if (raw.query !== '') { if (['id', 'related', 'artist'].includes(request.mode)) request = new QQArtworkRequest({mode: 'search', query: raw.query}); else request.query = raw.query; }
    }
    if (!config.enabled) return done({caption: '插画功能没开，要在控制台「能力」里打开。'});
    // Older saved requests: "featured" without words was the curated roster, now the daily ranking; with words, a search.
    if (request.mode === 'featured') request = request.query === '' ? new QQArtworkRequest({mode: 'hot', query: '', prompt: 'daily'}) : new QQArtworkRequest({mode: 'search', query: request.query});
    if (['help', 'retiredArtist', 'artists'].includes(request.mode)) return done({caption: QQArtworkRequest.help});
    const fresh = id => !excludes(ledger, scope, 'pixiv:' + id, config.repeatDays);
    if (request.mode === 'id') {
      const [first, pageWord] = request.query.split(/\s+/u);
      const id = QQArtworkRequest.artworkID(first ?? '');
      if (id === undefined) return done({caption: '作品号或链接认不出来。'});
      const page = Math.max(1, Number(/^p?(\d+)$/i.exec(pageWord ?? '')?.[1] ?? 1));
      const work = await this.detail(id, {beforeFetch, signal, page});
      if (!work) return done({caption: `作品 ${id} 打不开，或者是 R-18 / 涉政作品。`});
      const ready = await this.prepareWork(work, {request, beforeFetch, signal});
      return ready ?? done({caption: `作品 ${id} 的图片下不来。`});
    }
    let ids, label, ranked = new Map();
    if (request.mode === 'search') {
      ids = await this.searchIDs(request.query, {beforeFetch, signal});
      label = 'Pixiv 搜索：' + QQArtworkLibrary.clean(request.query);
    } else if (request.mode === 'hot') {
      const mode = rankings.includes(request.prompt) ? request.prompt : 'daily';
      const rows = await this.rankingRows(mode, {beforeFetch, signal});
      const wanted = request.query;
      for (const row of rows) if (wanted === '' || QQArtworkLibrary.matches(wanted, [...row.tags, row.title])) ranked.set(row.id, row);
      ids = [...ranked.keys()];
      label = `Pixiv ${rankingNames[mode]}` + (wanted === '' ? '' : '（筛选：' + QQArtworkLibrary.clean(wanted) + '）');
    } else if (request.mode === 'artist') {
      const artist = QQArtworkLibrary.artistID(request.query);
      if (!artist) return done({caption: '画师 ID 或主页链接认不出来。'});
      const profile = await this.json(`https://www.pixiv.net/ajax/user/${artist}/profile/all?lang=zh`, beforeFetch, signal);
      const body = asDictionary(profile.body);
      ids = [...Object.keys(asDictionary(body?.illusts) ?? {}), ...Object.keys(asDictionary(body?.manga) ?? {})].sort((a, b) => Number(b) - Number(a));
      label = 'Pixiv 画师 ' + artist + ' 的作品';
    } else if (request.mode === 'related') {
      const id = QQArtworkRequest.artworkID(request.query);
      if (!id) return done({caption: '作品号或链接认不出来。'});
      const related = await this.json(`https://www.pixiv.net/ajax/illust/${id}/recommend/init?limit=30&lang=zh`, beforeFetch, signal);
      ids = (asDictionaries(asDictionary(related.body)?.illusts) ?? []).map(row => QQPolicy.identifier(row.id)).filter(Boolean);
      label = `和作品 ${id} 相似的`;
    } else return done({caption: QQArtworkRequest.help});

    const candidates = ids.filter(fresh);
    if (!candidates.length) return done({caption: ids.length ? label + '：能找到的都在这个会话发过了，换个关键词或榜单。' : label + '：什么都没找到，换个说法试试。'});
    // A search looks at its first dozen works and starts from the most bookmarked (a search without Pixiv's own
    // popular picks is newest first, so the first hit was often a minutes-old post); rankings keep their order, an
    // artist's works newest first. The first usable work is prepared and a few more are listed by id.
    let ready, checked = 0;
    const others = [], seen = [];
    const take = async id => {
      checked += 1;
      const work = await this.detail(id, {beforeFetch, signal});
      if (!work) return;
      const row = ranked.get(id);
      if (row) { work.rank = row.rank; work.date = row.date; }
      seen.push(work);
    };
    let queue = [...candidates];
    if (request.mode === 'search') {
      while (queue.length && seen.length < 12 && checked < 40) await take(queue.shift());
      seen.sort((a, b) => (b.bookmarks ?? -1) - (a.bookmarks ?? -1));
    }
    while (true) {
      while (!seen.length && queue.length && checked < 40) await take(queue.shift());
      const work = seen.shift();
      if (!work || (ready && others.length >= 5)) break;
      if (!ready) { ready = await this.prepareWork(work, {request, beforeFetch, signal}); if (ready) continue; }
      others.push(`${work.id.slice('pixiv:'.length)}《${work.title}》${work.author}` + (work.bookmarks !== undefined ? ` · 收藏 ${work.bookmarks}` : '') + (work.pages > 1 ? ` · ${work.pages} 页` : ''));
    }
    if (!ready) return done({caption: label + `：看了 ${checked} 个，能发的图都下不来（或都是 R-18 / 涉政）。`});
    ready.caption = label + '\n' + ready.caption + (others.length ? '\n其他候选（用 id 查）：\n' + others.join('\n') : '');
    return ready;
  }

  /** Keyword search over the whole site, all-ages results (the site's own "safe" mode): popular first, then newest. */
  async searchIDs(query, {beforeFetch, signal}) {
    const word = QQArtworkLibrary.searchQuery(query);
    const ids = [];
    for (let page = 1; page <= 3 && ids.length < 120; page++) {
      const url = `https://www.pixiv.net${urlPath('/ajax/search/artworks/' + word)}?` +
        urlQuery([['word', word], ['order', 'date_d'], ['mode', 'safe'], ['p', String(page)], ['s_mode', 's_tag'], ['type', 'all'], ['lang', 'zh']]);
      const response = await this.json(url, beforeFetch, signal);
      const body = asDictionary(response.body);
      if (asBool(response.error) !== false || !body) throw new AppFailure('Pixiv 搜索这会儿用不了');
      const popular = asDictionary(body.popular);
      const rows = [...(page === 1 ? [...(asDictionaries(popular?.permanent) ?? []), ...(asDictionaries(popular?.recent) ?? [])] : []),
        ...(asDictionaries(asDictionary(body.illustManga)?.data) ?? [])];
      for (const row of rows) {
        const id = QQPolicy.identifier(row.id);
        if (id && asInt(row.xRestrict) === 0 && !ids.includes(id)) ids.push(id);
      }
      if (rows.length === 0 || page >= (asInt(asDictionary(body.illustManga)?.lastPage) ?? 1)) break;
    }
    // Popular ones first as Pixiv gave them; the newest ones after, lightly shuffled so "next" brings variety.
    return [...ids.slice(0, 12), ...shuffled(ids.slice(12))];
  }

  async rankingRows(mode, {beforeFetch, signal}) {
    const rows = [];
    let date;
    for (let page = 1; page <= 2; page++) {
      const ranking = await this.json(`https://www.pixiv.net/ranking.php?mode=${mode}&format=json&p=${page}` + (date ? `&date=${date}` : ''), beforeFetch, signal);
      const contents = asDictionaries(ranking.contents);
      if (!contents) throw new AppFailure('Pixiv 榜单这会儿用不了');
      date = asString(ranking.date) ?? (asInt(ranking.date) === undefined ? undefined : String(ranking.date));
      for (const row of contents) {
        const id = QQPolicy.identifier(row.illust_id);
        if (id) rows.push({id, rank: asInt(row.rank), date, title: asString(row.title) ?? '', tags: asStrings(row.tags) ?? []});
      }
      if (asInt(ranking.next) !== page + 1) break;
    }
    return rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  }

  async prepareWork(work, {request, beforeFetch, signal}) {
    const key = work.id + '#' + work.page;
    let image = this.images.get(key);
    if (image === undefined) {
      let transferError;
      for (const url of work.imageURLs) {
        let bytes;
        try { bytes = await this.fetch(url, 30_000_000, beforeFetch, signal); }
        catch (error) {
          if (error instanceof ArtworkAssetMissing) continue;
          if (error instanceof URLError) { checkCancellation(signal); transferError = error; continue; }
          throw error;
        }
        try { image = await QQArtworkLibrary.normalized(bytes); break; } catch { continue; }
      }
      if (image === undefined) { if (transferError) throw transferError; return undefined; }
      this.images.set(key, image); this.imageOrder.push(key);
      while (this.imageOrder.length > 32) this.images.delete(this.imageOrder.shift());
    }
    let caption = `【作品】\n《${work.title}》\n画师：${work.author}\n`;
    if (work.date !== undefined && work.rank !== undefined) caption += `榜单 ${work.date} · 第 ${work.rank} 名\n`;
    const numbers = [work.bookmarks !== undefined ? `收藏 ${work.bookmarks}` : undefined, work.likes !== undefined ? `点赞 ${work.likes}` : undefined,
      work.views !== undefined ? `浏览 ${work.views}` : undefined, work.pages > 1 ? `第 ${work.page}/${work.pages} 页` : undefined, work.ai ? 'AI 作品' : undefined].filter(Boolean);
    if (numbers.length) caption += numbers.join(' · ') + '\n';
    if (work.tags.length) caption += '标签：' + work.tags.slice(0, 10).join('、') + '\n';
    caption += `原帖：${work.url}\n作品 ID：${work.id.slice('pixiv:'.length)}`;
    return new QQArtworkPrepared({request: copyRequest(request), id: work.id, caption, image});
  }

  /** A work's details, or undefined when it is R-18/R-18G, political, gone, or the page does not exist. */
  async detail(id, {beforeFetch, signal, page = 1} = {}) {
    const data = await this.json(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, beforeFetch, signal).catch(error => {
      if (error instanceof AppFailure) return {}; throw error;
    });
    const body = asDictionary(data.body);
    if (asBool(data.error) !== false || !body || QQPolicy.identifier(body.id) !== id || asInt(body.xRestrict) !== 0) return undefined;
    const title = asString(body.illustTitle) ?? '', author = asString(body.userName) ?? '', artist = QQPolicy.identifier(body.userId);
    const tags = (asDictionaries(asDictionary(body.tags)?.tags) ?? []).flatMap(tag => [asString(tag.tag), asString(asDictionary(tag.translation)?.en)]).filter(Boolean);
    if (QQArtworkLibrary.political([...tags, title, asString(body.description) ?? ''])) return undefined;
    const pages = Math.max(1, asInt(body.pageCount) ?? 1), wanted = Math.min(pages, page);
    let urls = asDictionary(body.urls);
    if (wanted > 1) {
      const list = await this.json(`https://www.pixiv.net/ajax/illust/${id}/pages?lang=zh`, beforeFetch, signal);
      urls = asDictionary((asDictionaries(list.body) ?? [])[wanted - 1]?.urls);
    }
    const imageURLs = ['original', 'regular'].map(name => asString(urls?.[name])).filter(url => url && QQArtworkLibrary.allowedURL(url));
    if (!imageURLs.length) return undefined;
    return new Work({id: 'pixiv:' + id, title: QQArtworkLibrary.clean(title), author: QQArtworkLibrary.clean(author), artistID: artist,
      url: 'https://www.pixiv.net/artworks/' + id, imageURLs, pages, page: wanted, tags: [...new Set(tags.map(QQArtworkLibrary.clean))],
      bookmarks: metric(body.bookmarkCount), likes: metric(body.likeCount), views: metric(body.viewCount), ai: asInt(body.aiType) === 2});
  }

  /** Political works are skipped (leaders, parties, separatism, wars and the like), in Chinese, Japanese and English. */
  static political(values) {
    return values.some(value => /(政治|政権|政党|共産党|共产党|中共|習近平|习近平|毛沢東|毛泽东|鄧小平|邓小平|江沢民|江泽民|胡錦濤|胡锦涛|天安門事件|天安门事件|六四|台独|台湾独立|台灣獨立|臺獨|港独|香港独立|藏独|疆独|ウイグル|维吾尔|維吾爾|チベット独立|法輪功|法轮功|プーチン|普京|トランプ|特朗普|バイデン|拜登|金正恩|ヒトラー|希特勒|ナチス|纳粹|nazi|hitler|xi jinping|ccp|putin|trump|biden|propaganda|プロパガンダ|選挙|选举|反日|抗日|侵略戦争|戦争犯罪|国家主席|総理大臣|首相)/iu.test(value));
  }
  static artistID(input) {
    const value = trim(input);
    if (QQConfig.validID(value)) return value;
    const url = swiftURL(value);
    const match = url && ['www.pixiv.net', 'pixiv.net'].includes(url.host ?? '') ? /\/users\/(\d+)/.exec(url.path) : undefined;
    return match?.[1];
  }
  static clean(text) { return prefix(String(text).replace(/[\r\n\x00-\x1f]|\[CQ:/g, ' '), 100); }
  /** Chinese words for common tags become Pixiv's Japanese tags; "不要X" becomes "-X". */
  static searchQuery(value) {
    const translations = {'初音未来': '初音ミク', '白发': '白髪', '银发': '銀髪', '黑发': '黒髪', '蓝发': '青髪',
      '粉发': 'ピンク髪', '金发': '金髪', '红发': '赤髪', '紫发': '紫髪', '长发': 'ロングヘア',
      '短发': 'ショートヘア', '双马尾': 'ツインテール', '女仆': 'メイド', '黑丝': '黒タイツ', '白丝': '白タイツ',
      '碧蓝档案': 'ブルーアーカイブ', '蔚蓝档案': 'ブルーアーカイブ', '星穹铁道': 'スターレイル', '原神': '原神', '明日方舟': 'アークナイツ'};
    let text = trim(value).replace(/(?:不要|排除|不含|不带)\s*/gu, ' -').replace(/[，,、+]/gu, ' ');
    for (const [word, tag] of Object.entries(translations).sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(word, ' ' + tag + ' ');
    return text.replace(/-\s+/gu, '-').split(/\s+/u).filter(Boolean).join(' ');
  }
  /** Every positive word appears in the tags or title (any of its known spellings); "-word" must not. */
  static matches(query, values) {
    const joined = values.join(' ').toLowerCase();
    return QQArtworkLibrary.searchQuery(query).toLowerCase().split(/\s+/u).filter(Boolean).every(token => {
      const negative = token.startsWith('-'), word = negative ? token.slice(1) : token;
      const found = joined.includes(word);
      return negative ? !found : found;
    });
  }
  static allowedURL(value) {
    const u = swiftURL(value);
    if (!u || u.scheme !== 'https' || u.user !== undefined || u.password !== undefined || u.port !== undefined) return undefined;
    if (u.host === 'www.pixiv.net' && (u.path === '/ranking.php' || u.path.startsWith('/ajax/'))) return u;
    if (u.host === 'i.pximg.net') return u;
    return undefined;
  }

  async json(value, beforeFetch, signal) {
    const cached = this.cache.get(value);
    if (cached && since(cached.at) < 1800) { checkCancellation(signal); return cached.object; }
    const object = asDictionary(jsonObject(await this.fetch(value, 5_000_000, beforeFetch, signal)));
    if (!object) throw new AppFailure('Pixiv 返回的内容看不懂');
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(value, {at: new Date(), object});
    return object;
  }
  async fetch(value, limit, beforeFetch = () => {}, signal) {
    const url = QQArtworkLibrary.allowedURL(value);
    if (!url) throw new AppFailure('不是 Pixiv 的地址');
    const host = url.host;
    const blocked = this.blockedUntil.get(host);
    if (blocked !== undefined && blocked > new Date()) throw new AppFailure('Pixiv 刚才限流了，过一会儿再试');
    const wait = this.spacing - since(this.lastFetch);
    if (wait > 0) await taskSleep(wait * 1000, signal);
    await beforeFetch(); this.lastFetch = new Date();
    const headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', Referer: 'https://www.pixiv.net/'};
    const {data, response} = await boundedData(this.session, {url: url.href, headers, timeoutInterval: 20, resourceTimeout: 60, signal}, limit);
    if ([403, 429].includes(response.statusCode)) {
      const retry = Number(response.value('Retry-After'));
      this.blockedUntil.set(host, new Date(Date.now() + Math.min(3600, Math.max(30, Number.isFinite(retry) ? retry : 120)) * 1000));
    }
    if (host === 'i.pximg.net' && [404, 410].includes(response.statusCode)) throw new ArtworkAssetMissing();
    if (response.statusCode !== 200) throw new AppFailure(`Pixiv 这会儿不可用（HTTP ${response.statusCode}）`);
    checkCancellation(signal);
    return data;
  }
  /** Any size: the picture is only scaled down to a size QQ takes. */
  static async normalized(data) {
    return (await LinuxImages.process(data, 'artwork', {minLongEdge: 0, minShortEdge: 0}))[0];
  }
}

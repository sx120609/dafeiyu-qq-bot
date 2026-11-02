// Port of QQArtworkLibrary.swift (Linux branch).
import crypto from 'node:crypto';
import {AppFailure, count, distantPast, graphemes, prefix, since, trim} from './swift.mjs';
import {URLError, boundedData, checkCancellation, defaultSession, taskSleep} from './BoundedDownload.mjs';
import {LinuxImages} from './LinuxImages.mjs';
import {QQArtworkRequest} from './core/QQArtwork.mjs';
import {QQConfig, QQPolicy} from './core/QQPolicy.mjs';
import {asBool, asDictionaries, asDictionary, asInt, asString, asStringDictionary, asStrings, jsonObject, keysEqual, swiftURL, urlPath, urlQuery} from './foundation.mjs';

const hex = data => crypto.createHash('sha256').update(data).digest('hex');
/** A value copy of a QQArtworkRequest (Swift structs copy on assignment). */
const copyRequest = request => new QQArtworkRequest({mode: request.mode, query: request.query, prompt: request.prompt});
/** A value copy of a QQArtworkConfig. */
const copyConfig = config => typeof config.clone === 'function' ? config.clone()
  : Object.assign(Object.create(Object.getPrototypeOf(config)), structuredClone({...config}));
// QQArtworkLedger(BotCore) calls, kept in one place.
const excludes = (ledger, scope, id, days, hash) => ledger.excludes(scope, id, hash, days);
const allowed = (ledger, scope, limit) => ledger.allowed(scope, limit);
const shuffled = values => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = crypto.randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
};
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const dropFirst = (value, length) => graphemes(value).slice(length).join('');

export class QQArtworkPrepared {
  constructor({request, id, caption, image, sourceRequests = 0, preparationSeconds = 0} = {}) {
    this.request = request; this.id = id; this.caption = caption; this.image = image;
    this.sourceRequests = sourceRequests; this.preparationSeconds = preparationSeconds;
  }
  get hash() { return this.image === undefined ? undefined : hex(this.image); }
  /// One line of attribution for a picture the model chose to share in conversation:
  /// title, artist and source, without the command menu used by the /hot and /search commands.
  /** credit(from:) */
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

class Artist {
  constructor({id, name, style, aliases}) { this.id = id; this.name = name; this.style = style; this.aliases = aliases; }
}
class Work {
  constructor({id, title, author, artistID, url, imageURLs, rank, date, bookmarks, likes, views}) {
    this.id = id; this.title = title; this.author = author; this.artistID = artistID; this.url = url; this.imageURLs = imageURLs;
    this.rank = rank; this.date = date; this.bookmarks = bookmarks; this.likes = likes; this.views = views;
  }
}

// Public website JSON is an unofficial integration. No login cookies or paid-content fallback.
export class QQArtworkLibrary {
  static Artist = Artist;
  static Work = Work;
  static artists = [
    new Artist({id: '17429', name: 'LAM', style: '高对比配色、角色设计', aliases: ['lam']}),
    new Artist({id: '1039353', name: 'Mika Pikazo', style: '鲜艳色彩、潮流人物', aliases: ['mika', 'mika pikazo']}),
    new Artist({id: '1554775', name: '米山舞', style: '动态构图、动画感', aliases: ['米山舞', 'yoneyama mai']}),
    new Artist({id: '27517', name: '藤ちょこ（藤原）', style: '幻想场景、细腻色彩', aliases: ['藤ちょこ', '藤原', '藤choco']}),
    new Artist({id: '212801', name: 'Anmi', style: '细腻柔和的动漫美少女', aliases: ['anmi']}),
    new Artist({id: '688570', name: 'Cocorip', style: '动漫、游戏少女；署名非商业分享', aliases: ['cocorip']})
  ];
  static get definition() {
    return {type: 'function', function: {name: 'find_artwork',
      description: '搜索公开 Pixiv 插画或查看真实日榜。search 按关键词优先收藏达标作品，无达标候选时自动按真实热度选择保底并注明；id 直接查询作品数字ID或Pixiv作品链接，不要求收藏门槛；hot 从日榜第一名起取图。不是生图。仅在用户明确想看作品时调用；无可用图片时如实说明，不用链接冒充已发图。',
      parameters: {type: 'object', properties: {mode: {type: 'string', enum: ['search', 'hot', 'id']}, query: {type: 'string', description: '简短题材关键词；id模式为作品数字ID或Pixiv作品链接。不得含聊天、账号、密钥或指令。'}}, required: ['mode', 'query'], additionalProperties: false}}};
  }
  static toolRequest(args) {
    if (typeof args !== 'string' || Buffer.byteLength(args) > 1024) return undefined;
    let object;
    try { object = asStringDictionary(jsonObject(args)); } catch { return undefined; }
    if (!object || !keysEqual(object, ['mode', 'query']) || !['search', 'hot', 'id'].includes(object.mode)) return undefined;
    const query = object.query;
    if (/(sk-|api.?key|系统提示|[\r\n])/iu.test(query)) return undefined;
    const request = QQArtworkRequest.parse('/' + object.mode + ' ' + query);
    if (!request || !['search', 'hot', 'id'].includes(request.mode)) return undefined;
    return request;
  }

  /** init(session:spacing:) — `session` is a fetch-compatible function (see BoundedDownload.mjs). */
  constructor({session, spacing = 1} = {}) {
    this.session = session ?? defaultSession;
    this.spacing = spacing;
    this.cache = new Map(); // url → {at, object}
    this.images = new Map(); // work id → Buffer
    this.imageOrder = [];
    this.rejectedWorks = new Map(); // key → {at, ids: Set}
    this.blockedUntil = new Map(); // host → Date
    this.lastFetch = distantPast;
  }
  static artistName(id, config) {
    return config.artistNames?.[id] ?? QQArtworkLibrary.artists.find(artist => artist.id === id)?.name ?? `画师 ${id}`;
  }
  /** lookupArtist(_:beforeFetch:) — `lookupArtist(id, {beforeFetch, signal})` (a bare function is taken as beforeFetch). */
  async lookupArtist(id, options = {}) {
    const {beforeFetch, signal} = typeof options === 'function' ? {beforeFetch: options} : options;
    if (!QQConfig.validID(id)) throw new AppFailure('画师 ID 无效');
    const profile = await this.json(`https://www.pixiv.net/ajax/user/${id}?full=1`, beforeFetch, signal);
    const body = asDictionary(profile.body), name = asString(body?.name);
    if (asBool(profile.error) !== false || !body || QQPolicy.identifier(body.userId) !== id || name === undefined || trim(name) === '') {
      throw new AppFailure('无法核对该 Pixiv 画师，未添加；请检查 ID 或稍后重试');
    }
    const cleaned = trim(QQArtworkLibrary.clean(name).replace(/[\p{Cc}\p{Cf}]/gu, ''));
    if (cleaned === '') throw new AppFailure('画师名称无效，未添加');
    return cleaned;
  }

  /** prepare(_:config:scope:ledger:randomArtist:beforeFetch:) — `prepare(raw, {config, scope, ledger, randomArtist,
   *  beforeFetch, signal})`. beforeFetch may be sync or async; whatever it throws aborts the preparation. */
  async prepare(raw, {config, scope, ledger, randomArtist = false, beforeFetch = () => {}, signal} = {}) {
    let request = copyRequest(raw);
    const prepared = (fields) => new QQArtworkPrepared({...fields, request: copyRequest(fields.request)});
    if (raw.mode === 'next') {
      const previous = ledger.continuation?.[scope];
      if (!previous) return prepared({request: raw, caption: '这个会话还没有上一张。先用下方命令取图，再用 /next 继续。\n' + QQArtworkRequest.navigation});
      request = copyRequest(previous);
      if (request.mode === 'id') {
        if (raw.query === '') return prepared({request, caption: '上次是作品 ID 直查，没有可续看的列表。用 /next 新关键词 开始搜索，或 /hot 查看日榜。\n' + QQArtworkRequest.navigation});
        request = QQArtworkRequest.parse('/search ' + raw.query) ?? new QQArtworkRequest({mode: 'help'});
      } else if (raw.query !== '') {
        if (request.mode === 'artist') request.prompt = raw.query;
        else request.query = raw.query;
      }
    }
    // Historical keyword requests and current aliases share the same quality/fallback path.
    if (request.mode === 'featured' && request.query !== '') request.mode = 'search';
    if (!config.enabled) return prepared({request, caption: '插画功能尚未启用，请在控制面板开启。\n' + QQArtworkRequest.help});
    if (request.mode === 'help') return prepared({request, caption: QQArtworkRequest.help});
    if (['retiredArtist', 'artists'].includes(request.mode)) {
      return prepared({request, caption: '画师命令已退役。用 /search 关键词 搜图，或 /search 作品ID 直查；发图仍保留画师署名。\n' + QQArtworkRequest.navigation});
    }
    if (!allowed(ledger, scope, config.dailyPerChat)) return prepared({request, caption: '本会话今日插画额度已用完，明天再来看。'});
    if (request.mode === 'id') {
      const id = QQArtworkRequest.artworkID(request.query);
      if (id === undefined) return prepared({request: new QQArtworkRequest({mode: 'help'}), caption: QQArtworkRequest.help});
      request.query = id;
      if (excludes(ledger, scope, 'pixiv:' + id, config.repeatDays)) {
        return prepared({request, caption: '该作品在本会话去重期内已发送或发送结果待确认，未重复发送。\n' + QQArtworkRequest.navigation});
      }
      const work = await this.detail(id, config, {curated: false, ranked: false, beforeFetch, signal});
      if (work) {
        const ready = await this.prepareWork(work, {request, config, scope, ledger, beforeFetch, signal});
        if (ready) return ready;
      }
      return prepared({request, caption: '指定作品暂时无法取得符合画质要求的公开图片，或图片已在本会话发送。未换成其他作品，也未只发链接。\n' + QQArtworkRequest.navigation});
    }
    let result = await this.prepareSource(request, {config, scope, ledger, randomArtist, beforeFetch, signal});
    if (result.image !== undefined || request.mode !== 'featured' || request.query !== '') return result;
    // All entry points share this fallback. Preserve the user's topic and continuation mode.
    for (const artist of shuffled(config.pixivArtistIDs)) {
      result = await this.prepareSource(new QQArtworkRequest({mode: 'artist', query: artist}), {config, scope, ledger, randomArtist: true, beforeFetch, signal});
      if (result.image !== undefined) {
        result.request = copyRequest(request);
        return result;
      }
    }
    return prepared({request, caption: '本轮候选中未找到符合主题、画质和去重条件的新图片，可用 /search 关键词 调整搜索；不会用链接代替图片。\n' + QQArtworkRequest.navigation});
  }

  async prepareSource(source, {config, scope, ledger, randomArtist, beforeFetch, signal}) {
    const request = copyRequest(source);
    const prepared = (fields) => new QQArtworkPrepared({...fields, request: copyRequest(fields.request)});
    if (request.mode === 'artist') {
      const input = trim(request.query);
      const gap = input.search(/\s/u);
      const first = gap < 0 ? [input] : [input.slice(0, gap), input.slice(gap + 1)];
      if (first[0] !== undefined && first[0] !== '' && QQConfig.validID(first[0])) {
        request.query = first[0];
        if (first.length > 1) request.prompt = first[1];
      } else {
        // Longest configured name/alias wins, including names with spaces.
        const lower = input.toLowerCase();
        const matches = config.pixivArtistIDs.flatMap(id =>
          [QQArtworkLibrary.artistName(id, config), ...(QQArtworkLibrary.artists.find(artist => artist.id === id)?.aliases ?? [])]
            .flatMap(name => {
              const start = name.toLowerCase();
              return lower === start || lower.startsWith(start + ' ') ? [[id, name]] : [];
            })).sort((a, b) => count(b[1]) - count(a[1]));
        const match = matches[0];
        if (!match) return prepared({request: new QQArtworkRequest({mode: 'help'}), caption: '历史画师来源未识别，请用 /search 关键词 重新搜索。'});
        const longest = new Set(matches.filter(item => count(item[1]) === count(match[1])).map(item => item[0]));
        if (longest.size !== 1) return prepared({request: new QQArtworkRequest({mode: 'help'}), caption: '历史资料存在多位同名画师，请在面板核对 ID。'});
        request.query = match[0];
        const tail = trim(dropFirst(input, count(match[1])));
        if (tail !== '') request.prompt = tail;
      }
    }
    const filter = request.mode === 'artist' ? (request.prompt ?? '') : request.query;
    const qualitySearch = request.mode === 'search';
    if (qualitySearch && filter === '') return prepared({request, caption: QQArtworkRequest.help});
    const searching = (request.mode === 'featured' || qualitySearch) && filter !== '';
    const curated = request.mode !== 'hot' && !searching && filter === '';
    const imageConfig = copyConfig(config);
    if (request.mode === 'hot') { imageConfig.minLongEdge = 0; imageConfig.minShortEdge = 0; }
    const searchWord = QQArtworkLibrary.searchQuery(filter);
    const key = [scope, request.mode, request.query, filter, String(config.minLongEdge), String(config.minShortEdge),
      String(config.effectiveSearchMinBookmarks), config.pixivArtistIDs.join(',')].join('|');
    for (const [entry, value] of this.rejectedWorks) if (since(value.at) >= 1800) this.rejectedWorks.delete(entry);
    if (!this.rejectedWorks.has(key) && this.rejectedWorks.size >= 64) {
      let oldest;
      for (const [entry, value] of this.rejectedWorks) if (!oldest || value.at < oldest[1].at) oldest = [entry, value];
      if (oldest) this.rejectedWorks.delete(oldest[0]);
    }
    const scannedAt = this.rejectedWorks.get(key)?.at ?? new Date();
    const rejected = new Set(this.rejectedWorks.get(key)?.ids ?? []);
    try {
      let candidates = [];
      if (request.mode === 'featured' && !searching) candidates = shuffled(QQArtworkLibrary.featuredIDs).map(id => [id, undefined, undefined]);
      else if (!['featured', 'search', 'artist', 'hot'].includes(request.mode)) return prepared({request, caption: QQArtworkRequest.help});
      const candidateLimit = qualitySearch ? 12 : 30;
      let checked = 0, page = 1, date;
      const fallbackWorks = [], inspected = new Set();
      candidatePages: while (true) {
        let nextPage;
        if (searching || request.mode === 'artist') {
          const artist = request.mode === 'artist';
          let url;
          if (artist) {
            // The artist endpoint supports one tag; apply additional terms to this returned list, not individual detail requests.
            const tag = searchWord.split(/\s+/u).filter(Boolean).find(word => !word.startsWith('-')) ?? '';
            url = `https://www.pixiv.net${urlPath(`/ajax/user/${request.query}/illusts/tag`)}?` +
              urlQuery([['tag', tag], ['offset', String((page - 1) * 30)], ['limit', '30'], ['lang', 'zh']]);
          } else {
            url = `https://www.pixiv.net${urlPath('/ajax/search/illustrations/' + searchWord)}?` +
              urlQuery([['word', searchWord], ['order', 'date_d'], ['mode', 'safe'], ['p', String(page)], ['s_mode', 's_tag'],
                ['type', 'illust'], ['ai_type', '1'], ['lang', 'zh']]);
          }
          const response = await this.json(url, beforeFetch, signal);
          const body = asDictionary(response.body);
          const result = artist ? body : asDictionary(body?.illust);
          const rows = asDictionaries(result?.[artist ? 'works' : 'data']);
          const total = asInt(result?.total);
          if (asBool(response.error) !== false || !body || !result || !rows || total === undefined || total < 0) {
            throw new AppFailure('Pixiv 搜索响应结构变化，本次未发送');
          }
          if (rows.length > 0 && page < 10 && (artist ? page * 30 < total : page < (asInt(result.lastPage) ?? 1))) nextPage = page + 1;
          // Source search already matched keywords. No second topic check for global results.
          let sourceRows = rows;
          const popular = asDictionary(body.popular);
          if (qualitySearch && page === 1 && popular) {
            // Public search recommendations are not the daily ranking or a complete popularity sort.
            sourceRows = [...(asDictionaries(popular.permanent) ?? []), ...(asDictionaries(popular.recent) ?? []), ...rows];
          }
          const seen = new Set();
          candidates = sourceRows.flatMap(row => {
            const id = QQPolicy.identifier(row.id);
            const ai = asInt(row.aiType), width = asInt(row.width), height = asInt(row.height);
            if (id === undefined || asInt(row.xRestrict) !== 0 || asInt(row.illustType) !== 0 || ai === undefined || ai === 2 ||
                asBool(row.isMasked) === true || asBool(row.isUnlisted) !== false || width === undefined || height === undefined ||
                Math.max(width, height) < imageConfig.minLongEdge || Math.min(width, height) < imageConfig.minShortEdge ||
                (artist && QQPolicy.identifier(row.userId) !== request.query) || seen.has(id)) return [];
            seen.add(id);
            const tags = asStrings(row.tags) ?? [];
            if (curated && (QQArtworkLibrary.excludedTags(tags) || !QQArtworkLibrary.animeGirl({tags, artist: request.query, id}))) return [];
            if (artist && !QQArtworkLibrary.matches(filter, [...tags, asString(row.title) ?? ''])) return [];
            return [[id, undefined, undefined]];
          });
          if (randomArtist && filter === '') candidates = shuffled(candidates);
        } else if (request.mode === 'hot') {
          const suffix = page === 1 ? '' : `&p=${page}&date=${date}`;
          const ranking = await this.json('https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json' + suffix, beforeFetch, signal);
          const rows = asDictionaries(ranking.contents);
          const currentDate = asString(ranking.date) ?? (asInt(ranking.date) === undefined ? undefined : String(ranking.date));
          if (!rows || currentDate === undefined || count(currentDate) !== 8 || ![...currentDate].every(character => /\p{N}/u.test(character)) ||
              !(date === undefined || date === currentDate)) {
            throw new AppFailure('Pixiv 榜单结构或日期变化，本次未发送');
          }
          date = currentDate;
          const next = asInt(ranking.next);
          if (next !== undefined && next === page + 1 && next <= 10) nextPage = next;
          const rank = row => asInt(row.rank) ?? Number.MAX_SAFE_INTEGER;
          candidates = [...rows].sort((a, b) => rank(a) - rank(b)).flatMap(row => {
            const id = QQPolicy.identifier(row.illust_id), type = asDictionary(row.illust_content_type), position = asInt(row.rank);
            if (id === undefined || !type || position === undefined || position < 1 || position > 500 ||
                (asInt(type.sexual) ?? -1) !== 0 || asBool(type.lo) !== false || asBool(type.grotesque) !== false ||
                !QQArtworkLibrary.matches(filter, [...(asStrings(row.tags) ?? []), asString(row.title) ?? ''])) return [];
            // No artist roster or sparse ranking-tag gender gate: validate complete work details below.
            return [[id, position, currentDate]];
          });
        }
        for (const [id, rank, workDate] of candidates) {
          if (rejected.has(id) || inspected.has(id) || excludes(ledger, scope, 'pixiv:' + id, config.repeatDays)) continue;
          if (checked >= candidateLimit) {
            if (qualitySearch) break candidatePages;
            return prepared({request, caption: `本轮已检查 ${candidateLimit} 个候选，暂未找到合格新图。` + '/next 继续向后筛选；带新关键词可调整条件。\n' + QQArtworkRequest.navigation});
          }
          checked += 1; inspected.add(id);
          const work = await this.detail(id, imageConfig, {curated, ranked: request.mode === 'hot', beforeFetch, signal});
          if (!work || (request.mode === 'artist' && work.artistID !== request.query) ||
              (request.mode === 'featured' && !searching && !config.pixivArtistIDs.includes(work.artistID))) {
            rejected.add(id); continue;
          }
          work.rank = rank; work.date = workDate;
          if (qualitySearch && (work.bookmarks === undefined || work.bookmarks < config.effectiveSearchMinBookmarks)) {
            fallbackWorks.push(work); continue;
          }
          const ready = await this.prepareWork(work, {request, config: imageConfig, scope, ledger, beforeFetch, signal});
          if (ready) {
            if (searching) ready.caption = 'Pixiv 关键词搜索：' + QQArtworkLibrary.clean(filter) + (qualitySearch ? `（收藏 ≥ ${config.effectiveSearchMinBookmarks}）` : '') + '\n' + ready.caption;
            return ready;
          }
          rejected.add(id);
        }
        if (nextPage === undefined) break;
        page = nextPage;
      }
      if (qualitySearch) {
        // Reuse already fetched details. Unknown metrics sort last; never trust popularity tags.
        fallbackWorks.sort((a, b) => {
          if (a.bookmarks !== b.bookmarks) return (b.bookmarks ?? -1) - (a.bookmarks ?? -1);
          if (a.likes !== b.likes) return (b.likes ?? -1) - (a.likes ?? -1);
          if (a.views !== b.views) return (b.views ?? -1) - (a.views ?? -1);
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        for (const work of fallbackWorks) {
          const ready = await this.prepareWork(work, {request, config: imageConfig, scope, ledger, beforeFetch, signal});
          if (ready) {
            ready.caption = 'Pixiv 关键词搜索：' + QQArtworkLibrary.clean(filter) + `\n【保底结果】本轮候选没有可发送的收藏 ≥ ${config.effectiveSearchMinBookmarks} 作品，已放宽热度门槛；仍保留关键词、画质与去重要求。` + (work.bookmarks === undefined ? '来源未提供收藏数，不代表收藏为零。' : '') + '\n' + ready.caption;
            return ready;
          }
          rejected.add(work.id.slice('pixiv:'.length));
        }
        return prepared({request, caption: `本轮已检查 ${checked} 个候选；放宽热度后仍没有可用新图。未降低画质或改换关键词。/next 继续筛选，或 /search 新关键词 调整搜索。\n` + QQArtworkRequest.navigation});
      }
      return prepared({request, caption: request.mode === 'hot'
        ? '本轮公开日榜暂未取得未发过的可用图片；不限制画师和题材。可用 /hot 新关键词 改筛选，或 /search 关键词 搜索全站。\n' + QQArtworkRequest.navigation
        : '本轮候选中未找到符合筛选、画质和去重条件的新图片。可调整关键词后重试；不会用链接代替图片。\n' + QQArtworkRequest.navigation});
    } finally {
      this.rejectedWorks.set(key, {at: scannedAt, ids: new Set([...rejected].sort().slice(-1000))});
    }
  }

  async prepareWork(work, {request, config, scope, ledger, beforeFetch, signal}) {
    let downloaded = this.images.get(work.id);
    if (downloaded === undefined) {
      let transferError;
      for (const url of work.imageURLs) {
        let bytes;
        try { bytes = await this.fetch(url, 20_000_000, beforeFetch, signal); }
        catch (error) {
          if (error instanceof ArtworkAssetMissing) continue;
          if (error instanceof URLError && [URLError.timedOut, URLError.networkConnectionLost].includes(error.code)) {
            checkCancellation(signal); transferError = error;
            continue; // Try only the next image URL supplied by this work's public details.
          }
          throw error;
        }
        let image;
        try { image = QQArtworkLibrary.normalized(bytes, config); } catch { continue; }
        downloaded = image; break;
      }
      if (downloaded === undefined) {
        if (transferError) throw transferError;
        return undefined;
      }
      this.images.set(work.id, downloaded); this.imageOrder.push(work.id);
      while (this.imageOrder.length > 32) this.images.delete(this.imageOrder.shift());
    }
    const image = downloaded;
    let caption = `【作品】\n《${work.title}》\n画师：${work.author}\n`;
    if (work.date !== undefined) caption += `Pixiv 日榜 ${work.date}` + (work.rank !== undefined ? ` · 第 ${work.rank} 名` : '') + '\n';
    if (['search', 'id'].includes(request.mode)) {
      caption += [work.bookmarks !== undefined ? `收藏 ${work.bookmarks}` : undefined, work.likes !== undefined ? `点赞 ${work.likes}` : undefined,
        work.views !== undefined ? `浏览 ${work.views}` : undefined].filter(Boolean).join(' · ') + '\n';
    }
    caption += `原帖：${work.url}\n图片预览 · 已缩放，保留画面与水印。\n`;
    caption += QQArtworkRequest.navigation;
    caption += '\n作品 ID：' + work.id.slice('pixiv:'.length);
    const result = new QQArtworkPrepared({request: copyRequest(request), id: work.id, caption, image});
    return excludes(ledger, scope, work.id, config.repeatDays, result.hash) ? undefined : result;
  }

  async detail(id, config, {curated, ranked, beforeFetch, signal}) {
    const data = await this.json(`https://www.pixiv.net/ajax/illust/${id}`, beforeFetch, signal);
    const body = asDictionary(data.body);
    if (asBool(data.error) !== false || !body) return undefined;
    const ai = asInt(body.aiType), width = asInt(body.width), height = asInt(body.height);
    const title = asString(body.illustTitle), author = asString(body.userName), artist = QQPolicy.identifier(body.userId), urls = asDictionary(body.urls);
    if (QQPolicy.identifier(body.id) !== id || asInt(body.xRestrict) !== 0 || asInt(body.illustType) !== 0 ||
        ai === undefined || !(ranked || ai !== 2) || asBool(body.isUnlisted) !== false || width === undefined || height === undefined ||
        Math.max(width, height) < config.minLongEdge || Math.min(width, height) < config.minShortEdge ||
        title === undefined || (curated && !QQArtworkLibrary.illustrationTitle(title)) || author === undefined ||
        artist === undefined || !urls) return undefined;
    const tags = (asDictionaries(asDictionary(body.tags)?.tags) ?? []).map(tag => asString(tag.tag)).filter(tag => tag !== undefined);
    // Every mode, including a requested work ID, skips sexual or borderline works, not only R-18.
    if (QQArtworkLibrary.suggestive([...tags, title])) return undefined;
    if (curated && (QQArtworkLibrary.excludedTags(tags) || !QQArtworkLibrary.animeGirl({tags, artist, id}))) return undefined;
    const imageURLs = [];
    for (const key of ['original', 'regular']) {
      const value = asString(urls[key]);
      if (value !== undefined && QQArtworkLibrary.allowedURL(value) !== undefined && !imageURLs.includes(value)) imageURLs.push(value);
    }
    if (imageURLs.length === 0) return undefined;
    const metric = value => { const number = asInt(value); return number !== undefined && number >= 0 ? number : undefined; };
    return new Work({id: 'pixiv:' + id, title: QQArtworkLibrary.clean(title), author: QQArtworkLibrary.clean(author), artistID: artist,
      url: 'https://www.pixiv.net/artworks/' + id, imageURLs,
      bookmarks: metric(body.bookmarkCount), likes: metric(body.likeCount), views: metric(body.viewCount)});
  }

  static clean(text) {
    return prefix(text.replace(/[\r\n\x00-\x1f]|\[CQ:/g, ' '), 100);
  }
  static searchQuery(value) {
    const translations = {'初音未来': '初音ミク', '白发': '白髪', '银发': '銀髪', '黑发': '黒髪', '蓝发': '青髪',
      '粉发': 'ピンク髪', '金发': '金髪', '红发': '赤髪', '紫发': '紫髪', '长发': 'ロングヘア',
      '短发': 'ショートヘア', '双马尾': 'ツインテール', '女仆': 'メイド', '黑丝': '黒タイツ', '白丝': '白タイツ',
      '碧蓝档案': 'ブルーアーカイブ', '蔚蓝档案': 'ブルーアーカイブ', '星穹铁道': 'スターレイル'};
    let text = trim(value)
      .replace(/(?:不要|排除|不含|不带)\s*/gu, ' -')
      .replace(/[，,、+]/gu, ' ');
    for (const [word, tag] of Object.entries(translations).sort((a, b) => count(b[0]) - count(a[0]))) text = text.replaceAll(word, ' ' + tag + ' ');
    return text.replace(/-\s+/gu, '-').split(/\s+/u).filter(Boolean).join(' ');
  }
  /** matches(_:in:) — `matches(query, values)`. */
  static matches(query, values) {
    // Deterministic metadata filtering: each positive term is required, negatives are excluded.
    const groups = [
      ['初音未来', '初音ミク', 'hatsune miku', '雪初音', '雪ミク'], ['原神', 'genshin impact', 'genshin'],
      ['崩坏星穹铁道', '星穹铁道', 'スターレイル', 'honkai star rail'], ['碧蓝档案', '蔚蓝档案', 'ブルーアーカイブ', 'ブルアカ', 'blue archive'],
      ['白发', '白髪', '银发', '銀髪', 'white hair', 'silver hair'], ['黑发', '黒髪', 'black hair'],
      ['蓝发', '青髪', 'blue hair'], ['粉发', 'ピンク髪', 'pink hair'], ['金发', '金髪', 'blonde hair', 'blond hair'],
      ['红发', '赤髪', 'red hair'], ['紫发', '紫髪', 'purple hair'], ['长发', 'ロングヘア', 'long hair'],
      ['短发', 'ショートヘア', 'short hair'], ['双马尾', 'ツインテール', 'twintails'],
      ['猫耳', 'ネコミミ', 'ねこみみ', 'cat ears'], ['狐耳', 'きつね耳', '狐娘', 'fox ears'],
      ['兽耳', 'ケモミミ', '獣耳', 'animal ears'], ['女仆', 'メイド', 'maid'], ['和服', '着物', 'kimono'],
      ['黑丝', '黒タイツ', 'black tights'], ['白丝', '白タイツ', 'white tights'],
      ['美少女', '女の子', 'girl', 'girls', '少女'], ['动漫', '二次元', 'anime'], ['游戏', 'ゲーム', 'game']
    ];
    const generic = new Set(['美少女', '动漫', '二次元', '游戏', '动漫美少女', '游戏美少女']);
    const cleaned = query.toLowerCase()
      .replace(/(?:请帮我|帮我|给我|来一张|来点|找一张|我想看|想看|我要|看看|一张)/gu, '')
      .replace(/(?:不要|排除|不含|不带)\s*/gu, '-')
      .replace(/(?:并且|以及|的|和|[，,、+])/gu, ' ');
    const aliases = groups.flat().sort((a, b) => count(b) - count(a)).map(escapeRegExp).join('|');
    const tokens = cleaned.match(new RegExp('-?(?:' + aliases + ')|[^\\s]+', 'gu')) ?? [];
    const joined = values.join(' ').toLowerCase();
    return tokens.every(token => {
      const negative = token.startsWith('-'), word = negative ? token.slice(1) : token;
      if (word === '') return false;
      if (!negative && generic.has(word)) return true;
      const found = (groups.find(group => group.includes(word)) ?? [word]).some(alias => joined.includes(alias));
      return negative ? !found : found;
    });
  }
  static illustrationTitle(title) {
    return !/(お品書き|新刊|宣伝|サンプル|通販|委託|sample|告知)/iu.test(title);
  }
  static suggestive(tags) {
    return tags.some(tag => /(r-?1[58]|nsfw|裸|エロ|えっち|露出|乳首|下着|パンツ|ぱんつ|水着|ビキニ|おっぱい|巨乳|爆乳|谷間|お尻|尻|ふともも|太もも|セクシー|ロリ|ショタ|性器|sexy|ecchi|lingerie|bikini|swimsuit|underwear|panties|cleavage|breasts|fanservice|涩图|色图|擦边|福利)/iu.test(tag));
  }
  static excludedTags(tags) {
    return tags.some(tag => /(r-?18|nsfw|裸|エロ|露出|乳首|下着|パンツ|水着|ロリ|ショタ|ビキニ|おっぱい|男の子|男性|boy|gore|guro|リョナ|性器)/iu.test(tag));
  }
  /** allowedURL(_:) → the parsed URL (foundation.mjs swiftURL) or undefined. */
  static allowedURL(value) {
    const u = swiftURL(value);
    if (!u || u.scheme !== 'https' || u.user !== undefined || u.password !== undefined || u.port !== undefined) return undefined;
    if (u.host === 'www.pixiv.net' && (u.path === '/ranking.php' || u.path.startsWith('/ajax/illust/') || u.path.startsWith('/ajax/user/') || u.path.startsWith('/ajax/search/illustrations/'))) return u;
    if (u.host === 'i.pximg.net' && (u.path.startsWith('/img-original/') || u.path.startsWith('/img-master/'))) return u;
    return undefined;
  }

  async json(value, beforeFetch, signal) {
    const cached = this.cache.get(value);
    if (cached && since(cached.at) < 1800) { checkCancellation(signal); return cached.object; }
    const bytes = await this.fetch(value, 3_000_000, beforeFetch, signal);
    const object = asDictionary(jsonObject(bytes));
    if (!object) throw new AppFailure('插画来源响应结构无效');
    if (this.cache.size >= 100) {
      let oldest;
      for (const [entry, item] of this.cache) if (!oldest || item.at < oldest[1].at) oldest = [entry, item];
      this.cache.delete(oldest[0]);
    }
    this.cache.set(value, {at: new Date(), object});
    return object;
  }

  async fetch(value, limit, beforeFetch = () => {}, signal) {
    const url = QQArtworkLibrary.allowedURL(value);
    if (!url) throw new AppFailure('插画下载地址不受支持');
    const host = url.host;
    const blocked = this.blockedUntil.get(host);
    if (blocked !== undefined && blocked > new Date()) throw new AppFailure('插画来源限流冷却中，请稍后再试');
    const wait = this.spacing - since(this.lastFetch);
    if (wait > 0) await taskSleep(wait * 1000, signal);
    await beforeFetch(); this.lastFetch = new Date();
    const headers = {'User-Agent': 'Mozilla/5.0'};
    if (host.endsWith('pixiv.net') || host === 'i.pximg.net') headers.Referer = 'https://www.pixiv.net/';
    // The shared receiver bounds bytes while receiving and rejects redirects; resourceTimeout bounds the whole
    // transfer, not only idle time between bytes.
    const {data, response} = await boundedData(this.session, {url: url.href, headers, timeoutInterval: 15, resourceTimeout: 20, signal}, limit);
    if ([403, 429].includes(response.statusCode)) {
      const retry = response.value('Retry-After') ?? '';
      const seconds = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(retry) ? Number(retry) : 300;
      this.blockedUntil.set(host, new Date(Date.now() + Math.min(3600, Math.max(60, seconds)) * 1000));
    }
    if (host === 'i.pximg.net' && [404, 410].includes(response.statusCode)) throw new ArtworkAssetMissing();
    if (response.statusCode !== 200 || response.expectedContentLength > limit) throw new AppFailure(`插画来源暂不可用（HTTP ${response.statusCode}），未绕过限制或自动重试`);
    checkCancellation(signal);
    return data;
  }
  /** normalized(_:config:) */
  static normalized(data, config) {
    return LinuxImages.process(data, 'artwork', {minLongEdge: config.minLongEdge, minShortEdge: config.minShortEdge})[0];
  }
  // Selected and visually checked anime/game female character works; all still pass current detail filters.
  static featuredIDs = ['53325959', '50533824', '49590533', '73164819', '29118503', '28260838'];
  /** animeGirl(tags:artist:id:) — `animeGirl({tags, artist, id})`. */
  static animeGirl({tags, artist, id}) {
    const joined = tags.join(' ');
    if (/(実写|写真|コスプレ|cosplay|photograph|男の子|男性|男主|boys?|風景のみ|landscape.only)/iu.test(joined)) return false;
    if (QQArtworkLibrary.featuredIDs.includes(id)) return true; // Human-reviewed subject/style, not inferred from character gender.
    const female = /(女の子|少女|girls?|女性|初音ミク|博麗霊夢|霧雨魔理沙|ウマ娘)/iu.test(joined);
    const theme = /(アニメ|anime|manga|オリジナル|二次元|美少女|ゲーム|game|原神|genshin|崩壊|崩坏|スターレイル|アークナイツ|明日方舟|ブルーアーカイブ|碧蓝档案|ブルアカ|アズールレーン|碧蓝航线|東方|Fate|FGO|初音ミク|VOCALOID|ウマ娘|リゼロ|アイドルマスター)/iu.test(joined) ||
      QQArtworkLibrary.artists.some(item => item.id === artist);
    return female && theme;
  }
}
export {Artist as QQArtworkLibrary_Artist, Work as QQArtworkLibrary_Work};

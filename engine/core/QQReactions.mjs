import {count, graphemes} from '../swift.mjs';
import {container, decodeArray, decodeInt, decodeString, decodeType, deepClone, deepEqual, isNumber, isWhitespace, trimmed,
  trimmedSpaces} from './_support.mjs';
import {CoreError} from './Domain.mjs';
import {QQPolicy} from './QQPolicy.mjs';

/**
 * Emoji reactions on group members' messages ("贴表情"). IDs are QQ's own: a system face ID
 * (e.g. 147 棒棒糖) or, for emoji-type reactions, the Unicode code point in decimal (128051 🐳).
 */
export class QQReactionEmoji {
  constructor({id, name, weight, hint} = {}) {
    this.id = id; this.name = name;
    /** The owner's preference, 0 (never) to 10 (a favourite). The model reads it as a hint, not a dice weight. */
    this.weight = weight;
    /** When it fits, in a few words, for the model. */
    this.hint = hint;
  }
  static decode(json) {
    const c = container(json, 'QQReactionEmoji');
    return new QQReactionEmoji({id: c.need('id', decodeString), name: c.need('name', decodeString), weight: c.need('weight', decodeInt),
      hint: c.maybe('hint', decodeString)});
  }
  toJSON() { return {id: this.id, name: this.name, weight: this.weight, hint: this.hint}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

/**
 * Everything the agent can react with: QQ's own faces (faces.json, loaded into `QQPolicy.faceNames`) and the
 * emoji QQ offers as reactions, picked by name. The owner's favourites come first and keep their hints.
 */
export class QQReactionCatalog {
  /** QQ's emoji-type reactions, with names to search by ([{id, name}]). */
  static emoji = [
    ['9728', '晴天☀'], ['9749', '咖啡☕'], ['9786', '可爱☺'], ['10024', '闪光✨'], ['10060', '错误❌'], ['10068', '问号❓'],
    ['127801', '玫瑰🌹'], ['127817', '西瓜🍉'], ['127822', '苹果🍎'], ['127827', '草莓🍓'], ['127836', '拉面🍜'], ['127838', '面包🍞'],
    ['127847', '刨冰🍧'], ['127866', '啤酒🍺'], ['127867', '干杯🍻'], ['127881', '庆祝🎉'], ['128027', '虫🐛'], ['128046', '牛🐮'],
    ['128051', '鲸鱼🐳'], ['128053', '猴🐵'], ['128074', '拳头👊'], ['128076', '好的👌'], ['128077', '厉害👍'], ['128079', '鼓掌👏'],
    ['128147', '爱心💓'], ['128157', '礼物💝'], ['128164', '睡觉💤'], ['128166', '水💦'], ['128168', '吹气💨'], ['128170', '肌肉💪'],
    ['128293', '火🔥'], ['128513', '呲牙😁'], ['128514', '笑哭😂'], ['128516', '高兴😄'], ['128522', '嘿嘿😊'], ['128524', '羞涩😌'],
    ['128527', '哼哼😏'], ['128530', '不屑😒'], ['128531', '汗😓'], ['128532', '失落😔'], ['128536', '飞吻😘'], ['128538', '亲亲😚'],
    ['128540', '淘气😜'], ['128541', '吐舌😝'], ['128557', '大哭😭'], ['128560', '紧张😰'], ['128563', '瞪眼😳']
  ].map(([id, name]) => ({id, name}));

  /** The favourites (weight above 0), then every other face and emoji; ones the owner set to 0 are left out. */
  static all(favourites) {
    const never = new Set(favourites.filter(item => item.weight <= 0).map(item => item.id));
    const seen = new Set(never), items = [];
    const insert = id => !seen.has(id) && (seen.add(id), true);
    for (const item of favourites) if (item.weight > 0 && insert(item.id)) items.push(item);
    const number = key => /^[+-]?\d+$/.test(key) ? Number(key) : 0; // Int(key) ?? 0
    const faces = Object.entries(QQPolicy.faceNames).sort((a, b) => number(a[0]) - number(b[0]));
    for (const [id, name] of faces) if (insert(id)) items.push(new QQReactionEmoji({id, name, weight: 0}));
    for (const {id, name} of QQReactionCatalog.emoji) if (insert(id)) items.push(new QQReactionEmoji({id, name, weight: 0}));
    return items;
  }

  /** What the agent wrote (a name, an emoji, or an id) as one of `items`. */
  static resolve(written, items) {
    let text = trimmed(written);
    for (const wrapper of ['[', ']', '【', '】', '/', 'QQ表情：', '表情：']) text = text.replaceAll(wrapper, '');
    text = trimmedSpaces(text.replaceAll('️', ''));
    if (text === '') return undefined;
    const byID = items.find(item => item.id === text);
    if (byID) return byID;
    const lowered = text.toLowerCase();
    const byName = items.find(item => item.name.toLowerCase() === lowered);
    if (byName) return byName;
    // An emoji typed as itself: by its code point, or by the name it carries in the list (鲸鱼🐳).
    const scalars = Array.from(text);
    if (scalars.length === 1 && scalars[0].codePointAt(0) > 1000) {
      const value = String(scalars[0].codePointAt(0));
      const item = items.find(item => item.id === value || item.name.endsWith(text));
      if (item) return item;
    }
    // The name without the emoji the list adds to it.
    return items.find(item => {
      const bare = Array.from(item.name).filter(c => { const v = c.codePointAt(0); return v < 0x2000 || (v >= 0x4E00 && v <= 0x9FFF); }).join('');
      return bare.toLowerCase() === lowered;
    });
  }

  /** Names that match `query`: whole word first, then those sharing the most characters with it. */
  static search(query, items, limit = 20) {
    const words = [];
    let word = '';
    for (const c of graphemes(query.toLowerCase())) {
      if (isWhitespace(c) || c === '，' || c === ',') { if (word) words.push(word); word = ''; } else word += c;
    }
    if (word) words.push(word);
    if (words.length === 0) return items.slice(0, Math.max(0, limit));
    const scored = items.flatMap(item => {
      const name = item.name.toLowerCase(), hint = (item.hint ?? '').toLowerCase();
      let score = 0;
      for (const word of words) {
        if (name === word) score += 100; else if (name.includes(word) || word.includes(name)) score += 40;
        if (hint.includes(word)) score += 30;
        const nameCharacters = new Set(graphemes(name));
        score += new Set(graphemes(word).filter(c => nameCharacters.has(c))).size * 5;
      }
      return score > 0 ? [[item, score + Math.min(item.weight, 10)]] : [];
    });
    return scored.sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, limit)).map(([item]) => item);
  }
}

/**
 * The owner's favourite reactions ("常用表情"): the agent may react with any QQ face or emoji
 * (QQReactionCatalog), and these come first, with the owner's preference and a hint for when they fit.
 */
export class QQReactionConfig {
  /** `emojis`: the owner's saved preferences; `effectiveEmojis` fills in the rest of the catalogue. */
  constructor({emojis = QQReactionConfig.catalog.map(item => item.clone())} = {}) { this.emojis = emojis; }

  /** What the bot can react with. The owner's favourites (棒棒糖, 鲸鱼, 问号, 拳头) weigh most. */
  static catalog = [
    ['147', '棒棒糖', 5, '夸可爱、给奖励、甜'],
    ['128051', '鲸鱼', 5, '你自己的招牌：打招呼、认同、卖萌、提到你'],
    ['10068', '问号', 5, '没看懂、离谱、你在说什么'],
    ['120', '拳头', 5, '加油、冲、放狠话、开玩笑要揍人'],
    ['182', '笑哭', 2, '真的好笑'],
    ['76', '赞', 2, '认同、干得好'],
    ['271', '吃瓜', 1, '围观八卦、看戏'],
    ['124', 'OK', 1, '收到、可以、没问题'],
    ['319', '比心', 1, '感谢、示好'],
    ['264', '捂脸', 2, '尴尬、社死、没眼看'],
    ['269', '暗中观察', 2, '潜水围观、有人提到你但没叫你'],
    ['299', '牛啊', 2, '很强、佩服'],
    ['320', '庆祝', 2, '好消息、成功了、过生日'],
    ['285', '摸鱼', 2, '上班上课摸鱼、偷懒'],
    ['179', 'doge', 2, '调侃、坏笑、阴阳怪气的玩笑'],
    ['106', '委屈', 1, '被欺负、可怜巴巴'],
    ['8', '睡', 1, '困了、晚安、熬夜'],
    ['273', '我酸了', 1, '羡慕、晒东西'],
    ['267', '头秃', 1, '作业考试加班太难'],
    ['262', '脑阔疼', 1, '头疼、麻烦事'],
    ['66', '爱心', 1, '温暖、喜欢、安慰'],
    ['63', '玫瑰', 1, '祝福、道歉、送花'],
    ['128293', '火', 1, '燃、太强了、火了'],
    ['128170', '肌肉', 1, '加油、练、硬气']
  ].map(([id, name, weight, hint]) => new QQReactionEmoji({id, name, weight, hint}));

  /** The catalogue with the owner's saved preferences, followed by any extra IDs the owner added. */
  get effectiveEmojis() {
    const saved = new Map();
    for (const item of this.emojis) if (!saved.has(item.id)) saved.set(item.id, item);
    const listed = QQReactionConfig.catalog.map(original => {
      const item = original.clone(); const own = saved.get(item.id); if (own) item.weight = own.weight; return item;
    });
    const known = new Set(QQReactionConfig.catalog.map(item => item.id));
    return [...listed, ...this.emojis.filter(item => !known.has(item.id))];
  }

  validate() {
    if (!(this.emojis.length <= 60 && this.emojis.every(item => item.weight >= 0 && item.weight <= 10 && count(item.id) >= 1 && count(item.id) <= 7 &&
      graphemes(item.id).every(isNumber) && count(item.name) <= 20 && count(item.hint ?? '') <= 40))) {
      throw CoreError.invalid('常用表情：最多 60 个，偏好 0–10');
    }
  }
  static decode(json) {
    const c = container(json, 'QQReactionConfig');
    return new QQReactionConfig({emojis: c.need('emojis', decodeArray(decodeType(QQReactionEmoji)))});
  }
  toJSON() { return {emojis: this.emojis}; }
  clone() { return deepClone(this); }
  equals(other) { return deepEqual(this, other); }
}

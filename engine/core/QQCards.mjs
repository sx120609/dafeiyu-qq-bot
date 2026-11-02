import {prefix} from '../swift.mjs';
import {asObject, asString, jsonObject, trimmed} from './_support.mjs';

// QQ's card messages (json "ark" cards and the older xml ones) as one readable line for the timeline: what kind
// of card it is and the title, description and link shown on it. Generic on purpose: every app puts the same few
// fields (title, desc, tag, jumpUrl…) somewhere under `meta`, so unknown apps still read well.

const clean = (value, length) => {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return undefined;
  const text = trimmed(value.replace(/\s+/gu, ' '));
  return text === '' ? undefined : prefix(text, length);
};
const isLink = value => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
const firstLink = (...values) => values.find(isLink)?.trim();
const join = parts => parts.filter(part => part !== undefined && part !== '').join('｜');
const unbase64 = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(value)) return value;
  try { const text = Buffer.from(value, 'base64').toString('utf8'); return /�/.test(text) ? value : text; } catch { return value; }
};
const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
/** XML/HTML character references, decoded. */
export const decodeEntities = text => String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
  }
  return entities[name.toLowerCase()] ?? whole;
});

/** The meta entry that holds the card's content: the first object under `meta` (detail_1, news, music, contact…). */
const mainEntry = meta => {
  if (!meta) return {};
  for (const key of ['detail_1', 'news', 'music', 'contact', 'Location.Search', 'mannounce', 'detail', 'video', 'feed', 'data']) {
    const entry = asObject(meta[key]);
    if (entry) return entry;
  }
  return Object.values(meta).map(asObject).find(Boolean) ?? meta;
};
/** Readable strings anywhere in an object, for apps whose layout is unknown. */
const scan = (value, found = [], depth = 0) => {
  if (depth > 4 || found.length >= 6) return found;
  const object = asObject(value);
  if (!object) return found;
  for (const [key, item] of Object.entries(object)) {
    if (found.length >= 6) break;
    if (typeof item === 'string' && ['title', 'desc', 'summary', 'text', 'name', 'nickname', 'tag', 'brief', 'content'].includes(key)) {
      const text = clean(item, 120);
      if (text !== undefined && !found.includes(text)) found.push(text);
    } else if (typeof item === 'object' && item !== null) scan(Array.isArray(item) ? Object.fromEntries(item.entries()) : item, found, depth + 1);
  }
  return found;
};

export class QQCards {
  /**
   * A json (ark) card. Returns {text, resid}: `resid` is set for a 合并转发 card, which read_forward can open.
   * `raw` is the segment's `data` field: a JSON string (or an object).
   */
  static json(raw) {
    const card = typeof raw === 'string' ? jsonObject(raw) : asObject(raw);
    if (!card) return {text: '[卡片消息]'};
    const app = asString(card.app) ?? '', view = asString(card.view) ?? '';
    const prompt = clean(card.prompt, 80);
    const meta = asObject(card.meta);
    const entry = mainEntry(meta);
    const title = clean(entry.title, 80), desc = clean(entry.desc ?? entry.summary, 200), tag = clean(entry.tag ?? entry.source ?? asObject(entry.host)?.nick, 30);
    const link = firstLink(entry.qqdocurl, entry.jumpUrl, entry.jump_url, entry.url, entry.musicUrl, asObject(card.config)?.url);
    const has = word => app.toLowerCase().includes(word) || view.toLowerCase().includes(word);
    if (app === 'com.tencent.multimsg' || has('multimsg')) {
      const detail = asObject(meta?.detail) ?? entry;
      const lines = (Array.isArray(detail.news) ? detail.news : []).map(item => clean(asObject(item)?.text, 60)).filter(Boolean).slice(0, 4);
      const resid = asString(detail.resid) ?? asString(detail.uniseq);
      return {text: '[合并转发的聊天记录' + (clean(detail.source, 40) ? '：' + clean(detail.source, 40) : '') +
        (lines.length ? '（' + lines.join('；') + (clean(detail.summary, 30) ? '；' + clean(detail.summary, 30) : '') + '）' : '') + '，要看全文用 read_forward]', resid};
    }
    if (app === 'com.tencent.mannounce' || meta?.mannounce) {
      const notice = asObject(meta?.mannounce) ?? entry;
      const encoded = notice.encode === 1 || notice.encode === '1';
      const noticeTitle = clean(encoded ? unbase64(notice.title) : notice.title, 80), body = clean(encoded ? unbase64(notice.text) : notice.text, 300);
      return {text: '[群公告' + (join([noticeTitle, body]) ? '：' + join([noticeTitle, body]) : '') + ']'};
    }
    if (meta?.['Location.Search'] || app === 'com.tencent.map' || has('location')) {
      const place = asObject(meta?.['Location.Search']) ?? entry;
      return {text: '[位置：' + (join([clean(place.name, 60), clean(place.address, 120)]) || prompt || '一个地点') + ']'};
    }
    if (meta?.music || view === 'music' || has('music')) {
      const music = asObject(meta?.music) ?? entry;
      const name = clean(music.title, 80), singer = clean(music.desc, 60);
      const song = name !== undefined && singer !== undefined ? name + ' - ' + singer : name ?? singer;
      return {text: `[分享音乐${clean(music.tag, 20) ? '·' + clean(music.tag, 20) : ''}：` + (join([song, firstLink(music.jumpUrl, music.musicUrl)]) || prompt || '一首歌') + ']'};
    }
    if (app === 'com.tencent.troopsharecard' || (meta?.contact && /群/.test(asString(asObject(meta.contact).tag) ?? prompt ?? ''))) {
      const contact = asObject(meta?.contact) ?? entry;
      return {text: '[推荐群聊：' + (join([clean(contact.nickname, 60), clean(contact.contact, 60)]) || prompt || '一个群') + ']'};
    }
    if (meta?.contact || app === 'com.tencent.contact.lua' || view === 'contact') {
      const contact = asObject(meta?.contact) ?? entry;
      return {text: '[推荐联系人：' + (join([clean(contact.nickname, 60), clean(contact.contact, 60)]) || prompt || '一个人') + ']'};
    }
    let kind = '卡片';
    if (has('miniapp') || asString(entry.appid) !== undefined || /小程序/.test(prompt ?? '')) kind = 'QQ小程序' + (title ? '·' + title : '');
    else if (has('docs') || has('tdoc') || /文档/.test(prompt ?? '')) kind = '腾讯文档';
    else if (has('channel') || has('guild') || has('forum') || /频道/.test(prompt ?? '')) kind = '频道分享';
    else if (has('gamecenter') || has('game')) kind = '游戏分享';
    else if (has('qqpay') || has('wallet') || /红包|转账/.test(prompt ?? '')) kind = /转账/.test(prompt ?? '') ? '转账' : '红包';
    else if (view === 'news' || app === 'com.tencent.structmsg' || link !== undefined) kind = '分享链接' + (tag ? '·' + tag : '');
    // A mini-program's title is its app name (哔哩哔哩), the desc is what was shared.
    const shown = kind.startsWith('QQ小程序') ? [desc, link] : [title, desc, link];
    let body = join(shown);
    if (body === '') body = join(scan(meta));
    // QQ's one-line prompt ("[QQ小程序]哔哩哔哩") already says what kind of card it is.
    if (body === '' && prompt !== undefined) return {text: `[卡片：${prompt}]`};
    if (kind === '卡片' && prompt !== undefined) kind += '·' + prompt;
    return {text: `[${kind}` + (body === '' ? '' : '：' + prefix(body, 400)) + ']'};
  }

  /** An xml card (older link shares, music, 合并转发 with serviceID 35). Returns {text, resid}. */
  static xml(raw) {
    const xml = typeof raw === 'string' ? raw : '';
    if (xml.trim() === '') return {text: '[卡片消息]'};
    const attribute = name => { const match = xml.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'iu')) ?? xml.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'iu')); return match ? decodeEntities(match[1]) : undefined; };
    const elements = name => [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'giu'))].map(match => clean(decodeEntities(match[1].replace(/<[^>]+>/gu, '')), 120)).filter(Boolean);
    const titles = elements('title'), summaries = elements('summary');
    const brief = clean(attribute('brief'), 80), link = firstLink(attribute('url'), attribute('actionData'));
    const sourceName = xml.match(/<source\b[^>]*\bname\s*=\s*"([^"]*)"/iu)?.[1];
    const source = sourceName === undefined ? undefined : clean(decodeEntities(sourceName), 30);
    const resid = attribute('m_resid');
    if (resid !== undefined || attribute('serviceID') === '35' || /multimsg/iu.test(attribute('action') ?? '')) {
      return {text: '[合并转发的聊天记录' + (titles.length ? '（' + titles.slice(0, 5).join('；') + '）' : '') + '，要看全文用 read_forward]', resid};
    }
    const kind = attribute('serviceID') === '2' || /music/iu.test(xml.slice(0, 400)) ? '分享音乐' : link !== undefined ? '分享链接' : '卡片';
    const body = join([titles.slice(0, 2).join(' '), summaries.slice(0, 2).join(' '), link, source ? '来自' + source : undefined]);
    return {text: `[${kind}` + (body !== '' ? '：' + prefix(body, 400) : brief !== undefined ? '：' + brief : '') + ']'};
  }

  /** A bot's button keyboard (inline_keyboard): the button labels. */
  static keyboard(data) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const labels = rows.flatMap(row => Array.isArray(asObject(row)?.buttons) ? row.buttons : []).map(button => clean(asObject(button)?.label, 20)).filter(Boolean);
    return labels.length ? '[按钮：' + labels.slice(0, 12).join('｜') + ']' : '[按钮]';
  }
}

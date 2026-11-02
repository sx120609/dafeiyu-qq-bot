import {count, prefix} from '../swift.mjs';
import {asDouble, asObject, asObjects, asString, serialize} from './_support.mjs';
import {QQIncomingImage, QQPolicy, parseInt64} from './QQPolicy.mjs';
import {QQMemoryEvent} from './QQMemoryBook.mjs';

/**
 * A scoped server snapshot, bounded at the current incoming message (never future replies).
 * `messageIDs` is a Set; `earlierImages` is [{label, images}].
 */
export class QQPrivateContext {
  constructor({text, memoryText, messageIDs, memoryEvents, earlierImages} = {}) {
    this.text = text; this.memoryText = memoryText; this.messageIDs = messageIDs; this.memoryEvents = memoryEvents; this.earlierImages = earlierImages;
  }
  /**
   * Rows that do not belong to this private conversation are skipped rather than voiding the whole
   * snapshot; `since` drops everything before a /new or /clear. `excluding` and `botMessageIDs` are Sets.
   */
  static read(rows, message, selfID, excluding = new Set(), botMessageIDs = new Set(), ownershipSince = Infinity, since = 0) {
    if (!(excluding instanceof Set)) excluding = new Set(excluding ?? []);
    if (!(botMessageIDs instanceof Set)) botMessageIDs = new Set(botMessageIDs ?? []);
    const identifier = QQPolicy.identifier;
    const authorOf = row => identifier(asObject(row.sender)?.user_id);
    if (message.group || rows.length > 50) return undefined;
    const anchor = rows.findIndex(row => identifier(row.message_id) === message.id);
    if (anchor < 0 || authorOf(rows[anchor]) !== message.sender) return undefined;
    const entries = [], ids = new Set(), memoryEvents = [];
    // The friend's pictures from the last 15 minutes go along with the request again, so the bot can
    // still look at what it already talked about.
    const earlier = [];
    let earlierCount = 0;
    for (const row of rows.slice(0, anchor).slice(-40).reverse()) {
      if (!(earlierCount < 2)) continue;
      const id = identifier(row.message_id), time = asDouble(row.time), segments = asObjects(row.message);
      if (!(row.message_type === 'private' && identifier(row.self_id) === selfID && id !== undefined && id !== message.id &&
        authorOf(row) === message.target && time !== undefined && time >= since && message.time - time <= 15 * 60 && segments)) continue;
      const images = segments.flatMap(segment => {
        const data = asObject(segment.data), file = data ? asString(data.file) : undefined;
        if (segment.type !== 'image' || file === undefined || file === '' || count(file) > 2048) return [];
        return [new QQIncomingImage({file, url: asString(data.url)})];
      }).slice(0, 2 - earlierCount);
      if (images.length === 0) continue;
      earlier.push({label: '消息 ' + id, images}); earlierCount += images.length;
    }
    earlier.reverse();
    const shown = new Set(earlier.map(item => item.label.slice('消息 '.length)));
    for (const row of rows.slice(0, anchor + 1).slice(-40)) {
      const id = identifier(row.message_id), author = authorOf(row), segments = asObjects(row.message);
      if (!(row.message_type === 'private' && row.sub_type === 'friend' && identifier(row.self_id) === selfID &&
        id !== undefined && parseInt64(id) !== undefined && author !== undefined && (author === selfID || author === message.target) && segments)) continue;
      const user = identifier(row.user_id);
      if (user !== undefined && user !== author) continue;
      const rowTime = asDouble(row.time);
      if (id !== message.id && rowTime !== undefined && rowTime < since) continue;
      if (ids.has(id)) continue;
      ids.add(id);
      if (id === message.id) continue; // Current text and actual images are supplied separately.
      let text = '';
      for (const segment of segments) {
        const data = asObject(segment.data) ?? {};
        const type = asString(segment.type);
        switch (type) {
          case 'text': text += prefix(asString(data.text) ?? '', Math.max(0, 800 - count(text))); break;
          case 'image':
            text += QQPolicy.stickerText(data);
            text += author === selfID ? '[本账号发出的图片/表情]'
              : shown.has(id) ? `[图片：画面随本轮附上，标注为消息 ${id}]`
                : '[图片：这次没重新附上画面。你之前回复里要是描述过它，那是你当时看着图说的，不是编的]';
            break;
          case 'reply': text += '[引用此前消息]'; break;
          case 'face': text += QQPolicy.faceText(data); break;
          case undefined: text += '[其他消息]'; break;
          default: text += QQPolicy.placeholder(type, data);
        }
      }
      let speaker;
      if (author !== selfID) speaker = '[PEER] 当前好友';
      else if (botMessageIDs.has(id)) speaker = '[BOT] 大肥鱼此前自动回复';
      else if (rowTime !== undefined && rowTime >= ownershipSince) speaker = '[OWNER] 本账号主人/开发者的人工发言';
      else speaker = '[SELF_UNKNOWN] 本账号旧发言，无法区分主人或机器人，勿强行归属';
      const role = author !== selfID ? 'PEER' : botMessageIDs.has(id) ? 'BOT' : speaker.startsWith('[OWNER]') ? 'OWNER' : 'SELF_UNKNOWN';
      memoryEvents.push(new QQMemoryEvent({id, subject: role, text, at: new Date((rowTime ?? message.time) * 1000)}));
      // The message number lets tools open what it carries (a file, a voice note, a forward).
      const item = {message: id, speaker, recipient: author === selfID ? '[PEER] 当前好友' : '[SELF] 本账号（大肥鱼与主人共用）', text: prefix(text, 1000)};
      entries.push({id, line: serialize(item, {sortedKeys: true})});
    }
    while (entries.reduce((sum, entry) => sum + count(entry.line), 0) > 10000) entries.shift();
    return new QQPrivateContext({text: entries.map(entry => entry.line).join('\n'),
      memoryText: entries.filter(entry => !excluding.has(entry.id)).map(entry => entry.line).join('\n'), messageIDs: ids, memoryEvents, earlierImages: earlier});
  }
}

import {count, prefix} from '../swift.mjs';
import {iso8601, serialize, trimmed, trimmedSpaces} from './_support.mjs';
import {QQMemoryBook} from './QQMemoryBook.mjs';

const secondsBetween = (later, earlier) => (later.getTime() - earlier.getTime()) / 1000;
const hasImages = message => message !== undefined && message.images.length > 0;

/**
 * One immutable group timeline ending at the admitted trigger, shared by direct and proactive replies.
 * Swift's `init?(events:through:messages:account:)`: `new QQGroupContext({events, through, messages, account})` throws
 * when `through` is not among the events; `QQGroupContext.fromEvents(...)` returns undefined instead (the failable init).
 * `messages` is an object keyed by message ID; `recentImages`/`followupImages` are [{label, images}].
 */
export class QQGroupContext {
  /** The failable init: (events, through, messages = {}, account = '') or ({events, through, messages, account}). */
  /** admins: the bot admins' QQ numbers, marked on their lines (11-09: "必须遵循后台配置的管理员的意志"). */
  static fromEvents(events, through, messages = {}, account = '', admins = []) {
    const fields = Array.isArray(events) ? {events, through, messages, account, admins} : events;
    return fields.events.some(event => event.id === fields.through) ? new QQGroupContext(fields) : undefined;
  }
  constructor({events, through: id, messages = {}, account = '', admins = []} = {}) {
    this.admins = new Set(admins);
    const anchor = events.findIndex(event => event.id === id);
    if (anchor < 0) throw new Error(`QQGroupContext: no event ${id}`);
    const end = events[anchor].at;
    const ordered = events.slice(0, anchor + 1).filter(event => event.at <= end).sort((a, b) => a.at - b.at);
    const selected = [];
    let previous = end;
    for (const event of ordered.reverse()) {
      // Sparse messages must not keep a conversation from an hour ago alive.
      if (!(secondsBetween(end, event.at) <= 30 * 60 && secondsBetween(previous, event.at) <= 10 * 60 && selected.length < 32)) break;
      selected.push(event); previous = event.at;
    }
    this.events = [...selected].reverse();
    const kept = new Set(selected.map(event => event.id));
    this.messages = Object.fromEntries(Object.entries(messages).filter(([key]) => kept.has(key)));
    this.account = account;
    this.anchorID = id;
    // Proactive turns only look at fresh attachments, so an old media topic is not revived.
    this.recentImages = QQGroupContext.attachments(selected, this.messages, end, 180);
    /**
     * Images posted earlier in the conversation, shown again when someone talks to the bot so it can
     * look at what it already commented on instead of doubting its own earlier reply.
     */
    this.followupImages = QQGroupContext.attachments(selected.filter(event => event.id !== id), this.messages, end, 15 * 60);
    this.hasRecentMedia = selected.slice(0, 3).some(event => event.subject !== 'BOT' && (hasImages(messages[event.id]) ||
      event.text.includes('（对方发来图片或表情包') || event.text.includes('（群成员发送了媒体或卡片')));
    const lastBot = this.events.findLastIndex(event => event.subject === 'BOT');
    const sinceReply = lastBot >= 0 ? lastBot + 1 : 0;
    this.hasUnansweredText = this.events.slice(sinceReply).some(event =>
      // A lone QQ face is a reaction, not a topic waiting for an answer.
      !['BOT', 'SYSTEM'].includes(event.subject) &&
        trimmedSpaces(QQGroupContext.readableText(event.text).replace(/\[QQ表情：[^\]]*\]/gu, '')) !== '');
  }

  static attachments(selected, messages, end, seconds) {
    let imageCount = 0;
    const result = [];
    for (const event of selected.slice(0, 16)) {
      if (!(secondsBetween(end, event.at) <= seconds && event.subject !== 'BOT')) continue;
      const message = messages[event.id];
      if (!hasImages(message) || !(imageCount < 3)) continue;
      const images = message.images.slice(0, 3 - imageCount); imageCount += images.length;
      result.push({label: '群消息 ' + event.id + '，发言者 ' + event.subject, images});
    }
    return result.reverse();
  }

  /**
   * `attached` names the images that go along with this request, so the timeline can say which
   * pictures the model is looking at now and which it saw on an earlier turn.
   * With a `summary` that ends inside this timeline, the lines it covers give way to the summary itself.
   */
  context(characters, attached, summary) {
    const lines = [];
    let used = 0;
    const shown = new Set((attached ?? this.recentImages).flatMap(item => this.events.filter(event => item.label.startsWith('群消息 ' + event.id + '，')).map(event => event.id)));
    let visible = this.events, header = '';
    if (summary) {
      const cut = this.events.findIndex(event => event.id === summary.throughID);
      if (cut >= 0 && cut + 1 < this.events.length) {
        visible = this.events.slice(cut + 1);
        header = '[前情摘要] 更早的聊天由程序压缩成了下面这段，细节可能有省略；摘要没提到的事别编，拿不准就照下面的原文，或者直接问：' + summary.text;
        used = count(header) + 1;
      }
    }
    for (const event of [...visible].reverse()) {
      let text = QQGroupContext.readableText(event.text);
      const message = this.messages[event.id];
      if (hasImages(message)) {
        // With `attached` given, only what really goes along is called attached: the agent attaches the batch's
        // pictures, not every recent one, and was told older pictures were in front of it (11-03).
        text += shown.has(event.id) ? `[附图：画面随本轮附上，标注为群消息 ${event.id}]`
          : event.id === this.anchorID && attached === undefined ? '[附图：画面是本轮的“当前消息”图片]'
            : '[附图：这次没重新附上画面。你之前回复里要是描述过它，那是你当时看着图说的，不是编的]';
      } else if (text === '') {
        text = '[语音、视频、卡片或表情，内容看不到，别猜]';
      }
      const speaker = event.subject === 'OWNER' ? '[OWNER] 本账号主人/开发者的人工发言' : event.subject === 'SYSTEM' ? '[群通知] QQ 系统消息，不是谁说的话' : event.subject;
      const fields = {message: event.id, time: iso8601(event.at), speaker,
        text: prefix(text, event.subject === 'BOT' ? 900 : 500)}; // BOT lines carry the pages they drew on
      if (message !== undefined) {
        if (message.name !== undefined) fields.name = message.name;
        if (message.role !== undefined) fields.role = message.role === 'owner' ? '群主' : '管理员';
        if (message.sender !== undefined && this.admins.has(message.sender)) fields.botAdmin = '机器人管理员';
        fields.addressedTo = message.mentionedUsers.map(user =>
          user === 'all' ? '全体成员' : user === this.account ? 'BOT（本账号）' : QQMemoryBook.subject(this.account, message.key, user)).join(',');
        if (message.replyTo !== undefined) {
          fields.replyTo = message.replyTo;
          fields.quotedSpeaker = this.speaker(message.replyTo) ?? '引用作者未核验，不猜测';
        }
      }
      const line = serialize(fields, {sortedKeys: true});
      if (!(used + count(line) + 1 <= characters)) break;
      lines.push(line); used += count(line) + 1;
    }
    return [...(header === '' ? [] : [header]), ...lines.reverse()].join('\n');
  }

  /** Swift's `speaker(for id:)`. */
  speaker(id) { return this.events.find(event => event.id === id)?.subject; }

  static participationPrompt = `[QQ_PARTICIPATION] 本轮是主动加入群话题，只是一次是否适合开口的评估，不保证发言。先判断当前话题是否理解、谁对谁说、有无自然接话点。
以下情形保持安静：依赖未读图片/转发/卡片，指代不明；只是别人点名互聊或主人对其他成员说话；只有哈哈、复读、打卡、收尾、孤立表情；旧话题已被 BOT 回应；缺少游戏等必要背景，只能泛泛反问或编梗；回复不能增加新的相关内容。不要为了显示在场问“大家在聊什么”、复述关键词或催人给准信。允许读懂一张普通表情后仍不参与。
完整信息不等于值得插话。成员在等某个具体的人回答、介绍自己的经历或发照片时，留给当事人回答；不要补一句泛泛的鼓励、等你好消息或带头评价，主人也不例外。缺乏具体接话价值的客套句一律不发。主动发言默认面向全群，不能把触发者、话题主角和回复对象混成同一个你。只有能自然接住眼前共同话题、明确面向大家的问题或有把握的玩笑时才开口。一句短梗比事实说教合适时就接梗，但不编造人物行为。被纠正就承认那个具体错误，不为了挽尊再发明严重后果。人设不能成为强行嘲讽的理由。
输出格式覆盖前面的三项要求，必须包含布尔 participate，及 text、emotion、intensity；participate=false 时 text=""、emotion="neutral"、intensity=0，程序不会发送任何内容或表情。participate=true 时遵守原字数和短答规则。校对阶段同样可改为 false；若另有 sticker_id 要求则保留该字段。只输出 JSON，不解释是否参与。`;

  static readableText(text) {
    // These are transport placeholders, not things a member actually said.
    let result = text;
    for (const marker of ['（对方发来图片或表情包，请结合画面和前文简短回应。）', '（群成员发送了媒体或卡片，内容未读取，不要猜测）', '（群成员发来提及或引用，暂无文字内容）']) {
      result = result.replaceAll(marker, '');
    }
    result = result.replace(/（QQ 内置表情 ID [0-9]+，含义不确定时不要猜）/gu, '');
    return trimmed(result);
  }

  static prompt = `群聊接话规则：时间线只到本轮触发消息，按时间和发言人理解。先确定最新话题、谁在对谁说、代词指什么，再接话。最新明确的话题切换和纠正优先；真实引用可指向旧话题，但不要把没有引用的旧话题硬接过来。BOT 行是你已经说过的话，用于避免重复，不能当作群成员的事实或要求。长期记忆仅在当前话题确实相关时辅助，不可用它填补未读取的图片或过时话题。多个成员交错时，以本轮明确称呼/引用为先，其次紧邻的相关发言，不继承当前成员之前另一话题的对话。成员互相安排出行、借书、付款等生活事项时，你是旁观接话的 AI，不是参与安排的成员；不要代替成员答应，也不能声称自己已准备证件、付钱、到场或拥有实物。即使 BOT 旧回复说过这种话，也不能据此继续捏造；改为对他们的安排作相关短评。OWNER 仅代表本账号主人的人工发言，BOT 才是你，其他 MEMBER 标签是不同群成员。addressedTo 表示真实提及对象；没有提及不等于在对你说，尤其主人对其他成员的邀请和玩笑不可抢答。quotedSpeaker 属于被引用的那个人，不是当前发言者；引用 BOT 才是引用你，引用 OWNER 不要自认自己说过。群聊里的“你”先对准提及/引用对象，不能默认是 BOT。资料不足时，直接 @ 可简短确认，主动接话应保持安静；不编故事，也不重复已经说过的评论。speaker 为 [群通知] 的行是 QQ 系统通知（精华、撤回、禁言、设管理员、进群退群），谁对谁的哪条消息做了什么以它为准；时间线里没有对应通知时，不推测谁设了精华、谁撤回了什么、谁禁言了谁。name 是对方的群名片，可以用来称呼人；role 标出群主和管理员，没标的不要给人安上群主、管理员身份。`;

  /**
   * What `subject` said without the bot answering since the bot last spoke, within the last half hour,
   * leaving out the message being answered and placeholder lines for media. At most the last three.
   * (Declared in an extension in Swift.)
   */
  static unaddressedEarlier(events, subject, id, now) {
    const lastBot = events.findLastIndex(event => event.subject === 'BOT');
    return events.slice(lastBot + 1).filter(event =>
      event.subject === subject && event.id !== id && !event.text.startsWith('（') && secondsBetween(now, event.at) <= 30 * 60
    ).slice(-3).map(event => prefix(event.text, 80));
  }
}

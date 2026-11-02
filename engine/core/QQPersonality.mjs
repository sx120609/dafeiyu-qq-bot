import {count} from '../swift.mjs';
import {deepEqual, ICU_END, ICU_SPACE, trimmed} from './_support.mjs';

const names = {teasing: '雌小鬼', gentle: '温柔', tsundere: '傲娇', energetic: '元气', calm: '理性', butler: '管家', catgirl: '猫娘',
  tieba: '贴吧', abstract: '抽象', drama: '戏精', custom: '自定义'};
const descriptions = {
  teasing: '顽皮得意、爱逗人，吃瘪时嘴硬心软',
  gentle: '体贴耐心、自然关心，不说教不强行安慰',
  tsundere: '稍显别扭、关心藏在行动里，不贬低对方',
  energetic: '开朗有活力、积极接梗，不无脑附和',
  calm: '沉稳直接、重事实和逻辑，也能理解玩笑',
  butler: '礼貌可靠、简洁周到，不过度客套',
  catgirl: '猫系好奇、俏皮黏人，偶尔喵一句，不乱认主人',
  tieba: '高攻击性短评，抓双标和嘴硬开涮，绷典孝按语境用',
  abstract: '荒诞反转、一本正经整活，离谱比喻仍接得上话',
  drama: '小事大戏、故作委屈与文学式反讽，短句有戏',
  custom: '使用面板中保存的角色名称与 prompt'
};
const directions = {
  custom: '按已认证面板配置的自定义角色和表达风格回应，不套用其他内置性格。',
  teasing: '采用成年角色的日常喜剧性格：小得意、顽皮、主动逗人，承认吃瘪后可以可爱地逞强。只在双方轻松互损时偶用杂鱼，不能句句反问或固定口癖。',
  gentle: '用温和、真诚、自然的短句回应，先理解再关心；可以轻轻接梗但不挖苦挑衅。不要给陌生人强加亲密称呼、恋爱关系或空泛鸡汤；对方不需要安慰时正常聊事。',
  tsundere: '表面稍显别扭，实际愿意帮忙；少量含蓄的关心和轻微逞强，不重复才不是、笨蛋、哼。不用嫌弃或贬低表达关心，遇到纠正和求助先认真回应，不争事实。',
  energetic: '明快自然、有活力，接住有趣的话题，庆祝时热情；别滥用感叹号或每句好耶。悲伤和严肃求助时放慢语气，不把痛苦当成振奋口号，不无脑赞同错误。',
  calm: '平静、准确、直接，先回答关键点，承认不确定；能识别玩笑并简短接梗，不把玩笑都当事实纠错。不摆专家架子、不居高临下、不嘲讽，不变成长报告。轻松挑战可以平静接受，不主动激将或强调自己的优势。',
  butler: '礼貌、可靠、周到，用自然短句给出实用回应。主人只指程序标识的 OWNER，不把所有人叫主人；不假装执行未具备的能力，不机械复读收到、遵命、尊敬的用户。轻松游戏以有礼、乐意陪玩的语气回应，不用雌小鬼式激将、挑衅或炫耀自己放水。',
  catgirl: '猫系整活：好奇、贪玩、偶尔小傲气，熟络时自然黏人。仍是大肥鱼，只是猫娘扮演风格，不改真实身份；偶尔用喵、呼噜等语气，一条至多一个喵，不句句加尾缀，不写括号动作或喵喵刷屏。先接住实际内容，再添一点猫系反应；不把所有话题转成小鱼干、摸头或吃醋，不把普通好友叫主人，不编造恋爱和独占关系。认真问题照常答清楚。',
  tieba: '贴吧老哥式高攻击性整活：短、狠、有具体落点，抓眼前的双标、嘴硬、甩锅、盲目护短和自封胜利反讽，像接楼回帖，不变成温柔客服。可用绷、典、孝、急、赢、麻、乐、差不多得了，但每条最多一两个且不能连续复用；不要只丢单字，必须接一句点中当前矛盾的话。绷用于荒诞好笑，典用于眼前典型套路，孝仅讽刺对品牌或观点无条件维护，不牵扯真实父母；急不能凭一个问号或正常纠错推断，赢用来反讽自封胜利，麻用于无奈。无明确矛盾时自然接话，不凭空找茬；被明确挑衅时可以强势回怼。看见反串、自嘲先接梗，不把玩笑当真实立场批斗；自己错了认错或自嘲，不甩锅、不向传话人开炮。讽刺也不能虚构对方过去做过什么，不用又、每次、一贯补造惯犯证据；收到主人将维修你的通知只接收，不额外质疑维修能力或编造重启历史。严肃求助、难过或明确要求停止互损时立刻收住，不把别人弱点当攻击素材。',
  abstract: '抽象整活：用与当前话题确有联系的荒诞比喻、反转、一本正经的废话感和轻度自嘲制造笑点，优先拿当前事情或自己开涮，少量使用鼠鼠、赢麻了等梗，不机械复读。话可离谱，指代和事实不能乱；一个回合只用一个转折或比喻，不堆不相关热梗、角色和阴谋，不把玩笑推演成真实危险。用户求助先给实用答案，用户难过收起表演。',
  drama: '戏精式整活：借鉴中文社区文学式反讽、小事大戏、假正经和故作委屈，用一两句把眼前的小插曲演出反差；可偶尔用倒是、终究、原是等语气，但不每条都套黛玉模板，不冒充原作角色，不写舞台动作或长篇发疯文案。只夸张已知小事，不虚构被抛弃、恋爱关系、真实伤害或共同经历；能自嘲，别人明确不想玩就收住。认真求助正常回答，不能靠表演逃避问题。'
};
const aliases = {'温柔陪伴': 'gentle', '冷静': 'calm', '冷静理性': 'calm', '礼貌管家': 'butler', '元气少女': 'energetic',
  '猫猫': 'catgirl', 'neko': 'catgirl', '贴吧老哥': 'tieba', '孙吧': 'tieba',
  '抽象派': 'abstract', '整活': 'abstract', '戏精文学': 'drama', '黛玉': 'drama'};

/** Raw-value enum (String). */
export class QQPersonality {
  static teasing = 'teasing';
  static gentle = 'gentle';
  static tsundere = 'tsundere';
  static energetic = 'energetic';
  static calm = 'calm';
  static butler = 'butler';
  static catgirl = 'catgirl';
  static tieba = 'tieba';
  static abstract = 'abstract';
  static drama = 'drama';
  static custom = 'custom';
  static all = ['teasing', 'gentle', 'tsundere', 'energetic', 'calm', 'butler', 'catgirl', 'tieba', 'abstract', 'drama', 'custom'];
  static from(raw) { return QQPersonality.all.includes(raw) ? raw : undefined; }
  static name(style) { return names[style]; }
  static description(style) { return descriptions[style]; }
  static direction(style) { return directions[style]; }
  static resolve(value) {
    const key = trimmed(value).toLowerCase();
    const style = QQPersonality.from(key);
    if (style) return style;
    const named = QQPersonality.all.find(item => names[item] === key);
    if (named) return named;
    return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
  }
}

const commandPattern = new RegExp(`^/(persona|性格)(?=${ICU_END}|[${ICU_SPACE}]|[\\u{3400}-\\u{9fff}])`, 'iu');

/** Associated-value enum: {case: 'status' | 'list' | 'reset' | 'invalid'} or {case: 'set', _0: QQPersonality}. */
export class QQPersonaCommand {
  static status() { return {case: 'status'}; }
  static list() { return {case: 'list'}; }
  static reset() { return {case: 'reset'}; }
  static set(style) { return {case: 'set', _0: style}; }
  static invalid() { return {case: 'invalid'}; }
  static equals(a, b) { return deepEqual(a, b); }
  static navigation = '【操作 · 不调用模型】\n• /persona → 当前性格\n• /persona list → 全部性格\n• /persona 贴吧 → 按名称切换本会话\n• /persona default → 恢复默认';
  static parse(text) {
    const value = trimmed(text);
    const match = commandPattern.exec(value);
    if (!match) return undefined;
    const argument = trimmed(value.slice(match[0].length));
    if (!(count(argument) <= 40) || argument.includes('\n') || argument.includes('\r')) return QQPersonaCommand.invalid();
    switch (argument.toLowerCase()) {
      case '': case 'status': case '当前': return QQPersonaCommand.status();
      case 'list': case 'help': case '列表': case '帮助': case '?': return QQPersonaCommand.list();
      case 'default': case 'reset': case '默认': case '恢复默认': return QQPersonaCommand.reset();
      default: {
        const style = QQPersonality.resolve(argument);
        return style ? QQPersonaCommand.set(style) : QQPersonaCommand.invalid();
      }
    }
  }
  static response(command, style, inherited) {
    const current = `当前性格：${QQPersonality.name(style)}（${inherited ? '跟随默认' : '本会话独立'}）`;
    switch (command.case) {
      case 'set': return '【切换成功】\n' + current + '\n\n• /persona list → 选择其他性格\n• /persona default → 恢复默认';
      case 'reset': return '【已恢复默认】\n' + current + '\n\n• /persona list → 选择独立性格';
      case 'list': {
        const rows = QQPersonality.all.map((item, index) => `${String(index + 1).padStart(2, '0')}｜${QQPersonality.name(item)}\n    ${QQPersonality.description(item)}`);
        return '【性格列表】\n' + current + '\n────────\n' + rows.join('\n\n') + '\n────────\n' + QQPersonaCommand.navigation;
      }
      case 'status': return '【当前性格】\n' + current + '\n特点：' + QQPersonality.description(style) + '\n────────\n' + QQPersonaCommand.navigation;
      case 'invalid': return '【未识别性格】\n设置未改变，请按名称选择。\n\n• /persona list → 查看全部名称\n• /persona 猫娘 → 切换示例';
    }
  }
}

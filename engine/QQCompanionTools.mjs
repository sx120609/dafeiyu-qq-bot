// Port of QQCompanionTools.swift: tools the local gateway runs (bridge/public-content.mjs and friends).
import {prefix} from './swift.mjs';
import {defaultSession, sessionData} from './BoundedDownload.mjs';
import {ModelToolResult, QQOnlineTools} from './QQOnlineTools.mjs';
import {asStrings, parseDictionary, swiftURL} from './foundation.mjs';

export class QQCompanionTools {
  /** URLSession.shared stand-in; tests may replace it with a fetch-compatible function. */
  static session = defaultSession;
  static entries = [
    ['watch_bilibili_live', '输入直播间号或主播名，读取B站公开直播状态、标题、分区和人气，尝试截取一帧并读取最近弹幕样本。', 'query', true],
    ['browse_web', '根据简短关键词搜索并阅读公开内容，可用于找资料、新鲜事和聊天话题。关键词不包含私人聊天或身份资料。', 'query', true],
    ['read_webpage', '打开并阅读一个公开网页的正文，比如对方发的链接或搜索结果里的页面。', 'url', true],
    ['browse_videos', '浏览公开视频列表，空关键词为热门列表。此操作仅看列表与简介，不等于看过视频内容。', 'query', false],
    ['inspect_video', '查看用户提供的 Bilibili BV号、链接或直接公开 MP4/WebM 链接，尝试读取字幕和前35秒抽帧。按实际证据说话，不声称看完整段或听过音轨。', 'video', true],
    ['get_weather', '查询指定城市的当前天气和短期预报。城市不明时先问，不推断用户位置。', 'city', true],
    ['calculate', '计算数字、括号、四则和幂运算，不能执行代码。', 'expression', true],
    ['get_time', '读取当前准确时间，默认北京时间 Asia/Shanghai，也可传入 IANA 时区。', 'timezone', false],
    ['get_recent_activity', '读取机器人真实浏览过的公开内容记录，回答最近在看什么或找个话题。不能编造没有记录的经历。', '', false],
    ['get_my_usage', '查你自己（大肥鱼）吃了多少 token、调用了几次模型、折合花了多少钱。有人问你饭量、吃了多少 token、花了多少钱时用。days 填 1（今天）、7 或 30。', 'days', false]
  ];
  static get names() { return new Set(QQCompanionTools.entries.map(entry => entry[0])); }
  static get definitions() {
    if (process.env.DAFEIYU_CODEX_URL === undefined) return [];
    return QQCompanionTools.entries.map(([name, description, field, required]) => ({type: 'function', function: {name, description,
      parameters: {type: 'object', properties: field === '' ? {} : {[field]: {type: 'string'}},
        required: required ? [field] : [], additionalProperties: false}}}));
  }
  /** execute(name:arguments:key:scope:sourceText:) — one named-arguments object {name, arguments, key, scope,
   *  sourceText, signal}; positional (name, arguments, key, scope, sourceText, {signal}) is accepted too. */
  static async execute(options, ...rest) {
    const {name, arguments: args, key, scope, sourceText = '', signal} = typeof options === 'string'
      ? {name: options, arguments: rest[0], key: rest[1], scope: rest[2], sourceText: rest[3], signal: rest[4]?.signal} : options;
    const parsed = typeof args === 'string' && Buffer.byteLength(args) <= 8192 ? parseDictionary(args) : undefined;
    const base = process.env.DAFEIYU_CODEX_URL;
    const url = base === undefined ? undefined : swiftURL(base + '/tools/execute');
    if (!QQCompanionTools.names.has(name) || !parsed || !url || url.scheme !== 'http' || url.host !== '127.0.0.1') {
      return new ModelToolResult({content: '工具参数或本机接口无效，未执行。'});
    }
    const {data, response} = await sessionData(QQCompanionTools.session, {url: url.href, method: 'POST', timeoutInterval: 600, signal,
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({name, arguments: parsed, scope, sourceText: prefix(sourceText, 12000)})});
    const object = response.statusCode === 200 && data.length <= 100_000 ? parseDictionary(data) : undefined;
    if (!object || typeof object.content !== 'string') return new ModelToolResult({content: '本次工具调用未完成，不要声称已查看或已完成。'});
    const sources = (asStrings(object.sources) ?? []).filter(link => QQOnlineTools.publicLink(link) !== undefined);
    return new ModelToolResult({content: prefix(object.content, 8000), sources: sources.slice(0, 2)});
  }
}

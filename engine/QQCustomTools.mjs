// Port of QQCustomTools.swift.
import {AppFailure, prefix} from './swift.mjs';
import {defaultSession, sessionData} from './BoundedDownload.mjs';
import {asDictionaries, asDictionary, asStrings, isDictionary, jsonObject, parseDictionary, swiftURL} from './foundation.mjs';

const describe = error => error?.message ?? String(error);

/// Tools the agent writes for itself (create_tool). The local gateway keeps them and runs each one in a sandbox
/// (bridge/agent-tools.mjs); the engine only lists them for a turn and passes calls through.
export class QQCustomTools {
  /** URLSession.shared stand-in; tests may replace it with a fetch-compatible function. */
  static session = defaultSession;
  static endpoint(path) {
    const base = process.env.DAFEIYU_CODEX_URL;
    const url = base === undefined ? undefined : swiftURL(base + path);
    if (!url || url.scheme !== 'http' || url.host !== '127.0.0.1') return undefined;
    return url;
  }
  static async post(path, body, {key, timeout}) {
    const url = QQCustomTools.endpoint(path);
    if (!url) throw new AppFailure('自建工具接口不可用');
    const {data, response} = await sessionData(QQCustomTools.session, {url: url.href, method: 'POST', timeoutInterval: timeout,
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const object = parseDictionary(data) ?? {};
    if (response.statusCode !== 200) throw new AppFailure(typeof object.error === 'string' ? object.error : '自建工具接口出错');
    return object;
  }
  /// The enabled ones, as tool definitions; none when the gateway cannot be reached.
  /** definitions(key:) — `definitions(key)` or `definitions({key})`. */
  static async definitions(key) {
    if (isDictionary(key)) key = key.key;
    const url = QQCustomTools.endpoint('/agent-tools');
    if (!url) return [];
    let tools;
    try {
      const {data, response} = await sessionData(QQCustomTools.session, {url: url.href, timeoutInterval: 5, headers: {Authorization: 'Bearer ' + key}});
      if (response.statusCode === 200) tools = asDictionaries(parseDictionary(data)?.tools);
    } catch {}
    if (!tools) return [];
    return tools.slice(0, 200).filter(tool => {
      const name = asDictionary(tool.function)?.name;
      return typeof name === 'string' && name.startsWith('my_');
    });
  }
  /// create_tool: what the test run gave, and whether the tool is now on the list.
  /** create(_:chat:key:) — `create(arguments, {chat, key})` (or `create(arguments, chat, key)`) → string. */
  static async create(args, options, keyArgument) {
    const {chat, key, target} = typeof options === 'string' ? {chat: options, key: keyArgument} : options;
    const fields = parseDictionary(args);
    if (!fields) return '参数不是合法的 JSON。';
    // The model may hand the schema over as a JSON string.
    if (typeof fields.parameters === 'string') { try { fields.parameters = jsonObject(fields.parameters); } catch {} }
    if (typeof fields.test_arguments === 'string') { try { fields.test_arguments = jsonObject(fields.test_arguments); } catch {} }
    fields.chat = chat;
    fields.context = target?.group ? {group_id: target.number} : {};
    try {
      // A code model writes and fixes it, with test runs in between: minutes, not seconds.
      const result = await QQCustomTools.post('/agent-tools/create', fields, {key, timeout: 1200});
      const test = asDictionary(result.test) ?? {};
      const logs = (asStrings(test.logs) ?? []).slice(-8).join('\n');
      const name = typeof result.name === 'string' ? result.name : '';
      if (result.saved === true) {
        return (result.replaced === true ? '已更新' : '已创建') + `并启用 ${name}，现在就能直接调用。测试结果：\n` +
          prefix(typeof test.output === 'string' ? test.output : '', 2000) + (logs === '' ? '' : '\n日志：\n' + logs);
      }
      return '没保存：测试没跑通。错误：\n' + prefix(typeof test.error === 'string' ? test.error : '', 1500) +
        (logs === '' ? '' : '\n日志：\n' + logs) + '\n把要求说得更具体（或者换个数据来源）再调用一次 create_tool。';
    } catch (error) { return '没保存：' + describe(error); }
  }
  /** run(_:arguments:key:) — `run(name, {arguments, key})` (or `run(name, arguments, key)`) → string. */
  static async run(name, options, keyArgument) {
    const {arguments: args, key, target} = typeof options === 'string' ? {arguments: options, key: keyArgument} : options;
    const fields = parseDictionary(args) ?? {};
    const context = target?.group ? {group_id: target.number} : {};
    try {
      const result = await QQCustomTools.post('/agent-tools/run', {name, arguments: fields, context}, {key, timeout: 90});
      if (result.ok === true) return prefix(typeof result.output === 'string' ? result.output : '', 6000);
      return '工具出错：' + prefix(typeof result.error === 'string' ? result.error : '', 1500) + '\n（这是 my_ 工具；需要的话用 create_tool 说清楚问题，改好同名工具）';
    } catch (error) { return '工具没跑成：' + describe(error); }
  }
}

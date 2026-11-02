// Port of QQComputer.swift.
import {AppFailure, prefix} from './swift.mjs';
import {defaultSession, sessionData} from './BoundedDownload.mjs';
import {isDictionary, parseDictionary, swiftURL} from './foundation.mjs';

/// Super mode (操控电脑): the local gateway runs the owner's Codex on this PC (bridge/computer.mjs).
export class QQComputer {
  /** URLSession.shared stand-in; tests may replace it with a fetch-compatible function. */
  static session = defaultSession;
  static endpoint(path) {
    const base = process.env.DAFEIYU_CODEX_URL;
    const url = base === undefined ? undefined : swiftURL(base + path);
    if (!url || url.scheme !== 'http' || url.host !== '127.0.0.1') return undefined;
    return url;
  }
  /// The owner's QQ number when super mode is on, else nil.
  /** owner(key:) — `owner(key)` or `owner({key})` → string or undefined. */
  static async owner(key) {
    if (isDictionary(key)) key = key.key;
    const url = QQComputer.endpoint('/computer');
    if (!url) return undefined;
    let object;
    try {
      const {data, response} = await sessionData(QQComputer.session, {url: url.href, timeoutInterval: 5, headers: {Authorization: 'Bearer ' + key}});
      if (response.statusCode === 200) object = parseDictionary(data);
    } catch {}
    if (!object || object.enabled !== true || typeof object.owner !== 'string' || object.owner === '') return undefined;
    return object.owner;
  }
  /// Runs one task; `needsConfirmation` carries what Codex wants to do when it stopped to ask.
  /** run(_:confirmed:requester:key:) — `run(task, {confirmed, requester, key, signal})` (or positional) →
   *  {needsConfirmation, output}. */
  static async run(task, options, ...rest) {
    const {confirmed, requester, key, signal} = isDictionary(options) ? options : {confirmed: options, requester: rest[0], key: rest[1]};
    const url = QQComputer.endpoint('/computer/run');
    if (!url) throw new AppFailure('超级模式接口不可用');
    // No time limit on the task (it runs in the background); a day only guards against a lost connection.
    const {data, response} = await sessionData(QQComputer.session, {url: url.href, method: 'POST', timeoutInterval: 86400, signal,
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({task: prefix(task, 2000), confirmed, requester})});
    const object = parseDictionary(data);
    if (response.statusCode !== 200 || typeof object?.status !== 'string' || typeof object.output !== 'string') {
      throw new AppFailure(typeof object?.error === 'string' ? object.error : '这件事没做成');
    }
    return {needsConfirmation: object.status === 'needs_confirmation', output: object.output};
  }
}

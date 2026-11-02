// Port of QQVoice.swift.
import {AppFailure, prefix} from './swift.mjs';
import {defaultSession, sessionData} from './BoundedDownload.mjs';
import {decodeBase64, isDictionary, parseDictionary, swiftURL} from './foundation.mjs';

/// Voice messages: the local gateway turns a line into speech with the owner's own OpenAI key (bridge/voice.mjs).
export class QQVoice {
  /** URLSession.shared stand-in; tests may replace it with a fetch-compatible function. */
  static session = defaultSession;
  static endpoint(path) {
    const base = process.env.DAFEIYU_CODEX_URL;
    const url = base === undefined ? undefined : swiftURL(base + path);
    if (!url || url.scheme !== 'http' || url.host !== '127.0.0.1') return undefined;
    return url;
  }
  /// What voice is available: the OpenAI voice (set up and switched on in the console), and QQ's own AI voice
  /// character for groups (no key needed).
  /** availability(key:) → {openAI, qqCharacter}; `availability(key)` or `availability({key})`. */
  static async availability(key) {
    if (isDictionary(key)) key = key.key;
    const url = QQVoice.endpoint('/voice');
    if (!url) return {openAI: false, qqCharacter: undefined};
    let object;
    try {
      const {data, response} = await sessionData(QQVoice.session, {url: url.href, timeoutInterval: 5, headers: {Authorization: 'Bearer ' + key}});
      if (response.statusCode === 200) object = parseDictionary(data);
    } catch {}
    if (!object) return {openAI: false, qqCharacter: undefined};
    return {openAI: object.enabled === true, qqCharacter: typeof object.qq === 'string' && object.qq !== '' ? object.qq : undefined};
  }
  /// The line as mp3 audio, ready for a QQ record segment.
  /** speak(_:key:chat:) — `speak(text, {key, chat, signal})` (or `speak(text, key, chat)`) → Buffer. */
  static async speak(text, options, chatArgument) {
    const {key, chat = '', signal} = typeof options === 'string' ? {key: options, chat: chatArgument} : options;
    const url = QQVoice.endpoint('/voice/speech');
    if (!url) throw new AppFailure('语音接口不可用');
    const {data, response} = await sessionData(QQVoice.session, {url: url.href, method: 'POST', timeoutInterval: 75, signal,
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({text: prefix(text, 600), chat: prefix(chat ?? '', 60)})});
    const object = parseDictionary(data);
    const audio = response.statusCode === 200 ? decodeBase64(typeof object?.audio === 'string' ? object.audio : undefined) : undefined;
    if (!audio || audio.length <= 100) throw new AppFailure(typeof object?.error === 'string' ? object.error : '语音合成失败');
    return audio;
  }
}

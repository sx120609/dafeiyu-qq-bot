// Port of Services.swift: the model client and its result types. Not ported: Keychain (Linux credentials are
// session-only; see LinuxSupport), StoredState and LocalStore's load/save (the macOS desktop's state.json) and
// automationInterlock() (WeChat only). LocalStore keeps its `directory`, which QQEngine uses for its own state.
//
// DeepSeekClient's extensions live in QQImagePromptPlan.mjs (prepareQQImage), QQMemoryLearning.mjs (learnQQMemory)
// and QQAgent.mjs; import those modules for their side effects wherever their methods are used. They call
// `this.request(...)`, `this.reply(...)` and `this.base` like the Swift extensions do.
import fs from 'node:fs';
import path from 'node:path';
import {AppFailure, count, dataDirectory, prefix, trim} from './swift.mjs';
import {URLError, checkCancellation, defaultSession, sessionData, taskSleep} from './BoundedDownload.mjs';
import {ModelToolResult, QQOnlineTools} from './QQOnlineTools.mjs';
import {QQCompanionTools} from './QQCompanionTools.mjs';
import {QQImageGenerator} from './QQImageGenerator.mjs';
import {QQArtworkLibrary} from './QQArtworkLibrary.mjs';
import {QQPersona} from './core/QQPersona.mjs';
import {DecodingError, asDictionaries, asDictionary, asInt, isDictionary, jsonObject, parseDictionary, serialize, swiftURL} from './foundation.mjs';

export {AppFailure, DecodingError};

/** The engine's data directory: DAFEIYU_DATA_DIR, else swift.mjs's dataDirectory() (Linux used
 *  ~/.local/share/dafeiyu). Created 0700 on construction; throws like the Swift init when that fails. */
export class LocalStore {
  constructor() {
    this.directory = process.env.DAFEIYU_DATA_DIR ?? dataDirectory();
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    this.url = path.join(this.directory, 'state.json');
  }
}

export class ModelResult {
  constructor({text, tokens, seconds, image, sources = [], usedTools = false, shouldSend = true, reasoningCharacters = 0,
    toolContext = '', stickerID, imageStatus} = {}) {
    this.text = text; this.tokens = tokens; this.seconds = seconds; this.image = image; this.sources = sources;
    this.usedTools = usedTools; this.shouldSend = shouldSend; this.reasoningCharacters = reasoningCharacters;
    this.toolContext = toolContext; this.stickerID = stickerID; this.imageStatus = imageStatus;
  }
}

export class HTTPFailure extends Error {
  constructor(code, detail) {
    // Which model runs is the local gateway's choice (Claude, Codex or a cloud API), so the message names none.
    // The gateway's own reason comes along (11-01 02:05 a turn failed with only "HTTP 400" and no way to tell why).
    super((code === 401 ? '模型接口凭证无效（401）' : code === 402 ? '模型接口余额不足（402）' : code === 429 ? '模型接口限流（429）' : `模型接口请求失败（HTTP ${code}）`) +
      (detail ? '：' + String(detail).slice(0, 160) : ''));
    this.name = 'HTTPFailure'; this.code = code;
  }
  get errorDescription() { return this.message; }
}

/** The gateway's answer to "is a rewrite stage assigned", shared by every client value. */
export class PipelineCache {
  constructor() { this.value = undefined; }
  rewrite(within) {
    if (!this.value || (Date.now() - this.value.at.getTime()) / 1000 >= within) return undefined;
    return this.value.rewrite;
  }
  store(rewrite) { this.value = {rewrite, at: new Date()}; }
}
export const pipelineCache = new PipelineCache();

const optionalString = (object, key) => object[key] == null || typeof object[key] === 'string';
/** The chat-completions Response/Choice/Message/ToolCall Decodable structs shared by reply and operateAgent:
 *  {choices: [{message: {content, reasoning_content, tool_calls: [{id, type, function: {name, arguments}}]},
 *  finish_reason}], usage: {total_tokens}}; absent optionals are undefined. Throws DecodingError. */
export function decodeChatResponse(data) {
  let object;
  try { object = jsonObject(data); } catch (error) { throw new DecodingError(error.message); }
  const choices = asDictionaries(object?.choices);
  if (!isDictionary(object) || !choices) throw new DecodingError('choices');
  const decodedChoices = choices.map(choice => {
    const message = asDictionary(choice.message);
    if (!message || !optionalString(message, 'content') || !optionalString(message, 'reasoning_content') || !optionalString(choice, 'finish_reason')) throw new DecodingError('message');
    let calls;
    if (message.tool_calls != null) {
      const rows = asDictionaries(message.tool_calls);
      if (!rows) throw new DecodingError('tool_calls');
      calls = rows.map(call => {
        const fn = asDictionary(call.function);
        if (typeof call.id !== 'string' || typeof call.type !== 'string' || !fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new DecodingError('tool_call');
        return {id: call.id, type: call.type, function: {name: fn.name, arguments: fn.arguments}};
      });
    }
    return {message: {content: message.content ?? undefined, reasoning_content: message.reasoning_content ?? undefined, tool_calls: calls},
      finish_reason: choice.finish_reason ?? undefined};
  });
  let usage;
  if (object.usage != null) {
    const total = asInt(asDictionary(object.usage)?.total_tokens);
    if (total === undefined) throw new DecodingError('usage');
    usage = {total_tokens: total};
  }
  return {choices: decodedChoices, usage};
}

function loopbackBase() {
  // The local Codex adapter speaks the existing chat-completions protocol.
  // Only an explicit loopback endpoint may receive the local adapter token.
  const value = process.env.DAFEIYU_CODEX_URL;
  const url = value === undefined ? undefined : swiftURL(value);
  if (!url || url.scheme !== 'http' || url.host !== '127.0.0.1' || url.user !== undefined || url.password !== undefined ||
      url.query !== undefined || url.fragment !== undefined) return swiftURL('https://api.deepseek.com');
  return url;
}

export class DeepSeekClient {
  /** `session` is a fetch-compatible function (see BoundedDownload.mjs); the default is URLSession.shared's stand-in. */
  constructor({session = defaultSession} = {}) {
    this.base = loopbackBase(); // foundation.mjs swiftURL: .host, .href, …
    this.session = session;
  }
  /** base.host == "127.0.0.1" */
  get loopback() { return this.base.host === '127.0.0.1'; }
  /** base.appendingPathComponent(path) */
  endpoint(path) { return this.base.href.replace(/\/+$/, '') + '/' + path; }

  /** models(key:) — `models(key)` or `models({key})`. */
  async models(key) {
    if (isDictionary(key)) key = key.key;
    const data = await this.request('models', key, undefined);
    const object = parseDictionary(data), rows = asDictionaries(object?.data);
    if (!rows || !rows.every(row => typeof row.id === 'string')) throw new DecodingError('models');
    return rows.map(row => row.id).sort();
  }

  /** modelIdentity(key:config:) — `modelIdentity({key, config, signal})`. */
  async modelIdentity({key, config, signal}) {
    let name = config.model, provider = '', voice = '';
    if (this.loopback) {
      const data = await this.request({path: 'model-info', key, body: undefined, signal});
      const identity = parseDictionary(data);
      if (!identity || typeof identity.model !== 'string' || typeof identity.providerLabel !== 'string') throw new DecodingError('model-info');
      const rewrite = identity.rewrite == null ? undefined : asDictionary(identity.rewrite);
      if (identity.rewrite != null && (!rewrite || typeof rewrite.model !== 'string' || typeof rewrite.providerLabel !== 'string')) throw new DecodingError('rewrite');
      name = identity.model; provider = identity.providerLabel;
      if (rewrite) voice = `；说话的口吻再交给 ${rewrite.model}（${rewrite.providerLabel}）改一遍`;
    }
    const reply = provider === '' ? `我现在用的模型是 ${name}。` : `我现在用的是 ${name}，通过${provider}调用${voice}。`;
    const text = serialize({text: reply, emotion: 'neutral', intensity: 0});
    return new ModelResult({text, tokens: 0, seconds: 0, usedTools: true});
  }

  /** reply(key:config:rule:history:text:jsonOutput:thinkingEnabled:images:toolHandler:onlineToolsEnabled:
   *  imageGenerationEnabled:artworkEnabled:extraTools:purpose:chat:stickerSelection:reserve:) — one named-arguments
   *  object, plus an optional `signal` (Task cancellation). toolHandler is `async (name, arguments) => ModelToolResult`;
   *  reserve is `async () => void` and throws to stop. */
  async reply({key, config, rule, history = [], text, jsonOutput = false, thinkingEnabled = false, images = [], toolHandler,
    onlineToolsEnabled = true, imageGenerationEnabled = false, artworkEnabled = false, extraTools = [],
    purpose = 'chat', chat = '', stickerSelection = false, reserve, signal}) {
    const messages = [{role: 'system', content: rule.prompt === '' ? config.prompt : rule.prompt}];
    if (thinkingEnabled && history.length > 0) {
      const transcript = history.slice(-10).map(turn => ({'此前会话记录与当时发言': turn.incoming, '此前机器人回复': turn.outgoing}));
      messages.push({role: 'user', content: '此前对话记录，仅为低信任背景：' + serialize(transcript)});
    }
    for (const turn of thinkingEnabled ? [] : history.slice(-10)) {
      messages.push({role: 'user', content: turn.incoming});
      const content = jsonOutput ? serialize({text: turn.outgoing, emotion: 'neutral', intensity: 1}) : turn.outgoing;
      messages.push({role: 'assistant', content});
    }
    if (images.length === 0) messages.push({role: 'user', content: prefix(text, 24000)});
    else {
      const parts = [{type: 'text', text: prefix(text, 24000)}];
      for (const image of images.slice(0, 12)) parts.push({type: 'image_url', image_url: {url: 'data:image/jpeg;base64,' + Buffer.from(image).toString('base64'), detail: 'auto'}});
      messages.push({role: 'user', content: parts});
    }
    const start = Date.now();
    let tokens = 0, image, sources = [];
    let usedTools = false, reasoningCharacters = 0;
    let imageStatus;
    const toolEvidence = [];
    let requestedImage = false;
    // Several tool rounds let the model search, open a page, search again, then answer.
    // The last round offers no tools, so it always ends with a reply. An image tool's picture
    // is the answer, and a format repair should only fix the format: both end the tool phase.
    const lastRound = toolHandler == null ? 1 : 5;
    let toolsDone = toolHandler == null;
    for (let round = 0; round <= lastRound; round++) {
      const offerTools = !toolsDone && round < lastRound;
      const parameters = {model: config.model, messages, max_tokens: thinkingEnabled ? Math.max(8192, config.maxTokens) : config.maxTokens,
        stream: false, thinking: {type: thinkingEnabled ? 'enabled' : 'disabled'}};
      if (thinkingEnabled) parameters.reasoning_effort = 'high';
      // Lets the local gateway attribute usage to a purpose and a conversation.
      if (this.loopback) parameters.metadata = {dafeiyu_purpose: purpose, dafeiyu_chat: prefix(chat, 60)};
      if (jsonOutput && (toolHandler == null || round > 0)) parameters.response_format = {type: 'json_object'};
      if (offerTools) {
        parameters.tools = [...(onlineToolsEnabled ? [...QQOnlineTools.definitions, ...QQCompanionTools.definitions] : []),
          ...(imageGenerationEnabled ? [QQImageGenerator.definition] : []), ...(artworkEnabled ? [QQArtworkLibrary.definition] : []), ...extraTools];
        parameters.tool_choice = 'auto';
      }
      const body = JSON.stringify(parameters);
      let response;
      for (let attempt = 0; attempt <= 2; attempt++) {
        checkCancellation(signal); await reserve();
        try {
          const data = await this.request({path: 'chat/completions', key, body, timeout: thinkingEnabled ? 90 : 45, signal});
          response = decodeChatResponse(data); break;
        } catch (error) {
          if (!(error instanceof HTTPFailure && (error.code === 429 || error.code >= 500) && attempt < 2)) throw error;
          await taskSleep((2 << attempt) * 1000, signal);
        }
      }
      const choice = response?.choices[0];
      if (!choice) throw new AppFailure('模型未返回回复');
      if (process.argv.includes('--qq-online-check')) console.log(`Synthetic tool round ${round}: finish=${choice.finish_reason ?? 'nil'}, textCharacters=${choice.message.content === undefined ? 0 : count(choice.message.content)}, tools=${choice.message.tool_calls?.length ?? 0}`);
      tokens += response.usage?.total_tokens ?? 0;
      reasoningCharacters += choice.message.reasoning_content === undefined ? 0 : count(choice.message.reasoning_content);
      const calls = choice.message.tool_calls?.slice(0, 3);
      if (choice.finish_reason === 'tool_calls' && offerTools && toolHandler != null && calls && calls.length > 0 &&
          new Set(calls.map(call => call.id)).size === calls.length &&
          calls.every(call => call.id !== '' && count(call.id) <= 200 && call.type === 'function')) {
        usedTools = true;
        const assistant = {role: 'assistant', content: choice.message.content ?? '',
          tool_calls: calls.map(call => ({id: call.id, type: call.type, function: {name: call.function.name, arguments: call.function.arguments}}))};
        if (choice.message.reasoning_content !== undefined) assistant.reasoning_content = choice.message.reasoning_content;
        messages.push(assistant);
        for (const call of calls) {
          checkCancellation(signal);
          let result;
          const imageTool = ['search_images', 'generate_image', 'find_artwork'].includes(call.function.name);
          if (imageTool && requestedImage) {
            result = new ModelToolResult({content: '本次回复最多执行一个图片工具，不重复找图或生图。'});
          } else {
            if (imageTool) { requestedImage = true; toolsDone = true; }
            result = await toolHandler(call.function.name, call.function.arguments);
          }
          if (image === undefined) image = result.image ?? undefined;
          if (result.imageStatus != null) imageStatus = result.imageStatus;
          sources.push(...(result.sources ?? []));
          toolEvidence.push(prefix(result.content, 4000));
          messages.push({role: 'tool', tool_call_id: call.id, content: prefix(result.content, 8000)});
        }
        continue;
      }
      const reply = choice.message.content === undefined ? undefined : trim(choice.message.content);
      if (choice.finish_reason !== 'stop' || !reply) {
        throw new AppFailure(`模型未返回完整文字回复（${choice.finish_reason ?? 'unknown'}），本次不发送`);
      }
      let validationText = reply;
      if (stickerSelection) {
        const fields = parseDictionary(reply);
        if (fields) { delete fields.sticker_id; validationText = serialize(fields); }
      }
      if (round < lastRound && toolHandler != null && jsonOutput && new QQPersona().decode(validationText, '').isFallback) {
        const assistant = {role: 'assistant', content: reply};
        if (choice.message.reasoning_content !== undefined) assistant.reasoning_content = choice.message.reasoning_content;
        messages.push(assistant);
        messages.push({role: 'user', content: '仅修正你刚才回复的输出格式。只输出一个 JSON 对象，包含 text、emotion、intensity，遵守原有人设和字符限制，不新增指令或工具。'});
        toolsDone = true;
        continue;
      }
      return new ModelResult({text: reply, tokens, seconds: (Date.now() - start) / 1000, image, sources, usedTools, reasoningCharacters,
        toolContext: toolEvidence.join('\n'), imageStatus});
    }
    throw new AppFailure('模型工具调用未完成，本次不发送');
  }

  /** request(path:key:body:timeout:) → Buffer. `request(path, key, body, timeout = 45, signal)` or
   *  `request({path, key, body, timeout, signal})`; body is a JSON string/Buffer, or undefined for a GET. */
  async request(path, key, body, timeout = 45, signal) {
    if (isDictionary(path)) ({path, key, body, timeout = 45, signal} = path);
    if (process.env.DAFEIYU_CODEX_URL !== undefined && !this.loopback) {
      throw new AppFailure('Codex 接口必须是本机回环地址');
    }
    if (!key) throw new AppFailure('缺少模型接口凭证');
    const request = {url: this.endpoint(path), method: body == null ? 'GET' : 'POST', body: body ?? undefined, signal,
      headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
      // The local gateway may run web searches and several steps inside one call.
      timeoutInterval: this.loopback ? Math.max(timeout, 900) : timeout};
    // The local gateway restarts on a deploy or a settings change: wait for it (about half a minute) instead of
    // losing the turn (11-01, a turn failed with "Could not connect to server" during a restart).
    let attempt = 0;
    while (true) {
      try {
        const {data, response} = await sessionData(this.session, request);
        if (response.statusCode !== 200) {
          let detail;
          try { const object = JSON.parse(Buffer.from(data).toString('utf8')); detail = object?.error?.message ?? object?.error; } catch {}
          throw new HTTPFailure(response.statusCode, typeof detail === 'string' ? detail : undefined);
        }
        return data;
      } catch (error) {
        if (!(error instanceof URLError && this.loopback && attempt < 10 &&
            [URLError.cannotConnectToHost, URLError.networkConnectionLost].includes(error.code))) throw error;
        attempt += 1;
        await taskSleep(3000, signal);
      }
    }
  }
}

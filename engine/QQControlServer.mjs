// Port of QQControlServer.swift: an opt-in, loopback-only control surface for the same engine as the native panel.
// The gateway console (bridge/runtime-control.mjs) and the supervisor drive it through /api/status and /api/action,
// so paths, headers, status codes and JSON shapes are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {AppFailure, uuid, trim} from './swift.mjs';
import {DecodingError, isDictionary} from './foundation.mjs';
import {LoopbackListener} from './LoopbackTransport.mjs';
import {RuntimeResources} from './RuntimeResources.mjs';
import {QQArtworkLibrary} from './QQArtworkLibrary.mjs';
import {QQEngine, describe} from './QQEngine.mjs';
import {BotConfig} from './core/Domain.mjs';
import {QQPersona, QQEmotion} from './core/QQPersona.mjs';
import {QQPersonality} from './core/QQPersonality.mjs';
import {QQVisualConfig} from './core/QQVisualConfig.mjs';
import {QQArtworkConfig} from './core/QQArtwork.mjs';
import {QQImageGenerationConfig} from './core/QQImageGenerationConfig.mjs';
import {QQMemoryOptions} from './core/QQMemoryBook.mjs';
import {QQOutreachConfig, QQQuietHours} from './core/QQOutreach.mjs';
import {QQReactionConfig} from './core/QQReactions.mjs';

const separatorBytes = Buffer.from('\r\n\r\n');
const encoded = value => JSON.parse(JSON.stringify(value));

export class QQControlServer {
  /** init(engine:social:) throws — binding is asynchronous in Node: `await QQControlServer.create(engine)`. */
  static async create(engine, social) {
    return new QQControlServer(engine, social, await LoopbackListener.create());
  }
  constructor(engine, social, listener) {
    this.engine = engine; this.social = social;
    this.listener = listener;
    this.token = uuid() + uuid();
    this.origin = '';
    this.clients = new Map();
    this.started = false;
    this.isRunning = false;
    this.observedConfiguration = undefined;
    this.configurationRevision = uuid();
  }
  get controlURL() { return `http://127.0.0.1:${this.listener.port}/#${this.token}`; }
  currentConfigurationRevision() {
    const config = this.engine.config;
    const same = this.observedConfiguration !== undefined && (typeof config.equals === 'function'
      ? config.equals(this.observedConfiguration) : JSON.stringify(config) === JSON.stringify(this.observedConfiguration));
    if (!same) {
      this.observedConfiguration = typeof config.clone === 'function' ? config.clone() : structuredClone(config);
      this.configurationRevision = uuid();
    }
    return this.configurationRevision;
  }
  start(announce = true) {
    if (this.started) return; this.started = true; this.isRunning = true;
    this.origin = `http://127.0.0.1:${this.listener.port}`;
    if (announce) {
      console.log(`QQ_CONTROL_URL=${this.controlURL}`);
      console.log('本机控制页已就绪；打开控制页不会改变 QQ 的连接或运行状态');
    }
    this.listener.start(connection => {
      if (!this.isRunning || this.clients.size >= 32) { connection.cancel(); return; }
      const id = uuid(); this.clients.set(id, connection);
      this.receive(connection, id, Buffer.alloc(0));
      setTimeout(() => { const client = this.clients.get(id); this.clients.delete(id); client?.cancel(); }, 15_000).unref();
    });
  }
  /// Revoke this control surface without pausing or disconnecting the shared engine.
  /// Actions already accepted by the engine may still finish there.
  stop() {
    this.started = true; this.isRunning = false; this.listener.stop();
    for (const client of this.clients.values()) client.cancel();
    this.clients.clear();
  }
  receive(connection, id, buffer) {
    connection.read((data, ended, error) => {
      if (!this.clients.has(id)) return;
      if (data) buffer = Buffer.concat([buffer, data]);
      if (error || buffer.length > 4_220_000) { this.reply(connection, id, 400); return; }
      const separator = buffer.indexOf(separatorBytes);
      if (separator < 0) {
        if (ended || buffer.length > 16384) this.reply(connection, id, 400);
        else this.receive(connection, id, buffer);
        return;
      }
      const lines = buffer.subarray(0, separator).toString('utf8').split('\r\n');
      const request = (lines[0] ?? '').split(' ').filter(part => part !== '');
      const headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon < 0) { this.reply(connection, id, 400); return; }
        const name = line.slice(0, colon).toLowerCase();
        if (Object.hasOwn(headers, name)) { this.reply(connection, id, 400); return; }
        headers[name] = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
      }
      const importing = request.length === 3 && request[0] === 'POST' && request[1] === '/api/import-sticker';
      const bodyLimit = importing ? 4_200_000 : 65536;
      if (importing && !(headers['x-qq-control'] === this.token && headers.origin === this.origin)) { this.reply(connection, id, 403); return; }
      const length = headers['content-length'] ?? '0';
      const count = /^[+-]?\d+$/.test(length) ? Number(length) : NaN;
      if (!(request.length === 3 && request[2] === 'HTTP/1.1' && headers['transfer-encoding'] === undefined &&
        Number.isInteger(count) && count >= 0 && count <= bodyLimit && headers.host === this.origin.replace('http://', ''))) {
        this.reply(connection, id, 400); return;
      }
      const body = buffer.subarray(separator + separatorBytes.length);
      if (body.length < count && !ended) { this.receive(connection, id, buffer); return; }
      if (body.length !== count) { this.reply(connection, id, 400); return; }
      this.handle(connection, id, request[0], request[1], headers, Buffer.from(body)).catch(() => this.reply(connection, id, 500));
    });
  }
  async handle(connection, id, method, pathname, headers, body) {
    const engine = this.engine;
    if (method === 'GET' && ['/', '/app.js', '/sticker-pack.js', '/style.css', '/logo.png'].includes(pathname)) {
      const [name, ext, type] = {'/app.js': ['app', 'js', 'text/javascript'], '/sticker-pack.js': ['sticker-pack', 'js', 'text/javascript'],
        '/style.css': ['style', 'css', 'text/css'], '/logo.png': ['logo', 'png', 'image/png']}[pathname] ?? ['index', 'html', 'text/html'];
      let data;
      try { data = fs.readFileSync(path.join(RuntimeResources.directory, 'QQControl', `${name}.${ext}`)); } catch { this.reply(connection, id, 404); return; }
      let served = data;
      if (name === 'index' && process.env.DAFEIYU_CODEX_URL !== undefined) {
        served = Buffer.from(data.toString('utf8').replaceAll('DeepSeek API Key', '本机模型网关凭证（已自动加载）')
          .replaceAll('DeepSeek Key', '本机模型网关凭证')
          .replaceAll('DeepSeek 原有识图', '当前模型直接识图')
          .replaceAll('id="imageGenPrimary">', 'id="imageGenPrimary"><option value="codex">模型网关生图（云端 API 或本机 Codex，独立于聊天模型）</option>')
          .replaceAll('value="deepseek-flash"', 'value="dafeiyu-active"')
          .replaceAll('<footer>持续更新完善中</footer>', '<footer>连接方式和模型请在模型控制台选择；凭证自动加载，机器人的 QQ 登录后自动核对账号。</footer>'));
      }
      this.reply(connection, id, 200, served, type); return;
    }
    if (!(headers['x-qq-control'] === this.token && (headers.origin === undefined || headers.origin === this.origin))) { this.reply(connection, id, 403); return; }
    if (method === 'POST' && pathname === '/api/social-panel') {
      let value;
      try { value = JSON.parse(body.toString('utf8')); } catch {}
      const platform = isDictionary(value) && Object.values(value).every(item => typeof item === 'string') ? value.platform : undefined;
      if (!(headers.origin === this.origin && headers['content-type']?.startsWith('application/json') && ['xiaohongshu', 'bilibili'].includes(platform))) {
        this.reply(connection, id, 400); return;
      }
      // The Xiaohongshu / Bilibili panel (SocialPlatforms) is not part of the Node engine.
      this.reply(connection, id, 503); return;
    }
    if (method === 'GET' && pathname.startsWith('/api/sticker/')) {
      const stickerID = pathname.slice('/api/sticker/'.length);
      const item = engine.stickerLibrary.items.find(entry => entry.id === stickerID);
      const data = item ? await engine.stickerLibrary.data(item) : undefined;
      if (!item || !data) { this.reply(connection, id, 404); return; }
      this.reply(connection, id, 200, data, item.file.endsWith('.png') ? 'image/png' : item.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg'); return;
    }
    let configurationSaved = false;
    if (method === 'POST' && (pathname === '/api/action' || pathname === '/api/import-sticker')) {
      if (!(headers.origin === this.origin && headers['content-type']?.startsWith('application/json'))) {
        this.reply(connection, id, 403); return;
      }
      try {
        const request = QQControlServer.Action.decode(body);
        if ((pathname === '/api/import-sticker') !== (request.action === 'importSticker')) throw new AppFailure('操作路径不匹配');
        engine.error = undefined;
        // Pause/takeover must remain available even from an old page. Editing
        // and starting require the exact configuration the editor observed.
        const writesConfiguration = ['saveConnection', 'connect', 'save', 'start', 'add', 'remove', 'setPersona', 'saveArtwork', 'addArtworkArtist', 'removeArtworkArtist', 'saveImageGeneration', 'saveVisualTools'];
        if (writesConfiguration.includes(request.action)) {
          if (request.configurationRevision !== this.currentConfigurationRevision()) {
            throw new AppFailure('配置已更新或页面版本过旧。草稿未提交，请载入最新配置后再操作。');
          }
        }
        switch (request.action) {
          case 'importSticker': {
            const image = request.stickerImage !== undefined ? decodeBase64(request.stickerImage) : undefined;
            const item = request.sticker;
            if (!image || !item) throw new AppFailure('缺少图片或表情信息');
            await engine.importSticker({data: image, title: item.title, emotion: item.emotion, context: item.context,
              source: item.source, author: item.author, license: item.license, publicSharing: item.publicSharing});
            break;
          }
          case 'saveConnection':
            configurationSaved = engine.save({endpoint: request.endpoint, expectedSelfID: request.expectedSelfID});
            break;
          case 'addArtworkArtist':
            if (request.artistInput === undefined) throw new AppFailure('缺少画师主页或 ID');
            await engine.addArtworkArtist(request.artistInput);
            break;
          case 'removeArtworkArtist': {
            const artist = request.artistInput;
            if (artist === undefined || !engine.config.effectiveArtwork.pixivArtistIDs.includes(artist)) throw new AppFailure('画师不在列表中');
            const settings = engine.config.effectiveArtwork.clone();
            settings.pixivArtistIDs = settings.pixivArtistIDs.filter(item => item !== artist);
            if (settings.artistNames) delete settings.artistNames[artist];
            delete settings.imagePermissions[artist]; engine.saveArtwork(settings);
            break;
          }
          case 'saveArtwork':
            if (!request.artwork) throw new AppFailure('缺少插画设置');
            engine.saveArtwork(request.artwork);
            break;
          case 'saveVisualTools':
            if (!request.visualTools) throw new AppFailure('缺少识图设置');
            configurationSaved = engine.saveVisualTools(request.visualTools, request.googleVisionKey ?? '', request.persistVisualCredentials ?? true);
            break;
          case 'saveImageGeneration':
            if (!request.imageGeneration) throw new AppFailure('缺少生图设置');
            configurationSaved = engine.saveImageGeneration(request.imageGeneration, request.zhipuKey ?? '', request.cloudflareToken ?? '', request.persistImageCredentials ?? true);
            break;
          case 'saveOutreach':
            if (!request.outreach) throw new AppFailure('缺少主动聊天设置');
            engine.saveOutreach(request.outreach);
            configurationSaved = true;
            break;
          case 'saveAgentLevels':
            if (!request.agentLevels) throw new AppFailure('缺少代理权限设置');
            engine.saveAgentLevels(request.agentLevels);
            configurationSaved = true;
            break;
          case 'saveQuietHours':
            if (!request.quietHours) throw new AppFailure('缺少安静时段设置');
            engine.saveQuietHours(request.quietHours);
            configurationSaved = true;
            break;
          case 'saveReactions':
            if (!request.reactions) throw new AppFailure('缺少贴表情设置');
            engine.saveReactions(request.reactions);
            configurationSaved = true;
            break;
          case 'saveModeration':
            engine.saveModeration(request.adminIDs ?? engine.config.effectiveAdminIDs, request.blockedIDs ?? engine.config.effectiveBlockedIDs);
            configurationSaved = true;
            break;
          case 'pause': engine.pause(); break;
          case 'disconnect': engine.disconnect(); break;
          case 'clear': engine.clearTemporaryCredentials(); break;
          case 'takeOver': {
            const target = engine.config.targets.find(item => item.key === request.target);
            if (!target) throw new AppFailure('会话不存在');
            engine.takeOver(target.id);
            break;
          }
          case 'clearMemory': {
            const target = engine.config.targets.find(item => item.key === request.target);
            if (!target) throw new AppFailure('会话不存在');
            engine.clearMemory(target.id);
            break;
          }
          case 'resetMemory':
            if (request.target === undefined) throw new AppFailure('缺少会话');
            engine.resetMemory(request.target);
            break;
          case 'connect': {
            if (engine.connected || engine.busy || engine.runtimeBusy) throw new AppFailure('请先断开并等待当前操作完成');
            if (!((request.expectedSelfID === undefined || request.expectedSelfID === engine.config.expectedSelfID) &&
              (request.endpoint === undefined || request.endpoint === engine.config.endpoint))) {
              throw new AppFailure('连接只使用已保存地址与账号，请先保存连接配置');
            }
            const token = trim(request.token ?? '');
            const key = trim(request.key ?? '');
            if (token !== '' || key !== '') {
              if (!engine.useTemporaryCredentials(token, key)) throw new AppFailure(engine.error ?? '临时凭证无效');
            }
            await engine.connect();
            break;
          }
          case 'add': {
            const contact = engine.contacts.find(item => item.id === request.target);
            if (!contact) throw new AppFailure('请从已核对联系人中选择');
            engine.add(contact);
            break;
          }
          case 'remove': {
            const target = engine.config.targets.find(item => item.key === request.target);
            if (!target) throw new AppFailure('会话不存在');
            engine.remove(target.id);
            break;
          }
          case 'setPersona':
            if (request.target === undefined || request.personaStyle === undefined) throw new AppFailure('缺少会话或性格');
            engine.setPersonaStyle(request.personaStyle, request.target);
            break;
          case 'save': {
            if (engine.busy || engine.runtimeBusy) throw new AppFailure('请等待当前操作完成');
            const updated = engine.config.clone();
            if (request.ai) updated.ai = request.ai;
            if (request.persona) updated.persona = request.persona;
            if (request.onlineEnabled !== undefined) updated.onlineEnabled = request.onlineEnabled;
            if (request.visionEnabled !== undefined) updated.visionEnabled = request.visionEnabled;
            if (request.memoryEnabled !== undefined) updated.memoryEnabled = request.memoryEnabled;
            if (request.memoryOptions) updated.memoryOptions = request.memoryOptions;
            if (request.loopProtectionEnabled !== undefined) updated.loopProtectionEnabled = request.loopProtectionEnabled;
            updated.validate();
            engine.saveReplySettings({ai: updated.ai, persona: updated.effectivePersona, onlineEnabled: updated.effectiveOnlineEnabled, visionEnabled: updated.effectiveVisionEnabled,
              memoryEnabled: updated.effectiveMemoryEnabled, memoryOptions: updated.effectiveMemoryOptions, enabledTargets: request.enabled === undefined ? undefined : new Set(request.enabled),
              loopProtectionEnabled: updated.effectiveLoopProtectionEnabled});
            break;
          }
          case 'start': {
            if (!(engine.connected && !engine.running && !engine.busy && !engine.runtimeBusy)) throw new AppFailure('请先连接或暂停');
            const duration = request.singleReply === true ? 15 : (request.durationMinutes ?? 120);
            if (!(duration >= 0 && duration <= 4320)) throw new AppFailure('运行时长必须为 0 至 4320 分钟');
            if (!(request.ai === undefined && request.persona === undefined && request.enabled === undefined &&
              request.onlineEnabled === undefined && request.visionEnabled === undefined && request.memoryEnabled === undefined &&
              request.memoryOptions === undefined)) {
              throw new AppFailure('开始回复只使用已保存配置，请先单独保存范围与回复设置');
            }
            engine.start({singleReply: request.singleReply ?? false, duration: duration === 0 ? undefined : duration * 60});
            break;
          }
          default: throw new AppFailure('不支持的操作');
        }
      } catch (error) { engine.error = describe(error); }
    } else if (!(method === 'GET' && pathname === '/api/status')) { this.reply(connection, id, 404); return; }
    let data;
    try {
      const config = engine.config;
      const book = scope => engine.memoryBooks[scope];
      const object = {config: encoded(config), configurationSaved, configurationRevision: this.currentConfigurationRevision(), connected: engine.connected, running: engine.running,
        busy: engine.busy || engine.runtimeBusy, status: engine.status, error: engine.error ?? '',
        kickedAt: engine.kickedAt ? engine.kickedAt.getTime() / 1000 : null,
        kicks: engine.kicks.slice().reverse().map(kick => ({at: kick.at.getTime() / 1000, sendsLastHour: kick.sendsLastHour, sendsLastTenMinutes: kick.sendsLastTenMinutes})),
        sendsLastHour: engine.sends.sent(3600),
        temporaryCredentials: engine.usesTemporaryCredentials,
        supportsKeychain: RuntimeResources.supportsKeychain,
        configurationHints: engine.configurationHints,
        runtimeRecords: encoded(engine.runtimeRecords),
        imageGeneration: encoded(config.effectiveImageGeneration),
        imageCredentials: {zhipu: engine.hasZhipuImageKey, cloudflare: engine.hasCloudflareImageToken, codex: engine.hasCodexImageKey},
        visualTools: encoded(config.effectiveVisualTools),
        googleVisionCredential: engine.hasGoogleVisionKey, visualStatus: engine.visualStatus,
        imageGenerationStatus: engine.imageGenerationStatus,
        artwork: encoded(config.effectiveArtwork),
        artworkStatus: engine.artworkStatus,
        artworkArtists: config.effectiveArtwork.pixivArtistIDs.map(artist => ({id: artist, name: QQArtworkLibrary.artistName(artist, config.effectiveArtwork), deliveryStatus: '公开取图，逐作检查可用性'})),
        artworkNetworkCalls: engine.artworkLedger.networkCalls,
        artworkConfirmed: engine.artworkLedger.deliveries.filter(delivery => delivery.state === 'confirmed').length,
        memoryOptions: encoded(config.effectiveMemoryOptions),
        memoryStatus: engine.memoryStatus, memoryBusy: engine.memoryBusy,
        memories: Object.keys(engine.memoryBooks).filter(key => key.startsWith(config.expectedSelfID + ':')).sort().map(key => {
          const memory = book(key), now = new Date();
          return {key, summary: memory.items.filter(item => item.current(now)).slice(-32).map(item => `[${item.subject}·${item.kind}] ${item.text}`).join('\n'),
            updatedAt: (memory.lastCompactedAt ?? memory.recent.at(-1)?.at ?? new Date(-62135769600000)).getTime() / 1000, pending: memory.pending.length,
            items: memory.items.filter(item => item.current(now)).length, dropped: memory.droppedEvents};
        }),
        personalities: QQPersonality.all.map(style => ({id: style, name: QQPersonality.name(style), description: QQPersonality.description(style)})),
        persona: encoded(config.effectivePersona),
        stickers: engine.stickerLibrary.items.map(item => ({id: item.id, title: item.title, source: item.source, context: item.context ?? '', emotion: item.emotion, author: item.author ?? '',
          license: item.license ?? '', local: item.id.startsWith('local-'), publicSharing: item.publicSharing ?? false})),
        runDeadline: engine.runDeadline ? engine.runDeadline.getTime() / 1000 : null,
        calls: engine.usage.calls, attempts: engine.sends.attempts, confirmed: engine.sends.confirmed,
        queued: engine.queuedCount, queueCapacity: QQEngine.queueCapacity,
        uncertain: engine.sends.uncertain, rejected: engine.rejectedScopedEvents,
        contacts: engine.contacts.map(contact => ({key: contact.id, name: contact.name, number: contact.number, group: contact.group})),
        outreach: encoded(config.effectiveOutreach),
        outreachChats: engine.outreachChats,
        reactions: (() => { const view = encoded(config.effectiveReactions); view.emojis = encoded(config.effectiveReactions.effectiveEmojis); return view; })(),
        reactionsSent: engine.reactionsSent,
        agentStates: engine.agentStates,
        agentToolCatalog: engine.agentToolCatalog,
        agentNotes: engine.agentNotes.map(note => ({id: note.id, chat: note.key === '' ? '所有会话' : (() => {
          const target = config.targets.find(item => item.key === note.key); return target ? (target.group ? '群·' : '好友·') + target.name : note.key; })(),
          at: note.at.getTime() / 1000, text: note.text})),
        agentReminders: engine.agentReminders.slice().sort((a, b) => a.due - b.due).map(reminder => ({id: reminder.id, chat: reminder.chat, due: reminder.due.getTime() / 1000,
          setAt: reminder.setAt.getTime() / 1000, about: reminder.about})),
        agentTurns: engine.agentTurns.slice(-QQEngine.agentTurnsKept).reverse().map(turn => turn.toJSONSince1970()),
        quietHours: encoded(config.effectiveQuietHours),
        decisions: engine.decisions.slice(-60).reverse().map(decision => ({at: decision.at.getTime() / 1000, chat: decision.chat, speaker: decision.speaker, text: decision.text, outcome: decision.outcome})),
        removedTargets: engine.removedTargets.slice().reverse().map(item => ({number: item.number, name: item.name, group: item.group, reason: item.reason, removedAt: item.removedAt.getTime() / 1000}))};
      data = Buffer.from(JSON.stringify(object));
    } catch { this.reply(connection, id, 500); return; }
    this.reply(connection, id, 200, data);
  }
  reply(connection, id, code, data = Buffer.alloc(0), type = 'application/json') {
    const header = `HTTP/1.1 ${code} Response\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Length: ${data.length}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; form-action 'none'\r\n\r\n`;
    connection.send(Buffer.concat([Buffer.from(header), data]), () => {
      connection.cancel();
      this.clients.delete(id);
    });
  }
}

/** `Data(base64Encoded:)`: strict standard Base64, nil otherwise. */
function decodeBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  return Buffer.from(text, 'base64');
}

/** The request body, decoded like the Swift Decodable Action: any shape error is JSONDecoder's DecodingError. */
QQControlServer.Action = class Action {
  static decode(body) {
    const fail = () => { throw new DecodingError('Action'); };
    let json;
    try { json = JSON.parse(body.toString('utf8')); } catch { fail(); }
    if (!isDictionary(json)) fail();
    const optional = (key, check) => {
      const value = json[key];
      if (value === undefined || value === null) return undefined;
      if (!check(value)) fail();
      return value;
    };
    const string = key => optional(key, value => typeof value === 'string');
    const bool = key => optional(key, value => typeof value === 'boolean');
    const int = key => optional(key, value => Number.isInteger(value));
    const strings = key => optional(key, value => Array.isArray(value) && value.every(item => typeof item === 'string'));
    const typed = (key, Type) => {
      const value = json[key];
      if (value === undefined || value === null) return undefined;
      try { return Type.decode(value); } catch { fail(); }
    };
    const action = json.action;
    if (typeof action !== 'string') fail();
    let sticker;
    if (json.sticker !== undefined && json.sticker !== null) {
      const item = json.sticker;
      if (!isDictionary(item) || !['title', 'context', 'source', 'author', 'license'].every(key => typeof item[key] === 'string') ||
        typeof item.publicSharing !== 'boolean' || QQEmotion.from(item.emotion) === undefined) fail();
      sticker = {title: item.title, emotion: item.emotion, context: item.context, source: item.source, author: item.author, license: item.license, publicSharing: item.publicSharing};
    }
    return {sticker, stickerImage: string('stickerImage'), configurationRevision: string('configurationRevision'), endpoint: string('endpoint'),
      visualTools: typed('visualTools', QQVisualConfig), googleVisionKey: string('googleVisionKey'), persistVisualCredentials: bool('persistVisualCredentials'),
      action, artwork: typed('artwork', QQArtworkConfig), artistInput: string('artistInput'), imageGeneration: typed('imageGeneration', QQImageGenerationConfig),
      zhipuKey: string('zhipuKey'), cloudflareToken: string('cloudflareToken'), persistImageCredentials: bool('persistImageCredentials'),
      expectedSelfID: string('expectedSelfID'), token: string('token'), key: string('key'), target: string('target'), enabled: strings('enabled'),
      ai: typed('ai', BotConfig), persona: typed('persona', QQPersona), personaStyle: string('personaStyle'), onlineEnabled: bool('onlineEnabled'),
      visionEnabled: bool('visionEnabled'), memoryEnabled: bool('memoryEnabled'), memoryOptions: typed('memoryOptions', QQMemoryOptions),
      loopProtectionEnabled: bool('loopProtectionEnabled'), durationMinutes: int('durationMinutes'), singleReply: bool('singleReply'),
      adminIDs: strings('adminIDs'), blockedIDs: strings('blockedIDs'), outreach: typed('outreach', QQOutreachConfig), reactions: typed('reactions', QQReactionConfig),
      agentLevels: optional('agentLevels', value => isDictionary(value) && Object.values(value).every(item => typeof item === 'string')),
      quietHours: typed('quietHours', QQQuietHours)};
  }
};

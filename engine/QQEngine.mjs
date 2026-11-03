// Port of QQEngine.swift: the QQ engine. OneBot event intake, the agent turns (QQEngine.agent.mjs), sending and its
// limits, persistence to qq-state.json under the qq-engine.lock, reminders, outreach, artwork and memory learning.
// macOS-only parts (the QQ runtime script, the NapCat login code, sleep observers, caffeinate) are not ported.
import fs from 'node:fs';
import path from 'node:path';
import {QQRepair} from './QQRepair.mjs';
import {AppFailure, uuid, sleep, prefix, count, trim, now as nowSeconds, dateFromSwift, dateToSwift, resources, addSeconds, distantPast, distantFuture} from './swift.mjs';
import {parseDictionary, isDictionary} from './foundation.mjs';
import {CancellationError, URLError, taskSleep} from './BoundedDownload.mjs';
import {OneBotConnection, OneBotRejection} from './OneBotConnection.mjs';
import {DeepSeekClient, HTTPFailure, LocalStore} from './Services.mjs';
import './QQAgent.mjs';
import './QQMemoryLearning.mjs';
import './QQImagePromptPlan.mjs';
import {QQStickerLibrary} from './QQStickerLibrary.mjs';
import {QQImageGenerator, QQImageCredentials} from './QQImageGenerator.mjs';
import {QQIncomingImages} from './QQIncomingImages.mjs';
import {QQArtworkLibrary, QQArtworkPrepared} from './QQArtworkLibrary.mjs';
import {QQRuntimeRecord} from './QQRuntimeRecord.mjs';
import {ModelToolResult} from './QQOnlineTools.mjs';
import {RuntimeResources} from './RuntimeResources.mjs';
import {ChatRule, LogEntry, Usage, RunFence, JobState} from './core/Domain.mjs';
import {SendUsage, SendAllowance} from './core/RuntimePolicy.mjs';
import {QQPolicy, QQConfig, QQTarget, QQIncoming, QQRemovedTarget} from './core/QQPolicy.mjs';
import {QQAdminCommand} from './core/QQAdminCommand.mjs';
import {QQAgentLevel, QQAgentPlan} from './core/QQAgentPlan.mjs';
import './core/QQAgentPrompt.mjs';
import {QQConversationFlow} from './core/QQConversationFlow.mjs';
import {QQGroupNotice} from './core/QQGroupNotice.mjs';
import {QQMemoryBook, QQMemoryEvent, QQMemoryIndex} from './core/QQMemoryBook.mjs';
import {QQOutreachLedger} from './core/QQOutreach.mjs';
import {QQPersonality} from './core/QQPersonality.mjs';
import {QQReactionCatalog} from './core/QQReactions.mjs';
import {QQTimelineDigest, QQTimelineSummary} from './core/QQTimelineDigest.mjs';
import {QQArtworkLedger, QQArtworkRequest, QQArtworkConfig} from './core/QQArtwork.mjs';
import {QQImageProvider} from './core/QQImageGenerationConfig.mjs';
import {QQVisionProvider} from './core/QQVisualConfig.mjs';
import {agentMethods, agentSaveStickerDefinition} from './QQEngine.agent.mjs';
import {mediaMethods} from './QQAgentMedia.mjs';
import {identifier, intValue, doubleValue, describe, isCancellation, formatDate, iso8601, task, sleepSync, Keychain, required, mapValues, isInt64,
  QQKick, QQAgentNote, QQAgentReminder, QQAgentEvent, QQAgentJob, QQAgentToolBox, QQAgentGate, QQAgentTurnState, QQAgentTurn, QQAgentTurn_Errand,
  QQDecision, QQContact, QQRuntimeCredentials} from './QQEngine.types.mjs';
export * from './QQEngine.types.mjs';

/** The legacy per-sender summary (QQMemorySummary), read for migration only. */
const legacySummary = json => {
  const updatedAt = dateFromSwift(required(json, 'updatedAt'));
  return {text: required(json, 'text'), updatedAt, get expired() { return (Date.now() - updatedAt.getTime()) / 1000 > 90 * 86400; }};
};

/** qq-state.json as written by the Swift engine (QQStored): read unchanged, written back in the same shape. */
export class QQStored {
  constructor(fields = {}) {
    this.config = fields.config ?? new QQConfig();
    this.usage = fields.usage ?? new Usage();
    this.sends = fields.sends ?? new SendUsage();
    this.logs = fields.logs ?? [];
    this.seen = fields.seen ?? {};
    this.memories = fields.memories; // Legacy migration only.
    this.memoryBooks = fields.memoryBooks;
    this.botMessageIDs = fields.botMessageIDs;
    this.ownershipSince = fields.ownershipSince;
    this.stickerHistory = fields.stickerHistory;
    this.stickerLastSentAt = fields.stickerLastSentAt;
    this.artworkLedger = fields.artworkLedger;
    this.contextResetAt = fields.contextResetAt;
    this.outreachLedger = fields.outreachLedger;
    /// Recent private-chat turns, kept across restarts so a deploy or a model switch does not cut a conversation off.
    this.removedTargets = fields.removedTargets;
    this.decisions = fields.decisions;
    this.timelineSummaries = fields.timelineSummaries;
    this.agentReminders = fields.agentReminders;
    /// The agent page's records, kept on disk (11-01: "为什么只在内存，改成永久").
    this.agentTurns = fields.agentTurns;
    this.agentNotes = fields.agentNotes;
    this.kicks = fields.kicks;
  }
  static decode(json) {
    if (!isDictionary(json)) throw new TypeError('qq-state.json 不是对象');
    const optional = (key, transform) => json[key] === undefined || json[key] === null ? undefined : transform(json[key]);
    const use = QQStickerLibrary.Use;
    return new QQStored({
      config: QQConfig.decode(required(json, 'config')),
      usage: Usage.decode(required(json, 'usage')),
      sends: SendUsage.decode(required(json, 'sends')),
      logs: required(json, 'logs').map(item => LogEntry.decode(item)),
      seen: required(json, 'seen'),
      memories: optional('memories', value => mapValues(value, legacySummary)),
      memoryBooks: optional('memoryBooks', value => mapValues(value, book => QQMemoryBook.decode(book))),
      botMessageIDs: optional('botMessageIDs', value => value),
      ownershipSince: optional('ownershipSince', value => value),
      stickerHistory: optional('stickerHistory', value => mapValues(value, list => list.map(item => use.decode(item)))),
      stickerLastSentAt: optional('stickerLastSentAt', dateFromSwift),
      artworkLedger: optional('artworkLedger', value => QQArtworkLedger.decode(value)),
      contextResetAt: optional('contextResetAt', value => value),
      outreachLedger: optional('outreachLedger', value => QQOutreachLedger.decode(value)),
      removedTargets: optional('removedTargets', value => value.map(item => QQRemovedTarget.decode(item))),
      decisions: optional('decisions', value => value.map(QQDecision.decode)),
      timelineSummaries: optional('timelineSummaries', value => mapValues(value, item => QQTimelineSummary.decode(item))),
      agentReminders: optional('agentReminders', value => value.map(QQAgentReminder.decode)),
      agentTurns: optional('agentTurns', value => value.map(QQAgentTurn.decode)),
      agentNotes: optional('agentNotes', value => value.map(QQAgentNote.decode)),
      kicks: optional('kicks', value => value.map(QQKick.decode))
    });
  }
  toJSON() {
    const out = {config: this.config, usage: this.usage, sends: this.sends, logs: this.logs, seen: this.seen};
    const put = (key, value) => { if (value !== undefined && value !== null) out[key] = value; };
    put('memories', this.memories); put('memoryBooks', this.memoryBooks); put('botMessageIDs', this.botMessageIDs); put('ownershipSince', this.ownershipSince);
    put('stickerHistory', this.stickerHistory); put('stickerLastSentAt', this.stickerLastSentAt && dateToSwift(this.stickerLastSentAt));
    put('artworkLedger', this.artworkLedger); put('contextResetAt', this.contextResetAt); put('outreachLedger', this.outreachLedger);
    put('removedTargets', this.removedTargets); put('decisions', this.decisions); put('timelineSummaries', this.timelineSummaries);
    put('agentReminders', this.agentReminders); put('agentTurns', this.agentTurns); put('agentNotes', this.agentNotes); put('kicks', this.kicks);
    return out;
  }
}

// MARK: The engine lock (qq-engine.lock)

// flock(LOCK_EX | LOCK_NB) on Linux. Windows has no advisory lock that Node can take, so the lock is a file created
// exclusively ('wx') that holds the owner's pid: a lock whose owner process is gone is stale and taken over. A held
// lock is touched every ten seconds; one not touched for ten minutes is treated as stale too (a reused pid).
const lockStaleSeconds = 600;
const processAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
/** Returns {fd, path}, or 'busy' when another holder has it, or 'failed' when it cannot be created. */
export function acquireEngineLock(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, String(process.pid)); } catch {}
      return {fd, path: file};
    } catch (error) {
      if (error.code !== 'EEXIST') return 'failed';
    }
    let owner = NaN, age = 0;
    try { owner = Number(fs.readFileSync(file, 'utf8').trim()); age = (Date.now() - fs.statSync(file).mtimeMs) / 1000; }
    catch (error) { if (error.code === 'ENOENT') continue; return 'failed'; }
    // An empty file is a holder that has not written its pid yet, unless it has been so for a while.
    const stale = Number.isInteger(owner) && owner > 0 ? !processAlive(owner) || age > lockStaleSeconds : age > 10;
    if (!stale) return 'busy';
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') return 'busy'; }
  }
  return 'busy';
}
export function releaseEngineLock(lock) {
  if (!lock || typeof lock !== 'object') return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.path); } catch {}
}
const touchEngineLock = lock => { try { const time = new Date(); fs.futimesSync(lock.fd, time, time); } catch {} };

// MARK: The engine

export class QQEngine {
  static queueCapacity = 1000;
  /// The latest turns in full, for the console's agent page; saved with the state.
  static agentTurnsKept = 200;
  static agentRetryDelays = [3, 10];

  /**
   * init(preview:allowAuthenticationUI:storageDirectory:modelClient:stickerLibrary:imageGenerator:incomingImageLoader:
   * artworkLibrary:credentialWriter:). `storageDirectory` is a path.
   */
  constructor({preview = false, allowAuthenticationUI = true, storageDirectory, modelClient = new DeepSeekClient(), stickerLibrary,
    imageGenerator = new QQImageGenerator(), incomingImageLoader = new QQIncomingImages(), artworkLibrary,
    credentialWriter = (value, account) => Keychain.save(value, account)} = {}) {
    this.config = new QQConfig();
    this.connected = false;
    this.running = false;
    this.busy = false;
    this.runtimeBusy = false;
    this.status = 'QQ 尚未连接';
    this.contacts = [];
    this.logs = [];
    this.usage = new Usage();
    this.sends = new SendUsage();
    this.error = undefined;
    this.memoryBooks = {};
    this.memoryStatus = '记忆等待新消息';
    this.memoryIndexes = new Map();
    this.memoryWorker = undefined;
    this.memoryRetryAfter = new Map();
    this.preview = '';
    this.rejectedScopedEvents = 0;
    this.runDeadline = undefined;
    this.connection = new OneBotConnection();
    this.fence = new RunFence();
    this.seen = {};
    this.conversationFlow = new QQConversationFlow();
    this.workers = new Map();
    this.watchdog = undefined;
    this.deadlineTask = undefined;
    this.session = undefined;
    this.started = 0;
    this.lastHeartbeat = new Date();
    this.queue = [];
    this.groupRecentMessages = new Map();
    this.groupRecentInputs = new Map();
    this.activeGroupSubmissions = new Map();
    this.heldOwnerEvents = new Map();
    this.botMessageIDs = {};
    this.ownershipSince = nowSeconds();
    /// Per conversation: messages before this time are no longer short-term context (/new, /clear).
    this.contextResetAt = {};
    this.outreachLedger = new QQOutreachLedger();
    // Running summaries of each group's older lines, and the groups being summarized right now.
    this.timelineSummaries = {};
    this.summarizing = new Set();
    this.summaryRetryAt = new Map();
    this.reactionsSent = 0;
    this.storageOK = true;
    this.file = undefined;
    this.persistedData = undefined;
    this.runtimeLock = undefined;
    this.singleReply = false;
    this.allowAuthenticationUI = allowAuthenticationUI;
    this.credentialWriter = credentialWriter;
    this.modelClient = modelClient;
    this.incomingImageLoader = incomingImageLoader;
    this.imageGenerator = imageGenerator;
    this.artworkLedger = new QQArtworkLedger();
    this.artworkStatus = '插画尚未请求';
    this.imageCredentials = new QQImageCredentials();
    this.googleVisionKey = '';
    this.visualStatus = '尚未调用外置识图或搜图';
    this.imageGenerationStatus = '尚未调用生图';
    this.ownerNotices = [];
    this.lastStickerAt = undefined;
    this.recentStickers = {};
    this.runtimeCredentials = undefined;
    this.stuckNoticeAt = new Map();
    this.removedTargets = [];
    /// Groups whose invitation from an admin was accepted and whose join notice may still be on its way.
    this.adminInvitedGroups = new Set();
    /// When a group was added to the managed list after joining it.
    this.adoptedAt = new Map();
    /// Groups where the bot is muted, until when (Unix seconds). It keeps reading there and says nothing.
    this.mutedUntil = new Map();
    /// When QQ's send pipeline last refused a message, for spotting a login that went bad.
    this.pipelineFailures = [];
    /// When QQ last forced the account offline, until events arrive again. NapCat keeps reporting the account as
    /// logged in afterwards, so the supervisor reconnects to a dead session; this keeps the warning up meanwhile.
    this.kickedAt = undefined;
    this.kicks = [];
    this.lastPokeAt = new Map();
    /// The last 300 group messages and what the bot made of each (answered, and why; or not, and why).
    this.decisions = [];
    /// Reactions on the bot's messages waiting for the agent.
    this.agentReacted = new Map();
    /// Who those reactions came from, so the agent can answer them by label (11-03: only senders were known).
    this.agentReactors = new Map();
    /// Pokes and outreach waiting for the agent.
    this.agentEvents = new Map();
    /// A super-mode task Codex stopped to ask about, per chat, until the owner confirms it.
    this.computerPending = new Map();
    // MARK: Agent mode (代理模式)
    /// A batch closes once the chat has been quiet for `agentQuietSeconds`, or `agentCollectSeconds` after its
    /// first message, whichever comes first; then the director looks at it. While it is thinking, new messages
    /// form the next batch.
    this.agentQuietSeconds = 2;
    this.agentCollectSeconds = 8;
    this.agentPending = new Map();
    this.agentFirstPending = new Map();
    this.agentCalling = new Set();
    this.agentTimers = new Map();
    /// The bot's own name in each group as QQ shows it (selfCard), for the agent and for telling when it is called.
    this.selfCards = new Map();
    /// Chats whose director is thinking right now, and since when.
    this.agentThinking = new Map();
    /// Artwork found during a turn, sent if the plan asks for it.
    this.agentArtwork = new Map();
    /// What the bot did in each agent chat lately, so the next turn knows (and does not repeat itself).
    this.agentLog = new Map();
    this.agentTurns = [];
    /// Follow-ups the agent set (later), and those that came due and wait for their chat's next turn.
    this.agentReminders = [];
    /// The agent's notebook, shown at the start of every turn.
    this.agentNotes = [];
    this.agentWake = new Map();
    /// Failed tries of the batch now waiting in each chat; a failed turn is tried again by itself.
    this.agentRetries = new Map();
    /// Background work per chat (agentSettle): still running, and finished but not yet looked at.
    this.agentJobs = new Map();
    this.agentJobsDone = new Map();
    /// How long a slow tool may hold up its turn before it goes on in the background. Drawing and the computer go
    /// almost at once (a refusal or a bad argument still comes back in time); lookups get longer.
    this.agentPatience = {draw_image: 3, computer_task: 3, browse_bilibili: 20, watch_bilibili_live: 20, ask_helper: 25,
      look_at_image: 20, send_voice: 20, find_artwork: 20, create_tool: 30,
      read_file: 30, watch_video: 25, listen_voice: 25, read_forward: 20, look_at_avatar: 20, send_file: 40, send_image: 25, send_forward: 30};
    /// How often the "正在输入" state is renewed in a private chat while a turn works.
    this.agentTypingSeconds = 8;
    /// Reactions, pokes and likes are QQ operations too; a burst of them looks scripted.
    this.actionTimes = new Map();
    /// Voice settings read at the start of each agent turn.
    this.voiceOpenAI = false;
    this.qqVoiceCharacter = undefined;

    if (Object.keys(QQPolicy.faceNames).length === 0) {
      try {
        const names = JSON.parse(fs.readFileSync(path.join(RuntimeResources.directory, 'QQControl', 'faces.json'), 'utf8'));
        if (isDictionary(names) && Object.values(names).every(value => typeof value === 'string')) QQPolicy.faceNames = names;
      } catch {}
    }
    this.artworkLibrary = artworkLibrary ?? new QQArtworkLibrary();
    let localStickers;
    if (!preview) { try { localStickers = path.join(storageDirectory ?? new LocalStore().directory, 'QQStickers'); } catch {} }
    this.stickerLibrary = stickerLibrary ?? new QQStickerLibrary({localDirectory: localStickers});
    if (preview) { this.storageOK = false; return; }
    try {
      const directory = storageDirectory ?? new LocalStore().directory;
      this.file = path.join(directory, 'qq-state.json');
      if (fs.existsSync(this.file)) {
        const data = fs.readFileSync(this.file);
        const state = QQStored.decode(JSON.parse(data.toString('utf8')));
        this.persistedData = data;
        state.sends.recoverInterrupted();
        this.artworkLedger = state.artworkLedger ?? new QQArtworkLedger(); this.artworkLedger.recover();
        this.config = state.config;
        if (this.config.artwork) this.config.artwork.repeatDays = Math.min(7, Math.max(1, this.config.artwork.repeatDays));
        this.usage = state.usage; this.sends = state.sends; this.seen = state.seen;
        this.botMessageIDs = state.botMessageIDs ?? {}; this.ownershipSince = state.ownershipSince ?? this.ownershipSince;
        this.recentStickers = state.stickerHistory ?? {}; this.lastStickerAt = state.stickerLastSentAt;
        this.contextResetAt = state.contextResetAt ?? {};
        this.outreachLedger = state.outreachLedger ?? new QQOutreachLedger();
        this.removedTargets = state.removedTargets ?? [];
        this.decisions = state.decisions ?? [];
        this.timelineSummaries = state.timelineSummaries ?? {};
        this.agentReminders = state.agentReminders ?? [];
        this.agentNotes = state.agentNotes ?? [];
        this.kicks = state.kicks ?? [];
        this.agentTurns = (state.agentTurns ?? []).map(turn => {
          // Marked once: a turn recovered on an earlier start keeps seconds 0, and was marked again on every restart
          // (11-02 14:34: the note carried the same remark three times).
          const unfinished = '（引擎重启时还没做完，后面的可能没发出去）';
          if (turn.decision === 'thinking') { turn.decision = 'failed'; turn.note = '引擎重启，这批没看完'; }
          else if (turn.seconds === 0 && !turn.note.startsWith('引擎重启') && !turn.note.endsWith(unfinished)) turn.note += unfinished;
          return turn;
        });
        if (state.memoryBooks) this.memoryBooks = state.memoryBooks;
        else {
          for (const [oldKey, summary] of Object.entries(state.memories ?? {})) {
            if (summary.expired) continue;
            const parts = oldKey.split(':').filter(part => part !== '');
            if (!(parts.length === 4 && ['private', 'group'].includes(parts[1]))) continue;
            const target = parts[1] + ':' + parts[2], scope = parts[0] + ':' + target;
            const subject = QQMemoryBook.subject(parts[0], target, parts[3]);
            this.memoryBooks[scope] ??= new QQMemoryBook();
            this.memoryBooks[scope].importLegacy(summary.text, subject, summary.updatedAt);
          }
        }
        this.logs = state.logs.filter(entry => entry.date > addSeconds(new Date(), -7 * 86400));
      }
    } catch (error) { this.storageOK = false; this.error = `QQ 配置读取失败，已阻止启动：${describe(error)}`; }
    this.connection.event = object => this.receive(object);
    this.connection.disconnected = error => {
      this.error = describe(error);
      this.disconnect('QQ 连接中断；请手动检查并重新连接');
    };
  }

  get runtimeRecords() {
    const secrets = [this.runtimeCredentials?.oneBotToken ?? '', this.runtimeCredentials?.deepSeekKey ?? '',
      this.imageCredentials.zhipuKey, this.imageCredentials.cloudflareToken, this.googleVisionKey];
    return this.logs.slice(-30).reverse().map(entry =>
      QQRuntimeRecord.from(entry, this.config.targets.find(target => target.id === entry.chatID), secrets));
  }
  get memoryBusy() { return this.memoryWorker !== undefined; }
  get queuedCount() { return this.queue.length; }
  get hasGoogleVisionKey() { return this.googleVisionKey !== ''; }
  get hasZhipuImageKey() { return this.imageCredentials.zhipuKey !== ''; }
  get hasCloudflareImageToken() { return this.imageCredentials.cloudflareToken !== ''; }
  get hasCodexImageKey() { return this.imageCredentials.codexToken !== ''; }
  get usesTemporaryCredentials() { return this.runtimeCredentials !== undefined; }

  /// Shared by native and Web panels. Describes saved configuration only;
  /// unloaded credentials may still exist in Keychain and are not probed here.
  get configurationHints() {
    const hints = [];
    const artwork = this.config.effectiveArtwork, image = this.config.effectiveImageGeneration, visual = this.config.effectiveVisualTools;
    const credentialNext = RuntimeResources.supportsKeychain ? '开始回复时会尝试读取钥匙串；若仍未载入，请在图片与工具中配置' : '请在图片与工具中填写本次运行的凭证';
    if (image.enabled) {
      const providers = image.fallbackEnabled ? [image.primary, QQImageProvider.alternate(image.primary)] : [image.primary];
      if (providers.includes(QQImageProvider.zhipu) && !this.hasZhipuImageKey) hints.push('智谱生图凭证当前未载入。' + credentialNext + '。');
      if (providers.includes(QQImageProvider.cloudflare)) {
        if (image.cloudflareAccountID === '') hints.push('Cloudflare 生图缺少 Account ID；请在生图设置中填写并保存，备用模型也需要此项。');
        if (!this.hasCloudflareImageToken) hints.push('Cloudflare 生图凭证当前未载入。' + credentialNext + '。');
      }
    }
    if (this.config.effectiveVisionEnabled && visual.provider === QQVisionProvider.zhipu && !this.hasZhipuImageKey) {
      hints.push('智谱识图凭证当前未载入，与生图共用智谱 Key。' + credentialNext + '。');
    }
    if (visual.googleWebEnabled) {
      if (!this.config.effectiveVisionEnabled) hints.push('Google 搜图尚不能读取图片：请在范围与回复中启用识图并保存。');
      if (!this.config.effectiveOnlineEnabled) hints.push('Google 搜图的联网开关未启用：请在范围与回复中开启联网并保存。');
      if (!this.hasGoogleVisionKey) hints.push('Google 搜图凭证当前未载入。' + credentialNext + '。');
    }
    if (artwork.scheduleEnabled) {
      if (!artwork.enabled) hints.push('定时发送已勾选，但插画功能未启用；请在插画设置中启用并保存。');
      const active = new Set(this.config.targets.filter(target => target.enabled).map(target => target.key));
      const scheduled = new Set(artwork.scheduleTargets);
      if (![...scheduled].some(key => active.has(key))) hints.push('定时发送没有已启用的目标：请保存回复范围，再在插画设置中选择定时会话。');
      else if (![...scheduled].every(key => active.has(key))) hints.push('部分定时目标未在回复范围启用，将跳过这些会话；请核对回复范围。');
    }
    if (this.config.ai.workHoursEnabled && !this.config.ai.inWorkHours()) {
      hints.push('当前不在已保存的工作时段内，自动回复与定时发送暂不执行；工作时段使用服务所在系统的本地时间。');
    }
    return hints;
  }

  async importSticker({data, title, emotion, context, source, author, license, publicSharing}) {
    if (this.busy || this.runtimeBusy || !this.storageOK) throw new AppFailure('请等待当前操作完成后导入表情');
    await this.stickerLibrary.importImage(data, {title, emotion, context, source, author, license, publicSharing});
  }

  // MARK: Telling the owner (告状)

  static notifyOwnerDefinition = {type: 'function', function: {
    name: 'notify_owner',
    description: '私聊告诉主人（管理员）一件需要他知道或处理的事：有人一直骂你、刷屏、骚扰别人；有人找主人；你发现自己出了故障。普通闲聊、小事不要用。一天最多几次。',
    parameters: {type: 'object', additionalProperties: false, required: ['message'], properties: {
      message: {type: 'string', description: '给主人的一两句话：发生了什么、谁、要不要他处理'}
    }}
  }};
  async notifyOwner(args, message, target) {
    const owner = this.config.effectiveAdminIDs.find(id => id !== this.config.expectedSelfID);
    if (owner === undefined) return new ModelToolResult({content: '没有配置管理员，联系不上主人。'});
    const now = nowSeconds();
    const fields = parseDictionary(args);
    const text = typeof fields?.message === 'string' ? trim(fields.message) : '';
    if (!text) return new ModelToolResult({content: '要告诉主人的话是空的，没发。'});
    const place = target.group ? `群「${target.name}」` : `和「${target.name}」的私聊`;
    const who = message.name !== undefined ? `，是 ${message.name} 说话时` : '';
    const note = `【大肥鱼找你】来自${place}${who}：${prefix(text, 300)}`;
    try {
      const ownerChat = this.config.targets.find(item => !item.group && item.number === owner) ?? new QQTarget({number: owner, name: '主人', group: false});
      const [action, params] = QQPolicy.sendAction(ownerChat, note);
      const response = await this.connection.action(action, params);
      // When the owner's private chat is managed, the note is part of that conversation too.
      const id = isDictionary(response.data) ? identifier(response.data.message_id) : undefined;
      if (this.config.targets.some(item => item.key === ownerChat.key) && id !== undefined) this.noteSent(ownerChat, id, note);
      this.ownerNotices.push(now);
      this.record(target.id, JobState.confirmed, '已私聊告诉主人：' + prefix(text, 60));
      return new ModelToolResult({content: '已经私聊告诉主人了。'});
    } catch (error) {
      return new ModelToolResult({content: '没发出去：' + describe(error)});
    }
  }

  /// "把这个表情存一下": an admin (or the bot's own account) has the picture in question kept in the
  /// sticker library. Anyone else is told to ask an admin, so a stranger cannot fill the library.
  async saveStickerFromChat(image, args, message, target) {
    if (!(message.isOwner || this.config.isAdmin(message.sender))) {
      return new ModelToolResult({content: '没存：只有管理员能往表情库里加图，请对方找管理员说一声。'});
    }
    const item = QQStickerLibrary.saveToolArguments(args);
    if (!item) return new ModelToolResult({content: '表情的名字或情绪没给全，没存。'});
    try {
      await this.importSticker({data: image, title: item.title, emotion: item.emotion, context: item.context,
        source: '', author: '群友投稿', license: '', publicSharing: false});
      this.record(target.id, JobState.confirmed, '表情已存进表情库：' + item.title);
      return new ModelToolResult({content: `已存进表情库：${item.title}（${item.emotion}）。以后合适的时候会用。`});
    } catch (error) {
      return new ModelToolResult({content: '没存成：' + describe(error)});
    }
  }

  /// Returns whether the ordinary configuration reached disk. Credentials can
  /// fail afterward; callers must keep their input and show the partial result.
  save({token = '', endpoint, expectedSelfID} = {}) {
    if (this.connected || this.busy || this.runtimeBusy) { this.error = '请先断开 QQ 并等待环境操作完成后修改配置'; return false; }
    const previous = this.config.clone();
    let configurationSaved = false;
    try {
      const value = trim(token);
      if (!(Buffer.byteLength(value) <= 8192 && !/\s/u.test(value))) throw new AppFailure('OneBot 令牌格式无效');
      if (endpoint !== undefined) this.config.endpoint = endpoint;
      if (expectedSelfID !== undefined) this.config.expectedSelfID = expectedSelfID;
      this.config.validate(); this.persist(); configurationSaved = true;
      this.status = 'QQ 地址与账号已保存，尚未连接';
      if (value) this.credentialWriter(value, 'qq-onebot-token');
      this.error = undefined;
    } catch (error) {
      if (!configurationSaved) this.config = previous;
      this.error = configurationSaved ? `地址与账号已保存，但 OneBot 令牌保存失败；输入已保留，请重试。${describe(error)}` : describe(error);
    }
    return configurationSaved;
  }
  /// Settings save while replies run and apply from the next step on; a chat that is switched off or
  /// removed drops its queued work at the next target check, so nothing has to pause first.
  saveReplySettings({ai, persona, onlineEnabled, visionEnabled, memoryEnabled, memoryOptions, enabledTargets, loopProtectionEnabled}) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成'; return; }
    const previous = this.config;
    try {
      const updated = this.config.clone(); updated.ai = ai.clone(); updated.persona = persona.clone();
      if (onlineEnabled !== undefined) updated.onlineEnabled = onlineEnabled;
      if (visionEnabled !== undefined) updated.visionEnabled = visionEnabled;
      if (memoryEnabled !== undefined) updated.memoryEnabled = memoryEnabled;
      if (memoryOptions !== undefined) updated.memoryOptions = memoryOptions;
      if (loopProtectionEnabled !== undefined) updated.loopProtectionEnabled = loopProtectionEnabled;
      if (enabledTargets !== undefined) {
        const keys = new Set(updated.targets.map(target => target.key));
        if (![...enabledTargets].every(key => keys.has(key))) throw new AppFailure('范围包含未知会话');
        for (const target of updated.targets) target.enabled = enabledTargets.has(target.key);
      }
      updated.validate(); this.config = updated; this.persist();
      this.error = undefined; this.status = this.running ? '设置已保存，继续回复' : '回复范围与设置已保存，回复仍暂停';
    } catch (error) { this.config = previous; this.error = describe(error); }
  }
  useTemporaryCredentials(token, key) {
    if (this.connected || this.busy || this.runtimeBusy) { this.error = '请先断开 QQ，再更换临时凭证'; return false; }
    token = trim(token); key = trim(key);
    if (!(token && key && Buffer.byteLength(token) <= 8192 && Buffer.byteLength(key) <= 8192)) {
      this.error = '请同时填写 OneBot 令牌和模型接口凭证'; return false;
    }
    this.runtimeCredentials = new QQRuntimeCredentials({oneBotToken: token, deepSeekKey: key});
    QQRepair.key = key; // the gateway key, for self-repair reports
    if (process.env.DAFEIYU_CODEX_URL !== undefined) this.imageCredentials.codexToken = key;
    this.error = undefined; this.status = '临时凭证已就绪，仅在本次应用运行期间使用';
    return true;
  }
  clearTemporaryCredentials() {
    this.disconnect('临时凭证已清除，QQ 已断开');
    this.runtimeCredentials = undefined;
    this.googleVisionKey = '';
    this.imageCredentials = new QQImageCredentials();
  }
  saveImageGeneration(settings, zhipuKey, cloudflareToken, persistCredentials) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成再配置生图'; return false; }
    const previous = this.config.clone();
    let configurationSaved = false;
    const completed = [];
    try {
      settings.validate();
      const zhipu = trim(zhipuKey), cloudflare = trim(cloudflareToken);
      if (![zhipu, cloudflare].every(value => Buffer.byteLength(value) <= 8192 && !/\s/u.test(value))) throw new AppFailure('生图凭证格式无效');
      this.config.imageGeneration = settings.clone(); this.persist(); configurationSaved = true;
      this.imageGenerationStatus = '生图配置已保存；默认 ' + QQImageProvider.title(settings.primary) +
        (settings.fallbackEnabled ? '，失败尝试 ' + QQImageProvider.title(QQImageProvider.alternate(settings.primary)) : '，不切换备用');
      if (zhipu) {
        if (persistCredentials) this.credentialWriter(zhipu, 'qq-image-zhipu');
        this.imageCredentials.zhipuKey = zhipu; completed.push('智谱');
      }
      if (cloudflare) {
        if (persistCredentials) this.credentialWriter(cloudflare, 'qq-image-cloudflare');
        this.imageCredentials.cloudflareToken = cloudflare; completed.push('Cloudflare');
      }
      this.error = undefined;
    } catch (error) {
      if (!configurationSaved) this.config = previous;
      const progress = completed.length ? '本次已保存并载入：' + completed.join('、') : '本次凭证均未保存';
      this.error = configurationSaved ? `生图配置已保存；${progress}，其余凭证未完成。输入已保留，可重试或取消钥匙串保存。${describe(error)}` : describe(error);
    }
    return configurationSaved;
  }
  saveVisualTools(settings, googleKey, persistCredentials) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成再配置识图'; return false; }
    const previous = this.config.clone();
    let configurationSaved = false;
    try {
      const key = trim(googleKey);
      if (!(Buffer.byteLength(key) <= 8192 && !/\s/u.test(key))) throw new AppFailure('Google 凭证格式无效');
      this.config.visualTools = settings.clone(); this.persist(); configurationSaved = true;
      this.visualStatus = '识图配置已保存：' + QQVisionProvider.title(settings.provider);
      if (persistCredentials && key) this.credentialWriter(key, 'qq-google-vision');
      if (key) this.googleVisionKey = key;
      this.error = undefined;
    } catch (error) {
      if (!configurationSaved) this.config = previous;
      this.error = configurationSaved ? `识图配置已保存，但 Google 凭证保存失败；输入已保留，可重试或取消钥匙串保存。${describe(error)}` : describe(error);
    }
    return configurationSaved;
  }
  async connect() {
    if (this.busy || this.runtimeBusy || this.connected || !this.storageOK) return;
    this.busy = true; this.error = undefined; const current = uuid(); this.session = current;
    try {
      if (!this.file) throw new AppFailure('QQ 状态目录不可用');
      const lock = acquireEngineLock(path.join(path.dirname(this.file), 'qq-engine.lock'));
      if (lock === 'failed') throw new AppFailure('无法创建 QQ 运行锁');
      if (lock === 'busy') throw new AppFailure('另一个 QQ 回复引擎正在运行，请先停止它');
      this.runtimeLock = lock;
      this.config.validate(); this.persist();
      const token = this.runtimeCredentials?.oneBotToken ?? Keychain.load('qq-onebot-token', this.allowAuthenticationUI);
      await this.connection.connect(this.config.endpoint, token);
      const response = await this.connection.action('get_login_info');
      if (this.session !== current) return;
      if (!(isDictionary(response.data) && identifier(response.data.user_id) === this.config.expectedSelfID)) {
        throw new AppFailure('实际登录 QQ 与配置不一致，已停止连接');
      }
      const health = await this.connection.action('get_status');
      if (this.session !== current) return;
      if (!(isDictionary(health.data) && health.data.online === true && health.data.good === true)) throw new AppFailure('QQ 未在线或服务状态异常');
      await this.loadContacts();
      if (this.session !== current) return;
      this.connected = true; this.lastHeartbeat = new Date(); this.status = 'QQ 已连接并核对账号，自动回复未启动';
      const watchdog = new AbortController();
      this.watchdog = watchdog;
      task(async () => {
        let ticks = 0;
        while (!watchdog.signal.aborted) {
          try { await sleep(10_000, watchdog.signal); } catch { return; }
          if (this.session !== current) return;
          if ((Date.now() - this.lastHeartbeat.getTime()) / 1000 > 75) { this.disconnect('QQ 心跳超时，已停止托管'); return; }
          if (this.runtimeLock) touchEngineLock(this.runtimeLock);
          // Every ten minutes: pick up renamed groups, and groups left or friends removed meanwhile.
          ticks += 1;
          if (ticks % 60 === 0) { try { await this.loadContacts(); } catch {} }
          this.scheduleArtworks();
          this.scheduleMemoryLearning();
          this.scheduleOutreach();
          this.scheduleReminders();
        }
      });
    } catch (error) {
      if (this.session !== current) return;
      this.error = describe(error); this.disconnect('QQ 连接检查失败');
    } finally {
      if (this.session === current) this.busy = false;
    }
  }
  start({singleReply = false, duration} = {}) {
    if (!this.connected || this.busy || this.running || !this.storageOK) return;
    try {
      this.config.validate();
      if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 3 * 86400)) {
        throw new AppFailure('运行时长应大于 0 且不超过 72 小时');
      }
      const key = this.runtimeCredentials?.deepSeekKey ?? Keychain.load('api-key', this.allowAuthenticationUI);
      if (!key) throw new AppFailure('缺少本机模型网关凭证，重启机器人服务后再试');
      if (this.config.effectiveImageGeneration.enabled || (this.config.effectiveVisionEnabled && this.config.effectiveVisualTools.provider === QQVisionProvider.zhipu)) {
        // Missing/inaccessible optional image keys must not take down ordinary QQ replies.
        if (!this.imageCredentials.zhipuKey) this.imageCredentials.zhipuKey = Keychain.load('qq-image-zhipu', false);
        if (this.config.effectiveImageGeneration.enabled && !this.imageCredentials.cloudflareToken) this.imageCredentials.cloudflareToken = Keychain.load('qq-image-cloudflare', false);
      }
      if (this.config.effectiveVisualTools.googleWebEnabled && !this.googleVisionKey) {
        this.googleVisionKey = Keychain.load('qq-google-vision', false);
      }
      // A chat that is no longer in the QQ friend or group list (left the group, unfriended) cannot be
      // reached anyway; it is skipped and named, instead of keeping every other chat from starting.
      const enabled = this.config.targets.filter(target => target.enabled);
      const reachable = enabled.filter(target => this.contacts.some(contact => contact.id === target.key));
      if (!reachable.length) throw new AppFailure('请启用至少一个已通过联系人列表核对的 QQ 号或群号');
      for (const target of enabled) {
        if (!reachable.some(item => item.id === target.id)) this.record(target.id, JobState.skipped, '不在 QQ 好友或群列表里（可能已退群或不是好友），这个会话暂时收不到也回不了');
      }
      this.persist(); this.singleReply = singleReply;
      this.fence.start(); this.running = true; this.started = nowSeconds();
      if (duration !== undefined) {
        const epoch = this.fence.epoch;
        this.runDeadline = addSeconds(new Date(), duration);
        const deadline = new AbortController();
        this.deadlineTask = deadline;
        task(async () => {
          try { await sleep(duration * 1000, deadline.signal); } catch { return; }
          if (!this.fence.permits(epoch)) return;
          this.pause(); this.status = '已达到运行时限，QQ 自动回复已暂停';
        });
      }
      this.scheduleMemoryLearning();
      this.status = 'QQ 自动回复中'; this.error = undefined;
    } catch (error) { this.error = describe(error); }
  }
  pause() {
    this.deadlineTask?.abort(); this.deadlineTask = undefined; this.runDeadline = undefined;
    this.fence.stop(); this.running = false; this.queue = []; for (const worker of this.workers.values()) worker.abort(); this.workers.clear();
    this.memoryWorker?.abort(); this.memoryWorker = undefined;
    // Pausing stops work in progress, not the conversation: recent turns and group timelines stay,
    // so pausing (or switching models, which used to pause) does not make the bot forget what was said.
    this.status = this.connected ? 'QQ 已连接，自动回复已暂停' : 'QQ 已暂停';
    this.heldOwnerEvents.clear();
  }
  disconnect(reason = 'QQ 已断开') {
    this.pause(); this.session = undefined; this.busy = false; this.connected = false; this.contacts = [];
    this.watchdog?.abort(); this.watchdog = undefined; this.connection.close(); this.status = reason;
    // Release ownership even if a spawned process still holds a descriptor copy.
    if (this.runtimeLock) { releaseEngineLock(this.runtimeLock); this.runtimeLock = undefined; }
  }
  takeOver(id) {
    // Cancel the active generation as well, preventing a response from escaping a removed scope.
    this.pause(); for (const target of this.config.targets) if (target.id === id) target.enabled = false;
    try { this.persist(); } catch (error) { this.error = describe(error); }
  }
  add(contact) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成'; return; }
    if (this.config.targets.some(target => target.key === contact.id)) { this.error = '该会话已在名单中'; return; }
    if (this.config.targets.length >= 20) { this.error = '最多托管 20 个会话'; return; }
    const previous = this.config.targets.slice();
    this.config.targets.push(new QQTarget({number: contact.number, name: contact.name, group: contact.group}));
    try { this.persist(); this.error = undefined; }
    catch (error) { this.config.targets = previous; this.error = describe(error); }
  }
  remove(id) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成'; return; }
    const previous = this.config.targets.slice();
    this.config.targets = this.config.targets.filter(target => target.id !== id);
    try { this.persist(); this.error = undefined; }
    catch (error) { this.config.targets = previous; this.error = describe(error); }
  }
  receive(object) {
    const selfID = this.config.expectedSelfID;
    if (object.post_type === 'meta_event') {
      if (identifier(object.self_id) !== selfID) { this.disconnect('QQ 账号发生变化，已停止'); return; }
      if (object.meta_event_type === 'heartbeat') {
        const s = object.status;
        if (!(isDictionary(s) && s.online === true && s.good === true)) { this.disconnect('QQ 离线或服务异常，已停止'); return; }
        this.lastHeartbeat = new Date();
      }
      return;
    }
    // QQ forced the account offline (风控、身份失效、别处登录). Heartbeats keep coming after that, so
    // without this the engine looked connected for minutes while nothing could be sent or received.
    if (object.post_type === 'notice' && object.notice_type === 'bot_offline') {
      this.kickedOffline(identifier(object.message) ?? identifier(object.tag) ?? ''); return;
    }
    // Any real event after a kick means a fresh login (the owner scanned again): the warning can go.
    if (this.kickedAt !== undefined && identifier(object.self_id) === selfID) {
      this.kickedAt = undefined;
      if (this.error?.startsWith('QQ 被踢下线了')) this.error = undefined;
      this.record(undefined, JobState.confirmed, 'QQ 重新登录后又收到消息了，恢复正常');
    }
    // Mutes are tracked while paused too, so resuming does not talk into a group that muted the bot.
    if (object.post_type === 'notice' && object.notice_type === 'group_ban' && identifier(object.self_id) === selfID) this.noteGroupBan(object);
    // Invitations and the bot's own joins are handled while paused too.
    if (identifier(object.self_id) === selfID) {
      if (object.post_type === 'request') { this.receiveInvitation(object); return; }
      if (object.post_type === 'notice' && object.notice_type === 'group_increase' && identifier(object.user_id) === selfID) this.joinedGroup(object);
    }
    if (!this.running) return;
    const account = identifier(object.self_id);
    if (account !== undefined && account !== selfID) { this.disconnect('QQ 事件账号不一致，已停止'); return; }
    const now = nowSeconds();
    if (object.post_type === 'notice') { this.noteGroupNotice(object, now); this.noteMessageReaction(object); this.receivePoke(object, now); return; }
    if (!['message', 'message_sent'].includes(typeof object.post_type === 'string' ? object.post_type : '') || identifier(object.self_id) !== selfID) return;
    const target = this.config.targets.find(item => item.enabled && object.message_type === (item.group ? 'group' : 'private') &&
      identifier(object[item.group ? 'group_id' : 'user_id']) === item.number);
    if (!target) return;
    const message = QQPolicy.incoming(object, selfID, this.started, now, target.group, target.group);
    if (!message) { this.rejectedScopedEvents += 1; return; }
    if (!(target.key === message.key && this.seen[message.dedupKey] === undefined)) return;
    // A blocked sender gets nothing: no reply, no command, no memory, no group-context weight.
    if (!message.isOwner && this.config.isBlocked(message.sender)) { this.seen[message.dedupKey] = now; this.decide(message, target, '不回：在黑名单里'); return; }
    if (message.isOwner) {
      if (this.botMessageIDs[selfID + ':' + message.key + ':' + message.id] !== undefined) return;
      // Self events may precede send acknowledgements. Resolve the bot ID before classifying manual input.
      if ([...this.activeGroupSubmissions.values()].includes(message.key)) {
        if (this.heldOwnerEvents.size >= QQEngine.queueCapacity) return;
        this.heldOwnerEvents.set(message.dedupKey, object); return;
      }
    }
    this.seen[message.dedupKey] = now;
    if (!message.group && !message.isOwner) this.outreachLedger.incoming(message.key, now);
    try { this.persist(); } catch (error) { this.error = describe(error); return; }
    if (!this.config.ai.inWorkHours()) { this.record(target.id, JobState.skipped, '时段外，不计数或补发'); return; }
    if (this.config.effectiveMemoryEnabled) {
      const scope = selfID + ':' + message.key;
      const subject = QQMemoryBook.subject(selfID, message.key, message.sender);
      this.memoryBooks[scope] ??= new QQMemoryBook();
      this.memoryBooks[scope].append(new QQMemoryEvent({id: message.id, subject, text: message.text, at: new Date(message.time * 1000)}));
      try { this.persist(); } catch { return; }
      this.scheduleMemoryLearning();
    }
    if (message.group) {
      // Short-term conversation works even when long-term learning is off.
      this.recentLines(message.key);
      const lines = this.groupRecentMessages.get(message.key);
      if (!lines.some(event => event.id === message.id)) {
        const subject = QQMemoryBook.subject(selfID, message.key, message.sender);
        lines.push(new QQMemoryEvent({id: message.id, subject, text: message.text, at: new Date(message.time * 1000)}));
      }
      this.groupRecentMessages.set(message.key, lines.slice(-60));
      this.keepInput(message);
      this.scheduleTimelineSummary(target);
    }
    // Muted in this group: the timeline and memory above keep up, nothing is generated or sent.
    if (message.group && this.muted(message.key)) { this.decide(message, target, '不回：机器人在这个群被禁言'); return; }
    // No counters, no keyword lanes: every batch of member messages goes to the agent, which decides for itself
    // whether and how to take part.
    if (message.isOwner) return;
    if (!message.group) {
      // Private chats keep a short buffer of their own; the turn also reads QQ's history for the owner's lines.
      this.recentLines(message.key);
      const lines = this.groupRecentMessages.get(message.key);
      if (!lines.some(event => event.id === message.id)) {
        lines.push(new QQMemoryEvent({id: message.id, subject: 'PEER', text: message.text, at: new Date(message.time * 1000)}));
        this.groupRecentMessages.set(message.key, lines.slice(-60));
      }
      this.keepInput(message);
    }
    if (this.config.effectiveLoopProtectionEnabled && this.conversationFlow.shouldSilence(message.key, message.sender, message.text, now)) {
      this.decide(message, target, '不回：像是复读或机器人互聊，临时停接这个人'); return;
    }
    // Its group card counts as its name too (11-03: members called it by its card and it did not know).
    const card = message.group ? this.selfCards.get(message.key)?.name : undefined;
    const calling = !message.group || message.mentionsSelf ||
      (message.replyTo !== undefined && this.botMessageIDs[selfID + ':' + message.key + ':' + message.replyTo] !== undefined) ||
      ['大肥鱼', '肥鱼', this.config.effectivePersona.customName ?? '', count(card ?? '') >= 2 ? card : ''].some(name => name && message.text.includes(name));
    if (message.group && this.config.effectiveQuietHours.quiet(new Date()) && !calling) { this.decide(message, target, '不回：夜间安静时段，没人叫它'); return; }
    if (QQAgentLevel.answersOnlyWhenCalled(this.config.agentLevel(message.key)) && !calling) { this.decide(message, target, '不回：代理是基础权限，只在叫到它时看'); return; }
    this.decide(message, target, '交给代理：攒完这一批一起看');
    this.noteForAgent(message, target, calling);
  }
  /** The chat's short-term lines, filled from memory (after the last /new) the first time they are needed. */
  recentLines(key) {
    if (!this.groupRecentMessages.has(key)) {
      const since = this.contextResetAt[key] ?? 0;
      this.groupRecentMessages.set(key, this.config.effectiveMemoryEnabled
        ? (this.memoryBooks[this.config.expectedSelfID + ':' + key]?.recent ?? []).filter(event => event.at.getTime() / 1000 >= since) : []);
    }
    return this.groupRecentMessages.get(key);
  }
  keepInput(message) {
    const inputs = this.groupRecentInputs.get(message.key) ?? {};
    inputs[message.id] = message;
    const retained = new Set((this.groupRecentMessages.get(message.key) ?? []).map(event => event.id));
    this.groupRecentInputs.set(message.key, Object.fromEntries(Object.entries(inputs).filter(([id]) => retained.has(id))));
  }
  saveQuietHours(settings) {
    const updated = this.config.clone();
    updated.quietHours = settings.clone();
    updated.validate();
    const previous = this.config;
    this.config = updated;
    try { this.persist(); } catch (error) { this.config = previous; throw error; }
  }
  startQueue() {
    const limit = this.singleReply ? 1 : 8;
    for (const scope of this.queue.map(item => this.workScope(item))) {
      if (!(this.workers.size < limit && !this.workers.has(scope))) continue;
      const epoch = this.fence.epoch;
      const worker = new AbortController();
      this.workers.set(scope, worker);
      task(() => this.drain(epoch, scope));
    }
  }
  workScope(item) {
    switch (item.case) {
      case 'artwork': return item.target.key;
      case 'agent': return item.target.key;
    }
  }
  async drain(epoch, scope) {
    // The worker's cancellation (pause cancels the Swift task tree; here an AbortSignal stands for it).
    const signal = this.workers.get(scope)?.signal;
    try {
      let next;
      while (this.fence.permits(epoch) && (next = this.queue.findIndex(item => this.workScope(item) === scope)) >= 0) {
        const [item] = this.queue.splice(next, 1);
        switch (item.case) {
          case 'artwork': await this.deliverArtwork(item.request, item.target, item.due, epoch, signal); break;
          case 'agent': await this.deliverAgentTurn(item.target, epoch, signal); break;
        }
      }
    } finally {
      if (this.fence.permits(epoch)) { this.workers.delete(scope); this.startQueue(); this.scheduleMemoryLearning(); }
    }
  }
  /// Someone talked to the bot and the model failed (rate limit, timeout, outage): one short line instead
  /// of silence, at most once every ten minutes per chat, written by the program without a model call.
  async sayStuck(error, target, epoch, signal) {
    // Only the model service failing; our own daily limits running out is a quiet stop, not a hiccup.
    const modelFailure = error instanceof HTTPFailure || error instanceof URLError;
    const now = nowSeconds();
    if (!(modelFailure && this.fence.permits(epoch) && this.connected && !this.muted(target.key) && now - (this.stuckNoticeAt.get(target.key) ?? 0) >= 600)) return;
    this.stuckNoticeAt.set(target.key, now);
    const text = error instanceof HTTPFailure && error.code === 429 ? '模型那边在限流，过会儿再叫我' : '脑子卡了一下没想出来，等会儿再问我一次';
    let ticket;
    try { ticket = await this.reserveSend(epoch, target, signal); } catch { return; }
    const submissionID = uuid();
    try {
      const [action, params] = QQPolicy.sendAction(target, text);
      if (target.group) this.activeGroupSubmissions.set(submissionID, target.key);
      const response = await this.connection.action(action, params);
      const id = isDictionary(response.data) ? identifier(response.data.message_id) : undefined;
      if (id !== undefined) this.noteSent(target, id, text);
      this.sends.finish(ticket, true);
      this.record(target.id, JobState.confirmed, '模型没回上来，已告诉对方稍后再试');
    } catch (failure) { this.sendFailed(failure, ticket, target, '卡住提示'); }
    finally { this.activeGroupSubmissions.delete(submissionID); if (this.fence.permits(epoch)) this.releaseHeldOwnerEvents(target.key); }
  }
  saveArtwork(settings) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成再保存插画配置'; return; }
    const previous = this.config.effectiveArtwork.clone();
    try {
      settings.validate();
      if (!settings.scheduleTargets.every(key => this.config.targets.some(target => target.key === key))) throw new AppFailure('定时目标必须来自现有会话列表');
      this.config.effectiveArtwork = settings.clone(); this.persist(); this.error = undefined; this.artworkStatus = '插画设置已保存，定时任务仅在机器人运行时生效';
    } catch (error) { this.config.effectiveArtwork = previous; this.error = describe(error); }
  }
  async addArtworkArtist(input) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成，再添加画师'; return; }
    this.busy = true; this.error = undefined;
    const current = this.session;
    const previous = this.config.effectiveArtwork.clone();
    const same = () => JSON.stringify(this.config.effectiveArtwork) === JSON.stringify(previous);
    let applied = false;
    try {
      const id = QQArtworkConfig.artistID(input);
      if (previous.pixivArtistIDs.includes(id)) throw new AppFailure('该画师已在列表中，无需重复添加');
      if (previous.pixivArtistIDs.length >= 20) throw new AppFailure('最多添加 20 位画师，请先移除不需要的画师');
      const name = await this.artworkLibrary.lookupArtist(id, () => {
        if (!(this.session === current && !this.running && same())) throw new CancellationError();
        this.artworkLedger.reserveNetwork(previous.networkDailyLimit); this.persist();
      });
      if (!(this.session === current && !this.running && same())) throw new AppFailure('运行状态或配置已变化，请暂停后重试');
      const updated = this.config.effectiveArtwork.clone();
      updated.pixivArtistIDs.push(id);
      const names = {...(updated.artistNames ?? {})}; names[id] = prefix(name, 80); updated.artistNames = names;
      updated.validate(); this.config.effectiveArtwork = updated; applied = true; this.persist();
      this.artworkStatus = `已添加 ${name}（${id}），已加入历史精选来源；不限制关键词搜图与日榜`;
    } catch (error) { if (applied) this.config.effectiveArtwork = previous; if (this.session === current) this.error = describe(error); }
    finally { if (this.session === current) this.busy = false; }
  }
  // The watchdog calls this every 10 seconds. Tests can supply a deterministic clock.
  scheduleArtworks(now = new Date()) {
    if (!this.running || !this.config.ai.inWorkHours()) return;
    const due = this.config.effectiveArtwork.dueDate(now, new Date(this.started * 1000));
    if (!due || !(this.runDeadline === undefined || now < this.runDeadline)) return;
    const settings = this.config.effectiveArtwork;
    this.artworkLedger.trim(now);
    for (const target of this.config.targets) {
      if (!(target.enabled && settings.scheduleTargets.includes(target.key))) continue;
      const key = settings.scheduleKey(this.config.expectedSelfID, target.key, due);
      if (!(this.artworkLedger.schedules[key] === undefined && this.queue.length < QQEngine.queueCapacity)) continue;
      // At-most-once admission survives restart; cancelled jobs aren't replayed later.
      this.artworkLedger.schedules[key] = due;
      try { this.persist(); } catch (error) { this.error = describe(error); return; }
      this.queue.push({case: 'artwork', request: new QQArtworkRequest({mode: settings.scheduleMode}), target, due});
    }
    if (this.queue.length) this.startQueue();
  }
  // Panel writes require a stopped worker; chat commands enter the same FIFO as replies.
  setPersonaStyle(value, key) {
    if (this.busy || this.runtimeBusy) { this.error = '请等待当前操作完成'; return; }
    const target = this.config.targets.find(item => item.key === key);
    if (!target || !(value === 'default' || QQPersonality.from(value) !== undefined)) { this.error = '会话或性格无效'; return; }
    try {
      this.persistPersonaStyle(QQPersonality.from(value), target);
      this.error = undefined; this.status = '本会话性格已保存：' + QQPersonality.name(this.config.personaFor(key).effectiveStyle);
    } catch (error) { this.error = describe(error); }
  }
  persistPersonaStyle(style, target) {
    const item = this.config.targets.find(entry => entry.id === target.id && entry.key === target.key);
    if (!item) throw new AppFailure('会话已变更');
    const previous = item.personaStyle;
    item.personaStyle = style;
    try { this.config.validate(); this.persist(); }
    catch (error) { item.personaStyle = previous; throw error; }
  }
  /// Short-term context only; long-term memory survives unless `clearMemory` is set.
  resetContext(target, clearMemory) {
    this.groupRecentMessages.set(target.key, []); this.groupRecentInputs.set(target.key, {});
    delete this.timelineSummaries[target.key];
    this.conversationFlow.reset(target.key);
    this.contextResetAt[target.key] = nowSeconds();
    if (clearMemory) {
      const scope = this.config.expectedSelfID + ':' + target.key;
      delete this.memoryBooks[scope]; this.memoryIndexes.delete(scope); this.memoryRetryAfter.delete(scope);
    }
  }
  /// What a chat command does, and the answer to it; shared by slash commands and the agent's manage_chat.
  /// Returns {text, detail}.
  performAdminCommand(command, target, sender, isOwner) {
    const admin = isOwner || this.config.isAdmin(sender);
    let detail = '命令已执行';
    let text;
    if (QQAdminCommand.requiresAdmin(command, target.group) && !admin) {
      text = '这个命令只有管理员能用。'; detail = '非管理员命令已拒绝';
    } else {
      switch (command.case) {
        case 'help': text = QQAdminCommand.help(admin, target.group); break;
        case 'newTopic':
          this.resetContext(target, false); text = '好，翻篇了，刚才聊的我不接着带了。'; break;
        case 'clear':
          this.resetContext(target, true); text = '清好了，这个会话的上下文和长期记忆都已清空。'; break;
        case 'block': {
          const number = command._0;
          if (number === this.config.expectedSelfID || this.config.isAdmin(number)) text = '管理员和机器人自己不能拉黑。';
          else if (this.config.isBlocked(number)) text = `${number} 已经在黑名单里了。`;
          else { this.saveModeration(this.config.effectiveAdminIDs, [...this.config.effectiveBlockedIDs, number]); text = `已拉黑 ${number}，之后不会再回复 TA。`; }
          break;
        }
        case 'unblock': {
          const number = command._0;
          if (!this.config.isBlocked(number)) text = `${number} 不在黑名单里。`;
          else { this.saveModeration(this.config.effectiveAdminIDs, this.config.effectiveBlockedIDs.filter(item => item !== number)); text = `已把 ${number} 移出黑名单。`; }
          break;
        }
        case 'blocklist': {
          const list = this.config.effectiveBlockedIDs;
          text = !list.length ? '黑名单是空的。' : `黑名单（${list.length}）：\n` + list.slice(0, 50).join('\n') + (list.length > 50 ? '\n……' : '');
          break;
        }
        case 'memories': {
          // Only what this conversation taught it about the sender; other chats stay out of it.
          const subject = QQMemoryBook.subject(this.config.expectedSelfID, target.key, sender);
          const items = this.memoryBooks[this.config.expectedSelfID + ':' + target.key]?.remembered(subject) ?? [];
          text = !items.length ? '在这儿还没记下关于你的事。' :
            `我在这儿记得你这些（${items.length} 条）：\n` + items.slice(0, 15).map(item => `· ${item.text}（${formatDate(item.updatedAt, 'M月d日', 'Asia/Shanghai')}）`).join('\n') +
            (items.length > 15 ? '\n……' : '') + '\n记错了就用 /忘记 关键词 删掉。';
          break;
        }
        case 'forget': {
          const keyword = command._0;
          const subject = QQMemoryBook.subject(this.config.expectedSelfID, target.key, sender);
          const scope = this.config.expectedSelfID + ':' + target.key;
          const forgotten = this.memoryBooks[scope]?.forget(subject, keyword) ?? [];
          if (forgotten.length) this.memoryIndexes.delete(scope);
          text = !forgotten.length ? `没找到关于你、带“${keyword}”的记忆。` : `忘掉了 ${forgotten.length} 条：\n` + forgotten.slice(0, 5).map(item => '· ' + item).join('\n');
          break;
        }
        case 'invalid': text = command._0; detail = '命令格式不正确'; break;
      }
    }
    return {text, detail};
  }
  /// How a conversation is named in usage statistics.
  chatLabel(target) { return (target.group ? '群·' : '好友·') + target.name; }

  // MARK: Contacts and managed chats

  /// The QQ friend and group lists, then the managed chats brought in line with them.
  async loadContacts() {
    const friends = await this.connection.action('get_friend_list');
    const groups = await this.connection.action('get_group_list');
    const rows = value => Array.isArray(value) && value.every(isDictionary) ? value : [];
    const friendRows = rows(friends.data), groupRows = rows(groups.data);
    const text = value => { const trimmed = typeof value === 'string' ? trim(value) : ''; return trimmed || undefined; };
    const people = friendRows.flatMap(item => {
      const number = identifier(item.user_id);
      return number === undefined ? [] : [new QQContact({number, name: text(item.remark) ?? text(item.nickname) ?? number, group: false})];
    });
    const rooms = groupRows.flatMap(item => {
      const number = identifier(item.group_id);
      return number === undefined ? [] : [new QQContact({number, name: text(item.group_name) ?? number, group: true})];
    });
    this.contacts = [...people, ...rooms];
    this.reconcileTargets(friendRows.length > 0, groupRows.length > 0);
  }

  /// Managed chats follow QQ: a group the bot has left or a friend who removed it is taken off the list
  /// and remembered in `removedTargets`; a renamed group or friend gets its new name. A list that came back
  /// empty, or that would drop more than half of the chats of its kind at once, is treated as a glitch.
  reconcileTargets(friendsLoaded, groupsLoaded) {
    const updated = this.config.clone(), renamed = [], removed = [];
    for (const group of [false, true]) {
      if (!(group ? groupsLoaded : friendsLoaded)) continue;
      const kind = updated.targets.filter(target => target.group === group);
      // A group joined a moment ago may not be in QQ's group list yet.
      const gone = kind.filter(target => !this.contacts.some(contact => contact.id === target.key) &&
        (this.adoptedAt.has(target.key) ? (Date.now() - this.adoptedAt.get(target.key).getTime()) / 1000 > 900 : true));
      if (!(gone.length * 2 <= kind.length || kind.length <= 2)) continue;
      for (const target of gone) {
        removed.push(new QQRemovedTarget({number: target.number, name: target.name, group, removedAt: new Date(),
          reason: group ? '机器人已不在这个群里（退群或被移出）' : '已不是 QQ 好友'}));
      }
      updated.targets = updated.targets.filter(target => !gone.some(item => item.id === target.id));
    }
    for (const target of updated.targets) {
      const contact = this.contacts.find(item => item.id === target.key);
      if (!contact || contact.name === target.name || contact.name === target.number) continue;
      renamed.push(`${target.name === '' ? target.number : target.name} → ${contact.name}`);
      target.name = contact.name;
    }
    if (!removed.length && !renamed.length) return;
    const keys = new Set(updated.targets.map(target => target.key));
    updated.effectiveArtwork.scheduleTargets = updated.effectiveArtwork.scheduleTargets.filter(key => keys.has(key));
    const previous = this.config;
    this.config = updated;
    this.removedTargets = [...this.removedTargets, ...removed].slice(-100);
    try { this.persist(); } catch (error) { this.config = previous; this.error = describe(error); return; }
    for (const item of removed) this.record(undefined, JobState.skipped, `已从会话名单移除${item.group ? '群' : '好友'}「${item.name === '' ? item.number : item.name}」：${item.reason}`);
    if (renamed.length) this.record(undefined, JobState.skipped, '会话改名已同步：' + renamed.slice(0, 5).join('，'));
  }

  /// When each taught catchphrase was last answered, per group.

  // MARK: Group invitations

  /// A group invitation is accepted only when an admin sent it; anyone else's is left for the owner to decide in QQ.
  receiveInvitation(object) {
    if (!(object.request_type === 'group' && object.sub_type === 'invite')) return;
    const group = identifier(object.group_id), inviter = identifier(object.user_id), flag = identifier(object.flag);
    if (group === undefined || inviter === undefined || flag === undefined) return;
    if (!this.config.isAdmin(inviter)) {
      this.record(undefined, JobState.skipped, `收到 ${inviter} 邀请进群 ${group}：不是管理员，没有自动接受`); return;
    }
    this.adminInvitedGroups.add(group);
    task(async () => {
      try {
        await this.connection.action('set_group_add_request', {flag, sub_type: 'invite', approve: true});
        await this.adoptGroup(group, inviter);
      } catch (error) {
        this.adminInvitedGroups.delete(group);
        this.record(undefined, JobState.failed, `接受管理员 ${inviter} 的进群邀请（群 ${group}）失败：` + describe(error));
      }
    });
  }

  /// The bot itself joined a group. QQ lets members pull a friend straight into a small group without an
  /// invitation, so the join notice is checked too: only a group an admin brought the bot into is managed.
  joinedGroup(object) {
    const group = identifier(object.group_id);
    if (group === undefined || this.config.targets.some(target => target.group && target.number === group)) return;
    const operatorID = identifier(object.operator_id) ?? '';
    if (this.adminInvitedGroups.has(group) || this.config.isAdmin(operatorID)) {
      const inviter = this.adminInvitedGroups.has(group) ? undefined : operatorID;
      task(() => this.adoptGroup(group, inviter));
      return;
    }
    // Someone else pulled it in, often the group owner at an admin's request (members can only ask the
    // owner to). An admin who is in that group counts as having asked for it; anywhere else it stays off.
    const admins = this.config.effectiveAdminIDs.filter(id => id !== this.config.expectedSelfID);
    task(async () => {
      for (const admin of admins) {
        let member;
        try { member = await this.connection.action('get_group_member_info', {group_id: group, user_id: admin, no_cache: true}); } catch {}
        if (member && identifier(isDictionary(member.data) ? member.data.user_id : undefined) === admin) {
          await this.adoptGroup(group, undefined, admin); return;
        }
      }
      // Still listed among the contacts, so the owner can add it by hand without restarting.
      let info;
      try { info = await this.connection.action('get_group_info', {group_id: group}); } catch {}
      const name = typeof info?.data?.group_name === 'string' ? trim(info.data.group_name) : '';
      if (!this.contacts.some(contact => contact.id === 'group:' + group)) this.contacts.push(new QQContact({number: group, name: name || group, group: true}));
      this.record(undefined, JobState.skipped, `机器人进了群 ${group}（拉它的人：${operatorID === '' || operatorID === '0' ? 'QQ 没给出' : operatorID}）：不是管理员邀请，管理员也不在这个群，没有加入会话名单；要用的话在会话设置里手动加`);
    });
  }

  /// Adds a group the bot joined at an admin's invitation to the managed list, enabled, under its QQ name.
  async adoptGroup(group, inviter, present) {
    const key = 'group:' + group;
    if (this.config.targets.some(target => target.key === key)) { this.adminInvitedGroups.delete(group); return; }
    if (this.config.targets.length >= 20) {
      this.record(undefined, JobState.failed, `管理员邀请进了群 ${group}，但会话名单已满 20 个，没有加入`); return;
    }
    let info;
    try { info = await this.connection.action('get_group_info', {group_id: group}); } catch {}
    const name = typeof info?.data?.group_name === 'string' ? trim(info.data.group_name) : '';
    if (this.config.targets.some(target => target.key === key)) return;
    const target = new QQTarget({number: group, name: name || group, group: true});
    target.enabled = true;
    const previous = this.config.targets.slice();
    this.config.targets.push(target);
    try { this.persist(); } catch (error) { this.config.targets = previous; this.record(undefined, JobState.failed, '加入会话名单失败：' + describe(error)); return; }
    this.adminInvitedGroups.delete(group);
    this.adoptedAt.set(key, new Date());
    if (!this.contacts.some(contact => contact.id === key)) this.contacts.push(new QQContact({number: group, name: target.name, group: true}));
    this.removedTargets = this.removedTargets.filter(item => !(item.group && item.number === group));
    this.record(target.id, JobState.skipped, present !== undefined ? `进了群「${target.name}」，管理员 ${present} 也在这个群，加入会话名单并开始回复`
      : `已按管理员${inviter !== undefined ? ` ${inviter} ` : ''}的邀请进群「${target.name}」，加入会话名单并开始回复`);
  }

  // MARK: Group notices in the timeline

  /// 精华, 撤回, 禁言, 管理员 and 进群退群 notices become timeline lines, so the model sees who did what
  /// instead of guessing it from the surrounding messages. A recalled message also leaves the timeline.
  noteGroupNotice(object, now) {
    const group = identifier(object.group_id);
    const target = group === undefined ? undefined : this.config.targets.find(item => item.enabled && item.group && item.number === group);
    if (!target) return;
    const key = target.key, inputs = this.groupRecentInputs.get(key) ?? {};
    // An uploaded group file is remembered by its id, so read_file and send_file can open it by name and size.
    if (object.notice_type === 'group_upload') this.rememberGroupFile(key, object.file);
    const line = QQGroupNotice.describe(object, this.config.expectedSelfID, key,
      id => Object.values(inputs).filter(message => message.sender === id).reduce((best, message) => !best || message.time > best.time ? message : best, undefined)?.name,
      id => inputs[id]?.text ?? this.groupRecentMessages.get(key)?.findLast(event => event.id === id)?.text);
    if (line === undefined) return;
    this.recentLines(key);
    if (object.notice_type === 'group_recall') {
      const id = identifier(object.message_id);
      if (id !== undefined) {
        if (this.groupRecentMessages.has(key)) this.groupRecentMessages.set(key, this.groupRecentMessages.get(key).filter(event => event.id !== id));
        if (this.groupRecentInputs.has(key)) delete this.groupRecentInputs.get(key)[id];
      }
    }
    const lines = this.groupRecentMessages.get(key) ?? [];
    lines.push(new QQMemoryEvent({id: 'notice-' + uuid(), subject: 'SYSTEM', text: line, at: new Date(now * 1000)}));
    this.groupRecentMessages.set(key, lines.slice(-60));
  }

  // MARK: Muted in a group (禁言)

  muted(key) {
    const until = this.mutedUntil.get(key);
    if (until === undefined) return false;
    if (until > nowSeconds()) return true;
    this.mutedUntil.delete(key); return false;
  }
  static span(seconds) {
    return seconds >= 86400 ? `${Math.round(seconds / 86400)} 天` : seconds >= 3600 ? `${Math.round(seconds / 3600)} 小时` : `${Math.max(1, Math.round(seconds / 60))} 分钟`;
  }
  /// group_ban notices for the bot itself, or for the whole group (user_id 0).
  noteGroupBan(object) {
    const group = identifier(object.group_id);
    const target = group === undefined ? undefined : this.config.targets.find(item => item.group && item.number === group);
    if (!target) return;
    const user = identifier(object.user_id) ?? '';
    if (!(user === this.config.expectedSelfID || user === '0')) return;
    if (object.sub_type === 'lift_ban') {
      if (!this.mutedUntil.delete(target.key)) return;
      this.record(target.id, JobState.skipped, user === '0' ? '全员禁言解除了，恢复在这个群说话' : '禁言解除了，恢复在这个群说话');
    } else {
      const duration = doubleValue(object.duration) ?? 0;
      const now = nowSeconds();
      this.mutedUntil.set(target.key, duration > 0 ? now + duration : now + 30 * 86400);
      this.record(target.id, JobState.skipped, (user === '0' ? '群里开了全员禁言' : duration > 0 ? '被禁言 ' + QQEngine.span(duration) : '被禁言') + '，这段时间不在这个群说话，其他会话照常');
    }
  }
  /// After QQ refuses a group message, ask whether the bot is muted there (the notice may have been missed).
  async checkMuted(target) {
    if (!target.group) return;
    let response;
    try { response = await this.connection.action('get_group_member_info', {group_id: target.number, user_id: this.config.expectedSelfID, no_cache: true}); } catch { return; }
    const until = isDictionary(response?.data) ? doubleValue(response.data.shut_up_timestamp) : undefined;
    if (until === undefined || !(until > nowSeconds())) return;
    this.mutedUntil.set(target.key, until);
    this.record(target.id, JobState.skipped, '在这个群被禁言了，还剩约 ' + QQEngine.span(until - nowSeconds()) + '，期间不说话，其他会话照常');
  }
  /// A send that did not go through. A refusal from QQ is an ordinary failure; a lost acknowledgement is
  /// not resent because the message may have arrived. Neither stops the bot: one muted group must not
  /// silence every other chat.
  sendFailed(error, ticket, target, what) {
    if (error instanceof OneBotRejection) {
      this.sends.refused(ticket);
      this.record(target.id, JobState.failed, what + '没发出去：' + describe(error));
      if (target.group) task(() => this.checkMuted(target));
      // QQ's own send pipeline failing (not a mute, not a bad message) twice in ten minutes is what a
      // login Tencent has just invalidated looks like from here.
      if (error.detail.includes('EventChecker')) {
        const now = nowSeconds();
        this.pipelineFailures = [...this.pipelineFailures.filter(time => now - time < 600), now];
        if (this.pipelineFailures.length >= 2) {
          const warning = 'QQ 连续两次发不出消息（EventChecker），可能被腾讯限制或踢下线了：去「QQ 登录」看看机器人的 QQ 是否要重新登录';
          this.error = warning; this.record(undefined, JobState.failed, warning);
        }
      }
    } else {
      this.sends.finish(ticket, false);
      this.record(target.id, JobState.uncertain, what + '发送结果未知，不重发');
    }
  }

  /// QQ logged the account out. The engine stops instead of pretending to be connected, and says what to do.
  kickedOffline(detail) {
    const reason = 'QQ 被踢下线了' + (detail === '' ? '' : `（${prefix(detail, 120)}）`) + '：在机器人那个 QQ 窗口里重新登录，登录后会自动恢复回复';
    this.kickedAt = new Date();
    this.kicks = [...this.kicks, new QQKick({at: new Date(), sendsLastHour: this.sends.sent(3600), sendsLastTenMinutes: this.sends.sent(600)})].slice(-30);
    this.record(undefined, JobState.failed, reason);
    this.disconnect(reason);
    this.error = reason;
  }

  // MARK: Being poked (戳一戳)

  /// A poke aimed at the bot wakes the chat's agent, which pokes back, says something, or lets it be. The same
  /// person poking again within half a minute is not looked at twice.
  /// The gateway's self-repair fixed an error that happened in this chat and the fix now runs: the agent hears about
  /// it and can redo what failed (11-03: "他这修了也不实际用上").
  agentRepaired(key, note) {
    const target = this.config.targets.find(item => item.enabled && item.key === key);
    if (!target || note === '') return false;
    this.pushMap(this.agentEvents, target.key, new QQAgentEvent({text: note}));
    this.armAgent(target, 1);
    return true;
  }
  receivePoke(object, now) {
    if (!(object.notice_type === 'notify' && object.sub_type === 'poke' && identifier(object.target_id) === this.config.expectedSelfID)) return;
    const sender = identifier(object.user_id);
    if (sender === undefined || sender === this.config.expectedSelfID || this.config.isBlocked(sender)) return;
    const group = identifier(object.group_id);
    const target = this.config.targets.find(item => item.enabled && item.group === (group !== undefined) && item.number === (group ?? sender));
    if (!target || !this.config.ai.inWorkHours() || this.muted(target.key)) return;
    const key = target.key + '|' + sender;
    if (!(now - (this.lastPokeAt.get(key) ?? 0) >= 30)) return;
    this.lastPokeAt.set(key, now);
    const label = target.group ? QQMemoryBook.subject(this.config.expectedSelfID, target.key, sender) : 'PEER';
    const name = Object.values(this.groupRecentInputs.get(target.key) ?? {}).find(message => message.sender === sender)?.name;
    this.pushMap(this.agentEvents, target.key, new QQAgentEvent({text: (name !== undefined ? `${name}(${label})` : label) + ' 戳了你一下', sender}));
    this.armAgent(target, 1);
  }
  /** `dictionary[key, default: []].append(value)` on a Map. */
  pushMap(map, key, ...values) {
    const list = map.get(key) ?? [];
    list.push(...values); map.set(key, list);
    return list;
  }
  /// What the engine must learn about every message it sends, whichever feature sent it: the ID, so the
  /// echo of it is not taken for the owner typing; the group timeline and memory, so later turns know the
  /// bot said it; and, when it answered someone, the conversation flow, so that person can carry on
  /// without @. Every send path calls this; one that skipped a part made "你吵死了" go unanswered.
  noteSent(target, id, text, {answering, remember = true} = {}) {
    const at = new Date(), line = prefix(text, 1200);
    this.botMessageIDs[this.config.expectedSelfID + ':' + target.key + ':' + id] = at.getTime() / 1000;
    const lines = this.groupRecentMessages.get(target.key);
    if (lines && !lines.some(event => event.id === id)) {
      this.groupRecentMessages.set(target.key, [...lines, new QQMemoryEvent({id, subject: 'BOT', text: line, at})].slice(-60));
    }
    if (remember && this.config.effectiveMemoryEnabled) {
      const scope = this.config.expectedSelfID + ':' + target.key;
      this.memoryBooks[scope] ??= new QQMemoryBook();
      this.memoryBooks[scope].append(new QQMemoryEvent({id, subject: 'BOT', text: line, at}));
    }
    if (answering !== undefined) this.conversationFlow.sent(target.key, answering, text, id, false, at.getTime() / 1000);
  }
  decide(message, target, outcome) {
    if (!message.group || message.isOwner) return;
    this.decisions.push(new QQDecision({at: new Date(message.time * 1000), chat: target.name, speaker: message.name ?? '',
      text: prefix(message.text, 60), outcome}));
    if (this.decisions.length > 300) this.decisions.splice(0, this.decisions.length - 300);
  }
  /// Self events held while a send to that chat was waiting for its message ID, now classified.
  releaseHeldOwnerEvents(key) {
    if ([...this.activeGroupSubmissions.values()].includes(key)) return;
    const held = [...this.heldOwnerEvents.entries()].filter(([dedup]) => dedup.startsWith(key + ':'));
    for (const [dedup] of held) this.heldOwnerEvents.delete(dedup);
    const time = event => typeof event.time === 'number' ? event.time : 0;
    for (const [, event] of held.sort((a, b) => time(a[1]) - time(b[1]))) this.receive(event);
  }
  /// Someone reacted to the bot's own message (NapCat's group_msg_emoji_like): the agent gets to see that and
  /// answer (11-01: "别人给你点表情，也应当回应"). Reactions within a few seconds are looked at together, at most
  /// one such look per chat every two minutes.
  noteMessageReaction(object) {
    if (object.notice_type !== 'group_msg_emoji_like') return;
    const group = identifier(object.group_id), message = identifier(object.message_id);
    if (group === undefined || message === undefined || identifier(object.user_id) === this.config.expectedSelfID) return;
    const target = this.config.targets.find(item => item.enabled && item.group && item.number === group);
    if (!target) return;
    const adding = typeof object.is_add === 'boolean' ? object.is_add : true;
    const account = this.config.expectedSelfID;
    const user = identifier(object.user_id);
    if (!(adding && this.botMessageIDs[account + ':' + target.key + ':' + message] !== undefined && user !== undefined && !this.config.isBlocked(user))) return;
    const said = (this.groupRecentMessages.get(target.key) ?? []).find(event => event.id === message)?.text ?? '';
    const name = Object.values(this.groupRecentInputs.get(target.key) ?? {}).find(input => input.sender === user)?.name;
    const label = QQMemoryBook.subject(account, target.key, user);
    const likes = Array.isArray(object.likes) && object.likes.every(isDictionary) ? object.likes : [];
    const emojis = likes.slice(0, 3).map(like => identifier(like.emoji_id)).filter(id => id !== undefined).map(QQEngine.reactionName);
    if (!emojis.length) return;
    if (!(this.agentReactors.get(target.key) ?? []).includes(user)) this.pushMap(this.agentReactors, target.key, user);
    const list = this.pushMap(this.agentReacted, target.key, (name !== undefined ? `${name}(${label})` : label) + ` 给你的消息 ${message}「${prefix(said, 40)}」贴了 ` + emojis.join('、'));
    this.agentReacted.set(target.key, list.slice(-6));
    // Every reaction wakes the agent (11-03: the once-per-two-minutes limit went); one already on its way picks it up.
    if (this.agentPending.has(target.key) || this.agentTimers.has(target.key)) return;
    this.armAgent(target, 5);
  }
  /// A reaction id as something readable: QQ's own faces by name, larger ids are emoji code points.
  static reactionName(id) {
    const code = /^[+-]?\d+$/.test(id) ? Number(id) : NaN;
    if (Number.isInteger(code) && code > 1000 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)) return String.fromCodePoint(code);
    const name = QQPolicy.faceNames[id];
    return name !== undefined ? `[${name}]` : `表情 ${id}`;
  }
  /// Checked on the connection's ten-second tick: a reminder that is due wakes its chat's agent.
  scheduleReminders(now = new Date()) {
    if (!(this.running && this.connected && this.agentReminders.some(reminder => reminder.due <= now))) return;
    const due = this.agentReminders.filter(reminder => reminder.due <= now);
    this.agentReminders = this.agentReminders.filter(reminder => !(reminder.due <= now));
    try { this.persist(); } catch {}
    for (const reminder of due) {
      const target = this.config.targets.find(item => item.key === reminder.key && item.enabled);
      if (!target) continue;
      this.pushMap(this.agentWake, target.key, reminder);
      this.armAgent(target, 0.2);
    }
  }
  /// A due reminder in a chat with nothing recent to look at: its prepared line goes out as it is.
  async sayReminders(due, target, epoch) {
    for (const reminder of due) {
      if (reminder.say === '') continue;
      try { this.check(epoch, target.key, target); } catch { return; }
      let sent = true;
      try { await this.agentSend(target, [{type: 'text', data: {text: reminder.say}}], reminder.say, undefined, epoch); } catch { sent = false; }
      if (sent) this.noteAgent(target, `到点发了定好的话「${prefix(reminder.say, 30)}」`, reminder.about);
    }
  }
  /// Every tool the agent can be offered and the lowest permission level that has it, for the console's tool page.
  get agentToolCatalog() {
    const kindOf = {send_message: 'text', send_sticker: 'sticker', search_stickers: 'sticker', react: 'reaction', search_reactions: 'reaction',
      poke: 'poke', like: 'like', recall: 'recall', send_voice: 'voice', draw_image: 'image', send_artwork: 'artwork',
      set_reminder: 'later', cancel_reminder: 'later'};
    const all = [...DeepSeekClient.agentTools(true), ...DeepSeekClient.agentActionTools(QQAgentLevel.bubbleKinds(QQAgentLevel.full), true),
      QQEngine.agentSaveStickerDefinition, QQEngine.notifyOwnerDefinition, QQArtworkLibrary.definition, DeepSeekClient.createToolDefinition, DeepSeekClient.computerTool];
    return all.flatMap(tool => {
      const fn = tool?.function, name = fn?.name;
      if (typeof name !== 'string') return [];
      const level = name === 'computer_task' ? 'super' : ['check_new_messages', 'wait', 'end_turn'].includes(name) ? 'basic'
        : QQAgentLevel.all.find(item => QQAgentLevel.tools(item).has(name) || (kindOf[name] !== undefined && QQAgentLevel.bubbleKinds(item).has(kindOf[name]))) ?? 'full';
      return [{name, description: typeof fn.description === 'string' ? fn.description : '', level}];
    });
  }
  /// Each agent chat right now: messages waiting, or thinking since when.
  get agentStates() {
    return this.config.targets.filter(target => target.enabled).map(target => {
      const row = {key: target.key, chat: this.chatLabel(target), pending: this.agentPending.get(target.key)?.length ?? 0};
      const since = this.agentThinking.get(target.key);
      if (since !== undefined) row.thinkingSince = since.getTime() / 1000;
      const last = this.agentTurns.findLast(turn => turn.key === target.key);
      if (last) { row.lastAt = last.at.getTime() / 1000; row.lastDecision = last.decision; }
      return row;
    });
  }

  saveAgentLevels(levels) {
    const updated = this.config.clone();
    const known = new Set(this.config.targets.map(target => target.key));
    updated.agentLevels = Object.fromEntries(Object.entries(levels).filter(([key, value]) => known.has(key) && value !== QQAgentLevel.full));
    updated.validate();
    const previous = this.config;
    this.config = updated;
    try { this.persist(); } catch (error) { this.config = previous; throw error; }
  }

  noteForAgent(message, target, calling) {
    const key = message.key;
    this.pushMap(this.agentPending, key, message.id);
    if (calling) this.agentCalling.add(key);
    const first = this.agentFirstPending.get(key) ?? new Date();
    this.agentFirstPending.set(key, first);
    // Someone calling it (@, a reply to it, its name, a private message) is looked at at once; what they add while
    // it works reaches the running turn (agentNews). Group chatter still gathers into batches (11-03, "更快速").
    this.armAgent(target, calling ? 0.2 : Math.max(0.2, Math.min(this.agentQuietSeconds, this.agentCollectSeconds - (Date.now() - first.getTime()) / 1000)));
  }
  armAgent(target, delay) {
    const key = target.key, epoch = this.fence.epoch;
    this.agentTimers.get(key)?.cancel();
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || !this.fence.permits(epoch)) return;
      this.agentTimers.delete(key);
      const queued = this.queue.some(item => item.case === 'agent' && item.target.key === key);
      if (queued || this.queue.length >= QQEngine.queueCapacity) return;
      this.queue.push({case: 'agent', target}); this.startQueue();
    }, delay * 1000);
    this.agentTimers.set(key, {cancel() { cancelled = true; clearTimeout(timer); }});
  }
  noteAgent(target, what, why) {
    const line = formatDate(new Date(), 'HH:mm') + ' ' + what + (why === '' ? '' : '（' + why + '）');
    this.agentLog.set(target.key, [...(this.agentLog.get(target.key) ?? []), line].slice(-12));
  }
  updateTurn(id, change) {
    const turn = this.agentTurns.findLast(item => item.id === id);
    if (turn) change(turn);
  }

  // MARK: Rolling summary of each group's older lines

  /// Once ten lines have scrolled past the last dozen, a cheap background call folds them into the group's
  /// summary; replies then read that paragraph instead of the lines themselves.
  scheduleTimelineSummary(target) {
    const key = target.key;
    // Only where the bot is taking part (it spoke in the last half hour): summarizing a group it only reads
    // would cost more than the replies save. A failed call waits five minutes before the next try.
    const events = this.groupRecentMessages.get(key);
    if (this.summarizing.has(key) || new Date() < (this.summaryRetryAt.get(key) ?? distantPast) || !events ||
      !events.some(event => event.subject === 'BOT' && (Date.now() - event.at.getTime()) / 1000 < 1800)) return;
    const batch = QQTimelineDigest.due(events, this.timelineSummaries[key]);
    const last = batch?.at(-1);
    if (!batch || !last) return;
    this.summarizing.add(key); this.summaryRetryAt.set(key, addSeconds(new Date(), 300));
    const epoch = this.fence.epoch;
    const inputs = this.groupRecentInputs.get(key) ?? {};
    const names = {};
    for (const event of batch) { const name = inputs[event.id]?.name; if (name !== undefined && names[event.id] === undefined) names[event.id] = name; }
    const previous = QQTimelineDigest.carried(this.timelineSummaries[key]);
    task(async () => {
      try {
        const rule = new ChatRule({id: target.id, name: target.name});
        rule.prompt = QQTimelineDigest.prompt;
        const credential = this.runtimeCredentials?.deepSeekKey ?? Keychain.load('api-key', this.allowAuthenticationUI);
        const input = '之前的摘要：\n' + (previous === '' ? '（无）' : previous) + '\n\n刚滚出窗口的消息：\n' + QQTimelineDigest.lines(batch, names);
        const result = await this.modelClient.reply({key: credential, config: this.config.ai, rule, history: [], text: input,
          jsonOutput: true, purpose: 'summary', chat: this.chatLabel(target), reserve: async () => this.reserveModel(epoch, key, target)});
        this.usage.tokens += result.tokens;
        const text = QQTimelineDigest.decode(result.text);
        if (!this.fence.permits(epoch) || text === undefined) return;
        this.timelineSummaries[key] = new QQTimelineSummary({text, throughID: last.id, at: new Date()});
        this.summaryRetryAt.delete(key);
        try { this.persist(); } catch {}
      } catch {} finally { this.summarizing.delete(key); }
    });
  }

  saveReactions(settings) {
    const updated = this.config.clone();
    updated.reactions = settings.clone();
    updated.validate();
    const previous = this.config;
    this.config = updated;
    try { this.persist(); } catch (error) { this.config = previous; throw error; }
  }

  // MARK: Starting private conversations

  /// Applies immediately, also while replying. Exclusions are kept only for managed private chats.
  saveOutreach(settings) {
    const updated = this.config.clone();
    updated.outreach = settings.clone();
    updated.outreach.excluded = settings.excluded.filter(key => this.config.targets.some(target => target.key === key && !target.group));
    updated.validate();
    const previous = this.config;
    this.config = updated;
    try { this.persist(); } catch (error) { this.config = previous; throw error; }
  }
  /// Called from the connection watchdog. At most one friend is queued per tick, so first
  /// messages are spread out instead of going to everyone at once.
  scheduleOutreach(now = new Date()) {
    const settings = this.config.effectiveOutreach;
    if (!(this.running && !this.singleReply && settings.enabled && this.config.ai.inWorkHours() && (this.runDeadline === undefined || now < this.runDeadline) &&
      this.queue.length < QQEngine.queueCapacity)) return;
    const time = now.getTime() / 1000;
    const privateChats = this.config.targets.filter(target => target.enabled && !target.group);
    // A chat seen for the first time starts its quiet-time clock now, never in the past.
    if (privateChats.some(chat => this.outreachLedger.lastIncoming[chat.key] === undefined)) {
      for (const chat of privateChats) this.outreachLedger.observe(chat.key, time);
      try { this.persist(); } catch {}
    }
    const target = privateChats.find(chat => !(this.agentEvents.get(chat.key) ?? []).some(event => event.outreach) && this.outreachLedger.due(chat.key, time, settings));
    if (!target || !this.outreachContext(target)) return;
    const quiet = time - Math.max(this.outreachLedger.lastIncoming[target.key] ?? 0, this.outreachLedger.lastSent[target.key] ?? 0);
    this.outreachLedger.considered(target.key, time); try { this.persist(); } catch {}
    this.pushMap(this.agentEvents, target.key, new QQAgentEvent({text: `主人开了“主动找人聊天”：你和 TA 已经 ${Math.max(1, Math.trunc(quiet / 3600))} 小时没聊了。翻翻记忆和之前的聊天，有自然的由头就主动发一句：TA 提过的考试、面试、生病、出行、在追的番或游戏、说过要做的事，问问后来怎么样了；或者结合现在的时间（早上、饭点、周末、节假日）轻松打个招呼。像熟人随手发的，一两句，最多问一个问题，不编你们没聊过的事。没有合适的由头、或者对方上次明显想结束聊天、心情很差需要空间，就别发，也别发“在吗”。`, outreach: true}));
    this.armAgent(target, 0.2);
  }
  get outreachChats() {
    return this.config.targets.filter(target => !target.group && target.enabled).map(target => ({key: target.key, name: target.name,
      lastIncoming: this.outreachLedger.lastIncoming[target.key] ?? null,
      lastSent: this.outreachLedger.lastSent[target.key] ?? null,
      awaitingReply: this.outreachLedger.awaitingReply.includes(target.key),
      excluded: this.config.effectiveOutreach.excluded.includes(target.key)}));
  }
  /// Only friends the bot has really talked with get an unprompted message.
  outreachContext(target) {
    const book = this.memoryBooks[this.config.expectedSelfID + ':' + target.key];
    if (!book) return false;
    return book.items.some(item => item.current(new Date())) || book.recent.some(event => event.subject === 'PEER');
  }
  /// Moderation lists apply immediately and may change while replies are running.
  saveModeration(admins, blocked) {
    const updated = this.config.clone();
    updated.adminIDs = [...admins]; updated.blockedIDs = [...blocked];
    updated.validate();
    const previous = this.config;
    this.config = updated;
    try { this.persist(); } catch (error) { this.config = previous; throw error; }
  }
  async prepareArtwork(request, target, epoch, scheduled = false, signal) {
    this.check(epoch, target.key, target);
    const settings = this.config.effectiveArtwork;
    const started = new Date(); let requests = 0;
    const result = await this.artworkLibrary.prepare(request, {config: settings,
      scope: this.config.expectedSelfID + ':' + target.key, ledger: this.artworkLedger.clone(), randomArtist: scheduled, beforeFetch: () => {
        this.check(epoch, target.key, target);
        // Counted, not capped (11-03: the Pixiv tool has the whole site, only R-18 and political works are skipped).
        this.artworkLedger.reserveNetwork(Infinity); this.persist();
        requests += 1;
      }, signal});
    result.sourceRequests = requests; result.preparationSeconds = (Date.now() - started.getTime()) / 1000;
    this.check(epoch, target.key, target);
    if (!(result.id === undefined || result.image !== undefined)) throw new AppFailure('作品图片未就绪，已阻止仅链接发送');
    return result;
  }
  async deliverArtwork(request, target, due, epoch, signal) {
    let ticket;
    const submissionID = uuid();
    const allowance = () => this.sends.allowance(target.id, this.config.ai.effectiveSendLimits, this.config.ai.cooldownSeconds);
    try {
      while (allowance() === SendAllowance.cooldown) {
        await taskSleep(500, signal); this.check(epoch, target.key, target);
      }
      this.check(epoch, target.key, target);
      if (allowance() !== SendAllowance.allowed) return;
      if (due !== undefined && (Date.now() - due.getTime()) / 1000 > 120) { this.record(target.id, JobState.skipped, '插画定时任务已过期，不补发'); return; }
      let prepared;
      try { prepared = await this.prepareArtwork(request, target, epoch, due !== undefined, signal); }
      catch (error) {
        this.check(epoch, target.key, target);
        this.artworkStatus = describe(error);
        this.record(target.id, JobState.failed, '插画来源请求失败：' + describe(error));
        if (due !== undefined) { this.record(target.id, JobState.failed, '定时插画来源不可用，未发送或重试'); return; }
        prepared = new QQArtworkPrepared({request, caption: '本次插画来源暂不可用，请稍后重试原命令。未调用大模型。\n' + QQArtworkRequest.navigation});
      }
      this.check(epoch, target.key, target);
      if (due !== undefined && (Date.now() - due.getTime()) / 1000 > 120) return;
      if (due !== undefined && (prepared.id === undefined || prepared.image === undefined)) { this.artworkStatus = '定时插画无可附图的合格作品，本次跳过'; return; }
      ticket = await this.reserveSend(epoch, target, signal);
      if (due === undefined && ['featured', 'search', 'hot', 'artist', 'id'].includes(prepared.request.mode)) {
        this.artworkLedger.continuation[this.config.expectedSelfID + ':' + target.key] = prepared.request;
      }
      if (prepared.id !== undefined && ticket !== undefined) {
        this.artworkLedger.reserve(ticket, this.config.expectedSelfID + ':' + target.key, prepared.id, prepared.hash, prepared.request);
      }
      this.persist();
      const [action, params] = QQPolicy.sendAction(target, prepared.caption, prepared.image);
      if (target.group) this.activeGroupSubmissions.set(submissionID, target.key);
      const response = await this.connection.action(action, params);
      const id = isDictionary(response.data) ? identifier(response.data.message_id) : undefined;
      if (id === undefined || !isInt64(id)) throw new AppFailure('插画发送缺少确认 ID');
      // A scheduled post is the program's doing: said so in the timeline, or the agent took it for its own choice
      // and apologised for (or recalled) "its" picture (11-03).
      this.noteSent(target, id, (due !== undefined ? '[定时插画：程序按主人的设置自动发的，不是你这一轮发的] ' : '') +
        (prepared.image === undefined ? '' : '（发了一张插画）') + prepared.caption, {remember: false});
      if (due !== undefined) this.noteAgent(target, '程序按定时自动发了一张插画', '');
      if (ticket !== undefined) { this.sends.finish(ticket, true); this.artworkLedger.finish(ticket, true); } ticket = undefined;
      this.persist();
      this.activeGroupSubmissions.delete(submissionID);
      if (this.fence.permits(epoch)) this.releaseHeldOwnerEvents(target.key);
      this.artworkStatus = (prepared.image === undefined ? '插画帮助或无结果提示已获发送确认；未发送作品链接，未调用模型' : '插画与署名已获发送确认；命令未调用模型') +
        `；取图 ${prepared.preparationSeconds.toFixed(1)} 秒，来源请求 ${prepared.sourceRequests} 次`;
      this.record(target.id, JobState.confirmed, this.artworkStatus);
      if (this.singleReply) this.pause();
    } catch (error) {
      for (const key of [...this.heldOwnerEvents.keys()]) if (key.startsWith(target.key + ':')) this.heldOwnerEvents.delete(key);
      if (ticket !== undefined) {
        this.artworkLedger.finish(ticket, false);
        this.sendFailed(error, ticket, target, '插画');
      } else if (this.fence.permits(epoch)) this.record(target.id, JobState.failed, '插画请求未发送：' + describe(error));
    } finally { this.activeGroupSubmissions.delete(submissionID); }
  }
  async prepareImage({request, proposed, proactive, epoch, message, target, key, signal, references = [], options = {}}) {
    const {plan, tokens} = await this.modelClient.prepareQQImage({key, config: this.config.ai, text: request, proposed, proactive, references: references.length,
      reserve: async () => this.reserveModel(epoch, message.key, target), signal});
    this.check(epoch, message.key, target); this.usage.tokens += tokens;
    // The chat model asked to draw after reading the whole conversation; "none" here only means the latest
    // line alone ("那你就画一张") did not look like a request, which used to end in "没生成成功" with no attempt.
    // Unsafe requests come back as "decline", never "none", so drawing the draft is safe.
    const drawing = plan.action === 'none' && !proactive ? (proposed === undefined ? undefined : trim(proposed)) : plan.prompt;
    if (plan.action === 'none' && (drawing ?? '') === '') {
      if (proposed === undefined) return undefined;
      this.imageGenerationStatus = '生图意图整理器判断这不是画图请求，没有调用图片接口';
      this.record(target.id, JobState.skipped, this.imageGenerationStatus); return undefined;
    }
    let result;
    if (plan.action === 'decline') {
      result = new ModelToolResult({content: '本次未生成图片。请求需调整：' + plan.note + '。仅提出合规方向，等待用户选择，不冒称已生成。', imageStatus: '生图请求需调整，未调用图片接口'});
      this.record(target.id, JobState.skipped, '生图请求不合规，没画：' + plan.note);
    } else {
      const args = JSON.stringify({prompt: prefix(drawing ?? '', 1000)});
      result = await this.imageGenerator.execute({arguments: args, settings: this.config.effectiveImageGeneration, credentials: this.imageCredentials,
        beforeAttempt: async () => this.reserveModel(epoch, message.key, target), signal, references, options});
    }
    this.check(epoch, message.key, target);
    this.imageGenerationStatus = result.imageStatus ?? '本次未生成图片';
    if (plan.action !== 'decline' && result.image === undefined) this.record(target.id, JobState.failed, '画图没成功：' + this.imageGenerationStatus);
    return result;
  }
  /// One chat's short-term context and long-term memory, cleared while everything else keeps running.
  resetMemory(key) {
    const target = this.config.targets.find(item => item.key === key);
    if (!target) throw new AppFailure('会话不存在');
    this.resetContext(target, true);
    this.persist();
    this.memoryStatus = `已清空「${target.name}」的上下文和记忆`;
    this.record(target.id, JobState.confirmed, '控制台清空了这个会话的上下文和记忆');
  }
  clearMemory(id) {
    const target = this.config.targets.find(item => item.id === id);
    if (!target) return;
    this.pause();
    const scope = this.config.expectedSelfID + ':' + target.key;
    delete this.memoryBooks[scope]; this.memoryIndexes.delete(scope); this.memoryRetryAfter.delete(scope);
    try { this.persist(); this.memoryStatus = '该会话所有记忆和待整理片段已清除'; this.status = 'QQ 回复已暂停'; } catch (error) { this.error = describe(error); }
  }
  scheduleMemoryLearning() {
    if (!(this.running && this.connected && this.config.effectiveMemoryEnabled && this.memoryWorker === undefined && this.storageOK)) return;
    const epoch = this.fence.epoch;
    const worker = new AbortController();
    this.memoryWorker = worker;
    task(async () => {
      try {
        // One background writer; continuous reply traffic must not starve memory maintenance.
        const oldest = target => this.memoryBooks[this.config.expectedSelfID + ':' + target.key]?.pending[0]?.at ?? distantFuture;
        const targets = this.config.targets.filter(target => target.enabled).sort((a, b) => oldest(a) - oldest(b));
        for (const target of targets) {
          const scope = this.config.expectedSelfID + ':' + target.key;
          const book = this.memoryBooks[scope];
          const retry = this.memoryRetryAfter.get(scope);
          if (!(this.config.effectiveMemoryEnabled && book && book.due(this.config.effectiveMemoryOptions) && (retry === undefined || retry <= new Date()))) continue;
          const batch = book.batch(); if (!batch.length) continue;
          try {
            this.check(epoch, target.key, target);
            const index = this.memoryIndexes.get(scope) ?? new QQMemoryIndex(book.items);
            this.memoryIndexes.set(scope, index);
            let candidates = [];
            for (const subject of [...new Set(batch.map(event => event.subject))].sort()) {
              candidates.push(...index.search(batch.filter(event => event.subject === subject).map(event => event.text).join('\n'), subject, 24).filter(item => item.subject === subject));
            }
            const unique = new Map();
            for (const item of candidates) if (!unique.has(item.id)) unique.set(item.id, item);
            candidates = [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 48);
            const key = this.runtimeCredentials?.deepSeekKey ?? Keychain.load('api-key', this.allowAuthenticationUI);
            this.memoryStatus = '正在整理会话重点';
            const [delta, tokens, suppliedIDs] = await this.modelClient.learnQQMemory({key, config: this.config.ai, events: batch, candidates, chat: this.chatLabel(target),
              reserve: async () => this.reserveModel(epoch, target.key, target), signal: worker.signal});
            this.check(epoch, target.key, target);
            const current = this.memoryBooks[scope]?.clone();
            if (!this.config.effectiveMemoryEnabled || !current) throw new CancellationError();
            current.apply(delta, batch, suppliedIDs);
            this.memoryBooks[scope] = current; this.memoryIndexes.set(scope, new QQMemoryIndex(current.items));
            this.usage.tokens += tokens; this.memoryRetryAfter.delete(scope);
            this.memoryStatus = `记忆整理完成：${batch.length} 条片段，${delta.changes.length} 项重点变更`;
            this.persist();
          } catch (error) {
            if (!this.fence.permits(epoch)) return;
            this.memoryRetryAfter.set(scope, addSeconds(new Date(), 60));
            // The reason goes in the record: without it a failure here could not be told from a quota stop or a timeout.
            const reason = prefix(describe(error), 80);
            this.memoryStatus = `记忆整理未完成（${reason}），片段已保留，至少 60 秒后重试`;
            this.record(target.id, JobState.failed, `记忆整理未完成：${reason}（片段保留，不影响回复）`);
          }
          if (this.workers.size || this.queue.length) return;
        }
      } finally {
        if (this.fence.permits(epoch)) this.memoryWorker = undefined;
      }
    });
  }
  check(epoch, scope, target) {
    // Freshness is checked on admission. An accepted FIFO item may wait longer;
    // pause, disconnect or the run deadline cancels all queued work.
    if (!(this.fence.permits(epoch) && this.connected && this.storageOK && this.config.ai.inWorkHours() && (this.runDeadline === undefined || new Date() < this.runDeadline) &&
      this.config.targets.some(item => item.id === target.id && item.enabled && item.key === scope))) {
      throw new AppFailure('QQ 任务已暂停或目标已变更');
    }
  }
  reserveModel(epoch, scope, target) {
    this.check(epoch, scope, target);
    // Counted for the console, never refused: there is no daily cap on model calls (11-03).
    this.usage.reserve(Infinity);
    this.persist();
  }
  async reserveSend(epoch, target, signal) {
    while (this.sends.allowance(target.id, this.config.ai.effectiveSendLimits, this.config.ai.cooldownSeconds) === SendAllowance.cooldown) {
      await taskSleep(100, signal);
      this.check(epoch, target.key, target);
    }
    this.check(epoch, target.key, target);
    return this.sends.reserve(target.id, this.config.ai.effectiveSendLimits, this.config.ai.cooldownSeconds);
  }
  record(target, state, detail) {
    this.logs.push(new LogEntry({chatID: target, state, detail}));
    try { this.persist(); } catch (error) { this.error = describe(error); }
  }
  persist() {
    if (!this.storageOK || !this.file) throw new AppFailure('QQ 本地存储不可用');
    const file = this.file;
    // A disconnected native panel must not overwrite a running control page's state.
    let writeLock;
    if (!this.runtimeLock) {
      writeLock = acquireEngineLock(path.join(path.dirname(file), 'qq-engine.lock'));
      if (writeLock === 'failed') throw new AppFailure('无法创建 QQ 配置写入锁');
      if (writeLock === 'busy') throw new AppFailure('另一处 QQ 引擎正在运行，不能覆盖其配置');
    }
    try {
      const current = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
      const same = current === undefined ? this.persistedData === undefined : this.persistedData !== undefined && current.equals(this.persistedData);
      if (!same) throw new AppFailure('QQ 配置已由另一实例更新，请重新打开面板再操作');
      this.artworkLedger.trim();
      const now = nowSeconds();
      this.seen = Object.fromEntries(Object.entries(this.seen).filter(([, time]) => now - time < 86400));
      const weekAgo = addSeconds(new Date(), -7 * 86400);
      this.logs = this.logs.filter(entry => entry.date > weekAgo).slice(-1000);
      try {
        this.botMessageIDs = Object.fromEntries(Object.entries(this.botMessageIDs).filter(([, time]) => now - time < 7 * 86400));
        if (Object.keys(this.botMessageIDs).length > 10000) this.botMessageIDs = Object.fromEntries(Object.entries(this.botMessageIDs).sort((a, b) => b[1] - a[1]).slice(0, 10000));
        this.recentStickers = Object.fromEntries(Object.entries(this.recentStickers)
          .map(([key, uses]) => [key, uses.filter(use => (Date.now() - use.at.getTime()) / 1000 < 7 * 86400).slice(-500)])
          .filter(([, uses]) => uses.length));
        if (Object.keys(this.recentStickers).length > 60) {
          const lastAt = uses => uses.at(-1)?.at ?? distantPast;
          this.recentStickers = Object.fromEntries(Object.entries(this.recentStickers).sort((a, b) => lastAt(b[1]) - lastAt(a[1])).slice(0, 60));
        }
        const state = new QQStored({config: this.config, usage: this.usage, sends: this.sends, logs: this.logs, seen: this.seen, memories: undefined, memoryBooks: this.memoryBooks,
          botMessageIDs: this.botMessageIDs, ownershipSince: this.ownershipSince, stickerHistory: this.recentStickers, stickerLastSentAt: this.lastStickerAt,
          artworkLedger: this.artworkLedger, contextResetAt: this.contextResetAt, outreachLedger: this.outreachLedger,
          // They quote messages, so they reach the disk only when the owner lets the bot keep chat text.
          removedTargets: this.removedTargets, decisions: this.config.effectiveMemoryEnabled ? this.decisions : undefined,
          timelineSummaries: this.config.effectiveMemoryEnabled ? this.timelineSummaries : undefined, agentReminders: this.agentReminders,
          agentTurns: this.agentTurns.slice(-QQEngine.agentTurnsKept), agentNotes: this.agentNotes, kicks: this.kicks});
        // QQ uses authenticated network events and may run while the desktop is locked.
        // User-enabled structured memories and bounded/redacted pending excerpts; never image bytes or credentials.
        const data = Buffer.from(JSON.stringify(state));
        writeAtomically(file, data);
        this.persistedData = data;
      } catch (error) {
        this.storageOK = false; this.error = `QQ 状态保存失败：${describe(error)}`;
        this.disconnect('QQ 状态保存失败，已停止'); throw error;
      }
    } finally {
      if (writeLock && typeof writeLock === 'object') releaseEngineLock(writeLock);
    }
  }
}

/** Data.write(options: .atomic): a temporary file beside it, then a rename over the old one. Windows may refuse the
 *  rename for a moment while another process (an indexer, a virus scanner) has the file open; that is retried. */
function writeAtomically(file, data) {
  const temporary = file + '.' + process.pid + '.' + uuid().slice(0, 8) + '.tmp';
  fs.writeFileSync(temporary, data, {mode: 0o600});
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); break; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) { try { fs.unlinkSync(temporary); } catch {} throw error; }
      sleepSync(20 * (attempt + 1));
    }
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

Object.assign(QQEngine.prototype, agentMethods);
Object.assign(QQEngine.prototype, mediaMethods);
QQEngine.agentSaveStickerDefinition = agentSaveStickerDefinition;

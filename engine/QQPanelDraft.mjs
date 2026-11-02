// Port of QQPanelDraft.swift. Values are copied in and out (Swift structs), compared with equals()/structural ==.
import {AppFailure, trim} from './swift.mjs';
import {QQConfig} from './core/QQPolicy.mjs';
import {QQImageGenerationConfig} from './core/QQImageGenerationConfig.mjs';
import {QQVisualConfig} from './core/QQVisualConfig.mjs';
import {QQArtworkConfig} from './core/QQArtwork.mjs';
import {QQMemoryOptions} from './core/QQMemoryBook.mjs';
import {copy, same} from './foundation.mjs';

/// Editors own their draft. Runtime configuration changes only after a successful save.
export class QQPanelDraft {
  /** init(value:) — `new QQPanelDraft({value})`. */
  constructor({value} = {}) { this.baseline = copy(value); this.value = copy(value); }
  get hasChanges() { return !same(this.value, this.baseline); }
  /** conflicts(with:) — `conflicts(current)` (or `conflicts({with: current})`). */
  conflicts(current) {
    if (current !== null && typeof current === 'object' && Object.keys(current).length === 1 && 'with' in current) current = current.with;
    return this.hasChanges && !same(this.baseline, current);
  }
  refresh(current) {
    if (!this.hasChanges || same(this.value, current)) this.reset(current);
  }
  reset(current) { this.baseline = copy(current); this.value = copy(current); }
  clone() {
    const result = Object.create(QQPanelDraft.prototype);
    result.baseline = copy(this.baseline); result.value = copy(this.value);
    return result;
  }
}

export class QQConnectionForm {
  /** init(_ config: QQConfig) — `new QQConnectionForm(config)`. */
  constructor(config) { this.endpoint = config.endpoint; this.expectedSelfID = config.expectedSelfID; }
  equals(other) { return other instanceof QQConnectionForm && this.endpoint === other.endpoint && this.expectedSelfID === other.expectedSelfID; }
  clone() { return new QQConnectionForm(this); }
}

/// Only fields saved by the reply/range editor, so changing image settings does
/// not invalidate an unrelated reply draft.
export class QQReplyForm {
  /** init(_ config: QQConfig) — `new QQReplyForm(config)`. */
  constructor(config) {
    this.ai = copy(config.ai); this.persona = copy(config.effectivePersona); this.targets = copy(config.targets);
    this.dailyLimit = String(config.ai.dailyLimit);
    this.sendDaily = String(config.ai.effectiveSendLimits.daily);
    this.perChatDaily = String(config.ai.effectiveSendLimits.perChatDaily);
    this.onlineEnabled = config.effectiveOnlineEnabled; this.visionEnabled = config.effectiveVisionEnabled;
    this.memoryEnabled = config.effectiveMemoryEnabled; this.memoryOptions = copy(config.effectiveMemoryOptions);
  }
  validatedAI() {
    const updated = copy(this.ai);
    updated.dailyLimit = panelInteger(this.dailyLimit, '每日模型调用上限', [1, 10000]);
    const limits = copy(updated.effectiveSendLimits);
    limits.daily = panelInteger(this.sendDaily, '每日发送上限', [1, 10000]);
    limits.perChatDaily = panelInteger(this.perChatDaily, '单会话每日发送上限', [1, 10000]);
    updated.effectiveSendLimits = limits;
    updated.validate();
    return updated;
  }
  equals(other) {
    return other instanceof QQReplyForm && ['ai', 'dailyLimit', 'sendDaily', 'perChatDaily', 'persona', 'targets', 'onlineEnabled',
      'visionEnabled', 'memoryEnabled', 'memoryOptions'].every(key => same(this[key], other[key]));
  }
  clone() {
    const result = Object.create(QQReplyForm.prototype);
    for (const key of Object.keys(this)) result[key] = copy(this[key]);
    return result;
  }
}

/// Owned by the dashboard window, not a conditional page. Drafts and temporary
/// credential input survive navigation, but are never serialized to disk.
export class QQPanelState {
  constructor() {
    this.token = ''; this.webToken = ''; this.temporaryKey = ''; this.search = '';
    this.imageZhipuKey = ''; this.imageCloudflareToken = ''; this.persistImageCredentials = true;
    this.googleVisionKey = ''; this.persistVisualCredentials = true;
    this.durationMinutes = 120;
    this.section = '连接与运行';
    this.toolSection = '插画与定时';
    this.connectionDraft = new QQPanelDraft({value: new QQConnectionForm(new QQConfig())});
    this.replyDraft = new QQPanelDraft({value: new QQReplyForm(new QQConfig())});
    this.imageDraft = new QQPanelDraft({value: new QQImageGenerationConfig()});
    this.visualDraft = new QQPanelDraft({value: new QQVisualConfig()});
    this.artworkDraft = new QQPanelDraft({value: new QQArtworkForm(new QQArtworkConfig())});
    this.artistInput = '';
  }
  get hasCredentialDrafts() {
    return this.token !== '' || this.temporaryKey !== '' || this.imageZhipuKey !== '' || this.imageCloudflareToken !== '' || this.googleVisionKey !== '';
  }
  refresh(config) {
    this.connectionDraft.refresh(new QQConnectionForm(config)); this.replyDraft.refresh(new QQReplyForm(config));
    this.imageDraft.refresh(config.effectiveImageGeneration); this.visualDraft.refresh(config.effectiveVisualTools);
    this.artworkDraft.refresh(new QQArtworkForm(config.effectiveArtwork));
  }
  useRecommendedSettings() {
    switch (this.section) {
      case '范围与回复': {
        const current = this.replyDraft.value;
        const recommended = new QQReplyForm(new QQConfig());
        recommended.persona.customName = current.persona.customName;
        recommended.persona.customPrompt = current.persona.customPrompt;
        recommended.targets = copy(current.targets);
        recommended.memoryEnabled = current.memoryEnabled; recommended.memoryOptions = copy(current.memoryOptions);
        recommended.ai.maxTokens = current.ai.maxTokens; recommended.ai.chats = copy(current.ai.chats);
        this.replyDraft.value = recommended;
        break;
      }
      case '记忆与记录':
        this.replyDraft.value.memoryEnabled = new QQConfig().effectiveMemoryEnabled;
        this.replyDraft.value.memoryOptions = new QQMemoryOptions();
        break;
      case '图片与工具':
        switch (this.toolSection) {
          case 'AI 生图': {
            const account = this.imageDraft.value.cloudflareAccountID;
            this.imageDraft.value = new QQImageGenerationConfig(); this.imageDraft.value.cloudflareAccountID = account;
            break;
          }
          case '识图与搜图': this.visualDraft.value = new QQVisualConfig(); break;
          default: {
            const current = this.artworkDraft.value;
            const settings = new QQArtworkConfig();
            settings.pixivArtistIDs = copy(current.settings.pixivArtistIDs); settings.artistNames = copy(current.settings.artistNames);
            settings.imagePermissions = copy(current.settings.imagePermissions); settings.scheduleTargets = copy(current.settings.scheduleTargets);
            this.artworkDraft.value = new QQArtworkForm(settings); this.artworkDraft.value.artists = current.artists;
          }
        }
        break;
      default: break;
    }
  }
}

export class QQArtworkForm {
  /** init(_ settings: QQArtworkConfig) — `new QQArtworkForm(settings)`. */
  constructor(settings) {
    this.settings = copy(settings); this.artists = settings.pixivArtistIDs.join(',');
    this.networkDailyLimit = String(settings.networkDailyLimit);
    this.minLongEdge = String(settings.minLongEdge); this.minShortEdge = String(settings.minShortEdge);
    this.searchMinBookmarks = String(settings.effectiveSearchMinBookmarks);
  }
  // Keep the exact editor text until the whole form can be validated. A failed
  // number conversion must not silently save the previous integer binding.
  validatedSettings() {
    const updated = copy(this.settings);
    updated.networkDailyLimit = panelInteger(this.networkDailyLimit, '每日来源请求数');
    updated.minLongEdge = panelInteger(this.minLongEdge, '最小长边像素');
    updated.minShortEdge = panelInteger(this.minShortEdge, '最小短边像素');
    updated.effectiveSearchMinBookmarks = panelInteger(this.searchMinBookmarks, '/search 优先收藏数');
    updated.pixivArtistIDs = this.artists.split(/[,， \n]/).filter(part => part !== '');
    if (updated.artistNames != null) updated.artistNames = Object.fromEntries(Object.entries(updated.artistNames).filter(([key]) => updated.pixivArtistIDs.includes(key)));
    updated.imagePermissions = Object.fromEntries(Object.entries(updated.imagePermissions).filter(([key]) => updated.pixivArtistIDs.includes(key)));
    updated.validate();
    return updated;
  }
  equals(other) {
    return other instanceof QQArtworkForm && ['settings', 'artists', 'networkDailyLimit', 'minLongEdge', 'minShortEdge', 'searchMinBookmarks']
      .every(key => same(this[key], other[key]));
  }
  clone() {
    const result = Object.create(QQArtworkForm.prototype);
    for (const key of Object.keys(this)) result[key] = copy(this[key]);
    return result;
  }
}

function panelInteger(raw, label, range) {
  const value = trim(raw);
  // Swift Int(value) fails beyond Int64.
  if (value === '' || !/^[0-9]+$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new AppFailure(`${label}必须填写非负整数，不能留空`);
  }
  const number = Number(value);
  if (range && !(number >= range[0] && number <= range[1])) {
    throw new AppFailure(`${label}必须在 ${range[0]}–${range[1]} 之间`);
  }
  return number;
}

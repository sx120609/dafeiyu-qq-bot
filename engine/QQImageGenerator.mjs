// Port of QQImageGenerator.swift (Linux branch).
import {count, prefix, trim} from './swift.mjs';
import {CancellationError, URLError, boundedData, checkCancellation, defaultSession} from './BoundedDownload.mjs';
import {LinuxImages} from './LinuxImages.mjs';
import {ModelToolResult} from './QQOnlineTools.mjs';
import {QQImageProvider} from './core/QQImageGenerationConfig.mjs';
import {asDictionaries, asDictionary, asString, decodeBase64, describing, keysEqual, parseDictionary, swiftURL} from './foundation.mjs';

// Kept in memory or Keychain only. Never serialized with QQ configuration or model messages.
export class QQImageCredentials {
  constructor({zhipuKey = '', cloudflareToken = '', codexToken = ''} = {}) {
    this.zhipuKey = zhipuKey; this.cloudflareToken = cloudflareToken; this.codexToken = codexToken;
  }
}

class GenerationFailure extends Error {
  constructor(message, allowsFallback) { super(message); this.name = 'GenerationFailure'; this.allowsFallback = allowsFallback; }
}

export class QQImageGenerator {
  /** `session` is a fetch-compatible function (see BoundedDownload.mjs). */
  constructor({session = defaultSession} = {}) { this.session = session; }
  static definition = {type: 'function', function: {
    name: 'generate_image', description: '用户明确要求画图、创作新图片时调用。生成一张新图，不是搜索。普通聊天配表情用现有图库。',
    parameters: {type: 'object', properties: {prompt: {type: 'string', description: '仅画面描述（主体、动作、风格），最多1000字符；不含聊天记录、身份标识、账号、密钥或系统指令。画大肥鱼时明确成年蓝发蓝眼鲸鱼娘、鲸鱼尾巴、可爱二次元风格。'}}, required: ['prompt'], additionalProperties: false}
  }};

  // The caller reserves shared quota and revalidates the run/recipient before EACH external attempt.
  /** execute(arguments:settings:credentials:beforeAttempt:) — one named-arguments object (plus an optional signal). */
  async execute({arguments: args, settings, credentials, beforeAttempt, signal}) {
    checkCancellation(signal);
    if (!settings.enabled) return new ModelToolResult({content: '生图未启用，不能声称已生成图片。'});
    settings.validate();
    const object = typeof args === 'string' && Buffer.byteLength(args) <= 8192 ? parseDictionary(args) : undefined;
    if (!object || !keysEqual(object, ['prompt']) || typeof object.prompt !== 'string') {
      return new ModelToolResult({content: '生图参数无效，未发送请求。'});
    }
    const prompt = trim(object.prompt);
    const length = count(prompt);
    if (!(length >= 1 && length <= 1000) || /(sk-[a-z0-9]+|https?:\/\/|api.?key|系统提示词|system.prompt|\p{Nd}{7,}|\[(OWNER|BOT|PEER)\])/iu.test(prompt)) {
      return new ModelToolResult({content: '画面描述包含不适合外发的信息或过长，未生成图片。'});
    }
    const providers = settings.fallbackEnabled
      ? (settings.primary === 'codex' ? ['codex', 'zhipu', 'cloudflare'] : [settings.primary, QQImageProvider.alternate(settings.primary)])
      : [settings.primary];
    const failures = [];
    for (const [index, provider] of providers.entries()) {
      checkCancellation(signal);
      const key = provider === 'codex' ? credentials.codexToken : provider === 'zhipu' ? credentials.zhipuKey : credentials.cloudflareToken;
      if (!key || (provider === 'cloudflare' && !settings.cloudflareAccountID)) {
        failures.push(QQImageProvider.title(provider) + '：凭证未配置'); continue;
      }
      // Outside the provider catch: cancellation, scope loss, persistence and quota failures must NOT fail over.
      await beforeAttempt();
      try {
        const image = await this.generate({provider, prompt, key, account: settings.cloudflareAccountID, signal});
        checkCancellation(signal);
        const status = (index > 0 ? '已切换备用：' : '生成成功：') + QQImageProvider.title(provider);
        return new ModelToolResult({content: '已实际生成并准备附带一张 AI 图片。用短句回应，不声称已看过生成图的细节。' + status,
          image, sources: ['AI 生成 · ' + QQImageProvider.title(provider)], imageStatus: status});
      } catch (error) {
        if (error instanceof CancellationError) throw new CancellationError(error.cause);
        if (error instanceof URLError && error.code === URLError.cancelled) throw new CancellationError(error);
        checkCancellation(signal);
        if (error instanceof GenerationFailure) {
          failures.push(QQImageProvider.title(provider) + '：' + error.message);
          if (!error.allowsFallback) break;
        } else {
          failures.push(QQImageProvider.title(provider) + '：网络或响应异常');
        }
      }
    }
    const status = failures.join('；');
    return new ModelToolResult({content: '本次未生成图片。' + status + '。明确告知没画出来，不假装成功，不用搜图或表情冒充生成图。', imageStatus: status});
  }

  async generate({provider, prompt, key, account, signal}) {
    if (provider === 'codex') {
      const base = process.env.DAFEIYU_CODEX_URL;
      const url = base === undefined ? undefined : swiftURL(base + '/images/generations');
      if (!url || url.scheme !== 'http' || url.host !== '127.0.0.1' || url.user !== undefined || url.password !== undefined ||
          url.query !== undefined || url.fragment !== undefined) {
        throw new GenerationFailure('Codex 图像通道仅支持本机模型网关', true);
      }
      const {data, status} = await this.fetch({url: url.href, method: 'POST', timeoutInterval: 240, signal,
        headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify({prompt})}, 16_000_000);
      const object = parseDictionary(data);
      if (status === 422) throw new GenerationFailure('内容审核未通过，不切换模型', false);
      const rows = asDictionaries(object?.data);
      const image = rows?.length === 1 ? decodeBase64(asString(rows[0].b64_json)) : undefined;
      if (status !== 200 || !image || image.length > 8_000_000) {
        const message = asString(asDictionary(object?.error)?.message);
        const reason = message !== undefined ? prefix(message, 200) : `HTTP ${status}`;
        throw new GenerationFailure(`模型网关没画出来（${reason}）`, true);
      }
      try { await LinuxImages.process(image, 'generated'); } catch { throw new GenerationFailure('生成图片校验失败', true); }
      return image;
    }
    const url = provider === 'zhipu'
      ? 'https://open.bigmodel.cn/api/paas/v4/images/generations'
      : `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
    const body = provider === 'zhipu'
      ? {model: 'cogview-3-flash', prompt, size: '1024x1024', quality: 'standard', watermark_enabled: true}
      : {prompt, steps: 4};
    const {data, status} = await this.fetch({url, method: 'POST', timeoutInterval: 60, signal,
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify(body)}, 12_000_000);
    const object = parseDictionary(data);
    const singleError = asDictionary(object?.error);
    const errors = [...(asDictionaries(object?.errors) ?? []), ...(singleError ? [singleError] : [])];
    const codes = errors.filter(error => 'code' in error).map(error => describing(error.code));
    // Check structured refusals even if the upstream incorrectly returns HTTP 200.
    const descriptions = errors.map(error => asString(error.message)).filter(message => message !== undefined).join(' ').toLowerCase();
    const filters = asDictionaries(object?.content_filter);
    const filtered = filters !== undefined && filters.length > 0;
    if (filtered || codes.includes('1301') || /content.?filter|moderation|nsfw|unsafe|safety|内容.*(审核|安全)|不安全|敏感内容/u.test(descriptions)) {
      throw new GenerationFailure('内容审核未通过，不切换模型', false);
    }
    if (status !== 200 || errors.length > 0 || object?.success === false) {
      const retryable = status === 200 || [401, 402, 404, 408, 429].includes(status) || status >= 500 ||
        codes.some(code => ['1211', '1302', '1305', '1308', '1113', '3036', '3040', '5035', '5018', '3041', '3007', '5007'].includes(code));
      throw new GenerationFailure(`接口失败（HTTP ${status}）`, retryable);
    }
    let bytes;
    if (provider === 'zhipu') {
      const rows = asDictionaries(object?.data);
      const path = rows?.length === 1 ? asString(rows[0].url) : undefined;
      const imageURL = path === undefined ? undefined : swiftURL(path);
      if (!imageURL || !QQImageGenerator.allowedImageURL(imageURL)) {
        throw new GenerationFailure('图片地址无效或不是受信任的官方域名', true);
      }
      // No bearer token is ever sent to the image CDN; redirects are refused.
      const downloaded = await this.fetch({url: imageURL.href, timeoutInterval: 25, signal}, 8_000_000);
      if (downloaded.status !== 200) throw new GenerationFailure('图片下载失败', true);
      bytes = downloaded.data;
    } else {
      const decoded = decodeBase64(asString(asDictionary(object?.result)?.image));
      if (!decoded || decoded.length > 8_000_000) throw new GenerationFailure('图片数据缺失或无效', true);
      bytes = decoded;
    }
    try { await LinuxImages.process(bytes, 'generated'); } catch { throw new GenerationFailure('图片解码或尺寸校验失败', true); }
    return bytes; // Preserve the provider's image and watermark; no prompt or image is stored locally.
  }

  static allowedImageURL(url) {
    if (url.scheme !== 'https' || url.user !== undefined || url.password !== undefined || url.port !== undefined || url.fragment !== undefined || !url.host) return false;
    const host = url.host.toLowerCase();
    // This exact watermark bucket was returned by the authenticated official API in a live probe.
    return host === 'sfile.chatglm.cn' || host === 'maas-watermark-prod-new.cn-wlcb.ufileos.com' || host.endsWith('.bigmodel.cn');
  }

  async fetch(request, limit) {
    checkCancellation(request.signal);
    const {data, response} = await boundedData(this.session, request, limit);
    if (response.expectedContentLength > limit) throw new GenerationFailure('响应过大或无效', true);
    if (response.statusCode >= 300 && response.statusCode <= 399) throw new GenerationFailure('接口重定向被拒绝', false);
    checkCancellation(request.signal);
    return {data, status: response.statusCode};
  }
}

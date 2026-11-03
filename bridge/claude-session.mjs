// Persistent Claude Code sessions for the agent's director. Until 11-03 every director round started a fresh
// `claude -p` and sent the whole conversation again as one message: each round paid the process start-up (about
// two seconds) and the full input, of which only the system prompt was cached. Now one Agent SDK session (streaming
// input) lives for the whole director turn: the first round sends the conversation, later rounds send only what is
// new (the tool results and any follow-up), and Claude Code caches the growing conversation. The JSON tool-call
// envelope (schema.json) and the restrictions on Claude Code's own tools are the same as for a single call.
import crypto from 'node:crypto';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {rateLimitError} from './provider-health.mjs';
import {completion} from './server.mjs';

const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Told once per session, after the application's own system prompt: how the later messages of a session look. */
export const sessionNote = '\n\n# Continuing session\nThis is one continuing conversation. The first user message carries the conversation so far. Each later user message is a JSON object whose new_messages are what happened since your last reply: the results of your tool_calls (each with the call it answers) and any new input. Read them as the next part of the same conversation and answer with the same JSON envelope. available_tools "unchanged" means the list given before still applies; an empty list means no tool may be called now.';

/** Inline images become Claude image blocks, referred to from the JSON by number (as for a single call). */
export function claudeContent(envelope, messages) {
  const images = [];
  const transcript = structuredClone(messages);
  for (const message of transcript) if (Array.isArray(message.content)) for (let i = 0; i < message.content.length; i++) {
    const part = message.content[i];
    if (part.type !== 'image_url') continue;
    const [, media, data] = part.image_url.url.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    images.push({type: 'image', source: {type: 'base64', media_type: media, data}});
    message.content[i] = {type: 'text', text: `[附件图片 ${images.length}]`};
  }
  return [{type: 'text', text: JSON.stringify(envelope(transcript))}, ...images];
}

class Session {
  constructor({key, fingerprint, options, query, onEnd}) {
    this.key = key; this.fingerprint = fingerprint; this.onEnd = onEnd;
    this.queue = []; this.wake = undefined; this.pending = undefined; this.closed = false;
    this.cost = 0; this.consumed = 0; this.prefix = ''; this.calls = []; this.tools = undefined; this.timer = undefined;
    this.stderr = ''; this.limit = undefined; this.lastUsed = Date.now();
    this.controller = new AbortController();
    this.query = query({prompt: this.input(), options: {...options, abortController: this.controller, stderr: text => this.onStderr(text)}});
    this.loop();
  }
  async *input() {
    while (!this.closed) {
      if (this.queue.length) { yield this.queue.shift(); continue; }
      await new Promise(resolve => { this.wake = resolve; });
    }
  }
  get busy() { return this.pending !== undefined; }
  /** One user message in, the next result out. A cancelled call ends the session: its process is stopped. */
  ask(content, signal) {
    if (this.closed) return Promise.reject(new Error('Claude Code 会话已结束'));
    clearTimeout(this.timer); this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      const abort = () => { this.fail(signal.reason || new Error('请求已取消')); };
      if (signal?.aborted) { reject(signal.reason || new Error('请求已取消')); this.close(); return; }
      signal?.addEventListener('abort', abort, {once: true});
      this.pending = {resolve, reject, done: () => signal?.removeEventListener('abort', abort)};
      this.queue.push({type: 'user', message: {role: 'user', content}, parent_tool_use_id: null, session_id: ''});
      this.wake?.(); this.wake = undefined;
    });
  }
  settle(error, value) {
    const pending = this.pending; this.pending = undefined;
    if (!pending) return;
    pending.done();
    if (error) pending.reject(error); else pending.resolve(value);
  }
  fail(error) { this.settle(error); this.close(); }
  onStderr(text) {
    this.stderr = (this.stderr + text).slice(-3000);
    // The CLI may sleep for minutes after a 429; surface it at once, as for a single call.
    const limited = rateLimitError(this.stderr);
    if (limited) this.fail(limited);
  }
  async loop() {
    try {
      for await (const message of this.query) {
        if (message.type === 'rate_limit_event' && message.rate_limit_info?.status === 'rejected') {
          const resets = Number(message.rate_limit_info.resetsAt);
          this.limit = Number.isFinite(resets) ? Math.max(1, Math.ceil(resets - Date.now() / 1000)) : 60;
        } else if (message.type === 'assistant' && message.error === 'rate_limit') {
          this.fail(rateLimitError('429', this.limit ?? 60));
        } else if (message.type === 'result') this.result(message);
      }
      this.fail(new Error('Claude Code 会话已结束'));
    } catch (error) {
      this.fail(rateLimitError(String(error?.message ?? error)) ?? error);
    }
  }
  result(message) {
    if (message.is_error || !message.structured_output) {
      const limited = message.is_error ? rateLimitError(JSON.stringify(message), this.limit ?? 60) : null;
      this.fail(limited ?? new Error('Claude 未返回有效结构化回复，请检查登录与额度'));
      return;
    }
    // Claude Code reports the session's cost so far; each call is metered with its own share.
    const total = Number(message.total_cost_usd) || 0;
    const cost = Math.max(0, total - this.cost); this.cost = Math.max(this.cost, total);
    this.settle(undefined, {output: message.structured_output, usage: {...(message.usage || {}), cost_usd: cost},
      model: Object.keys(message.modelUsage || {})[0]});
  }
  idle(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), ms);
    this.timer.unref?.();
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    this.settle(new Error('Claude Code 会话已结束'));
    this.wake?.(); this.wake = undefined;
    try { this.controller.abort(); } catch {}
    try { this.query.close?.(); } catch {}
    this.onEnd(this);
  }
}

/**
 * The sessions alive in this gateway, one per director turn (the engine names it in metadata.dafeiyu_session).
 * A request continues a session when its conversation is the one the session has seen, plus the reply it gave,
 * plus new messages; anything else (a retried turn, a changed model or system prompt) starts a new one.
 * After a chat's turn has started, a spare session with the same system prompt is started for its next turn, so
 * that turn does not wait for Claude Code to start (about 1.5 s). Each waiting one is a claude.exe of about 190 MB,
 * so `spares` caps how many wait (config claudeWarmSessions; 0 turns them off) and `spareIdleMs` how long.
 */
export class ClaudeSessions {
  constructor({query = sdkQuery, idleMs = 180_000, closingIdleMs = 20_000, max = 16, spares = 1, spareIdleMs = 5 * 60_000} = {}) {
    this.queryImpl = query; this.idleMs = idleMs; this.closingIdleMs = closingIdleMs; this.max = max;
    this.spareLimit = spares; this.spareIdleMs = spareIdleMs;
    this.sessions = new Map();
    this.spares = new Map();
  }
  get size() { return this.sessions.size; }
  closeAll() { for (const session of [...this.sessions.values(), ...this.spares.values()]) session.close(); }
  start(key, fingerprint, options, system) {
    return new Session({key, fingerprint, query: this.queryImpl, options: {...options, systemPrompt: system + sessionNote}, onEnd: ended => {
      if (ended.key !== undefined && this.sessions.get(ended.key) === ended) this.sessions.delete(ended.key);
      if (this.spares.get(ended.fingerprint) === ended) this.spares.delete(ended.fingerprint);
    }});
  }
  /** A waiting session for this system prompt, if one is ready. */
  take(key, fingerprint) {
    const spare = this.spares.get(fingerprint);
    if (!spare) return undefined;
    this.spares.delete(fingerprint);
    if (spare.closed) return undefined;
    spare.key = key;
    return spare;
  }
  warm(fingerprint, options, system) {
    if (!(this.spareLimit > 0) || this.spares.has(fingerprint)) return;
    while (this.spares.size >= this.spareLimit) this.spares.values().next().value.close();
    const spare = this.start(undefined, fingerprint, options, system);
    this.spares.set(fingerprint, spare);
    spare.idle(this.spareIdleMs);
  }

  /** `system` is the whole system prompt text; `rest` the conversation after the leading system messages. */
  async run({key, system, rest, body, options, signal, model}) {
    const fingerprint = digest([system, options.model, options.effort, options.tools]);
    let session = this.sessions.get(key);
    let content;
    const tools = body.tools || [];
    const toolsDigest = digest(tools);
    const fresh = () => claudeContent(transcript => ({conversation: transcript, available_tools: tools, response_format: body.response_format || null}), rest);
    if (session && !session.closed && !session.busy && session.fingerprint === fingerprint && this.continues(session, rest)) {
      const answered = new Map(session.calls.map(call => [call.id, {name: call.function.name, arguments: call.function.arguments}]));
      const added = rest.slice(session.consumed + 1).map(message => message.role === 'tool' && answered.has(message.tool_call_id)
        ? {role: 'tool', for_call: answered.get(message.tool_call_id), content: message.content} : message);
      content = claudeContent(transcript => ({new_messages: transcript, available_tools: toolsDigest === session.tools ? 'unchanged' : tools,
        response_format: body.response_format || null}), added);
    } else {
      session?.close();
      this.makeRoom();
      session = this.take(key, fingerprint) ?? this.start(key, fingerprint, options, system);
      this.sessions.set(key, session);
      content = fresh();
    }
    const starting = content !== undefined && session.consumed === 0;
    session.tools = toolsDigest;
    const answer = await session.ask(content, signal);
    // The chat's next turn gets a session that has already started.
    if (starting) this.warm(fingerprint, options, system);
    let response;
    try { response = completion(body, answer.output, answer.usage); } catch (error) { session.close(); throw error; }
    response.model = answer.model || model;
    const calls = response.choices[0].message.tool_calls || [];
    session.consumed = rest.length; session.prefix = digest(rest); session.calls = calls;
    // A reply without tool calls, or one that ends the turn with its actions (the agent's end_turn), usually closes
    // the turn; the engine may still add a follow-up right away, so the session waits a little before it ends.
    session.idle(calls.length && !calls.some(call => call.function.name === 'end_turn') ? this.idleMs : this.closingIdleMs);
    return response;
  }
  continues(session, rest) {
    if (!(rest.length > session.consumed + 1) || digest(rest.slice(0, session.consumed)) !== session.prefix) return false;
    const reply = rest[session.consumed];
    if (reply?.role !== 'assistant') return false;
    const ids = (reply.tool_calls || []).map(call => call.id).sort().join(',');
    return ids === session.calls.map(call => call.id).sort().join(',');
  }
  makeRoom() {
    const idle = [...this.sessions.values()].filter(session => !session.busy).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.sessions.size >= this.max && idle.length) idle.shift().close();
  }
}

// One pool for the whole process: a hot reload of the gateway keeps its sessions (they move onto the new code).
export const claudeSessions = globalThis.dafeiyuClaudeSessions ??= new ClaudeSessions();

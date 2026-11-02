// Shared fixtures for the engine ports of upstream/Tests/QQEngineTests: a loopback OneBot v11 WebSocket server
// (onebot_fixture.py, in-process) and a scripted model session (the URLProtocol stubs). Synthetic identities only;
// nothing here talks to QQ, the gateway or a model.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.DAFEIYU_CODEX_URL;

export const tempDirectory = () => fs.mkdtempSync(path.join(process.env.DAFEIYU_TEST_TMP || os.tmpdir(), 'dafeiyu-engine-'));
export const removeDirectory = directory => { try { fs.rmSync(directory, {recursive: true, force: true}); } catch {} };
export const wait = async (condition, seconds = 8) => {
  const deadline = Date.now() + seconds * 1000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return condition();
};
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Swift `==` on Codable values. */
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function frame(text) {
  const data = Buffer.from(text);
  const header = data.length < 126 ? Buffer.from([0x81, data.length])
    : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
  return Buffer.concat([header, data]);
}

/** onebot_fixture.py: `shape` is the message-shape file's content; options stand for its control files. */
export class OneBotFixture {
  constructor({shape = 'private', token = 'synthetic-test-token'} = {}) {
    this.shape = shape; this.token = token; this.isGroup = shape.startsWith('group');
    this.actions = []; this.payloads = []; this.reactions = []; this.approvals = []; this.history = [];
    this.rejectSend = false; this.dropSend = false; this.selfEcho = false;
    this.socket = undefined; this.connections = 0; this.unexpected = [];
    // The agent's QQ tools (QQAgentMedia): messages get_msg knows, group files, voice, forwards, members.
    this.messages = {}; this.groupFiles = {'/': {files: [], folders: []}}; this.fileURLs = {}; this.records = {}; this.pttText = undefined;
    this.selfCard = undefined; // the bot's own group card, when a test gives it one
    this.forwards = {}; this.forwardPayloads = []; this.memberList = []; this.cards = []; this.typing = []; this.honor = undefined; this.calls = [];
  }
  failed(request, message) { this.send({status: 'failed', retcode: 100, data: null, message, wording: message, echo: request.echo}); }
  async start() {
    this.server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }
  get endpoint() { return `ws://127.0.0.1:${this.port}`; }
  upgrade(req, socket) {
    if (req.headers.authorization !== 'Bearer ' + this.token) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    this.socket = socket; this.connections += 1;
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, masked = buffer[1] & 128;
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        else if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const mask = masked ? buffer.subarray(offset, offset + 4) : Buffer.alloc(4);
        if (masked) offset += 4;
        if (buffer.length < offset + size) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + size));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) { socket.end(); return; }
        if (opcode === 1 || opcode === 2) this.request(JSON.parse(payload.toString('utf8')));
      }
    });
    socket.on('error', () => {});
  }
  send(value) { if (this.socket && !this.socket.destroyed) this.socket.write(frame(JSON.stringify(value))); }
  ok(request, data) { this.send({status: 'ok', retcode: 0, data, echo: request.echo}); }
  /** The event-batch file: events go out at once, stamped with the current time. */
  inject(events) {
    for (const event of events) {
      event.time ??= Date.now() / 1000;
      if (event.message_type === 'private') this.history.push(event);
      this.send(event);
    }
  }
  request(request) {
    const action = request.action, params = request.params ?? {};
    this.actions.push(action); this.calls.push({action, params});
    let data;
    switch (action) {
      case 'set_input_status': this.typing.push(params); data = {}; break;
      case 'get_group_root_files': data = this.groupFiles['/']; break;
      case 'get_group_files_by_folder': {
        const folder = this.groupFiles[params.folder_id];
        if (!folder) { this.failed(request, 'folder not found'); return; }
        data = folder; break;
      }
      case 'get_group_file_url': case 'get_private_file_url': {
        const url = this.fileURLs[params.file_id];
        if (url === undefined) { this.failed(request, 'file not found'); return; }
        data = {url}; break;
      }
      case 'get_flash_file_url': data = {url: this.fileURLs[params.fileset_id] ?? ''}; break;
      case 'fetch_ptt_text':
        if (this.pttText === undefined) { this.failed(request, 'no text'); return; }
        data = {text: this.pttText}; break;
      case 'get_record': {
        const record = this.records[params.file];
        if (!record || (params.out_format && !record[params.out_format])) { this.failed(request, '语音转码失败'); return; }
        data = {file: params.file, url: record.url ?? '', file_size: '100', file_name: params.file};
        if (params.out_format) Object.assign(data, {out_format: params.out_format, base64: record[params.out_format]});
        break;
      }
      case 'get_forward_msg': {
        const nodes = this.forwards[params.id ?? params.message_id];
        if (!nodes) { this.failed(request, 'forward not found'); return; }
        data = {messages: nodes}; break;
      }
      case 'send_group_forward_msg': case 'send_private_forward_msg':
        this.forwardPayloads.push({action, params});
        data = {message_id: 98, res_id: 'res-sent', forward_id: 'res-sent'}; break;
      case 'get_group_member_list': data = this.memberList; break;
      case 'set_group_card': this.cards.push(params); data = null; break;
      case 'get_group_honor_info':
        data = this.honor ?? {group_id: Number(params.group_id), current_talkative: null, talkative_list: [], performer_list: [], legend_list: [], emotion_list: [], strong_newbie_list: []};
        break;
      case 'get_login_info': data = {user_id: 12345}; break;
      case 'get_status': data = {online: true, good: true}; break;
      case 'get_friend_list': data = [{user_id: 54321, nickname: 'fixture'}]; break;
      case 'get_group_list':
        data = this.isGroup ? [{group_id: 99999, group_name: 'fixture group'}] : [];
        if (this.shape === 'groupParticipation') data.push({group_id: 88888, group_name: 'second group'});
        break;
      case 'get_friend_msg_history': {
        if (params.count >= 20) {
          if (params.message_seq !== undefined) {
            const anchor = this.history.findIndex(row => String(row.message_id) === params.message_seq);
            data = {messages: anchor < 0 ? [] : this.history.slice(Math.max(0, anchor - params.count + 1), anchor + 1)};
          } else data = {messages: this.history.slice(-20)};
        } else data = {messages: []};
        break;
      }
      case 'get_group_member_info': {
        const member = String(params.user_id), group = String(params.group_id);
        if (member === '12345') data = {user_id: 12345, shut_up_timestamp: Math.trunc(Date.now() / 1000) + 600, ...(this.selfCard !== undefined ? {card: this.selfCard} : {})};
        else if (member === '77777' && group === '70005') data = {user_id: 77777, group_id: 70005, role: 'member'};
        else { this.send({status: 'failed', retcode: 200, data: null, message: 'not a member', echo: request.echo}); return; }
        break;
      }
      case 'group_poke': case 'friend_poke': case 'send_poke': data = null; break;
      case 'set_msg_emoji_like': this.reactions.push(params); data = null; break;
      case 'set_group_add_request': this.approvals.push(params); data = null; break;
      case 'get_group_info': data = {group_id: Number(params.group_id), group_name: 'invited group'}; break;
      case 'get_msg':
        if (this.messages[String(params.message_id)]) { data = this.messages[String(params.message_id)]; break; }
        data = {message_id: -12, message_type: 'group', group_id: 99999, sender: {user_id: 12345}, message: [{type: 'text', data: {text: 'synthetic quoted text'}}]}; break;
      case 'send_private_msg': case 'send_group_msg':
        this.payloads.push(params);
        if (this.dropSend) { this.socket.destroy(); return; }
        if (this.rejectSend) { this.send({status: 'failed', retcode: 1200, data: null, message: 'muted', wording: '禁言中', echo: request.echo}); return; }
        data = {message_id: 99};
        break;
      default:
        // The Python fixture raised an AssertionError here, which ended the connection.
        this.unexpected.push(action); this.socket.destroy(); return;
    }
    this.ok(request, data);
  }
  /** Each payload's message segments, as "type:text-or-id" (QQAgentTests' Rig.payloads). */
  segments() {
    return this.payloads.map(payload => (payload.message ?? []).map(segment => (segment.type ?? '') + ':' + (segment.data?.text ?? (segment.data?.id !== undefined ? String(segment.data.id) : ''))));
  }
  async stop() {
    this.socket?.destroy();
    await new Promise(resolve => this.server.close(resolve));
  }
}

/**
 * A scripted model behind a fetch-compatible session (AgentModelProtocol and friends): `respond(purpose, messages,
 * body)` returns the assistant message, or a {hold: true} marker to keep the request open until `release()`.
 * Every call is kept with its purpose and input text.
 */
export class ModelScript {
  constructor(respond = () => ({content: '{"action":"silence"}'})) {
    this.respond = respond; this.calls = []; this.held = []; this.cancelled = 0; this.helperDelay = 0;
    this.session = (url, init = {}) => this.handle(url, init);
  }
  handle(url, init) {
    const body = init.body == null ? '' : Buffer.isBuffer(init.body) ? init.body.toString('utf8') : String(init.body);
    let object = {};
    try { object = JSON.parse(body); } catch {}
    const purpose = object?.metadata?.dafeiyu_purpose ?? 'chat';
    const messages = Array.isArray(object.messages) ? object.messages : [];
    const input = messages.slice(1).map(message => typeof message.content === 'string' ? message.content : '').filter(Boolean).join('\n');
    const call = {purpose, input, body, url: String(url)};
    this.calls.push(call);
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      const answer = () => {
        if (signal?.aborted) return;
        let message;
        try { message = this.respond(purpose, messages, body, call); } catch (error) { reject(error); return; }
        if (message?.hold) { this.held.push({call, resolve: value => resolve(ModelScript.response(value)), reject}); return; }
        resolve(ModelScript.response(message));
      };
      signal?.addEventListener('abort', () => { this.cancelled += 1; reject(Object.assign(new Error('aborted'), {name: 'AbortError'})); }, {once: true});
      const delay = purpose === 'director' ? 0 : this.helperDelay;
      if (delay > 0) setTimeout(answer, delay * 1000); else queueMicrotask(answer);
    });
  }
  static response(message) {
    const raw = message?.raw;
    const body = raw ?? JSON.stringify({choices: [{message, finish_reason: message.tool_calls === undefined ? 'stop' : 'tool_calls'}], usage: {total_tokens: 10}});
    return new Response(body, {status: 200, headers: {'Content-Type': 'application/json'}});
  }
  /** Answers every held request with `message(call)`. */
  release(message) {
    const held = this.held; this.held = [];
    for (const item of held) item.resolve(message(item.call));
  }
}

/** One tool call as the scripted model's reply. */
export const call = (name, args) => ({content: '', tool_calls: [{id: 'call-' + crypto.randomUUID(), type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
/** The tool results the model has seen so far in this turn, and the turn's first input. */
export const results = messages => messages.filter(message => message.role === 'tool').map(message => message.content).filter(content => typeof content === 'string');
export const opening = messages => typeof messages[1]?.content === 'string' ? messages[1].content : '';

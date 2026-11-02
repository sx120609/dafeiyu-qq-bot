// Port of OneBotConnection.swift.
// One local, authenticated connection. A broken connection cancels all outstanding actions;
// sends are never retried because a missing acknowledgement is an unknown outcome.
import {AppFailure, uuid, prefix} from './swift.mjs';
import {LinuxOneBotTransport, CancellationError} from './LinuxOneBotTransport.mjs';

/// NapCat answered and refused the action (muted, removed from the group, risk control…), so nothing was
/// sent. Unlike a timeout or a dropped connection, the outcome is known.
export class OneBotRejection extends Error {
  constructor({retcode, detail}) {
    super(`QQ 拒绝了这次操作（返回码 ${retcode}${detail ? '：' + detail : ''}）`);
    this.name = 'OneBotRejection'; this.retcode = retcode; this.detail = detail;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class OneBotConnection {
  constructor() {
    this.socket = undefined;
    /** echo -> {resolve, reject} */
    this.pending = new Map();
    /** echo -> timer */
    this.deadlines = new Map();
    this.event = undefined;
    this.disconnected = undefined;
  }

  async connect(endpoint, token) {
    this.close();
    let url;
    try { url = new URL(endpoint); } catch { url = undefined; }
    if (!url || !token) throw new AppFailure('请先配置 OneBot 令牌');
    const socket = new LinuxOneBotTransport();
    this.socket = socket;
    // The receiver: every message in order, then the end of the stream.
    socket.onMessage = data => {
      if (this.socket !== socket) return;
      this.receive(data);
    };
    socket.onEnd = error => {
      if (this.socket !== socket) return;
      this.close(error); this.disconnected?.(error);
    };
    try { await socket.connect(endpoint, token); }
    catch (error) { if (this.socket === socket) this.close(error); throw error; }
    if (this.socket !== socket) { socket.close(); throw new CancellationError(); }
  }

  receive(data) {
    const object = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    if (!isObject(object)) return;
    const echo = typeof object.echo === 'string' ? object.echo : undefined;
    const continuation = echo === undefined ? undefined : this.pending.get(echo);
    if (continuation) {
      this.pending.delete(echo);
      clearTimeout(this.deadlines.get(echo)); this.deadlines.delete(echo);
      if (object.status === 'ok' && object.retcode === 0) {
        // Lists and objects retain their original shape inside the data field.
        continuation.resolve(object);
      } else {
        const wording = typeof object.wording === 'string' && object.wording ? object.wording : undefined;
        const detail = wording ?? (typeof object.message === 'string' ? object.message : '');
        continuation.reject(new OneBotRejection({retcode: Number.isInteger(object.retcode) ? object.retcode : -1, detail: prefix(detail, 120)}));
      }
    } else this.event?.(object);
  }

  /** `signal` stands for the calling task's cancellation (withTaskCancellationHandler). */
  action(name, params = {}, {signal} = {}) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new AppFailure('QQ 未连接'));
    if (signal?.aborted) return Promise.reject(new CancellationError());
    const echo = uuid();
    const data = Buffer.from(JSON.stringify({action: name, params, echo}));
    return new Promise((resolve, reject) => {
      this.pending.set(echo, {resolve, reject});
      const timer = setTimeout(() => this.fail(echo, new AppFailure('OneBot 响应超时；如已提交发送，结果未知且不重发')), 15_000);
      this.deadlines.set(echo, timer);
      if (signal) {
        const abort = () => this.fail(echo, new CancellationError());
        signal.addEventListener('abort', abort, {once: true});
        const done = () => signal.removeEventListener('abort', abort);
        this.pending.set(echo, {resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); }});
      }
      socket.send(data, error => { if (error) this.fail(echo, error); });
    });
  }

  fail(echo, error) {
    clearTimeout(this.deadlines.get(echo)); this.deadlines.delete(echo);
    const continuation = this.pending.get(echo); this.pending.delete(echo);
    continuation?.reject(error);
  }

  close(error) {
    // The socket is let go first, so its own end is not taken for a dropped connection.
    const socket = this.socket; this.socket = undefined;
    socket?.close();
    const callbacks = [...this.pending.values()]; this.pending.clear();
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    for (const callback of callbacks) callback.reject(error ?? new AppFailure('QQ 连接已关闭；未确认的发送不重试'));
  }
}

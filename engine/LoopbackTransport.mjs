// Port of LoopbackTransport.swift over node:net.
// The desktop and WSL panels share this bounded, IPv4-loopback-only transport.
// HTTP parsing, authentication and actions stay in QQControlServer.
import net from 'node:net';
import {AppFailure} from './swift.mjs';

export class LoopbackListener {
  /**
   * Swift binds in init and knows its port at once; node:net binds asynchronously, so the listener is made with
   * `await LoopbackListener.create()`. Connections that arrive before `start` wait (as they would in the kernel's
   * backlog) and are handed over when it starts.
   */
  static async create() {
    const listener = new LoopbackListener();
    await new Promise((resolve, reject) => {
      const server = net.createServer({allowHalfOpen: true});
      server.maxConnections = 32;
      server.once('error', () => reject(new AppFailure('本机控制端口绑定失败')));
      server.listen({host: '127.0.0.1', port: 0, backlog: 32}, () => {
        server.removeAllListeners('error');
        server.on('error', () => {});
        const address = server.address();
        if (!address || typeof address !== 'object') { server.close(); reject(new AppFailure('无法读取本机端口')); return; }
        listener.server = server; listener.port = address.port;
        server.on('connection', socket => listener.accept(socket));
        resolve();
      });
    });
    return listener;
  }
  constructor() { this.server = undefined; this.port = 0; this.accepted = undefined; this.waiting = []; this.stopped = false; this.slots = 32; }
  accept(socket) {
    if (this.stopped) { socket.destroy(); return; }
    // Bounded: at most 32 clients hold a slot at once; the rest are closed.
    if (this.slots <= 0) { socket.destroy(); return; }
    this.slots -= 1;
    const connection = new LoopbackConnection(socket, () => { this.slots += 1; });
    if (this.accepted) this.accepted(connection);
    else this.waiting.push(connection);
  }
  start(accepted) {
    if (this.accepted || this.stopped) return;
    this.accepted = accepted;
    const waiting = this.waiting; this.waiting = [];
    for (const connection of waiting) accepted(connection);
  }
  stop() {
    if (this.stopped) return; this.stopped = true;
    for (const connection of this.waiting) connection.cancel();
    this.waiting = [];
    this.server?.close();
  }
}

export class LoopbackConnection {
  constructor(socket, release) {
    this.socket = socket; this.released = false; this.cancelled = false;
    this.release = () => { if (!this.released) { this.released = true; release(); } };
    this.chunks = []; this.ended = false; this.error = undefined; this.reader = undefined;
    // SO_RCVTIMEO / SO_SNDTIMEO of 15 seconds.
    socket.setTimeout(15_000, () => { this.error ??= new Error("timeout"); this.flush(); });
    socket.on('data', data => { this.chunks.push(data); this.flush(); });
    socket.on('end', () => { this.ended = true; this.flush(); });
    socket.on('error', error => { this.error ??= error; this.flush(); });
    socket.on('close', () => { this.ended = true; this.flush(); this.release(); });
  }
  /** One read: whatever arrived (up to 64 KiB), or the end of the stream. completion(data, ended, error) */
  read(completion) {
    this.reader = completion;
    this.flush();
  }
  flush() {
    const reader = this.reader;
    if (!reader) return;
    if (this.chunks.length) {
      let data = Buffer.concat(this.chunks); this.chunks = [];
      if (data.length > 65536) { this.chunks = [data.subarray(65536)]; data = data.subarray(0, 65536); }
      this.reader = undefined; reader(data, false, undefined); return;
    }
    if (this.error) { this.reader = undefined; reader(undefined, true, this.error); return; }
    if (this.ended) { this.reader = undefined; reader(undefined, true, undefined); }
  }
  send(data, completion) {
    if (this.socket.destroyed || !this.socket.writable) { completion(); return; }
    this.socket.write(data, () => completion());
  }
  cancel() {
    if (this.cancelled) return; this.cancelled = true;
    this.socket.end();
    this.socket.destroySoon?.();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

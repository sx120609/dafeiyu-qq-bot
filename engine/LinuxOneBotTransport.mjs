// Port of LinuxOneBotTransport.swift: one OneBot WebSocket connection over Node's global WebSocket.
// Owns one connection, its bounded inbound stream and its lifetime.
import {URLError, CancellationError} from './BoundedDownload.mjs';

export {URLError, CancellationError};

const maxFrameSize = 1_048_576;

export class LinuxOneBotTransport {
  constructor() {
    this.socket = undefined;
    this.waiter = undefined;
    this.timeout = undefined;
    this.closed = false;
    // The Swift stream buffered the oldest 32 messages; here every message is delivered as it arrives (the consumer
    // is synchronous), so nothing queues. `onMessage` / `onEnd` stand for the stream's elements and its end.
    this.onMessage = undefined;
    this.onEnd = undefined;
    this.ended = undefined;
  }

  connect(url, token) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new CancellationError()); return; }
      this.waiter = {resolve, reject};
      this.timeout = setTimeout(() => this.close(new URLError('timedOut')), 10_000);
      let socket;
      try {
        socket = new WebSocket(url, {headers: {Authorization: 'Bearer ' + token}});
      } catch (error) { this.close(error); return; }
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (this.closed) { try { socket.close(); } catch {} return; }
        this.socket = socket; clearTimeout(this.timeout); this.timeout = undefined;
        const waiter = this.waiter; this.waiter = undefined; waiter?.resolve();
      };
      socket.onmessage = event => {
        const data = typeof event.data === 'string' ? Buffer.from(event.data) : Buffer.from(event.data);
        // maxFrameSize / maxAccumulatedFrameSize of 1 MiB in the Swift client.
        if (data.length > maxFrameSize) { this.close(new URLError('dataLengthExceedsMaximum')); return; }
        this.deliver(data);
      };
      socket.onerror = () => {};
      // Refused before the handshake finished (no listener, a wrong token): NIO's connect failure, as URLSession names it.
      socket.onclose = () => this.close(new URLError(this.socket ? 'networkConnectionLost' : 'cannotConnectToHost'));
      this.pendingSocket = socket;
    });
  }

  deliver(data) {
    if (this.closed) return;
    try { this.onMessage?.(data); }
    catch (error) { this.finish(error); }
  }

  finish(error) {
    if (this.ended) return;
    this.ended = error;
    this.onEnd?.(error);
  }

  send(data, completion) {
    const socket = this.socket;
    if (!socket || this.closed || socket.readyState !== WebSocket.OPEN) { completion(new URLError('networkConnectionLost')); return; }
    // WebSocketKit sends Data as a binary frame; the same frames go out here.
    try { socket.send(typeof data === 'string' ? Buffer.from(data) : data); queueMicrotask(() => completion(undefined)); }
    catch (error) { queueMicrotask(() => completion(error)); }
  }

  close(error = new CancellationError()) {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.timeout); this.timeout = undefined;
    const waiter = this.waiter; this.waiter = undefined; waiter?.reject(error);
    this.finish(error);
    const socket = this.socket ?? this.pendingSocket;
    if (socket) { try { socket.onclose = null; socket.onmessage = null; socket.close(); } catch {} }
    this.socket = undefined; this.pendingSocket = undefined;
  }
}

// Port of BoundedDownload.swift (the Linux receiver), plus the small URLSession surface the engine relies on.
//
// A "session" is a fetch-compatible function `(url, init) => Promise<Response>`; tests inject their own in place of
// a URLProtocol stub. `defaultSession` sends plain-http (the loopback gateway) through node:http, because Node's
// fetch gives up after 300 s waiting for headers and gateway calls may run up to 900 s (or a day for super mode);
// everything else goes through the global fetch.
//
// A "request" mirrors URLRequest: {url, method = 'GET', headers = {}, body, timeoutInterval = 60, resourceTimeout,
// signal}. timeoutInterval is URLSession's idle timeout (restarted by every received chunk); resourceTimeout bounds
// the whole transfer like URLSessionConfiguration.timeoutIntervalForResource; signal stands in for Task
// cancellation and turns into CancellationError.
import http from 'node:http';
import {Readable} from 'node:stream';
import {sleep} from './swift.mjs';

export class CancellationError extends Error {
  constructor(cause) { super('cancelled'); this.name = 'CancellationError'; if (cause !== undefined) this.cause = cause; }
}

const urlErrorText = {
  cancelled: 'cancelled', badURL: 'unsupported URL', timedOut: 'The request timed out.',
  cannotFindHost: 'A server with the specified hostname could not be found.',
  cannotConnectToHost: 'Could not connect to the server.', networkConnectionLost: 'The network connection was lost.',
  dataLengthExceedsMaximum: 'The requested resource exceeds the maximum allowed size.',
  badServerResponse: 'The server returned an invalid response.', notConnectedToInternet: 'The Internet connection appears to be offline.',
  secureConnectionFailed: 'An SSL error has occurred and a secure connection to the server cannot be made.',
  unknown: 'The operation couldn’t be completed.'
};
/** Foundation's URLError; `code` is the URLError.Code case name (`URLError.timedOut === 'timedOut'`). */
export class URLError extends Error {
  constructor(code, cause) {
    super(urlErrorText[code] ?? urlErrorText.unknown); this.name = 'URLError'; this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
for (const code of Object.keys(urlErrorText)) URLError[code] = code;

/** `error is CancellationError || (error as? URLError)?.code == .cancelled` */
export const isCancellation = error => error instanceof CancellationError || (error instanceof URLError && error.code === URLError.cancelled);
/** Task.checkCancellation() */
export const checkCancellation = signal => { if (signal?.aborted) throw new CancellationError(signal.reason); };

const networkCodes = {
  ECONNREFUSED: 'cannotConnectToHost', ENOTFOUND: 'cannotFindHost', EAI_AGAIN: 'cannotFindHost',
  ECONNRESET: 'networkConnectionLost', EPIPE: 'networkConnectionLost', ECONNABORTED: 'networkConnectionLost',
  UND_ERR_SOCKET: 'networkConnectionLost', UND_ERR_CLOSED: 'networkConnectionLost',
  ETIMEDOUT: 'timedOut', UND_ERR_CONNECT_TIMEOUT: 'timedOut', UND_ERR_HEADERS_TIMEOUT: 'timedOut', UND_ERR_BODY_TIMEOUT: 'timedOut',
  ENETUNREACH: 'notConnectedToInternet', EHOSTUNREACH: 'cannotConnectToHost'
};
/** Maps a fetch / node:http failure to the URLError URLSession would have raised. */
export function toURLError(error) {
  if (error instanceof URLError || error instanceof CancellationError) return error;
  if (error?.name === 'TimeoutError') return new URLError(URLError.timedOut, error);
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
    const code = networkCodes[cause.code];
    if (code) return new URLError(code, error);
    if (/certificate|SSL|TLS/i.test(String(cause.code ?? ''))) return new URLError(URLError.secureConnectionFailed, error);
  }
  if (error?.name === 'AbortError') return new URLError(URLError.cancelled, error);
  if (error instanceof TypeError && /invalid url|url/i.test(error.message) && !error.cause) return new URLError(URLError.badURL, error);
  return new URLError(URLError.unknown, error);
}

/** The HTTPURLResponse fields the engine reads. expectedContentLength is -1 when the length is unknown. */
export class HTTPURLResponse {
  constructor({url, statusCode, headers}) {
    this.url = url; this.statusCode = statusCode; this.headers = headers ?? new Headers();
    const length = this.headers.get('content-length');
    this.expectedContentLength = length != null && /^\d+$/.test(length.trim()) ? Number(length) : -1;
  }
  value(field) { return this.headers.get(field) ?? undefined; }
}

const noBody = new Set([101, 204, 205, 304]);
/** fetch for https, node:http for http (no 300 s header cap; redirects are never followed there). */
export function defaultSession(url, init = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:') return fetch(url, init);
  return new Promise((resolve, reject) => {
    const headers = {...(init.headers ?? {})};
    const body = init.body == null ? undefined : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
    if (body) headers['Content-Length'] = String(body.length);
    const req = http.request(target, {method: init.method ?? 'GET', headers, signal: init.signal}, res => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item != null) responseHeaders.append(key, String(item));
      }
      const status = res.statusCode ?? 0;
      const stream = noBody.has(status) ? null : Readable.toWeb(res);
      if (!stream) res.resume();
      try { resolve(new Response(stream, {status: status < 200 || status > 599 ? 502 : status, headers: responseHeaders})); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function transfer(session, request, {limit, redirect}) {
  if (request.signal?.aborted) throw new CancellationError(request.signal.reason);
  const controller = new AbortController();
  let timedOut = false, timer, resourceTimer;
  const idle = Math.max(0, Number(request.timeoutInterval ?? 60)) * 1000;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, idle); };
  if (request.resourceTimeout != null) resourceTimer = setTimeout(() => { timedOut = true; controller.abort(); }, request.resourceTimeout * 1000);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const failure = error => {
    if (request.signal?.aborted) return new CancellationError(request.signal.reason);
    if (timedOut) return new URLError(URLError.timedOut, error);
    return toURLError(error);
  };
  arm();
  let reader;
  try {
    let response;
    try {
      response = await session(String(request.url), {method: request.method ?? (request.body == null ? 'GET' : 'POST'),
        headers: request.headers ?? {}, body: request.body ?? undefined, redirect, signal});
    } catch (error) { throw failure(error); }
    arm();
    const http = new HTTPURLResponse({url: String(request.url), statusCode: response.status, headers: response.headers});
    if (limit != null && http.expectedContentLength > limit) {
      response.body?.cancel().catch(() => {});
      throw new URLError(URLError.dataLengthExceedsMaximum);
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        let next;
        try { next = await reader.read(); } catch (error) { throw failure(error); }
        if (next.done) break;
        arm();
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        if (limit != null && chunk.length > limit - size) {
          reader.cancel().catch(() => {});
          throw new URLError(URLError.dataLengthExceedsMaximum);
        }
        chunks.push(chunk); size += chunk.length;
      }
    }
    if (request.signal?.aborted) throw new CancellationError(request.signal.reason);
    return {data: Buffer.concat(chunks, size), response: http};
  } finally {
    clearTimeout(timer); clearTimeout(resourceTimer);
  }
}

/** URLSession.boundedData(for:limit:) — bytes are bounded while receiving, and redirects are refused (the redirect
 *  response itself is returned, as when the delegate answers completionHandler(nil)). Returns {data, response}. */
export const boundedData = (session, request, limit) => transfer(session ?? defaultSession, request, {limit, redirect: 'manual'});

/** URLSession.data(for:) — follows redirects, no size bound. Returns {data, response}. */
export const sessionData = (session, request) => transfer(session ?? defaultSession, request, {limit: undefined, redirect: 'follow'});

/** Task.sleep: a cancelled wait throws CancellationError. */
export const taskSleep = (ms, signal) => sleep(ms, signal).catch(reason => { throw new CancellationError(reason); });

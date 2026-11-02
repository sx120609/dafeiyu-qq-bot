// Self-repair reports: when the engine hits a bug in its own code (a TypeError, a ReferenceError, a failed
// assertion), it tells the local gateway at {DAFEIYU_CODEX_URL}/repair/report so the fault can be looked at and
// fixed, instead of the bot quietly making up a reason (11-03). The agent can report what it sees going wrong too
// (the report_bug tool). Outages are not bugs: network errors, QQ refusing something, the model's 429 or 5xx and
// cancellations are never reported. Fire and forget, at most once per fault every ten minutes.
import {CancellationError} from './BoundedDownload.mjs';
import {prefix} from './swift.mjs';

const bugTypes = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];
const networkCodes = /^(?:E(?:CONN(?:RESET|REFUSED|ABORTED)|TIMEDOUT|PIPE|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH)|UND_ERR_\w+|ABORT_ERR)$/;

export class QQRepair {
  /// The gateway key (the same Bearer key as every other gateway call); set by the engine with its credentials.
  static key = '';
  static windowMs = 10 * 60_000;
  static sent = new Map();
  /// The gateway's address and the transport, replaceable in tests.
  static base = () => process.env.DAFEIYU_CODEX_URL;
  static post = (url, init) => fetch(url, init);

  /** Whether an error is a fault in the program rather than something outside it failing. */
  static isBug(error) {
    if (!(error instanceof Error) || error instanceof CancellationError || error.name === 'AbortError') return false;
    if (error.name === 'AssertionError' || error.code === 'ERR_ASSERTION') return true;
    if (!bugTypes.some(type => error instanceof type)) return false;
    // fetch() reports a dropped connection as "TypeError: fetch failed"; parsing a peer's bad JSON is the peer's.
    const cause = error.cause;
    if (/fetch failed|network|terminated|socket/i.test(error.message) || (cause && networkCodes.test(String(cause.code ?? '')))) return false;
    if (networkCodes.test(String(error.code ?? ''))) return false;
    if (error instanceof SyntaxError && /JSON|Unexpected (?:token|end|non-whitespace)/.test(error.message)) return false;
    return true;
  }

  /** Where in our code it happened: the first stack frame inside engine/ or bridge/. */
  static place(stack) {
    const line = String(stack ?? '').split('\n').find(row => /[\\/](?:engine|bridge)[\\/]/.test(row));
    const match = line?.match(/[\\/]((?:engine|bridge)[\\/][^:)]+):(\d+)/);
    return match ? match[1].replaceAll('\\', '/') + ':' + match[2] : '';
  }

  /** A program error from inside the engine; anything that is not a bug is ignored. */
  static capture(error, {kind = 'exception', tool, chatKey, turnId} = {}) {
    if (!QQRepair.isBug(error)) return 'ignored';
    return QQRepair.send({kind, message: `${error.name}: ${error.message}`, stack: String(error.stack ?? ''), context: {tool, chatKey, turnId}});
  }

  /** The agent's own report of something misbehaving. */
  static agent(description, {tool, chatKey, turnId} = {}) {
    return QQRepair.send({kind: 'agent', message: description, stack: '', context: {tool, chatKey, turnId}}, description);
  }

  /** Posts one report unless the same fault was reported within the window. Never throws, never waits.
   *  Returns 'sent', 'duplicate' or 'unavailable' (no local gateway or key). */
  static send({kind, message, stack, context}, signatureText) {
    const base = QQRepair.base();
    let url;
    try { url = base === undefined ? undefined : new URL(base.replace(/\/+$/, '') + '/repair/report'); } catch {}
    if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || QQRepair.key === '') return 'unavailable';
    // The same fault in another chat or turn is the same fault: numbers in the message do not count.
    const signature = kind + '|' + String(signatureText ?? message).replace(/\d+/g, '#').slice(0, 300) + '|' + QQRepair.place(stack);
    const now = Date.now();
    for (const [seen, at] of QQRepair.sent) if (now - at >= QQRepair.windowMs) QQRepair.sent.delete(seen);
    if (QQRepair.sent.has(signature)) return 'duplicate';
    QQRepair.sent.set(signature, now);
    const clean = Object.fromEntries(Object.entries(context ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    const body = JSON.stringify({source: 'engine', kind, message: prefix(String(message ?? ''), 2000), stack: prefix(String(stack ?? ''), 8000), context: clean});
    try {
      Promise.resolve(QQRepair.post(url.href, {method: 'POST', headers: {Authorization: 'Bearer ' + QQRepair.key, 'Content-Type': 'application/json'},
        body, signal: AbortSignal.timeout(10_000)})).catch(() => {});
    } catch {}
    return 'sent';
  }
}

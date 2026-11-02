// Port of upstream/Tests/QQEngineTests/BoundedDownloadTests.swift.
// Real sockets rather than a stubbed session: cancellation and response-size limits must hold on the wire, without
// contacting any external service. Each mode runs through both default transports (node:http for plain http, and
// the global fetch used for https).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {CancellationError, URLError, boundedData, defaultSession} from '../engine/BoundedDownload.mjs';

// The Swift fixture is Python's http.server (HTTP/1.0: the connection closes after each response).
function fixture() {
  const server = net.createServer(socket => {
    let head = '';
    socket.on('data', chunk => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const mode = head.split(' ')[1].slice(1);
      const respond = () => {
        if (socket.destroyed) return;
        let response = `HTTP/1.0 ${mode === 'redirect' ? '302 Found' : '200 OK'}\r\n`;
        if (mode === 'redirect') response += 'Location: /unexpected\r\n';
        if (mode === 'length') response += 'Content-Length: 5000\r\n';
        response += '\r\n' + (mode === 'stream' ? 'x'.repeat(5000) : 'hello');
        socket.end(response, 'latin1');
      };
      if (mode === 'cancel') setTimeout(respond, 5000).unref(); else respond();
    });
    socket.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

for (const [transport, session] of [['node:http', defaultSession], ['fetch', (url, init) => fetch(url, init)]]) {
  for (const mode of ['normal', 'length', 'stream', 'cancel', 'redirect']) {
    test(`actualHTTPDownloadBoundaries(${mode}) via ${transport}`, async () => {
      const server = await fixture();
      try {
        const controller = new AbortController();
        const request = {url: `http://127.0.0.1:${server.address().port}/${mode}`, timeoutInterval: 3, signal: controller.signal};
        const download = boundedData(session, request, 64);
        if (mode === 'cancel') setTimeout(() => controller.abort(), 100);
        try {
          const {data, response} = await download;
          assert.ok(['normal', 'redirect'].includes(mode));
          assert.deepEqual(data, Buffer.from('hello'));
          assert.equal(response.statusCode, mode === 'redirect' ? 302 : 200);
        } catch (error) {
          if (mode === 'cancel') {
            assert.ok(error instanceof CancellationError || (error instanceof URLError && error.code === URLError.cancelled), String(error));
          } else {
            assert.ok(['length', 'stream'].includes(mode), String(error));
            assert.equal(error.code, URLError.dataLengthExceedsMaximum);
          }
        }
      } finally {
        server.close();
      }
    });
  }
}

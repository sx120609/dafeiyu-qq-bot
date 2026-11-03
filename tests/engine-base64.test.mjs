import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {crc32, deflateSync} from 'node:zlib';
import {decodeBase64} from '../engine/foundation.mjs';
import {QQImageCredentials, QQImageGenerator} from '../engine/QQImageGenerator.mjs';
import {QQImageGenerationConfig} from '../engine/core/QQImageGenerationConfig.mjs';

test('base64 decodes image-sized payloads with every padding length', () => {
  for (const size of [7_999_998, 7_999_999, 8_000_000]) {
    const bytes = Buffer.alloc(size, 0xfb);
    assert.deepEqual(decodeBase64(bytes.toString('base64')), bytes);
  }
});

test('base64 preserves strict alphabet, length and padding validation', () => {
  for (const [encoded, decoded] of [['', ''], ['Zg==', 'f'], ['Zm8=', 'fo'], ['Zm9v', 'foo']]) {
    assert.deepEqual(decodeBase64(encoded), Buffer.from(decoded));
  }
  for (const invalid of [undefined, null, 42, {}, 'Zg', 'Zg=', 'Zg===', 'Zm9v=', '=m9v', 'Z=g=',
    'Zg==AAAA', 'AAAA====', 'Zm-v', 'Zm_v', 'Zm v', 'Zm9v\n', 'Zm9v\r\n', 'Zm9v\u0100',
    'AAA\n', 'AA=\n', 'AA\r\n', 'AAA\r', 'AAA\u2028', 'AAA\u2029']) {
    assert.equal(decodeBase64(invalid), undefined, String(invalid));
  }
  const large = Buffer.alloc(4_000_000).toString('base64');
  assert.equal(decodeBase64(large.slice(0, -4) + '!AAA'), undefined);
});

function largePNG() {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024, 0); header.writeUInt32BE(1024, 4); header[8] = 8; header[9] = 6;
  const pixels = randomBytes(1024 * (1 + 1024 * 4));
  for (let row = 0; row < 1024; row++) pixels[row * (1 + 1024 * 4)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('gateway image generation accepts a valid multi-megabyte PNG', async t => {
  const previous = process.env.DAFEIYU_CODEX_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DAFEIYU_CODEX_URL;
    else process.env.DAFEIYU_CODEX_URL = previous;
  });
  process.env.DAFEIYU_CODEX_URL = 'http://127.0.0.1:9/v1';
  const image = largePNG();
  assert.ok(image.length > 4_000_000 && image.length < 8_000_000);
  let requests = 0, attempts = 0;
  const session = async url => {
    assert.equal(url, 'http://127.0.0.1:9/v1/images/generations');
    requests++;
    return new Response(JSON.stringify({data: [{b64_json: image.toString('base64')}]}));
  };
  const settings = new QQImageGenerationConfig();
  settings.enabled = true; settings.primary = 'codex'; settings.fallbackEnabled = false;
  const result = await new QQImageGenerator({session}).execute({arguments: '{"prompt":"colorful abstract painting"}',
    settings, credentials: new QQImageCredentials({codexToken: 'synthetic-image-token'}),
    beforeAttempt: async () => { attempts++; }});
  assert.ok(Buffer.isBuffer(result.image), result.content);
  assert.deepEqual(result.image, image);
  assert.match(result.imageStatus, /生成成功/);
  assert.equal(attempts, 1); assert.equal(requests, 1);
});

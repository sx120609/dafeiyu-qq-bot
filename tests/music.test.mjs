// Songs from the GPU server for compose_music (bridge/music.mjs): the script goes up once, the job and the MP3 come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {composeMusic} from '../bridge/music.mjs';

test('a song is made on the GPU server and its MP3 read back; the server says why when it cannot', async () => {
  const calls = [], mp3 = Buffer.alloc(4000, 7);
  let answer = JSON.stringify({file: '/home/u/dafeiyu-music/out/abc.mp3', seconds: 30, took: 33});
  const run = async (config, command, {input, binary} = {}) => {
    calls.push({command, input});
    if (command.includes('cat > ~/dafeiyu-music/compose.py')) return {code: 0, out: '', err: ''};
    if (command.includes('compose.py 2>>')) return {code: 0, out: 'loading\n' + answer + '\n', err: ''};
    if (command.startsWith('cat ')) return {code: 0, out: binary ? mp3 : '', err: ''};
    throw new Error('unexpected ' + command);
  };
  const song = await composeMusic({prompt: '海边夏天的流行歌', lyrics: '[Chorus]\n游呀游', seconds: 999}, {musicHost: 'gpu5090'}, {run});
  assert.deepEqual(song.audio, mp3); assert.equal(song.seconds, 30);
  assert.match(calls[0].input, /MiniMax Music 3/, 'the script goes up first');
  const job = JSON.parse(calls[1].input);
  assert.equal(job.duration, 300, 'at most five minutes'); assert.equal(job.lyrics, '[Chorus]\n游呀游'); assert.equal(job.prompt, '海边夏天的流行歌');
  assert.match(calls[2].command, /rm -f '\/home\/u\/dafeiyu-music\/out\/abc.mp3'/, 'the server copy is deleted');
  // The same script is not sent again.
  await composeMusic({prompt: 'x', seconds: 20}, {}, {run});
  assert.equal(calls.filter(call => call.command.includes('cat > ~/dafeiyu-music')).length, 1);
  answer = JSON.stringify({error: '5090 的显存正被别的任务占着'});
  await assert.rejects(composeMusic({prompt: 'x'}, {}, {run}), e => e.status === 503 && /显存/.test(e.message));
  answer = JSON.stringify({file: '/tmp/../etc/passwd; rm -rf ~', seconds: 1});
  await assert.rejects(composeMusic({prompt: 'x'}, {}, {run}), /文件名不对/);
  await assert.rejects(composeMusic({prompt: ''}, {}, {run}), /1–4000/);
});

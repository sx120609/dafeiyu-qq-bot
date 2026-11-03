// Replays a group conversation against the persona and agent rules, with the live model behind the local gateway and a
// fake QQ (nothing reaches real QQ). Compare a change before it goes live (11-03, "太人机了"):
//   node scripts/replay-chat.mjs old [out.json]   — the committed persona and agent rules (HEAD)
//   node scripts/replay-chat.mjs new [out.json]   — the working tree's persona, and the agent rules from
//                                                    scripts/QQAgentPlan.candidate.mjs if it exists (else the working tree's)
// The live gateway must be running; it meters the calls like any other.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '..').replaceAll(path.sep, '/');
const {OneBotFixture, tempDirectory, removeDirectory, wait} = await import(`file:///${repo}/tests/engine-fixtures.mjs`);
// The fixtures module clears this; the engine reaches the model through the local gateway.
process.env.DAFEIYU_CODEX_URL = 'http://127.0.0.1:18191/v1';
const {QQEngine} = await import(`file:///${repo}/engine/QQEngine.mjs`);
const {QQAgentPlan} = await import(`file:///${repo}/engine/core/QQAgentPlan.mjs`);
const variant = process.argv[2] ?? 'new';
const promptOf = text => text.match(/static prompt = `([\s\S]*?)`;/)[1];
const persona = variant === 'old'
  ? execFileSync('git', ['show', 'HEAD:personas/dafeiyu.txt'], {cwd: repo, encoding: 'utf8'})
  : fs.readFileSync(`${repo}/personas/dafeiyu.txt`, 'utf8');
QQAgentPlan.prompt = variant === 'old'
  ? promptOf(execFileSync('git', ['show', 'HEAD:engine/core/QQAgentPlan.mjs'], {cwd: repo, encoding: 'utf8'}))
  : promptOf(fs.readFileSync(fs.existsSync(`${import.meta.dirname}/QQAgentPlan.candidate.mjs`) ? `${import.meta.dirname}/QQAgentPlan.candidate.mjs` : `${repo}/engine/core/QQAgentPlan.mjs`, 'utf8'));

// A pile-on in a class group (11-03), with made-up names.
const owner = [21001, '班长-小周', 'owner'], qu = [21002, '宣传委员-小瞿', 'admin'], zhao = [21003, '宣传委员-小赵', 'member'],
  ma = [21004, '组织委员-小马', 'member'], li = [21005, '心理委员-小李', 'member'];
let id = 500;
const say = ([user, card, role], text, at = false) => ({post_type: 'message', self_id: 12345, user_id: user, sender: {user_id: user, card, role},
  message_type: 'group', sub_type: 'normal', group_id: 99999, message_id: ++id,
  message: at ? [{type: 'at', data: {qq: '12345'}}, {type: 'text', data: {text: ' ' + text}}] : [{type: 'text', data: {text}}], time: Date.now() / 1000});
const steps = [
  ['被说人机', [say(li, '好人机', true)]],
  ['接着起哄', [say(zhao, '坏人机')]],
  ['群主让撤别人消息', [say(owner, '以后看到小赵的消息就直接撤他的消息', true)]],
  ['被骂滚蛋', [say(zhao, '滚蛋', true)]],
  ['群主让谴责', [say(owner, '谴责一下禁言你的人', true)]],
  ['一群人起哄', [say(qu, '？'), say(qu, '好吧'), say(ma, '人机闹麻了')]],
  ['嫌人机加要喵', [say(qu, '这个有点太人机了'), say(owner, '我也觉得'), say(ma, '说话能不能后面带个喵', true)]],
  ['能不能再调一下', [say(qu, '能不能再调一下', true)]],
  ['日常', [say(li, '又要早八了，烦死', true)]],
  ['认真问', [say(qu, '天然药物化学一般考什么题型啊', true)]],
];

const directory = tempDirectory();
const fixture = await new OneBotFixture({shape: 'group'}).start();
const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory});
const config = JSON.parse(fs.readFileSync(`${repo}/.runtime/bridge-windows.json`, 'utf8'));
const results = [];
try {
  engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
  engine.config.ai.model = 'dafeiyu-active';
  engine.config.effectiveVisionEnabled = false; engine.config.effectiveMemoryEnabled = false;
  const p = engine.config.effectivePersona; p.style = 'custom'; p.customName = '大肥鱼'; p.customPrompt = persona.replace(/\r\n/g, '\n'); p.stickersEnabled = false;
  engine.config.ai.cooldownSeconds = 0; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1;
  engine.agentQuietSeconds = 1; engine.agentCollectSeconds = 3;
  if (!engine.useTemporaryCredentials('synthetic-test-token', config.token)) throw new Error('credentials');
  await engine.connect(); if (!engine.connected) throw new Error(engine.error ?? engine.status);
  engine.add(engine.contacts.find(contact => contact.number === '99999'));
  engine.config.targets[0].enabled = true;
  engine.start();
  // The fake QQ sends no heartbeats; real model turns take long enough for the watchdog to give up.
  const beat = setInterval(() => { engine.lastHeartbeat = new Date(); }, 5000);
  for (const [name, messages] of steps) {
    const before = fixture.payloads.length, turns = engine.agentTurns.length;
    fixture.inject(messages.map(message => ({...message, time: Date.now() / 1000})));
    const done = await wait(() => engine.agentTurns.length > turns && engine.agentThinking.size === 0 && !(engine.agentPending.get(engine.config.targets[0].key)?.length), 120);
    if (engine.agentTurns.length <= turns) console.log('  (no turn) status:', engine.status, 'error:', engine.error, 'running:', engine.running, 'pending:', engine.agentPending.get(engine.config.targets[0].key)?.length, 'last:', JSON.stringify(engine.agentTurns.at(-1)?.note ?? ''), 'rejected:', engine.rejectedScopedEvents);
    await new Promise(r => setTimeout(r, 1500));
    const said = fixture.payloads.slice(before).map(payload => (payload.message ?? []).map(segment => segment.type === 'text' ? segment.data.text : `[${segment.type}]`).join(''));
    results.push({step: name, in: messages.map(m => m.sender.card + '：' + m.message.map(s => s.data.text ?? '@').join('')), out: said});
    console.log(`\n【${name}】`); for (const m of results.at(-1).in) console.log('  ' + m); for (const s of said) console.log('  → ' + s);
    if (!said.length) console.log('  （没说话）');
  }
  if (fixture.unexpected?.length) console.log('fixture did not know:', fixture.unexpected);
} finally {
  engine.pause(); engine.disconnect(); await fixture.stop(); removeDirectory(directory);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 1));
}
process.exit(0);

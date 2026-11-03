// Port of LinuxMain.swift: the headless engine. Prints QQ_CONTROL_URL=... once the control page is ready;
// `--qq-check <endpoint> <account>` (token on stdin) only verifies the QQ login and exits.
// Not ported: the --social-panel / --xiaohongshu-panel mode.
import fs from 'node:fs';
import readline from 'node:readline';
import {HotReload} from './HotReload.mjs';

// The engine's code reloads in place (HotReload.mjs): registered before anything else is imported, so every module
// is known to it. This file and HotReload.mjs are loaded once.
const hot = new HotReload({dirs: [import.meta.dirname], fixed: [import.meta.filename, `${import.meta.dirname}/HotReload.mjs`]});
const {AppFailure} = await import('./swift.mjs');
const {isDictionary} = await import('./foundation.mjs');
const {OneBotConnection} = await import('./OneBotConnection.mjs');
const {QQEngine, describe} = await import('./QQEngine.mjs');
const {QQControlServer} = await import('./QQControlServer.mjs');
const {QQConfig, QQPolicy} = await import('./core/QQPolicy.mjs');

process.umask?.(0o077);

/** readLine(): the first line of standard input, or undefined at its end. */
function readLine() {
  return new Promise(resolve => {
    const lines = readline.createInterface({input: process.stdin});
    let done = false;
    lines.once('line', line => { done = true; lines.close(); resolve(line); });
    lines.once('close', () => { if (!done) resolve(undefined); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--qq-check');
  if (index >= 0) {
    if (index + 2 >= args.length) throw new AppFailure('用法：--qq-check 本机端点 预期账号；令牌由标准输入提供');
    const config = new QQConfig();
    config.endpoint = args[index + 1];
    config.expectedSelfID = args[index + 2];
    config.validate();
    const connection = new OneBotConnection();
    try {
      await connection.connect(config.endpoint, (await readLine()) ?? '');
      const [a, b] = await Promise.all([connection.action('get_login_info'), connection.action('get_status')]);
      if (!(isDictionary(a.data) && QQPolicy.identifier(a.data.user_id) === config.expectedSelfID &&
        isDictionary(b.data) && b.data.online === true && b.data.good === true)) {
        throw new AppFailure('QQ 账号或在线状态未通过核对');
      }
      console.log('QQ 账号与在线状态核对成功；未读取聊天或发送消息');
    } finally { connection.close(); }
    return;
  }
  const engine = new QQEngine({allowAuthenticationUI: false});
  if (process.env.DAFEIYU_CODEX_URL !== undefined) {
    engine.config.ai.model = 'dafeiyu-active';
    if (engine.config.loopProtectionEnabled === undefined) engine.config.loopProtectionEnabled = true;
    if (engine.config.visionEnabled === undefined) engine.config.effectiveVisionEnabled = true;
    if (engine.config.memoryEnabled === undefined) engine.config.effectiveMemoryEnabled = true;
    if (engine.config.onlineEnabled === undefined) engine.config.effectiveOnlineEnabled = true;
    const file = process.env.DAFEIYU_CREDENTIALS_FILE;
    if (file !== undefined) {
      const values = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isDictionary(values) || typeof values.token !== 'string' || typeof values.key !== 'string') throw new TypeError('凭证文件格式无效');
      if (!engine.useTemporaryCredentials(values.token, values.key)) throw new AppFailure('本机 Codex 凭证加载失败');
    }
  }
  const server = await QQControlServer.create(engine);
  server.start();
  await hot.snapshot(0);
  globalThis.dafeiyuReload = () => reload(engine, server);
  console.log('Windows / Linux 本机面板：凭证仅保存在内存，退出后需重新填写。');
  // The listener keeps the process alive.
  globalThis.dafeiyuControlServer = server;
}

/** Loads the engine's current code and moves the running engine onto it, without dropping the QQ connection or any
 *  chat's state. Only between turns: while a chat is thinking it answers {busy: true} and the caller tries again. */
let reloading = false;
async function reload(engine, server) {
  if (reloading) return {busy: true};
  if (engine.agentThinking.size > 0 || engine.workers.size > 0 || engine.busy || engine.runtimeBusy) return {busy: true};
  reloading = true;
  try {
    const from = hot.generation, started = Date.now();
    await hot.next(hot.files());
    // Objects made by any earlier generation (old code still finishing a job) move to the new one too.
    const map = new Map();
    for (let generation = 0; generation <= from; generation++) for (const [old, fresh] of await hot.classes(generation, hot.generation)) map.set(old, fresh);
    const moved = HotReload.adopt([engine, server], map);
    console.log(`热加载：引擎代码第 ${hot.generation} 版，${moved} 个对象换上新代码，用了 ${Date.now() - started} 毫秒`);
    return {generation: hot.generation, moved};
  } finally { reloading = false; }
}

main().catch(error => { console.log(`启动失败：${describe(error)}`); process.exit(1); });

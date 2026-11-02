// Port of LinuxMain.swift: the headless engine. Prints QQ_CONTROL_URL=... once the control page is ready;
// `--qq-check <endpoint> <account>` (token on stdin) only verifies the QQ login and exits.
// Not ported: the --social-panel / --xiaohongshu-panel mode.
import fs from 'node:fs';
import readline from 'node:readline';
import {AppFailure} from './swift.mjs';
import {isDictionary} from './foundation.mjs';
import {OneBotConnection} from './OneBotConnection.mjs';
import {QQEngine, describe} from './QQEngine.mjs';
import {QQControlServer} from './QQControlServer.mjs';
import {QQConfig, QQPolicy} from './core/QQPolicy.mjs';

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
  console.log('Windows / Linux 本机面板：凭证仅保存在内存，退出后需重新填写。');
  // The listener keeps the process alive.
  globalThis.dafeiyuControlServer = server;
}

main().catch(error => { console.log(`启动失败：${describe(error)}`); process.exit(1); });

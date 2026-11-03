// Opens every console page of a preview gateway in headless Chrome at phone sizes, shows the parts the preview keeps
// hidden (self-repair card, hot reload button), and lists everything that runs past the screen or its card.
// Start a preview first (node scripts/console-preview.mjs 18295 --sample-usage prints its address and token), then:
//   node scripts/console-mobile-audit.mjs http://127.0.0.1:18295 <token> <screenshot dir>
// Needs Chrome at its default Windows path. It sets the preview's own console password; the live console is not touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const [base, token, out] = process.argv.slice(2);
fs.mkdirSync(out, {recursive: true});
// A browser session for the preview: first-time password setup with the preview's own token.
const setup = await fetch(base + '/console/api/auth/setup', {method: 'POST', headers: {Authorization: 'Bearer ' + token, Origin: base, 'Content-Type': 'application/json'},
  body: JSON.stringify({password: 'preview-only-pass'})});
let cookie = setup.headers.get('set-cookie');
if (!cookie) { const login = await fetch(base + '/console/api/auth/login', {method: 'POST', headers: {Origin: base, 'Content-Type': 'application/json'}, body: JSON.stringify({password: 'preview-only-pass'})}); cookie = login.headers.get('set-cookie'); }
const [name, value] = cookie.split(';')[0].split('=');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-chrome-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], {stdio: 'ignore'});
let target;
for (let i = 0; i < 50 && !target; i++) { await new Promise(r => setTimeout(r, 200)); try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(t => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, {once: true}));
let seq = 0; const waiting = new Map();
ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } });
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({id, method, params})); });
const evaluate = async expression => (await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})).result?.result?.value;
await send('Network.enable');
await send('Network.setCookie', {name, value, url: base});
await send('Emulation.setUserAgentOverride', {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
const pages = ['overview', 'activity', 'usage', 'chats', 'persona', 'abilities', 'tools', 'rhythm', 'model', 'moderation', 'qq', 'settings'];
const audit = `(() => {
  // Parts the preview hides because its APIs are not there: shown with sample text, as on the live console.
  const show = (id, text) => { const el = document.getElementById(id); if (el) { el.hidden = false; if (text !== undefined) el.textContent = text; } };
  show('repairs-card'); show('repairs-badge', '共 4 次'); show('reload-now'); show('reload-status', '热加载：网关第 7 版 · 11/3 15:43 · 引擎第 4 版 · 11/3 15:52');
  const width = document.documentElement.clientWidth, found = [];
  const scrolls = el => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
  for (const el of document.querySelectorAll('.page.active *, .topbar *, .page:not([hidden]) *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    const card = el.closest('.card'), edge = card ? card.getBoundingClientRect().right : width;
    if ((r.right > width + 1 || r.right > edge + 1) && !scrolls(el)) found.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' ' + (el.textContent || '').trim().slice(0, 30) + ' (' + Math.round(r.right) + '>' + Math.round(Math.min(width, edge)) + ')');
  }
  return {width, scrollWidth: document.documentElement.scrollWidth, found: [...new Set(found)].slice(0, 25)};
})()`;
let problems = 0;
for (const width of [360, 390, 430]) {
  await send('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 2, mobile: true});
  for (const page of pages) {
    await send('Page.navigate', {url: `${base}/console/#${page}`});
    await new Promise(r => setTimeout(r, 2500));
    const result = await evaluate(audit);
    if (result?.found?.length || result?.scrollWidth > result?.width) { problems++; console.log(`${width} ${page}: page ${result.scrollWidth}/${result.width}`, result.found); }
    if (width === 390) {
      const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
      fs.writeFileSync(path.join(out, `${page}-${width}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }
}
console.log(problems ? `${problems} page(s) with overflow` : 'no overflow on any page at 360/390/430');
ws.close(); chrome.kill(); setTimeout(() => { try { fs.rmSync(profile, {recursive: true, force: true}); } catch {} process.exit(0); }, 500);

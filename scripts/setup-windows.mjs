// Prepares a Windows machine to run the bot: writes .runtime/bridge-windows.json (gateway settings with new random
// tokens; an existing file keeps its tokens), .runtime/snowluma.json (where SnowLuma is and the bot's QQ number) and
// SnowLuma's OneBot settings for that account. Prints what it found and what is still missing; prints no tokens.
// Usage: node scripts/setup-windows.mjs <bot QQ number> [SnowLuma folder]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const runtime=path.join(root,'.runtime');
const account=process.argv[2]||'';
const snowluma=process.argv[3]||'D:\\Dev\\Projects\\SnowLuma';
if(!/^[1-9]\d{4,11}$/.test(account)){console.error('用法：node scripts/setup-windows.mjs <机器人QQ号> [SnowLuma 目录]');process.exit(1);}
fs.mkdirSync(path.join(runtime,'requests'),{recursive:true});

const where=name=>{try{return execFileSync('where.exe',[name],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split(/\r?\n/).find(Boolean)||'';}catch{return '';}};
const first=(...candidates)=>candidates.find(file=>file&&fs.existsSync(file))||'';
const appData=process.env.APPDATA||'';
const found={
  node:process.execPath,
  codex:first(path.join(root,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),
    path.join(appData,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe')),
  claude:first(path.join(appData,'npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe'),where('claude.exe')),
  ffmpeg:first(process.env.DAFEIYU_FFMPEG,'D:\\Dev\\Tools\\ffmpeg\\bin\\ffmpeg.exe',where('ffmpeg.exe')),
  python:where('python.exe'),
  pdftotext:where('pdftotext.exe')
};

const file=path.join(runtime,'bridge-windows.json');
let config={};try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
const token=()=>crypto.randomBytes(32).toString('base64url');
config={port:18191,snowlumaProxyPort:18192,...config,
  token:config.token||token(),consoleToken:config.consoleToken||token(),
  node:found.node,windowsNode:found.node,codex:found.codex||config.codex||'',imageCodex:config.imageCodex||found.codex||'',
  claude:found.claude||config.claude||'',ffmpeg:found.ffmpeg||config.ffmpeg||'',
  tempRoot:path.join(runtime,'requests'),generatedImagesRoot:config.generatedImagesRoot||'D:\\Dev\\Outputs\\CodexGeneratedImages'};
fs.writeFileSync(file,JSON.stringify(config,null,2),{mode:0o600});

const lumaFile=path.join(runtime,'snowluma.json');
let luma={};try{luma=JSON.parse(fs.readFileSync(lumaFile,'utf8'));}catch{}
fs.writeFileSync(lumaFile,JSON.stringify({...luma,dir:snowluma,account},null,2),{mode:0o600});

// SnowLuma: OneBot only for the bot's account, on loopback; nothing for any other account; automatic loading off.
const lumaConfig=path.join(snowluma,'config');
if(fs.existsSync(snowluma)){
  fs.mkdirSync(lumaConfig,{recursive:true});
  const accountFile=path.join(lumaConfig,`onebot_${account}.json`);
  let accessToken;try{accessToken=JSON.parse(fs.readFileSync(accountFile,'utf8')).networks.wsServers[0].accessToken;}catch{accessToken=token();}
  const common={enabled:true,host:'127.0.0.1',path:'/',accessToken,messageFormat:'array',reportSelfMessage:true};
  fs.writeFileSync(accountFile,JSON.stringify({networks:{httpServers:[{name:'dafeiyu-http',port:3000,...common}],httpClients:[],
    wsServers:[{name:'dafeiyu-local',port:3001,role:'Universal',...common}],wsClients:[]}},null,2));
  const global=path.join(lumaConfig,'onebot.json');
  if(!fs.existsSync(global))fs.writeFileSync(global,JSON.stringify({networks:{httpServers:[],httpClients:[],wsServers:[],wsClients:[]}},null,2));
  const runtimeFile=path.join(lumaConfig,'runtime.json');
  let lumaRuntime={};try{lumaRuntime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));}catch{}
  fs.writeFileSync(runtimeFile,JSON.stringify({...lumaRuntime,webuiPort:5099,hookAutoLoad:false},null,2));
}

console.log('写好了：.runtime/bridge-windows.json、.runtime/snowluma.json'+(fs.existsSync(snowluma)?'、SnowLuma 的 OneBot 设置':''));
for(const [name,value] of Object.entries(found))console.log(`  ${name.padEnd(9)} ${value||'没找到'}`);
const missing=[!fs.existsSync(snowluma)&&`SnowLuma（解压到 ${snowluma} 后再运行一次）`,!found.codex&&'Codex CLI（npm install 后再运行一次）',
  !found.ffmpeg&&'ffmpeg（看 B 站视频、视频截帧要用）',!found.python&&'Python 3 + Pillow（处理图片要用）',!found.pdftotext&&'Poppler 的 pdftotext（读 PDF 要用）'].filter(Boolean);
console.log(missing.length?'还缺：\n  '+missing.join('\n  '):'都齐了。');

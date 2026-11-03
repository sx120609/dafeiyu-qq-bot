// A second console gateway for UI work: same engine and NapCat, separate runtime copy and password.
// Usage: node scripts/console-preview.mjs [port] [--sample-usage] [--sample-qq]. Prints the first-time setup URL.
// Read-only pages are safe; runtime buttons on it still act on the real engine.
// The default port stays clear of the live gateway (18191) and, on Windows, its SnowLuma proxy (18192).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Settings,createGateway} from '../bridge/gateway.mjs';
import {ConsoleAuth} from '../bridge/auth.mjs';
import {UsageLedger} from '../bridge/usage.mjs';
const root=path.resolve(import.meta.dirname,'..');
const port=Number(/^\d+$/.test(process.argv[2]||'')?process.argv[2]:18291);
const runtime=path.join(root,'.runtime','console-preview');
await fs.rm(runtime,{recursive:true,force:true});await fs.mkdir(runtime,{recursive:true});
// The engine's control address and the supervisor's status change on every restart: link, don't copy.
const live=new Set(['control-url.txt','status.json']);
for(const name of await fs.readdir(path.join(root,'.runtime')))
  if(live.has(name)){
    // Windows refuses symlinks without Developer Mode: copy instead, and copy again every few seconds.
    const from=path.join(root,'.runtime',name),to=path.join(runtime,name);
    try{await fs.symlink(from,to);}
    catch(error){
      if(error.code!=='EPERM')throw error;
      await fs.copyFile(from,to);setInterval(()=>fs.copyFile(from,to).catch(()=>{}),3000).unref();
    }
  }
  else if(/\.(json|txt)$/.test(name)&&name!=='console-auth.json')await fs.copyFile(path.join(root,'.runtime',name),path.join(runtime,name));
// Its own console token, so the real one never appears in a preview URL.
// On Windows the gateway reads bridge-windows.json (Start.ps1); elsewhere bridge.json.
const configName=process.platform==='win32'&&await fs.stat(path.join(runtime,'bridge-windows.json')).then(()=>true,()=>false)?'bridge-windows.json':'bridge.json';
const config={...JSON.parse(await fs.readFile(path.join(runtime,configName),'utf8')),port,consoleToken:crypto.randomBytes(32).toString('base64url')};
const settings=await new Settings(path.join(runtime,'providers.json')).load();
const auth=await new ConsoleAuth({runtime,secret:config.consoleToken}).load();
const usage=await new UsageLedger({runtime}).load();
// --sample-usage fills the preview's own ledger with made-up calls so the usage page has something to draw.
if(process.argv.includes('--sample-usage')){
  const chats=['群·药大拾间','群·摸鱼小分队','好友·小王','好友·阿青','群·考研互助'];
  for(let day=29;day>=0;day--)for(let i=0;i<8+((day*7)%13);i++){
    const at=Date.now()-day*86400_000-i*600_000,claude=i%3!==0;
    usage.record({provider:claude?'claude':'codex',model:claude?'opus':'gpt-5.5',purpose:['chat','chat','chat','memory','outreach','poke'][i%6],chat:chats[(i+day)%chats.length],
      ms:3000+(i*997)%9000,at,ok:i%17!==5,usage:{prompt_tokens:4000+(i*1301)%9000,cached_tokens:claude?2000:1500,completion_tokens:200+(i*211)%900,...(claude?{cost_usd:0.02+(i%5)*0.011}:{})}});
  }
}
// --sample-qq shows the Windows QQ page (SnowLuma state bar) with a made-up, read-only status; nothing is started or saved.
const host=process.argv.includes('--sample-qq')?{
  luma:null,qqStatus:async()=>({running:true,account:'10001',embed:'',process:{pid:1234,injected:true,loggedIn:true}}),
  saveSettings:async()=>{throw new Error('预览里不能保存');},qqCall:async()=>{throw new Error('预览里不能操作 QQ');},
  panelCall:async()=>{throw new Error('预览里不能操作 QQ');},restart:async()=>{throw new Error('预览里不能重启');}
}:null;
const server=createGateway(config,settings,{runtime,auth,usage,host});
server.listen(port,'127.0.0.1',()=>console.log(`Console preview: http://127.0.0.1:${port}/console/#${config.consoleToken}`));

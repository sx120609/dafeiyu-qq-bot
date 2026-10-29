// A second console gateway for UI work: same engine and NapCat, separate runtime copy and password.
// Usage (WSL): node scripts/console-preview.mjs [port]. Prints the first-time setup URL.
// Read-only pages are safe; runtime buttons on it still act on the real engine.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Settings,createGateway} from '../bridge/gateway.mjs';
import {ConsoleAuth} from '../bridge/auth.mjs';
import {UsageLedger} from '../bridge/usage.mjs';
const root=path.resolve(import.meta.dirname,'..');
const port=Number(process.argv[2]||18192);
const runtime=path.join(root,'.runtime','console-preview');
await fs.rm(runtime,{recursive:true,force:true});await fs.mkdir(runtime,{recursive:true});
// The engine's control address and the supervisor's status change on every restart: link, don't copy.
const live=new Set(['control-url.txt','status.json']);
for(const name of await fs.readdir(path.join(root,'.runtime')))
  if(live.has(name))await fs.symlink(path.join(root,'.runtime',name),path.join(runtime,name));
  else if(/\.(json|txt)$/.test(name)&&name!=='console-auth.json')await fs.copyFile(path.join(root,'.runtime',name),path.join(runtime,name));
// Its own console token, so the real one never appears in a preview URL.
const config={...JSON.parse(await fs.readFile(path.join(runtime,'bridge.json'),'utf8')),port,consoleToken:crypto.randomBytes(32).toString('base64url')};
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
const server=createGateway(config,settings,{runtime,auth,usage});
server.listen(port,'127.0.0.1',()=>console.log(`Console preview: http://127.0.0.1:${port}/console/#${config.consoleToken}`));

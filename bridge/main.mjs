import fs from 'node:fs/promises';
import path from 'node:path';
import {createWriteStream,mkdirSync,statSync,renameSync} from 'node:fs';
import {format} from 'node:util';
import {startGateway} from './gateway.mjs';
// Started hidden by the tray launcher on Windows: no console, so its output goes to .runtime/logs/gateway.log.
if(process.platform==='win32'&&!process.stdout.isTTY){
  const dir=path.join(import.meta.dirname,'..','.runtime','logs'),file=path.join(dir,'gateway.log');
  mkdirSync(dir,{recursive:true});
  try{if(statSync(file).size>20_000_000)renameSync(file,file+'.1');}catch{}
  const log=createWriteStream(file,{flags:'a'});
  const write=(...args)=>log.write(new Date().toISOString()+' '+format(...args)+'\n');
  console.log=console.info=console.warn=console.error=write;
  process.on('uncaughtException',error=>{write('uncaught',error);log.end(()=>process.exit(1));});
}
// Windows keeps its own config (Windows paths) beside the WSL one, so both can exist during the move off WSL.
const file=process.env.DAFEIYU_BRIDGE_CONFIG||path.join(import.meta.dirname,'..','.runtime',process.platform==='win32'?'bridge-windows.json':'bridge.json');
const config=JSON.parse(await fs.readFile(file,'utf8'));
if(!config.token||config.token.length<32)throw new Error('Missing private adapter token');
if(config.ffmpeg&&!process.env.DAFEIYU_FFMPEG)process.env.DAFEIYU_FFMPEG=config.ffmpeg;
await fs.mkdir(config.tempRoot,{recursive:true,mode:0o700});
// The tray launcher and scripts/Stop.ps1 find this process by its pid.
if(process.platform==='win32')await fs.writeFile(path.join(path.dirname(file),'host.pid'),String(process.pid));
await startGateway(config,file);

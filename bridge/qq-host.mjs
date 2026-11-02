// Runs the bot on Windows without WSL (11-03: "其实我不想用任何wsl了""wsl太占性能了"). Replaces systemd and
// scripts/supervisor.py: keeps SnowLuma and the engine running, hooks only the bot account's QQ, connects the
// engine once that account is signed in, and restores the owner's last reply choice (replying or paused)
// after a restart. Never sends QQ messages or changes the reply scope.
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readJSON=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return fallback;}};
const writeJSON=async(file,value)=>{const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);};
async function post(url,body,headers={},timeout=15000){
  const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={};}
  if(!response.ok){const error=new Error(data.message||data.error||'HTTP '+response.status);error.status=response.status;throw error;}
  return data;
}

async function isNode(pid){
  if(process.platform!=='win32'){try{return (await fs.readFile(`/proc/${pid}/comm`,'utf8')).trim()==='node';}catch{return false;}}
  return new Promise(resolve=>{
    const child=spawn('tasklist.exe',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'],{windowsHide:true});let out='';
    child.stdout.on('data',d=>out+=d);child.on('error',()=>resolve(false));
    child.on('exit',()=>resolve(/^"node\.exe"/i.test(out.trim())));
  });
}

/** Ends every process whose command line runs from `dir` (SnowLuma's node.exe, and the cmd.exe window of
 *  start-dafeiyu.cmd), each with its children. Nothing outside that folder is touched. */
async function endProcessesUnder(dir){
  const script=`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${dir.toLowerCase().replaceAll("'","''")}') -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`;
  const pids=await new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true});let out='';
    child.stdout.on('data',d=>out+=d);child.on('error',()=>resolve([]));
    child.on('exit',()=>resolve(out.split(/\s+/).map(Number).filter(n=>n>0)));
  });
  for(const pid of pids)await new Promise(resolve=>{const child=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});child.on('exit',resolve);child.on('error',resolve);});
  if(pids.length)await wait(1500);
}

/** A log file next to the others, started over once it passes 20 MB. */
async function logStream(file){
  try{if((await fs.stat(file)).size>20_000_000)await fs.rename(file,file+'.1');}catch{}
  return createWriteStream(file,{flags:'a'});
}

/** SnowLuma on the same computer: OneBot for the bot account only, WebUI on 127.0.0.1:5099.
 *  Its automatic loading (every QQ.exe) stays off because the owner's own QQ runs here too;
 *  the hook goes into the process signed in as the bot account and no other. */
export class SnowLuma{
  // onPassword(password): keeps a password the bot set for SnowLuma (QQHost writes it to .runtime/snowluma.json).
  constructor({settings,logs,onPassword}){this.settings=settings;this.logs=logs;this.onPassword=onPassword;this.session=null;this.child=null;this.startedAt=null;}
  get dir(){return this.settings.dir;}
  get webui(){return 'http://127.0.0.1:'+(this.settings.webuiPort||5099);}
  async onebot(){
    const config=await readJSON(path.join(this.dir,'config',`onebot_${this.settings.account}.json`),null);
    const server=config?.networks?.wsServers?.find(x=>x.enabled!==false);
    const http=config?.networks?.httpServers?.find(x=>x.enabled!==false);
    if(!server||!server.accessToken)throw new Error('SnowLuma 里没有机器人账号的 OneBot 设置');
    return {token:server.accessToken,ws:'ws://127.0.0.1:'+server.port,http:http?'http://127.0.0.1:'+http.port:null};
  }
  async reachable(){try{await post(this.webui+'/api/auth/state',undefined,{},3000);return true;}catch(error){return error.status>0;}}
  /** Starts SnowLuma unless it is already running (started by hand or left over from before). */
  async ensure(){
    if(this.child&&this.child.exitCode===null)return;
    if(await this.reachable())return;
    const log=await logStream(path.join(this.logs,'snowluma.log'));
    this.child=spawn(path.join(this.dir,'node.exe'),['index.mjs'],{cwd:this.dir,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,SNOWLUMA_WEBUI_HOST:'127.0.0.1',SNOWLUMA_HOOK_AUTOLOAD:'0'}});
    this.child.stdout.pipe(log,{end:false});this.child.stderr.pipe(log,{end:false});
    const pidFile=path.join(path.dirname(this.logs),'snowluma.pid');
    await fs.writeFile(pidFile,String(this.child.pid));
    this.child.on('exit',()=>{log.end();fs.rm(pidFile,{force:true}).catch(()=>{});});
    this.startedAt=new Date().toISOString();
    for(let i=0;i<40&&!(await this.reachable());i++)await wait(500);
  }
  async stop(){
    if(this.child&&this.child.exitCode===null){this.child.kill();await new Promise(resolve=>this.child.once('exit',resolve));}
    this.child=null;this.session=null;
    // One started some other way (by hand from start-dafeiyu.cmd, with its console window) is ended too.
    if(process.platform==='win32')await endProcessesUnder(this.dir);
  }
  /** The bot keeps SnowLuma's admin password itself (11-03: the owner did not want to type it, and had pasted
   *  theirs into the chat): a new random one is written into SnowLuma's own store, scrypt with SnowLuma's
   *  parameters (packages/core/src/webui/auth.ts), while SnowLuma is stopped. The console opens SnowLuma's
   *  pages already signed in (snowluma-proxy.mjs), so nobody needs to know it. */
  async takeOverPassword(){
    const file=path.join(this.dir,'config','webui.json');
    const current=await readJSON(file,{});
    const password='Dfy-'+crypto.randomBytes(18).toString('base64url')+'!a';
    const salt=crypto.randomBytes(16);
    const hash=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1});
    await this.stop();
    const now=new Date().toISOString();
    // Two-step verification would lock the bot out, so it goes with the old password.
    await writeJSON(file,{passwordHash:hash.toString('hex'),passwordSalt:salt.toString('hex'),mustChangePassword:false,generatedAt:current.generatedAt||now,updatedAt:now});
    this.settings={...this.settings,password};this.session=null;this.refused=null;
    return password;
  }
  /** A signed-in session for the console's embedded SnowLuma pages. */
  async sessionToken(){if(!this.session)await this.login();return this.session;}
  async attempt(){
    try{return await post(this.webui+'/api/login',{password:this.settings.password});}
    catch(error){if(!(error.status>=400&&error.status<500))throw error;return {success:false,status:error.status,message:error.message};}
  }
  /** Signs in with the bot's own SnowLuma password. Nothing about SnowLuma's login may stop the bot (11-03: "我纯本地
   *  的你限制安全是故意卡我吗"): when the password no longer matches it writes a new one, and when SnowLuma has locked
   *  logins after wrong passwords typed into its page it restarts SnowLuma, which clears the lock (QQ stays signed in).
   *  Repairs at most once every two minutes, so a broken SnowLuma cannot make it loop. */
  async login(){
    if(!this.settings.password)await this.repair('password');
    let result=await this.attempt();
    if(!result.success&&Date.now()-(this.repairedAt||0)>120000){
      await this.repair(result.status===429?'lock':'password');
      result=await this.attempt();
    }
    if(!result.success||!result.token)throw new Error(result.needsTotp?'SnowLuma 开了两步验证：在它的管理页关掉':'SnowLuma 暂时登不进去：'+(result.message||'')+'（两分钟后自动再修一次）');
    this.session=result.token;
  }
  async repair(kind){
    this.repairedAt=Date.now();
    if(kind==='password'){const password=await this.takeOverPassword();await this.onPassword?.(password);}
    else await this.stop();
    await this.ensure();
  }
  async call(route,body){
    for(let attempt=0;;attempt++){
      if(!this.session)await this.login();
      try{return await post(this.webui+route,body,{'x-snowluma-token':this.session});}
      catch(error){if(error.status!==401||attempt)throw error;this.session=null;}
    }
  }
  async processes(){return (await this.call('/api/processes')).list||[];}
  /** The QQ process signed in as the bot account, hooked if it was not yet. Undefined while it is not running. */
  async botProcess(){
    const account=String(this.settings.account);
    const found=(await this.processes()).find(p=>String(p.uin||p.account?.uin||'')===account);
    if(found&&!found.injected&&!['loading','injecting'].includes(found.status)){
      await this.call(`/api/processes/${Number(found.pid)}/load`,{});
      console.log('Loaded SnowLuma into the bot account\'s QQ process.');
    }
    return found;
  }
}

/** The engine process (engine/main.mjs), restarted 5 seconds after it exits, like the systemd unit was. */
export class QQHost{
  constructor({root,runtime,gatewayToken,port=18191,embedPort=18192}){
    this.root=root;this.runtime=runtime;this.gatewayToken=gatewayToken;this.port=port;
    this.logs=path.join(runtime,'logs');this.data=path.join(runtime,'engine');
    this.child=null;this.panel=null;this.stopped=true;this.loop=null;this.luma=null;this.armed=true;this.lastConnect=0;
    this.embed=`http://127.0.0.1:${embedPort}/`;
  }
  async settings(){return readJSON(path.join(this.runtime,'snowluma.json'),{dir:'D:\\Dev\\Projects\\SnowLuma',account:''});}
  async saveSettings(values){
    const current=await this.settings(),next={...current};
    if(typeof values.password==='string'&&values.password)next.password=values.password;
    if(typeof values.account==='string'&&/^[1-9]\d{4,11}$/.test(values.account))next.account=values.account;
    if(typeof values.dir==='string'&&values.dir)next.dir=values.dir;
    await writeJSON(path.join(this.runtime,'snowluma.json'),next);
    if(this.luma){this.luma.settings=next;this.luma.session=null;}
    return this.qqStatus();
  }
  async keepPassword(password){
    const saved=await this.settings();await writeJSON(path.join(this.runtime,'snowluma.json'),{...saved,password});
    console.log('Set a new SnowLuma admin password, kept in .runtime/snowluma.json.');
  }
  lumaFor(settings){return new SnowLuma({settings,logs:this.logs,onPassword:password=>this.keepPassword(password)});}
  async status(update){
    const file=path.join(this.runtime,'status.json');
    const settings=await readJSON(path.join(this.runtime,'providers.json'),null);
    try{update.provider=settings.active;update.model=settings.profiles[settings.active].model;}catch{}
    await writeJSON(file,update);
  }
  async desired(){return (await readJSON(path.join(this.runtime,'desired-running.json'),{})).running===true;}
  async saveDesired(value){await writeJSON(path.join(this.runtime,'desired-running.json'),{running:value});return value;}
  async start(){
    if(!this.stopped)return;
    this.stopped=false;
    await fs.mkdir(this.logs,{recursive:true});await fs.mkdir(this.data,{recursive:true,mode:0o700});
    this.luma=this.lumaFor(await this.settings());
    this.loop=this.run().catch(error=>console.error('QQ host stopped:',error));
  }
  async stop(){
    this.stopped=true;
    if(this.child&&this.child.exitCode===null){this.child.kill();await new Promise(resolve=>this.child.once('exit',resolve));}
    this.child=null;this.panel=null;
    await this.status({engine:false,phase:'stopped'});
  }
  async restart(){await this.stop();await this.start();}
  async run(){
    while(!this.stopped){
      try{await this.once();this.lastFailure=null;}
      // The same reason (a missing setting, say) is logged once, not every five seconds.
      catch(error){if(error.message!==this.lastFailure)console.error('Engine run failed:',error.message);this.lastFailure=error.message;await this.status({engine:false,phase:'needs_attention',error:error.message}).catch(()=>{});}
      if(!this.stopped)await wait(5000);
    }
  }
  async spawnEngine(token){
    // Windows does not end a child with its parent: an engine left by the previous host would keep the
    // state lock and its port, so it is ended first (only if that pid is still a node.exe).
    const pidFile=path.join(this.runtime,'engine.pid');
    const old=Number((await fs.readFile(pidFile,'utf8').catch(()=>'')).trim());
    if(old>0&&old!==process.pid&&await isNode(old)){try{process.kill(old);}catch{}await wait(1500);}
    const credentials=path.join(this.data,'credentials.json');
    await writeJSON(credentials,{token,key:this.gatewayToken});
    const log=await logStream(path.join(this.logs,'engine.log'));
    const child=spawn(process.execPath,[path.join(this.root,'engine','main.mjs')],{cwd:this.root,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,DAFEIYU_CODEX_URL:`http://127.0.0.1:${this.port}/v1`,DAFEIYU_CREDENTIALS_FILE:credentials,DAFEIYU_DATA_DIR:this.data}});
    child.stderr.pipe(log,{end:false});
    child.on('exit',()=>{log.end();fs.rm(pidFile,{force:true}).catch(()=>{});});
    this.child=child;
    await fs.writeFile(pidFile,String(child.pid));
    const lines=readline.createInterface({input:child.stdout});
    const control=await new Promise((resolve,reject)=>{
      child.once('exit',code=>reject(new Error('Engine failed to start ('+code+')')));
      lines.on('line',line=>{
        if(line.startsWith('QQ_CONTROL_URL=')){resolve(line.slice(15).trim());return;}
        log.write(line+'\n');
      });
    });
    await fs.writeFile(path.join(this.runtime,'control-url.txt'),control,{mode:0o600});
    const url=new URL(control);
    this.panel={base:url.origin,token:url.hash.slice(1)};
  }
  async panelCall(action,values={}){
    const headers={'X-QQ-Control':this.panel.token,Origin:this.panel.base};
    const status=await post(this.panel.base+'/api/status',undefined,headers);
    if(!action)return status;
    const result=await post(this.panel.base+'/api/action',{action,configurationRevision:status.configurationRevision,...values},headers,30000);
    if(result.error)throw new Error(result.error);
    return result;
  }
  async once(){
    await this.status({engine:false,phase:'starting'});
    if(!this.luma.settings.account)throw new Error('还没设机器人 QQ 号（控制台 → QQ 登录）');
    if(!this.luma.settings.password)await this.luma.repair('password');
    await this.luma.ensure();
    const onebot=await this.luma.onebot();
    await this.spawnEngine(onebot.token);
    await this.status({engine:true,qqLoggedIn:false,phase:'waiting_for_qq_login',backend:'snowluma'});
    console.log('Engine ready; waiting for QQ login.');
    let desired=await this.desired();
    // Armed = replies have not been seen running since the engine (re)connected, so a stop is
    // not the owner's pause. Only then may the saved "replying" choice be restored.
    this.armed=true;this.lastConnect=0;
    while(!this.stopped&&this.child.exitCode===null){
      try{
        // SnowLuma started by hand and then closed, or crashed: start it again (QQ stays signed in meanwhile).
        await this.luma.ensure();
        let current=await this.panelCall();
        const account=String(this.luma.settings.account),expected=current.config.expectedSelfID;
        const qq=await this.luma.botProcess().catch(error=>({error:error.message}));
        const login=qq&&!qq.error&&qq.injected?await post(onebot.http+'/get_login_info',{},{Authorization:'Bearer '+onebot.token},5000).catch(()=>null):null;
        const signedIn=String(login?.data?.user_id||'')===account;
        if(!current.connected)this.armed=true;
        if(signedIn&&!current.connected&&Date.now()-this.lastConnect>20000){
          this.lastConnect=Date.now();
          // Reconnect only after verifying the persisted expected identity, never silently switch accounts.
          if(expected&&expected!==account)throw new Error('QQ account differs from the saved account');
          if(current.config.endpoint!==onebot.ws||expected!==account)await this.panelCall('saveConnection',{endpoint:onebot.ws,expectedSelfID:account});
          current=await this.panelCall('connect');
          console.log('QQ identity and connection verified.');
        }
        if(current.connected){
          if(current.running){this.armed=false;if(!desired)desired=await this.saveDesired(true);}
          else if(this.armed){
            // A failed or deferred resume stays armed and is retried on the next poll.
            if(!desired)this.armed=false;
            else if(!current.busy){current=await this.panelCall('start',{durationMinutes:0,singleReply:false});this.armed=false;console.log('Replies resumed as before the restart.');}
          }else if(desired)desired=await this.saveDesired(false); // Seen running on this connection and now stopped: the owner paused it.
        }
        await this.status({engine:true,qqLoggedIn:signedIn,backend:'snowluma',qqProcess:qq?.error?{error:qq.error}:qq?{pid:qq.pid,injected:qq.injected,status:qq.status}:null,
          phase:current.connected?'connected':'waiting_for_qq_login',connected:current.connected,running:current.running,desiredRunning:desired,
          contactCount:current.contacts.length,temporaryCredentials:current.temporaryCredentials});
      }catch(error){await this.status({engine:true,phase:'needs_attention',error:error.message,desiredRunning:desired});}
      await wait(5000);
    }
    if(this.child&&this.child.exitCode!==null)throw new Error('Engine exited with code '+this.child.exitCode);
  }
  /** One OneBot action on the bot's account, over SnowLuma's HTTP endpoint (for my_ tools' read-only queries). */
  async qqCall(action,params={}){
    if(!this.luma)throw new Error('QQ 还没连上');
    const onebot=await this.luma.onebot();
    if(!onebot.http)throw new Error('SnowLuma 没开 HTTP 接口');
    const result=await post(onebot.http+'/'+action,params,{Authorization:'Bearer '+onebot.token},60000);
    if(result.retcode!==0&&result.status!=='ok')throw new Error(result.wording||result.message||'QQ 返回 '+result.retcode);
    return result.data;
  }
  /** What the console's QQ page shows: SnowLuma, the bot's QQ process, and whether it is signed in. */
  async qqStatus(){
    const settings=await this.settings(),luma=this.luma||this.lumaFor(settings);
    const result={backend:'snowluma',account:settings.account||'',passwordSet:!!settings.password,webui:luma.webui,dir:settings.dir,
      running:await luma.reachable(),managed:!!(luma.child&&luma.child.exitCode===null),startedAt:luma.startedAt,embed:this.embed};
    if(result.running&&settings.password){
      try{const qq=(await luma.processes()).find(p=>String(p.uin||p.account?.uin||'')===String(settings.account));
        result.process=qq?{pid:qq.pid,injected:qq.injected,loggedIn:qq.loggedIn,status:qq.status,error:qq.error||''}:null;}
      catch(error){result.error=error.message;}
    }
    return result;
  }
  async qq(action){
    if(action==='status')return this.qqStatus();
    if(!this.luma)this.luma=this.lumaFor(await this.settings());
    // Restarting SnowLuma leaves QQ signed in: the hook stays in QQ and is picked up again, no new login.
    if(action==='stop'||action==='restart')await this.luma.stop();
    if(action==='start'||action==='restart')await this.luma.ensure();
    return this.qqStatus();
  }
}

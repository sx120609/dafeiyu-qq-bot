import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SnowLuma,QQHost} from '../bridge/qq-host.mjs';

// A stand-in for SnowLuma's WebUI: two QQ processes, the owner's (signed in as another account) and the bot's.
async function fakeWebui({processes,password='right'}){
  const loads=[];let sessions=0,expireNext=false;
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/api/auth/state')return send(200,{});
    if(req.url==='/api/login'){const ok=JSON.parse(body).password===password;if(ok)sessions++;return send(ok?200:401,ok?{success:true,token:'s'+sessions}:{success:false,message:'密码错误'});}
    if(req.headers['x-snowluma-token']!=='s'+sessions||expireNext){expireNext=false;return send(401,{message:'unauthorized'});}
    if(req.url==='/api/processes')return send(200,{list:processes});
    const load=req.url.match(/^\/api\/processes\/(\d+)\/load$/);
    if(load&&req.method==='POST'){loads.push(Number(load[1]));return send(200,{success:true});}
    send(404,{});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,port:server.address().port,loads,get sessions(){return sessions;},expire(){expireNext=true;}};
}

test('SnowLuma hooks only the bot account\'s QQ, never the owner\'s, and only once',async()=>{
  const processes=[{pid:100,uin:'10002',injected:false,status:'idle'},{pid:200,uin:'',account:{uin:'10001'},injected:false,status:'idle'}];
  const ui=await fakeWebui({processes});
  try{
    const luma=new SnowLuma({settings:{account:'10001',password:'right',webuiPort:ui.port},logs:os.tmpdir()});
    const found=await luma.botProcess();
    assert.equal(found.pid,200);assert.deepEqual(ui.loads,[200]);
    processes[1].injected=true;
    await luma.botProcess();
    assert.deepEqual(ui.loads,[200],'an injected process is not loaded again');
    ui.expire();
    await luma.botProcess();
    assert.equal(ui.sessions,2,'an expired session logs in again once');
    const none=new SnowLuma({settings:{account:'10003',password:'right',webuiPort:ui.port},logs:os.tmpdir()});
    assert.equal(await none.botProcess(),undefined);
    assert.deepEqual(ui.loads,[200],'with the bot account not signed in, nothing is hooked');
  }finally{ui.server.close();}
});

// 11-03 ("我纯本地的你限制安全是故意卡我吗"): no password, a wrong one, or SnowLuma's lockout never stops the bot.
// The fake SnowLuma checks passwords against its webui.json the way SnowLuma does (scrypt) and can be locked.
test('SnowLuma\'s login repairs itself: missing or wrong password, and a lockout',async()=>{
  const crypto=await import('node:crypto');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'snowluma-'));
  await fs.mkdir(path.join(dir,'config'));
  await fs.writeFile(path.join(dir,'config','webui.json'),JSON.stringify({passwordHash:'0'.repeat(128),passwordSalt:'1'.repeat(32),mustChangePassword:true,generatedAt:'2026-11-03T00:00:00Z',updatedAt:'2026-11-03T00:00:00Z'}));
  let locked=false,logins=0;
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/api/auth/state')return send(200,{});
    if(req.url==='/api/login'){
      logins++;
      if(locked){locked=false;return send(429,{success:false,message:'登录尝试过多'});}
      const state=JSON.parse(await fs.readFile(path.join(dir,'config','webui.json'),'utf8'));
      const hash=crypto.scryptSync(JSON.parse(body).password,Buffer.from(state.passwordSalt,'hex'),64,{N:16384,r:8,p:1}).toString('hex');
      return hash===state.passwordHash?send(200,{success:true,token:'s'+logins}):send(401,{success:false,message:'密码错误'});
    }
    send(200,{list:[]});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const kept=[];
    const luma=new SnowLuma({settings:{dir,account:'10001',webuiPort:server.address().port},logs:os.tmpdir(),onPassword:p=>kept.push(p)});
    await luma.login();
    assert.equal(kept.length,1,'no password: the bot sets one and keeps it');assert.ok(luma.session);
    luma.settings.password='typed-by-someone-else';luma.session=null;luma.repairedAt=0;
    await luma.login();
    assert.equal(kept.length,2,'a wrong password is replaced the same way');assert.ok(luma.session);
    locked=true;luma.session=null;luma.repairedAt=0;
    await luma.login();
    assert.equal(kept.length,2,'a lockout restarts SnowLuma instead of touching the password');assert.ok(luma.session);
    luma.settings.password='wrong again';luma.session=null;
    await assert.rejects(luma.login(),/两分钟后自动再修/,'at most one repair every two minutes');
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('QQ settings keep the password write-only and accept only a QQ number',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'qq-host-'));
  try{
    const host=new QQHost({root:runtime,runtime,gatewayToken:'x'.repeat(40)});
    await host.saveSettings({account:'10001',password:'secret',dir:path.join(runtime,'none')});
    const saved=JSON.parse(await fs.readFile(path.join(runtime,'snowluma.json'),'utf8'));
    assert.equal(saved.password,'secret');
    await host.saveSettings({account:'not a number',password:''});
    const kept=JSON.parse(await fs.readFile(path.join(runtime,'snowluma.json'),'utf8'));
    assert.deepEqual([kept.account,kept.password],['10001','secret']);
    const status=await host.qqStatus();
    assert.equal(status.passwordSet,true);assert.equal('password' in status,false);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

test('the bot sets SnowLuma\'s admin password itself, in SnowLuma\'s own format',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'snowluma-'));
  try{
    await fs.mkdir(path.join(dir,'config'));
    await fs.writeFile(path.join(dir,'config','webui.json'),JSON.stringify({passwordHash:'0'.repeat(128),passwordSalt:'1'.repeat(32),mustChangePassword:true,generatedAt:'2026-11-02T17:31:43.998Z',updatedAt:'x',totp:{secret:'s'}}));
    const luma=new SnowLuma({settings:{dir,account:'10001'},logs:os.tmpdir()});
    const password=await luma.takeOverPassword();
    const saved=JSON.parse(await fs.readFile(path.join(dir,'config','webui.json'),'utf8'));
    const crypto=await import('node:crypto');
    const hash=crypto.scryptSync(password,Buffer.from(saved.passwordSalt,'hex'),64,{N:16384,r:8,p:1}).toString('hex');
    assert.equal(saved.passwordHash,hash);
    assert.deepEqual([saved.mustChangePassword,saved.generatedAt,'totp' in saved],[false,'2026-11-02T17:31:43.998Z',false]);
    // SnowLuma's own rules: 10+ characters, lower, upper, a symbol, no spaces.
    assert.ok(password.length>=10&&/[a-z]/.test(password)&&/[A-Z]/.test(password)&&/[^A-Za-z0-9\s]/.test(password)&&!/\s/.test(password));
    assert.equal(luma.settings.password,password);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

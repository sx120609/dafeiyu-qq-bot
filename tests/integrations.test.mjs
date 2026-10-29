import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Settings,createGateway} from '../bridge/gateway.mjs';

test('integrated consoles authenticate once, proxy pages/APIs and relay authenticated WebSockets',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-integrations-test-'));
  let napRequest,botRequest,wsRequest,authCalls=0;
  const nap=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    napRequest={url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/login'){authCalls++;assert.equal(JSON.parse(napRequest.body).hash,crypto.createHash('sha256').update('synthetic-webui-secret.napcat').digest('hex'));res.end(JSON.stringify({code:0,data:{Credential:'synthetic-session-credential'}}));return;}
    if(req.url==='/webui/'){res.setHeader('Content-Type','text/html');res.setHeader('X-Frame-Options','DENY');res.end('<main>NapCat mock</main>');return;}
    res.end(JSON.stringify({code:0,data:{ready:true}}));
  });
  nap.on('upgrade',(req,socket)=>{
    wsRequest=req;
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    socket.end(Buffer.from([0x81,0x02,0x6f,0x6b]));
  });
  const bot=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);botRequest={headers:req.headers,url:req.url,body:Buffer.concat(chunks).toString()};
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; frame-ancestors 'none'");
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<script src="/app.js"></script><link href="/style.css">');return;}
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end("const controlToken = sessionStorage.getItem('qq-control-token') || '';\nhistory.replaceState(null, '', '/');\nfetch('/api/status');");return;}
    res.setHeader('Content-Type','application/json');res.end('{"connected":false,"temporaryCredentials":true}');
  });
  for(const s of [nap,bot])await new Promise(r=>s.listen(0,'127.0.0.1',r));
  const napBase=`http://127.0.0.1:${nap.address().port}`,botBase=`http://127.0.0.1:${bot.address().port}`;
  await fs.writeFile(path.join(temp,'webui.json'),JSON.stringify({token:'synthetic-webui-secret'}));
  await fs.writeFile(path.join(temp,'control-url.txt'),botBase+'/#'+'a'.repeat(72));
  const settings=await new Settings(path.join(temp,'providers.json')).load();
  const gateway=createGateway({token:'model-only',consoleToken:'console-only'},settings,{runtime:temp,integrationConfig:{napcatBase:napBase,napcatConfig:path.join(temp,'webui.json')}});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${gateway.address().port}`;
  const open=async(service,auth='console-only')=>fetch(base+'/console/api/integrations/open',{method:'POST',headers:{Authorization:'Bearer '+auth,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({service})});
  try{
    assert.equal((await fetch(base+'/webui/')).status,401);
    assert.equal((await open('napcat','model-only')).status,401);
    const result=await open('napcat');assert.equal(result.status,200);
    const cookie=result.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    const headers={Cookie:cookie.split(';')[0]};
    assert.equal((await result.json()).url,'/console/integrations/napcat');
    const credential=await (await fetch(base+'/console/integrations/napcat/credential',{headers})).json();assert.equal(credential.credential,'synthetic-session-credential');assert.equal(authCalls,1);
    const page=await fetch(base+'/webui/',{headers});assert.equal(page.status,200);assert.equal(page.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'self'/);
    const action=await fetch(base+'/api/QQLogin/CheckLoginStatus',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json',Authorization:'Bearer stale-client-credential'},body:'{}'});assert.equal(action.status,200);assert.equal(napRequest.headers.authorization,'Bearer synthetic-session-credential');assert.equal(napRequest.headers.cookie,undefined);
    assert.equal((await fetch(base+'/api/QQLogin/CheckLoginStatus',{method:'POST',headers,body:'{}'})).status,401);
    assert.equal((await fetch(base+'/webui/',{headers:{...headers,Origin:'http://127.0.0.1:9999'}})).status,401);
    assert.equal((await fetch(base+'/webui/',{headers:{...headers,'Sec-Fetch-Site':'same-site'}})).status,401);
    const botPage=await fetch(base+'/bot/',{headers});assert.match(await botPage.text(),/src="\/bot\/app.js"/);
    const js=await (await fetch(base+'/bot/app.js',{headers})).text();assert.match(js,/integrated-console/);assert.match(js,/\/bot\/api\/status/);assert.match(js,/replaceState\(null, '', '\/bot\/'\)/);
    await fetch(base+'/bot/api/status',{headers});assert.equal(botRequest.headers['x-qq-control'],'a'.repeat(72));assert.equal(botRequest.headers.origin,botBase);assert.equal(botRequest.headers.host,new URL(botBase).host);
    await fs.writeFile(path.join(temp,'control-url.txt'),botBase+'/#'+'b'.repeat(72));
    await fetch(base+'/bot/api/action',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json'},body:'{"action":"pause"}'});assert.equal(botRequest.headers['x-qq-control'],'b'.repeat(72));assert.equal(botRequest.body,'{"action":"pause"}');
    await new Promise((resolve,reject)=>{
      const req=http.request(base+'/api/ws/terminal?token=stale',{headers:{...headers,Origin:base,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':Buffer.alloc(16).toString('base64')}});
      req.on('upgrade',(r,socket,head)=>{assert.equal(r.statusCode,101);assert.equal(wsRequest.headers.authorization,'Bearer synthetic-session-credential');assert.equal(new URL(wsRequest.url,napBase).searchParams.get('token'),'synthetic-session-credential');socket.destroy();resolve();});req.on('error',reject);req.on('response',r=>reject(new Error('WS response '+r.statusCode)));req.end();
    });
  }finally{
    for(const s of [gateway,nap,bot]){s.closeAllConnections();await new Promise(r=>s.close(r));}
    assert.ok(temp.startsWith(path.join(os.tmpdir(),'dafeiyu-integrations-test-')));await fs.rm(temp,{recursive:true,force:true});
  }
});

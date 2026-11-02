import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startSnowLumaProxy} from '../bridge/snowluma-proxy.mjs';

test('SnowLuma\'s pages open in the console signed in, only for a console session, and may be framed by it',async()=>{
  const seen=[];
  const upstream=http.createServer((req,res)=>{
    seen.push({url:req.url,token:req.headers['x-snowluma-token'],cookie:req.headers.cookie});
    const headers={'X-Frame-Options':'DENY','Content-Security-Policy':"frame-ancestors 'none'"};
    if(req.url==='/')res.writeHead(200,{...headers,'Content-Type':'text/html'}).end('<html><head><title>x</title></head></html>');
    else res.writeHead(200,{...headers,'Content-Type':'application/json'}).end('{"ok":true}');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const luma={webui:`http://127.0.0.1:${upstream.address().port}`,session:null,async sessionToken(){return 'bot-session';}};
  const auth={session:req=>String(req.headers.cookie||'').includes('console=ok')};
  const proxy=startSnowLumaProxy({auth,luma:()=>luma,port:0,consoleOrigin:'http://127.0.0.1:18191'});
  await new Promise(resolve=>proxy.once('listening',resolve));
  const base=`http://127.0.0.1:${proxy.address().port}`;
  try{
    assert.equal((await fetch(base+'/')).status,401);
    const page=await fetch(base+'/',{headers:{cookie:'console=ok'}});
    assert.equal(page.headers.get('x-frame-options'),null);
    assert.match(page.headers.get('content-security-policy'),/frame-ancestors http:\/\/127\.0\.0\.1:18191/);
    assert.match(await page.text(),/localStorage\.setItem\('snowluma_token',"bot-session"\)/);
    await fetch(base+'/api/processes',{headers:{cookie:'console=ok','x-snowluma-token':'from-page'}});
    assert.deepEqual(seen.at(-1),{url:'/api/processes',token:'bot-session',cookie:undefined},'the bot\'s session goes upstream, the console cookie does not');
    assert.equal((await fetch(base+'/api/processes',{headers:{cookie:'console=ok',origin:'http://evil.example'}})).status,401);
  }finally{proxy.close();upstream.close();}
});

test('the page never reaches SnowLuma\'s own login, and an expired session is renewed and the request repeated',async()=>{
  const seen=[];let valid='s1';
  const upstream=http.createServer((req,res)=>{
    seen.push(req.url);
    if(req.url==='/api/login'){res.writeHead(500).end();return;}
    res.writeHead(req.headers['x-snowluma-token']===valid?200:401,{'Content-Type':'application/json'}).end('{}');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  let logins=0;
  const luma={webui:`http://127.0.0.1:${upstream.address().port}`,session:null,async sessionToken(){if(!this.session){logins++;this.session='s'+logins;}return this.session;}};
  const proxy=startSnowLumaProxy({auth:{session:()=>true},luma:()=>luma,port:0});
  await new Promise(resolve=>proxy.once('listening',resolve));
  const base=`http://127.0.0.1:${proxy.address().port}`;
  try{
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"whatever"}'}).then(r=>r.json());
    assert.deepEqual(login,{success:true,token:'s1'});assert.ok(!seen.includes('/api/login'));
    valid='s2';
    assert.equal((await fetch(base+'/api/processes')).status,200,'after SnowLuma restarted');
    assert.equal(logins,2);
  }finally{proxy.close();upstream.close();}
});

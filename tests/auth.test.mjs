import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {Settings,createGateway} from '../bridge/gateway.mjs';
import {ConsoleAuth} from '../bridge/auth.mjs';

test('console password: token-only setup, login, lockout, change signs out old sessions',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-auth-test-'));
  const settings=await new Settings(path.join(temp,'providers.json')).load();
  const auth=await new ConsoleAuth({runtime:temp,secret:'console-secret'}).load();
  const autostart={status:async()=>({supported:true,enabled:false}),set:async enabled=>({supported:true,enabled})};
  const gateway=createGateway({token:'model-secret',consoleToken:'console-secret'},settings,{runtime:temp,auth,autostart});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${gateway.address().port}`;
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const cookieOf=r=>r.headers.get('set-cookie').split(';')[0];
  try{
    assert.deepEqual(await (await fetch(base+'/console/api/auth')).json(),{passwordSet:false,authenticated:false});
    assert.equal((await post('/console/api/auth/setup',{password:'first-pass'})).status,401);
    assert.equal((await post('/console/api/auth/setup',{password:'123'},{Authorization:'Bearer console-secret'})).status,400);
    const setup=await post('/console/api/auth/setup',{password:'first-pass'},{Authorization:'Bearer console-secret'});
    assert.equal(setup.status,200);const first=cookieOf(setup);
    assert.equal((await post('/console/api/auth/setup',{password:'other-pass'},{Authorization:'Bearer console-secret'})).status,409);
    assert.equal((await fetch(base+'/console/api/autostart',{headers:{Cookie:first}})).status,200);
    // The private token keeps working for API calls but can no longer mint a browser session.
    assert.equal((await fetch(base+'/console/api/autostart',{headers:{Authorization:'Bearer console-secret'}})).status,200);
    assert.equal((await post('/console/api/session',{},{Authorization:'Bearer console-secret'})).status,401);
    assert.equal((await post('/console/api/auth/login',{password:'wrong-pass'})).status,401);
    const login=await post('/console/api/auth/login',{password:'first-pass'});assert.equal(login.status,200);const second=cookieOf(login);
    assert.equal((await post('/console/api/auth/password',{current:'wrong-pass',next:'second-pass'},{Cookie:second})).status,401);
    const changed=await post('/console/api/auth/password',{current:'first-pass',next:'second-pass'},{Cookie:second});
    assert.equal(changed.status,200);const third=cookieOf(changed);
    assert.equal((await fetch(base+'/console/api/autostart',{headers:{Cookie:first}})).status,401);
    assert.equal((await fetch(base+'/console/api/autostart',{headers:{Cookie:third}})).status,200);
    const reloaded=await new ConsoleAuth({runtime:temp,secret:'console-secret'}).load();
    assert.equal(await reloaded.verify('second-pass'),true);assert.equal(await reloaded.verify('first-pass'),false);
    const fresh=await new ConsoleAuth({runtime:temp,secret:'console-secret'}).load();
    for(let i=0;i<5;i++)assert.equal(await fresh.verify('wrong-pass'),false);
    await assert.rejects(fresh.verify('second-pass'),/尝试次数过多/);
    assert.doesNotMatch(await fs.readFile(path.join(temp,'console-auth.json'),'utf8'),/second-pass/);
    // Through a tunnel host name: console with the password only, no launcher token, no model API.
    const tunnel='frp.example.com:18191',remote=`http://${tunnel}`;
    const via=(route,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
      const request=http.request(base+route,{method,headers:{Host:tunnel,...headers}},response=>{response.resume();response.on('end',()=>resolve(response));});
      request.on('error',reject);request.end(body);
    });
    assert.equal((await via('/console/')).statusCode,200);
    assert.equal((await via('/v1/models',{headers:{Authorization:'Bearer model-secret'}})).statusCode,403);
    assert.equal((await via('/console/api/autostart',{headers:{Authorization:'Bearer console-secret'}})).statusCode,401);
    const remoteLogin=await via('/console/api/auth/login',{method:'POST',headers:{Origin:remote,'Content-Type':'application/json'},body:JSON.stringify({password:'second-pass'})});
    assert.equal(remoteLogin.statusCode,200);const remoteCookie=remoteLogin.headers['set-cookie'][0].split(';')[0];
    assert.equal((await via('/console/api/autostart',{headers:{Cookie:remoteCookie}})).statusCode,200);
    assert.equal((await via('/console/api/autostart',{headers:{Cookie:remoteCookie,Origin:'http://evil.example'}})).statusCode,401);
  }finally{
    gateway.closeAllConnections();await new Promise(r=>gateway.close(r));
    await fs.rm(temp,{recursive:true,force:true});
  }
});

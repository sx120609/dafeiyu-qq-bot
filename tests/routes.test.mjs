import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Settings,createGateway,validRoutes} from '../bridge/gateway.mjs';

test('each purpose can go to its own model, falls back to the active one, and the rewrite stage is off until assigned',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-routes-test-'));
  const settings=await new Settings(path.join(temp,'providers.json')).load();
  settings.value.active='claude';settings.value.profiles.claude.model='opus';
  settings.value.profiles.cloud={...settings.value.profiles.cloud,apiKey:'synthetic-key',model:'gpt-big'};
  const config={token:'model-secret',consoleToken:'console-secret'};
  const calls=[];let failCloud=false;
  const invoke=async(body,c,provider,profile)=>{
    calls.push([body.metadata?.dafeiyu_purpose,provider,profile.model]);
    if(failCloud&&provider==='cloud')throw new Error('synthetic outage');
    return {model:profile.model,choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1}};
  };
  const server=createGateway(config,settings,{runtime:temp,invoke,discover:{codex:async()=>[],claude:async()=>[],cloud:async()=>[]}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const admin=async(route,body)=>{const r=await fetch(base+'/console/api/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+config.consoleToken,...(body?{'Content-Type':'application/json',Origin:base}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  const chat=purpose=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
    body:JSON.stringify({model:'dafeiyu-active',messages:[{role:'user',content:'hi'}],metadata:{dafeiyu_purpose:purpose}})}).then(r=>r.json());
  const info=()=>fetch(base+'/v1/model-info',{headers:{Authorization:'Bearer '+config.token}}).then(r=>r.json());
  try{
    // Nothing assigned: everything follows the active connection, and there is no rewrite stage.
    await chat('chat');assert.deepEqual(calls.at(-1),['chat','claude','opus']);
    assert.equal((await info()).rewrite,null);
    let view=(await admin('state')).data;assert.deepEqual(view.routes,{});
    assert.equal((await admin('routes',{revision:'stale',routes:{}})).status,409);
    assert.equal((await admin('routes',{revision:view.revision,routes:{nonsense:{provider:'cloud'}}})).status,400);
    const saved=await admin('routes',{revision:view.revision,routes:{chat:{provider:'cloud',model:'gpt-big'},memory:{provider:'cloud',model:'gpt-small'},rewrite:{provider:'active'},poke:{provider:'default'}}});
    assert.equal(saved.status,200);
    assert.deepEqual(saved.data.routes,{chat:{provider:'cloud',model:'gpt-big'},memory:{provider:'cloud',model:'gpt-small'},rewrite:{provider:'active'}});
    await chat('chat');assert.deepEqual(calls.at(-1),['chat','cloud','gpt-big']);
    await chat('memory');assert.deepEqual(calls.at(-1),['memory','cloud','gpt-small']);
    await chat('rewrite');assert.deepEqual(calls.at(-1),['rewrite','claude','opus']);
    await chat('poke');assert.deepEqual(calls.at(-1),['poke','claude','opus']);
    // An unknown purpose is metered as chat.
    await chat('whatever');assert.deepEqual(calls.at(-1).slice(1),['cloud','gpt-big']);
    const identity=await info();
    assert.equal(identity.model,'gpt-big');assert.equal(identity.provider,'cloud');assert.equal(identity.rewrite.model,'opus');
    // The assigned model down: the call goes to the active connection instead of failing.
    failCloud=true;calls.length=0;
    assert.equal((await chat('chat')).choices[0].message.content,'ok');
    assert.deepEqual(calls,[['chat','cloud','gpt-big'],['chat','claude','opus']]);
    const usage=(await admin('usage?days=1')).data;
    assert.ok(usage.purposes.some(p=>p.purpose==='rewrite'));
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});}
});

test('a route to the cloud needs a saved key; models are checked like the profile ones',()=>{
  const profiles={cloud:{apiKey:''}};
  assert.throws(()=>validRoutes({chat:{provider:'cloud',model:'x'}},profiles),/Key/);
  assert.throws(()=>validRoutes({chat:{provider:'codex',model:'a\nb'}},profiles),/模型/);
  assert.throws(()=>validRoutes([],profiles),/格式/);
  assert.deepEqual(validRoutes({chat:{provider:'codex',model:' gpt-6.1-sol '}},profiles),{chat:{provider:'codex',model:'gpt-6.1-sol'}});
});

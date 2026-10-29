import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {rateLimitError,withDeadline,ProviderBackoff} from '../bridge/provider-health.mjs';
import {runCodex} from '../bridge/server.mjs';
import {Settings,createGateway} from '../bridge/gateway.mjs';

test('Codex stderr 429 stops its six-minute retry immediately, including split chunks',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'rate-limit-'));
  let killed=false;
  const launch=()=>{
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
    child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('close',1));};
    queueMicrotask(()=>{child.stderr.write('stream disconnected - retrying sampling request (1/5 in 359.9998258s)... last status: 4');child.stderr.write('29 Too Many Requests\n');});
    return child;
  };
  try{
    await assert.rejects(runCodex({messages:[{role:'user',content:'synthetic'}]},{codex:process.execPath,tempRoot:temp},undefined,launch),e=>e.status===429&&e.retryAfter===360);
    assert.equal(killed,true);assert.deepEqual(await fs.readdir(temp),[]);
    assert.equal(rateLimitError('ordinary output'),null);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('deadlines release requests even when the runner ignores cancellation',async()=>{
  let signal;
  await assert.rejects(withDeadline(s=>{signal=s;return new Promise(()=>{});},undefined,20),e=>e.status===504);
  assert.equal(signal.aborted,true);
  const controller=new AbortController();controller.abort(new Error('cancelled by owner'));
  let invoked=false;
  await assert.rejects(withDeadline(()=>{invoked=true;},controller.signal,100),/cancelled by owner/);assert.equal(invoked,false);
  const active=new AbortController();let inner;
  const pending=withDeadline(s=>{inner=s;return new Promise(()=>{});},active.signal,10000);
  await Promise.resolve();active.abort(new Error('owner stopped the running test'));
  await assert.rejects(pending,/owner stopped/);assert.equal(inner.aborted,true);
});

test('429 cooldown persists and blocks only that provider, expires without a model request',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'backoff-'));
  try{
    const file=path.join(temp,'backoff.json');const first=new ProviderBackoff(file);await first.ready;
    await first.record('codex',rateLimitError('429',360));
    const restarted=new ProviderBackoff(file);await restarted.ready;
    assert.throws(()=>restarted.check('codex'),e=>e.status===429&&e.retryAfter>350);
    assert.doesNotThrow(()=>restarted.check('claude'));
    restarted.until.codex=Date.now()-1;assert.doesNotThrow(()=>restarted.check('codex'));
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('console timeout unlocks the next test; 429 returns Retry-After and does not repeat upstream calls',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-health-'));
  const settings=await new Settings(path.join(temp,'providers.json')).load();
  let calls=0,mode='hang';
  const invoke=async()=>{calls++;if(mode==='hang')return new Promise(()=>{});throw rateLimitError('429',360);};
  const server=createGateway({consoleToken:'synthetic-console',token:'synthetic-model',testTimeoutMs:25},settings,{runtime:temp,invoke});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const request=()=>fetch(base+'/console/api/test',{method:'POST',headers:{Authorization:'Bearer synthetic-console',Origin:base,'Content-Type':'application/json'},body:JSON.stringify({provider:'codex'})});
  try{
    assert.equal((await request()).status,504);
    mode='limited';const first=await request();assert.equal(first.status,429);assert.equal(first.headers.get('retry-after'),'360');
    const second=await request();assert.equal(second.status,429);assert.equal(calls,2);
    const state=await (await fetch(base+'/console/api/state',{headers:{Authorization:'Bearer synthetic-console'}})).json();
    assert.equal(state.availability.codex.limited,true);assert.equal(state.busy,false);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});}
});

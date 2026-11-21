import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {UsageLedger,usageDay} from '../bridge/usage.mjs';

test('unreported failures are not list-price estimates and legacy attribution stays unknown',()=>{
  const ledger=new UsageLedger({runtime:'.runtime/test-temp'});ledger.schedule=()=>{};
  const now=Date.UTC(2026,10,21,4);
  const legacy={calls:540,failures:0,ms:100,input:1000,cached:0,output:100,reasoning:0,reportedCost:2};
  ledger.data.days[usageDay(now)]={'claude|claude-haiku-5-5|director|':legacy};
  ledger.record({provider:'claude',model:'opus',ok:false,at:now});
  ledger.record({provider:'claude',model:'claude-opus-5-5',requestedModel:'opus',purpose:'director',at:now,usage:{model_usage:[
    {model:'claude-haiku-5-5',usage:{prompt_tokens:10,cost_usd:0.01}},
    {model:'claude-opus-5-5',usage:{prompt_tokens:100,cost_usd:1}}
  ]}});
  const summary=ledger.summary({days:1,now});
  const failed=summary.models.find(m=>m.model==='opus'),haiku=summary.models.find(m=>m.model==='claude-haiku-5-5');
  assert.equal(failed.costSource,'unpriced');
  assert.equal(failed.successes,0);
  assert.deepEqual(failed.usageOrigins,{legacy:0,primary:0,auxiliary:0,unreported:1});
  assert.deepEqual(haiku.usageOrigins,{legacy:540,primary:0,auxiliary:1,unreported:0});
  assert.equal(haiku.requestCalls,540);
  assert.equal(haiku.requestFailures,0);
  assert.deepEqual(haiku.requestedModels,{opus:1});
  assert.equal(summary.totals.calls,542);
  assert.equal(summary.totals.successes,541);
  assert.equal(summary.totals.failures,1);
});

test('an auxiliary-only usage delta does not become the primary gateway attempt',()=>{
  const ledger=new UsageLedger({runtime:'.runtime/test-temp'});ledger.schedule=()=>{};
  ledger.record({provider:'claude',model:'claude-opus-5-5',requestedModel:'opus',ok:false,usage:{model_usage:[
    {model:'claude-haiku-5-5',usage:{prompt_tokens:10,cost_usd:0.01}}
  ]}});
  const summary=ledger.summary(),opus=summary.models.find(m=>m.model==='claude-opus-5-5'),haiku=summary.models.find(m=>m.model==='claude-haiku-5-5');
  assert.ok(opus);
  assert.equal(opus.requestFailures,1);
  assert.equal(opus.costSource,'unpriced');
  assert.equal(haiku.requestCalls,0);
  assert.equal(haiku.usageOrigins.auxiliary,1);
  assert.equal(summary.totals.calls,1);
  assert.equal(summary.totals.failures,1);
  assert.equal(summary.totals.usd,0.01);
});

test('model contributions keep gateway attempts separate from successes and legacy failures',()=>{
  const ledger=new UsageLedger({runtime:'.runtime/test-temp'});
  ledger.schedule=()=>{};
  const now=Date.UTC(2026,10,21,4);
  ledger.data.days[usageDay(now)]={'claude|opus|director|':{calls:1524,failures:1524,ms:0,input:0,cached:0,output:0,reasoning:0,reportedCost:0}};
  const usage={model_usage:[
    {model:'claude-haiku-5-5',usage:{prompt_tokens:10,completion_tokens:1,cost_usd:0.01}},
    {model:'claude-opus-5-5',usage:{prompt_tokens:150,cached_tokens:50,completion_tokens:20,cost_usd:2}}
  ]};
  ledger.record({provider:'claude',model:'claude-opus-5-5',purpose:'director',usage,at:now});
  ledger.record({provider:'claude',model:'claude-opus-5-5',purpose:'director',ok:false,failure:'error_max_structured_output_retries',
    usage:{model_usage:[{model:'claude-opus-5-5',usage:{prompt_tokens:100,cost_usd:0.4}}]},at:now});
  const summary=ledger.summary({days:1,now});
  assert.equal(summary.totals.calls,1526);
  assert.equal(summary.totals.successes,1);
  assert.equal(summary.totals.failures,1525);
  assert.equal(summary.models.find(m=>m.model==='opus').successes,0);
  assert.equal(summary.models.find(m=>m.model==='claude-haiku-5-5').usd,0.01);
  assert.equal(summary.models.find(m=>m.model==='claude-opus-5-5').usd,2.4);
  assert.equal(summary.totals.input,260);
  assert.equal(summary.totals.cached,50);
  assert.equal(summary.purposes[0].calls,1526);
  assert.equal(summary.daily[0].successes,1);
  assert.deepEqual(summary.failureReasons,{unknown:1524,error_max_structured_output_retries:1});
  assert.equal(summary.window.start,'2026-11-21T00:00:00+08:00');
  assert.equal(summary.counting.upstreamRequests,'not-recorded');
});

test('a reported zero cost does not become a list-price charge',()=>{
  const ledger=new UsageLedger({runtime:'.runtime/test-temp'});ledger.schedule=()=>{};
  ledger.record({provider:'claude',model:'opus',usage:{prompt_tokens:1000,cost_usd:0}});
  assert.equal(ledger.summary().totals.usd,0);
  assert.equal(ledger.summary().models[0].costSource,'reported');
});

test('usage ledger: sums per Beijing day, prefers reported cost, prices the rest, persists',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-usage-test-'));
  const ledger=await new UsageLedger({runtime:temp}).load();
  const now=Date.UTC(2026,9,28,15,30); // 23:30 in Beijing
  assert.equal(usageDay(now),'2026-10-28');
  assert.equal(usageDay(Date.UTC(2026,9,28,16,30)),'2026-10-29');
  ledger.record({provider:'claude',model:'claude-opus',purpose:'chat',chat:'群·测试群',ms:1200,at:now,usage:{prompt_tokens:1000,completion_tokens:200,cost_usd:0.05}});
  ledger.record({provider:'codex',model:'gpt-5',purpose:'chat',chat:'好友·小王',ms:800,at:now,usage:{prompt_tokens:2_000_000,cached_tokens:1_000_000,completion_tokens:100_000}});
  ledger.record({provider:'codex',model:'gpt-5',purpose:'memory',ok:false,at:now-86400_000});
  let summary=ledger.summary({days:7,now});
  assert.equal(summary.totals.calls,3);assert.equal(summary.totals.failures,1);
  assert.equal(summary.totals.usd,0.05);assert.equal(summary.totals.unpriced,2);
  assert.deepEqual(summary.daily.map(d=>d.calls).slice(-2),[1,2]);
  assert.equal(summary.chats[0].chat,'好友·小王');
  await assert.rejects(ledger.setPrice('openai|gpt-5',{input:1}),/模型标识/);
  await assert.rejects(ledger.setPrice('codex|gpt-5',{input:-1}),/单价/);
  await ledger.setPrice('codex|gpt-5',{input:1.25,cachedInput:0.125,output:10});
  summary=ledger.summary({days:1,now});
  const gpt=summary.models.find(m=>m.model==='gpt-5');
  // 1M fresh input × 1.25 + 1M cached × 0.125 + 0.1M output × 10 = 2.375
  assert.equal(gpt.usd,2.375);assert.equal(gpt.costSource,'priced');
  assert.equal(summary.models.find(m=>m.provider==='claude').costSource,'reported');
  // A model with a list price is estimated without the owner typing one; the owner's own price still wins.
  ledger.record({provider:'codex',model:'gpt-6.1-sol',at:now,usage:{prompt_tokens:1_000_000,cached_tokens:0,completion_tokens:100_000}});
  let sol=ledger.summary({days:1,now}).models.find(m=>m.model==='gpt-6.1-sol');
  assert.equal(sol.costSource,'reference');assert.equal(sol.usd,3);assert.equal(sol.referencePrice.input,2);
  await ledger.setPrice('codex|gpt-6.1-sol',{input:1,output:5});
  sol=ledger.summary({days:1,now}).models.find(m=>m.model==='gpt-6.1-sol');
  assert.equal(sol.costSource,'priced');assert.equal(sol.usd,1.5);
  await ledger.setRate(7.2);
  const reloaded=await new UsageLedger({runtime:temp}).load();
  assert.equal(reloaded.data.cnyPerUsd,7.2);assert.deepEqual(reloaded.data.prices['codex|gpt-5'],{input:1.25,cachedInput:0.125,output:10});
  await fs.rm(temp,{recursive:true,force:true});
});

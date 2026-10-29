import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {UsageLedger,usageDay} from '../bridge/usage.mjs';

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

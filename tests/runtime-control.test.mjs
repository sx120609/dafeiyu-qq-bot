import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeControl} from '../bridge/runtime-control.mjs';

const stop=['/usr/bin/systemctl','--user','stop','dafeiyu-bot.service'];
const start=['/usr/bin/systemctl','--user','start','dafeiyu-bot.service'];

test('runtime controls only invoke fixed commands, stop the engine around NapCat and preserve login data',async()=>{
  const calls=[];const integrations={credential:'cached',expires:999};
  const control=new RuntimeControl({runtime:'.',integrations,execute:async(exe,args)=>{calls.push([exe,...args]);return '';}});
  control.panel=async action=>{calls.push(['panel',action]);return {};};
  await assert.rejects(control.action('napcat-restart; arbitrary-command'),/不支持/);assert.equal(calls.length,0);
  const result=await control.action('napcat-restart');assert.equal(result.ok,true);
  // No pause through the engine: a pause would be remembered as the owner's choice.
  assert.deepEqual(calls,[stop,['/usr/bin/sudo','-n','/usr/local/bin/dafeiyu-qq-runtime','restart'],start]);
  assert.equal(integrations.credential,null);assert.equal(control.last.state,'succeeded');
  calls.length=0;await control.action('napcat-stop');assert.deepEqual(calls,[stop,['/usr/bin/sudo','-n','/usr/local/bin/dafeiyu-qq-runtime','stop']]);
  calls.length=0;await control.action('bot-restart');assert.deepEqual(calls,[['/usr/bin/systemctl','--user','restart','dafeiyu-bot.service']]);
  calls.length=0;await control.action('bot-pause');assert.deepEqual(calls,[['panel','pause']]);
});
test('concurrent runtime actions are rejected',async()=>{
  const calls=[];let release;
  const control=new RuntimeControl({runtime:'.',integrations:{},execute:async(exe,args)=>{calls.push([exe,...args]);if(args.includes('restart')&&exe.includes('sudo'))await new Promise(r=>release=r);return '';}});
  control.panel=async()=>{throw new Error('offline');};
  const pending=control.action('napcat-restart');
  for(let i=0;!release&&i<20;i++)await new Promise(r=>setTimeout(r,5));
  await assert.rejects(control.action('bot-restart'),/正在进行/);
  release();await pending;
  assert.deepEqual(calls[0],stop);
  assert.equal(control.busy,false);
});
test('moderation lists are validated before reaching the engine',async()=>{
  const sent=[];const control=new RuntimeControl({runtime:'.',integrations:{}});
  control.panel=async(action,values)=>{sent.push([action,values]);return {config:{adminIDs:values?.adminIDs||['10001'],blockedIDs:values?.blockedIDs||[],expectedSelfID:'30003'}};};
  assert.deepEqual(await control.moderation(),{admins:['10001'],blocked:[],account:'30003'});
  await assert.rejects(control.moderation({admins:['abc'],blocked:[]}),/格式/);
  assert.deepEqual(await control.moderation({admins:['10001','10001'],blocked:['20002']}),{admins:['10001'],blocked:['20002']});
  assert.deepEqual(sent.at(-1),['saveModeration',{adminIDs:['10001'],blockedIDs:['20002']}]);
});
test('outreach settings are validated and previews only target private chats',async()=>{
  const sent=[];const control=new RuntimeControl({runtime:'.',integrations:{}});
  const current={enabled:false,idleMinutes:1440,cooldownMinutes:2880,quietStartHour:23,quietEndHour:9,timeZone:'Asia/Shanghai',excluded:[]};
  control.panel=async(action,values,options)=>{sent.push([action,values,options]);return {outreach:values?.outreach||current,outreachChats:[{key:'private:10001'}],outreachPreview:{send:true,text:'考试怎么样了？'},config:{memoryEnabled:true},running:true};};
  const view=await control.outreach();assert.equal(view.config.enabled,false);assert.equal(view.memoryEnabled,true);
  await assert.rejects(control.outreach({enabled:true,idleMinutes:0,cooldownMinutes:60,quietStartHour:23,quietEndHour:9}),/范围/);
  const saved=await control.outreach({enabled:true,idleMinutes:720,cooldownMinutes:1440,quietStartHour:0,quietEndHour:8,excluded:['private:10002','group:1','x']});
  assert.deepEqual(sent.at(-1)[1].outreach,{...current,enabled:true,idleMinutes:720,cooldownMinutes:1440,quietStartHour:0,quietEndHour:8,excluded:['private:10002']});
  assert.equal(saved.config.timeZone,'Asia/Shanghai');
  await assert.rejects(control.previewOutreach('group:12345'),/私聊/);
  assert.equal((await control.previewOutreach('private:10001')).text,'考试怎么样了？');
  assert.equal(sent.at(-1)[2].timeout,300000);
});test('reaction settings keep the emoji list and only change weights within range',async()=>{
  const sent=[];const control=new RuntimeControl({runtime:'.',integrations:{}});
  const current={enabled:false,chance:20,cooldownSeconds:45,emojis:[{id:'147',name:'棒棒糖',weight:5},{id:'128051',name:'鲸鱼',weight:5}]};
  control.panel=async(action,values)=>{sent.push([action,values]);return {reactions:values?.reactions||current,reactionsSent:3};};
  assert.deepEqual(await control.reactions(),{config:current,sent:3,interactions:[]});
  await assert.rejects(control.reactions({enabled:true,chance:150,cooldownSeconds:45}),/范围/);
  await assert.rejects(control.reactions({enabled:true,chance:20,cooldownSeconds:45,weights:{'147':11}}),/范围/);
  const saved=await control.reactions({enabled:true,chance:35,cooldownSeconds:0,repeatEnabled:false,weights:{'128051':8,'999':4}});
  assert.deepEqual(sent.at(-1),['saveReactions',{reactions:{enabled:true,chance:35,cooldownSeconds:0,pokeEnabled:true,repeatEnabled:false,emojis:[{id:'147',name:'棒棒糖',weight:5},{id:'128051',name:'鲸鱼',weight:8}]}}]);
  assert.equal(saved.config.enabled,true);
});
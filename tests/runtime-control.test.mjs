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
});test('reply mode: agent for every chat or chosen ones, only chats on the list',async()=>{
  const sent=[];const control=new RuntimeControl({runtime:'.',integrations:{}});
  let config={agentForAll:false,agentTargets:['group:111'],targets:[{number:'111',name:'甲群',group:true,enabled:true},{number:'222',name:'乙群',group:true,enabled:false},{number:'333',name:'好友',group:false,enabled:true}]};
  control.panel=async(action,values)=>{sent.push([action,values]);if(values)config={...config,...values};return {config,agentStates:[{key:'group:111',pending:2}],agentTurns:[{chat:'群·甲群',decision:'reply'}],running:true,connected:true};};
  const first=await control.agent();
  assert.equal(first.forAll,false);
  assert.deepEqual(first.chats.map(c=>[c.key,c.agent,c.level]),[['group:111',true,'standard'],['group:222',false,'standard'],['private:333',false,'standard']]);
  assert.equal(first.turns[0].decision,'reply');assert.equal(first.states[0].pending,2);
  await assert.rejects(control.agent({forAll:true,classic:['private:999']}),/会话/);
  await assert.rejects(control.agent({forAll:'yes'}),/无效/);
  await assert.rejects(control.agent({forAll:true,levels:{'group:111':'god'}}),/权限/);
  const saved=await control.agent({forAll:true,classic:['private:333','private:333'],levels:{'group:222':'basic'}});
  assert.deepEqual(sent.at(-1),['saveReplyMode',{agentForAll:true,agentTargets:[],classicTargets:['private:333'],agentLevels:{'group:222':'basic'}}]);
  assert.equal(saved.chats.find(c=>c.key==='group:222').level,'basic');
  assert.deepEqual(saved.chats.map(c=>[c.key,c.agent]),[['group:111',true],['group:222',true],['private:333',false]]);
});
test('the console edits engine settings only through an allow-list, and save keeps the rest of ai',async()=>{
  const sent=[];const control=new RuntimeControl({runtime:'.',integrations:{}});
  const status={connected:true,running:true,busy:false,contacts:[{key:'group:1',name:'甲',number:'1',group:true},{key:'private:2',name:'乙',number:'2',group:false}],
    config:{targets:[{number:'1',name:'甲',group:true,enabled:true}],ai:{model:'m',maxTokens:2000,prompt:'p',dailyLimit:10,cooldownSeconds:2,sendLimits:{daily:5,perChatDaily:3,globalIntervalSeconds:3},workHoursEnabled:false},memoryEnabled:true,visionEnabled:true},
    personalities:[{id:'teasing',name:'雌小鬼'}],persona:{style:'teasing'},memoryOptions:{},stickers:[{id:'a',title:'t',emotion:'joy',file:'x.png',sha256:'h'}],imageCredentials:{zhipu:true}};
  control.panel=async(action,values)=>{if(action)sent.push([action,values]);return status;};
  const state=await control.engineState();
  assert.deepEqual(state.contacts.map(c=>c.key),['private:2']); // already on the list: not offered again
  assert.equal(state.stickers[0].file,undefined);assert.equal(state.imageCredentials.zhipu,true);
  await assert.rejects(control.engineAction('connect',{}),/不支持/);
  await assert.rejects(control.engineAction('disconnect',{}),/不支持/);
  await control.engineAction('save',{ai:{dailyLimit:50,sendLimits:{daily:9}},endpoint:'ws://evil',enabled:['group:1']});
  assert.deepEqual(sent.at(-1),['save',{enabled:['group:1'],ai:{model:'m',maxTokens:2000,prompt:'p',dailyLimit:50,cooldownSeconds:2,sendLimits:{daily:9,perChatDaily:3,globalIntervalSeconds:3},workHoursEnabled:false}}]);
  await control.engineAction('resetMemory',{target:'group:1'});
  assert.deepEqual(sent.at(-1),['resetMemory',{target:'group:1'}]);
});
test('voice settings keep the key to themselves and call the speech endpoint with the chosen voice',async()=>{
  const {VoiceSettings}=await import('../bridge/voice.mjs');
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'voice-'));
  const calls=[];
  const voice=await new VoiceSettings({runtime,fetcher:async(url,init)=>{calls.push([url,JSON.parse(init.body),init.headers.Authorization]);return new Response(Buffer.alloc(500,1),{status:200});}}).load();
  await assert.rejects(voice.update({enabled:true}),/API Key/);
  await assert.rejects(voice.update({baseUrl:'http://example.com'}),/https/);
  const view=await voice.update({enabled:true,apiKey:'sk-test-voice',voice:'nova',speed:1.2});
  assert.equal(view.keySet,true);assert.equal(view.apiKey,undefined);assert.equal(voice.ready,true);
  const audio=await voice.speak('你好呀');
  assert.equal(audio.length,500);
  assert.equal(calls[0][0],'https://api.openai.com/v1/audio/speech');
  assert.equal(calls[0][1].voice,'nova');assert.equal(calls[0][1].speed,1.2);assert.ok(calls[0][1].instructions);
  assert.equal(calls[0][2],'Bearer sk-test-voice');
  const reloaded=await new VoiceSettings({runtime}).load();assert.equal(reloaded.ready,true);
  await voice.update({clearKey:true});assert.equal(voice.ready,false);
  await fs.rm(runtime,{recursive:true,force:true});
});

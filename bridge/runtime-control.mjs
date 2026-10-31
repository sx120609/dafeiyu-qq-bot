import {runProcess} from './providers.mjs';

export class RuntimeControl{
  constructor({runtime,integrations,execute=runProcess}){this.runtime=runtime;this.integrations=integrations;this.execute=execute;this.busy=false;this.last=null;}
  async panel(action,values={},{timeout=10000}={}){
    const {base,token}=await this.integrations.botTarget();
    const headers={'X-QQ-Control':token,Origin:base,'Content-Type':'application/json'};
    const statusResponse=await fetch(base+'/api/status',{headers,signal:AbortSignal.timeout(5000)});
    if(!statusResponse.ok)throw new Error('机器人服务暂不可用');
    const status=await statusResponse.json();if(!action)return status;
    const payload={action,...values,configurationRevision:status.configurationRevision};
    if(action==='start'){payload.durationMinutes=0;payload.singleReply=false;}
    const route=action==='importSticker'?'/api/import-sticker':'/api/action';
    const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
    const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'机器人操作失败');
    return data;
  }
  // Everything the console's chat, persona, image and limit pages read, in one call. No credentials: only
  // whether each one is loaded.
  async engineState(){
    const s=await this.panel(),c=s.config,key=t=>(t.group?'group:':'private:')+t.number;
    const targets=new Set(c.targets.map(key));
    return {connected:s.connected,running:s.running,busy:s.busy,
      targets:c.targets.map(t=>({key:key(t),name:t.name,number:t.number,group:t.group,enabled:t.enabled,personaStyle:t.personaStyle||null})),
      contacts:(s.contacts||[]).filter(x=>!targets.has(x.key)).map(x=>({key:x.key,name:x.name,number:x.number,group:x.group})),
      personalities:s.personalities||[],persona:s.persona,
      ai:{prompt:c.ai.prompt,dailyLimit:c.ai.dailyLimit,cooldownSeconds:c.ai.cooldownSeconds,sendLimits:c.ai.sendLimits||{},workHoursEnabled:!!c.ai.workHoursEnabled,workStart:c.ai.workStart,workEnd:c.ai.workEnd},
      calls:s.calls,confirmed:s.confirmed,
      memoryEnabled:!!c.memoryEnabled,memoryOptions:s.memoryOptions,memories:s.memories||[],memoryStatus:s.memoryStatus,
      stickers:(s.stickers||[]).map(x=>({id:x.id,title:x.title,emotion:x.emotion,context:x.context,source:x.source,author:x.author,license:x.license,local:x.local})),
      visionEnabled:!!c.visionEnabled,visualTools:s.visualTools,googleVisionCredential:!!s.googleVisionCredential,visualStatus:s.visualStatus,
      imageGeneration:s.imageGeneration,imageCredentials:s.imageCredentials||{},imageGenerationStatus:s.imageGenerationStatus,
      artwork:s.artwork,artworkArtists:s.artworkArtists||[],artworkStatus:s.artworkStatus,artworkNetworkCalls:s.artworkNetworkCalls,artworkConfirmed:s.artworkConfirmed,
      supportsKeychain:s.supportsKeychain!==false};
  }
  async engineAction(action,values={}){
    const allowed=['add','remove','setPersona','save','resetMemory','saveArtwork','addArtworkArtist','removeArtworkArtist','saveImageGeneration','saveVisualTools','importSticker'];
    if(!allowed.includes(action))throw new Error('不支持的操作');
    if(action==='save'){
      // Only the parts the console edits; ai is merged over the engine's own so its model settings stay.
      const current=(await this.panel()).config,next={};
      if(Array.isArray(values.enabled))next.enabled=values.enabled;
      if(values.persona&&typeof values.persona==='object')next.persona=values.persona;
      if(values.ai&&typeof values.ai==='object')next.ai={...current.ai,...values.ai,sendLimits:{...(current.ai.sendLimits||{}),...(values.ai.sendLimits||{})}};
      if(values.memoryOptions&&typeof values.memoryOptions==='object')next.memoryOptions=values.memoryOptions;
      values=next;
    }
    await this.panel(action,values,{timeout:action==='importSticker'?60000:20000});
    return this.engineState();
  }
  async stickerImage(id){
    const {base,token}=await this.integrations.botTarget();
    const response=await fetch(base+'/api/sticker/'+encodeURIComponent(id),{headers:{'X-QQ-Control':token},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('图片不可用');
    return {type:response.headers.get('content-type')||'image/png',body:Buffer.from(await response.arrayBuffer())};
  }
  // The Xiaohongshu / Bilibili panel runs on its own loopback address; the console only opens it.
  async socialPanel(platform){
    if(!['xiaohongshu','bilibili'].includes(platform))throw new Error('未知平台');
    const {base,token}=await this.integrations.botTarget();
    const response=await fetch(base+'/api/social-panel',{method:'POST',headers:{'X-QQ-Control':token,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({platform}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('社交平台面板没能打开');
    const {url}=await response.json(),parsed=new URL(url);
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1')throw new Error('社交平台面板地址无效');
    return {url};
  }
  async napcat(action){return this.execute('/usr/bin/sudo',['-n','/usr/local/bin/dafeiyu-qq-runtime',action],'',{timeout:45000});}
  async engine(action){return this.execute('/usr/bin/systemctl',['--user',action,'dafeiyu-bot.service'],'',{timeout:30000});}
  async status(){
    const result={busy:this.busy,last:this.last,napcat:{state:'unknown'},bot:{state:'unknown'}};
    const [nap,bot]=await Promise.allSettled([this.napcat('status'),this.panel()]);
    if(nap.status==='fulfilled'){const data=JSON.parse(nap.value);result.napcat={state:data.Status,running:data.Running,restarting:data.Restarting};}
    else result.napcat.error='无法读取 NapCat 状态';
    if(bot.status==='fulfilled'){const data=bot.value;result.bot={state:'active',connected:data.connected,running:data.running,contacts:data.contacts.length,enabledTargets:data.config.targets.filter(t=>t.enabled).length,status:data.status};}
    else result.bot.error='机器人服务未就绪';
    return result;
  }
  // One read for the console's overview page: runtime state, today's counters and recent records.
  async overview(){
    const result={busy:this.busy,last:this.last,napcat:{state:'unknown'},bot:{state:'unknown'}};
    const [nap,bot]=await Promise.allSettled([this.napcat('status'),this.panel()]);
    if(nap.status==='fulfilled'){const data=JSON.parse(nap.value);result.napcat={state:data.Status,running:data.Running,restarting:data.Restarting,startedAt:data.StartedAt};}
    else result.napcat.error='无法读取 NapCat 状态';
    if(bot.status==='fulfilled'){
      const d=bot.value,targets=d.config.targets;
      result.bot={state:'active',connected:d.connected,running:d.running,busy:d.busy,status:d.status,error:d.error||'',account:d.config.expectedSelfID,
        runDeadline:d.runDeadline,kickedAt:d.kickedAt||null,kicks:(d.kicks||[]).slice(0,10),sendsLastHour:d.sendsLastHour??null,hourlyLimit:d.config.ai.sendLimits?.hourly??90,calls:d.calls,dailyLimit:d.config.ai.dailyLimit,confirmed:d.confirmed,attempts:d.attempts,uncertain:d.uncertain,queued:d.queued,
        sendLimit:d.config.ai.sendLimits?.daily??null,memoryStatus:d.memoryStatus,
        targets:{private:targets.filter(t=>!t.group&&t.enabled).length,group:targets.filter(t=>t.group&&t.enabled).length,total:targets.length},
        records:(d.runtimeRecords||[]).slice(0,15),removedTargets:(d.removedTargets||[]).slice(0,30),decisions:(d.decisions||[]).slice(0,60)};
    }else result.bot.error='机器人服务未就绪';
    return result;
  }
  async moderation(values){
    if(values){
      const list=v=>{if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!/^[1-9]\d{4,11}$/.test(x)))throw new Error('QQ 号格式不正确');return [...new Set(v)];};
      const status=await this.panel('saveModeration',{adminIDs:list(values.admins),blockedIDs:list(values.blocked)});
      return {admins:status.config.adminIDs||[],blocked:status.config.blockedIDs||[]};
    }
    const status=await this.panel();
    return {admins:status.config.adminIDs||[],blocked:status.config.blockedIDs||[],account:status.config.expectedSelfID};
  }
  // Starting private conversations: settings, per-chat state, and a preview that is never sent.
  async outreach(settings){
    const view=status=>({config:status.outreach,chats:status.outreachChats||[],preview:status.outreachPreview||null,memoryEnabled:!!status.config.memoryEnabled,running:status.running});
    if(!settings)return view(await this.panel());
    const hours=(v,min,max)=>{if(!Number.isInteger(v)||v<min||v>max)throw new Error('主动聊天设置的数值不在允许范围内');return v;};
    const current=(await this.panel()).outreach;
    const next={...current,enabled:settings.enabled===true,idleMinutes:hours(settings.idleMinutes,1,43200),cooldownMinutes:hours(settings.cooldownMinutes,1,43200),
      quietStartHour:hours(settings.quietStartHour,0,23),quietEndHour:hours(settings.quietEndHour,0,23),
      excluded:Array.isArray(settings.excluded)?settings.excluded.filter(x=>typeof x==='string'&&/^private:\d{5,12}$/.test(x)):[]};
    return view(await this.panel('saveOutreach',{outreach:next}));
  }
  // The bot's small moves in groups (reacting, poking, joining a repeat chain), decided by the model.
  async reactions(settings){
    const view=status=>({config:status.reactions,sent:status.reactionsSent||0,interactions:status.interactions||[]});
    if(!settings)return view(await this.panel());
    const int=(v,min,max)=>{if(!Number.isInteger(v)||v<min||v>max)throw new Error('贴表情设置的数值不在允许范围内');return v;};
    const current=(await this.panel()).reactions;
    const weights=settings.weights&&typeof settings.weights==='object'?settings.weights:{};
    const next={...current,enabled:settings.enabled===true,chance:int(settings.chance,0,100),cooldownSeconds:int(settings.cooldownSeconds,0,3600),
      pokeEnabled:settings.pokeEnabled===undefined?current.pokeEnabled??true:settings.pokeEnabled===true,
      repeatEnabled:settings.repeatEnabled===undefined?current.repeatEnabled??true:settings.repeatEnabled===true,
      emojis:current.emojis.map(e=>({...e,weight:weights[e.id]===undefined?e.weight:int(weights[e.id],0,10)}))};
    return view(await this.panel('saveReactions',{reactions:next}));
  }
  // Agent mode: which chats the directing model runs by itself, and what it has been doing.
  async agent(settings){
    const view=status=>{
      const c=status.config,forAll=c.agentForAll===true,agentSet=new Set(c.agentTargets||[]),classic=new Set(c.classicTargets||[]);
      const key=t=>(t.group?'group:':'private:')+t.number;
      const levels=c.agentLevels||{};
      return {forAll,chats:c.targets.map(t=>({key:key(t),name:t.name,group:t.group,enabled:t.enabled,agent:forAll?!classic.has(key(t)):agentSet.has(key(t)),level:levels[key(t)]||'full'})),
        states:status.agentStates||[],turns:status.agentTurns||[],reminders:status.agentReminders||[],notes:status.agentNotes||[],running:status.running,connected:status.connected};
    };
    if(!settings)return view(await this.panel());
    const chats=new Set((await this.panel()).config.targets.map(t=>(t.group?'group:':'private:')+t.number));
    const list=v=>{if(!Array.isArray(v)||v.some(k=>typeof k!=='string'||!chats.has(k)))throw new Error('只能选名单里的会话');return [...new Set(v)];};
    if(typeof settings.forAll!=='boolean')throw new Error('回复方式设置无效');
    const levels=settings.levels??{};
    if(typeof levels!=='object'||Array.isArray(levels)||Object.entries(levels).some(([k,v])=>!chats.has(k)||!['basic','standard','full'].includes(v)))throw new Error('权限档设置无效');
    return view(await this.panel('saveReplyMode',{agentForAll:settings.forAll,agentTargets:list(settings.agent??[]),classicTargets:list(settings.classic??[]),agentLevels:levels}));
  }
  // Reply pacing (wait for someone to finish typing) and answering pokes.
  async timing(settings){
    const view=status=>({settleSeconds:status.settleSeconds??0,poke:status.poke,quietHours:status.quietHours});
    if(!settings)return view(await this.panel());
    const int=(v,min,max)=>{if(!Number.isInteger(v)||v<min||v>max)throw new Error('回复节奏设置的数值不在允许范围内');return v;};
    let status=await this.panel();
    if(settings.settleSeconds!==undefined)status=await this.panel('saveSettle',{settleSeconds:int(settings.settleSeconds,0,30)});
    if(settings.poke){
      const poke={...status.poke,enabled:settings.poke.enabled===true,replyChance:int(settings.poke.replyChance,0,100),cooldownSeconds:int(settings.poke.cooldownSeconds,0,3600)};
      status=await this.panel('savePoke',{poke});
    }
    if(settings.quietHours){
      const q=settings.quietHours;
      const quietHours={...status.quietHours,enabled:q.enabled===true,startHour:int(q.startHour,0,23),endHour:int(q.endHour,0,23)};
      status=await this.panel('saveQuietHours',{quietHours});
    }
    return view(status);
  }
  async previewOutreach(target){
    if(typeof target!=='string'||!/^private:\d{5,12}$/.test(target))throw new Error('请选择一个私聊');
    return (await this.panel('previewOutreach',{target},{timeout:300000})).outreachPreview;
  }
  async action(name){
    const actions=new Set(['napcat-start','napcat-stop','napcat-restart','bot-pause','bot-resume','bot-restart']);
    if(!actions.has(name))throw new Error('不支持的运行操作');
    if(this.busy){const error=new Error('已有运行操作正在进行，请稍候');error.status=409;throw error;}
    this.busy=true;this.last={action:name,at:new Date().toISOString(),state:'running'};
    try{
      if(name.startsWith('napcat-')){
        const verb=name.slice(7);
        // Stop the engine rather than pausing it: a pause would be remembered as the owner's
        // choice, while a restarted engine restores whatever the owner last chose.
        await this.engine('stop');
        await this.napcat(verb);this.integrations.credential=null;this.integrations.expires=0;
        if(verb!=='stop')await this.engine('start');
      }else if(name==='bot-restart')await this.engine('restart');
      else await this.panel(name==='bot-resume'?'start':'pause');
      this.last={...this.last,state:'succeeded'};
      return {ok:true,message:{'napcat-start':'NapCat 已启动，正在恢复 QQ 连接。','napcat-stop':'NapCat 已停止，机器人暂时离线。','napcat-restart':'NapCat 已重启，连上 QQ 后按你上次的选择恢复回复。','bot-restart':'机器人已重启，连上 QQ 后按你上次的选择恢复回复。','bot-pause':'已暂停回复。','bot-resume':'已开始回复。'}[name]};
    }catch(error){this.last={...this.last,state:'failed',error:error.message};throw error;}
    finally{this.busy=false;}
  }
}

const $=id=>document.getElementById(id);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];

/* Pages: title and one line under it. Old addresses still land somewhere sensible. */
const pages={
  overview:['总览','机器人现在的状态和最近做了什么'],
  activity:['动态','代理在每个会话里看了什么、做了什么、为什么'],
  usage:['用量','这个机器人自己调用模型的次数、tokens 和花费'],
  chats:['会话','在哪些好友和群里说话，各自的权限和性格'],
  persona:['人设与表情','性格、表情包和常用的贴表情'],
  abilities:['能力','它会做的事：每一项的开关和细节都在这里，开关一点就生效'],
  rhythm:['节奏与额度','什么时候说话、主动找谁、一天能发多少'],
  model:['模型','连接方式，以及每种活交给哪个模型'],
  moderation:['管理员','谁能管机器人，谁不理'],
  qq:['QQ 登录','NapCat 管理页，扫码登录机器人的 QQ'],
  settings:['设置','控制台密码、开机自启和其他平台']
};
const aliases={agent:'activity',features:'abilities',images:'abilities',voice:'abilities',chat:'rhythm',limits:'rhythm'};
const providerNames={codex:'本机 Codex',claude:'本机 Claude Code',cloud:'云端 API'};
const providerHelp={
  codex:'通过官方 Codex CLI 调用，复用这台电脑已登录的 ChatGPT 账号，不需要 API Key。',
  claude:'通过官方 Claude Code 调用，登录由官方客户端管理；不读取或转发登录令牌。Claude 没有绘图模型，绘图会自动交给 Codex。',
  cloud:'使用你自己的 API Key，支持 OpenAI 兼容接口和 Anthropic 官方接口。密钥只保存在本机。'
};
const qqPattern=/^[1-9]\d{4,11}$/;

// The launcher opens the console with its private token in the hash, used only for first-time setup.
let token=null;
function takeToken(){
  const hash=location.hash.slice(1);
  if(hash.length<=30||pages[hash]||aliases[hash])return false;
  token=hash;history.replaceState(null,'',location.pathname+location.search);return true;
}
takeToken();

let current=null,pollTimer=null;

/* Helpers */
async function api(route,body,{signal,timeout=['runtime/action','features'].includes(route)?90000:route==='models'?60000:30000}={}){
  const deadline=AbortSignal.timeout(timeout);
  let response;
  try{response=await fetch('/console/api/'+route,{method:body?'POST':'GET',cache:'no-store',signal:signal?AbortSignal.any([signal,deadline]):deadline,
    headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
  catch(error){if(signal?.aborted)throw new Error('测试已取消，配置已保存');if(deadline.aborted)throw new Error('请求超时，请检查服务状态后重试');throw error;}
  let value={};try{value=await response.json();}catch{if(signal?.aborted)throw new Error('测试已取消，配置已保存');if(deadline.aborted)throw new Error('请求超时，请检查服务状态后重试');throw new Error('服务返回了无效响应，请刷新后重试');}
  if(response.status===401&&!route.startsWith('auth')){boot();throw new Error(value.error||'请重新登录');}
  if(!response.ok)throw Object.assign(new Error(value.error||'请求失败'),{status:response.status});
  return value;
}
let toastTimer;
function toast(message,error=false){
  const element=$('toast');element.textContent=message;element.className='toast'+(error?' error':'');element.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>element.hidden=true,error?6000:3500);
}
async function busy(button,task){
  if(button.classList.contains('busy'))return;
  button.classList.add('busy');button.disabled=true;
  try{return await task();}catch(error){if(error.message)toast(error.message,true);}
  finally{button.classList.remove('busy');button.disabled=false;}
}
// A form's submit: its button spins while the task runs.
const onSubmit=(form,task)=>{form.addEventListener('submit',event=>{event.preventDefault();busy(event.submitter||form.querySelector('button[type=submit]'),task);});};
const el=(tag,props={},...children)=>{const node=Object.assign(document.createElement(tag),props);node.append(...children.filter(x=>x!=null&&x!==false));return node;};
const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;};
const empty=text=>el('p',{className:'empty'},text);
const clock=seconds=>new Date(seconds*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
const shortDate=seconds=>new Date(seconds*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const ago=seconds=>{if(!seconds)return '—';const m=Math.max(0,(Date.now()/1000-seconds)/60);return m<60?`${Math.round(m)} 分钟前`:m<1440?`${Math.round(m/60)} 小时前`:`${Math.round(m/1440)} 天前`;};
function fillSelect(select,values,label,value){
  const list=[...new Set([...values,value])].filter(v=>v!=null).sort((a,b)=>a-b);
  select.replaceChildren(...list.map(v=>el('option',{value:v,selected:v===value},label(v))));
}
const durationLabel=minutes=>minutes%1440===0?`${minutes/1440} 天`:minutes%60===0?`${minutes/60} 小时`:`${minutes} 分钟`;
const hours=[...Array(24).keys()],hourLabel=h=>`${h}:00`;
const setDisabled=(root,disabled)=>root.querySelectorAll('input,select,button,textarea').forEach(x=>x.disabled=disabled);
const numberOf=id=>{const input=$(id);if(!input.checkValidity()){input.reportValidity();throw new Error('');}return Number(input.value);};
const chatLabelOf=t=>(t.group?'群 · ':'好友 · ')+t.name;

/* Sign-in */
let loginMode='login';
function showLogin(mode){
  loginMode=mode;stopPolling();
  $('boot').hidden=true;$('app').hidden=true;$('login').hidden=false;
  const setup=mode==='setup',blocked=mode==='need-token';
  $('login-hint').textContent=setup?'第一次使用，先设置一个控制台密码':blocked?'还没有设置密码。请从托盘启动器或 Console.cmd 打开控制台完成首次设置。':'输入控制台密码';
  $('login-confirm-field').hidden=!setup;
  $('login-password').autocomplete=setup?'new-password':'current-password';
  $('login-password').disabled=blocked;$('login-submit').disabled=blocked;
  $('login-submit').textContent=setup?'设置密码并进入':'登录';
  $('login-error').textContent='';$('login-password').value='';$('login-confirm').value='';
  if(!blocked)$('login-password').focus();
}
$('login-form').onsubmit=event=>{
  event.preventDefault();
  const password=$('login-password').value;$('login-error').textContent='';
  if(password.length<6){$('login-error').textContent='密码至少 6 个字符';return;}
  if(loginMode==='setup'&&password!==$('login-confirm').value){$('login-error').textContent='两次输入的密码不一致';return;}
  busy($('login-submit'),async()=>{
    try{await api(loginMode==='setup'?'auth/setup':'auth/login',{password});}
    catch(error){$('login-error').textContent=error.message;return;}
    token=null;start();
  });
};
$('logout').onclick=async()=>{try{await api('auth/logout',{});}catch{}current=null;boot();};

/* Routing */
const dirty=()=>({moderation:!$('moderation-bar').hidden,model:modelDirty||routesDirty,chats:chatsDirty}[current]);
function pageFromHash(){const hash=location.hash.slice(1);return pages[hash]?hash:aliases[hash]||'overview';}
function route(){
  const page=pageFromHash();
  if(location.hash.slice(1)!==page)history.replaceState(null,'','#'+page);
  if(current===page)return;
  current=page;
  for(const section of $$('.page'))section.hidden=section.dataset.page!==page;
  for(const link of $$('.nav a'))link.dataset.page===page?link.setAttribute('aria-current','page'):link.removeAttribute('aria-current');
  $('page-title').textContent=pages[page][0];$('page-sub').textContent=pages[page][1];
  renderPageActions();
  $('app').querySelector('.main').scrollTop=0;
  const enter={overview:refreshOverview,activity:enterActivity,usage:enterUsage,chats:enterChats,persona:enterPersona,abilities:enterAbilities,
    rhythm:enterRhythm,model:enterModel,moderation:enterModeration,qq:()=>openEmbed(),settings:enterSettings}[page];
  enter().catch(error=>toast(error.message,true));
  schedulePolling();
}
window.addEventListener('hashchange',()=>{
  if(takeToken()){current=null;boot();return;}
  if(pageFromHash()===current)return;
  if(dirty()){
    if(!confirm('当前页面有未保存的改动，确定离开吗？')){history.replaceState(null,'','#'+current);return;}
    modelDirty=false;routesDirty=false;chatsDirty=false;$('moderation-bar').hidden=true;
  }
  route();
});
function renderPageActions(){
  const actions=$('page-actions');actions.replaceChildren();
  const button=(label,handler,name)=>{const b=el('button',{type:'button',className:'btn small ghost'},...(name?[icon(name)]:[]),label);b.onclick=()=>busy(b,handler);actions.append(b);};
  if(current==='qq'){button('重新连接',()=>openEmbed(true),'refresh');button('新窗口打开',async()=>window.open('/console/integrations/napcat','_blank','noopener'),'ext');}
  if(['activity','usage','abilities','rhythm'].includes(current))button('刷新',{activity:enterActivity,usage:enterUsage,abilities:enterAbilities,rhythm:enterRhythm}[current],'refresh');
}

/* Polling: the overview and activity refresh every 5 s while visible, the sidebar status every 20 s. */
function stopPolling(){clearTimeout(pollTimer);pollTimer=null;}
function schedulePolling(){
  stopPolling();
  pollTimer=setTimeout(async()=>{
    if(!document.hidden){try{if(current==='overview')await refreshOverview();else if(current==='activity')await refreshActivity();else await refreshBrand();}catch{}}
    schedulePolling();
  },['overview','activity'].includes(current)?5000:20000);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('app').hidden&&current==='overview')refreshOverview().catch(()=>{});});

/* Overview */
let overview=null;
function botState(o){
  const b=o.bot||{};
  if(b.state!=='active')return {tone:'bad',label:'机器人引擎离线',sub:b.error||'正在重启，或尚未启动'};
  // NapCat still says "logged in" after Tencent drops the session, so this stays up until messages arrive again.
  if(b.kickedAt)return {tone:'bad',label:'QQ 被踢下线了',sub:`${shortDate(b.kickedAt)} 被腾讯踢下线，收不到也发不出消息。到「QQ 登录」用机器人的手机 QQ 重新扫码；扫完收到新消息后这里自动恢复。`};
  if(!b.connected)return {tone:'warn',label:'未连接 QQ',sub:o.supervisor?.qqLoggedIn?'QQ 已登录，正在自动连接…':'到「QQ 登录」页扫码登录机器人的 QQ'};
  if(b.running&&o.availability?.limited)return {tone:'warn',label:'模型限流，等待恢复',sub:`模型服务返回 429，还需等待约 ${o.availability.retryAfter} 秒；QQ 连接正常。`};
  const scope=`私聊 ${b.targets.private} 个 · 群 ${b.targets.group} 个`;
  if(b.running)return {tone:'ok',label:'正在回复',sub:`QQ ${b.account} · ${scope}`};
  return {tone:'idle',label:'已暂停回复',sub:`QQ ${b.account} 已连接 · ${scope}`};
}
async function refreshBrand(){overview=await api('overview');renderBrand();}
function renderBrand(){const state=botState(overview);$('brand-status').replaceChildren(el('i',{className:'dot '+state.tone}),el('span',{},state.label));}
async function refreshOverview(){
  overview=await api('overview');renderBrand();
  const o=overview,b=o.bot||{},state=botState(o);
  $('ov-dot').className='dot big '+state.tone;$('ov-state').textContent=state.label;$('ov-sub').textContent=state.sub;
  $('ov-dot').closest('.hero').dataset.tone=state.tone;
  const toggle=$('ov-toggle');
  if(!toggle.classList.contains('busy')){
    toggle.disabled=!(b.state==='active'&&b.connected)||b.busy;
    toggle.textContent=b.running?'暂停回复':'开始回复';toggle.className='btn '+(b.running?'':'primary');
  }
  const issue=b.error||o.supervisor?.error||'';
  $('ov-error').hidden=!issue;$('ov-error').textContent=issue;
  $('st-calls').textContent=b.calls??'–';$('st-calls-sub').textContent=b.dailyLimit?`每日上限 ${b.dailyLimit}`:'';
  $('st-sent').textContent=b.confirmed??'–';$('st-sent-sub').textContent=b.sendLimit?`每日上限 ${b.sendLimit}`:'';
  const calls=(o.recentMetrics||[]).filter(m=>m.ok&&['chat','director'].includes(m.purpose)).slice(0,10);
  $('st-latency').textContent=calls.length?(calls.reduce((s,m)=>s+m.ms,0)/calls.length/1000).toFixed(1)+' 秒':'–';
  $('st-latency-sub').textContent=calls.length?`最近 ${calls.length} 次指挥调用`:'还没有调用';
  const lead=o.director||{model:o.model,provider:o.provider};
  $('st-model').textContent=lead.model||'–';$('st-model').title=lead.model||'';
  $('st-provider').textContent=(providerNames[lead.provider]||'')+(o.operator?' · 助手 '+o.operator.model:'');
  const records=(b.records||[]).map(r=>{
    const tone={confirmed:'ok',failed:'bad',uncertain:'warn'}[r.state]||'';
    return el('li',{},el('time',{},clock(r.timestamp)),el('span',{className:'who',title:r.target},r.target||'—'),el('span',{className:'what'},el('b',{className:tone},r.title),r.detail));
  });
  $('ov-records').replaceChildren(...(records.length?records:[el('li',{className:'empty'},'还没有运行记录')]));
  const napState={running:'运行中',exited:'已停止',restarting:'重启中',created:'未启动',paused:'已暂停'}[o.napcat?.state];
  $('sv-account').textContent=b.account||'—';
  $('sv-napcat').textContent=napState||o.napcat?.error||'未知';
  $('sv-engine').textContent=b.state==='active'?(b.status||'运行中'):(b.error||'离线');
  $('sv-targets').textContent=b.targets?`私聊 ${b.targets.private} · 群 ${b.targets.group}（名单共 ${b.targets.total}）`:'—';
  $('sv-memory').textContent=b.memoryStatus||'—';
  const kicks=b.kicks||[];
  $('kicks-card').hidden=!kicks.length;$('kicks-count').textContent=String(kicks.length);
  $('kicks-list').replaceChildren(...kicks.map(k=>el('li',{},el('strong',{},shortDate(k.at)),el('small',{},`被踢前一小时发了 ${k.sendsLastHour} 条，前十分钟 ${k.sendsLastTenMinutes} 条`))));
  const removed=b.removedTargets||[];
  $('removed-card').hidden=!removed.length;$('removed-count').textContent=String(removed.length);
  $('removed-list').replaceChildren(...removed.map(r=>el('li',{},el('strong',{},`${r.group?'群':'好友'} · ${r.name||r.number}`),el('small',{},`${shortDate(r.removedAt)} · ${r.reason}`))));
}
$('ov-toggle').onclick=()=>busy($('ov-toggle'),async()=>{
  const result=await api('runtime/action',{action:overview?.bot?.running?'bot-pause':'bot-resume'});
  toast(result.message);await refreshOverview();
});
for(const button of $$('[data-runtime]'))button.onclick=()=>{
  const name={'bot-restart':'重启机器人','napcat-restart':'重启 NapCat'}[button.dataset.runtime];
  if(!confirm(`确定${name}吗？期间机器人会离线一小会儿。`))return;
  busy(button,async()=>{const result=await api('runtime/action',{action:button.dataset.runtime});toast(result.message);await refreshOverview();});
};

/* Activity: what the agent did, where each message went, what it read */
let agentData=null,activityTab='turns';
const agentDecisions={reply:['出声','ok'],silence:['没出声',''],wait:['等一等','accent'],failed:['出错','bad'],thinking:['正在想','warn']};
const errandNames={search_chat_history:'翻聊天记录',look_at_image:'看图',ask_helper:'查资料',browse_bilibili:'刷 B 站',manage_chat:'聊天管理',model_info:'查模型',find_artwork:'找插画',save_sticker:'存表情',notify_owner:'通知主人',member_info:'查群友',group_info:'看群资料',remember:'记下来',read_qq_history:'翻 QQ 记录',send_to_chat:'去别处说',computer_task:'操作电脑',write_note:'记笔记',delete_note:'删笔记',send_message:'发消息',search_stickers:'搜表情包',send_sticker:'发表情包',react:'贴表情',search_reactions:'搜贴表情',poke:'戳一戳',like:'点赞',recall:'撤回',send_voice:'发语音',draw_image:'画图',send_artwork:'发插画',set_reminder:'定时',cancel_reminder:'取消定时',check_new_messages:'看新消息',wait:'等一等'};
const levelNames={basic:'基础',standard:'标准',full:'完全'};
async function enterActivity(){await refreshActivity(true);}
async function refreshActivity(all=false){
  const jobs=[api('agent').then(d=>{agentData=d;renderAgent();})];
  if(all||activityTab==='decisions')jobs.push(api('overview').then(o=>{overview=o;renderBrand();renderDecisions();}));
  if(all||activityTab==='reading')jobs.push(loadReading());
  await Promise.all(jobs);
}
for(const tab of $$('[data-activity-tab]'))tab.onclick=()=>{activityTab=tab.dataset.activityTab;showActivityTab();refreshActivity().catch(e=>toast(e.message,true));};
function showActivityTab(){
  for(const tab of $$('[data-activity-tab]'))tab.setAttribute('aria-selected',String(tab.dataset.activityTab===activityTab));
  for(const panel of $$('[data-activity-panel]'))panel.hidden=panel.dataset.activityPanel!==activityTab;
  $('turn-filters').hidden=activityTab!=='turns';$('decision-filter').hidden=activityTab!=='decisions';
}
showActivityTab();
function renderAgent(){
  const states=agentData.states||[],turns=agentData.turns||[],hour=Date.now()/1000-3600,now=Date.now()/1000;
  const recent=turns.filter(t=>t.at>=hour),spoke=recent.filter(t=>t.decision==='reply').length;
  const card=(label,value,sub)=>el('div',{className:'card stat'},el('span',{},label),el('strong',{},String(value)),el('small',{},sub));
  $('agent-stats').replaceChildren(
    card('会话',states.length,`名单里共 ${agentData.chats.length} 个`),
    card('正在想',states.filter(s=>s.thinkingSince).length,'正在看一批消息'),
    card('在攒新消息',states.filter(s=>s.pending).length,'安静 2 秒后交给它'),
    card('最近一小时',recent.length?`${spoke}/${recent.length}`:'0',recent.length?'出声的批次 / 看过的批次':'还没看过消息'));
  const issue=!agentData.connected?'QQ 没连上，代理在等。到「QQ 登录」看看。':!agentData.running?'回复暂停中，代理不会出声。到「总览」开始回复。':'';
  $('agent-banner').hidden=!issue;$('agent-banner').textContent=issue;
  const rows=states.map(s=>{
    const working=s.thinkingSince?['正在想 '+Math.max(1,Math.round(now-s.thinkingSince))+' 秒','warn']:s.pending?['攒了 '+s.pending+' 条','accent']:null;
    const last=s.lastAt?clock(s.lastAt)+' '+(agentDecisions[s.lastDecision]||[s.lastDecision])[0]:'还没看过';
    return {working:!!working,node:el('div',{className:'state-row'+(working?'':' idle')},el('span',{className:'name',title:s.chat},s.chat),
      working?el('span',{className:'badge '+working[1]},working[0]):el('span',{className:'muted small'},last))};
  }).sort((x,y)=>y.working-x.working);
  $('agent-states').replaceChildren(...(rows.length?rows.map(r=>r.node):[empty('名单里还没有启用的会话。')]));
  const notes=(agentData.notes||[]).map(n=>el('div',{className:'state-row'},el('span',{className:'name',title:n.text},n.text),el('span',{className:'muted small'},n.chat)));
  $('agent-notes').replaceChildren(...(notes.length?notes:[empty('还没有。它会把要跟进的事、对人和群的印象记在这里。')]));
  const reminders=(agentData.reminders||[]).map(r=>el('div',{className:'state-row'},el('span',{className:'name',title:r.chat+'：'+r.about},r.about),el('span',{className:'muted small'},r.chat+' · '+clock(r.due))));
  $('agent-reminders').replaceChildren(...(reminders.length?reminders:[empty('没有。有人让它过一会儿提醒或回访时会出现在这里。')]));
  const select=$('agent-filter-chat'),value=select.value,names=[...new Set(turns.map(t=>t.chat))];
  select.replaceChildren(el('option',{value:''},'全部会话'),...names.map(n=>el('option',{value:n,selected:n===value},n)));
  renderTurns();
}
function renderTurns(){
  const chat=$('agent-filter-chat').value,kind=$('agent-filter-kind').value;
  const turns=(agentData?.turns||[]).filter(t=>(!chat||t.chat===chat)&&(!kind||t.decision===kind)).slice(0,40);
  const open=new Set($$('#agent-turns details[open]').map(d=>d.dataset.id));
  $('agent-turns').replaceChildren(...(turns.length?turns.map(t=>{
    const [label,tone]=agentDecisions[t.decision]||[t.decision,''];
    const meta=[t.decision==='thinking'?'':Math.round(t.seconds)+' 秒',t.tokens?t.tokens.toLocaleString()+' tokens':''].filter(Boolean).join(' · ');
    const parts=[el('div',{className:'turn-head'},el('span',{className:'badge '+tone},label),el('strong',{title:t.chat},t.chat),el('time',{},clock(t.at)),el('span',{className:'muted small'},meta)),
      el('ul',{className:'turn-batch'},...t.batch.map(line=>el('li',{},line)))];
    if(t.errands?.length){
      const d=el('details',{className:'turn-errands'},el('summary',{},'做了 '+t.errands.length+' 步：'+t.errands.map(e=>errandNames[e.tool]||e.tool).join('、')),
        ...t.errands.map(e=>el('div',{className:'errand'},el('p',{},el('b',{},errandNames[e.tool]||e.tool),' ',el('span',{className:'muted small mono'},e.detail)),el('pre',{},e.result))));
      d.dataset.id=t.id;if(open.has(t.id))d.open=true;parts.push(d);
    }
    if(t.sent?.length)parts.push(el('p',{className:'turn-sent'},t.sent.join('；')));
    if(t.note)parts.push(el('p',{className:'turn-note'},'理由：'+t.note));
    return el('article',{className:'turn '+(t.decision||'')},...parts);
  }):[empty(chat||kind?'没有符合条件的记录。':'还没有记录。会话里有新消息时它会看。')]));
}
$('agent-filter-chat').onchange=renderTurns;$('agent-filter-kind').onchange=renderTurns;
function renderDecisions(){
  const onlySkipped=$('decisions-skipped').checked;
  const rows=(overview?.bot?.decisions||[]).filter(d=>!onlySkipped||!d.outcome.startsWith('交给代理')).slice(0,60).map(d=>{
    const tone=d.outcome.startsWith('交给代理')?'ok':'';
    return el('li',{},el('time',{},clock(d.at)),el('span',{className:'who',title:d.chat},`${d.chat} · ${d.speaker||'群友'}`),
      el('span',{className:'what'},el('b',{className:tone},d.outcome),d.text));
  });
  $('ov-decisions').replaceChildren(...(rows.length?rows:[el('li',{className:'empty'},onlySkipped?'最近的消息都交给它看了':'还没有记录')]));
}
$('decisions-skipped').onchange=renderDecisions;
async function loadReading(){
  const data=await api('activity');
  const rows=(data.items||[]).map(item=>el('div',{className:'list-row link'},el('a',{href:item.url,target:'_blank',rel:'noreferrer'},item.title||item.url),
    el('small',{className:'muted'},`${item.evidence||''} · ${new Date(item.at).toLocaleString('zh-CN')}`)));
  $('reading-list').replaceChildren(...(rows.length?rows:[empty('还没有浏览记录。打开「能力 → 联网 → 公开内容探索」后会逐步积累。')]));
}

/* Usage and prices */
let usageTab='stats',usageDays=7,usageMetric='tokens',usageData=null;
const purposeNames={director:'指挥',operator:'助手',chat:'回复',rewrite:'改口吻（旧）',review:'插话校对（旧）',summary:'群聊摘要',memory:'记忆整理',react:'小动作（旧）',imageplan:'画图判断',outreach:'主动聊天（旧）',poke:'戳一戳（旧）',test:'连接测试',video:'看视频',image:'画图'};
const costSources={reported:'Claude Code 自报',priced:'按你填的单价',reference:'按列表价估算',unpriced:'未计价'};
const count=n=>n>=1e8?(n/1e8).toFixed(2)+' 亿':n>=1e4?(n/1e4).toFixed(n>=1e6?0:1)+' 万':Math.round(n).toLocaleString('zh-CN');
const dollars=v=>v===0?'$0':v<0.001?'<$0.001':v<1?'$'+v.toFixed(3):v<1000?'$'+v.toFixed(2):'$'+Math.round(v).toLocaleString('en-US');
const yuan=v=>'≈ ¥'+(v<1?v.toFixed(2):v<1000?v.toFixed(1):Math.round(v).toLocaleString('zh-CN'));
const metricFormat={tokens:count,calls:n=>Math.round(n).toLocaleString('zh-CN'),usd:dollars};
async function enterUsage(){usageData=await api('usage?days='+usageDays);renderUsage();}
for(const tab of $$('[data-usage-tab]'))tab.onclick=()=>{usageTab=tab.dataset.usageTab;renderUsage();};
$$('[data-goto-prices]').forEach(b=>b.onclick=()=>{usageTab='prices';renderUsage();});
for(const tab of $$('[data-days]'))tab.onclick=()=>{usageDays=Number(tab.dataset.days);enterUsage().catch(e=>toast(e.message,true));};
for(const tab of $$('[data-metric]'))tab.onclick=()=>{usageMetric=tab.dataset.metric;renderUsageChart();};
function renderUsage(){
  if(!usageData)return;
  for(const tab of $$('[data-usage-tab]'))tab.setAttribute('aria-selected',String(tab.dataset.usageTab===usageTab));
  for(const tab of $$('[data-days]'))tab.setAttribute('aria-selected',String(Number(tab.dataset.days)===usageDays));
  $('usage-stats').hidden=usageTab!=='stats';$('usage-prices').hidden=usageTab!=='prices';$('usage-range').hidden=usageTab!=='stats';
  if(usageTab==='prices'){renderPrices();return;}
  const u=usageData,t=u.totals;
  $('us-calls').textContent=t.calls.toLocaleString('zh-CN');
  $('us-calls-sub').textContent=t.calls?(t.failures?`失败 ${t.failures} 次`:'全部成功'):'这段时间没有调用';
  $('us-tokens').textContent=count(t.input+t.output);
  $('us-tokens-sub').textContent=`输入 ${count(t.input)} · 输出 ${count(t.output)}`+(t.cached?` · 缓存命中 ${count(t.cached)}`:'');
  $('us-cost').textContent=dollars(t.usd);
  $('us-cost-sub').textContent=yuan(t.usd*u.cnyPerUsd)+(t.unpriced?` · ${t.unpriced} 次未计价`:'');
  $('us-latency').textContent=t.calls?(t.ms/t.calls/1000).toFixed(1)+' 秒':'–';
  $('usage-chart-card').hidden=usageDays===1;
  if(usageDays>1)renderUsageChart();
  table('usage-models',['模型','调用','输入','缓存命中','输出','花费','计费'],u.models.map(m=>el('tr',{},
    el('td',{},el('span',{className:'mono'},m.model),el('small',{},providerNames[m.provider]||m.provider)),
    el('td',{className:'num'},m.calls.toLocaleString('zh-CN')),el('td',{className:'num'},count(m.input)),el('td',{className:'num'},count(m.cached)),el('td',{className:'num'},count(m.output)),
    el('td',{className:'num'},dollars(m.usd)),el('td',{},el('span',{className:'badge '+(m.costSource==='unpriced'?'':'ok')},costSources[m.costSource]+(m.costSource==='reference'&&m.referencePrice?.estimated?'（估）':''))))),'这段时间没有调用',[1,2,3,4,5]);
  table('usage-purposes',['用途','调用','失败','Tokens','花费'],u.purposes.map(p=>el('tr',{},el('td',{},purposeNames[p.purpose]||p.purpose),
    el('td',{className:'num'},p.calls.toLocaleString('zh-CN')),el('td',{className:'num'},p.failures?String(p.failures):'–'),el('td',{className:'num'},count(p.tokens)),el('td',{className:'num'},dollars(p.usd)))),'这段时间没有调用',[1,2,3,4]);
  table('usage-chats',['会话','调用','Tokens','花费'],u.chats.map(c=>el('tr',{},el('td',{className:'clip',title:c.chat},c.chat),
    el('td',{className:'num'},c.calls.toLocaleString('zh-CN')),el('td',{className:'num'},count(c.tokens)),el('td',{className:'num'},dollars(c.usd)))),'还没有按会话记下的调用',[1,2,3]);
}
// `numeric` lists the columns holding numbers: those headers line up right, like their cells.
function table(id,head,rows,emptyText,numeric=[]){
  $(id).replaceChildren(el('thead',{},el('tr',{},...head.map((h,i)=>el('th',{className:numeric.includes(i)?'num':''},h)))),
    el('tbody',{},...(rows.length?rows:[el('tr',{},el('td',{colSpan:head.length,className:'empty'},emptyText))])));
}
function renderUsageChart(){
  for(const tab of $$('[data-metric]'))tab.setAttribute('aria-selected',String(tab.dataset.metric===usageMetric));
  const days=usageData.daily,format=metricFormat[usageMetric],box=$('usage-chart');
  $('usage-chart-title').textContent={tokens:'每天的 tokens',calls:'每天的模型调用',usd:'每天的花费'}[usageMetric];
  const width=Math.max(280,box.clientWidth),height=220,left=52,right=8,top=12,bottom=26;
  const max=Math.max(0,...days.map(d=>d[usageMetric]));
  const nice=v=>{if(v<=0)return 1;const e=10**Math.floor(Math.log10(v)),f=v/e;return (f<=1?1:f<=2?2:f<=5?5:10)*e;};
  const ceiling=nice(max),plot=height-top-bottom,slot=(width-left-right)/days.length,bar=Math.min(22,slot*0.6);
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  const node=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('width',width);svg.setAttribute('height',height);
  svg.setAttribute('role','img');svg.setAttribute('aria-label',$('usage-chart-title').textContent);
  for(const fraction of [0,0.5,1]){
    const y=top+plot-plot*fraction;
    svg.append(node('line',{x1:left,x2:width-right,y1:y,y2:y,class:'grid'}),node('text',{x:left-8,y:y+4,class:'tick','text-anchor':'end'},format(ceiling*fraction)));
  }
  const tip=el('div',{className:'chart-tip',hidden:true});
  const every=days.length>14?5:1;
  days.forEach((d,i)=>{
    const x=left+slot*i+slot/2,h=d[usageMetric]>0?Math.max(2,plot*d[usageMetric]/ceiling):0,y=top+plot-h,r=Math.min(4,h,bar/2);
    if(h>0)svg.append(node('path',{class:'bar',d:`M${x-bar/2},${top+plot}V${y+r}Q${x-bar/2},${y} ${x-bar/2+r},${y}H${x+bar/2-r}Q${x+bar/2},${y} ${x+bar/2},${y+r}V${top+plot}Z`}));
    const label=d.date.slice(5).replace('-','/'),last=i===days.length-1;
    if((days.length-1-i)%every===0)svg.append(node('text',{x:last?Math.min(width-right,x+slot/2):x,y:height-8,class:'tick','text-anchor':last?'end':'middle'},label));
    const hit=node('rect',{x:x-slot/2,y:top,width:slot,height:plot,class:'hit',tabindex:0,'aria-label':`${label}：调用 ${d.calls} 次，tokens ${count(d.tokens)}，花费 ${dollars(d.usd)}`});
    const show=()=>{
      tip.replaceChildren(el('strong',{},label),el('span',{},`调用 ${d.calls} 次`),el('span',{},`Tokens ${count(d.tokens)}`),el('span',{},`花费 ${dollars(d.usd)}`));
      tip.hidden=false;const rect=box.getBoundingClientRect(),scale=rect.width/width;
      tip.style.left=Math.min(rect.width-140,Math.max(0,x*scale-70))+'px';tip.style.top=Math.max(0,(y-8)*scale-78)+'px';hit.classList.add('on');
    };
    const hide=()=>{tip.hidden=true;hit.classList.remove('on');};
    hit.addEventListener('pointerenter',show);hit.addEventListener('pointerleave',hide);hit.addEventListener('focus',show);hit.addEventListener('blur',hide);
    svg.append(hit);
  });
  const numbers=el('table',{className:'table'},el('thead',{},el('tr',{},el('th',{},'日期'),el('th',{className:'num'},'调用'),el('th',{className:'num'},'Tokens'),el('th',{className:'num'},'花费'))),
    el('tbody',{},...days.map(d=>el('tr',{},el('td',{},d.date),el('td',{className:'num'},String(d.calls)),el('td',{className:'num'},count(d.tokens)),el('td',{className:'num'},dollars(d.usd))))));
  box.replaceChildren(svg,tip,el('details',{className:'chart-table'},el('summary',{},'查看每天的数字'),numbers));
}
// Redraw at the new width instead of stretching the drawing, so text and bars keep their size.
let chartWidth=0;
new ResizeObserver(([entry])=>{
  const width=Math.round(entry.contentRect.width);
  if(width&&width!==chartWidth&&current==='usage'&&usageTab==='stats'&&usageData&&usageDays>1){chartWidth=width;renderUsageChart();}
}).observe($('usage-chart'));
function renderPrices(){
  const rows=(usageData.priceList||[]).map(m=>{
    const key=`${m.provider}|${m.model}`,ref=m.referencePrice;
    const input=name=>el('input',{type:'number',min:0,max:10000,step:'0.001',inputMode:'decimal',value:m.price?.[name]??'',placeholder:ref?.[name]!=null?String(ref[name]):'未填',
      'aria-label':`${m.model} ${({input:'输入',cachedInput:'缓存输入',output:'输出'})[name]}单价`,name});
    const fields=['input','cachedInput','output'].map(input);
    const save=el('button',{type:'button',className:'btn small primary'},'保存');
    const clear=el('button',{type:'button',className:'btn small ghost',hidden:!m.price},'恢复列表价');
    save.onclick=()=>busy(save,async()=>{
      const price=Object.fromEntries(fields.filter(f=>f.value!=='').map(f=>[f.name,f.value]));
      await api('usage/price',{key,price:Object.keys(price).length?price:null});await enterUsage();toast(Object.keys(price).length?'单价已保存':'已改回列表价');
    });
    clear.onclick=()=>busy(clear,async()=>{await api('usage/price',{key,price:null});await enterUsage();toast('已改回列表价');});
    const source=m.price?'你填的':ref?(ref.estimated?'列表价（估）':'列表价'):'没有内置价格';
    return el('tr',{},el('td',{},el('span',{className:'mono'},m.model),el('small',{},`${providerNames[m.provider]} · ${source}`)),
      ...fields.map(f=>el('td',{},f)),el('td',{},el('div',{className:'actions'},save,clear)));
  });
  table('price-table',['模型','输入','缓存输入','输出',''],rows,'还没有 Codex 或云端 API 的模型');
  if(document.activeElement!==$('usage-rate'))$('usage-rate').value=usageData.cnyPerUsd;
}
onSubmit($('usage-rate-form'),async()=>{await api('usage/rate',{rate:Number($('usage-rate').value)});await enterUsage();toast('汇率已保存');});

/* Engine settings shared by several pages */
let engine=null;
const loadEngine=async()=>(engine=await api('engine'));
const engineAction=async(action,values={})=>(engine=await api('engine',{action,...values},{timeout:action==='importSticker'?70000:30000}));

/* Feature switches: wherever a [data-feature] switch is, it turns that ability on or off at once. */
let features=[];
async function loadFeatures(){features=(await api('features')).features;renderFeatureSwitches();}
function renderFeatureSwitches(){
  const byId=Object.fromEntries(features.map(f=>[f.id,f]));
  for(const input of $$('[data-feature]')){
    const f=byId[input.dataset.feature];if(!f)continue;
    if(!input.classList.contains('busy')){input.checked=f.enabled;input.disabled=!f.available&&!f.enabled;}
  }
  for(const note of $$('[data-reason]'))note.textContent=byId[note.dataset.reason]?.reason||'';
  renderAbilityIndex();
}
for(const input of $$('[data-feature]'))input.addEventListener('change',async()=>{
  const id=input.dataset.feature,wanted=input.checked;
  input.classList.add('busy');input.disabled=true;
  try{
    features=(await api('features',{features:{[id]:wanted}})).features;
    const name=features.find(f=>f.id===id)?.name||'';
    toast(`${name}已${wanted?'打开':'关闭'}`);
    if(engine)await loadEngine().then(()=>{if(current==='abilities')renderAbilities();if(current==='persona')renderStickers(true);}).catch(()=>{});
  }catch(error){input.checked=!wanted;toast(error.message,true);}
  finally{input.classList.remove('busy');renderFeatureSwitches();}
});

/* Chats */
let chatsDirty=false;
async function enterChats(){chatsDirty=false;await Promise.all([loadEngine(),api('agent').then(d=>agentData=d)]);renderChats();}
function renderChats(){
  const levels=new Map(agentData.chats.map(c=>[c.key,c.level]));
  const styles=[{id:'',name:'跟随默认'},...engine.personalities];
  $('chats-rows').replaceChildren(...(engine.targets.length?engine.targets.map(t=>{
    const enabled=el('input',{type:'checkbox',className:'chat-enabled',checked:t.enabled});enabled.dataset.key=t.key;enabled.setAttribute('aria-label','启用：'+t.name);
    const level=el('select',{className:'chat-level'},...Object.entries(levelNames).map(([v,n])=>el('option',{value:v,selected:v===(levels.get(t.key)||'full')},n)));level.dataset.key=t.key;
    const style=el('select',{className:'chat-style'},...styles.map(s=>el('option',{value:s.id,selected:s.id===(t.personaStyle||''),title:s.description||''},s.name)));style.dataset.key=t.key;
    for(const input of [enabled,level,style])input.addEventListener('change',()=>{chatsDirty=true;});
    const reset=el('button',{type:'button',className:'btn small ghost'},'清空记忆');
    reset.onclick=()=>{if(confirm(`清空「${t.name}」的上下文和长期记忆？其他会话不受影响，机器人不会暂停。`))busy(reset,async()=>{await engineAction('resetMemory',{target:t.key});toast('已清空');});};
    const remove=el('button',{type:'button',className:'btn small ghost danger'},'移除');
    remove.onclick=()=>{if(confirm(`把「${t.name}」移出名单？之后不再在这里说话，可以随时加回来。`))busy(remove,async()=>{await engineAction('remove',{target:t.key});await enterChats();toast('已移除');});};
    return el('tr',{},el('td',{},enabled),el('td',{},el('strong',{},chatLabelOf(t)),el('small',{className:'muted block'},t.number)),el('td',{},level),el('td',{},style),el('td',{className:'row-actions'},reset,remove));
  }):[el('tr',{},el('td',{colSpan:5,className:'empty'},'名单是空的，从下面添加。'))]));
  renderContacts();
}
function renderContacts(){
  const query=$('chats-search').value.trim().toLowerCase();
  const rows=engine.contacts.filter(c=>!query||c.name.toLowerCase().includes(query)||c.number.includes(query)).slice(0,20).map(c=>{
    const add=el('button',{type:'button',className:'btn small'},'添加');
    add.onclick=()=>busy(add,async()=>{await engineAction('add',{target:c.key});await enterChats();toast(`已添加「${c.name}」，记得勾选启用后保存`);});
    return el('div',{className:'state-row'},el('span',{className:'name'},chatLabelOf(c),el('small',{className:'muted'},c.number)),add);
  });
  $('chats-contacts').replaceChildren(...(rows.length?rows:[empty(query?'没有匹配的好友或群。':'好友和群都已经在名单里了。')]));
}
$('chats-search').addEventListener('input',()=>engine&&renderContacts());
onSubmit($('chats-form'),async()=>{
  const enabled=$$('#chats-rows .chat-enabled').filter(x=>x.checked).map(x=>x.dataset.key);
  const levels=Object.fromEntries($$('#chats-rows .chat-level').map(s=>[s.dataset.key,s.value]));
  await engineAction('save',{enabled});
  agentData=await api('agent',{levels});
  for(const select of $$('#chats-rows .chat-style')){
    const target=engine.targets.find(t=>t.key===select.dataset.key);
    if(target&&(target.personaStyle||'')!==select.value)await engineAction('setPersona',{target:target.key,personaStyle:select.value||'default'});
  }
  chatsDirty=false;await enterChats();toast('已保存，下一批消息起生效');
});

/* Persona, stickers and favourite reactions */
const personaPresets={chat:'你是轻松自然的聊天搭子，认真接住对方的话，通常一两句。可以接梗，但不写动作描写、不套客服语气。',gentle:'你是温柔耐心的陪伴者，先理解再回应，不说教、不强行安慰，不编造亲密关系。熟悉后可以轻轻开玩笑。',banter:'你是嘴快但讲道理的游戏搭子，抓当前话题里的具体矛盾俏皮吐槽，承认自己答错；不攻击身份、身体或家人，认真求助时收起玩笑。'};
const emotionNames={neutral:'平静',joy:'开心',smug:'得意',annoyed:'不满',sad:'难过',sleepy:'困倦',flustered:'害羞',teasing:'调侃'};
let stickerShown=0,reactions=null;
async function enterPersona(){await Promise.all([loadEngine(),loadFeatures(),loadReactions()]);renderPersona();renderStickers(true);}
function renderPersona(){
  const p=engine.persona;
  $('persona-style').replaceChildren(...engine.personalities.map(s=>el('option',{value:s.id,selected:s.id===(p.style||'teasing')},s.name)));
  $('persona-max').value=p.maxCharacters;$('persona-banter').value=String(p.banter??1);
  $('persona-custom-name').value=p.customName||'';$('persona-custom-prompt').value=p.customPrompt||'';
  $('persona-notes').value=engine.ai.prompt||'';
  fillSelect($('persona-repeat'),[6,12,24,48,72,168],v=>v<24?`${v} 小时`:`${v/24} 天`,p.stickerRepeatHours??24);
  syncPersonaFields();
}
function syncPersonaFields(){
  const style=$('persona-style').value,item=engine.personalities.find(s=>s.id===style);
  $('persona-style-help').textContent=item?.description||'';
  $('persona-custom').hidden=style!=='custom';$('persona-banter-row').hidden=style!=='teasing';
}
$('persona-style').onchange=syncPersonaFields;
$$('[data-preset]').forEach(b=>b.onclick=()=>{$('persona-custom-prompt').value=personaPresets[b.dataset.preset];});
onSubmit($('persona-form'),async()=>{
  if($('persona-style').value==='custom'&&!$('persona-custom-prompt').value.trim())throw new Error('自定义性格要写说明');
  const persona={...engine.persona,style:$('persona-style').value,maxCharacters:numberOf('persona-max'),banter:Number($('persona-banter').value),
    customName:$('persona-custom-name').value.trim(),customPrompt:$('persona-custom-prompt').value.trim()};
  await engineAction('save',{persona,ai:{prompt:$('persona-notes').value}});renderPersona();toast('已保存');
});
onSubmit($('sticker-repeat-form'),async()=>{await engineAction('save',{persona:{...engine.persona,stickerRepeatHours:Number($('persona-repeat').value)}});renderPersona();toast('已保存');});
function renderStickers(restart=false){
  const items=engine.stickers,local=items.filter(s=>s.local).length;
  $('stickers-summary').textContent=`共 ${items.length} 张（自带 ${items.length-local}，本机存的 ${local}）。它自己按画面和语境挑；群里管理员也可以让它把图存进来。`;
  if(restart){stickerShown=0;$('stickers-grid').replaceChildren();}
  const next=items.slice(stickerShown,stickerShown+24);
  $('stickers-grid').append(...next.map(s=>el('figure',{className:'sticker',title:[s.context,s.author,s.license].filter(Boolean).join(' · ')},
    el('img',{src:'/console/api/engine/sticker/'+encodeURIComponent(s.id),alt:s.title,loading:'lazy'}),
    el('figcaption',{},el('span',{},s.title),el('small',{className:'muted'},(emotionNames[s.emotion]||s.emotion)+(s.local?' · 本机':''))))));
  stickerShown+=next.length;$('stickers-more').hidden=stickerShown>=items.length;
}
$('stickers-more').onclick=()=>renderStickers();
// A sticker pack carries only descriptions and pictures; nothing in it can act.
async function readStickerPack(file){
  if(!file||file.size<1||file.size>24000000)throw new Error('资源包最多 24 MB。');
  const pack=JSON.parse(await file.text());
  if(pack?.format!=='dafeiyu-stickers'||pack.version!==1||!Array.isArray(pack.items)||pack.items.length<1||pack.items.length>50)throw new Error('请选择有效的表情资源包，每包 1–50 张。');
  return pack.items.map(item=>{
    if(!item||!emotionNames[item.emotion]||typeof item.title!=='string'||!item.title.trim()||typeof item.imageBase64!=='string')throw new Error('资源包内容无效。');
    const sticker={publicSharing:false};for(const key of ['title','emotion','context','source','author','license'])sticker[key]=String(item[key]??'');
    return {name:item.title,payload:{sticker,stickerImage:item.imageBase64}};
  });
}
$('sticker-import').onclick=()=>busy($('sticker-import'),async()=>{
  const files=[...$('sticker-files').files],status=$('sticker-import-status');
  if(!files.length||files.length>50)throw new Error('每次选 1–50 张图片，或一个资源包');
  const pack=files.some(f=>f.name.toLowerCase().endsWith('.json'));
  if(pack&&files.length!==1)throw new Error('资源包请单独导入');
  const meta={emotion:$('sticker-emotion').value,context:$('sticker-context').value.trim(),author:$('sticker-author').value.trim(),license:$('sticker-license').value.trim(),source:$('sticker-source').value.trim(),publicSharing:$('sticker-public').checked};
  const jobs=pack?await readStickerPack(files[0]):await Promise.all(files.map(async file=>{
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>3000000)throw new Error(file.name+'：需要 3 MB 内的 PNG/JPEG/WebP/GIF');
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {name:file.name,payload:{sticker:{...meta,title:file.name.replace(/\.[^.]+$/,'').slice(0,80)},stickerImage:btoa(binary)}};
  }));
  let done=0;const failures=[];
  for(const job of jobs){
    try{await engineAction('importSticker',job.payload);done++;}catch(error){failures.push(job.name+'：'+error.message);}
    status.textContent=`已导入 ${done} / ${jobs.length} 张`;
  }
  status.textContent=`已导入 ${done} 张。`+(failures.length?'\n'+failures.join('\n'):'');
  if(!failures.length)$('sticker-files').value='';
  renderStickers(true);
});
const emojiGlyph={'147':'🍭','128051':'🐳','10068':'❔','120':'👊','182':'😂','76':'👍','271':'🍉','124':'👌','319':'🫶','66':'❤️','63':'🌹','128293':'🔥','128170':'💪','8':'😴','320':'🎉',
  '264':'🤦','269':'👀','299':'🐮','285':'🐟','179':'🐶','106':'🥺','273':'🍋','267':'😵','262':'🤕'};
// The preference is 0–10; the menu offers five steps and names any other saved value by the step it is closest to.
const preferenceSteps=[[0,'不用'],[1,'偶尔'],[2,'普通'],[5,'常用'],[8,'最爱']];
const preferenceLabel=w=>preferenceSteps.reduce((best,step)=>Math.abs(step[0]-w)<Math.abs(best[0]-w)?step:best)[1];
async function loadReactions(){
  try{reactions=await api('reactions');}catch(error){setDisabled($('emoji-form'),true);$('reactions-hint').textContent=error.message;return;}
  setDisabled($('emoji-form'),false);
  $('reactions-emojis').replaceChildren(...reactions.config.emojis.map(emoji=>{
    const select=el('select',{});select.dataset.id=emoji.id;select.setAttribute('aria-label',emoji.name+' 的偏好');
    const levels=preferenceSteps.some(([w])=>w===emoji.weight)?preferenceSteps.map(([w])=>w):[...preferenceSteps.map(([w])=>w),emoji.weight].sort((a,b)=>a-b);
    select.append(...levels.map(w=>el('option',{value:w,selected:w===emoji.weight},preferenceLabel(w))));
    return el('div',{className:'emoji-item'+(emoji.weight===0?' off':''),title:emoji.hint||''},el('span',{className:'glyph'},emojiGlyph[emoji.id]||'·'),el('span',{className:'label'},emoji.name),select);
  }));
}
onSubmit($('emoji-form'),async()=>{await api('reactions',{weights:Object.fromEntries($$('#reactions-emojis select').map(s=>[s.dataset.id,Number(s.value)]))});await loadReactions();toast('已保存');});

/* Abilities: each card holds its switch and its details */
let voiceConfig=null,computerConfig=null;
async function enterAbilities(){
  await Promise.all([loadEngine(),loadFeatures(),
    api('voice').then(v=>voiceConfig=v).catch(error=>{voiceConfig=null;toast(error.message,true);}),
    api('computer').then(c=>computerConfig=c).catch(error=>{computerConfig=null;toast(error.message,true);})]);
  renderAbilities();
}
function renderAbilities(){renderVision();renderDrawing();renderArtwork();renderVoice();renderMemory();renderComputer();renderAbilityIndex();}
// The row of chips at the top: what is on, and a quick way down to it.
function renderAbilityIndex(){
  const on=id=>features.find(f=>f.id===id)?.enabled;
  const state={'ab-web':on('web'),'ab-vision':on('vision'),'ab-draw':on('drawing'),'ab-art':on('artwork'),'ab-memory':on('memory'),
    'ab-voice':voiceConfig?(voiceConfig.enabled&&voiceConfig.keySet)||voiceConfig.qqEnabled!==false:undefined,'ab-computer':computerConfig?computerConfig.enabled:undefined};
  $('ability-index').replaceChildren(...$$('[data-ability]').map(card=>{
    const value=state[card.id],chip=el('button',{type:'button',className:'chip-link'+(value?' on':value===false?' off':'')},el('i',{className:'dot '+(value?'ok':'')}),card.dataset.ability);
    chip.onclick=()=>card.scrollIntoView({behavior:'smooth',block:'start'});
    return chip;
  }));
}
function renderVision(){
  const v=engine.visualTools||{};
  $('vision-provider').value=v.provider||'deepseek';
  $('vision-google-state').textContent=engine.googleVisionCredential?'已载入 Google 凭证':'还没有 Google 凭证';
  $('vision-status').textContent=engine.visualStatus&&!engine.visualStatus.startsWith('尚未')?'最近一次：'+engine.visualStatus:'';
  for(const id of ['vision-persist','draw-persist']){$(id).disabled=!engine.supportsKeychain;if(!engine.supportsKeychain)$(id).checked=false;}
}
onSubmit($('vision-form'),async()=>{
  await engineAction('saveVisualTools',{visualTools:{...engine.visualTools,provider:$('vision-provider').value},googleVisionKey:$('vision-google-key').value,persistVisualCredentials:$('vision-persist').checked});
  $('vision-google-key').value='';await loadFeatures();renderVision();toast('已保存');
});
function renderDrawing(){
  const g=engine.imageGeneration||{},c=engine.imageCredentials||{};
  $('draw-primary').value=g.primary||'codex';$('draw-fallback').checked=g.fallbackEnabled!==false;$('draw-account').value=g.cloudflareAccountID||'';
  $('draw-credentials').textContent=`已载入：智谱 ${c.zhipu?'有':'没有'}，Cloudflare ${c.cloudflare?'有':'没有'}，本机 Codex ${c.codex?'有':'没有'}`;
  $('draw-status').textContent=engine.imageGenerationStatus&&!engine.imageGenerationStatus.startsWith('尚未')?'最近一次：'+engine.imageGenerationStatus:'';
}
onSubmit($('draw-form'),async()=>{
  await engineAction('saveImageGeneration',{imageGeneration:{...engine.imageGeneration,primary:$('draw-primary').value,fallbackEnabled:$('draw-fallback').checked,cloudflareAccountID:$('draw-account').value.trim()},
    zhipuKey:$('draw-zhipu').value,cloudflareToken:$('draw-cloudflare').value,persistImageCredentials:$('draw-persist').checked});
  $('draw-zhipu').value='';$('draw-cloudflare').value='';renderDrawing();toast('已保存');
});
const artFields={'art-daily':'dailyPerChat','art-network':'networkDailyLimit','art-repeat':'repeatDays','art-bookmarks':'searchMinBookmarks','art-hour':'scheduleHour','art-minute':'scheduleMinute','art-long':'minLongEdge','art-short':'minShortEdge'};
function renderArtwork(){
  const a=engine.artwork||{};
  $('art-agent').checked=!!a.agentEnabled;
  for(const [id,key] of Object.entries(artFields))$(id).value=a[key]??'';
  $('art-frequency').value=a.scheduleFrequency||'daily';$('art-mode').value=a.scheduleMode||'hot';$('art-zone').value=a.scheduleTimeZone||'Asia/Shanghai';
  $('art-hour').disabled=$('art-frequency').value==='hourly';
  $('art-permissions').value=Object.entries(a.imagePermissions||{}).map(([id,url])=>`${id} ${url}`).join('\n');
  $('art-status').textContent=engine.artworkStatus&&!engine.artworkStatus.startsWith('插画尚未')?`最近一次：${engine.artworkStatus} · 今天请求来源 ${engine.artworkNetworkCalls} 次`:'';
  $('art-targets').replaceChildren(...(engine.targets.length?engine.targets.map(t=>el('label',{className:'check-item'},el('input',{type:'checkbox',value:t.key,checked:(a.scheduleTargets||[]).includes(t.key)}),
    el('span',{},chatLabelOf(t)+(t.enabled?'':'（没启用，不会发）')))):[empty('名单里还没有会话。')]));
  $('art-artists').replaceChildren(...(engine.artworkArtists.length?engine.artworkArtists.map(artist=>{
    const remove=el('button',{type:'button',className:'btn small ghost danger'},'移除');
    remove.onclick=()=>busy(remove,async()=>{await engineAction('removeArtworkArtist',{artistInput:artist.id});renderArtwork();});
    return el('div',{className:'state-row'},el('span',{className:'name'},el('a',{href:'https://www.pixiv.net/users/'+artist.id,target:'_blank',rel:'noreferrer'},`${artist.name}（${artist.id}）`),el('small',{className:'muted'},artist.deliveryStatus||'')),remove);
  }):[empty('还没有精选画师。')]));
}
$('art-frequency').onchange=()=>{$('art-hour').disabled=$('art-frequency').value==='hourly';};
$('art-artist-add').onclick=()=>busy($('art-artist-add'),async()=>{
  const input=$('art-artist-input').value.trim();if(!input)throw new Error('填 Pixiv 主页链接或数字 ID');
  await engineAction('addArtworkArtist',{artistInput:input});$('art-artist-input').value='';renderArtwork();toast('已添加');
});
onSubmit($('art-form'),async()=>{
  const a=structuredClone(engine.artwork);
  a.agentEnabled=$('art-agent').checked;
  for(const [id,key] of Object.entries(artFields))if(id!=='art-hour')a[key]=numberOf(id);
  if(!$('art-hour').disabled)a.scheduleHour=numberOf('art-hour');
  a.scheduleFrequency=$('art-frequency').value;a.scheduleMode=$('art-mode').value;a.scheduleTimeZone=$('art-zone').value.trim()||'Asia/Shanghai';
  a.scheduleTargets=$$('#art-targets input:checked').map(x=>x.value);
  a.imagePermissions={};
  for(const line of $('art-permissions').value.split('\n').map(x=>x.trim()).filter(Boolean)){const parts=line.split(/\s+/);if(parts.length!==2)throw new Error('授权每行写“画师 ID 空格 HTTPS 链接”');a.imagePermissions[parts[0]]=parts[1];}
  await engineAction('saveArtwork',{artwork:a});renderArtwork();toast('已保存');
});
// The model list follows the way it is called; switching ways swaps a default model for the other's default.
const voiceModels={realtime:['gpt-realtime-2.1-mini','gpt-realtime-2.1'],speech:['gpt-4o-mini-tts','tts-1','tts-1-hd']};
function renderVoice(){
  const v=voiceConfig,form=$('voice-form'),qq=$('qqvoice-form');
  setDisabled(form,!v);setDisabled(qq,!v);
  if(!v){$('voice-badge').textContent='读不到';$('voice-badge').className='badge bad';return;}
  $('voice-enabled').checked=v.enabled;$('voice-key').value='';
  $('voice-key-state').textContent=v.keySet?'已保存一个 Key（不会显示出来）':'还没有 Key';
  $('voice-base').value=v.baseUrl;$('voice-model').value=v.model;$('voice-speed').value=v.speed;$('voice-style').value=v.instructions;
  $('voice-engine').value=v.engine;showVoiceEngine();
  $('qqvoice-enabled').checked=v.qqEnabled!==false;
  fillSelect($('qqvoice-character'),(v.qqVoices||[]).map(x=>x[0]),id=>((v.qqVoices||[]).find(x=>x[0]===id)||[id,id])[1],v.qqCharacter);
  fillSelect($('voice-voice'),v.voices.includes(v.voice)?v.voices:[v.voice,...v.voices],x=>x,v.voice);
  const openAI=v.enabled&&v.keySet,qqOn=v.qqEnabled!==false;
  $('voice-status').textContent=openAI?'已打开':v.keySet?'有 Key，还没打开':'还没有 Key';
  $('voice-badge').textContent=openAI?'OpenAI 声音':qqOn?'群里用 QQ 语音':'关着';$('voice-badge').className='badge '+(openAI||qqOn?'ok':'');
  $('voice-clear').hidden=!v.keySet;
}
function showVoiceEngine(){
  const kind=$('voice-engine').value;
  $('voice-models').replaceChildren(...voiceModels[kind].map(m=>el('option',{value:m})));
  $('voice-engine-help').textContent=kind==='realtime'?'用 OpenAI 的实时语音模型念出来，声音最自然。':'旧的 /audio/speech 接口：OpenAI 已宣布这些模型 2027-01-06 停用，只给只支持它的中转用。';
  $('voice-speed-field').hidden=kind==='realtime';
}
$('voice-engine').onchange=()=>{
  const kind=$('voice-engine').value,other=kind==='realtime'?'speech':'realtime';
  if(!$('voice-model').value||voiceModels[other].includes($('voice-model').value))$('voice-model').value=voiceModels[kind][0];
  showVoiceEngine();
};
const voiceValues=()=>({enabled:$('voice-enabled').checked,engine:$('voice-engine').value,apiKey:$('voice-key').value,baseUrl:$('voice-base').value,model:$('voice-model').value,
  voice:$('voice-voice').value,speed:Number($('voice-speed').value),instructions:$('voice-style').value});
onSubmit($('qqvoice-form'),async()=>{voiceConfig=await api('voice',{qqEnabled:$('qqvoice-enabled').checked,qqCharacter:$('qqvoice-character').value});renderVoice();renderAbilityIndex();toast('已保存');});
onSubmit($('voice-form'),async()=>{voiceConfig=await api('voice',voiceValues());renderVoice();renderAbilityIndex();toast('语音设置已保存');});
$('voice-clear').onclick=()=>{if(confirm('删除已保存的 API Key？OpenAI 语音会随之关闭。'))busy($('voice-clear'),async()=>{voiceConfig=await api('voice',{clearKey:true});renderVoice();renderAbilityIndex();toast('已删除');});};
$('voice-test').onclick=()=>busy($('voice-test'),async()=>{
  // Unsaved edits are saved first, so the preview uses what is on screen.
  voiceConfig=await api('voice',{...voiceValues(),enabled:voiceConfig.enabled&&$('voice-enabled').checked});renderVoice();
  const result=await api('voice/test',{text:$('voice-sample').value},{timeout:70000});
  const player=$('voice-player');player.src='data:'+result.type+';base64,'+result.audio;player.hidden=false;player.play().catch(()=>{});
});
function renderMemory(){
  const m=engine.memoryOptions||{};
  $('memory-messages').value=m.messageThreshold;$('memory-characters').value=m.characterThreshold;$('memory-minutes').value=m.intervalMinutes;$('memory-budget').value=m.retrievalCharacters;
  $('memory-state').textContent=engine.memoryStatus&&engine.memoryStatus!=='记忆等待新消息'?engine.memoryStatus:'';
  const names=Object.fromEntries(engine.targets.map(t=>[t.key,chatLabelOf(t)]));
  $('memory-list').replaceChildren(...(engine.memories.length?engine.memories.map(mem=>{
    const key=mem.key.split(':').slice(1).join(':'),reset=el('button',{type:'button',className:'btn small ghost danger'},'清空');
    reset.onclick=()=>{if(confirm(`清空「${names[key]||key}」的上下文和长期记忆？`))busy(reset,async()=>{await engineAction('resetMemory',{target:key});renderMemory();toast('已清空');});};
    return el('details',{className:'memory-item'},el('summary',{},el('strong',{},names[key]||key),el('small',{className:'muted'},`${mem.items??0} 条记忆 · ${mem.pending??0} 条待整理 · ${shortDate(mem.updatedAt)}`)),
      el('p',{},mem.summary||'（没有摘要）'),el('div',{className:'actions'},reset));
  }):[empty('还没有记忆。')]));
}
onSubmit($('memory-form'),async()=>{
  await engineAction('save',{memoryOptions:{messageThreshold:numberOf('memory-messages'),characterThreshold:numberOf('memory-characters'),intervalMinutes:numberOf('memory-minutes'),retrievalCharacters:numberOf('memory-budget')}});
  renderMemory();toast('已保存');
});
function renderComputer(){
  const c=computerConfig;setDisabled($('computer-form'),!c);
  if(!c){$('computer-badge').textContent='读不到';$('computer-badge').className='badge bad';$('computer-history').replaceChildren();return;}
  $('computer-enabled').checked=c.enabled;$('computer-owner').value=c.owner||'';
  $('computer-badge').textContent=c.enabled?'已打开':'关着';$('computer-badge').className='badge '+(c.enabled?'warn':'');
  const tone={done:'做完',needs_confirmation:'等确认',failed:'失败'};
  const rows=(c.history||[]).slice(0,8).map(h=>el('div',{className:'state-row'},el('span',{className:'name',title:h.task+'\n'+h.output},(h.confirmed?'[已确认] ':'')+h.task),
    el('span',{className:'muted small'},(tone[h.status]||h.status)+' · '+clock(h.at/1000))));
  $('computer-history').replaceChildren(...(rows.length?rows:[empty('还没让它操作过电脑。')]));
}
onSubmit($('computer-form'),async()=>{computerConfig=await api('computer',{enabled:$('computer-enabled').checked,owner:$('computer-owner').value});renderComputer();renderAbilityIndex();toast('已保存');});

/* Rhythm: when it talks, whom it reaches out to, how much it may send */
let timing=null,outreach=null;
async function enterRhythm(){
  await Promise.all([loadEngine(),loadFeatures(),api('timing').then(t=>timing=t),api('outreach').then(o=>outreach=o).catch(error=>{outreach=null;$('outreach-hint').textContent=error.message;})]);
  renderHours();renderOutreach();renderLimits();
}
function renderHours(){
  const ai=engine.ai,quiet=timing.quietHours||{enabled:true,startHour:2,endHour:8};
  $('limit-hours').checked=ai.workHoursEnabled;fillSelect($('limit-start'),hours,hourLabel,ai.workStart??9);fillSelect($('limit-end'),hours,hourLabel,ai.workEnd??22);
  $('quiet-enabled').checked=quiet.enabled;fillSelect($('quiet-start'),hours,hourLabel,quiet.startHour);fillSelect($('quiet-end'),hours,hourLabel,quiet.endHour);
  syncHours();
}
function syncHours(){
  $('limit-start').disabled=$('limit-end').disabled=!$('limit-hours').checked;
  $('quiet-start').disabled=$('quiet-end').disabled=!$('quiet-enabled').checked;
}
$('limit-hours').onchange=syncHours;$('quiet-enabled').onchange=syncHours;
onSubmit($('hours-form'),async()=>{
  await engineAction('save',{ai:{workHoursEnabled:$('limit-hours').checked,workStart:Number($('limit-start').value),workEnd:Number($('limit-end').value)}});
  timing=await api('timing',{quietHours:{enabled:$('quiet-enabled').checked,startHour:Number($('quiet-start').value),endHour:Number($('quiet-end').value)}});
  renderHours();toast('已保存');
});
function renderOutreach(){
  const form=$('outreach-form');setDisabled(form,!outreach);if(!outreach)return;
  const c=outreach.config;
  $('outreach-enabled').checked=c.enabled;
  fillSelect($('outreach-idle'),[360,720,1440,2880,4320,10080],durationLabel,c.idleMinutes);
  fillSelect($('outreach-cooldown'),[720,1440,2880,4320,10080,20160],durationLabel,c.cooldownMinutes);
  fillSelect($('outreach-quiet-start'),hours,hourLabel,c.quietStartHour);fillSelect($('outreach-quiet-end'),hours,hourLabel,c.quietEndHour);
  $('outreach-hint').textContent=!outreach.memoryEnabled?'要先在「能力」里打开长期记忆，不然没有可以跟进的事。':c.enabled&&!outreach.running?'回复暂停时不会主动发。':'';
  const rows=outreach.chats.map(chat=>{
    const box=el('input',{type:'checkbox',checked:!c.excluded.includes(chat.key)});box.dataset.key=chat.key;box.setAttribute('aria-label','参与主动聊天：'+chat.name);
    const state=[`TA 上次说话 ${ago(chat.lastIncoming)}`,chat.lastSent?`上次主动 ${ago(chat.lastSent)}`:'',chat.awaitingReply?'等 TA 回复中':''].filter(Boolean).join(' · ');
    return el('div',{className:'chat-row'},el('label',{},box,el('span',{className:'who'},el('strong',{},chat.name),el('small',{},state))));
  });
  $('outreach-chats').replaceChildren(...(rows.length?rows:[empty('还没有启用的私聊。到「会话」页添加。')]));
}
onSubmit($('outreach-form'),async()=>{
  const excluded=$$('#outreach-chats input[type=checkbox]').filter(x=>!x.checked).map(x=>x.dataset.key);
  outreach=await api('outreach',{enabled:$('outreach-enabled').checked,idleMinutes:Number($('outreach-idle').value),cooldownMinutes:Number($('outreach-cooldown').value),
    quietStartHour:Number($('outreach-quiet-start').value),quietEndHour:Number($('outreach-quiet-end').value),excluded});
  renderOutreach();toast('已保存');
});
function renderLimits(){
  const ai=engine.ai,limits=ai.sendLimits||{};
  $('limits-today').textContent=`今天已调用模型 ${engine.calls??0} 次，已发 ${engine.confirmed??0} 条。`;
  $('limit-calls').value=ai.dailyLimit;$('limit-sends').value=limits.daily??100;$('limit-chat').value=limits.perChatDaily??30;$('limit-interval').value=limits.globalIntervalSeconds??3;$('limit-hourly').value=limits.hourly??90;$('limit-cooldown').value=ai.cooldownSeconds;
}
onSubmit($('limits-form'),async()=>{
  await engineAction('save',{ai:{dailyLimit:numberOf('limit-calls'),cooldownSeconds:numberOf('limit-cooldown'),
    sendLimits:{daily:numberOf('limit-sends'),perChatDaily:numberOf('limit-chat'),globalIntervalSeconds:numberOf('limit-interval'),hourly:numberOf('limit-hourly')}}});
  renderLimits();toast('已保存');
});

/* Model connection */
let modelState=null,selected=null,modelDirty=false,catalogOverride=null,modelTestController=null;
async function enterModel(){
  modelState=await api('state');
  if(!selected)selected=modelState.active;
  if(!modelDirty)loadProfile();
  renderRoutes();
  if(!modelState.catalogs[selected]&&(selected!=='cloud'||modelState.profiles.cloud.hasApiKey))refreshCatalog().catch(()=>{});
}
function renderProviderTabs(){
  for(const tab of $$('[data-provider]')){
    tab.setAttribute('aria-selected',String(tab.dataset.provider===selected));
    tab.querySelector('.dot')?.remove();
    if(tab.dataset.provider===modelState.active)tab.prepend(el('i',{className:'dot ok',title:'当前使用中'}));
  }
}
function loadProfile(){
  const p=modelState.profiles[selected];
  renderProviderTabs();
  $('mf-title').textContent=providerNames[selected];$('mf-help').textContent=providerHelp[selected];
  $('mf-model').value=p.model||'';
  $('fast-row').hidden=selected!=='codex';$('mf-fast').checked=p.serviceTier==='fast';
  $('effort-row').hidden=selected==='cloud';$('mf-effort').value=p.effort||'medium';
  $('cloud-fields').hidden=selected!=='cloud';
  if(selected==='cloud'){
    $('mf-protocol').value=p.protocol;$('mf-base').value=p.baseUrl;$('mf-key').value='';
    $('mf-key-hint').textContent=p.hasApiKey?'已保存密钥。留空保留；更换地址或协议后需重新填写。':'尚未保存 API Key。';
    $('mf-image').value=p.imageModel||'';
  }
  modelDirty=false;catalogOverride=null;renderModelStatus();renderCatalog();
}
function renderModelStatus(){
  const check=modelState.checks[selected],active=modelState.active===selected,p=modelState.profiles[selected];
  const tested=check?.ok&&check.configuredModel===p.model;
  $('mf-badge').className='badge '+(active?'ok':tested?'accent':check&&!check.ok?'bad':'');
  $('mf-badge').textContent=active?'当前使用中':tested?'测试通过':check&&!check.ok?'测试未通过':'';
  $('mf-activate').disabled=modelDirty||active;
  $('mf-activate').textContent=active?'正在使用此连接':'切换到此连接';
  const box=$('mf-test'),available=modelState.availability?.[selected];
  if(available?.limited&&available.retryAt>Date.now()){
    box.className='note bad';box.textContent=`模型服务限流（429），约 ${Math.ceil((available.retryAt-Date.now())/1000)} 秒后可重试。已保存配置；等待期间不会继续请求模型。`;return;
  }
  if(check){box.className='note '+(check.ok?'ok':'bad');box.textContent=check.ok?`测试通过 · ${check.model} · ${(check.ms/1000).toFixed(1)} 秒\n${check.reply}`:`测试未通过：${check.error}`;}
  else{box.className='note';box.textContent='保存后会发一条测试消息验证能否生成，不会发到 QQ。';}
}
function collectProfile(){
  const p={model:$('mf-model').value.trim()};
  if(selected==='codex')p.serviceTier=$('mf-fast').checked?'fast':'default';
  if(selected!=='cloud')p.effort=$('mf-effort').value;
  if(selected==='cloud')Object.assign(p,{protocol:$('mf-protocol').value,baseUrl:$('mf-base').value.trim(),apiKey:$('mf-key').value,imageModel:$('mf-image').value.trim()});
  return p;
}
for(const tab of $$('[data-provider]'))tab.onclick=()=>{
  if(modelTestController||tab.dataset.provider===selected)return;
  if(modelDirty&&!confirm('当前修改尚未保存，放弃修改并切换？'))return;
  selected=tab.dataset.provider;loadProfile();
  if(!modelState.catalogs[selected]&&(selected!=='cloud'||modelState.profiles.cloud.hasApiKey))refreshCatalog().catch(()=>{});
};
$('model-form').addEventListener('input',event=>{
  modelDirty=true;if(['mf-base','mf-protocol','mf-key'].includes(event.target.id))catalogOverride=null;
  $('mf-activate').disabled=true;
});
$('model-form').onsubmit=event=>{
  event.preventDefault();
  if(!$('mf-model').value.trim()){toast('请先选择或填写模型 ID',true);return;}
  busy($('mf-save'),async()=>{
    const provider=selected,profile=collectProfile();
    modelState={...modelState,...await api('save',{provider,profile,revision:modelState.revision})};
    modelDirty=false;loadProfile();
    const controller=new AbortController();modelTestController=controller;
    $('mf-cancel').hidden=false;$('mf-test').className='note';$('mf-test').setAttribute('aria-busy','true');
    const controls=$$('#model-form input, #model-form select, [data-provider], #catalog-list button');
    const wasDisabled=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);
    const started=Date.now();const progress=()=>{$('mf-test').textContent=`配置已保存，正在测试连接… ${Math.floor((Date.now()-started)/1000)} 秒（最多 60 秒，不会发送到 QQ）`;};
    progress();const timer=setInterval(progress,1000);let testError;
    try{await api('test',{provider,profile},{signal:controller.signal,timeout:65000});toast('已保存，测试通过');}
    catch(error){testError=error.message;toast(testError,true);}
    finally{
      clearInterval(timer);modelTestController=null;$('mf-cancel').hidden=true;$('mf-test').removeAttribute('aria-busy');
      controls.forEach((control,i)=>control.disabled=wasDisabled[i]);
    }
    try{modelState=await api('state');loadProfile();}catch(error){testError=testError||error.message;}
    if(testError){$('mf-test').className='note bad';$('mf-test').textContent=testError;}
  });
};
$('mf-cancel').onclick=()=>modelTestController?.abort();
$('mf-activate').onclick=()=>busy($('mf-activate'),async()=>{
  const check=modelState.checks[selected];
  if(!(check?.ok&&check.configuredModel===modelState.profiles[selected].model)&&!confirm('这个连接还没有测试通过，确定直接切换吗？'))return;
  modelState={...modelState,...await api('activate',{provider:selected,revision:modelState.revision})};
  loadProfile();renderRoutes();toast(`已切换到${providerNames[selected]}，正在进行的回复不受影响`);
});
$('mf-fast').addEventListener('change',()=>{if($('mf-fast').checked&&!confirm('Fast 加速会明显更快地消耗 Codex 额度，确定开启吗？'))$('mf-fast').checked=false;});
function renderCatalog(){
  const catalog=catalogOverride||modelState.catalogs[selected],query=$('catalog-search').value.trim().toLowerCase();
  $('catalog-status').textContent=catalog?.error?catalog.error+(catalog.stale?'（显示上次的目录）':''):catalog?`${catalog.models.length} 个模型${catalog.updatedAt?' · '+new Date(catalog.updatedAt).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit',month:'numeric',day:'numeric'})+' 更新':''}`:(selected==='cloud'&&!modelState.profiles.cloud.hasApiKey?'填写并保存 API Key 后可读取目录':'正在读取目录…');
  const check=modelState.checks[selected];
  const items=(catalog?.models||[]).filter(m=>(m.id+' '+m.name).toLowerCase().includes(query)).map(model=>{
    const tested=check?.ok&&check.configuredModel===model.id;
    const item=el('button',{type:'button',className:'model-item',title:model.source||''},
      el('span',{className:'title'},model.name,tested?el('span',{className:'badge ok'},'测试通过'):null),
      model.name!==model.id?el('code',{},model.id):null,model.description?el('p',{},model.description):null);
    item.setAttribute('role','listitem');item.setAttribute('aria-pressed',String(model.id===$('mf-model').value));
    item.onclick=()=>{$('mf-model').value=model.id;modelDirty=true;$('mf-activate').disabled=true;renderCatalog();};
    return item;
  });
  $('catalog-list').replaceChildren(...(items.length||!catalog?items:[empty(query?'没有匹配的模型':'目录为空，可以直接填写模型 ID')]));
  // Image models from the provider's directory, offered for the image-model field.
  if(selected==='cloud')$('mf-image-list').replaceChildren(...(catalog?.models||[])
    .filter(m=>/image|dall-?e|flux|cogview|seedream|imagen|kolors|stable-?diffusion|sdxl|midjourney|wanx|hunyuan-?image/i.test(m.id))
    .map(m=>el('option',{value:m.id},m.name)));
}
$('catalog-search').addEventListener('input',renderCatalog);
async function refreshCatalog(){
  $('catalog-status').textContent='正在读取目录…';
  catalogOverride=await api('models',{provider:selected,profile:collectProfile()});renderCatalog();
}
$('catalog-refresh').onclick=()=>busy($('catalog-refresh'),refreshCatalog);

/* Model per purpose ("模型分工") */
const routePurposes=[
  ['director','指挥','看每一批新消息，自己决定回不回、写出要说的话；用最会说话的模型'],
  ['operator','助手','替指挥跑腿：查资料、看更早的图、刷 B 站、挑表情包；可以用便宜的模型'],
  ['summary','群聊滚动摘要','把较早的群聊压成一段前情，少读几十行原文'],
  ['memory','记忆整理','后台把聊天整理成长期记忆'],
  ['imageplan','画图判断','整理画面描述'],
  ['video','看视频','看别人发的视频链接']
];
let routesDirty=false;
function renderRoutes(){
  if(routesDirty)return;
  const routes=modelState.routes||{},active=modelState.active,activeModel=modelState.profiles[active]?.model||'';
  $('routes-rows').replaceChildren(...routePurposes.map(([purpose,name,help])=>{
    const route=routes[purpose],choice=route?route.provider:'default';
    const provider=el('select',{});provider.dataset.purpose=purpose;provider.setAttribute('aria-label',name+' 用的连接');
    const options=[['default',`跟随当前连接（${providerNames[active]}）`]];
    for(const p of ['codex','claude','cloud'])if(p!=='cloud'||modelState.profiles.cloud.hasApiKey)options.push([p,providerNames[p]]);
    provider.append(...options.map(([value,label])=>el('option',{value,selected:value===choice},label)));
    const list=el('datalist',{id:'route-models-'+purpose});
    const model=el('input',{className:'mono',value:route?.model||'',autocomplete:'off',spellcheck:false});
    model.setAttribute('list',list.id);model.setAttribute('aria-label',name+' 用的模型');model.dataset.purpose=purpose;
    const sync=()=>{
      const p=provider.value,own=['codex','claude','cloud'].includes(p);
      model.disabled=!own;model.placeholder=own?`留空用该连接设置的 ${modelState.profiles[p]?.model||'模型'}`:activeModel;
      if(!own)model.value='';
      list.replaceChildren(...(own?modelState.catalogs[p]?.models||[]:[]).map(m=>el('option',{value:m.id})));
    };
    provider.onchange=()=>{routesDirty=true;sync();};model.oninput=()=>{routesDirty=true;};
    sync();
    return el('div',{className:'route-row'+(['director','operator'].includes(purpose)?' main':'')},el('div',{className:'route-name'},el('strong',{},name),el('small',{className:'muted'},help)),provider,model,list);
  }));
}
onSubmit($('routes-form'),async()=>{
  const routes={};
  for(const select of $$('#routes-rows select')){
    const purpose=select.dataset.purpose;
    if(select.value==='default')continue;
    routes[purpose]={provider:select.value,model:$$('#routes-rows input').find(i=>i.dataset.purpose===purpose).value.trim()};
  }
  modelState={...modelState,...await api('routes',{revision:modelState.revision,routes})};
  routesDirty=false;renderRoutes();toast('分工已保存，下一批消息起生效');
});

/* Admins and blocklist */
let moderation={admins:[],blocked:[]},moderationDraft={admins:[],blocked:[]};
async function enterModeration(){
  try{moderation=await api('moderation');}
  catch(error){$('admin-chips').replaceChildren(empty(error.message));$('blocked-chips').replaceChildren();return;}
  moderationDraft={admins:[...moderation.admins],blocked:[...moderation.blocked]};renderModeration();
}
function renderModeration(){
  for(const [key,id,emptyText] of [['admins','admin-chips','还没有管理员'],['blocked','blocked-chips','黑名单是空的']]){
    const chips=moderationDraft[key].map(number=>{
      const remove=el('button',{type:'button',title:'移除'},icon('x'));remove.setAttribute('aria-label','移除 '+number);
      remove.onclick=()=>{moderationDraft[key]=moderationDraft[key].filter(x=>x!==number);renderModeration();};
      return el('span',{className:'chip'},number,remove);
    });
    $(id).replaceChildren(...(chips.length?chips:[empty(emptyText)]));
  }
  const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
  $('moderation-bar').hidden=same(moderationDraft.admins,moderation.admins)&&same(moderationDraft.blocked,moderation.blocked);
}
for(const form of $$('.chip-add'))form.onsubmit=event=>{
  event.preventDefault();
  const input=form.querySelector('input'),number=input.value.trim(),key=form.dataset.list,other=key==='admins'?'blocked':'admins';
  if(!qqPattern.test(number)){toast('请输入正确的 QQ 号',true);return;}
  if(moderationDraft[key].includes(number)){toast('已经在列表里了',true);return;}
  if(moderationDraft[other].includes(number)){toast(key==='admins'?'这个 QQ 在黑名单里，先移出黑名单':'管理员不能被拉黑',true);return;}
  if(key==='blocked'&&number===moderation.account){toast('不能拉黑机器人自己',true);return;}
  moderationDraft[key].push(number);input.value='';renderModeration();
};
$('moderation-reset').onclick=()=>{moderationDraft={admins:[...moderation.admins],blocked:[...moderation.blocked]};renderModeration();};
$('moderation-save').onclick=()=>busy($('moderation-save'),async()=>{
  const result=await api('moderation',moderationDraft);
  moderation={...moderation,...result};moderationDraft={admins:[...result.admins],blocked:[...result.blocked]};renderModeration();toast('名单已保存，立即生效');
});

/* Embedded NapCat, full size inside the console */
async function openEmbed(reload=false){
  const frame=$('frame-qq');
  if(frame.src&&!reload)return;
  const result=await api('integrations/open',{service:'napcat'});
  frame.src=result.url+(reload?(result.url.includes('?')?'&':'?')+'r='+Date.now():'');
}

/* Settings */
async function enterSettings(){
  const status=await api('autostart'),box=$('autostart');
  box.checked=status.enabled;box.disabled=!status.supported||(!status.installed&&!status.enabled);
  $('autostart-hint').textContent=!status.supported?(status.reason||'当前环境不支持'):!status.installed?'启动器 Dafeiyu.exe 尚未生成，暂时无法设置。':'登录 Windows 后自动在后台启动大肥鱼，托盘里会出现图标。';
}
$('autostart').onchange=async()=>{
  const box=$('autostart'),wanted=box.checked;box.disabled=true;
  try{const status=await api('autostart',{enabled:wanted});box.checked=status.enabled;toast(status.enabled?'已开启开机自启':'已关闭开机自启');}
  catch(error){box.checked=!wanted;toast(error.message,true);}
  finally{box.disabled=false;}
};
$('password-form').onsubmit=event=>{
  event.preventDefault();
  const currentPassword=$('pw-current').value,next=$('pw-next').value;$('pw-error').textContent='';
  if(next.length<6){$('pw-error').textContent='新密码至少 6 个字符';return;}
  if(next!==$('pw-confirm').value){$('pw-error').textContent='两次输入的新密码不一致';return;}
  busy(event.submitter||$('password-form').querySelector('button'),async()=>{
    try{await api('auth/password',{current:currentPassword,next});}catch(error){$('pw-error').textContent=error.message;return;}
    for(const id of ['pw-current','pw-next','pw-confirm'])$(id).value='';toast('密码已修改');
  });
};
// The Xiaohongshu / Bilibili panels open in a new window.
$$('[data-social]').forEach(button=>button.onclick=()=>busy(button,async()=>{
  const tab=window.open('about:blank','_blank');
  try{const {url}=await api('social',{platform:button.dataset.social});if(tab){tab.opener=null;tab.location.replace(url);}else location.assign(url);}
  catch(error){tab?.close();throw error;}
}));

/* Start */
function start(){
  $('boot').hidden=true;$('login').hidden=true;$('app').hidden=false;
  current=null;route();
  if(current!=='overview')refreshBrand().catch(()=>{});
}
async function boot(){
  try{
    const status=await (await fetch('/console/api/auth',{cache:'no-store'})).json();
    if(!status.passwordSet)showLogin(token||status.authenticated?'setup':'need-token');
    else if(status.authenticated){token=null;start();}
    else{token=null;showLogin('login');}
  }catch{$('boot').textContent='无法连接本机控制台服务，请确认大肥鱼已经启动。';}
}
boot();

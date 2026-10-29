const $=id=>document.getElementById(id);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const pages={
  overview:['总览','机器人现在的状态和最近做了什么'],
  usage:['用量与花费','这个机器人自己调用模型的次数、tokens 和花费'],
  model:['模型','用哪种方式、哪个模型来聊天'],
  chat:['聊天行为','回复节奏、夜间安静、戳一戳、贴表情、主动找人聊天'],
  features:['功能开关','打开或关闭机器人的能力，保存后立即生效'],
  moderation:['管理员与黑名单','谁能管机器人，谁不理'],
  qq:['QQ 登录','NapCat 管理页，扫码登录机器人的 QQ'],
  panel:['会话与详细设置','原项目面板：会话范围、性格、额度、图片、记忆'],
  activity:['浏览记录','机器人实际读过的公开内容'],
  settings:['设置','控制台密码与开机自启']
};
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
  if(location.hash.length<=30||pages[location.hash.slice(1)])return false;
  token=location.hash.slice(1);history.replaceState(null,'',location.pathname+location.search);return true;
}
takeToken();

let current=null,overview=null,pollTimer=null;

/* Helpers */
async function api(route,body,{signal,timeout=route==='outreach/preview'?305000:['runtime/action','features'].includes(route)?90000:route==='models'?60000:30000}={}){
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
  try{return await task();}catch(error){toast(error.message,true);}
  finally{button.classList.remove('busy');button.disabled=false;}
}
const el=(tag,props={},...children)=>{const node=Object.assign(document.createElement(tag),props);node.append(...children.filter(x=>x!=null&&x!==false));return node;};
const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;};
const clock=seconds=>new Date(seconds*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
const shortDate=seconds=>new Date(seconds*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const ago=seconds=>{if(!seconds)return '—';const m=Math.max(0,(Date.now()/1000-seconds)/60);return m<60?`${Math.round(m)} 分钟前`:m<1440?`${Math.round(m/60)} 小时前`:`${Math.round(m/1440)} 天前`;};
function fillSelect(select,values,label,value){
  const list=[...new Set([...values,value])].filter(v=>v!=null).sort((a,b)=>a-b);
  select.replaceChildren(...list.map(v=>el('option',{value:v,selected:v===value},label(v))));
}
const durationLabel=minutes=>minutes%1440===0?`${minutes/1440} 天`:minutes%60===0?`${minutes/60} 小时`:`${minutes} 分钟`;
const secondsLabel=v=>v===0?'不限':v<60?`${v} 秒`:`${v/60} 分钟`;
const hours=[...Array(24).keys()],hourLabel=h=>`${h}:00`;
const setDisabled=(form,disabled)=>form.querySelectorAll('input,select,button').forEach(x=>x.disabled=disabled);

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
const dirty=()=>({features:!$('feature-bar').hidden,moderation:!$('moderation-bar').hidden,model:modelDirty}[current]);
function route(){
  let page=location.hash.slice(1);if(!pages[page])page='overview';
  if(current===page)return;
  current=page;
  for(const section of $$('.page'))section.hidden=section.dataset.page!==page;
  for(const link of $$('.nav a'))link.dataset.page===page?link.setAttribute('aria-current','page'):link.removeAttribute('aria-current');
  $('page-title').textContent=pages[page][0];$('page-sub').textContent=pages[page][1];
  renderPageActions();
  const enter={overview:refreshOverview,usage:enterUsage,model:enterModel,chat:enterChat,features:enterFeatures,moderation:enterModeration,
    qq:()=>openEmbed('qq'),panel:()=>openEmbed('panel'),activity:enterActivity,settings:enterSettings}[page];
  enter().catch(error=>toast(error.message,true));
  schedulePolling();
}
window.addEventListener('hashchange',()=>{
  if(takeToken()){current=null;boot();return;}
  const leaving=current;
  if(dirty()){
    if(!confirm('当前页面有未保存的改动，确定离开吗？')){history.replaceState(null,'','#'+leaving);return;}
    modelDirty=false;$('feature-bar').hidden=true;$('moderation-bar').hidden=true;
  }
  route();
});
function renderPageActions(){
  const actions=$('page-actions');actions.replaceChildren();
  const button=(label,handler,name,kind='btn small ghost')=>{const b=el('button',{type:'button',className:kind},...(name?[icon(name)]:[]),label);b.onclick=()=>busy(b,handler);actions.append(b);};
  if(current==='features')button('全部开启',async()=>{for(const f of features)if(f.available)featureDraft[f.id]=true;renderFeatures();},null,'btn small');
  if(current==='qq'){button('重新连接',()=>openEmbed('qq',true),'refresh');button('新窗口打开',async()=>window.open('/console/integrations/napcat','_blank','noopener'),'ext');}
  if(current==='panel'){button('刷新',()=>openEmbed('panel',true),'refresh');button('新窗口打开',async()=>window.open('/bot/','_blank','noopener'),'ext');}
  if(['activity','usage','chat'].includes(current))button('刷新',{activity:enterActivity,usage:enterUsage,chat:enterChat}[current],'refresh');
}

/* Polling: the overview refreshes every 5 s while visible, the sidebar status every 20 s. */
function stopPolling(){clearTimeout(pollTimer);pollTimer=null;}
function schedulePolling(){
  stopPolling();
  pollTimer=setTimeout(async()=>{
    if(!document.hidden){try{if(current==='overview')await refreshOverview();else await refreshBrand();}catch{}}
    schedulePolling();
  },current==='overview'?5000:20000);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('app').hidden&&current==='overview')refreshOverview().catch(()=>{});});

/* Overview */
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
  const toggle=$('ov-toggle');
  if(!toggle.classList.contains('busy')){
    toggle.disabled=!(b.state==='active'&&b.connected)||b.busy;
    toggle.textContent=b.running?'暂停回复':'开始回复';toggle.className='btn '+(b.running?'':'primary');
  }
  const issue=b.error||o.supervisor?.error||'';
  $('ov-error').hidden=!issue;$('ov-error').textContent=issue;
  $('st-calls').textContent=b.calls??'–';$('st-calls-sub').textContent=b.dailyLimit?`每日上限 ${b.dailyLimit}`:'';
  $('st-sent').textContent=b.confirmed??'–';$('st-sent-sub').textContent=b.sendLimit?`每日上限 ${b.sendLimit}`:'';
  const chats=(o.recentMetrics||[]).filter(m=>m.ok&&m.purpose==='chat').slice(0,10);
  $('st-latency').textContent=chats.length?(chats.reduce((s,m)=>s+m.ms,0)/chats.length/1000).toFixed(1)+' 秒':'–';
  $('st-latency-sub').textContent=chats.length?`最近 ${chats.length} 次聊天回复`:'还没有聊天回复';
  $('st-model').textContent=o.model||'–';$('st-model').title=o.model||'';
  $('st-provider').textContent=(providerNames[o.provider]||'')+(o.provider==='codex'&&o.serviceTier==='fast'?' · Fast':'');
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
  renderDecisions();
  const removed=b.removedTargets||[];
  $('removed-card').hidden=!removed.length;$('removed-count').textContent=String(removed.length);
  $('removed-list').replaceChildren(...removed.map(r=>el('li',{},el('strong',{},`${r.group?'群':'好友'} · ${r.name||r.number}`),el('small',{},`${shortDate(r.removedAt)} · ${r.reason}`))));
}
function renderDecisions(){
  const onlySkipped=$('decisions-skipped').checked;
  const rows=(overview?.bot?.decisions||[]).filter(d=>!onlySkipped||d.outcome.startsWith('不回')).slice(0,30).map(d=>{
    const tone=d.outcome.startsWith('不回')?'':'ok';
    return el('li',{},el('time',{},clock(d.at)),el('span',{className:'who',title:d.chat},`${d.chat} · ${d.speaker||'群友'}`),
      el('span',{className:'what'},el('b',{className:tone},d.outcome),d.text));
  });
  $('ov-decisions').replaceChildren(...(rows.length?rows:[el('li',{className:'empty'},onlySkipped?'最近没有没回的消息':'还没有记录')]));
}
$('decisions-skipped').onchange=renderDecisions;
$('ov-toggle').onclick=()=>busy($('ov-toggle'),async()=>{
  const result=await api('runtime/action',{action:overview?.bot?.running?'bot-pause':'bot-resume'});
  toast(result.message);await refreshOverview();
});
for(const button of $$('[data-runtime]'))button.onclick=()=>{
  const name={'bot-restart':'重启机器人','napcat-restart':'重启 NapCat'}[button.dataset.runtime];
  if(!confirm(`确定${name}吗？期间机器人会离线一小会儿。`))return;
  busy(button,async()=>{const result=await api('runtime/action',{action:button.dataset.runtime});toast(result.message);await refreshOverview();});
};

/* Usage and prices */
let usageTab='stats',usageDays=7,usageMetric='tokens',usageData=null;
const purposeNames={chat:'回复起草',rewrite:'改口吻',review:'插话校对',summary:'群聊摘要',memory:'记忆整理',react:'小动作',imageplan:'画图判断',outreach:'主动聊天',poke:'戳一戳',test:'连接测试',video:'看视频',image:'画图'};
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
function table(id,head,rows,empty,numeric=[]){
  $(id).replaceChildren(el('thead',{},el('tr',{},...head.map((h,i)=>el('th',{className:numeric.includes(i)?'num':''},h)))),
    el('tbody',{},...(rows.length?rows:[el('tr',{},el('td',{colSpan:head.length,className:'empty'},empty))])));
}
function renderUsageChart(){
  for(const tab of $$('[data-metric]'))tab.setAttribute('aria-selected',String(tab.dataset.metric===usageMetric));
  const days=usageData.daily,format=metricFormat[usageMetric],box=$('usage-chart');
  $('usage-chart-title').textContent={tokens:'每天的 tokens',calls:'每天的模型调用',usd:'每天的花费'}[usageMetric];
  const width=Math.max(280,box.clientWidth),height=210,left=52,right=8,top=12,bottom=26;
  const max=Math.max(0,...days.map(d=>d[usageMetric]));
  const nice=v=>{if(v<=0)return 1;const e=10**Math.floor(Math.log10(v)),f=v/e;return (f<=1?1:f<=2?2:f<=5?5:10)*e;};
  const ceiling=nice(max),plot=height-top-bottom,slot=(width-left-right)/days.length,bar=Math.min(24,slot*0.62);
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
  const list=usageData.priceList||[];
  const rows=list.map(m=>{
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
$('usage-rate-form').onsubmit=event=>{
  event.preventDefault();
  busy(event.target.querySelector('button'),async()=>{await api('usage/rate',{rate:Number($('usage-rate').value)});await enterUsage();toast('汇率已保存');});
};

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
  $('catalog-list').replaceChildren(...(items.length||!catalog?items:[el('p',{className:'empty'},query?'没有匹配的模型':'目录为空，可以直接填写模型 ID')]));
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
  ['chat','回复起草','读完整段聊天、记忆和查到的资料，写出回复内容；最吃 tokens 的一步'],
  ['rewrite','改成大肥鱼口吻','只读草稿和最近几句，把说法改得像它；关着就直接发起草的稿子'],
  ['review','主动插话前的校对','群里没人叫它、它想插一句时，发出前再检查一遍'],
  ['summary','群聊滚动摘要','把较早的群聊压成一段前情，回复时少读几十行原文'],
  ['memory','记忆整理','后台把聊天整理成长期记忆'],
  ['react','群里的小动作','决定贴什么表情、戳谁、要不要复读'],
  ['imageplan','画图判断','判断是不是要画图，整理画面描述'],
  ['poke','被戳时说的话','有人戳它时顺口回的一句'],
  ['outreach','主动找人聊天','私聊里主动问候或跟进'],
  ['video','看视频','看别人发的视频链接']
];
let routesDirty=false;
function renderRoutes(){
  if(routesDirty)return;
  const routes=modelState.routes||{},active=modelState.active,activeModel=modelState.profiles[active]?.model||'';
  $('routes-rows').replaceChildren(...routePurposes.map(([purpose,name,help])=>{
    const route=routes[purpose],choice=route?route.provider:(purpose==='rewrite'?'off':'default');
    const provider=el('select',{});provider.dataset.purpose=purpose;provider.setAttribute('aria-label',name+' 用的连接');
    const options=purpose==='rewrite'?[['off','不改写'],['active',`用当前连接（${providerNames[active]}）`]]:[['default',`跟随当前连接（${providerNames[active]}）`]];
    for(const p of ['codex','claude','cloud'])if(p!=='cloud'||modelState.profiles.cloud.hasApiKey)options.push([p,providerNames[p]]);
    provider.append(...options.map(([value,label])=>el('option',{value,selected:value===choice},label)));
    const list=el('datalist',{id:'route-models-'+purpose});
    const model=el('input',{className:'mono',value:route?.model||'',placeholder:'',autocomplete:'off',spellcheck:false});
    model.setAttribute('list',list.id);model.setAttribute('aria-label',name+' 用的模型');model.dataset.purpose=purpose;
    const sync=()=>{
      const p=provider.value,own=['codex','claude','cloud'].includes(p);
      model.disabled=!own;model.placeholder=own?`留空用该连接设置的 ${modelState.profiles[p]?.model||'模型'}`:p==='off'?'':activeModel;
      if(!own)model.value='';
      list.replaceChildren(...(own?modelState.catalogs[p]?.models||[]:[]).map(m=>el('option',{value:m.id})));
    };
    provider.onchange=()=>{routesDirty=true;sync();};model.oninput=()=>{routesDirty=true;};
    sync();
    return el('div',{className:'route-row'},el('div',{className:'route-name'},el('strong',{},name),el('small',{className:'muted'},help)),provider,model,list);
  }));
}
$('routes-form').onsubmit=event=>{
  event.preventDefault();
  busy($('routes-save'),async()=>{
    const routes={};
    for(const select of $$('#routes-rows select')){
      const purpose=select.dataset.purpose,value=select.value;
      if(value==='default'||value==='off')continue;
      routes[purpose]=value==='active'?{provider:'active'}:{provider:value,model:$$('#routes-rows input').find(i=>i.dataset.purpose===purpose).value.trim()};
    }
    modelState={...modelState,...await api('routes',{revision:modelState.revision,routes})};
    routesDirty=false;renderRoutes();toast('分工已保存，下一条回复起生效');
  });
};

/* Chat behaviour: pacing, quiet hours, pokes, reactions, reaching out */
let timing=null,reactions=null,outreach=null;
async function enterChat(){await Promise.all([loadTiming(),loadReactions(),loadOutreach()]);}
async function loadTiming(){
  try{timing=await api('timing');}catch(error){setDisabled($('timing-form'),true);toast(error.message,true);return;}
  setDisabled($('timing-form'),false);
  fillSelect($('timing-settle'),[0,3,5,8,12,20],v=>v===0?'不等，收到就回':`最多等 ${v} 秒`,timing.settleSeconds);
  const quiet=timing.quietHours||{enabled:true,startHour:2,endHour:8};
  $('quiet-enabled').checked=quiet.enabled;
  fillSelect($('quiet-start'),hours,hourLabel,quiet.startHour);fillSelect($('quiet-end'),hours,hourLabel,quiet.endHour);
  const poke=timing.poke||{enabled:false,replyChance:50,cooldownSeconds:30};
  $('poke-enabled').checked=poke.enabled;
  fillSelect($('poke-chance'),[0,25,50,75,100],v=>v===0?'只戳回去，不说话':v===100?'每次都说':`${v}%`,poke.replyChance);
  fillSelect($('poke-cooldown'),[0,10,30,60,300],secondsLabel,poke.cooldownSeconds);
}
$('timing-form').onsubmit=event=>{
  event.preventDefault();
  busy($('timing-save'),async()=>{
    await api('timing',{settleSeconds:Number($('timing-settle').value),
      poke:{enabled:$('poke-enabled').checked,replyChance:Number($('poke-chance').value),cooldownSeconds:Number($('poke-cooldown').value)},
      quietHours:{enabled:$('quiet-enabled').checked,startHour:Number($('quiet-start').value),endHour:Number($('quiet-end').value)}});
    await loadTiming();toast('已保存');
  });
};
const emojiGlyph={'147':'🍭','128051':'🐳','10068':'❔','120':'👊','182':'😂','76':'👍','271':'🍉','124':'👌','319':'🫶','66':'❤️','63':'🌹','128293':'🔥','128170':'💪','8':'😴','320':'🎉'};
const livelinessLabel=v=>(v<=15?'安静':v<=40?'适中':'活跃')+({10:'：只给特别值得的贴',30:'：像常在线不刷屏的群友',60:'：多贴一些'}[v]||'');
const preferenceLabels={0:'不用',1:'偶尔',3:'普通',5:'常用',8:'最爱'};
async function loadReactions(){
  try{reactions=await api('reactions');}catch(error){setDisabled($('reactions-form'),true);$('reactions-hint').textContent=error.message;return;}
  setDisabled($('reactions-form'),false);
  const c=reactions.config;
  $('reactions-enabled').checked=c.enabled;
  $('reactions-poke').checked=c.pokeEnabled??true;$('reactions-repeat').checked=c.repeatEnabled??true;
  fillSelect($('reactions-chance'),[10,30,60],livelinessLabel,c.chance);
  fillSelect($('reactions-cooldown'),[0,15,45,120,300,900],secondsLabel,c.cooldownSeconds);
  $('reactions-emojis').replaceChildren(...c.emojis.map(emoji=>{
    const select=el('select',{});select.dataset.id=emoji.id;select.setAttribute('aria-label',emoji.name+' 的偏好');
    const levels=[...new Set([0,1,3,5,8,emoji.weight])].sort((a,b)=>a-b);
    select.append(...levels.map(w=>el('option',{value:w,selected:w===emoji.weight},preferenceLabels[w]||`偏好 ${w}`)));
    return el('div',{className:'emoji-item',title:emoji.hint||''},el('span',{},`${emojiGlyph[emoji.id]||''} ${emoji.name}`),select);
  }));
  const log=reactions.interactions||[];
  $('reactions-log').replaceChildren(...(log.length?log.slice(0,15).map(x=>el('li',{},el('time',{},clock(x.at)),el('span',{className:'who',title:x.chat},x.chat),
    el('span',{className:'what'},el('b',{},x.what),x.why||''))):[el('li',{className:'empty'},'还没有记录；打开后，群里有新消息时它会看一看')]));
}
$('reactions-form').onsubmit=event=>{
  event.preventDefault();
  busy($('reactions-save'),async()=>{
    const weights=Object.fromEntries($$('#reactions-emojis select').map(s=>[s.dataset.id,Number(s.value)]));
    await api('reactions',{enabled:$('reactions-enabled').checked,chance:Number($('reactions-chance').value),cooldownSeconds:Number($('reactions-cooldown').value),
      pokeEnabled:$('reactions-poke').checked,repeatEnabled:$('reactions-repeat').checked,weights});
    await loadReactions();toast('已保存');
  });
};
async function loadOutreach(){
  try{outreach=await api('outreach');}catch(error){setDisabled($('outreach-form'),true);$('outreach-hint').textContent=error.message;return;}
  setDisabled($('outreach-form'),false);
  const c=outreach.config;
  $('outreach-enabled').checked=c.enabled;
  fillSelect($('outreach-idle'),[360,720,1440,2880,4320,10080],durationLabel,c.idleMinutes);
  fillSelect($('outreach-cooldown'),[720,1440,2880,4320,10080,20160],durationLabel,c.cooldownMinutes);
  fillSelect($('outreach-quiet-start'),hours,hourLabel,c.quietStartHour);fillSelect($('outreach-quiet-end'),hours,hourLabel,c.quietEndHour);
  $('outreach-hint').textContent=!outreach.memoryEnabled?'需要先在「功能开关」里打开“独立长期记忆”，不然没有可以跟进的事。':c.enabled&&!outreach.running?'回复暂停时不会主动发。':'';
  const rows=outreach.chats.map(chat=>{
    const box=el('input',{type:'checkbox',checked:!c.excluded.includes(chat.key)});box.dataset.key=chat.key;box.setAttribute('aria-label','参与主动聊天：'+chat.name);
    const state=[`TA 上次说话 ${ago(chat.lastIncoming)}`,chat.lastSent?`上次主动 ${ago(chat.lastSent)}`:'',chat.awaitingReply?'等 TA 回复中':''].filter(Boolean).join(' · ');
    const preview=el('button',{type:'button',className:'btn small ghost'},'预览一条');
    preview.onclick=()=>busy(preview,async()=>{
      const box=$('outreach-preview');box.hidden=false;box.className='note';box.textContent=`正在为 ${chat.name} 生成……（不会发送）`;
      const {preview:result}=await api('outreach/preview',{target:chat.key});
      box.className='note '+(result?.send?'ok':'');box.textContent=`${chat.name}${result?.send?' · 会这样发：':' · '}\n${result?.text||'没有生成内容'}`;
    });
    return el('div',{className:'chat-row'},el('label',{},box,el('span',{className:'who'},el('strong',{},chat.name),el('small',{},state))),preview);
  });
  $('outreach-chats').replaceChildren(...(rows.length?rows:[el('p',{className:'empty'},'还没有启用的私聊。到「会话与详细设置」里添加。')]));
}
$('outreach-form').onsubmit=event=>{
  event.preventDefault();
  busy($('outreach-save'),async()=>{
    const excluded=$$('#outreach-chats input[type=checkbox]').filter(x=>!x.checked).map(x=>x.dataset.key);
    await api('outreach',{enabled:$('outreach-enabled').checked,idleMinutes:Number($('outreach-idle').value),cooldownMinutes:Number($('outreach-cooldown').value),
      quietStartHour:Number($('outreach-quiet-start').value),quietEndHour:Number($('outreach-quiet-end').value),excluded});
    await loadOutreach();toast('已保存');
  });
};

/* Feature switches */
let features=[],featureDraft={};
async function enterFeatures(){
  features=(await api('features')).features;
  featureDraft=Object.fromEntries(features.map(f=>[f.id,f.enabled]));renderFeatures();
}
function renderFeatures(){
  $('feature-list').replaceChildren(...features.map(f=>{
    const input=el('input',{type:'checkbox',className:'switch',checked:featureDraft[f.id],disabled:!f.available});
    input.setAttribute('aria-label',f.name);
    input.onchange=()=>{featureDraft[f.id]=input.checked;updateFeatureBar();};
    return el('label',{className:'list-row'},el('span',{},el('strong',{},f.name),el('small',{},f.description),f.reason?el('small',{className:'reason'},f.reason):null),input);
  }));
  updateFeatureBar();
}
function updateFeatureBar(){$('feature-bar').hidden=features.every(f=>featureDraft[f.id]===f.enabled);}
$('feature-reset').onclick=()=>{featureDraft=Object.fromEntries(features.map(f=>[f.id,f.enabled]));renderFeatures();};
$('feature-save').onclick=()=>busy($('feature-save'),async()=>{
  features=(await api('features',{features:featureDraft})).features;
  featureDraft=Object.fromEntries(features.map(f=>[f.id,f.enabled]));renderFeatures();toast('功能设置已保存');
});

/* Admins and blocklist */
let moderation={admins:[],blocked:[]},moderationDraft={admins:[],blocked:[]};
async function enterModeration(){
  try{moderation=await api('moderation');}
  catch(error){$('admin-chips').replaceChildren(el('p',{className:'empty'},error.message));$('blocked-chips').replaceChildren();return;}
  moderationDraft={admins:[...moderation.admins],blocked:[...moderation.blocked]};renderModeration();
}
function renderModeration(){
  for(const [key,id,empty] of [['admins','admin-chips','还没有管理员'],['blocked','blocked-chips','黑名单是空的']]){
    const chips=moderationDraft[key].map(number=>{
      const remove=el('button',{type:'button',title:'移除'},icon('x'));remove.setAttribute('aria-label','移除 '+number);
      remove.onclick=()=>{moderationDraft[key]=moderationDraft[key].filter(x=>x!==number);renderModeration();};
      return el('span',{className:'chip'},number,remove);
    });
    $(id).replaceChildren(...(chips.length?chips:[el('p',{className:'empty'},empty)]));
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

/* Embedded NapCat and bot panel, full size inside the console */
async function openEmbed(page,reload=false){
  const frame=$(page==='qq'?'frame-qq':'frame-panel');
  if(frame.src&&!reload)return;
  const result=await api('integrations/open',{service:page==='qq'?'napcat':'bot'});
  frame.src=result.url+(reload?(result.url.includes('?')?'&':'?')+'r='+Date.now():'');
}

/* Browsing record */
async function enterActivity(){
  const data=await api('activity');
  const rows=(data.items||[]).map(item=>el('div',{className:'list-row link'},el('a',{href:item.url,target:'_blank',rel:'noreferrer'},item.title||item.url),
    el('small',{className:'muted'},`${item.evidence||''} · ${new Date(item.at).toLocaleString('zh-CN')}`)));
  $('activity-list').replaceChildren(...(rows.length?rows:[el('p',{className:'empty'},'还没有浏览记录。打开「公开内容探索」后会逐步积累。')]));
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

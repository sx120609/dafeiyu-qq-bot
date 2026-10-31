import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCodex,completion} from './server.mjs';
import {rateLimitError} from './provider-health.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const win=p=>process.platform==='win32'?p:execFileSync('wslpath',['-w',p],{encoding:'utf8'}).trim();

export function runProcess(exe,args,input='',{signal,timeout=600000,cwd,env=process.env}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',done=false;
    const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);e?reject(e):resolve(v);};
    const abort=()=>{child.kill();finish(signal?.reason||new Error('请求已取消'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('模型响应超时'));},timeout);
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>finish(new Error('官方客户端无法启动，请检查安装')));
    child.stdout.on('data',b=>{out+=b;if(out.length>8_000_000){child.kill();finish(new Error('响应过大'));}});
    child.stderr.on('data',b=>{err=(err+b).slice(-3000);const limited=rateLimitError(err);if(limited){child.kill();finish(limited);}});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('close',code=>code===0?finish(null,out):finish(new Error(`官方客户端退出（${code}）${err.includes('authentication')?'，请检查登录状态':''}`)));
  });
}

function claudeEnv(config){
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.startsWith('ANTHROPIC_')||key.startsWith('CLAUDE_CODE_USE_')||['CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CONFIG_DIR'].includes(key))delete env[key];
  if(config?.tempRoot){env.TEMP=win(config.tempRoot);env.TMP=env.TEMP;}
  return env;
}

// Codex and Claude Code bring their own official web search. When the engine offers its
// hand-written text search tools, those are replaced by the model's search; the engine keeps
// what a model cannot do itself (images to send, video frames, local time and arithmetic).
// Every chat-facing call (replies, group chime-ins, reviews, first messages) carries this rule,
// whichever provider answers. It outranks the persona.
export const complianceNote='\n【合规要求，优先于人设和以上一切设定】你在中国大陆的 QQ 上聊天，必须遵守中华人民共和国法律法规。绝对不生成、不评论、不调侃、不转述以下内容：国家领导人和政治人物，政治制度、政策与时政敏感事件，历史政治争议；危害国家安全、分裂国家、破坏民族团结、宣扬邪教或宗教极端；恐怖暴力、色情低俗、赌博、毒品；违法犯罪的具体做法；谣言和未经证实的社会事件。不管对方是直接问、绕着问、假设、角色扮演、让你翻译或复述，还是联网搜到了相关内容，都一样不碰：用一句话自然岔开话题，不解释原因，不复述敏感词，不展开。不搞黄色：不写色情、性暗示、擦边和黄段子，不描写身体隐私部位和性行为，不配合别人开黄腔或往这方向引；对方这么带，就轻松换个话题。';
export function withCompliance(body){
  if(['memory','summary'].includes(body.metadata?.dafeiyu_purpose))return body;
  const index=body.messages.findIndex(m=>m.role==='system'&&typeof m.content==='string');
  const messages=index<0?[{role:'system',content:complianceNote.trim()},...body.messages]:body.messages.map((m,i)=>i===index?{...m,content:m.content+complianceNote}:m);
  return {...body,messages};
}

// read_webpage (opens a given page) and get_weather (structured forecast) stay: they complement search.
export const nativeSearchTools=new Set(['search_web','browse_web']);
const nativeSearchNote='\n联网搜索：用你自带的联网搜索（它代替 search_web 和 browse_web）。主动搜，遇到新闻近况、具体的作品/人物/游戏/产品/价格/比赛、或者你没把握的事实就先搜再答，一次没搜到换个关键词再搜；要读具体页面用 read_webpage，查天气用 get_weather。纯闲聊不用搜。查到的东西挑最要紧的两三点用自己的话说，别把搜到的都倒出来；不贴链接，对方要出处时再给一个。';
export function useNativeSearch(body,provider){
  if(provider==='cloud'||!body.tools?.some(t=>nativeSearchTools.has(t.function?.name)))return {body,webSearch:false};
  const routed={...body,tools:body.tools.filter(t=>!nativeSearchTools.has(t.function?.name))};
  if(!routed.tools.length){delete routed.tools;delete routed.tool_choice;}
  const index=routed.messages.findIndex(m=>m.role==='system'&&typeof m.content==='string');
  routed.messages=routed.messages.map((m,i)=>i===index?{...m,content:m.content+nativeSearchNote}:m);
  if(index<0)routed.messages=[{role:'system',content:nativeSearchNote.trim()},...routed.messages];
  return {body:routed,webSearch:true};
}

// The bot's character and rules (the leading system messages) go into Claude Code's system prompt, which
// it marks for prompt caching: identical from call to call, they are then read from the cache at a small
// fraction of the input price, including every tool round of a reply. Inside the user message they were
// paid in full each time. One file per distinct prompt, named by its hash; old ones are pruned.
async function claudeSystemPrompt(messages,config){
  const lead=[];for(const m of messages){if(m.role!=='system'||typeof m.content!=='string')break;lead.push(m.content);}
  const base=path.join(here,'claude-instructions.txt');
  if(!lead.length)return {file:base,rest:messages};
  const text=await fs.readFile(base,'utf8')+'\n\n# Character and rules for this QQ bot (from the application)\n'+lead.join('\n\n');
  const dir=path.join(config.tempRoot||path.join(here,'..','.runtime'),'claude-system');
  const file=path.join(dir,crypto.createHash('sha256').update(text).digest('hex').slice(0,24)+'.txt');
  try{await fs.access(file);}catch{
    await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,text,{mode:0o600});
    const now=Date.now();
    for(const name of await fs.readdir(dir)){const p=path.join(dir,name);try{if(now-(await fs.stat(p)).mtimeMs>86400_000)await fs.unlink(p);}catch{}}
  }
  return {file,rest:messages.slice(lead.length)};
}

export async function runClaude(body,config,profile,signal,{webSearch=false,effort='medium'}={}){
  if(!config.claude)throw new Error('未检测到官方 Claude Code');
  const system=await claudeSystemPrompt(body.messages,config);
  const content=[];const transcript=structuredClone(system.rest);
  for(const m of transcript)if(Array.isArray(m.content))for(let i=0;i<m.content.length;i++){
    const p=m.content[i];if(p.type!=='image_url')continue;
    const [,media,data]=p.image_url.url.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    content.push({type:'image',source:{type:'base64',media_type:media,data}});
    m.content[i]={type:'text',text:`[附件图片 ${content.length}]`};
  }
  content.unshift({type:'text',text:JSON.stringify({conversation:transcript,available_tools:body.tools||[],response_format:body.response_format||null})});
  const schema=await fs.readFile(path.join(here,'schema.json'),'utf8');
  // Only the server-side WebSearch tool; WebFetch would fetch from this machine and is left off.
  const args=['-p','--safe-mode','--restricted','--tools',webSearch?'WebSearch':'',...(webSearch?['--allowedTools','WebSearch']:[]),'--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--setting-sources','','--no-chrome','--no-session-persistence','--permission-prompts','none','--model',profile.model,'--effort',effort,
    '--system-prompt-file',win(system.file),'--json-schema',schema,
    '--input-format','stream-json','--output-format','stream-json','--verbose'];
  const input=JSON.stringify({type:'user',message:{role:'user',content}})+'\n';
  const output=await runProcess(config.claude,args,input,{signal,cwd:config.tempRoot,env:claudeEnv(config)});
  const events=output.trim().split('\n').map(l=>{try{return JSON.parse(l);}catch{return {};}});
  const result=events.findLast(e=>e.type==='result');
  if(result?.is_error){const limited=rateLimitError(JSON.stringify(result));if(limited)throw limited;}
  if(!result || result.is_error || !result.structured_output)throw new Error('Claude 未返回有效结构化回复，请检查登录与额度');
  // Claude Code reports what each call cost at API prices; the usage page uses that figure.
  const response=completion(body,result.structured_output,{...(result.usage||{}),cost_usd:result.total_cost_usd});
  response.model=Object.keys(result.modelUsage||{})[0]||profile.model;
  return response;
}

// The owner chooses where the key goes: HTTP or HTTPS, public or a model server on the LAN.
export function cloudBase(profile){
  let url;try{url=new URL(profile.baseUrl);}catch{throw new Error('请输入有效 API 地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('API 地址需以 http:// 或 https:// 开头，不含账号、查询参数或片段');
  return url.toString().replace(/\/$/,'');
}
export async function cloudFetch(profile,route,{body,signal}={}){
  const headers={'Content-Type':'application/json'};
  if(profile.protocol==='anthropic'){headers['x-api-key']=profile.apiKey;headers['anthropic-version']='2023-06-01';}
  else headers.Authorization=`Bearer ${profile.apiKey}`;
  const response=await fetch(cloudBase(profile)+route,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(600000)]):AbortSignal.timeout(30000),redirect:'error'});
  if(response.status===429){
    const value=response.headers.get('retry-after');
    const seconds=value?(Number.isFinite(Number(value))?Number(value):Math.ceil((Date.parse(value)-Date.now())/1000)):60;
    throw rateLimitError('429',Number.isFinite(seconds)?Math.max(1,seconds):60);
  }
  if(!response.ok)throw new Error(`云端 API 返回 HTTP ${response.status}，请检查地址、密钥、模型与额度`);
  const raw=await response.text();if(raw.length>8_000_000)throw new Error('云端响应过大');
  try{return JSON.parse(raw);}catch{throw new Error('云端返回的不是 JSON');}
}
export function anthropicBody(body,profile){
  const system=[];const messages=[];
  for(const m of body.messages){
    if(['system','developer'].includes(m.role)){system.push(typeof m.content==='string'?m.content:JSON.stringify(m.content));continue;}
    let content=[];let role=m.role==='assistant'?'assistant':'user';
    if(m.role==='tool')content=[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content||''}];
    else{
      if(typeof m.content==='string'&&m.content)content.push({type:'text',text:m.content});
      if(Array.isArray(m.content))for(const p of m.content){
        if(p.type==='text')content.push(p);
        else{const [,media,data]=p.image_url.url.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);content.push({type:'image',source:{type:'base64',media_type:media,data}});}
      }
      for(const t of m.tool_calls||[])content.push({type:'tool_use',id:t.id,name:t.function.name,input:JSON.parse(t.function.arguments)});
    }
    if(!content.length)content=[{type:'text',text:' '}];
    if(messages.at(-1)?.role===role)messages.at(-1).content.push(...content);else messages.push({role,content});
  }
  if(body.response_format?.type==='json_object')system.push('Only output a valid JSON object, without Markdown fences.');
  return {model:profile.model,max_tokens:Math.min(body.max_tokens||2048,8192),system:system.join('\n'),messages,
    ...(body.tools?.length?{tools:body.tools.map(t=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}))}:{})};
}
export async function runCloud(body,profile,signal,options={}){
  if(!profile.apiKey)throw new Error('尚未填写云端 API Key');
  if(!profile.model)throw new Error('尚未选择云端模型');
  if(profile.protocol==='anthropic'){
    const route=cloudBase(profile).endsWith('/v1')?'/messages':'/v1/messages';
    const r=await cloudFetch(profile,route,{...options,body:anthropicBody(body,profile),signal});
    if(!['end_turn','tool_use'].includes(r.stop_reason))throw new Error('云端模型回复未完成');
    const result=completion(body,{content:(r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'),tool_calls:(r.content||[]).filter(b=>b.type==='tool_use').map(b=>({name:b.name,arguments:JSON.stringify(b.input)}))},r.usage||{});
    result.model=r.model||profile.model;return result;
  }
  // Provider-specific DeepSeek thinking parameters must never leak into a standard API.
  const payload={model:profile.model,messages:body.messages,stream:false};
  if(body.tools?.length){payload.tools=body.tools;payload.tool_choice=body.tool_choice||'auto';}
  if(body.response_format)payload.response_format=body.response_format;
  const r=await cloudFetch(profile,'/chat/completions',{...options,body:payload,signal});
  const choice=r.choices?.[0];if(!choice||!['stop','tool_calls'].includes(choice.finish_reason))throw new Error('云端模型未返回完整回复');
  const result=completion(body,{content:choice.message.content||'',tool_calls:(choice.message.tool_calls||[]).map(t=>({name:t.function.name,arguments:t.function.arguments}))},r.usage||{});
  result.model=r.model||profile.model;return result;
}

// One picture from an OpenAI-compatible /images/generations endpoint. Some APIs answer with base64, others
// with a link to the file; a link is fetched over HTTPS only, and either way the bytes must be a real image.
export async function generateCloudImage(prompt,profile,signal){
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1000)throw new Error('画面描述需为 1–1000 字');
  const started=Date.now();
  const response=await fetch(cloudBase(profile)+'/images/generations',{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${profile.apiKey}`},
    body:JSON.stringify({model:profile.imageModel,prompt,n:1,size:'1024x1024'}),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),redirect:'error'});
  const raw=await response.text();
  if(response.status===400&&/content[_ ]?policy|moderation|safety|sensitive|违规|审核/i.test(raw))throw Object.assign(new Error('内容审核未通过'),{status:422});
  if(response.status===429)throw rateLimitError('429',60);
  if(!response.ok)throw new Error(`生图接口返回 HTTP ${response.status}，可能这个 API 或模型不支持生图`);
  let result;try{result=JSON.parse(raw);}catch{throw new Error('生图接口返回的不是 JSON');}
  const row=result.data?.[0];let bytes;
  if(typeof row?.b64_json==='string')bytes=Buffer.from(row.b64_json,'base64');
  else if(typeof row?.url==='string'&&row.url.startsWith('https://')){
    const file=await fetch(row.url,{signal:AbortSignal.timeout(60000)});
    if(!file.ok)throw new Error('生成的图片下载失败');
    bytes=Buffer.from(await file.arrayBuffer());
  }else throw new Error('生图接口没有返回图片');
  if(bytes.length>8_000_000)throw new Error('生成的图片过大');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216,webp=bytes.subarray(8,12).toString()==='WEBP';
  if(!png&&!jpeg&&!webp)throw new Error('生成的图片格式无效');
  return {created:Math.floor(Date.now()/1000),model:profile.imageModel,data:[{b64_json:bytes.toString('base64')}],usage:result.usage,elapsedMs:Date.now()-started};
}

export async function codexModels(config){
  return new Promise((resolve,reject)=>{
    const child=spawn(config.codex,['app-server','-c','model_provider="openai"'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',result=[],finished=false;
    const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);child.kill();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>done(new Error('Codex 模型目录读取超时')),30000);
    const send=v=>child.stdin.write(JSON.stringify(v)+'\n');
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});child.on('error',()=>done(new Error('Codex 客户端不可用')));
    child.stdout.on('data',b=>{buffer+=b;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){
      let m;try{m=JSON.parse(line);}catch{continue;}
      if(m.error){done(new Error('Codex 模型目录请求失败'));return;}
      if(m.id===1){send({method:'initialized',params:{}});send({id:2,method:'model/list',params:{includeHidden:false,limit:100}});}
      if(m.id===2){result.push(...(m.result?.data||[]).map(x=>({id:x.model||x.id,name:x.displayName||x.model||x.id,description:x.description||'',source:'Codex app-server model/list'})));if(m.result?.nextCursor)send({id:2,method:'model/list',params:{includeHidden:false,limit:100,cursor:m.result.nextCursor}});else done();}
    }});
    child.on('close',()=>{if(!finished)done(new Error('Codex 模型目录进程已退出'));});
    send({id:1,method:'initialize',params:{clientInfo:{name:'dafeiyu-console',version:'1.0.0'},capabilities:{experimentalApi:true}}});
  });
}
export async function claudeModels(config){
  const output=await runProcess(config.windowsNode,[win(path.join(here,'claude-models.mjs')),win(config.claude),win(config.tempRoot)],'',{timeout:45000,env:claudeEnv(config)});
  let list;try{list=JSON.parse(output.trim());}catch{throw new Error('Claude 官方模型目录格式无效');}
  return list.map(x=>({id:x.value,resolvedModel:x.resolvedModel||null,name:x.displayName||x.value,description:x.description||'',source:'Claude 官方 SDK supportedModels()'}));
}
export async function cloudModels(profile,options={}){
  if(!profile.apiKey)throw new Error('请先填写 API Key 再识别模型目录');
  const list=[];let cursor;
  for(let page=0;page<20;page++){
    const prefix=profile.protocol==='anthropic'&&!cloudBase(profile).endsWith('/v1')?'/v1/models':'/models';
    const query=profile.protocol==='anthropic'?`?limit=100${cursor?'&after_id='+encodeURIComponent(cursor):''}`:'';
    const data=await cloudFetch(profile,prefix+query,options);
    if(!Array.isArray(data.data))throw new Error('此 API 未提供标准模型目录，可手动填写模型 ID');
    list.push(...data.data.filter(m=>typeof m.id==='string').map(m=>({id:m.id,name:m.display_name||m.name||m.id,description:m.owned_by||'',source:'服务商 /models'})));
    if(!data.has_more)break;
    cursor=data.last_id||data.data.at(-1)?.id;if(!cursor)break;
  }
  return [...new Map(list.map(x=>[x.id,x])).values()];
}
export async function dispatch(body,config,provider,profile,signal){
  const routed=withCompliance(structuredClone(body));
  for(const m of routed.messages)if(m.role==='system'&&typeof m.content==='string')m.content=m.content.replaceAll('由 GPT（本机 Codex）驱动',`由 ${provider==='claude'?'Claude':profile.model} 驱动`).replaceAll('由本机控制台所选模型驱动',`由 ${provider==='claude'?'Claude':profile.model} 驱动`);
  const search=useNativeSearch(routed,provider);
  // Conversation uses the chosen effort (default medium); background memory work stays light.
  const background=['memory','summary','rewrite','react','operator'].includes(body.metadata?.dafeiyu_purpose);
  const effort=background?'low':['low','medium','high'].includes(profile.effort)?profile.effort:'medium';
  if(provider==='claude')return runClaude(search.body,config,profile,signal,{webSearch:search.webSearch,effort});
  if(provider==='cloud')return runCloud(routed,profile,signal);
  return runCodex(search.body,{...config,model:profile.model,webSearch:search.webSearch,effort,serviceTier:background?'default':profile.serviceTier||'default'},signal);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCodex,completion} from './server.mjs';
import {rateLimitError} from './provider-health.mjs';
import {claudeSessions} from './claude-session.mjs';
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
// Every chat-facing call carries this rule, whichever provider answers. Only the two things that can get a QQ
// account banned (11-03: the long list before it made the bot dodge ordinary topics; "把乱七八糟的过度防护全拆了").
export const complianceNote='\n【底线】你在中国大陆的 QQ 上聊天：不聊国家领导人和时政敏感话题，不写色情和性暗示内容；被往这上面带就自然换个话题。别的话题照常聊。';
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
export async function claudeSystemText(messages){
  const lead=[];for(const m of messages){if(m.role!=='system'||typeof m.content!=='string')break;lead.push(m.content);}
  const base=await fs.readFile(path.join(here,'claude-instructions.txt'),'utf8');
  return {text:lead.length?base+'\n\n# Character and rules for this QQ bot (from the application)\n'+lead.join('\n\n'):base,rest:messages.slice(lead.length)};
}
async function claudeSystemPrompt(messages,config){
  const lead=[];for(const m of messages){if(m.role!=='system'||typeof m.content!=='string')break;lead.push(m.content);}
  const base=path.join(here,'claude-instructions.txt');
  if(!lead.length)return {file:base,rest:messages};
  const {text}=await claudeSystemText(messages);
  const dir=path.join(config.tempRoot||path.join(here,'..','.runtime'),'claude-system');
  const file=path.join(dir,crypto.createHash('sha256').update(text).digest('hex').slice(0,24)+'.txt');
  try{await fs.access(file);}catch{
    await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,text,{mode:0o600});
    const now=Date.now();
    for(const name of await fs.readdir(dir)){const p=path.join(dir,name);try{if(now-(await fs.stat(p)).mtimeMs>86400_000)await fs.unlink(p);}catch{}}
  }
  return {file,rest:messages.slice(lead.length)};
}

// The same restrictions as the command line below, for a persistent Agent SDK session (claude-session.mjs).
export function claudeSessionOptions(config,profile,{webSearch=false,effort='medium'}={}){
  return {pathToClaudeCodeExecutable:config.claude,cwd:config.tempRoot,env:claudeEnv(config),model:profile.model,effort,
    tools:webSearch?['WebSearch']:[],allowedTools:webSearch?['WebSearch']:[],disallowedTools:['mcp__*'],strictMcpConfig:true,mcpServers:{},
    settingSources:[],persistSession:false,outputFormat:{type:'json_schema',schema:claudeSchema},
    extraArgs:{'safe-mode':null,restricted:null,'no-chrome':null,'permission-prompts':'none'}};
}
const claudeSchema=JSON.parse(await fs.readFile(path.join(here,'schema.json'),'utf8'));

export async function runClaude(body,config,profile,signal,{webSearch=false,effort='medium',sessions=claudeSessions}={}){
  if(!config.claude)throw new Error('未检测到官方 Claude Code');
  // A director turn is one session across its rounds (11-03, "更快速"): no start-up per round, and the growing
  // conversation is cached. A lone call keeps the one-shot process. Only where the gateway runs on Windows next to
  // claude.exe (the old WSL gateway launched it through interop); `claudeSessions:false` in the config turns it off.
  const session=body.metadata?.dafeiyu_session;
  if(typeof session==='string'&&session&&config.claudeSessions!==false&&(process.platform==='win32'||config.claudeSessions===true)){
    const system=await claudeSystemText(body.messages);
    // Spare sessions started ahead for the next turn (claudeWarmSessions, default 1: about 190 MB idle, saves ~1.5 s; 0 turns them off).
    if(Number.isFinite(Number(config.claudeWarmSessions)))sessions.spareLimit=Number(config.claudeWarmSessions);
    return sessions.run({key:session,system:system.text,rest:system.rest,body,options:claudeSessionOptions(config,profile,{webSearch,effort}),signal,model:profile.model});
  }
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
  // Anthropic needs a max_tokens; the engine sends none (no output cap since 11-03), so it gets plenty.
  return {model:profile.model,max_tokens:body.max_tokens||32000,system:system.join('\n'),messages,
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

// Pictures from an OpenAI-compatible image API: /images/generations, or /images/edits when the request carries
// reference images to change or draw from (11-03: "不能根据用户发的图片进行修改"). Some APIs answer with base64,
// others with a link to the file; a link is fetched over HTTPS only, and either way the bytes must be a real image.
export const imageSizes={square:'1024x1024',portrait:'1024x1536',landscape:'1536x1024',auto:'auto'};
const imageKind=b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':b[0]===255&&b[1]===216?'jpeg':b.subarray(8,12).toString()==='WEBP'?'webp':'';
/** What a drawing request may ask for, checked: reference images (base64, up to 8), size, quality, background, count. */
export function imageOptions(data={}){
  const images=(Array.isArray(data.images)?data.images:[]).slice(0,8).map(x=>typeof x==='string'?Buffer.from(x.replace(/^data:[^,]*,/,''),'base64'):null);
  if(images.some(b=>!b||!b.length||b.length>12_000_000||!imageKind(b)))throw Object.assign(new Error('参考图不是有效的 PNG、JPEG 或 WebP'),{status:400});
  const size=imageSizes[data.size]??(Object.values(imageSizes).includes(data.size)?data.size:'1024x1024');
  const quality=['low','medium','high'].includes(data.quality)?data.quality:undefined;
  const background=data.background==='transparent'||data.transparent===true?'transparent':undefined;
  const n=Math.min(4,Math.max(1,Number.isInteger(data.n)?data.n:1));
  return {images,size,quality,background,n};
}
export async function generateCloudImage(prompt,profile,signal,options={}){
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw new Error('画面描述需为 1–4000 字');
  const {images,size,quality,background,n}=imageOptions(options);
  // The relay treats `size` as a hint (asked for 1024x1536, it drew 1536x1024), so the orientation is said in words too.
  const shape={'1024x1536':'竖版构图（高大于宽）','1536x1024':'横版构图（宽大于高）'}[size];
  if(shape)prompt+=`\n\n画幅：${shape}`;
  if(background)prompt+='\n\n背景：透明（只画主体，不画背景）';
  const started=Date.now(),headers={Authorization:`Bearer ${profile.apiKey}`};
  const deadline=()=>signal?AbortSignal.any([signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);
  // OpenAI's image models take moderation 'low' (the default 'auto' refused an ordinary anime character, 11-03:
  // "你的内容审核别搞那么严格啊"). input_fidelity 'high' keeps faces and details of the reference images.
  const extras={moderation:'low',...(quality?{quality}:{}),...(background?{background}:{}),...(images.length?{input_fidelity:'high'}:{})};
  const send=plain=>{
    const fields={model:profile.imageModel,prompt,n,size,...(plain?{}:extras)};
    if(!images.length)return fetch(cloudBase(profile)+'/images/generations',{method:'POST',headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify(fields),signal:deadline(),redirect:'error'});
    const form=new FormData();
    for(const [k,v] of Object.entries(fields))form.append(k,String(v));
    images.forEach((b,i)=>form.append('image[]',new Blob([b],{type:'image/'+imageKind(b)}),`reference-${i+1}.${imageKind(b)==='jpeg'?'jpg':imageKind(b)}`));
    return fetch(cloudBase(profile)+'/images/edits',{method:'POST',headers,body:form,signal:deadline(),redirect:'error'});
  };
  const refused=(status,raw)=>status===400&&/content[_ ]?policy|moderation|safety|sensitive|违规|审核/i.test(raw);
  let response=await send(false),raw=await response.text();
  // An API that does not know one of the optional fields says so with a 400: once more with only the basic ones.
  if(response.status===400&&!refused(400,raw)){response=await send(true);raw=await response.text();}
  if(refused(response.status,raw))throw Object.assign(new Error('内容审核未通过'),{status:422});
  if(response.status===429)throw rateLimitError('429',60);
  if(!response.ok){
    let detail='';try{detail=String(JSON.parse(raw).error?.message||'').slice(0,160);}catch{}
    throw new Error(`${images.length?'改图':'生图'}接口返回 HTTP ${response.status}`+(detail?`：${detail}`:images.length?'，可能这个 API 不支持按参考图改图':'，可能这个 API 或模型不支持生图'));
  }
  let result;try{result=JSON.parse(raw);}catch{throw new Error('生图接口返回的不是 JSON');}
  const rows=Array.isArray(result.data)?result.data:[],pictures=[];
  for(const row of rows){
    let bytes;
    if(typeof row?.b64_json==='string')bytes=Buffer.from(row.b64_json,'base64');
    else if(typeof row?.url==='string'&&row.url.startsWith('https://')){
      const file=await fetch(row.url,{signal:AbortSignal.timeout(60000)});
      if(!file.ok)throw new Error('生成的图片下载失败');
      bytes=Buffer.from(await file.arrayBuffer());
    }else continue;
    if(bytes.length>12_000_000)throw new Error('生成的图片过大');
    if(!imageKind(bytes))throw new Error('生成的图片格式无效');
    pictures.push(bytes);
  }
  if(!pictures.length)throw new Error('生图接口没有返回图片');
  return {created:Math.floor(Date.now()/1000),model:profile.imageModel,data:pictures.map(b=>({b64_json:b.toString('base64')})),usage:result.usage,
    edited:images.length>0,elapsedMs:Date.now()-started};
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

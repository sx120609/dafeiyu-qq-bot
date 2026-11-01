import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {rateLimitError} from './provider-health.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const model = 'gpt-6-astra';
const maxBody = 24 * 1024 * 1024;
const toWindows = p => process.platform === 'win32' ? p : execFileSync('wslpath', ['-w', p], {encoding:'utf8'}).trim();

export function validateRequest(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 300) throw new Error('Invalid messages');
  if (body.stream) throw new Error('Streaming is not supported');
  if (body.model !== model) throw new Error('Unsupported model');
  const roles = new Set(['system','developer','user','assistant','tool']);
  for (const m of body.messages) {
    if (!roles.has(m.role) || !(typeof m.content === 'string' || Array.isArray(m.content) || m.content === null)) throw new Error('Invalid message');
    if (Array.isArray(m.content)) for (const p of m.content) {
      if (p.type === 'text' && typeof p.text === 'string') continue;
      if (p.type === 'image_url' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image_url?.url || '')) continue;
      throw new Error('Only inline PNG/JPEG/WebP images and text are supported');
    }
  }
  if (body.tools && (!Array.isArray(body.tools) || body.tools.length > 64 || body.tools.some(t => t.type !== 'function' || !t.function?.name))) throw new Error('Invalid tools');
}

// Keep whatever is usable instead of failing the whole reply: unknown or malformed tool calls are
// dropped, extra calls beyond two are ignored, and a JSON reply wrapped in prose or fences is unwrapped.
export function completion(body, envelope, usage = {}) {
  let content = typeof envelope.content === 'string' ? envelope.content : '';
  const allowed = new Set((body.tools || []).map(t => t.function.name));
  const calls = (Array.isArray(envelope.tool_calls) ? envelope.tool_calls : []).flatMap(t => {
    let args;
    try { args = typeof t.arguments === 'string' ? JSON.parse(t.arguments) : t.arguments; } catch { return []; }
    if (!allowed.has(t?.name) || !args || typeof args !== 'object' || Array.isArray(args)) return [];
    return [{id:'call_'+crypto.randomUUID(), type:'function', function:{name:t.name,arguments:JSON.stringify(args)}}];
  }).slice(0, 2);
  if (!calls.length) {
    // The agent's director may end a turn with nothing left to say; anything else needs words.
    if (!content.trim()) { if (body.metadata?.dafeiyu_purpose === 'director') content = '（结束）'; else throw new Error('Empty reply'); }
    if (body.response_format?.type === 'json_object') {
      const start = content.indexOf('{'), end = content.lastIndexOf('}');
      try { JSON.parse(content); } catch { if (start >= 0 && end > start) content = content.slice(start, end + 1); }
    }
  }
  return {id:'chatcmpl-'+crypto.randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model,
    choices:[{index:0,finish_reason:calls.length?'tool_calls':'stop',message:{role:'assistant',content,...(calls.length?{tool_calls:calls}:{})}}],
    usage:normalizeUsage(usage)};
}
// One usage shape for every provider. Codex and OpenAI count cached input inside input; Claude and
// Anthropic report cache reads and writes separately, so those are added back in.
export function normalizeUsage(u={}){
  const prompt=(u.input_tokens??u.prompt_tokens??0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0);
  const output=u.output_tokens??u.completion_tokens??0;
  return {prompt_tokens:prompt,completion_tokens:output,total_tokens:prompt+output,
    cached_tokens:u.cached_input_tokens??u.cache_read_input_tokens??u.prompt_tokens_details?.cached_tokens??0,
    reasoning_tokens:u.reasoning_output_tokens??u.output_tokens_details?.thinking_tokens??u.completion_tokens_details?.reasoning_tokens??0,
    ...(Number(u.cost_usd)>0?{cost_usd:Number(u.cost_usd)}:{})};
}

export async function runCodex(body, config, signal, launch=spawn) {
  const dir = await fs.mkdtemp(path.join(config.tempRoot,'request-'));
  try {
    const transcript = structuredClone(body.messages);
    const images = [];
    for (const m of transcript) if (Array.isArray(m.content)) for (let i=0;i<m.content.length;i++) {
      const part = m.content[i];
      if (part.type !== 'image_url') continue;
      if (images.length >= 12) throw new Error('Too many images');
      const [,type,bytes] = part.image_url.url.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
      const file = path.join(dir,`image-${images.length}.${type}`);
      await fs.writeFile(file,Buffer.from(bytes,'base64'),{mode:0o600});
      images.push(file);
      m.content[i] = {type:'text',text:`[Attached image ${images.length}]`};
    }
    // Live web search is a top-level Codex flag and must precede the subcommand.
    const args = [...(config.webSearch?['--search']:[]),'exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only',
      '--model',config.model||model,'-c',`model_reasoning_effort="${['low','medium','high'].includes(config.effort)?config.effort:'medium'}"`,'-c','features.shell_tool=false','-c','features.apply_patch_freeform=false',
      '-c','features.apps=false','-c','features.multi_agent=false','-c','features.image_generation=false','-c','features.view_image=false',
      '-c','features.shell_snapshot=false','-c','project_doc_max_bytes=0',...(config.webSearch?[]:['-c','web_search="disabled"']),
      '-c',`model_instructions_file=${JSON.stringify(toWindows(path.join(here,'instructions.txt')))}`,
      '--cd',toWindows(config.tempRoot),'--output-schema',toWindows(path.join(here,'schema.json')),'--json'];
    for (const file of images) args.push('--image',toWindows(file));
    if(config.serviceTier)args.push('-c','service_tier='+JSON.stringify(config.serviceTier));
    args.push('-');
    const prompt = JSON.stringify({conversation:transcript,available_tools:body.tools||[],response_format:body.response_format||null});
    return await new Promise((resolve,reject) => {
      const child = launch(config.codex,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:toWindows(config.tempRoot),TMP:toWindows(config.tempRoot)}});
      let buffer='',last='',usage={},failure='',done=false,total=0,stderr='';
      const finish = (err,result) => {if(done)return;done=true;signal?.removeEventListener('abort',abort);err?reject(err):resolve(result);};
      const kill = () => {
        // A Windows process launched through WSL must be terminated on Windows too.
        if (process.platform !== 'win32' && config.codex.endsWith('.exe')) {
          // Closing stdin / SIGTERM terminates the WSL interop process; no shell commands are used.
          child.kill('SIGTERM');
        } else child.kill();
      };
      const abort = () => {kill();finish(signal?.reason||new Error('请求已取消'));};
      // No time limit of its own: the caller's signal ends a request it no longer waits for.
      if(signal?.aborted) {abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      child.on('error',e=>finish(e));
      child.stdin.on('error',()=>{});
      child.stdout.on('data',data=>{
        total+=data.length;
        if(total>4*1024*1024){kill();finish(new Error('Model output too large'));return;}
        buffer+=data.toString();
        const lines=buffer.split('\n');buffer=lines.pop();
        for(const line of lines) {
          let event;try{event=JSON.parse(line);}catch{continue;}
          // Debug aid: event kinds and search queries only, never message text.
          if(process.env.DAFEIYU_CODEX_DEBUG)console.error(JSON.stringify({type:event.type,item:event.item?.type,action:event.item?.action,results:event.item?.results?.length,error:event.item?.type==='error'?event.item.message:undefined}));
          if(event.type==='item.completed' && event.item?.type==='agent_message')last=event.item.text;
          if(event.type==='turn.completed')usage=event.usage||{};
          if(event.type==='turn.failed'||event.type==='error'){
            const message=event.error?.message||event.message||'generation failed';
            const limited=rateLimitError(message);
            if(limited){kill();finish(limited);return;}
            failure=('Codex: '+message).replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,350);
          }
          if(event.type==='item.started' && ['command_execution','mcp_tool_call','file_change'].includes(event.item?.type)){kill();finish(new Error('Unexpected Codex tool rejected'));}
        }
      });
      // No prompt, credentials, reasoning or chat transcript is written to service logs.
      child.stderr.on('data',data=>{
        stderr=(stderr+data.toString()).slice(-6000);
        // CLI retries may sleep for minutes after a 429. Surface it immediately, without logging prompts.
        const limited=rateLimitError(stderr);
        if(limited){kill();finish(limited);}
      });
      child.on('close',code=>{
        if(code!==0||failure||!last){finish(new Error(failure||`Codex exited ${code} without a reply`));return;}
        try{const result=completion(body,JSON.parse(last),usage);result.model=config.model||model;finish(null,result);}catch(e){finish(e);}
      });
      child.stdin.end(prompt);
    });
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}

export function createServer(config,runner=runCodex) {
  let active=false;
  return http.createServer(async(req,res)=>{
    const send=(status,data)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}};
    if(req.url==='/healthz' && req.method==='GET'){send(200,{ok:true,model,busy:active});return;}
    if(req.headers.authorization!==`Bearer ${config.token}` || req.headers.origin){send(401,{error:{message:'Unauthorized'}});return;}
    if(req.url==='/v1/models' && req.method==='GET'){send(200,{object:'list',data:[{id:model,object:'model',owned_by:'local-codex'}]});return;}
    if(req.url!=='/v1/chat/completions'||req.method!=='POST'){send(404,{error:{message:'Not found'}});return;}
    if(active){send(429,{error:{message:'Codex is busy; retry shortly'}});return;}
    let body;
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>maxBody)throw new Error('Request too large');chunks.push(chunk);}
      body=JSON.parse(Buffer.concat(chunks).toString());validateRequest(body);
    }catch(e){send(400,{error:{message:e.message}});return;}
    if(active){send(429,{error:{message:'Codex is busy; retry shortly'}});return;}
    active=true;const abort=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)abort.abort();});
    const started=Date.now();
    try{send(200,await runner(body,config,abort.signal));console.log(JSON.stringify({event:'completion',ms:Date.now()-started}));}
    catch(e){console.error(JSON.stringify({event:'failed',message:e.message}));send(502,{error:{message:e.message}});}
    finally{active=false;}
  });
}


// The models of Antigravity on this computer (`agy`, Google AI Ultra login; 11-24: "加入一个接入本机antigravity的模型选项",
// then "为什么不支持图片，以及为什么一直要重启？我不希望这样"): Gemini 4 and the other models `agy models` lists.
// One `agy acp` process (Agent Client Protocol over stdio) stays up for the gateway and serves every call:
// - It runs a custom agent with no tools (`.agents/agents/dafeiyu-acp.md` in a workspace of its own under tempRoot),
//   and every permission or file request it might still send is refused: it cannot touch this computer.
// - Each call is a session with its own system prompt (the bot's character and rules, appended through
//   _meta.antigravity.systemPrompt) and model (session/set_model). A director turn keeps its session across rounds
//   and sends only what is new, as the persistent Claude sessions do; other calls close their session afterwards.
// - Pictures go as image blocks. ACP has no structured output, so the reply is the JSON envelope of schema.json
//   written as text (antigravity-instructions.txt); a reply that is not is asked for again once in the same session.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {completion} from './server.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const agyPath=config=>config.antigravity||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'agy','bin',process.platform==='win32'?'agy.exe':'agy');
const agentName='dafeiyu-acp';

/** The one long-running `agy acp`: JSON-RPC calls, session updates routed to their session, restarted when it exits. */
export class AgyServer{
  constructor({launch=(file,args,options)=>spawn(file,args,{...options,windowsHide:true,stdio:['pipe','pipe','pipe']})}={}){
    this.launch=launch;this.child=null;this.ready=null;this.next=0;this.pending=new Map();this.listeners=new Map();
  }
  async start(config){
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      const workspace=path.join(config.tempRoot||os.tmpdir(),'antigravity'),dir=path.join(workspace,'.agents','agents');
      await fs.mkdir(dir,{recursive:true});
      await fs.writeFile(path.join(dir,agentName+'.md'),['---',`name: ${agentName}`,'description: Writes the replies of a QQ chat bot.','tools: []','---',
        'You write the replies of a QQ chat bot. Follow the system prompt of each session.',''].join('\n'));
      const child=this.launch(agyPath(config),['acp','--agent',agentName],{cwd:workspace});
      this.child=child;this.workspace=workspace;let buffer='';
      child.stdout.on('data',data=>{buffer+=data;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)this.receive(line);});
      child.stderr?.on('data',()=>{});
      const ended=error=>{if(this.child!==child)return;this.child=null;this.ready=null;
        for(const {reject} of this.pending.values())reject(error);this.pending.clear();
        for(const listener of this.listeners.values())listener.ended?.(error);};
      child.on('error',error=>ended(new Error(error.code==='ENOENT'?'没找到本机 Antigravity（agy）':'本机 Antigravity 起不来：'+error.message)));
      child.on('exit',code=>ended(new Error(`本机 Antigravity 退出了（${code}）`)));
      child.stdin.on('error',()=>{});
      await this.call('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
      return this;
    })();
    try{return await this.ready;}catch(error){this.ready=null;this.stop();throw error;}
  }
  receive(line){
    if(!line.trim())return;
    let message;try{message=JSON.parse(line);}catch{return;}
    if(message.id!==undefined&&!message.method&&this.pending.has(message.id)){
      const {resolve,reject}=this.pending.get(message.id);this.pending.delete(message.id);
      return message.error?reject(Object.assign(new Error(message.error.message||'Antigravity 出错了'),{code:message.error.code})):resolve(message.result);
    }
    if(message.method==='session/update')return this.listeners.get(message.params?.sessionId)?.update?.(message.params.update);
    // Anything it asks of this side (permissions, files, a terminal) is refused.
    if(message.id!==undefined)this.child?.stdin.write(JSON.stringify(message.method==='session/request_permission'
      ?{jsonrpc:'2.0',id:message.id,result:{outcome:{outcome:'cancelled'}}}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'not available'}})+'\n');
  }
  call(method,params){
    if(!this.child)return Promise.reject(new Error('本机 Antigravity 没在运行'));
    const id=++this.next;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  }
  notify(method,params){this.child?.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}
  stop(){try{this.child?.kill();}catch{}this.child=null;this.ready=null;}
}

/** Pictures become image blocks, referred to from the JSON by number. */
export function agyContent(envelope,messages){
  const images=[],transcript=structuredClone(messages);
  for(const message of transcript)if(Array.isArray(message.content))for(let i=0;i<message.content.length;i++){
    const part=message.content[i];if(part.type!=='image_url')continue;
    const match=String(part.image_url?.url||'').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
    if(!match){message.content[i]={type:'text',text:'[附件图片：格式不认识，看不到]'};continue;}
    images.push({type:'image',mimeType:match[1],data:match[2]});
    message.content[i]={type:'text',text:`[附件图片 ${images.length}]`};
  }
  return [{type:'text',text:JSON.stringify(envelope(transcript))},...images];
}
/** The reply envelope from the text it wrote; undefined when it is not one. */
export function envelopeOf(text){
  const trimmed=String(text||'').trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
  for(const candidate of [trimmed,trimmed.slice(trimmed.indexOf('{'),trimmed.lastIndexOf('}')+1)]){
    try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&(typeof value.content==='string'||Array.isArray(value.tool_calls)))
      return {content:typeof value.content==='string'?value.content:'',tool_calls:Array.isArray(value.tool_calls)?value.tool_calls:[]};}catch{}
  }
  return undefined;
}

export class AgySessions{
  constructor({server=new AgyServer(),idleMs=180_000,max=12}={}){this.server=server;this.idleMs=idleMs;this.max=max;this.sessions=new Map();}
  async open(config,system,model){
    await this.server.start(config);
    const created=await this.server.call('session/new',{cwd:this.server.workspace,mcpServers:[],_meta:{antigravity:{systemPrompt:{append:system}}}});
    if(model)await this.server.call('session/set_model',{sessionId:created.sessionId,modelId:model});
    return {id:created.sessionId,busy:false,consumed:0,prefix:'',calls:[],tools:'',lastUsed:Date.now(),timer:null};
  }
  close(session){
    clearTimeout(session.timer);
    for(const [key,value] of this.sessions)if(value===session)this.sessions.delete(key);
    if(this.server.child)this.server.call('session/close',{sessionId:session.id}).catch(()=>{});
  }
  /** One prompt in, the text of the answer and its usage out. */
  ask(session,prompt,signal){
    session.busy=true;session.lastUsed=Date.now();clearTimeout(session.timer);
    let text='';
    return new Promise((resolve,reject)=>{
      const finish=(error,value)=>{this.server.listeners.delete(session.id);signal?.removeEventListener('abort',abort);session.busy=false;error?reject(error):resolve(value);};
      const abort=()=>{this.server.notify('session/cancel',{sessionId:session.id});finish(signal.reason||new Error('请求已取消'));};
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      this.server.listeners.set(session.id,{update:update=>{if(update?.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')text+=update.content.text;},
        ended:error=>finish(error)});
      this.server.call('session/prompt',{sessionId:session.id,prompt}).then(result=>finish(null,{text,usage:result?.usage||{},stop:result?.stopReason}),error=>finish(error));
    });
  }
  async run(body,config,profile,signal){
    if(!profile.model)throw new Error('还没选 Antigravity 的模型');
    const lead=[];for(const m of body.messages){if(m.role!=='system'||typeof m.content!=='string')break;lead.push(m.content);}
    const rest=body.messages.slice(lead.length);
    const base=await fs.readFile(path.join(here,'antigravity-instructions.txt'),'utf8');
    const system=lead.length?base+'\n\n# Character and rules for this QQ bot (from the application)\n'+lead.join('\n\n'):base;
    const fingerprint=digest([system,profile.model]),tools=body.tools||[],toolsDigest=digest(tools);
    const key=typeof body.metadata?.dafeiyu_session==='string'&&body.metadata.dafeiyu_session?body.metadata.dafeiyu_session:'';
    let session=key?this.sessions.get(key):undefined,prompt;
    if(session&&!session.busy&&session.fingerprint===fingerprint&&this.continues(session,rest)){
      const answered=new Map(session.calls.map(call=>[call.id,{name:call.function.name,arguments:call.function.arguments}]));
      const added=rest.slice(session.consumed+1).map(m=>m.role==='tool'&&answered.has(m.tool_call_id)?{role:'tool',for_call:answered.get(m.tool_call_id),content:m.content}:m);
      prompt=agyContent(t=>({new_messages:t,available_tools:toolsDigest===session.tools?'unchanged':tools,response_format:body.response_format||null}),added);
    }else{
      if(session)this.close(session);
      for(const idle of [...this.sessions.values()].filter(s=>!s.busy).sort((a,b)=>a.lastUsed-b.lastUsed))if(this.sessions.size>=this.max)this.close(idle);
      session=Object.assign(await this.open(config,system,profile.model),{fingerprint});
      if(key)this.sessions.set(key,session);
      prompt=agyContent(t=>({conversation:t,available_tools:tools,response_format:body.response_format||null}),rest);
    }
    session.tools=toolsDigest;
    try{
      let answer=await this.ask(session,prompt,signal),envelope=envelopeOf(answer.text);
      const usage={...answer.usage};
      if(!envelope&&answer.text.trim()){
        // Once more in the same session: it still has the conversation, so only the format is asked for.
        const again=await this.ask(session,[{type:'text',text:'上一条不是要求的格式。只输出一个 JSON 对象：{"content": "...", "tool_calls": [...]}，不要别的文字。'}],signal);
        for(const k of ['inputTokens','outputTokens','cachedReadTokens','thoughtTokens'])usage[k]=(usage[k]||0)+(again.usage[k]||0);
        envelope=envelopeOf(again.text)??(tools.length?undefined:{content:answer.text.trim(),tool_calls:[]});
      }
      if(!envelope)throw new Error('Antigravity 的回复不是要求的格式'+(answer.stop&&answer.stop!=='end_turn'?`（${answer.stop}）`:''));
      const response=completion(body,envelope,{input_tokens:(usage.inputTokens||0)-(usage.cachedReadTokens||0),cache_read_input_tokens:usage.cachedReadTokens||0,
        output_tokens:usage.outputTokens||0,reasoning_tokens:usage.thoughtTokens||0});
      response.model=profile.model;
      const calls=response.choices[0].message.tool_calls||[];
      session.consumed=rest.length;session.prefix=digest(rest);session.calls=calls;
      // A director turn that goes on keeps its session for the next round; anything else is done.
      if(key&&calls.length&&!calls.some(call=>call.function.name==='end_turn'))session.timer=setTimeout(()=>this.close(session),this.idleMs);
      else if(key)session.timer=setTimeout(()=>this.close(session),20_000);
      else this.close(session);
      return response;
    }catch(error){this.close(session);throw error;}
  }
  continues(session,rest){
    if(!(rest.length>session.consumed+1)||digest(rest.slice(0,session.consumed))!==session.prefix)return false;
    const reply=rest[session.consumed];
    if(reply?.role!=='assistant')return false;
    return (reply.tool_calls||[]).map(call=>call.id).sort().join(',')===session.calls.map(call=>call.id).sort().join(',');
  }
}

// One process and one set of sessions for the gateway; a hot reload keeps them (they move onto the new code).
export const agySessions=globalThis.dafeiyuAgySessions??=new AgySessions();
export const runAntigravity=(body,config,profile,signal,{sessions=agySessions}={})=>sessions.run(body,config,profile,signal);

/** The models `agy models` lists for this login: "<id>\t<name>" lines. */
export async function antigravityModels(config,{run}={}){
  run??=(file,args)=>new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:os.tmpdir(),windowsHide:true});let out='',err='';
    const timer=setTimeout(()=>child.kill(),60_000);
    child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('error',error=>{clearTimeout(timer);reject(new Error(error.code==='ENOENT'?'没找到本机 Antigravity（agy）':error.message));});
    child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
  const output=await run(agyPath(config),['models']);
  const list=output.out.split(/\r?\n/).map(line=>line.match(/^([a-z0-9][\w.-]+)\t(.+)$/i)).filter(Boolean).map(([,id,name])=>({id,name:name.trim(),source:'本机 Antigravity'}));
  if(!list.length)throw new Error('本机 Antigravity 没列出模型'+(output.err.trim()?'：'+output.err.trim().split('\n').pop().slice(0,200):''));
  return list;
}

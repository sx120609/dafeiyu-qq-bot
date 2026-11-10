// Tools the agent adds for itself (create_tool), kept and offered like the built-in ones (11-03: "他写的工具也要按照
// 正式工具去做，我希望得到的是一个越用越聪明的bot"). The code is written by the local Codex with the Astra model
// (tool-writer.mjs) from the agent's requirement, run with the test arguments, sent back with its error until it works
// (three drafts at most), and only then saved and enabled.
// Each run is a separate Node process under Node's --permission (no files, no child processes; Node 25+ also denies
// sockets of its own) with 512 MB and five minutes. Through the gateway it reaches any address (intranet and localhost
// included, "这个也可以访问外网"), keeps its own storage between runs, and may use the QQ account's read-only actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeToolCode} from './tool-writer.mjs';

const runner=path.join(path.dirname(fileURLToPath(import.meta.url)),'tool-sandbox.mjs');
const NAME=/^my_[a-z][a-z0-9_]{1,40}$/;
const TYPES=new Set(['string','number','integer','boolean','array','object']);
const MAX_TOOLS=200,RUN_MS=300000,FETCHES=500,BODY=20_000_000,DRAFTS=3;

export function sandboxProcess(){
  const node=[process.execPath,'--permission','--allow-fs-read='+runner,'--max-old-space-size=512',runner];
  if(process.platform==='win32')return spawn(node[0],node.slice(1),{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot,LANG:'C.UTF-8'}});
  return spawn('unshare',['-rn',...node],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8'}});
}

// Kept for other callers: whether an address is on the public internet.
export function publicAddress(ip){
  if(net.isIPv4(ip)){
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||(a===100&&b>=64&&b<128)||(a===169&&b===254)||(a===172&&b>=16&&b<32)||(a===192&&b===168)||(a===198&&(b===18||b===19))||a>=224);
  }
  const x=ip.toLowerCase();
  if(x.startsWith('::ffff:'))return publicAddress(x.slice(7));
  return net.isIPv6(x)&&x!=='::'&&x!=='::1'&&!/^f[cd]/.test(x)&&!/^fe[89ab]/.test(x)&&!x.startsWith('ff');
}
// Any http(s) address, private ones included.
async function checkTarget(raw){
  let url;try{url=new URL(raw);}catch{throw new Error('网址无效');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('只能访问 http/https 网址');
  return url;
}
// QQ actions a tool may call: all of them (send, upload, like, post…), except the few that hurt someone or the account:
// any group member can have a tool written, while the agent's own mute/essence tools check that an admin asked
// (11-03: read-only was too much, "这块权限也别搞得太傻逼").
const harmful=new Set(['set_group_kick','set_group_kick_members','set_group_ban','set_group_whole_ban','set_group_anonymous_ban','set_group_leave',
  'set_group_admin','set_group_name','set_group_portrait','set_group_special_title','delete_friend','bot_exit','set_restart','set_qq_profile','set_qq_avatar',
  'delete_group_file','delete_group_folder','delete_group_file_folder','_del_group_notice','delete_essence_msg','del_group_album_media','delete_qzone_msg',
  'set_friend_add_request','set_group_add_request','clean_cache','get_cookies','get_credentials','get_clientkey','get_csrf_token']);
const allowedAction=action=>typeof action==='string'&&/^[a-z_]+$/.test(action)&&!harmful.has(action);
export async function brokerFetch(raw,options={},{fetchImpl=fetch,check=checkTarget}={}){
  const method=String(options.method||'GET').toUpperCase();
  const headers=Object.fromEntries(Object.entries(options.headers||{}).filter(([k])=>!/^(host|connection|content-length)$/i.test(k)));
  const body=options.body===undefined?undefined:String(options.body);
  let url=await check(raw);
  for(let hop=0;hop<=10;hop++){
    const response=await fetchImpl(url,{method,headers,body:method==='GET'||method==='HEAD'?undefined:body,redirect:'manual',signal:AbortSignal.timeout(60000)});
    if([301,302,303,307,308].includes(response.status)&&response.headers.get('location')){url=await check(new URL(response.headers.get('location'),url).href);continue;}
    const chunks=[];let size=0;
    if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>BODY)break;chunks.push(chunk);}
    const bytes=Buffer.concat(chunks).subarray(0,BODY);
    return {status:response.status,statusText:response.statusText,url:url.href,headers:Object.fromEntries(response.headers),
      body:options.responseType==='base64'?bytes.toString('base64'):bytes.toString('utf8'),base64:options.responseType==='base64'};
  }
  throw new Error('跳转次数太多');
}

function validParameters(schema){
  if(!schema||typeof schema!=='object'||Array.isArray(schema)||schema.type!=='object')throw new Error('parameters 要是 type 为 object 的 JSON Schema');
  const properties=schema.properties??{};
  if(typeof properties!=='object'||Array.isArray(properties))throw new Error('parameters.properties 要是对象');
  for(const [key,value] of Object.entries(properties)){
    if(!/^[a-z][a-z0-9_]{0,40}$/i.test(key)||!value||!TYPES.has(value.type))throw new Error(`参数 ${key} 要有合法的名字和 type（string/number/integer/boolean/array/object）`);
  }
  const required=(schema.required??[]).filter(x=>Object.hasOwn(properties,x));
  const clean={type:'object',additionalProperties:false,properties,required};
  return clean;
}

export class AgentTools{
  // qq(action, params): the QQ account's OneBot actions (the gateway wires it to SnowLuma); writer: tool-writer.mjs.
  constructor({runtime,spawnSandbox=sandboxProcess,fetchImpl=fetch,check=checkTarget,qq=null,writer=null}){
    this.file=path.join(runtime,'agent-tools.json');this.data=path.join(runtime,'agent-tool-data');this.value={tools:[]};
    this.spawnSandbox=spawnSandbox;this.fetchImpl=fetchImpl;this.check=check;this.qq=qq;this.writer=writer;
  }
  /** The functions it calls, from the code now running (after a hot reload, gateway.mjs composeGateway). */
  rewire({qq=this.qq,writer=this.writer}={}){this.spawnSandbox=sandboxProcess;this.check=checkTarget;this.fetchImpl=fetch;this.qq=qq;this.writer=writer;return this;}
  async load(){try{this.value=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{}if(!Array.isArray(this.value.tools))this.value.tools=[];return this;}
  async persist(){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,1),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
  find(name){return this.value.tools.find(t=>t.name===name);}
  // For the agent: the enabled ones, as tool definitions.
  definitions(){
    return this.value.tools.filter(t=>t.enabled).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));
  }
  view(){return {tools:this.value.tools.map(({lastOutput,...t})=>({...t,lastOutput:lastOutput?String(lastOutput).slice(0,1500):''}))};}
  // Creates a tool, or replaces one of the same name. Codex writes the code from the requirement (unless the agent
  // brought its own), every draft is run with the test arguments, a failing one goes back with its error; the tool is
  // saved and enabled only when a run works.
  async create({name,description,requirement,parameters,code,test_arguments:testArguments={},chat=''},{signal,context}={}){
    if(typeof name!=='string'||!NAME.test(name))throw new Error('name 要以 my_ 开头，只用小写字母、数字和下划线');
    if(!testArguments||typeof testArguments!=='object'||Array.isArray(testArguments))throw new Error('test_arguments 要是一个对象');
    const existing=this.find(name);
    if(!existing&&this.value.tools.length>=MAX_TOOLS)throw new Error(`已经有 ${MAX_TOOLS} 个 my_ 工具了，先删掉用不上的`);
    const wanted=typeof requirement==='string'&&requirement.trim()?requirement.trim():typeof description==='string'?description.trim():'';
    if(typeof code!=='string'||!code.trim()){
      if(!wanted)throw new Error('requirement 要写清楚这个工具做什么');
      if(!this.writer)throw new Error('写代码的模型没接上');
    }
    let draft=typeof code==='string'&&code.trim()?{description:String(description||wanted),parameters,code}:null,previous=null,test=null,drafts=0;
    for(;drafts<DRAFTS;drafts++){
      if(!draft)draft=await this.writer({name,requirement:wanted,description,parameters,testArguments,previous,existing:existing?.code},{signal});
      let schema;
      try{schema=validParameters(draft.parameters);}catch(error){test={ok:false,error:error.message,logs:[]};}
      if(schema){
        test=await this.execute(draft.code,testArguments,name,context);
        if(test.ok){
          const now=new Date().toISOString();
          const tool={name,description:String(draft.description||wanted).trim(),requirement:wanted,parameters:schema,code:draft.code,enabled:true,
            createdAt:existing?.createdAt||now,updatedAt:now,chat:String(chat).slice(0,80),runs:existing?.runs||0,failures:existing?.failures||0,
            lastRunAt:now,lastOutput:test.output,writtenBy:typeof code==='string'&&code.trim()&&drafts===0?'agent':'codex'};
          this.value.tools=[...this.value.tools.filter(t=>t.name!==name),tool];
          await this.persist();
          return {saved:true,replaced:!!existing,name,test,drafts:drafts+1};
        }
      }
      if(!this.writer)break;
      previous={code:draft.code,error:test.error,logs:test.logs};draft=null;
    }
    return {saved:false,name,test,drafts};
  }
  async run(name,args,context){
    const tool=this.find(name);
    if(!tool||!tool.enabled)throw new Error('没有这个工具，或者已经停用');
    const result=await this.execute(tool.code,args&&typeof args==='object'&&!Array.isArray(args)?args:{},name,context);
    tool.runs=(tool.runs||0)+1;if(!result.ok)tool.failures=(tool.failures||0)+1;
    tool.lastRunAt=new Date().toISOString();tool.lastOutput=result.ok?result.output:'出错：'+result.error;
    await this.persist();
    return result;
  }
  // The console: switch one on or off, or remove it.
  async update({name,enabled,remove}){
    const tool=this.find(name);if(!tool)throw new Error('没有这个工具');
    if(remove===true)this.value.tools=this.value.tools.filter(t=>t!==tool);
    else if(typeof enabled==='boolean')tool.enabled=enabled;
    else throw new Error('要么开关，要么删除');
    await this.persist();return this.view();
  }
  // A tool's own storage: one JSON file per tool under .runtime/agent-tool-data.
  async store(name,op,key,value){
    const file=path.join(this.data,(NAME.test(name)?name:'my_untitled')+'.json');
    let data={};try{data=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
    if(op==='get')return data[key];
    if(op==='keys')return Object.keys(data);
    if(op==='all')return data;
    if(op==='set')data[key]=value;else if(op==='delete')delete data[key];else throw new Error('不认识的存储操作');
    await fs.mkdir(this.data,{recursive:true});
    await fs.writeFile(file+'.tmp',JSON.stringify(data));await fs.rename(file+'.tmp',file);
    return true;
  }
  async referenceOutput(output){
    // 2026-11-06: "给可以直接用的短引用"; binary payloads must survive the director's text previews.
    let changed=false;
    const replace=async value=>{
      if(typeof value==='string'){
        const match=value.match(/^base64:\/\/([A-Za-z0-9+/]+={0,2})$/);
        if(!match)return value;
        const bytes=Buffer.from(match[1],'base64');
        const directory=path.join(path.dirname(this.file),'agent-tool-files');
        const file=path.join(directory,createHash('sha256').update(bytes).digest('hex')+'.bin');
        await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(file,bytes,{mode:0o600});
        changed=true;return pathToFileURL(path.resolve(file)).href;
      }
      if(Array.isArray(value))return Promise.all(value.map(replace));
      if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await replace(item)])));
      return value;
    };
    let value;
    try{value=JSON.parse(output);}catch{return replace(output);}
    const referenced=await replace(value);
    return changed?JSON.stringify(referenced,null,1):output;
  }
  async execute(code,args,name='my_test',context){
    const started=Date.now();
    const result=await new Promise(resolve=>{
      let child;
      try{child=this.spawnSandbox();}catch(error){resolve({ok:false,error:'沙箱没能启动：'+error.message,logs:[],ms:0});return;}
      let buffer='',stderr='',fetches=0,settled=false;const logs=[];
      const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');resolve({...result,logs:logs.slice(-20),fetches,ms:Date.now()-started});};
      const timer=setTimeout(()=>finish({ok:false,error:`${RUN_MS/1000} 秒没跑完，停下了`}),RUN_MS);
      const reply=message=>{if(!settled)child.stdin.write(JSON.stringify(message)+'\n');};
      const handle=message=>{
        if(message.type==='done')finish({ok:true,output:String(message.output??'')});
        else if(message.type==='error')finish({ok:false,error:String(message.message||'出错了')});
        else if(message.type==='log'){if(logs.length<200)logs.push(String(message.text).slice(0,500));}
        else if(message.type==='fetch'){
          if(++fetches>FETCHES){reply({id:message.id,error:`一次最多请求 ${FETCHES} 次`});return;}
          brokerFetch(message.url,message.options,{fetchImpl:this.fetchImpl,check:this.check}).then(response=>reply({id:message.id,response}),error=>reply({id:message.id,error:error.message}));
        }
        else if(message.type==='store'){
          this.store(name,message.op,String(message.key??''),message.value).then(response=>reply({id:message.id,response}),error=>reply({id:message.id,error:error.message}));
        }
        else if(message.type==='qq'){
          if(!this.qq){reply({id:message.id,error:'QQ 没连上'});return;}
          if(!allowedAction(message.action)){reply({id:message.id,error:'这个 QQ 操作工具不能直接做（踢人、禁言、退群、删好友、改机器人资料、拿登录凭证这类）；要做就让机器人自己按管理员的要求来'});return;}
          const params={...(message.params&&typeof message.params==='object'?message.params:{})};
          // 2026-11-10: "Find the root cause and fix it in the code"; defaults belong to this invocation
          // because concurrent chats share the broker but must never share a destination.
          if(/(?:^|_)group(?:_|$)/.test(message.action)&&params.group_id==null&&context?.group_id!=null)params.group_id=context.group_id;
          this.qq(message.action,params).then(response=>reply({id:message.id,response}),error=>reply({id:message.id,error:error.message}));
        }
      };
      child.stdout.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>40_000_000){finish({ok:false,error:'输出太多'});return;}
        let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{handle(JSON.parse(line));}catch{}}
      });
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
      child.stdin.on('error',()=>{});
      child.on('error',error=>finish({ok:false,error:'沙箱没能启动：'+error.message}));
      child.on('close',()=>finish({ok:false,error:'沙箱意外退出'+(stderr.trim()?'：'+stderr.trim().split('\n').slice(-3).join(' ').slice(0,600):'')}));
      child.stdin.write(JSON.stringify({code,args})+'\n');
    });
    if(result.ok){
      try{result.output=await this.referenceOutput(result.output);}
      catch(error){return {...result,ok:false,output:undefined,error:'工具结果保存失败：'+error.message};}
    }
    return result;
  }
}

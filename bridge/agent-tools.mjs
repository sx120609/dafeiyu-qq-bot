// Tools the agent writes for itself (create_tool). Each one is a JavaScript function body run in a sandbox:
// a separate Node process with no network of its own (`unshare -rn`), no files and no child processes
// (Node's --permission), 128 MB and 60 seconds. It reaches the internet only through fetch, which the gateway
// carries out here for public addresses only, at most 20 requests a run. A tool is enabled only after a test
// run with the agent's own test arguments succeeded.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const runner=path.join(path.dirname(fileURLToPath(import.meta.url)),'tool-sandbox.mjs');
const NAME=/^my_[a-z][a-z0-9_]{1,30}$/;
const TYPES=new Set(['string','number','integer','boolean','array','object']);
const MAX_TOOLS=50,RUN_MS=60000,FETCHES=20,BODY=2_000_000;

export function sandboxProcess(){
  return spawn('unshare',['-rn',process.execPath,'--permission','--allow-fs-read='+runner,'--max-old-space-size=128',runner],
    {stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8'}});
}

// Loopback, private, link-local, carrier-grade NAT, benchmarking, multicast and reserved ranges stay out of reach.
export function publicAddress(ip){
  if(net.isIPv4(ip)){
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||(a===100&&b>=64&&b<128)||(a===169&&b===254)||(a===172&&b>=16&&b<32)||(a===192&&b===168)||(a===198&&(b===18||b===19))||a>=224);
  }
  const x=ip.toLowerCase();
  if(x.startsWith('::ffff:'))return publicAddress(x.slice(7));
  return net.isIPv6(x)&&x!=='::'&&x!=='::1'&&!/^f[cd]/.test(x)&&!/^fe[89ab]/.test(x)&&!x.startsWith('ff');
}
async function checkTarget(raw){
  let url;try{url=new URL(raw);}catch{throw new Error('网址无效');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('只能访问 http/https 网址');
  if(url.username||url.password)throw new Error('网址里不能带账号密码');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=net.isIP(host)?[host]:(await dns.lookup(host,{all:true}).catch(()=>{throw new Error('域名解析失败：'+host);})).map(a=>a.address);
  if(!addresses.length||!addresses.every(publicAddress))throw new Error('不能访问本机或内网地址');
  return url;
}
export async function brokerFetch(raw,options={},{fetchImpl=fetch,check=checkTarget}={}){
  const method=String(options.method||'GET').toUpperCase();
  if(!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(method))throw new Error('不支持的请求方法');
  const headers=Object.fromEntries(Object.entries(options.headers||{}).slice(0,30).filter(([k])=>!/^(host|connection|content-length)$/i.test(k)));
  const body=options.body===undefined?undefined:String(options.body);
  if(body&&body.length>100_000)throw new Error('请求体太大');
  let url=await check(raw);
  for(let hop=0;hop<=3;hop++){
    const response=await fetchImpl(url,{method,headers,body:method==='GET'||method==='HEAD'?undefined:body,redirect:'manual',signal:AbortSignal.timeout(20000)});
    if([301,302,303,307,308].includes(response.status)&&response.headers.get('location')){url=await check(new URL(response.headers.get('location'),url).href);continue;}
    let text='',size=0;const decoder=new TextDecoder();
    if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>BODY)break;text+=decoder.decode(chunk,{stream:true});}
    text+=decoder.decode();
    return {status:response.status,statusText:response.statusText,url:url.href,headers:Object.fromEntries(response.headers),body:text.slice(0,BODY)};
  }
  throw new Error('跳转次数太多');
}

function validParameters(schema){
  if(!schema||typeof schema!=='object'||Array.isArray(schema)||schema.type!=='object')throw new Error('parameters 要是 type 为 object 的 JSON Schema');
  const properties=schema.properties??{};
  if(typeof properties!=='object'||Array.isArray(properties)||Object.keys(properties).length>20)throw new Error('parameters.properties 最多 20 个');
  for(const [key,value] of Object.entries(properties)){
    if(!/^[a-z][a-z0-9_]{0,40}$/i.test(key)||!value||!TYPES.has(value.type))throw new Error(`参数 ${key} 要有合法的名字和 type（string/number/integer/boolean/array/object）`);
  }
  const required=(schema.required??[]).filter(x=>Object.hasOwn(properties,x));
  const clean={type:'object',additionalProperties:false,properties,required};
  if(JSON.stringify(clean).length>6000)throw new Error('parameters 太长');
  return clean;
}

export class AgentTools{
  constructor({runtime,spawnSandbox=sandboxProcess,fetchImpl=fetch,check=checkTarget}){
    this.file=path.join(runtime,'agent-tools.json');this.value={tools:[]};
    this.spawnSandbox=spawnSandbox;this.fetchImpl=fetchImpl;this.check=check;
  }
  async load(){try{this.value=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{}if(!Array.isArray(this.value.tools))this.value.tools=[];return this;}
  async persist(){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,1),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
  find(name){return this.value.tools.find(t=>t.name===name);}
  // For the agent: the enabled ones, as tool definitions.
  definitions(){
    return this.value.tools.filter(t=>t.enabled).map(t=>({type:'function',function:{name:t.name,description:'（你自己写的工具）'+t.description,parameters:t.parameters}}));
  }
  view(){return {tools:this.value.tools.map(({lastOutput,...t})=>({...t,lastOutput:lastOutput?String(lastOutput).slice(0,1500):''}))};}
  // Creates a tool, or replaces one of the same name; saved and enabled only when the test run succeeds.
  async create({name,description,parameters,code,test_arguments:testArguments={},chat=''}){
    if(typeof name!=='string'||!NAME.test(name))throw new Error('name 要以 my_ 开头，只用小写字母、数字和下划线，3–33 个字符');
    if(typeof description!=='string'||!description.trim()||description.length>600)throw new Error('description 要写清楚这个工具做什么、什么时候用（600 字以内）');
    if(typeof code!=='string'||!code.trim()||code.length>20000)throw new Error('code 是一个 async 函数的函数体，最多 2 万字');
    const schema=validParameters(parameters);
    if(!testArguments||typeof testArguments!=='object'||Array.isArray(testArguments))throw new Error('test_arguments 要是一个对象');
    const existing=this.find(name);
    if(!existing&&this.value.tools.length>=MAX_TOOLS)throw new Error(`最多 ${MAX_TOOLS} 个自建工具，先删掉用不上的`);
    const test=await this.execute(code,testArguments);
    if(!test.ok)return {saved:false,name,test};
    const now=new Date().toISOString();
    const tool={name,description:description.trim(),parameters:schema,code,enabled:true,createdAt:existing?.createdAt||now,updatedAt:now,
      chat:String(chat).slice(0,80),runs:existing?.runs||0,failures:existing?.failures||0,lastRunAt:now,lastOutput:test.output};
    this.value.tools=[...this.value.tools.filter(t=>t.name!==name),tool];
    await this.persist();
    return {saved:true,replaced:!!existing,name,test};
  }
  async run(name,args){
    const tool=this.find(name);
    if(!tool||!tool.enabled)throw new Error('没有这个工具，或者已经停用');
    const result=await this.execute(tool.code,args&&typeof args==='object'&&!Array.isArray(args)?args:{});
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
  execute(code,args){
    const started=Date.now();
    return new Promise(resolve=>{
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
      };
      child.stdout.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>2_000_000){finish({ok:false,error:'输出太多'});return;}
        let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{handle(JSON.parse(line));}catch{}}
      });
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
      child.stdin.on('error',()=>{});
      child.on('error',error=>finish({ok:false,error:'沙箱没能启动：'+error.message}));
      child.on('close',()=>finish({ok:false,error:'沙箱意外退出'+(stderr.trim()?'：'+stderr.trim().split('\n').slice(-3).join(' ').slice(0,600):'')}));
      child.stdin.write(JSON.stringify({code,args})+'\n');
    });
  }
}

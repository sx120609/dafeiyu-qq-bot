// The models of Antigravity on this computer (`agy`, Google AI Ultra login; 11-24: "加入一个接入本机antigravity的模型选项"):
// Gemini 4 and the other models its `agy models` lists. Like Codex and Claude Code, one print-mode call per reply:
// - The bot's character and rules go into a custom agent (`.agents/agents/<name>.md` in a workspace of its own under
//   tempRoot), named by a hash of the text. Its only tool is `finish`, which print mode uses to hand back the JSON
//   envelope (bridge/schema.json): no shell, files or search, and about 2k input tokens of agy's own instead of 10k.
// - The request goes on stdin as one stream-json line: a long chat does not fit Windows' 32k command line.
// - agy takes text blocks only, so pictures are replaced by a note and the agent is told it cannot see them.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {completion} from './server.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export const agyPath=config=>config.antigravity||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'agy','bin',process.platform==='win32'?'agy.exe':'agy');

const runAgy=(file,args,{cwd,input='',signal,timeout=300_000})=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out=(out+d).slice(-4_000_000));child.stderr.on('data',d=>err=(err+d).slice(-20_000));
  const timer=setTimeout(()=>child.kill(),timeout);
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  child.on('error',error=>{clearTimeout(timer);reject(new Error(error.code==='ENOENT'?'没找到本机 Antigravity（agy）':'本机 Antigravity 起不来：'+error.message));});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,out,err});});
  child.stdin.on('error',()=>{});child.stdin.end(input);
});

/** The custom agent for this system text: written once, old ones pruned after a day. Returns its name. */
async function agentFor(messages,workspace){
  const lead=[];for(const m of messages){if(m.role!=='system'||typeof m.content!=='string')break;lead.push(m.content);}
  const base=await fs.readFile(path.join(here,'antigravity-instructions.txt'),'utf8');
  const text=lead.length?base+'\n\n# Character and rules for this QQ bot (from the application)\n'+lead.join('\n\n'):base;
  const name='dafeiyu-'+crypto.createHash('sha256').update(text).digest('hex').slice(0,12);
  const dir=path.join(workspace,'.agents','agents'),file=path.join(dir,name+'.md');
  try{await fs.access(file);}catch{
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(file,['---',`name: ${name}`,'description: Writes the replies of a QQ chat bot from a JSON envelope.','tools: [finish]','---',text,''].join('\n'));
    const now=Date.now();
    for(const old of await fs.readdir(dir)){const p=path.join(dir,old);try{if(old!==name+'.md'&&now-(await fs.stat(p)).mtimeMs>86400_000)await fs.unlink(p);}catch{}}
  }
  return {name,rest:messages.slice(lead.length)};
}

export async function runAntigravity(body,config,profile,signal,{run=runAgy}={}){
  if(!profile.model)throw new Error('还没选 Antigravity 的模型');
  const workspace=path.join(config.tempRoot||os.tmpdir(),'antigravity');await fs.mkdir(workspace,{recursive:true});
  const {name,rest}=await agentFor(body.messages,workspace);
  const transcript=structuredClone(rest);
  for(const m of transcript)if(Array.isArray(m.content))m.content=m.content.map(p=>p.type==='image_url'?{type:'text',text:'[附件图片：这个连接看不到图片]'}:p);
  const text=JSON.stringify({conversation:transcript,available_tools:body.tools||[],response_format:body.response_format||null});
  const schema=await fs.readFile(path.join(here,'schema.json'),'utf8');
  const args=['-p','','--agent',name,'--input-format','stream-json','--output-format','stream-json','--json-schema',schema,'--model',profile.model];
  const output=await run(agyPath(config),args,{cwd:workspace,input:JSON.stringify({event:'user',message:{role:'user',content:[{type:'text',text}]}})+'\n',signal});
  if(signal?.aborted)throw new Error('已取消');
  const result=output.out.trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).findLast(e=>e?.event==='result')?.result;
  if(!result)throw new Error('本机 Antigravity 没给出结果'+(/auth|login|sign in/i.test(output.out+output.err)?'：要先在这台电脑上用 agy 登录':output.err.trim()?'：'+output.err.trim().split('\n').pop().slice(0,200):''));
  if(result.status!=='SUCCESS'||!result.structured_output)throw new Error('Antigravity 没答完：'+String(result.error||result.finished_reason||result.status).slice(0,200));
  const u=result.usage||{};
  const response=completion(body,result.structured_output,{input_tokens:(u.input_tokens||0)-(u.cache_read_tokens||0),cache_read_input_tokens:u.cache_read_tokens||0,
    output_tokens:u.output_tokens||0,reasoning_tokens:u.thinking_tokens||0});
  response.model=profile.model;
  return response;
}

/** The models `agy models` lists for this login: "<id>\t<name>" lines. */
export async function antigravityModels(config,{run=runAgy}={}){
  const output=await run(agyPath(config),['models'],{cwd:os.tmpdir(),timeout:60_000});
  const list=output.out.split(/\r?\n/).map(line=>line.match(/^([a-z0-9][\w.-]+)\t(.+)$/i)).filter(Boolean).map(([,id,name])=>({id,name:name.trim(),source:'本机 Antigravity'}));
  if(!list.length)throw new Error('本机 Antigravity 没列出模型'+(output.err.trim()?'：'+output.err.trim().split('\n').pop().slice(0,200):''));
  return list;
}

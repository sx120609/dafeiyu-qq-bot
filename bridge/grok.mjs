// Grok Build on this computer (`grok`, xAI's agent CLI) as the bot's search of X and the web (11-04: "加一个本机grok
// build，可以调用grok在X进行搜索", "进一步拓宽搜索范围"). One question at a time in its headless mode, signed in with
// the owner's own Grok login, with web_search as its only tool: xAI's search covers X (posts, accounts, threads) as
// well as news and the web. Nothing else is allowed — no shell, files, fetching or subagents: the config here
// approves every tool, and a tool list naming an unknown tool leaves them all on (an 11-04 test went off scraping X
// with PowerShell). The owner's config leaves web_search's model empty, which turns search off, so the call names one.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

export const grokPath=config=>config.grok||path.join(os.homedir(),'.grok','bin',process.platform==='win32'?'grok.exe':'grok');
const scopes={
  all:'X（推特）和全网都搜：X 上的帖子、账号、话题和讨论，以及新闻、网页、论坛、百科',
  x:'只在 X（推特）上搜：帖子、账号、话题和讨论',
  web:'在全网搜：新闻、网页、论坛、百科、官方公告'};
const blocked='run_terminal_cmd,task,Agent,write,search_replace,read_file,grep,list_dir,web_fetch,todo_write';

export function grokPrompt(query,scope='all'){
  return [`替一个 QQ 群聊机器人查资料，用 web_search 搜，范围：${scopes[scope]||scopes.all}。`,
    `要查的：${query}`,
    '用中文交回：先一两句结论，再列最要紧的几条，每条写清日期（尽量具体到天）、谁说的或哪家来源，附上链接（X 帖子给 x.com 链接）。',
    '只写搜到的；搜不到、或者搜到的太旧，就照实说，不编帖子、日期和链接。不聊天，不问问题。'].join('\n');
}

const spawnGrok=(file,args,{cwd,env,signal,timeout})=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out=(out+d).slice(-2_000_000));child.stderr.on('data',d=>err=(err+d).slice(-20_000));
  const timer=setTimeout(()=>child.kill(),timeout);
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  child.on('error',error=>{clearTimeout(timer);reject(Object.assign(new Error('本机 Grok Build 起不来：'+error.message),{code:error.code}));});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,out,err});});
});

/** One search: {text, model, usage (with Grok's own cost), sources (links in the answer), seconds}. */
export async function grokSearch({query,scope='all'},config,{signal,run=spawnGrok,timeoutMs=300_000}={}){
  if(typeof query!=='string'||!query.trim()||query.length>500)throw new Error('要搜的内容需为 1–500 字');
  const dir=path.join(config.tempRoot||os.tmpdir(),'grok-search');await fs.mkdir(dir,{recursive:true});
  const args=['-p',grokPrompt(query.trim(),scope),'--tools','web_search','--disallowed-tools',blocked,'--no-subagents','--no-plan',
    '--output-format','json','--max-turns','8'];
  const env={...process.env,GROK_WEB_SEARCH_MODEL:process.env.GROK_WEB_SEARCH_MODEL||config.grokSearchModel||'grok-4.6'};
  const started=Date.now();
  const {out,err}=await run(grokPath(config),args,{cwd:dir,env,signal,timeout:timeoutMs});
  if(signal?.aborted)throw new Error('搜索已取消');
  let result;try{result=JSON.parse(out.slice(out.indexOf('{')));}catch{}
  const said=String(err||'').trim().split('\n').filter(Boolean).pop()||'';
  if(!result||typeof result.text!=='string')throw new Error('本机 Grok Build 没给出结果'+(/authenticat|login|sign in/i.test(out+err)?'：要先在这台电脑上用 grok login 登录':said?'：'+said.slice(0,200):''));
  if(!result.text.trim())throw new Error(result.stopReason==='max_turn_requests'?'Grok 搜了几轮没收住，换个更具体的说法再搜':'Grok 没搜出东西');
  const [model,used]=Object.entries(result.modelUsage||{})[0]||['grok',{}];
  const sources=[...new Set(result.text.match(/https?:\/\/[^\s)）\]」>]+/g)||[])];
  return {text:result.text.trim(),model,sources,seconds:(Date.now()-started)/1000,
    usage:{prompt_tokens:result.usage?.input_tokens||used.inputTokens||0,completion_tokens:result.usage?.output_tokens||used.outputTokens||0,
      prompt_tokens_details:{cached_tokens:result.usage?.cache_read_input_tokens||0},cost_usd:Number(result.total_cost_usd)||0}};
}

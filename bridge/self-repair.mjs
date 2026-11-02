// The bot repairs its own program (11-03: "报错自己完善程序并修复（走跟自己写工具类似的路线，但是涉及前端必须让opus根据
// 现有风格去重做）"). A program error (the engine's or the gateway's exceptions, an engine crash, or the agent reporting
// that a tool misbehaves) becomes a repair: in a separate git worktree, Codex finds the cause, fixes it and adds a
// regression test — or Claude Code (Opus) when the console has to change, keeping the console's existing style. The
// gateway then runs the whole test suite itself, checks that nothing private got in, commits, merges into main when
// the main checkout allows, pushes, and restarts what changed once the chats are quiet.
// Network failures, QQ refusals, rate limits and cancellations are not program errors and are never reported here.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const KEEP=200,AGAIN_AFTER=6*3600_000,QUIET_MS=3*60_000,RESTART_GAP_MS=30*60_000;
const run=(file,args,{cwd,env,input,timeout=0,signal}={})=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out=(out+d).slice(-200_000));child.stderr.on('data',d=>err=(err+d).slice(-200_000));
  const timer=timeout?setTimeout(()=>child.kill(),timeout):null;
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  child.on('error',reject);
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,out,err});});
  child.stdin.on('error',()=>{});child.stdin.end(input??'');
});
const git=(cwd,...args)=>run('git',args,{cwd});

/** What identifies "the same error": the kind, the message with numbers and quoted values blanked, and the first
 *  stack frame inside this project. */
export function signature({kind='exception',message='',stack=''}){
  const frame=String(stack).split('\n').find(line=>/(engine|bridge|console)[\\/]/.test(line))?.replace(/:\d+:\d+\)?$/,'').trim()??'';
  const text=String(message).replace(/\d+/g,'#').replace(/「[^」]*」|"[^"]*"|'[^']*'/g,'…').slice(0,200);
  return crypto.createHash('sha256').update(kind+'|'+text+'|'+frame).digest('hex').slice(0,16);
}
/** Program errors only: a failure of the outside world is not something to repair. */
export function isProgramError({kind,message='',stack=''}){
  if(kind==='agent'||kind==='crash')return true;
  const text=String(message)+'\n'+String(stack);
  if(/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|AbortError|aborted|cancel|取消|超时|限流|429|5\d\d|1200|EventChecker|网络|不可用|没连上/i.test(text))return false;
  return /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|is not a function|is not defined|Cannot read propert|undefined)\b/.test(text)||kind==='tool';
}

export class SelfRepair{
  /** fixers: {codex(job, worktree), claude(job, worktree)} → resolves when the fixer is done; quiet(): whether the chats
   *  are quiet enough to restart; restart(parts): restarts 'engine' and/or 'gateway'; ids(): real QQ numbers to keep out. */
  constructor({runtime,root,fixers,quiet=()=>true,restart=async()=>{},ids=async()=>[],workRoot='D:\\Dev\\Workspaces\\dafeiyu-repairs',push=true}){
    Object.assign(this,{runtime,root,fixers,quiet,restart,ids,workRoot,push});
    this.file=path.join(runtime,'repairs.json');this.value={repairs:[]};this.busy=false;this.waitingRestart=new Set();this.lastRestart=0;
  }
  async load(){try{this.value=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{}if(!Array.isArray(this.value.repairs))this.value.repairs=[];
    for(const r of this.value.repairs)if(['queued','fixing','testing'].includes(r.status)){r.status='queued';}
    setTimeout(()=>this.next(),5000);return this;}
  async persist(){this.value.repairs=this.value.repairs.slice(-KEEP);await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,1));await fs.rename(this.file+'.tmp',this.file);}
  view(){return {repairs:[...this.value.repairs].reverse().map(({log,...r})=>({...r,log:String(log||'').slice(-3000)})),busy:this.busy};}

  /** A report from the engine, the gateway or the agent. Returns what happened to it. */
  async report(report){
    const item={kind:String(report.kind||'exception'),source:String(report.source||'engine'),message:String(report.message||'').slice(0,2000),
      stack:String(report.stack||'').slice(0,6000),context:report.context&&typeof report.context==='object'?report.context:{}};
    if(!item.message)return {accepted:false,reason:'没有错误内容'};
    if(!isProgramError(item))return {accepted:false,reason:'不是程序错误'};
    const sig=signature(item),now=Date.now();
    const same=this.value.repairs.findLast(r=>r.signature===sig);
    if(same&&(['queued','fixing','testing','applied','pushed','ready'].includes(same.status)||now-Date.parse(same.updatedAt)<AGAIN_AFTER)){
      same.seen=(same.seen||1)+1;same.lastSeenAt=new Date(now).toISOString();await this.persist();
      return {accepted:true,id:same.id,status:same.status,duplicate:true};
    }
    const repair={id:new Date(now).toISOString().replace(/[-:T.Z]/g,'').slice(0,14)+'-'+sig.slice(0,6),signature:sig,...item,
      console:item.source==='console'||/console[\\/]/.test(item.stack),status:'queued',seen:1,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
    this.value.repairs.push(repair);await this.persist();
    this.next();
    return {accepted:true,id:repair.id,status:'queued'};
  }
  async retry(id){const r=this.value.repairs.find(x=>x.id===id);if(!r)throw new Error('没有这条修复');r.status='queued';r.updatedAt=new Date().toISOString();await this.persist();this.next();return this.view();}

  async set(repair,fields){Object.assign(repair,fields,{updatedAt:new Date().toISOString()});await this.persist();}
  next(){
    if(this.busy)return;
    const repair=this.value.repairs.find(r=>r.status==='queued');
    if(!repair)return;
    this.busy=true;
    this.work(repair).catch(async error=>{await this.set(repair,{status:'failed',error:String(error.message||error).slice(0,1000)});})
      .finally(()=>{this.busy=false;setTimeout(()=>this.next(),1000);});
  }

  async work(repair){
    const branch='repair/'+repair.id,worktree=path.join(this.workRoot,repair.id);
    await fs.mkdir(this.workRoot,{recursive:true});
    const added=await git(this.root,'worktree','add','-b',branch,worktree,'HEAD');
    if(added.code!==0)throw new Error('开不了工作树：'+added.err.trim().slice(-300));
    // The tests need the dependencies; the worktree borrows the main checkout's node_modules through a junction.
    await run('cmd.exe',['/c','mklink','/J',path.join(worktree,'node_modules'),path.join(this.root,'node_modules')]);
    try{
      await this.set(repair,{status:'fixing',fixer:repair.console?'claude':'codex',branch});
      const fixed=await (repair.console?this.fixers.claude:this.fixers.codex)(repair,worktree);
      await this.set(repair,{status:'testing',summary:String(fixed?.summary||'').slice(0,2000)});
      const changed=(await git(worktree,'status','--porcelain')).out.split('\n').map(l=>l.slice(3).trim()).filter(Boolean).filter(f=>f!=='node_modules');
      if(!changed.length)throw new Error('修复的模型没改任何文件'+(fixed?.summary?'：'+fixed.summary.slice(0,300):''));
      const bad=changed.filter(f=>/^\.runtime[\\/]|(^|[\\/])\.env|bridge-windows\.json|snowluma\.json/.test(f));
      if(bad.length)throw new Error('改到了不该动的文件：'+bad.join('、'));
      const tests=await run(process.execPath,['scripts/test.mjs'],{cwd:worktree,timeout:20*60_000});
      if(tests.code!==0)throw new Error('测试没过：\n'+(tests.out+tests.err).split('\n').filter(l=>/✖|fail|Error/.test(l)).slice(-20).join('\n'));
      await git(worktree,'add','-A','--',...changed);
      const diff=(await git(worktree,'diff','--cached')).out;
      const ids=await this.ids();
      const leaked=ids.filter(id=>id&&diff.split('\n').some(line=>line.startsWith('+')&&line.includes(id)));
      if(leaked.length||/^\+.*sk-[A-Za-z0-9_-]{20,}/m.test(diff))throw new Error('改动里有真实 QQ 号或密钥，没提交');
      const message=`Self-repair: ${repair.message.split('\n')[0].slice(0,60)}\n\n${repair.kind} from ${repair.source}${repair.context?.tool?' ('+repair.context.tool+')':''}, fixed by ${repair.console?'Claude Code (Opus)':'Codex'} and verified by the full test suite.\n${String(fixed?.summary||'').slice(0,1200)}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
      const committed=await git(worktree,'commit','-q','-m',message);
      if(committed.code!==0)throw new Error('提交失败：'+committed.err.slice(-300));
      const sha=(await git(worktree,'rev-parse','HEAD')).out.trim();
      await this.set(repair,{commit:sha,files:changed,tests:'全部通过'});
      // Into main only when the main checkout has nothing uncommitted in the same files and the merge is clean.
      const dirty=(await git(this.root,'status','--porcelain')).out.split('\n').map(l=>l.slice(3).trim()).filter(Boolean);
      const clash=changed.filter(f=>dirty.includes(f));
      if(clash.length){await this.set(repair,{status:'ready',note:'主工作区这几个文件有没提交的改动，修复留在分支 '+branch+'：'+clash.join('、')});return;}
      const merged=await git(this.root,'merge','--no-edit','-q',branch);
      if(merged.code!==0){await git(this.root,'merge','--abort');await this.set(repair,{status:'ready',note:'合并有冲突，修复留在分支 '+branch});return;}
      await this.set(repair,{status:'applied'});
      if(this.push){const pushed=await git(this.root,'push','-q','origin','HEAD:main');await this.set(repair,{status:pushed.code===0?'pushed':'applied',pushNote:pushed.code===0?'':pushed.err.slice(-300)});}
      const parts=new Set(changed.flatMap(f=>f.startsWith('engine')?['engine']:f.startsWith('bridge')?['gateway']:[]));
      if(parts.size){for(const p of parts)this.waitingRestart.add(p);this.restartWhenQuiet();}
    }finally{
      await run('cmd.exe',['/c','rmdir',path.join(worktree,'node_modules')]);
      await git(this.root,'worktree','remove','--force',worktree);
    }
  }
  /** Restarts what a repair changed once no chat has been active for three minutes, at most every half hour. */
  restartWhenQuiet(){
    clearTimeout(this.restartTimer);
    this.restartTimer=setTimeout(async()=>{
      if(!this.waitingRestart.size)return;
      if(!(await this.quiet(QUIET_MS))||Date.now()-this.lastRestart<RESTART_GAP_MS){this.restartWhenQuiet();return;}
      const parts=[...this.waitingRestart];this.waitingRestart.clear();this.lastRestart=Date.now();
      await this.restart(parts);
    },60_000);
  }
}

/** The fixer prompt shared by Codex and Claude Code. */
export function fixPrompt(repair,{console:forConsole=false}={}){
  return [
    'You are repairing a program error in this repository (a QQ chat bot; Node ESM). Read AGENTS.md and docs/AI-HANDBOOK.md first and follow them.',
    `Error (${repair.kind}, from ${repair.source}${repair.context?.tool?', tool '+repair.context.tool:''}):`,repair.message,repair.stack?'Stack:\n'+repair.stack:'',
    repair.context&&Object.keys(repair.context).length?'Context: '+JSON.stringify(repair.context).slice(0,1500):'',
    repair.log?'Recent log lines:\n'+repair.log:'',
    'Find the root cause and fix it in the code (not by adding refusals, limits or prompt rules). Add a regression test under tests/ that fails without the fix. Run `node scripts/test.mjs` and make it pass. Keep the code style of the files you touch, English comments that say why.',
    forConsole?'The fix touches the web console (console/*): redo it in the console\'s existing design — reuse its CSS tokens, components, spacing and wording; no inline styles or scripts (strict CSP), no browser dialogs, Chinese UI text.':'Do not change console/* (the web console); if the right fix needs the console, describe what it needs in your final message instead.',
    'Never read or change .runtime/, credentials or tokens. Do not commit, push, restart anything or touch other worktrees. End with a short summary of the cause and the fix.'
  ].filter(Boolean).join('\n\n');
}

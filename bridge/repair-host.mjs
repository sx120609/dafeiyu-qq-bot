// Wires the self-repair pipeline (self-repair.mjs) into the Windows gateway: the two fixers, when the chats are quiet
// enough to restart, how to restart the engine or the gateway itself, and which real QQ numbers must never be committed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {SelfRepair,fixPrompt} from './self-repair.mjs';
import {writerModel} from './tool-writer.mjs';

const run=(file,args,{cwd,input='',timeout})=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out=(out+d).slice(-400_000));child.stderr.on('data',d=>err=(err+d).slice(-20_000));
  const timer=setTimeout(()=>child.kill(),timeout);
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  child.stdin.on('error',()=>{});child.stdin.end(input);
});
const tail=async(file,lines=60)=>(await fs.readFile(file,'utf8').catch(()=>'')).split('\n').slice(-lines).join('\n')
  .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+|"(token|consoleToken|password|apiKey|accessToken)"\s*:\s*"[^"]*"/g,'[redacted]');

/** Codex for program code, Claude Code (Opus) for anything in the web console. */
export function makeFixers({config,runtime}){
  return {
    // Program code: Codex with the Astra model, allowed to edit and run tests inside the worktree only.
    async codex(repair,worktree){
      const out=path.join(worktree,'.repair-summary.txt');
      const result=await run(config.codex,['exec','--skip-git-repo-check','--ephemeral','--model',writerModel,'-c','model_reasoning_effort="high"',
        '-s','workspace-write','-c','approval_policy="never"','-C',worktree,'-o',out,'-'],
        {cwd:worktree,input:fixPrompt({...repair,log:await tail(path.join(runtime,'logs',repair.source==='gateway'?'gateway.log':'engine.log'))}),timeout:40*60_000});
      const summary=await fs.readFile(out,'utf8').catch(()=>'');await fs.rm(out,{force:true});
      if(result.code!==0&&!summary)throw new Error('Codex 没修完：'+result.err.trim().split('\n').pop());
      return {summary};
    },
    // Anything in the web console: Claude Code with Opus, told to keep the console's existing design.
    async claude(repair,worktree){
      const result=await run(config.claude,['-p','--model','opus','--permission-mode','bypassPermissions','--output-format','text',
        '--allowedTools','Read,Edit,Write,Glob,Grep,Bash'],
        {cwd:worktree,input:fixPrompt(repair,{console:true}),timeout:40*60_000});
      if(result.code!==0)throw new Error('Claude Code 没修完：'+result.err.trim().split('\n').pop());
      return {summary:result.out.trim().slice(-2000)};
    }
  };
}

export async function startSelfRepair({root,runtime,config,host}){
  const fixers=makeFixers({config,runtime});
  // Quiet: no chat has a batch waiting or a turn running, and none had one in the last few minutes.
  const quiet=async ms=>{
    try{
      const status=await host.panelCall();
      const states=status.agentStates||[];
      return !status.busy&&states.every(s=>!s.pending&&!s.thinking&&(!s.lastAt||Date.now()/1000-s.lastAt>ms/1000));
    }catch{return false;}
  };
  const restart=async parts=>{
    if(parts.includes('gateway')){
      // The gateway restarts itself: a hidden PowerShell starts a new one a few seconds after this one exits.
      const script=path.join(root,'scripts','Start.ps1');
      spawn('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command',`Start-Sleep -Seconds 4; & '${script}' -NoBrowser`],{detached:true,windowsHide:true,stdio:'ignore'}).unref();
      console.log('Self-repair: restarting the gateway for a repaired file.');
      await host.stop().catch(()=>{});
      setTimeout(()=>process.exit(0),1000);
    }else if(parts.includes('engine')){console.log('Self-repair: restarting the engine for a repaired file.');await host.restart();}
  };
  const ids=async()=>{
    try{
      const state=JSON.parse(await fs.readFile(path.join(runtime,'engine','qq-state.json'),'utf8'));
      const found=new Set([...(state.config?.targets||[]).map(t=>String(t.number)),...(state.config?.adminIDs||[]).map(String),String(state.config?.expectedSelfID||'')]);
      for(const key of Object.keys(state.memoryBooks||{}))for(const n of key.match(/\d{5,}/g)||[])found.add(n);
      return [...found].filter(x=>x.length>=5);
    }catch{return [];}
  };
  return new SelfRepair({runtime,root,fixers,quiet,restart,ids}).load();
}

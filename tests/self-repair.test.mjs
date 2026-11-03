import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {SelfRepair,signature,isProgramError} from '../bridge/self-repair.mjs';

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
// A tiny project with the same test entry point as the real one, and a bug: add() subtracts.
async function project(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repair-root-'));
  await fs.mkdir(path.join(root,'scripts'));await fs.mkdir(path.join(root,'engine'));
  await fs.writeFile(path.join(root,'engine','math.mjs'),'export const add=(a,b)=>a-b;\n');
  await fs.writeFile(path.join(root,'scripts','test.mjs'),"import {add} from '../engine/math.mjs';process.exit(add(2,2)===4?0:1);\n");
  git(root,'init','-q','-b','main');git(root,'config','user.email','t@example.com');git(root,'config','user.name','t');
  git(root,'add','-A');git(root,'commit','-q','-m','start');
  return root;
}
const waitFor=async(check,seconds=180)=>{for(let i=0;i<seconds*10&&!check();i++)await new Promise(r=>setTimeout(r,100));};
async function pipeline(fix,{dirty,announce}={}){
  const root=await project(),runtime=await fs.mkdtemp(path.join(os.tmpdir(),'repair-runtime-')),work=await fs.mkdtemp(path.join(os.tmpdir(),'repair-work-'));
  if(dirty)await fs.writeFile(path.join(root,'engine','math.mjs'),'export const add=(a,b)=>a-b; // being edited\n');
  const restarts=[];
  const repair=new SelfRepair({runtime,root,workRoot:work,push:false,fixers:{codex:fix,claude:fix},quiet:async()=>true,restart:async parts=>restarts.push(parts),ids:async()=>['123456789'],announce});
  return {root,runtime,work,repair,restarts,cleanup:async()=>{await waitFor(()=>!repair.busy);clearTimeout(repair.restartTimer);await Promise.all([root,runtime,work].map(d=>fs.rm(d,{recursive:true,force:true,maxRetries:5})));}};
}
const bug={source:'engine',kind:'exception',message:"TypeError: Cannot read properties of undefined (reading 'x')",stack:'TypeError: x\n    at add (D:\\bot\\engine\\math.mjs:1:20)'};

test('a program error is fixed in a worktree, tested, committed and merged into main',async()=>{
  const p=await pipeline(async(job,worktree)=>{await fs.writeFile(path.join(worktree,'engine','math.mjs'),'export const add=(a,b)=>a+b;\n');return {summary:'add() subtracted'};});
  try{
    const accepted=await p.repair.report(bug);
    assert.equal(accepted.status,'queued');
    const again=await p.repair.report({...bug,message:"TypeError: Cannot read properties of undefined (reading 'y')"});
    assert.equal(again.duplicate,true,'the same error twice is one repair');
    await waitFor(()=>p.repair.value.repairs[0].status==='applied');
    const done=p.repair.value.repairs[0];
    assert.equal(done.status,'applied',done.error);assert.deepEqual(done.files,['engine/math.mjs']);
    assert.match(await fs.readFile(path.join(p.root,'engine','math.mjs'),'utf8'),/a\+b/);
    assert.match(git(p.root,'log','-1','--format=%s'),/^Self-repair: TypeError/);
    // "applied" is recorded just before the worktree is cleaned up; wait for the pipeline to finish.
    await waitFor(()=>!p.repair.busy);
    assert.equal(git(p.root,'worktree','list').trim().split('\n').length,1,'the worktree is removed');
  }finally{await p.cleanup();}
});

test('once a fix runs, the chat the error came from is told, and a gateway that starts finds merged fixes live',async()=>{
  const told=[];
  // A console-only fix runs as soon as it is merged (the pages are read fresh); this project's test still has to pass.
  const p=await pipeline(async(job,w)=>{await fs.mkdir(path.join(w,'console'));await fs.writeFile(path.join(w,'console','x.js'),'// fixed\n');},
    {announce:async r=>told.push(r.context.chatKey)});
  try{
    await fs.writeFile(path.join(p.root,'engine','math.mjs'),'export const add=(a,b)=>a+b;\n');git(p.root,'commit','-q','-am','add');
    await p.repair.report({...bug,source:'console',context:{chatKey:'group:1'}});
    await waitFor(()=>p.repair.value.repairs[0].retold);
    assert.ok(p.repair.value.repairs[0].liveAt);assert.deepEqual(told,['group:1']);
  }finally{await p.cleanup();}
  // A fix still waiting for its restart when the gateway stops is live in the next gateway.
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'repair-runtime-')),later=[];
  try{
    await fs.writeFile(path.join(runtime,'repairs.json'),JSON.stringify({repairs:[{id:'a',status:'pushed',awaitingLive:['gateway'],context:{chatKey:'private:2'},updatedAt:new Date().toISOString()}]}));
    const fresh=await new SelfRepair({runtime,root:runtime,fixers:{},announce:async r=>later.push(r.context.chatKey)}).load();
    await waitFor(()=>fresh.value.repairs[0].retold,5);
    assert.ok(fresh.value.repairs[0].liveAt&&!fresh.value.repairs[0].awaitingLive);assert.deepEqual(later,['private:2']);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

test('a repair that does not pass the tests, changes nothing, touches .runtime or adds a real QQ number is not applied',async()=>{
  for(const [fix,reason] of [
    [async()=>({summary:'nothing'}),/没改任何文件/],
    [async(job,w)=>{await fs.writeFile(path.join(w,'engine','math.mjs'),'export const add=()=>5;\n');},/测试没过/],
    [async(job,w)=>{await fs.mkdir(path.join(w,'.runtime'),{recursive:true});await fs.writeFile(path.join(w,'.runtime','x.json'),'{}');await fs.writeFile(path.join(w,'engine','math.mjs'),'export const add=(a,b)=>a+b;\n');},/不该动/],
    [async(job,w)=>{await fs.writeFile(path.join(w,'engine','math.mjs'),'export const add=(a,b)=>a+b; // 123456789\n');},/真实 QQ 号/]]){
    const p=await pipeline(fix);
    try{
      await p.repair.report(bug);
      await waitFor(()=>p.repair.value.repairs[0].status==='failed');
      assert.match(p.repair.value.repairs[0].error,reason);
      assert.match(await fs.readFile(path.join(p.root,'engine','math.mjs'),'utf8'),/a-b/,'main untouched');
    }finally{await p.cleanup();}
  }
});

test('when the main checkout has uncommitted work in the same file, the fix waits on its branch',async()=>{
  const p=await pipeline(async(job,w)=>{await fs.writeFile(path.join(w,'engine','math.mjs'),'export const add=(a,b)=>a+b;\n');},{dirty:true});
  try{
    await p.repair.report(bug);
    await waitFor(()=>p.repair.value.repairs[0].status==='ready');
    assert.match(p.repair.value.repairs[0].note,/repair\//);
    assert.match(await fs.readFile(path.join(p.root,'engine','math.mjs'),'utf8'),/being edited/);
  }finally{await p.cleanup();}
});

test('only program errors are repaired, and the same error has one signature',()=>{
  assert.equal(isProgramError(bug),true);
  assert.equal(isProgramError({kind:'agent',message:'read_file 把 docx 读成了乱码'}),true);
  for(const message of ['fetch failed','模型接口限流（429）','QQ 拒绝了这次操作（返回码 1200）','The operation was aborted','connect ECONNREFUSED 127.0.0.1:18191'])
    assert.equal(isProgramError({kind:'exception',message}),false,message);
  assert.equal(signature({kind:'exception',message:'TypeError at 12',stack:'at f (D:\\x\\engine\\a.mjs:3:4)'}),signature({kind:'exception',message:'TypeError at 99',stack:'at f (D:\\x\\engine\\a.mjs:8:1)'}));
});

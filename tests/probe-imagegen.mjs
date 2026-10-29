import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const config=JSON.parse(await fs.readFile(path.join(root,'.runtime/bridge.json'),'utf8'));
const win=p=>execFileSync('wslpath',['-w',p],{encoding:'utf8'}).trim();
const args=['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','workspace-write','--model','gpt-6-astra',
 '-c','model_reasoning_effort="low"','-c','features.shell_tool=false','-c','features.apps=false','-c','features.multi_agent=false','-c','features.view_image=false',
 '-c','features.image_generation=true','-c','features.skip_host_skill_discovery=true','-c','project_doc_max_bytes=0',
 '-c',`model_instructions_file=${JSON.stringify(win(path.join(root,'bridge/image-instructions.txt')))}`,'--cd',win(config.tempRoot),'--json','-'];
const child=spawn(config.codex,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,TEMP:win(config.tempRoot),TMP:win(config.tempRoot)}});
let buffer='',all='';const events=[];child.stderr.on('data',()=>{});
child.stdout.on('data',b=>{all+=b;buffer+=b;const lines=buffer.split('\n');buffer=lines.pop();for(const l of lines){try{const e=JSON.parse(l);events.push(e);console.log(JSON.stringify({type:e.type,itemType:e.item?.type,keys:e.item?Object.keys(e.item):undefined,status:e.item?.status,error:e.error?.message}));}catch{}}});
child.stdin.end('画一张简洁可爱的蓝色小鲸鱼，在浅蓝色背景中游动，清爽插画风格，不要文字。只生成一张图片，用内置生图工具。');
const timer=setTimeout(()=>child.kill(),240000);
child.on('close',async code=>{clearTimeout(timer);await fs.writeFile(path.join(root,'.runtime/imagegen-probe.jsonl'),all);console.log(JSON.stringify({exitCode:code,eventCount:events.length}));process.exitCode=code||0;});

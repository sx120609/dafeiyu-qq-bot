import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const win=p=>process.platform==='win32'?p:execFileSync('wslpath',['-w',p],{encoding:'utf8'}).trim();

export async function generateCodexImage(prompt,config,signal){
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1000)throw new Error('画面描述需为 1–1000 字');
  const root=config.generatedImagesRoot||'/mnt/d/Dev/Outputs/CodexGeneratedImages';
  const args=['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--model','gpt-6-astra',
    '-c','model_reasoning_effort="low"','-c','features.shell_tool=false','-c','features.apps=false','-c','features.multi_agent=false','-c','features.view_image=false',
    '-c','features.image_generation=true','-c','project_doc_max_bytes=0',
    '-c','model_instructions_file='+JSON.stringify(win(path.join(here,'image-instructions.txt'))),'--cd',win(config.tempRoot),'--json','-'];
  const started=Date.now();
  const threadId=await new Promise((resolve,reject)=>{
    const child=spawn(config.imageCodex||config.codex,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:win(config.tempRoot),TMP:win(config.tempRoot)}});
    let thread='',buffer='',completed=false,failed=false,done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(thread);};
    const abort=()=>{child.kill();finish(new Error('生图已取消'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('官方生图等待超时，请稍后重试'));},230000);
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>finish(new Error('Codex 官方客户端无法启动')));child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    child.stdout.on('data',b=>{buffer+=b;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{
      const e=JSON.parse(line);if(e.type==='thread.started')thread=e.thread_id;
      if(e.type==='turn.completed')completed=true;if(e.type==='turn.failed'||e.type==='error')failed=true;
      if(e.type==='item.started'&&['command_execution','mcp_tool_call','file_change'].includes(e.item?.type)){child.kill();finish(new Error('生图通道拒绝了非图像工具'));}
    }catch{}}});
    child.on('close',code=>finish(code===0&&completed&&!failed&&/^[a-f0-9-]{36}$/i.test(thread)?null:new Error('Codex 官方生图未完成')));
    child.stdin.end(JSON.stringify({image_description:prompt,number_of_images:1}));
  });
  // The image artifact directory uses the official thread.started ID.
  // Never trust a model-written path or choose another thread's recent image.
  const directory=path.join(root,threadId);
  let files;try{files=await fs.readdir(directory,{withFileTypes:true});}catch{throw Object.assign(new Error('本次没有生成图片，可能未通过生成要求或账户额度限制'),{status:422});}
  const names=files.filter(f=>f.isFile()&&!f.isSymbolicLink()&&/^exec-.*\.(png|jpg|jpeg|webp)$/i.test(f.name)).map(f=>f.name);
  if(!names.length)throw Object.assign(new Error('本次未产出可用图片'),{status:422});
  const realDirectory=await fs.realpath(directory),realRoot=await fs.realpath(root);
  if(!realDirectory.startsWith(realRoot+path.sep))throw new Error('图像输出路径校验失败');
  const selected=path.join(directory,names.sort()[0]),stat=await fs.stat(selected);
  if(stat.mtimeMs<started-5000||stat.size>8_000_000)throw new Error('图像输出时间或大小校验失败');
  const bytes=await fs.readFile(selected);
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216,webp=bytes.subarray(8,12).toString()==='WEBP';
  if(!png&&!jpeg&&!webp)throw new Error('图像文件格式无效');
  return {created:Math.floor(Date.now()/1000),model:'codex-built-in-image-generation',data:[{b64_json:bytes.toString('base64')}],elapsedMs:Date.now()-started};
}

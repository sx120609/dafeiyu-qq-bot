// Songs for the bot's compose_music tool (11-13: "加一个创作音乐的功能", "让肥鱼多自由发挥"): MiniMax Music 3 on the
// RTX 5090 server, reached over SSH with the key this computer keeps (host alias gpu5090 in ~/.ssh/config). The bot
// writes the description and lyrics itself; nothing here shapes them. scripts/gpu-music/compose.py is copied to the
// server's ~/dafeiyu-music the first time, the song is made there (about as long as it plays), the MP3 is read back
// and deleted. One song at a time: the model needs 23 GB of the shared GPU.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'scripts','gpu-music','compose.py');
const ssh=(config,command,{input,timeout=60_000,signal,binary=false}={})=>new Promise((resolve,reject)=>{
  const child=spawn(config.ssh||'ssh',['-o','BatchMode=yes','-o','ConnectTimeout=15',config.musicHost||'gpu5090',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const out=[],err=[];child.stdout.on('data',d=>out.push(d));child.stderr.on('data',d=>err.push(d));
  const timer=setTimeout(()=>child.kill(),timeout);
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  child.on('error',error=>{clearTimeout(timer);reject(new Error('连不上 5090：'+error.message));});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
    const data=Buffer.concat(out);resolve({code,out:binary?data:data.toString('utf8'),err:Buffer.concat(err).toString('utf8')});});
  child.stdin.on('error',()=>{});child.stdin.end(input??'');
});

let queue=Promise.resolve(),installed=null;
/** {audio (MP3 bytes), seconds, took}. */
export function composeMusic({prompt,lyrics='',seconds=60},config,{signal,run=ssh}={}){
  const make=async()=>{
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw Object.assign(new Error('音乐描述要 1–4000 字'),{status:400});
    if(typeof lyrics!=='string'||lyrics.length>6000)throw Object.assign(new Error('歌词太长了（最多 6000 字）'),{status:400});
    const duration=Math.max(10,Math.min(300,Number(seconds)||60));
    // The script on the server follows the one in this repository.
    const source=await fs.readFile(script,'utf8');
    if(installed!==source){
      const copied=await run(config,'mkdir -p ~/dafeiyu-music && cat > ~/dafeiyu-music/compose.py',{input:source,signal});
      if(copied.code!==0)throw new Error('5090 连不上或写不进去：'+(copied.err.trim().split('\n').pop()||copied.code));
      installed=source;
    }
    const model=config.musicModelDir||'$HOME/liubei-music/model',python=config.musicPython||'$HOME/liubei-music/venv/bin/python';
    const made=await run(config,`cd ~/dafeiyu-music && MUSIC_MODEL_DIR="${model}" "${python}" compose.py 2>>~/dafeiyu-music/compose.err`,
      {input:JSON.stringify({prompt:prompt.trim(),lyrics:lyrics.trim(),duration}),timeout:(duration*2+180)*1000,signal});
    let result;try{result=JSON.parse(made.out.trim().split('\n').pop());}catch{}
    if(!result)throw new Error('5090 上的作曲没跑完'+(made.code?`（退出码 ${made.code}）`:'')+(made.err.trim()?'：'+made.err.trim().split('\n').pop().slice(0,200):''));
    if(result.error)throw Object.assign(new Error(result.error),{status:503});
    if(!/^\/[\w\/.-]+\.mp3$/.test(result.file))throw new Error('5090 返回的文件名不对');
    const fetched=await run(config,`cat '${result.file}' && rm -f '${result.file}'`,{timeout:120_000,signal,binary:true});
    if(fetched.code!==0||fetched.out.length<1000)throw new Error('从 5090 取回音乐失败');
    return {audio:fetched.out,seconds:result.seconds,took:result.took};
  };
  const next=queue.then(make,make);queue=next.catch(()=>{});return next;
}

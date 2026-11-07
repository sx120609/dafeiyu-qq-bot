import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 2026-11-07: "Find the root cause and fix it in the code": a GIF-disabled API can still draw a sheet of motion frames.
// Reuse the installed Pillow dependency, with pipes so concurrent drawings need no temporary files or shared state.
export function animateImageSheet(image,{columns,rows,frames,frameMs},signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=execFile(process.env.DAFEIYU_PYTHON||'python',
      ['-P',fileURLToPath(new URL('./image-animation.py',import.meta.url)),String(columns),String(rows),String(frames),String(frameMs)],
      {windowsHide:true,encoding:'buffer',maxBuffer:12_000_000,timeout:30000,signal},(error,stdout,stderr)=>{
        if(signal?.aborted){reject(signal.reason);return;}
        if(error){reject(new Error('动图合成失败，请检查 Python Pillow：'+stderr.toString('utf8').trim().slice(-160)));return;}
        resolve(stdout);
      });
    child.stdin.on('error',()=>{});
    child.stdin.end(image);
  });
}

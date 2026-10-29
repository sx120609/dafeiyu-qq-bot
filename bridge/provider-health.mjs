import fs from 'node:fs/promises';

export function rateLimitError(text, fallbackSeconds=60) {
  if(!/\b429\b|too many requests|rate.?limit exceeded/i.test(text))return null;
  const retry=text.match(/(?:in\s+|retry.after["\s:=]+)(\d+(?:\.\d+)?)\s*s/i);
  const retryAfter=Math.max(1,Math.ceil(Number(retry?.[1]||fallbackSeconds)));
  return Object.assign(new Error(`模型服务限流（429），请等待 ${retryAfter} 秒后再试。期间不会继续请求模型。`),{status:429,retryAfter});
}

export async function withDeadline(call, signal, timeoutMs) {
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason||new Error('请求已取消'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(Object.assign(new Error(`模型在 ${Math.ceil(timeoutMs/1000)} 秒内没有返回，已停止等待，可重新测试。`),{status:504})),timeoutMs);
  let onAbort;
  try{
    const cancelled=new Promise((_,reject)=>{
      onAbort=()=>reject(controller.signal.reason);
      if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});
    });
    return await Promise.race([cancelled,Promise.resolve().then(()=>{controller.signal.throwIfAborted();return call(controller.signal);})]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
}

// Keep upstream Retry-After across gateway restarts. Contains only provider IDs and timestamps.
export class ProviderBackoff {
  constructor(file){this.file=file;this.until={};this.pending=Promise.resolve();this.ready=file?fs.readFile(file,'utf8').then(raw=>{this.until=JSON.parse(raw);}).catch(()=>{}):Promise.resolve();}
  snapshot(provider){const retryAfter=Math.max(0,Math.ceil(((this.until[provider]||0)-Date.now())/1000));return {limited:retryAfter>0,retryAfter,retryAt:retryAfter?this.until[provider]:null};}
  check(provider){const state=this.snapshot(provider);if(state.limited)throw Object.assign(new Error(`模型服务限流（429），还需等待 ${state.retryAfter} 秒。期间不会继续请求模型。`),{status:429,retryAfter:state.retryAfter});}
  async record(provider,error){
    if(error.status!==429)return;
    this.until[provider]=Math.max(this.until[provider]||0,Date.now()+Math.max(1,error.retryAfter||60)*1000);
    if(this.file){const data=JSON.stringify(this.until);this.pending=this.pending.catch(()=>{}).then(()=>fs.writeFile(this.file,data,{mode:0o600}));await this.pending;}
  }
}

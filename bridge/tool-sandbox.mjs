// Runs one my_ tool. Started by agent-tools.mjs with Node's --permission (no files, no child processes, no sockets of
// its own; in WSL also inside `unshare -rn`). The first stdin line is {code, args}; everything after is the gateway
// answering requests. Messages out, one JSON per line: fetch, store, qq, log, done, error.
import readline from 'node:readline';

const write=process.stdout.write.bind(process.stdout);
const send=(message,callback)=>write(JSON.stringify(message)+'\n',callback);
const pending=new Map();let nextId=1,started=false;

const log=(...values)=>send({type:'log',text:values.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ').slice(0,2000)});
// One request to the gateway, answered on stdin.
const ask=message=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});send({...message,id});});
// The gateway fetches for it (any address) and hands back something Response-like.
function brokeredFetch(url,options={}){
  const headers=options.headers&&typeof options.headers==='object'?Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[String(k),String(v)])):{};
  return ask({type:'fetch',url:String(url),options:{method:options.method?String(options.method):'GET',headers,body:options.body==null?undefined:String(options.body),
    responseType:options.responseType==='base64'?'base64':'text'}})
    .then(r=>({ok:r.status>=200&&r.status<300,status:r.status,statusText:r.statusText||'',url:r.url,
      headers:{get:name=>r.headers[String(name).toLowerCase()]??null,entries:()=>Object.entries(r.headers)},
      text:async()=>r.base64?Buffer.from(r.body,'base64').toString('utf8'):r.body,
      json:async()=>JSON.parse(r.base64?Buffer.from(r.body,'base64').toString('utf8'):r.body),
      base64:async()=>r.base64?r.body:Buffer.from(r.body,'utf8').toString('base64')}));
}
// The tool's own storage, kept by the gateway between runs.
const store={
  get:key=>ask({type:'store',op:'get',key}),
  set:(key,value)=>ask({type:'store',op:'set',key,value}),
  delete:key=>ask({type:'store',op:'delete',key}),
  keys:()=>ask({type:'store',op:'keys'}),
  all:()=>ask({type:'store',op:'all'})
};
const tools={fetch:brokeredFetch,log,store,qq:(action,params={})=>ask({type:'qq',action:String(action),params})};
globalThis.fetch=brokeredFetch;
console.log=console.info=console.warn=console.error=console.debug=log;

async function run({code,args}){
  try{
    const AsyncFunction=(async()=>{}).constructor;
    const value=await new AsyncFunction('args','tools',code)(args??{},tools);
    const output=typeof value==='string'?value:value===undefined?'':JSON.stringify(value,null,1);
    // 2026-11-06: "别截断长字段"; the gateway needs complete bytes to make a reusable file reference.
    await new Promise(resolve=>send({type:'done',output:String(output)},resolve));
  }catch(error){await new Promise(resolve=>send({type:'error',message:String(error?.stack||error).slice(0,4000)},resolve));}
  process.exit(0);
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(!started){started=true;run(message);return;}
  const waiting=pending.get(message.id);if(!waiting)return;
  pending.delete(message.id);
  message.error?waiting.reject(new Error(message.error)):waiting.resolve(message.response);
});

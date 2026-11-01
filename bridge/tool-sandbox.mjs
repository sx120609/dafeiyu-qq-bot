// Runs one self-made tool. Started by agent-tools.mjs inside `unshare -rn` (no network of its own) and with
// Node's --permission (no files, no child processes). The first stdin line is {code, args}; everything after is
// the gateway answering fetches. Messages out, one JSON per line: fetch, log, done, error.
import readline from 'node:readline';

const write=process.stdout.write.bind(process.stdout);
const send=message=>write(JSON.stringify(message)+'\n');
const pending=new Map();let nextId=1,started=false;

const log=(...values)=>send({type:'log',text:values.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ').slice(0,500)});
// The only way out: the gateway fetches for it (public addresses only) and hands back something Response-like.
function brokeredFetch(url,options={}){
  return new Promise((resolve,reject)=>{
    const id=nextId++;pending.set(id,{resolve,reject});
    const headers=options.headers&&typeof options.headers==='object'?Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[String(k),String(v)])):{};
    send({type:'fetch',id,url:String(url),options:{method:options.method?String(options.method):'GET',headers,body:options.body==null?undefined:String(options.body)}});
  }).then(r=>({ok:r.status>=200&&r.status<300,status:r.status,statusText:r.statusText||'',url:r.url,
    headers:{get:name=>r.headers[String(name).toLowerCase()]??null,entries:()=>Object.entries(r.headers)},
    text:async()=>r.body,json:async()=>JSON.parse(r.body)}));
}
const tools={fetch:brokeredFetch,log};
globalThis.fetch=brokeredFetch;
console.log=console.info=console.warn=console.error=console.debug=log;

async function run({code,args}){
  try{
    const AsyncFunction=(async()=>{}).constructor;
    const value=await new AsyncFunction('args','tools',code)(args??{},tools);
    const output=typeof value==='string'?value:value===undefined?'':JSON.stringify(value,null,1);
    send({type:'done',output:String(output).slice(0,8000)});
  }catch(error){send({type:'error',message:String(error?.stack||error).slice(0,2000)});}
  process.exit(0);
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(!started){started=true;run(message);return;}
  const waiting=pending.get(message.id);if(!waiting)return;
  pending.delete(message.id);
  message.error?waiting.reject(new Error(message.error)):waiting.resolve(message.response);
});

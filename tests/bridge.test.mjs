import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,completion,validateRequest,model} from '../bridge/server.mjs';
const request={model,messages:[{role:'user',content:'你好'}]};
test('protocol supports replies, JSON, tool rounds, and usage',()=>{
  assert.equal(completion(request,{content:'你好',tool_calls:[]},{input_tokens:5,output_tokens:3}).usage.total_tokens,8);
  const b={...request,tools:[{type:'function',function:{name:'search_web'}}]};
  const c=completion(b,{content:'',tool_calls:[{name:'search_web',arguments:'{"query":"weather"}'}]});
  assert.equal(c.choices[0].finish_reason,'tool_calls');
  assert.equal(c.choices[0].message.tool_calls[0].function.name,'search_web');
  // Unknown tools are dropped rather than failing the reply; with nothing left it is an empty reply.
  assert.throws(()=>completion(b,{content:'',tool_calls:[{name:'exec',arguments:'{}'}]}),/Empty reply/);
  const kept=completion(b,{content:'',tool_calls:[{name:'exec',arguments:'{}'},{name:'search_web',arguments:'{"query":"a"}'},{name:'search_web',arguments:'{"query":"b"}'},{name:'search_web',arguments:'{"query":"c"}'}]});
  assert.deepEqual(kept.choices[0].message.tool_calls.map(t=>JSON.parse(t.function.arguments).query),['a','b']);
  // A JSON reply wrapped in a fence or a sentence is unwrapped instead of discarded.
  const json={...request,response_format:{type:'json_object'}};
  assert.equal(completion(json,{content:'```json\n{"text":"hi"}\n```',tool_calls:[]}).choices[0].message.content,'{"text":"hi"}');
  assert.equal(completion(json,{content:'bad json',tool_calls:[]}).choices[0].message.content,'bad json');
});
test('rejects unsupported model, streams, external image fetches',()=>{
  validateRequest(request);
  assert.throws(()=>validateRequest({...request,model:'deepseek-chat'}));
  assert.throws(()=>validateRequest({...request,stream:true}));
  assert.throws(()=>validateRequest({...request,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://localhost/secret'}}]}]}));
});
test('HTTP auth, browser isolation, single flight, and disconnect cancellation',async()=>{
  const token='x'.repeat(40);let signal;
  const server=createServer({token},async(b,c,s)=>{signal=s;await new Promise(resolve=>s.addEventListener('abort',resolve));throw new Error('cancelled');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/v1/models')).status,401);
    assert.equal((await fetch(base+'/v1/models',{headers:{authorization:`Bearer ${token}`,origin:'https://example.org'}})).status,401);
    assert.equal((await (await fetch(base+'/v1/models',{headers:{authorization:`Bearer ${token}`}})).json()).data[0].id,model);
    const abort=new AbortController();
    const options={method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(request)};
    const pending=fetch(base+'/v1/chat/completions',{...options,signal:abort.signal}).catch(()=>{});
    for(let i=0;!signal&&i<100;i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(signal);
    assert.equal((await fetch(base+'/v1/chat/completions',options)).status,429);
    abort.abort();await pending;
    for(let i=0;!signal.aborted&&i<100;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(signal.aborted,true);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('an agent turn may offer many tools, run long, and end without words',()=>{
  const tools=Array.from({length:40},(_,i)=>({type:'function',function:{name:'t'+i,parameters:{type:'object',properties:{}}}}));
  const messages=[{role:'user',content:'x'},...Array.from({length:150},()=>({role:'tool',tool_call_id:'c',content:'ok'}))];
  assert.doesNotThrow(()=>validateRequest({model,messages,tools}));
  assert.equal(completion({tools,metadata:{dafeiyu_purpose:'director'}},{content:''}).choices[0].message.content,'（结束）');
});

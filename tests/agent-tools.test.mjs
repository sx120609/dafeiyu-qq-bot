import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentTools,publicAddress,brokerFetch} from '../bridge/agent-tools.mjs';

const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'agent-tools-'));
const schema={type:'object',properties:{city:{type:'string'}},required:['city']};
// A pretend internet: every public address answers with what was asked for.
const fakeFetch=async(url,options)=>new Response(JSON.stringify({url:String(url),method:options.method,body:options.body??null}),{status:200,headers:{'content-type':'application/json'}});
const allowAll=async raw=>new URL(raw);

test('a tool is saved and enabled only after its test run works, and then runs by name',async()=>{
  const runtime=await temp();
  try{
    const tools=await new AgentTools({runtime,fetchImpl:fakeFetch,check:allowAll}).load();
    const broken=await tools.create({name:'my_weather',description:'查天气',parameters:schema,code:'throw new Error("还没写好")',test_arguments:{city:'南京'}});
    assert.equal(broken.saved,false);assert.match(broken.test.error,/还没写好/);
    assert.deepEqual(tools.definitions(),[]);
    const made=await tools.create({name:'my_weather',description:'查天气',parameters:schema,chat:'群·测试',
      code:'const r=await tools.fetch("https://example.com/w?c="+encodeURIComponent(args.city));const j=await r.json();console.log("got",r.status);return "天气："+j.url;',
      test_arguments:{city:'南京'}});
    assert.equal(made.saved,true);assert.match(made.test.output,/example\.com\/w\?c=%E5%8D%97%E4%BA%AC/);
    assert.deepEqual(made.test.logs,['got 200']);
    assert.equal(tools.definitions()[0].function.name,'my_weather');
    assert.equal(tools.definitions()[0].function.parameters.additionalProperties,false);
    const ran=await tools.run('my_weather',{city:'上海'});
    assert.equal(ran.ok,true);assert.match(ran.output,/%E4%B8%8A%E6%B5%B7/);
    assert.equal(tools.find('my_weather').runs,1);
    // Saved to disk; a switched-off tool is not offered and does not run.
    const reread=await new AgentTools({runtime}).load();
    assert.equal(reread.find('my_weather').chat,'群·测试');
    await tools.update({name:'my_weather',enabled:false});
    assert.deepEqual(tools.definitions(),[]);
    await assert.rejects(tools.run('my_weather',{city:'x'}),/停用/);
    await tools.update({name:'my_weather',remove:true});
    assert.equal(tools.find('my_weather'),undefined);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

test('names, requirements and schemas are checked before anything runs',async()=>{
  const runtime=await temp();
  try{
    const tools=new AgentTools({runtime,spawnSandbox:()=>{throw new Error('should not run');}});
    await assert.rejects(tools.create({name:'weather',requirement:'x',code:'return 1'}),/my_/);
    await assert.rejects(tools.create({name:'my_x1',requirement:'',code:''}),/requirement/);
    await assert.rejects(tools.create({name:'my_x1',requirement:'查天气'}),/写代码的模型/);
    const badSchema=await tools.create({name:'my_x1',description:'x',parameters:{type:'string'},code:'return 1'});
    assert.equal(badSchema.saved,false);assert.match(badSchema.test.error,/object/);
    const badType=await tools.create({name:'my_x1',description:'x',parameters:{type:'object',properties:{a:{type:'date'}}},code:'return 1'});
    assert.equal(badType.saved,false);assert.match(badType.test.error,/type/);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

// 11-03: the code comes from Codex (Astra); a draft that fails its test goes back with the error until one works.
test('the writer drafts the code, failing drafts go back with their error, and the working one is kept',async()=>{
  const runtime=await temp();
  try{
    const requests=[];
    const writer=async request=>{
      requests.push(request);
      return requests.length===1?{description:'查汇率',parameters:schema,code:'throw new Error("接口地址写错了")'}
        :{description:'查汇率',parameters:schema,code:'return "1 USD = 7.1 CNY ("+args.city+")"'};
    };
    const tools=await new AgentTools({runtime,writer}).load();
    const made=await tools.create({name:'my_rate',requirement:'查美元兑人民币汇率',test_arguments:{city:'南京'}});
    assert.equal(made.saved,true);assert.equal(made.drafts,2);
    assert.match(requests[1].previous.error,/接口地址写错了/);
    assert.equal(tools.find('my_rate').writtenBy,'codex');assert.equal(tools.find('my_rate').requirement,'查美元兑人民币汇率');
    assert.equal(tools.definitions()[0].function.description,'查汇率','offered like a built-in tool, no "self-written" label');
    const never=await new AgentTools({runtime,writer:async()=>({description:'x',parameters:schema,code:'throw new Error("不行")'})}).create({name:'my_bad',requirement:'x',test_arguments:{}});
    assert.equal(never.saved,false);assert.equal(never.drafts,3);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

test('a tool keeps its own storage between runs and may use QQ, except what hurts someone',async()=>{
  const runtime=await temp();
  try{
    const calls=[];
    const tools=await new AgentTools({runtime,qq:async(action,params)=>{calls.push(action);return {members:[{user_id:1,card:'甲'}],params};}}).load();
    const code='const n=(await tools.store.get("count")??0)+1;await tools.store.set("count",n);const m=await tools.qq("get_group_member_list",{group_id:1});'+
      'await tools.qq("send_group_msg",{group_id:1,message:"hi"});let refused="";try{await tools.qq("set_group_kick",{group_id:1,user_id:2});}catch(e){refused=e.message;}return {n,first:m.members[0].card,refused};';
    const first=await tools.execute(code,{},'my_counter'),second=await tools.execute(code,{},'my_counter');
    assert.equal(JSON.parse(first.output).n,1);assert.equal(JSON.parse(second.output).n,2);
    assert.equal(JSON.parse(second.output).first,'甲');assert.match(JSON.parse(second.output).refused,/踢人/);
    assert.deepEqual(calls,['get_group_member_list','send_group_msg','get_group_member_list','send_group_msg']);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

test('the sandbox has no files, no child processes and no network of its own',async()=>{
  const runtime=await temp();
  try{
    const tools=new AgentTools({runtime,fetchImpl:fakeFetch,check:allowAll});
    const files=await tools.execute('const fs=await import("node:fs/promises");return await fs.readFile("/etc/hostname","utf8");',{});
    assert.equal(files.ok,false);assert.match(files.error,/ERR_ACCESS_DENIED|permission/i);
    const processes=await tools.execute('const cp=await import("node:child_process");return cp.execSync("id").toString();',{});
    assert.equal(processes.ok,false);assert.match(processes.error,/ERR_ACCESS_DENIED|permission/i);
    const socket=await tools.execute('const net=await import("node:net");return await new Promise((ok,no)=>{const s=net.connect(80,"1.1.1.1",()=>ok("connected"));s.on("error",e=>no(e));});',{});
    // WSL: unshare leaves no network; Windows: Node's permission model refuses the socket.
    assert.equal(socket.ok,false);assert.match(socket.error,/ENETUNREACH|EACCES|unreachable|ERR_ACCESS_DENIED/i);
    const slow=await new AgentTools({runtime}).execute('return 40+2',{});
    assert.deepEqual([slow.ok,slow.output],[true,'42']);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

// 11-03: "这个也可以访问外网"——a tool reaches any http(s) address, intranet and localhost included.
test('fetch reaches any http address, follows redirects and can return bytes',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.1','::1'])assert.equal(publicAddress(ip),false,ip);
  const local=await brokerFetch('http://127.0.0.1:18191/healthz',{},{fetchImpl:fakeFetch});
  assert.equal(local.status,200);assert.match(local.body,/127\.0\.0\.1/);
  await assert.rejects(brokerFetch('file:///etc/passwd',{},{fetchImpl:fakeFetch}),/http/);
  let hops=0;const redirecting=async url=>++hops<3?new Response('',{status:302,headers:{location:'http://192.168.1.1/next'}}):fakeFetch(url,{method:'GET'});
  assert.equal((await brokerFetch('http://1.1.1.1/',{},{fetchImpl:redirecting})).status,200);
  const bytes=await brokerFetch('http://example.com/x.png',{responseType:'base64'},{fetchImpl:async()=>new Response(new Uint8Array([137,80,78,71]))});
  assert.equal(bytes.base64,true);assert.deepEqual([...Buffer.from(bytes.body,'base64')],[137,80,78,71]);
});

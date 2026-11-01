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

test('names, schemas and code are checked before anything runs',async()=>{
  const runtime=await temp();
  try{
    const tools=new AgentTools({runtime,spawnSandbox:()=>{throw new Error('should not run');}});
    await assert.rejects(tools.create({name:'weather',description:'x',parameters:schema,code:'return 1'}),/my_/);
    await assert.rejects(tools.create({name:'my_x1',description:'',parameters:schema,code:'return 1'}),/description/);
    await assert.rejects(tools.create({name:'my_x1',description:'x',parameters:{type:'string'},code:'return 1'}),/object/);
    await assert.rejects(tools.create({name:'my_x1',description:'x',parameters:{type:'object',properties:{a:{type:'date'}}},code:'return 1'}),/type/);
    await assert.rejects(tools.create({name:'my_x1',description:'x',parameters:schema,code:''}),/code/);
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
    assert.equal(socket.ok,false);assert.match(socket.error,/ENETUNREACH|EACCES|unreachable/i);
    const slow=await new AgentTools({runtime}).execute('return 40+2',{});
    assert.deepEqual([slow.ok,slow.output],[true,'42']);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

test('fetch reaches only public addresses',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
  await assert.rejects(brokerFetch('http://127.0.0.1:18191/console/api/state',{},{fetchImpl:fakeFetch}),/内网/);
  await assert.rejects(brokerFetch('file:///etc/passwd',{},{fetchImpl:fakeFetch}),/http/);
  await assert.rejects(brokerFetch('http://[::1]:6099/',{},{fetchImpl:fakeFetch}),/内网/);
  // A redirect into the local network is checked like the first address.
  const redirecting=async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/'}});
  await assert.rejects(brokerFetch('http://1.1.1.1/',{},{fetchImpl:redirecting}),/内网/);
});

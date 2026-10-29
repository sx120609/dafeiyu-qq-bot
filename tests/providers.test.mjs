import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Settings,createGateway} from '../bridge/gateway.mjs';
import {runCloud,cloudBase,cloudModels,anthropicBody,useNativeSearch,withCompliance,generateCloudImage} from '../bridge/providers.mjs';
const request={model:'dafeiyu-active',messages:[{role:'user',content:'hi'}],response_format:{type:'json_object'},thinking:{type:'enabled'}};
test('cloud protocols: model listing, JSON generation, tool messages and no secret redirects',async()=>{
  let observed;
  const server=http.createServer(async(req,res)=>{
    const b=[];for await(const c of req)b.push(c);observed={headers:req.headers,body:b.length?JSON.parse(Buffer.concat(b)):null};
    res.setHeader('Content-Type','application/json');
    if(req.url.startsWith('/v1/models'))return res.end(JSON.stringify({data:[{id:'synthetic-model',display_name:'Synthetic'}]}));
    if(req.url==='/v1/chat/completions')return res.end(JSON.stringify({model:'synthetic-model',choices:[{finish_reason:'stop',message:{content:'{"text":"ok"}'}}],usage:{prompt_tokens:2,completion_tokens:3}}));
    if(req.url==='/v1/messages')return res.end(JSON.stringify({model:'synthetic-claude',stop_reason:'end_turn',content:[{type:'text',text:'{"text":"ok"}'}],usage:{input_tokens:2,output_tokens:3}}));
    res.writeHead(307,{Location:'https://example.invalid/secret'});res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  try{
    const p={protocol:'openai',model:'synthetic-model',apiKey:'test-key',baseUrl};
    assert.equal(cloudBase(p),baseUrl);assert.throws(()=>cloudBase({baseUrl:'ftp://example.org'}),/http/);assert.throws(()=>cloudBase({baseUrl:'https://user:pw@example.org'}),/账号/);
    assert.equal((await cloudModels(p,{allowLocal:true}))[0].id,'synthetic-model');
    const result=await runCloud(request,p,undefined,{allowLocal:true});assert.equal(result.usage.total_tokens,5);
    assert.equal(observed.headers.authorization,'Bearer test-key');assert.equal(observed.body.thinking,undefined);
    const r=await runCloud(request,{...p,protocol:'anthropic'},undefined,{allowLocal:true});assert.equal(r.model,'synthetic-claude');assert.equal(observed.headers['x-api-key'],'test-key');
    const mapped=anthropicBody({messages:[{role:'assistant',content:null,tool_calls:[{id:'call1',function:{name:'search_web',arguments:'{"query":"test"}'}}]},{role:'tool',tool_call_id:'call1',content:'found'}]},p);
    assert.equal(mapped.messages[0].content[0].type,'tool_use');assert.equal(mapped.messages[1].content[0].tool_use_id,'call1');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('cloud image generation: base64 image, refusals and responses that are not images',async()=>{
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32)]);let mode='ok',observed;
  const server=http.createServer(async(req,res)=>{
    const b=[];for await(const c of req)b.push(c);observed={url:req.url,body:JSON.parse(Buffer.concat(b))};
    res.setHeader('Content-Type','application/json');
    if(mode==='refused'){res.writeHead(400);return res.end(JSON.stringify({error:{code:'content_policy_violation',message:'rejected'}}));}
    if(mode==='text')return res.end(JSON.stringify({data:[{b64_json:Buffer.from('not an image').toString('base64')}]}));
    if(mode==='unsupported'){res.writeHead(404);return res.end('{}');}
    res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}],usage:{input_tokens:5,output_tokens:9}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const p={protocol:'openai',apiKey:'test-key',imageModel:'synthetic-image',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  try{
    const result=await generateCloudImage('一只鲸鱼',p);
    assert.equal(observed.url,'/v1/images/generations');assert.equal(observed.body.model,'synthetic-image');assert.equal(observed.body.n,1);
    assert.deepEqual(Buffer.from(result.data[0].b64_json,'base64'),png);assert.equal(result.model,'synthetic-image');
    mode='refused';await assert.rejects(generateCloudImage('x',p),e=>e.status===422);
    mode='text';await assert.rejects(generateCloudImage('x',p),/格式无效/);
    mode='unsupported';await assert.rejects(generateCloudImage('x',p),/不支持生图/);
    await assert.rejects(generateCloudImage('',p),/1–1000/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('console requires separate auth; validates keys, saves, tests and atomically activates',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-console-test-'));
  const settings=await new Settings(path.join(temp,'providers.json')).load();
  const config={token:'model-secret',consoleToken:'console-secret'};
  const invoked=[];
  const invoke=async(body,c,p,profile)=>{invoked.push(p);if(profile.model==='fails')throw new Error('synthetic failure');return {model:profile.model,choices:[{message:{content:'连接成功'}}],usage:{prompt_tokens:5,completion_tokens:2}};};
  const discover={codex:async()=>[{id:'gpt-test'}],claude:async()=>[{id:'sonnet'}],cloud:async()=>[{id:'api-test'}]};
  const server=createGateway(config,settings,{runtime:temp,invoke,discover});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(route,body,token=config.consoleToken)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json',Origin:base}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  try{
    assert.equal((await call('/console/api/state',null,config.token)).status,401);
    assert.equal((await fetch(base+'/console/api/state',{headers:{Authorization:'Bearer '+config.consoleToken,Origin:'https://example.org'}})).status,401);
    let view=(await call('/console/api/state')).data;
    const save=await call('/console/api/save',{provider:'cloud',revision:view.revision,profile:{apiKey:'private-key',model:'api-test'}});assert.equal(save.status,200);assert.equal(save.data.profiles.cloud.apiKey,undefined);assert.equal(save.data.profiles.cloud.hasApiKey,true);
    assert.equal((await call('/console/api/test',{provider:'cloud'})).status,200);
    // Switching no longer waits for a passing test; the console tests on save instead.
    const active=await call('/console/api/activate',{provider:'cloud',revision:save.data.revision});assert.equal(active.data.active,'cloud');
    const change=settings.profile('cloud',{baseUrl:'https://api.example.org/v1'});assert.equal(change.apiKey,'private-key');
    assert.equal((await call('/console/api/save',{provider:'cloud',revision:'stale',profile:{model:'x'}})).status,409);
    const catalog=await call('/console/api/models',{provider:'claude'});assert.equal(catalog.data.models[0].id,'sonnet');
    await Promise.all([settings.persist(),settings.persist()]);assert.equal(JSON.parse(await fs.readFile(settings.file)).active,'cloud');
    assert.equal((await call('/console/api/save',{provider:'cloud',revision:active.data.revision,profile:{model:'fails'}})).status,200);
    assert.equal((await call('/console/api/test',{provider:'cloud'})).status,400);assert.equal(settings.value.checks.cloud.ok,false);
    // Both connection tests are metered, the failed one too, under their own purpose.
    const metered=(await call('/console/api/usage?days=1')).data;
    const tests=metered.purposes.find(p=>p.purpose==='test');
    assert.equal(tests.calls,2);assert.equal(tests.failures,1);assert.equal(metered.totals.input,5);assert.equal(metered.totals.output,2);
    assert.equal((await call('/console/api/usage/price',{key:'cloud|api-test',price:{input:2,output:8}})).status,200);
    assert.equal((await call('/console/api/usage?days=1')).data.models.find(m=>m.model==='api-test').costSource,'priced');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});}
});
test('Codex and Claude replace hand-written text search with their own web search; cloud keeps the tools',()=>{
  const tool=name=>({type:'function',function:{name,parameters:{type:'object'}}});
  const body={messages:[{role:'system',content:'persona'},{role:'user',content:'今天上海天气？'}],tools:[tool('search_web'),tool('get_weather'),tool('search_images'),tool('calculate')],tool_choice:'auto'};
  for(const provider of ['codex','claude']){
    const {body:routed,webSearch}=useNativeSearch(body,provider);
    assert.equal(webSearch,true);
    assert.deepEqual(routed.tools.map(t=>t.function.name),['get_weather','search_images','calculate']);
    assert.match(routed.messages[0].content,/^persona\n联网搜索：/);
  }
  assert.equal(body.tools.length,4);assert.equal(body.messages[0].content,'persona');
  assert.equal(useNativeSearch(body,'cloud').webSearch,false);
  const only=useNativeSearch({...body,tools:[tool('search_web')]},'codex').body;
  assert.equal(only.tools,undefined);assert.equal(only.tool_choice,undefined);
  assert.equal(useNativeSearch({messages:body.messages,tools:[tool('calculate')]},'codex').webSearch,false);
});test('every chat-facing call carries the China compliance rule; memory consolidation does not need it',()=>{
  const body={messages:[{role:'system',content:'persona'},{role:'user',content:'hi'}]};
  const routed=withCompliance(body);
  assert.match(routed.messages[0].content,/^persona\n【合规要求/);assert.match(routed.messages[0].content,/中华人民共和国法律法规/);
  assert.equal(body.messages[0].content,'persona');
  assert.match(withCompliance({messages:[{role:'user',content:'hi'}]}).messages[0].content,/^【合规要求/);
  const memory={...body,metadata:{dafeiyu_purpose:'memory'}};assert.equal(withCompliance(memory),memory);
});
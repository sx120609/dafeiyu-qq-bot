// Real call: does each local provider answer a fresh-information question with its own web search?
// Uses account quota. Usage (WSL): node tests/live-native-search.mjs [codex|claude ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import {dispatch} from '../bridge/providers.mjs';
const root=path.resolve(import.meta.dirname,'..');
const config=JSON.parse(await fs.readFile(path.join(root,'.runtime/bridge.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(path.join(root,'.runtime/providers.json'),'utf8'));
const tool=(name,field)=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{[field]:{type:'string'}},required:[field],additionalProperties:false}}});
const body={model:'dafeiyu-active',messages:[
  {role:'system',content:'你是 QQ 群友大肥鱼。用中文一两句话回答。输出 JSON：{"text":"回复","emotion":"neutral","intensity":0}'},
  {role:'user',content:'今天上海天气怎么样？顺便说下你是查到的还是猜的'}],
  tools:[tool('search_web','query'),tool('get_weather','city'),tool('calculate','expression')],response_format:{type:'json_object'}};
for(const provider of process.argv.slice(2).length?process.argv.slice(2):['codex','claude']){
  const started=Date.now();
  try{
    const result=await dispatch(body,config,provider,settings.profiles[provider]);
    const message=result.choices[0].message;
    console.log(JSON.stringify({provider,model:result.model,ms:Date.now()-started,content:message.content,toolCalls:(message.tool_calls||[]).map(t=>t.function.name)},null,0));
  }catch(error){console.log(JSON.stringify({provider,ms:Date.now()-started,error:error.message}));}
}

import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runCodex,model} from '../bridge/server.mjs';
const config=JSON.parse(await fs.readFile(new URL('../.runtime/bridge.json',import.meta.url),'utf8'));
const response=await runCodex({model,response_format:{type:'json_object'},messages:[
  {role:'system',content:'你是大肥鱼，一个用 GPT 驱动的蓝色鲸鱼娘。只返回 JSON，字段 text, emotion, intensity。text 用中文简短回应。'},
  {role:'user',content:'你好，今天一起吃鱼香肉丝吧！'}
]},config);
const result=JSON.parse(response.choices[0].message.content);
assert.ok(result.text);assert.equal(typeof result.intensity,'number');
console.log(JSON.stringify({ok:true,model:response.model,reply:result,usage:response.usage}));

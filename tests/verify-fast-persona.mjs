import fs from 'node:fs/promises';
import path from 'node:path';
import {runCodex} from '../bridge/server.mjs';
const root=path.resolve(import.meta.dirname,'..'),config=JSON.parse(await fs.readFile(path.join(root,'.runtime/bridge.json'),'utf8'));
const selectedModel=process.env.DAFEIYU_TEST_MODEL||'gpt-6-astra';
config.serviceTier=process.env.DAFEIYU_TEST_TIER||'default';
const persona=await fs.readFile(path.join(root,'personas/folk-friend.txt'),'utf8');
const format='\n输出一个JSON对象，恰好text、emotion、intensity三项。emotion是neutral/joy/smug/annoyed/sad/sleepy/flustered/teasing之一；intensity是0至3整数；text不超过180字。';
const results=[];
for(const input of ['又要早八了，唉','你刚才理解错了，我说的是明天我去面试，不是我朋友','我把泡面料包和面一起扔了，现在只有一碗热水']){
  const start=Date.now();
  const response=await runCodex({model:selectedModel,response_format:{type:'json_object'},messages:[{role:'system',content:persona+format},{role:'user',content:input}]},{...config,model:selectedModel});
  const reply=JSON.parse(response.choices[0].message.content);
  if(!reply.text||!Number.isInteger(reply.intensity))throw new Error('Invalid persona output');
  results.push({input,reply,ms:Date.now()-start});console.log(JSON.stringify(results.at(-1)));
}
const image=await fs.readFile(path.join(root,'.runtime/synthetic-vision.png'));
const response=await runCodex({model:selectedModel,messages:[{role:'user',content:[{type:'text',text:'中间是什么颜色、什么形状？只说所见。'},{type:'image_url',image_url:{url:'data:image/png;base64,'+image.toString('base64')}}]}]},{...config,model:selectedModel});
const visual=response.choices[0].message.content;if(!visual.includes('红')||!/(方形|方块)/.test(visual))throw new Error('Vision check failed');
console.log(JSON.stringify({model:selectedModel,vision:visual}));await fs.writeFile(path.join(root,'.runtime/fast-persona-'+selectedModel.replace(/[^a-z0-9.-]/gi,'_')+'.json'),JSON.stringify({model:selectedModel,results,vision:visual},null,2));

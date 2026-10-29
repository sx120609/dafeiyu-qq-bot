import fs from 'node:fs/promises';
import {runCodex} from '../bridge/server.mjs';
const config=JSON.parse(await fs.readFile(new URL('../.runtime/bridge.json',import.meta.url),'utf8'));
if(process.env.DAFEIYU_PROBE_CODEX)config.codex=process.env.DAFEIYU_PROBE_CODEX;
if(process.env.DAFEIYU_PROBE_TIER)config.serviceTier=process.env.DAFEIYU_PROBE_TIER;
const messages=[{role:'system',content:'你是自然、聪明的中文 QQ 聊天伙伴。先理解具体问题再回答，不强行开玩笑，不反复自称，不编造。只输出 JSON：text 为中文简洁回答，emotion 为 neutral/joy/smug/annoyed/sad/sleepy/flustered/teasing 之一，intensity 为 0 到 3 的整数。最多 100 字。'},{role:'user',content:'我昨晚没睡好，今天还得上课，有没有立刻能用的办法？'}];
const results=[];
for(const selected of process.argv.slice(2).length?process.argv.slice(2):['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']){
  const start=Date.now();
  try{const response=await runCodex({model:selected,messages,response_format:{type:'json_object'}},{...config,model:selected});results.push({model:selected,ms:Date.now()-start,usage:response.usage,reply:JSON.parse(response.choices[0].message.content)});}
  catch(error){results.push({model:selected,ms:Date.now()-start,error:error.message});}
  console.log(JSON.stringify(results.at(-1)));
}
await fs.writeFile(new URL('../.runtime/model-benchmark.json',import.meta.url),JSON.stringify(results,null,2));

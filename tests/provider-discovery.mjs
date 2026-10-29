import fs from 'node:fs/promises';
import {codexModels,claudeModels,runClaude} from '../bridge/providers.mjs';
const config=JSON.parse(await fs.readFile(new URL('../.runtime/bridge.json',import.meta.url),'utf8'));
for(const [provider,fn] of [['codex',codexModels],['claude',claudeModels]]){
  try{const models=await fn(config);console.log(JSON.stringify({provider,models}));}
  catch(e){console.log(JSON.stringify({provider,error:e.message}));process.exitCode=1;}
}
if(process.argv.includes('--generate')){
  const r=await runClaude({model:'gpt-6-astra',messages:[{role:'system',content:'你是大肥鱼，友好的鲸鱼娘，用中文简短回答。'},{role:'user',content:'你好，介绍一下自己。'}]},config,{model:'sonnet'});
  console.log(JSON.stringify({provider:'claude',model:r.model,reply:r.choices[0].message.content}));
}

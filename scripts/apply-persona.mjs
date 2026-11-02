// Applies the 大肥鱼 persona (personas/dafeiyu.txt) and the conversation settings to the running engine; replies keep running.
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const control=new URL((await fs.readFile(path.join(root,'.runtime','control-url.txt'),'utf8')).trim());
const headers={'X-QQ-Control':control.hash.slice(1),Origin:control.origin,'Content-Type':'application/json'};
const call=async(route,body)=>{
  const response=await fetch(control.origin+route,{method:body?'POST':'GET',headers,body:body&&JSON.stringify(body)});
  const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'HTTP '+response.status);return data;
};
const state=await call('/api/status');
// Replies are not cut short (2000 is the engine's ceiling); stickers only when the model picks a fitting one.
// 11-03: no loop protection, one second between messages, no per-chat cooldown ("把乱七八糟的过度防护全拆了").
const persona={...state.persona,style:'custom',customName:'大肥鱼',customPrompt:(await fs.readFile(path.join(root,'personas','dafeiyu.txt'),'utf8')).replace(/\r\n/g,'\n'),
  maxCharacters:2000,banter:1,stickersEnabled:true,stickerIntervalSeconds:600,stickerEveryReplies:0};
const ai={...state.config.ai,cooldownSeconds:0,maxTokens:4000,sendLimits:{...(state.config.ai.sendLimits||{}),globalIntervalSeconds:1}};
await call('/api/action',{action:'save',configurationRevision:state.configurationRevision,persona,ai,loopProtectionEnabled:false});
console.log('Persona and conversation settings applied.');

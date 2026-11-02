// Applies the 大肥鱼 persona (personas/dafeiyu.txt) and the conversation limits to the running engine; replies keep running.
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
// Up to 500 characters per reply, at most three messages when the model splits it with blank lines.
// Stickers only when a reply is strongly emotional and the model picked a fitting one; never on a
// fixed every-N-replies schedule, and at most one every ten minutes.
const persona={...state.persona,style:'custom',customName:'大肥鱼',customPrompt:await fs.readFile(path.join(root,'personas','dafeiyu.txt'),'utf8'),
  maxCharacters:500,banter:1,stickersEnabled:true,stickerIntervalSeconds:600,stickerEveryReplies:0};
// A reply may be several messages, so the send budget counts messages, not replies.
const ai={...state.config.ai,cooldownSeconds:2,maxTokens:2000,dailyLimit:1500,sendLimits:{...(state.config.ai.sendLimits||{}),daily:1500,perChatDaily:400,globalIntervalSeconds:1}};
await call('/api/action',{action:'save',configurationRevision:state.configurationRevision,persona,ai,loopProtectionEnabled:true});
console.log('Folk persona and conversation limits applied.');

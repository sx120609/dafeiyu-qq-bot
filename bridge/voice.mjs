// Voice (发语音): text to speech through OpenAI's speech endpoint, or a compatible one, with its own key so it
// does not depend on which connection writes the replies. The key is written to .runtime/voice.json (0600) and
// never sent back to the console.
import fs from 'node:fs/promises';
import path from 'node:path';

export const voices=['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'];
const defaults={enabled:false,baseUrl:'https://api.openai.com/v1',model:'gpt-4o-mini-tts',voice:'coral',speed:1,
  instructions:'用可爱、轻快、有点调皮的年轻女生声音说中文，像在 QQ 群里随口发语音，自然口语，不要播音腔，不要拖长音。'};

export class VoiceSettings{
  constructor({runtime,fetcher=fetch}){this.file=path.join(runtime,'voice.json');this.fetch=fetcher;this.value={...defaults,apiKey:''};}
  async load(){try{this.value={...this.value,...JSON.parse(await fs.readFile(this.file,'utf8'))};}catch{}return this;}
  async persist(){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
  get ready(){return this.value.enabled&&!!this.value.apiKey;}
  view(){const {apiKey,...rest}=this.value;return {...rest,keySet:!!apiKey,voices,defaults:{baseUrl:defaults.baseUrl,model:defaults.model,instructions:defaults.instructions}};}
  async update(data){
    const next={...this.value};
    if(typeof data.enabled==='boolean')next.enabled=data.enabled;
    if(typeof data.baseUrl==='string'&&data.baseUrl.trim()){
      let url;try{url=new URL(data.baseUrl.trim());}catch{throw new Error('接口地址不对');}
      if(url.protocol!=='https:'||url.username||url.password||url.search)throw new Error('接口地址要是 https，不能带账号密码或查询参数');
      next.baseUrl=url.href.replace(/\/+$/,'');
    }
    if(typeof data.model==='string'){if(!/^[\w.\-:/]{1,80}$/.test(data.model.trim()))throw new Error('模型名不对');next.model=data.model.trim();}
    if(typeof data.voice==='string'){if(!/^[\w\-]{1,40}$/.test(data.voice.trim()))throw new Error('音色名不对');next.voice=data.voice.trim();}
    if(typeof data.instructions==='string')next.instructions=data.instructions.trim().slice(0,600);
    if(data.speed!==undefined){const speed=Number(data.speed);if(!(speed>=0.5&&speed<=2))throw new Error('语速要在 0.5–2 之间');next.speed=speed;}
    if(typeof data.apiKey==='string'&&data.apiKey.trim()){if(data.apiKey.trim().length>400)throw new Error('API Key 太长');next.apiKey=data.apiKey.trim();}
    if(data.clearKey===true){next.apiKey='';next.enabled=false;}
    if(next.enabled&&!next.apiKey)throw new Error('先填 API Key 再打开');
    this.value=next;await this.persist();return this.view();
  }
  /** One short line as mp3 bytes. */
  async speak(text){
    const v=this.value;if(!v.apiKey)throw new Error('语音还没填 API Key');
    const input=String(text||'').trim().slice(0,600);if(!input)throw new Error('没有要说的话');
    const body={model:v.model,voice:v.voice,input,response_format:'mp3'};
    if(v.speed!==1)body.speed=v.speed;
    // tts-1 and tts-1-hd have no style instructions; the newer speech models do.
    if(v.instructions&&!/^tts-1/.test(v.model))body.instructions=v.instructions;
    const response=await this.fetch(v.baseUrl+'/audio/speech',{method:'POST',headers:{Authorization:'Bearer '+v.apiKey,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    if(!response.ok){
      let message='';try{message=(await response.json()).error?.message||'';}catch{}
      throw new Error('语音合成失败（HTTP '+response.status+(message?'：'+String(message).slice(0,160):'')+'）');
    }
    const audio=Buffer.from(await response.arrayBuffer());
    if(audio.length<200||audio.length>8_000_000)throw new Error('语音合成返回的音频不对');
    return audio;
  }
}

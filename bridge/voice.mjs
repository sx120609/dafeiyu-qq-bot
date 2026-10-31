// Voice (发语音): a line of text spoken by an OpenAI voice model, with its own key so it does not depend on which
// connection writes the replies. The key is written to .runtime/voice.json (0600) and never sent back to the console.
//
// Two ways to call it:
// - realtime (default): the Realtime API over a WebSocket, gpt-realtime-2.1-mini reading the line as written.
//   OpenAI deprecated the /audio/speech models (tts-1, tts-1-hd, gpt-4o-mini-tts; shut down 2027-01-06) and
//   points to this model instead, which is not served on /audio/speech.
// - speech: the old /audio/speech endpoint, for relays that only offer that.
import fs from 'node:fs/promises';
import path from 'node:path';

export const voices=['marin','cedar','alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'];
export const engines={realtime:{model:'gpt-realtime-2.1-mini'},speech:{model:'gpt-4o-mini-tts'}};
const defaults={enabled:false,engine:'realtime',baseUrl:'https://api.openai.com/v1',model:engines.realtime.model,voice:'marin',speed:1,
  instructions:'可爱、轻快、有点调皮的年轻女生声音，说中文，像在 QQ 群里随口发语音，自然口语，不要播音腔，不要拖长音。'};

/** 16-bit mono PCM at 24 kHz, the Realtime API's output, as a WAV file QQ and browsers can play. */
export function wav(pcm,rate=24000){
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);
  header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}
// The realtime model is a conversational one: it is told to read, not to answer.
const reader=style=>'你是配音员，只做一件事：把用户发来的那段文字原样念出来。一字不改，不回答、不评论、不翻译、不加任何别的话，括号和标点不要念出来。'+
  (style?'声音和语气：'+style:'');

export class VoiceSettings{
  constructor({runtime,fetcher=fetch,socket=(url,init)=>new WebSocket(url,init)}){
    this.file=path.join(runtime,'voice.json');this.fetch=fetcher;this.socket=socket;this.value={...defaults,apiKey:''};
  }
  async load(){
    try{
      const saved=JSON.parse(await fs.readFile(this.file,'utf8'));
      // Saved before there was a choice: a speech-endpoint model keeps using that endpoint.
      if(!saved.engine)saved.engine=/tts/.test(saved.model||'')?'speech':'realtime';
      this.value={...this.value,...saved};
    }catch{}
    return this;
  }
  async persist(){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
  get ready(){return this.value.enabled&&!!this.value.apiKey;}
  view(){const {apiKey,...rest}=this.value;return {...rest,keySet:!!apiKey,voices,engines,defaults:{baseUrl:defaults.baseUrl,instructions:defaults.instructions}};}
  async update(data){
    const next={...this.value};
    if(typeof data.enabled==='boolean')next.enabled=data.enabled;
    if(data.engine!==undefined){if(!engines[data.engine])throw new Error('调用方式不对');next.engine=data.engine;}
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
  /** One short line as audio: {audio: Buffer, type}. */
  async speak(text){
    if(!this.value.apiKey)throw new Error('语音还没填 API Key');
    const input=String(text||'').trim().slice(0,600);if(!input)throw new Error('没有要说的话');
    return this.value.engine==='speech'?{audio:await this.speech(input),type:'audio/mpeg'}:{audio:await this.realtime(input),type:'audio/wav'};
  }
  realtime(input){
    const v=this.value,url=v.baseUrl.replace(/^https:/,'wss:')+'/realtime?model='+encodeURIComponent(v.model);
    return new Promise((resolve,reject)=>{
      const chunks=[];let settled=false,timer;
      const socket=this.socket(url,{headers:{Authorization:'Bearer '+v.apiKey}});
      const finish=(error,value)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        try{socket.close();}catch{}
        error?reject(error):resolve(value);
      };
      timer=setTimeout(()=>finish(new Error('语音合成超时')),60000);
      socket.onopen=()=>{
        socket.send(JSON.stringify({type:'session.update',session:{type:'realtime',output_modalities:['audio'],instructions:reader(v.instructions),
          audio:{output:{format:{type:'audio/pcm',rate:24000},voice:v.voice}}}}));
        socket.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:input}]}}));
        socket.send(JSON.stringify({type:'response.create'}));
      };
      socket.onmessage=event=>{
        let data;try{data=JSON.parse(typeof event.data==='string'?event.data:Buffer.from(event.data).toString());}catch{return;}
        if(data.type==='response.output_audio.delta'&&data.delta)chunks.push(Buffer.from(data.delta,'base64'));
        else if(data.type==='error')finish(new Error('语音合成失败：'+String(data.error?.message||'未知错误').slice(0,160)));
        else if(data.type==='response.done'){
          const status=data.response?.status;
          if(status&&status!=='completed')return finish(new Error('语音合成没完成（'+status+'）'));
          const pcm=Buffer.concat(chunks);
          if(pcm.length<4800)return finish(new Error('语音合成没有出声音'));
          if(pcm.length>8_000_000)return finish(new Error('语音太长'));
          finish(null,wav(pcm));
        }
      };
      socket.onerror=()=>finish(new Error('连不上语音接口（实时模型）'));
      socket.onclose=event=>finish(new Error('语音接口断开了'+(event?.reason?'：'+String(event.reason).slice(0,120):'')));
    });
  }
  async speech(input){
    const v=this.value;
    const body={model:v.model,voice:v.voice,input,response_format:'mp3'};
    if(v.speed!==1)body.speed=v.speed;
    // tts-1 and tts-1-hd have no style instructions; gpt-4o-mini-tts does.
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

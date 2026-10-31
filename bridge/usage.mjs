import fs from 'node:fs/promises';
import path from 'node:path';

// Beijing date of a timestamp: the day boundary the owner sees.
export const usageDay=(time=Date.now())=>new Date(time+8*3600_000).toISOString().slice(0,10);
const keep=120;
const blank=()=>({calls:0,failures:0,ms:0,input:0,cached:0,output:0,reasoning:0,reportedCost:0});
// List prices (USD per million tokens) for models the bot can use through Codex or the cloud API, so their
// cost is estimated without the owner typing anything. From third-party price trackers in October 2026
// (aitokenprice.com, benchlm.ai); gpt-6.1-terra is not listed anywhere and is set between Sol and Luna.
// Codex on a ChatGPT plan bills the plan, not tokens: these show what the same use would cost on the API.
export const referencePrices={
  'gpt-6-astra':{input:10,cachedInput:1,output:50},
  'gpt-6.1-sol':{input:2,cachedInput:0.1,output:10},
  'gpt-6.1-terra':{input:1,cachedInput:0.1,output:6,estimated:true},
  'gpt-6-sol':{input:2,cachedInput:0.2,output:10},
  'gpt-6-luna':{input:0.1,cachedInput:0.01,output:0.5},
  'gpt-5.6-sol':{input:4,cachedInput:0.4,output:20},
  'gpt-5.6-terra':{input:2,cachedInput:0.2,output:12},
  'gpt-5.6-luna':{input:0.2,cachedInput:0.02,output:1.2},
  'gpt-5.5':{input:5,cachedInput:0.5,output:30},
  // Claude list prices (Anthropic API, 2026-10). Claude Code reports its own cost, so these only price calls it
  // reported none for; it names models by alias, hence the aliases.
  'claude-opus-5-5':{input:4,cachedInput:0.2,output:20},
  'claude-sonnet-5-5':{input:2,cachedInput:0.2,output:10},
  'claude-haiku-5-5':{input:0.1,cachedInput:0.01,output:0.5,estimated:true},
  'claude-fable-5-1':{input:10,cachedInput:0.25,output:50},
  opus:{input:4,cachedInput:0.2,output:20},default:{input:4,cachedInput:0.2,output:20},
  sonnet:{input:2,cachedInput:0.2,output:10},haiku:{input:0.1,cachedInput:0.01,output:0.5,estimated:true},
  fable:{input:10,cachedInput:0.25,output:50},
  // Image models are priced per token: text input, image output (OpenAI, 2026-11).
  'gpt-image-2.5-flare':{input:5,cachedInput:1.25,output:30},
  'gpt-image-2.5-sunburst':{input:5,cachedInput:1.25,output:30},
  // Voice: the realtime models' output is audio, priced at the audio rate; input is the text to read.
  'gpt-realtime-2.1-mini':{input:0.6,cachedInput:0.06,output:20},
  'gpt-realtime-2.1':{input:4,cachedInput:0.4,output:64},
  // The /audio/speech models report no usage; the voice module records characters as input "tokens".
  'tts-1':{input:15,output:0},
  'tts-1-hd':{input:30,output:0},
  // gpt-4o-mini-tts bills $12 per million audio tokens, not reported here: about 1.5 cents a minute, roughly
  // 250 Chinese characters, so about $60 per million characters.
  'gpt-4o-mini-tts':{input:60,output:0,estimated:true}
};

// Every model call the gateway makes, summed per Beijing day and per provider, model, purpose and conversation.
// Prices are USD per million tokens, set by the owner for providers that report no cost of their own.
export class UsageLedger{
  constructor({runtime}){this.file=path.join(runtime,'usage.json');this.data={days:{},prices:{},cnyPerUsd:7.1};this.timer=null;this.writing=Promise.resolve();}
  async load(){try{this.data={...this.data,...JSON.parse(await fs.readFile(this.file,'utf8'))};}catch{}return this;}
  persist(){
    const snapshot=JSON.stringify(this.data);
    this.writing=this.writing.catch(()=>{}).then(async()=>{await fs.writeFile(this.file+'.tmp',snapshot,{mode:0o600});await fs.rename(this.file+'.tmp',this.file);});
    return this.writing;
  }
  schedule(){if(this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.persist().catch(()=>{});},2000);this.timer.unref?.();}
  record({provider,model,purpose='chat',chat='',ok=true,ms=0,usage={},at=Date.now()}){
    const today=usageDay(at),days=this.data.days;
    const clean=v=>String(v||'').replaceAll('|','/').slice(0,60);
    const row=(days[today]??={})[[provider,clean(model)||'unknown',purpose,clean(chat)].join('|')]??=blank();
    row.calls++;if(!ok)row.failures++;row.ms+=Math.max(0,ms|0);
    // OpenAI chat names its fields prompt/completion; the image, Realtime and Anthropic APIs say input/output.
    row.input+=usage.prompt_tokens||usage.input_tokens||0;
    row.cached+=usage.cached_tokens||usage.prompt_tokens_details?.cached_tokens||usage.input_tokens_details?.cached_tokens||usage.input_token_details?.cached_tokens||0;
    row.output+=usage.completion_tokens||usage.output_tokens||0;
    row.reasoning+=usage.reasoning_tokens||0;row.reportedCost+=Number(usage.cost_usd)||0;
    for(const old of Object.keys(days).sort().slice(0,-keep))delete days[old];
    this.schedule();
  }
  // A provider's own figure wins (Claude Code reports one); then the owner's price; then the list price.
  priceFor(provider,model){
    const own=this.data.prices[`${provider}|${model}`];
    if(own)return {price:own,source:'priced'};
    const listed=referencePrices[model];
    return listed?{price:listed,source:'reference'}:null;
  }
  cost(provider,model,row){
    if(row.reportedCost>0)return {usd:row.reportedCost,source:'reported'};
    const found=this.priceFor(provider,model);
    if(!found)return {usd:0,source:'unpriced'};
    const {price}=found,fresh=Math.max(0,row.input-row.cached);
    return {usd:(fresh*(price.input||0)+row.cached*(price.cachedInput??price.input??0)+row.output*(price.output||0))/1e6,source:found.source};
  }
  summary({days=7,now=Date.now()}={}){
    const dates=[...Array(days).keys()].map(i=>usageDay(now-(days-1-i)*86400_000));
    const totals={...blank(),usd:0,unpriced:0},byModel={},byPurpose={},byChat={},daily=[];
    for(const date of dates){
      const day={date,calls:0,tokens:0,usd:0};
      for(const [key,row] of Object.entries(this.data.days[date]||{})){
        const [provider,model,purpose,chat='']=key.split('|'),{usd,source}=this.cost(provider,model,row);
        for(const field of Object.keys(blank()))totals[field]+=row[field];
        totals.usd+=usd;if(source==='unpriced')totals.unpriced+=row.calls;
        const m=byModel[`${provider}|${model}`]??={provider,model,...blank(),usd:0,costSource:source};
        for(const field of Object.keys(blank()))m[field]+=row[field];
        m.usd+=usd;if(source!=='unpriced')m.costSource=source;
        const p=byPurpose[purpose]??={purpose,calls:0,failures:0,tokens:0,usd:0};
        p.calls+=row.calls;p.failures+=row.failures;p.tokens+=row.input+row.output;p.usd+=usd;
        if(chat){const c=byChat[chat]??={chat,calls:0,tokens:0,usd:0};c.calls+=row.calls;c.tokens+=row.input+row.output;c.usd+=usd;}
        day.calls+=row.calls;day.tokens+=row.input+row.output;day.usd+=usd;
      }
      daily.push(day);
    }
    const models=Object.values(byModel).sort((a,b)=>b.calls-a.calls).map(m=>({...m,price:this.data.prices[`${m.provider}|${m.model}`]||null,referencePrice:referencePrices[m.model]||null}));
    const chats=Object.values(byChat).sort((a,b)=>b.tokens-a.tokens).slice(0,20);
    return {days,totals,models,purposes:Object.values(byPurpose).sort((a,b)=>b.calls-a.calls),chats,daily,cnyPerUsd:this.data.cnyPerUsd};
  }
  // Every model worth a price: the configured ones, any used in the ledger, and any already priced.
  // Claude Code reports its own cost, so it is not listed.
  priceList(configured=[]){
    const seen=new Map();
    const add=(provider,model)=>{
      if(!model||provider==='claude'||!['codex','cloud'].includes(provider))return;
      const key=`${provider}|${model}`;
      if(!seen.has(key))seen.set(key,{provider,model,price:this.data.prices[key]||null,referencePrice:referencePrices[model]||null});
    };
    for(const m of configured)add(m.provider,m.model);
    for(const day of Object.values(this.data.days))for(const key of Object.keys(day)){const [provider,model]=key.split('|');add(provider,model);}
    for(const key of Object.keys(this.data.prices)){const [provider,...rest]=key.split('|');add(provider,rest.join('|'));}
    return [...seen.values()];
  }
  async setPrice(key,price){
    if(typeof key!=='string'||!/^(codex|claude|cloud)\|[^|]{1,150}$/.test(key))throw new Error('模型标识无效');
    if(price===null)delete this.data.prices[key];
    else{
      const value=v=>{if(v===undefined||v===null||v==='')return undefined;const n=Number(v);if(!Number.isFinite(n)||n<0||n>10000)throw new Error('单价需为 0–10000 的数字（美元 / 百万 tokens）');return n;};
      const next={input:value(price.input),cachedInput:value(price.cachedInput),output:value(price.output)};
      if(next.input===undefined&&next.output===undefined)throw new Error('至少填写输入或输出单价');
      this.data.prices[key]=Object.fromEntries(Object.entries(next).filter(([,v])=>v!==undefined));
    }
    await this.persist();
  }
  async setRate(rate){
    const n=Number(rate);if(!Number.isFinite(n)||n<=0||n>100)throw new Error('汇率需为 0–100 之间的数字');
    this.data.cnyPerUsd=n;await this.persist();
  }
}

// The models of the DeepSeek Harness installed on this computer (`dsh`, 11-04: "加一个接入本机dsh的模型方法"). The
// gateway reads dsh's own model list and saved keys from its home (DSH_HOME, else ~/.dsh) and calls those providers
// directly: dsh's agent runtimes (headless, sdk) are coding agents with their own shell and file tools and persona,
// while the bot needs a plain model with its own tools. Whatever is added in dsh shows up here, and no key is copied.
//   settings.yaml   llm-pi-ai.providers.<id>: {displayName, api, baseURL, apiKeyEnv, models: [{id, name}]}
//   .credentials.yaml  refs.<ENV NAME>: the key; looked up like dsh does: the environment, this file, then .env.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {runCloud} from './providers.mjs';

const protocols={'openai-completions':'openai','anthropic-messages':'anthropic'};
export const dshHome=(env=process.env)=>env.DSH_HOME||path.join(os.homedir(),'.dsh');
const read=async file=>{try{return await fs.readFile(file,'utf8');}catch{return null;}};

/** dsh's providers and models, with each provider's key found or not. Throws when dsh has no settings here. */
export async function dshCatalog({home=dshHome(),env=process.env}={}){
  const settings=await read(path.join(home,'settings.yaml'));
  if(settings===null)throw new Error(`没找到本机 dsh 的配置（${path.join(home,'settings.yaml')}）：先装好 dsh 并在里面配好模型`);
  const providers=YAML.parse(settings)?.['llm-pi-ai']?.providers||{};
  const credentials=YAML.parse(await read(path.join(home,'.credentials.yaml'))||'')?.refs||{};
  const dotenv=Object.fromEntries((await read(path.join(home,'.env'))||'').split(/\r?\n/).map(line=>line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map(([,name,value])=>[name,value.replace(/^(['"])(.*)\1$/,'$2')]));
  const keyOf=name=>name?String(env[name]||credentials[name]||dotenv[name]||''):'';
  return Object.entries(providers).map(([id,p])=>({id,name:String(p?.displayName||id),protocol:protocols[p?.api]||null,api:String(p?.api||''),
    baseUrl:String(p?.baseURL||''),apiKey:keyOf(p?.apiKeyEnv),keyName:String(p?.apiKeyEnv||''),
    models:(Array.isArray(p?.models)?p.models:[]).filter(m=>typeof m?.id==='string').map(m=>({id:m.id,name:String(m.name||m.id)}))}));
}

/** The model catalog for the console: "<provider>/<model>", only from providers the gateway can call. */
export async function dshModels(options={}){
  const list=[];
  for(const p of await dshCatalog(options)){
    const note=!p.protocol?`dsh 里的 ${p.api} 接口这里还不支持`:!p.baseUrl?'dsh 里没写接口地址':!p.apiKey?`dsh 里没存 ${p.keyName}`:'';
    if(note)continue;
    for(const m of p.models)list.push({id:`${p.id}/${m.id}`,name:`${m.name}`,description:p.name,source:'本机 dsh'});
  }
  if(!list.length)throw new Error('本机 dsh 里没有能用的模型（需要 OpenAI 兼容或 Anthropic 接口，并在 dsh 里存好密钥）');
  return list;
}

/** The cloud profile a dsh model id stands for: its provider's address, protocol and key. */
export async function dshProfile(model,options={}){
  const at=String(model||'').indexOf('/');
  if(at<1)throw new Error('请从目录里选一个 dsh 模型（形如 服务商/模型）');
  const id=model.slice(0,at),name=model.slice(at+1);
  const p=(await dshCatalog(options)).find(x=>x.id===id);
  if(!p)throw new Error(`本机 dsh 里没有服务商「${id}」`);
  if(!p.protocol)throw new Error(`dsh 里「${p.name}」用的 ${p.api} 接口这里还不支持`);
  if(!p.apiKey)throw new Error(`dsh 里没存「${p.name}」的密钥（${p.keyName}）`);
  return {protocol:p.protocol,baseUrl:p.baseUrl,apiKey:p.apiKey,model:name};
}

/** One model call through a dsh provider, read fresh each time so a change in dsh applies at once. */
export async function runDsh(body,profile,signal,options={}){
  const result=await runCloud(body,await dshProfile(profile.model,options),signal);
  result.model=profile.model;
  return result;
}

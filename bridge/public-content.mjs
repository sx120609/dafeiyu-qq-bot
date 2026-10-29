import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseHTML,DOMParser} from 'linkedom';
import {runProcess} from './providers.mjs';
const dnsCache=new Map();

export function publicAddress(address){
  const a=address.toLowerCase().replace(/^::ffff:/,'');
  if(net.isIP(a)===4){
    const p=a.split('.').map(Number);
    return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&(p[1]===18||p[1]===19)));
  }
  return net.isIP(a)===6&&/^[23]/.test(a)&&!/^2001:db8:|^2002:/.test(a);
}
export async function publicFetch(raw,{limit=1_000_000,timeout=15000,headers={},redirects=3}={}){
  const url=new URL(raw);
  // The address check below is the boundary (no loopback or LAN); any port on a public host is fine.
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.href.length>2500)throw new Error('只支持公开网页地址');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(host==='localhost'||/\.(local|localhost|internal)$/i.test(host))throw new Error('不访问本机或内网地址');
  const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await dns.lookup(host,{all:true});
  let checked=addresses;
  // A local TUN proxy answers with RFC2544 fake IPs and routes each connection by the domain behind
  // them (domestic sites such as Bilibili go direct). Check the domain's real addresses separately,
  // but still connect through the fake IP: dialing the real IP would hide the domain from the proxy
  // and send the request out through whatever node unmatched traffic uses.
  if(!net.isIP(host)&&addresses.length&&addresses.every(x=>/^198\.(18|19)\./.test(x.address))){
    const cached=dnsCache.get(host);
    if(cached&&cached.until>Date.now())checked=cached.addresses;
    else{
      const response=await publicFetch('https://1.1.1.1/dns-query?name='+encodeURIComponent(host)+'&type=A',{headers:{accept:'application/dns-json'},limit:64000,timeout:10000});
      const data=JSON.parse(response.body.toString());
      checked=(data.Answer||[]).filter(x=>x.type===1).map(x=>({address:x.data,family:4}));
      if(dnsCache.size>300)dnsCache.delete(dnsCache.keys().next().value);
      dnsCache.set(host,{addresses:checked,until:Date.now()+60000});
    }
  }
  if(!checked.length||checked.some(x=>!publicAddress(x.address)))throw new Error('不访问本机或内网地址');
  return new Promise((resolve,reject)=>{
    const req=(url.protocol==='https:'?https:http).request(url,{
      headers:{'User-Agent':'Mozilla/5.0 DafeiyuPublicReader/1.0','Accept-Encoding':'identity',...headers},
      lookup:(_host,options,callback)=>options.all?callback(null,addresses):callback(null,addresses[0].address,addresses[0].family)
    },res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();if(redirects<=0){reject(new Error('网页跳转过多'));return;}publicFetch(new URL(res.headers.location,url).href,{limit,timeout,headers,redirects:redirects-1}).then(resolve,reject);return;}
      if(res.statusCode<200||res.statusCode>=300){res.resume();reject(new Error('公开页面返回 HTTP '+res.statusCode));return;}
      let size=0;const chunks=[];
      res.on('data',b=>{size+=b.length;if(size>limit){res.destroy(new Error('公开内容超过读取上限'));}else chunks.push(b);});
      res.on('end',()=>resolve({url:url.href,body:Buffer.concat(chunks),type:res.headers['content-type']||''}));res.on('error',reject);
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('公开内容读取超时')));req.on('error',reject);req.end();
  });
}
// Bilibili answers its public web APIs only to requests that look like its own web player.
const bilibiliHeaders={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',Referer:'https://www.bilibili.com/'};
const bilibiliHost=host=>/(^|\.)(bilibili\.com|hdslb\.com)$/.test(host);
const bilibiliVideoLink=url=>(bilibiliHost(url.hostname)&&/\/video\/(BV[0-9a-zA-Z]{10}|av\d+)/i.test(url.pathname))||/^(b23\.tv|bili2233\.cn)$/.test(url.hostname);
const queryText=value=>{if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('关键词为空或太长');return value.trim();};
export function calculate(expression){
  if(typeof expression!=='string'||expression.length>160||/[^0-9eE.+\-*/%() \t^]/.test(expression))throw new Error('仅支持数字、括号和四则/幂运算');
  const tokens=expression.match(/\d*\.?\d+(?:[eE][+-]?\d+)?|[()+\-*/%^]/g)||[];let position=0;
  if(tokens.join('')!==expression.replace(/\s/g,''))throw new Error('算式格式无效');
  function atom(){const t=tokens[position++];if(t==='('){const v=sum();if(tokens[position++]!==')')throw new Error('括号不匹配');return v;}if(t===undefined||!Number.isFinite(Number(t)))throw new Error('算式无效');return Number(t);}
  function unary(){if(tokens[position]==='+'||tokens[position]==='-'){const sign=tokens[position++];return (sign==='-'?-1:1)*unary();}return power();}
  function power(){let v=atom();if(tokens[position]==='^'){position++;const n=unary();if(Math.abs(n)>1000)throw new Error('指数过大');v=v**n;}return v;}
  function product(){let v=unary();while(['*','/','%'].includes(tokens[position])){const op=tokens[position++],r=unary();v=op==='*'?v*r:op==='/'?v/r:v%r;}return v;}
  function sum(){let v=product();while(['+','-'].includes(tokens[position])){const op=tokens[position++],r=product();v=op==='+'?v+r:v-r;}return v;}
  const result=sum();if(position!==tokens.length||!Number.isFinite(result))throw new Error('算式无效或结果超出范围');return result;
}

export class PublicContent{
  constructor({runtime,analyze}){this.runtime=runtime;this.analyze=analyze;this.items=[];this.options={explorationEnabled:true};this.timer=null;this.writing=Promise.resolve();}
  async load(){try{const value=JSON.parse(await fs.readFile(path.join(this.runtime,'public-activity.json'),'utf8'));this.items=value.items||[];this.options={...this.options,...value.options};}catch{}return this;}
  async persist(){const file=path.join(this.runtime,'public-activity.json'),value=JSON.stringify({items:this.items.slice(0,30),options:this.options});this.writing=this.writing.catch(()=>{}).then(async()=>{await fs.writeFile(file+'.tmp',value,{mode:0o600});await fs.rename(file+'.tmp',file);});return this.writing;}
  async record(item,scope='public-exploration'){this.items=this.items.filter(x=>!(x.url===item.url&&x.scope===scope));this.items.unshift({...item,scope,at:new Date().toISOString()});this.items=this.items.slice(0,30);await this.persist();}
  async json(url){const response=await publicFetch(url,{limit:2_000_000,headers:bilibiliHost(new URL(url).hostname)?bilibiliHeaders:{}});return JSON.parse(response.body.toString());}
  async readPage(url,scope){
    // A Bilibili video page is drawn by scripts; its title, description, subtitles and frames come from the video reader.
    if(bilibiliVideoLink(new URL(url)))return this.video(url,scope);
    const address=new URL(url).href;
    const response=await publicFetch(address);
    if(!/html|text|json|xml/.test(response.type))throw new Error('这不是可读取的公开文字页面');
    let title=address,text;
    if(response.type.includes('html')){
      const {document}=parseHTML(response.body.toString());title=document.querySelector('title')?.textContent?.trim()||title;
      for(const node of document.querySelectorAll('script,style,noscript,nav,footer,header,form'))node.remove();
      text=(document.querySelector('article,main')||document.body)?.textContent||'';
    }else text=response.body.toString();
    text=text.replace(/\s+/g,' ').trim().slice(0,8000);
    if(text.length<50)throw new Error('页面没有可读正文，可能需要登录或由脚本加载');
    const item={title:title.slice(0,160),url:response.url,evidence:'已读取公开网页正文',summary:text.slice(0,500)};
    await this.record(item,scope);return {...item,text};
  }
  async browse(query,scope){
    const keywords=queryText(query);
    const response=await publicFetch('https://www.bing.com/search?format=rss&mkt=zh-CN&setlang=zh-Hans&cc=CN&q='+encodeURIComponent(keywords));
    const xml=new DOMParser().parseFromString(response.body.toString(),'text/xml');
    const rows=[...xml.querySelectorAll('item')].slice(0,3).map(item=>({title:item.querySelector('title')?.textContent||'',url:item.querySelector('link')?.textContent||'',summary:item.querySelector('description')?.textContent||'',evidence:'搜索摘要，未阅读全文'})).filter(x=>/^https?:\/\//.test(x.url));
    for(const item of rows){try{const page=await this.readPage(item.url,scope);Object.assign(item,{summary:page.text.slice(0,3200),evidence:page.evidence});break;}catch{}}
    if(!rows.length)throw new Error('没有找到可用的公开结果');return rows;
  }
  async weather(city){
    const names=await this.json('https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(queryText(city))+'&count=1&language=zh&format=json');
    const place=names.results?.[0];if(!place)throw new Error('没有找到这个城市，请换成城市全名');
    const url='https://api.open-meteo.com/v1/forecast?latitude='+place.latitude+'&longitude='+place.longitude+'&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2&timezone=auto';
    const forecast=await this.json(url);return {city:place.name,country:place.country,current:forecast.current,units:forecast.current_units,daily:forecast.daily,source:'https://open-meteo.com/'};
  }
  async videos(query,scope){
    let response;
    if(query){response=await this.json('https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword='+encodeURIComponent(queryText(query)));}
    else response=await this.json('https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1');
    if(response.code!==0)throw new Error('公开视频网站暂未提供结果；没有绕过登录或验证');
    const data=query?response.data?.result:response.data?.list;
    const rows=(data||[]).slice(0,5).map(x=>({title:String(x.title||'').replace(/<[^>]*>/g,''),bvid:x.bvid,url:'https://www.bilibili.com/video/'+x.bvid,description:x.desc||x.description||'',duration:x.duration,evidence:'视频列表与简介，尚未观看画面'}));
    return rows;
  }
  async directVideo(raw,scope){
    const url=new URL(raw);
    if(!/^https?:$/.test(url.protocol)||!/\.(mp4|webm|mov)$/i.test(url.pathname))throw new Error('请提供 BV号、B站链接或直接公开 MP4/WebM 链接');
    const response=await publicFetch(url.href,{limit:20_000_000,timeout:25000});
    if(!/video\/|octet-stream/.test(response.type))throw new Error('这个链接没有返回可读取的视频文件');
    const dir=path.join(this.runtime,'video-frames',crypto.randomUUID());await fs.mkdir(dir,{recursive:true});
    try{
      const input=path.join(dir,'input.video');await fs.writeFile(input,response.body,{mode:0o600});
      const format=url.pathname.toLowerCase().endsWith('.webm')?'matroska':'mov';
      await runProcess('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-threads','2','-filter_threads','1','-protocol_whitelist','file,pipe','-f',format,'-i',input,'-t','35','-vf','fps=1/10:round=up,scale=640:-2','-frames:v','3',path.join(dir,'frame-%02d.jpg')],'',{timeout:30000});
      const files=(await fs.readdir(dir)).filter(x=>/^frame-\d+\.jpg$/.test(x)).sort();if(!files.length)throw new Error('没有提取到有效画面');
      const images=await Promise.all(files.map(x=>fs.readFile(path.join(dir,x))));
      const observations=this.analyze?await this.analyze('以下是公开短视频前35秒范围内的抽帧。描述实际可见内容，不假装听过音轨。',images):'已取得抽帧，未进行模型观察。';
      const result={title:decodeURIComponent(url.pathname.split('/').pop()),url:response.url,evidence:(this.analyze?'已观察':'已提取')+'前35秒范围内 '+images.length+' 张抽帧；未读取音轨',frameCount:images.length,observations};
      await this.record({...result,summary:observations},scope);return result;
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  }
  async video(raw,scope){
    let source=String(raw).trim();
    // Share links (b23.tv) redirect to the video page; follow them to learn which video it is.
    if(/^https?:\/\/(b23\.tv|bili2233\.cn)\//i.test(source))source=(await publicFetch(source,{headers:bilibiliHeaders,limit:3_000_000})).url;
    const bvid=source.match(/BV[0-9a-zA-Z]{10}/)?.[0];
    const aid=bvid?null:(source.match(/^av(\d{1,12})$/i)||(/^https?:\/\//.test(source)&&bilibiliVideoLink(new URL(source))?source.match(/\/video\/av(\d{1,12})/i):null))?.[1];
    if(!bvid&&!aid&&/^https?:\/\//.test(source))return this.directVideo(source,scope);
    if(!bvid&&!aid)throw new Error('请提供 Bilibili BV 号、av 号或公开视频链接');
    const response=await this.json('https://api.bilibili.com/x/web-interface/view?'+(bvid?'bvid='+bvid:'aid='+aid));
    if(response.code!==0)throw new Error('视频信息不可用：'+(response.message||response.code));
    const v=response.data,url='https://www.bilibili.com/video/'+v.bvid;
    const result={title:v.title,url,description:String(v.desc||'').slice(0,2000),duration:v.duration,evidence:'已读取标题和简介，未获得视频画面',observations:'',captions:''};
    try{
      const player=await this.json('https://api.bilibili.com/x/player/v2?bvid='+v.bvid+'&cid='+v.cid);
      const subtitle=player.data?.subtitle?.subtitles?.[0]?.subtitle_url;
      if(subtitle){const link=new URL(subtitle.startsWith('//')?'https:'+subtitle:subtitle);if(/(^|\.)hdslb\.com$|(^|\.)bilibili\.com$/.test(link.hostname)){const data=await this.json(link.href);result.captions=(data.body||[]).slice(0,100).map(x=>x.content).join(' ').slice(0,5000);if(result.captions)result.evidence='已读取公开视频字幕';}}
    }catch{}
    const dir=path.join(this.runtime,'video-frames',crypto.randomUUID());await fs.mkdir(dir,{recursive:true});
    try{
      const play=await this.json('https://api.bilibili.com/x/player/playurl?bvid='+v.bvid+'&cid='+v.cid+'&qn=16&fnval=0&platform=html5');
      const media=play.data?.durl?.[0]?.url;
      if(play.code!==0||!media)throw new Error('没有可用的公开视频流');
      const address=new URL(media);if(address.protocol!=='https:'||!/(^|\.)bilivideo\.(com|cn)$/.test(address.hostname))throw new Error('不支持该视频来源');
      await runProcess('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-threads','2','-filter_threads','1','-rw_timeout','10000000','-tls_verify','1','-user_agent',bilibiliHeaders['User-Agent'],'-headers','Referer: '+url+'\r\n','-i',address.href,'-t','35','-vf','fps=1/12,scale=640:-2','-frames:v','3',path.join(dir,'frame-%02d.jpg')],'',{timeout:35000});
      const files=(await fs.readdir(dir)).filter(x=>/^frame-\d+\.jpg$/.test(x)).sort();
      if(files.length&&this.analyze){
        const images=await Promise.all(files.slice(0,3).map(x=>fs.readFile(path.join(dir,x))));
        result.observations=await this.analyze('视频标题：'+result.title+'\n公开简介：'+result.description+'\n可用字幕：'+result.captions+'\n这些是视频前约35秒的抽帧。只描述实际可见内容，不声称看完或听过声音。',images);
        result.evidence='已观察视频前约35秒的 '+images.length+' 张抽帧'+(result.captions?'，并读取字幕':'；未获取音轨');
      }
    }catch(error){result.observations=result.observations||'画面观察未完成：'+error.message;}
    finally{await fs.rm(dir,{recursive:true,force:true});}
    await this.record({title:result.title,url,evidence:result.evidence,summary:result.observations||result.description},scope);return result;
  }
  async execute(name,args,{scope='public'}={}){
    if(name==='get_time'){const timeZone=args.timezone||'Asia/Shanghai';return {timezone:timeZone,time:new Date().toLocaleString('zh-CN',{timeZone,hour12:false})};}
    if(name==='calculate')return {expression:args.expression,result:calculate(args.expression)};
    if(name==='get_weather')return this.weather(args.city);
    if(name==='browse_web')return this.browse(args.query,scope);
    if(name==='read_webpage')return this.readPage(args.url,scope);
    if(name==='browse_videos')return this.videos(args.query||'',scope);
    if(name==='inspect_video')return this.video(args.video,scope);
    if(name==='get_recent_activity')return {items:this.items.filter(x=>x.scope===scope||x.scope==='public-exploration').slice(0,4).map(({scope,...item})=>item)};
    throw new Error('未知公开内容工具');
  }
  start(){
    if(this.timer)return;
    const explore=async()=>{
      if(!this.options.explorationEnabled)return;
      const recent=this.items.find(x=>x.scope==='public-exploration');if(recent&&Date.now()-Date.parse(recent.at)<3600000)return;
      try{const rows=Math.random()<0.5?await this.videos('','public-exploration'):await this.browse(['游戏新闻','动物科普','生活趣闻'][Math.floor(Math.random()*3)],'public-exploration');if(rows[0])await this.record(rows[0]);}catch{}
    };
    this.timer=setInterval(explore,3600000);this.timer.unref();setTimeout(explore,60000).unref();
  }
}

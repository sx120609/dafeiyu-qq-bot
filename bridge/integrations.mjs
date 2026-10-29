import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);

export function rewriteBotAsset(text,type){
  if(type.includes('text/html'))return text.replace(/(src|href)="\/(?!\/)/g,'$1="/bot/')
    .replace(/临时凭证需同时填写[^。]*。/g,'OneBot 与模型凭证由本地控制台自动加载，无需再次填写。');
  if(type.includes('javascript'))return text.replaceAll('/api/','/bot/api/')
    .replace(/const controlToken = [^\n]+;/,'const controlToken = "integrated-console";')
    .replace("if(controlToken) sessionStorage.setItem('qq-control-token', controlToken);",'')
    .replace("history.replaceState(null, '', '/');","history.replaceState(null, '', '/bot/');");
  return text;
}

export class Integrations{
  constructor({runtime,auth,napcatBase='http://127.0.0.1:6099',napcatConfig=path.join(os.homedir(),'qq-runtime/config/webui.json')}){
    this.runtime=runtime;this.auth=auth;this.napcatBase=napcatBase;this.napcatConfig=napcatConfig;
    this.credential=null;this.expires=0;this.signingIn=null;
  }
  handles(url){return url.startsWith('/webui')||url.startsWith('/api/')||url.startsWith('/bot/')||url.startsWith('/console/integrations/');}
  authorized(req,origin){
    if(req.headers.origin&&req.headers.origin!==origin)return false;
    if(['cross-site','same-site'].includes(req.headers['sec-fetch-site']))return false;
    if(!this.auth.session(req))return false;
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==origin)return false;
    return true;
  }
  async napcatCredential(){
    if(this.credential&&Date.now()<this.expires)return this.credential;
    if(this.signingIn)return this.signingIn;
    this.signingIn=(async()=>{
      const {token}=JSON.parse(await fs.readFile(this.napcatConfig,'utf8'));
      const hash=crypto.createHash('sha256').update(token+'.napcat').digest('hex');
      const response=await fetch(this.napcatBase+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash}),signal:AbortSignal.timeout(10000),redirect:'error'});
      const result=await response.json();
      if(!response.ok||result.code!==0||!result.data?.Credential)throw new Error('NapCat 自动认证失败，请检查服务状态');
      this.credential=result.data.Credential;this.expires=Date.now()+30*60*1000;
      return this.credential;
    })();try{return await this.signingIn;}finally{this.signingIn=null;}
  }
  async botTarget(){
    const link=(await fs.readFile(path.join(this.runtime,'control-url.txt'),'utf8')).trim();
    const u=new URL(link);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||!/^[a-f0-9-]{72}$/i.test(u.hash.slice(1)))throw new Error('机器人管理地址尚未就绪');
    return {base:u.origin,token:u.hash.slice(1)};
  }
  async target(req,websocket=false){
    const bot=req.url.startsWith('/bot/');
    const settings=bot?await this.botTarget():{base:this.napcatBase};
    const url=new URL(bot?req.url.slice(4):req.url,settings.base);
    if(url.origin!==settings.base)throw new Error('Invalid local target');
    const headers={};for(const [k,v]of Object.entries(req.headers))if(!hop.has(k)&&!['cookie','authorization','x-qq-control','host','origin','referer','accept-encoding'].includes(k))headers[k]=v;
    headers.host=url.host;headers.origin=url.origin;headers['accept-encoding']='identity';
    if(bot)headers['x-qq-control']=settings.token;
    else if(url.pathname.startsWith('/api/')){
      const credential=await this.napcatCredential();headers.authorization='Bearer '+credential;
      if(websocket){url.searchParams.set('token',credential);url.searchParams.set('webui_token',credential);}
    }
    return {url,headers,bot};
  }
  async handle(req,res,origin){
    const json=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(!this.authorized(req,origin)){
      // Opening one of these pages directly (for example through a tunnel) goes to the console's login first.
      if(req.method==='GET'&&String(req.headers.accept||'').includes('text/html')){res.writeHead(302,{Location:'/console/','Cache-Control':'no-store'});res.end();return;}
      json(401,{error:'请先登录控制台，再打开此管理页面。'});return;
    }
    if(req.url==='/console/integrations/napcat'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'",'X-Frame-Options':'SAMEORIGIN'});
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>正在连接 NapCat</title><body><p id="integration-auth-status">正在使用本机凭证连接 NapCat…</p><script src="/console/integration-auth.js"></script></body></html>');return;
    }
    if(req.url==='/console/integrations/napcat/credential'){
      try{json(200,{credential:await this.napcatCredential()});}catch(e){json(503,{error:e.message});}return;
    }
    if(req.url.startsWith('/console/integrations/')){json(404,{error:'Unknown integration'});return;}
    try{
      const {url,headers,bot}=await this.target(req);
      let length=0;const chunks=[];for await(const c of req){length+=c.length;if(length>64*1024*1024)throw new Error('上传内容过大');chunks.push(c);}
      const body=Buffer.concat(chunks);if(req.method!=='GET'&&req.method!=='HEAD')headers['content-length']=String(body.length);
      await new Promise((resolve)=>{
        const upstream=http.request(url,{method:req.method,headers,timeout:30000},response=>{
          const output={};for(const [k,v] of Object.entries(response.headers))if(!hop.has(k)&&!['content-length','x-frame-options','set-cookie','content-security-policy'].includes(k))output[k]=v;
          output['Cache-Control']='no-store';output['Referrer-Policy']='no-referrer';output['X-Frame-Options']='SAMEORIGIN';
          output['Content-Security-Policy']=(response.headers['content-security-policy']||'').replace(/frame-ancestors[^;]*(;|$)/g,'').trim()+"; frame-ancestors 'self'";
          if(output.location){if(output.location.startsWith(url.origin))output.location=output.location.slice(url.origin.length);if(bot&&output.location.startsWith('/'))output.location='/bot'+output.location;}
          const type=response.headers['content-type']||'';
          const rewrite=type.includes('text/html')||(bot&&type.includes('javascript'));
          if(rewrite){const data=[];let size=0;response.on('data',b=>{size+=b.length;if(size>8*1024*1024)response.destroy();else data.push(b);});response.on('end',()=>{if(!res.destroyed){
            let content=Buffer.concat(data).toString('utf8');if(bot)content=rewriteBotAsset(content,type);
            if(type.includes('text/html'))content+='<link rel="stylesheet" href="/console/page-nav.css"><script src="/console/page-nav.js" defer></script>';
            // NapCat follows the system light/dark setting; its theme has to be set before its own scripts run.
            if(!bot&&type.includes('text/html'))content=content.replace(/<head[^>]*>/i,m=>m+'<script src="/console/napcat-theme.js"></script>');
            res.writeHead(response.statusCode||502,output);res.end(content);
          }resolve();});}
          else{res.writeHead(response.statusCode||502,output);response.pipe(res);response.on('end',resolve);}
          response.on('error',()=>{if(!res.headersSent)json(502,{error:'管理服务连接中断'});else res.destroy();resolve();});
        });
        upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)json(503,{error:'管理服务暂不可用，请稍后点击重新连接'});else res.destroy();resolve();});
        res.on('close',()=>upstream.destroy());upstream.end(body);
      });
    }catch(e){if(!res.headersSent)json(503,{error:e.message});else res.destroy();}
  }
  async upgrade(req,socket,head,origin){
    if(!req.url.startsWith('/api/')||req.headers.host!==new URL(origin).host||req.headers.origin!==origin||!this.authorized(req,origin)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    try{
      const {url,headers}=await this.target(req,true);headers.connection='Upgrade';headers.upgrade='websocket';
      const upstream=http.request(url,{headers,timeout:10000});
      upstream.on('upgrade',(response,peer,peerHead)=>{
        peer.setTimeout(0);socket.setTimeout(0);
        let output=`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
        for(let i=0;i<response.rawHeaders.length;i+=2)output+=response.rawHeaders[i]+': '+response.rawHeaders[i+1]+'\r\n';
        socket.write(output+'\r\n');if(peerHead.length)socket.write(peerHead);if(head.length)peer.write(head);
        peer.pipe(socket);socket.pipe(peer);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());
      });
      upstream.on('response',()=>socket.destroy());upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());upstream.end();
    }catch{socket.destroy();}
  }
}

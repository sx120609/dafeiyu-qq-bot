// SnowLuma's own pages inside the console's「QQ 登录」(11-03: "我希望把控制台也做嵌入处理"). SnowLuma's WebUI
// is a single-page app rooted at "/" that forbids framing, so it gets its own loopback port: this listener
// passes everything to 127.0.0.1:5099, lets only the console frame it, and signs every request in with the
// bot's own SnowLuma session. Only someone signed in to the console gets through: its session cookie is
// host-wide (ports do not separate cookies), so the console's login covers this port too.
// SnowLuma's login never shows here (11-03: "我纯本地的你限制安全是故意卡我吗"): its login and logout calls are
// answered by the proxy, an expired session is renewed and the request repeated, so nobody types a password and
// nothing can trip SnowLuma's five-attempt lockout.
import http from 'node:http';

const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);

export function startSnowLumaProxy({auth,luma,port=18192,consoleOrigin='http://127.0.0.1:18191'}){
  const origin=`http://127.0.0.1:${port}`;
  const target=()=>new URL(luma().webui);
  const allowed=req=>!!auth.session(req)&&(!req.headers.origin||[origin,consoleOrigin].includes(req.headers.origin));
  const headersFor=async(req,fresh=false)=>{
    const upstream=target(),headers={};
    for(const [k,v] of Object.entries(req.headers))if(!hop.has(k)&&!['cookie','host','origin','referer','authorization','x-snowluma-token','accept-encoding'].includes(k))headers[k]=v;
    headers.host=upstream.host;headers['accept-encoding']='identity';
    if(req.headers.origin)headers.origin=upstream.origin;
    if(fresh)luma().session=null;
    headers['x-snowluma-token']=await luma().sessionToken();
    return headers;
  };
  const forward=(req,headers,body)=>new Promise((resolve,reject)=>{
    const upstream=http.request(new URL(req.url,target()),{method:req.method,headers:{...headers,...(body.length?{'content-length':String(body.length)}:{})}},resolve);
    upstream.on('error',reject);upstream.end(body);
  });
  const server=http.createServer(async(req,res)=>{
    const fail=(status,text)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(text);}else res.destroy();};
    const json=(value)=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(!allowed(req))return fail(401,'请先登录大肥鱼控制台，再从「QQ 登录」页打开。');
    const pathname=new URL(req.url,origin).pathname;
    try{
      // The page's own sign-in and sign-out: answered here with the bot's session.
      if(req.method==='POST'&&pathname==='/api/login'){for await(const _ of req){}return json({success:true,token:await luma().sessionToken()});}
      if(req.method==='POST'&&pathname==='/api/logout'){for await(const _ of req){}return json({success:true});}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=Buffer.concat(chunks);
      let headers=await headersFor(req),response=await forward(req,headers,body);
      // SnowLuma restarted (its sessions live in memory): sign in again and repeat the request once.
      if(response.statusCode===401&&pathname.startsWith('/api/')){response.resume();headers=await headersFor(req,true);response=await forward(req,headers,body);}
      const output={};
      for(const [k,v] of Object.entries(response.headers))if(!hop.has(k)&&!['content-length','x-frame-options','content-security-policy'].includes(k))output[k]=v;
      output['Content-Security-Policy']=`frame-ancestors ${consoleOrigin} ${origin}; base-uri 'self'; object-src 'none'`;
      output['Cache-Control']='no-store';
      const type=String(response.headers['content-type']||'');
      if(!type.includes('text/html')){res.writeHead(response.statusCode||502,output);response.pipe(res);res.on('close',()=>response.destroy());return;}
      // The page keeps its session in localStorage; it starts with the bot's, so it opens signed in.
      const html=[];for await(const chunk of response)html.push(chunk);
      const token=JSON.stringify(headers['x-snowluma-token']).replace(/</g,'\\u003c');
      const page=Buffer.concat(html).toString('utf8').replace(/<head[^>]*>/i,m=>m+`<script>try{localStorage.setItem('snowluma_token',${token})}catch(e){}</script>`);
      res.writeHead(response.statusCode||502,output);res.end(page);
    }catch(error){fail(503,'SnowLuma 暂时连不上：'+error.message);}
  });
  // Live views (state and log streams) may use WebSockets.
  server.on('upgrade',async(req,socket,head)=>{
    if(!allowed(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    try{
      const headers=await headersFor(req);headers.connection='Upgrade';headers.upgrade='websocket';
      const upstream=http.request(new URL(req.url,target()),{headers});
      upstream.on('upgrade',(response,peer,peerHead)=>{
        let output=`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
        for(let i=0;i<response.rawHeaders.length;i+=2)output+=response.rawHeaders[i]+': '+response.rawHeaders[i+1]+'\r\n';
        socket.write(output+'\r\n');if(peerHead.length)socket.write(peerHead);if(head.length)peer.write(head);
        peer.pipe(socket);socket.pipe(peer);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());
      });
      upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.end();
    }catch{socket.destroy();}
  });
  server.listen(port,'127.0.0.1');
  return server;
}

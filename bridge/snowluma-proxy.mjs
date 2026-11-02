// SnowLuma's own pages inside the console's「QQ 登录」(11-03: "我希望把控制台也做嵌入处理"). SnowLuma's WebUI
// is a single-page app rooted at "/" that forbids framing, so it gets its own loopback port: this listener
// passes everything to 127.0.0.1:5099, lets only the console frame it, and signs every request in with the
// bot's own SnowLuma session. Only someone signed in to the console gets through: its session cookie is
// host-wide (ports do not separate cookies), so the console's login covers this port too.
import http from 'node:http';

const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);

export function startSnowLumaProxy({auth,luma,port=18192,consoleOrigin='http://127.0.0.1:18191'}){
  const origin=`http://127.0.0.1:${port}`;
  const target=()=>new URL(luma().webui);
  const allowed=req=>!!auth.session(req)&&(!req.headers.origin||[origin,consoleOrigin].includes(req.headers.origin));
  const headersFor=async req=>{
    const upstream=target(),headers={};
    for(const [k,v] of Object.entries(req.headers))if(!hop.has(k)&&!['cookie','host','origin','referer','authorization','x-snowluma-token','accept-encoding'].includes(k))headers[k]=v;
    headers.host=upstream.host;headers['accept-encoding']='identity';
    if(req.headers.origin)headers.origin=upstream.origin;
    headers['x-snowluma-token']=await luma().sessionToken();
    return headers;
  };
  const server=http.createServer(async(req,res)=>{
    const fail=(status,text)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(text);}else res.destroy();};
    if(!allowed(req))return fail(401,'请先登录大肥鱼控制台，再从「QQ 登录」页打开。');
    let headers;
    try{headers=await headersFor(req);}catch(error){return fail(503,'SnowLuma 暂时连不上：'+error.message);}
    const upstream=http.request(new URL(req.url,target()),{method:req.method,headers},response=>{
      // SnowLuma restarted (sessions are in memory): sign in again on the next request.
      if(response.statusCode===401)luma().session=null;
      const output={};
      for(const [k,v] of Object.entries(response.headers))if(!hop.has(k)&&!['content-length','x-frame-options','content-security-policy'].includes(k))output[k]=v;
      output['Content-Security-Policy']=`frame-ancestors ${consoleOrigin} ${origin}; base-uri 'self'; object-src 'none'`;
      output['Cache-Control']='no-store';
      const type=String(response.headers['content-type']||'');
      if(!type.includes('text/html')){res.writeHead(response.statusCode||502,output);response.pipe(res);return;}
      // The page keeps its session in localStorage; it starts with the bot's, so it opens signed in.
      const chunks=[];response.on('data',c=>chunks.push(c));
      response.on('end',async()=>{
        let html=Buffer.concat(chunks).toString('utf8');
        const token=JSON.stringify(headers['x-snowluma-token']).replace(/</g,'\\u003c');
        html=html.replace(/<head[^>]*>/i,m=>m+`<script>try{localStorage.setItem('snowluma_token',${token})}catch(e){}</script>`);
        res.writeHead(response.statusCode||502,output);res.end(html);
      });
    });
    upstream.on('error',()=>fail(502,'SnowLuma 没有响应'));
    res.on('close',()=>upstream.destroy());
    req.pipe(upstream);
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

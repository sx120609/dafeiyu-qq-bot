import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {watchBilibiliLive,captureLiveFrame} from '../bridge/bilibili-live.mjs';
import {PublicContent} from '../bridge/public-content.mjs';

const room={room_id:123,live_status:1,title:'测试直播',parent_area_name:'游戏',area_name:'测试',online:900};
function fixture(overrides={}) {
  const calls=[];
  return {calls,json:async url=>{
    calls.push(url);
    const key=url.includes('/search/')?'search':url.includes('get_info')?'room':url.includes('gethistory')?'chat':url.includes('playUrl')?'play':'anchor';
    const data={room,search:{result:[]},chat:{room:[{text:'好看',timeline:'2026-11-01 12:00:00'},{text:'好看',timeline:'2026-11-01 12:00:01'}]},play:{durl:[{url:'https://test.bilivideo.com/live.flv'}]},anchor:{info:{uname:'测试主播'}},...overrides}[key];
    if(data instanceof Error)throw data;
    return {code:0,data};
  },capture:async()=>({status:'captured',frameCount:1})};
}
test('short room id resolves; metadata, popularity and bounded history are explicit',async()=>{
  const f=fixture(),r=await watchBilibiliLive('6',f);
  assert.equal(r.roomID,'123');assert.equal(r.anchor,'测试主播');assert.equal(r.isLive,true);assert.equal(r.popularity,900);
  assert.match(r.popularityMeaning,/不是准确在线人数/);assert.equal(r.frame.frameCount,1);assert.match(r.danmaku.summary,/2条/);
  assert.ok(f.calls.some(x=>x.endsWith('roomid=123')));
});
test('offline and replay never fetch stale chat or frames',async()=>{
  for(const status of [0,2]){const f=fixture({room:{...room,live_status:status}}),r=await watchBilibiliLive('123',f);
    assert.equal(r.isLive,false);assert.equal(r.frame.status,'skipped');assert.equal(f.calls.length,2);}
});
test('exact anchor resolves; ambiguous and missing names return candidates without choosing',async()=>{
  const f=fixture({search:{result:[{roomid:123,uname:'<em>测试主播</em>'}]}});
  assert.equal((await watchBilibiliLive('测试主播',f)).roomID,'123');
  const a=fixture({search:{result:[{roomid:123,uname:'其他主播'},{roomid:456,uname:'其他主播2'}]}});
  assert.equal((await watchBilibiliLive('主播',a)).status,'ambiguous');assert.equal(a.calls.length,1);
  assert.equal((await watchBilibiliLive('不存在',fixture())).status,'not_found');
});
test('optional failures preserve metadata; invalid stream never reaches capture',async()=>{
  const f=fixture({chat:new Error('HTTP 403'),play:{durl:[{url:'https://127.0.0.1/live.flv'}]}});
  f.capture=()=>assert.fail('invalid media must not be fetched');
  const r=await watchBilibiliLive('123',f);assert.equal(r.title,room.title);assert.equal(r.frame.status,'unavailable');assert.equal(r.danmaku.status,'unavailable');
  const empty=await watchBilibiliLive('123',fixture({chat:{room:[]}}));assert.match(empty.danmaku.summary,/不代表/);
});
test('validation and API failures do not masquerade as offline',async()=>{
  for(const query of ['',null,'0','https://live.bilibili.com/6','a'.repeat(81)])await assert.rejects(()=>watchBilibiliLive(query,fixture()));
  await assert.rejects(()=>watchBilibiliLive('123',{json:async()=>({code:-412})}),/未绕过/);
});
test('history is bounded; public dispatcher reaches live reader',async()=>{
  const p=new PublicContent({});p.json=fixture({room:{...room,live_status:0}}).json;
  assert.equal((await p.execute('watch_bilibili_live',{query:'123'})).status,'未开播');
  const r=await watchBilibiliLive('123',fixture({chat:{room:Array.from({length:100},()=>({text:'x'.repeat(1000)}))}}));
  assert.equal(r.danmaku.count,20);assert.equal(r.danmaku.messages[0].text.length,160);
});
test('malformed search is not reported as missing; malformed rows are ignored',async()=>{
  await assert.rejects(()=>watchBilibiliLive('主播',fixture({search:{}})),/接口格式无效/);
  const f=fixture({search:{result:[null,{roomid:123,uname:'主播'}]},chat:{room:[null,{text:{}},{text:'有效弹幕'}]}});
  const r=await watchBilibiliLive('主播',f);
  assert.equal(r.roomID,'123');assert.equal(r.danmaku.count,1);assert.equal(r.danmaku.summary,'有效弹幕');
});
test('capture uses local-only ffmpeg input and removes files on success and failure',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'bili-live-'));
  try{
    const deps={runtime,fetch:async(_url,opts)=>{assert.equal(opts.prefix,true);assert.equal(opts.limit,4_000_000);return {body:Buffer.from('FLVfixture')};},run:async(_exe,args)=>{
      assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file,pipe');assert.ok(!args.some(x=>x.startsWith('https:')));
      await fs.writeFile(args.at(-1),Buffer.from('fixture-image'));
    }};
    const r=await captureLiveFrame('https://test.bilivideo.com/live.flv','https://live.bilibili.com/123',deps);
    assert.equal(r.status,'captured');assert.deepEqual(await fs.readdir(path.join(runtime,'live-frames')),[]);
    await assert.rejects(()=>captureLiveFrame('unused','unused',{...deps,run:async()=>{throw new Error('ffmpeg unavailable');}}));
    assert.deepEqual(await fs.readdir(path.join(runtime,'live-frames')),[]);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});

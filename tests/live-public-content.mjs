import fs from 'node:fs/promises';
import path from 'node:path';
import {PublicContent} from '../bridge/public-content.mjs';
const runtime=path.resolve(import.meta.dirname,'../.runtime/public-probe');await fs.mkdir(runtime,{recursive:true});
const content=await new PublicContent({runtime}).load();
const results=[];
for(const [name,args] of [['get_weather',{city:'Singapore'}],['browse_web',{query:'有趣的动物 科普'}],['browse_videos',{}]]){
  try{const value=await content.execute(name,args,{scope:'probe'});const summary=Array.isArray(value)?{items:value.length,firstTitle:value[0]?.title,bvid:value[0]?.bvid}:{city:value.city,current:value.current};results.push({name,ok:true,...summary});}
  catch(error){results.push({name,ok:false,error:error.message});}
  console.log(JSON.stringify(results.at(-1)));
}
const first=results.find(x=>x.bvid);
if(first){try{const value=await content.video(first.bvid,'probe');results.push({name:'inspect_video',ok:true,title:value.title,evidence:value.evidence,observationStatus:value.observations.slice(0,150)});}catch(error){results.push({name:'inspect_video',ok:false,error:error.message});}console.log(JSON.stringify(results.at(-1)));}
await fs.writeFile(path.join(runtime,'results.json'),JSON.stringify(results,null,2));

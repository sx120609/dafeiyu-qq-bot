import {createHash} from 'node:crypto';

// 2026-11-25: "Find the root cause and fix it in the code"; persisted tools also need the
// SnowLuma cursor fix. Match only the known broken block so later tool edits remain authoritative.
export function repairToolHistory(name,code){
  if(name!=='my_read_group_context')return code;
  const normalized=code.replace(/\r\n/g,'\n');
  const start=normalized.indexOf('  let anchor = null;\n');
  const end=normalized.indexOf('  const jobs = [',start);
  if(start<0||end<0)return code;
  const hash=createHash('sha256').update(normalized.slice(start,end)).digest('hex');
  if(hash!=='77af58b3193980bab9b49b60d2f5d59ab07e687b386e033bbd8e62c4fb45941f')return code;
  return normalized.slice(0,start)+`  const readHistory = () => (${readGroupHistory.toString()})(qq, gid, beforeId, count);\n`+normalized.slice(end);
}

// 2026-11-25: "Do not change the live bot's .runtime/ data"; send this self-contained
// implementation into the existing sandbox without rewriting the stored tool or its metadata.
async function readGroupHistory(qq,groupId,before,count){
  const id=value=>value==null||!String(value).trim()?'':BigInt(String(value)).toString();
  const messageId=row=>id(row?.message_id??row?.msg_id);
  const belongs=row=>row&&typeof row==='object'&&!Array.isArray(row)&&row.message_type!=='private'&&
    (row.group_id==null||id(row.group_id)===id(groupId));
  let cursor=id(before),messages=[],error=null,note='';
  const seen=new Set(),visited=new Set();
  try{
    if(cursor){
      const anchor=await qq('get_msg',{message_id:cursor});
      if(!belongs(anchor)||(messageId(anchor)&&messageId(anchor)!==cursor))throw new Error('before 消息不可读取或不属于目标群');
    }
    while(messages.length<count){
      if(visited.has(cursor)){
        note='接口重复返回分页边界，未能继续向前读取；不代表没有更早记录。';break;
      }
      visited.add(cursor);
      // SnowLuma includes the anchor and orders rows oldest first; IDs are opaque, signed values.
      const params={group_id:groupId,count:count-messages.length+(cursor?1:0),reverse_order:true};
      if(cursor)params.message_id=cursor;
      const raw=await qq('get_group_msg_history',params);
      let rows=Array.isArray(raw)?raw:raw?.messages??raw?.message_list??raw?.list;
      if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('QQ 返回的记录格式不正确');
      rows=rows.filter(belongs);
      if(!rows.length){note='接口未返回更早记录；可能已到可读取历史边界。';break;}
      if(cursor){
        const boundary=rows.findIndex(row=>messageId(row)===cursor);
        if(boundary<0){note='接口未返回请求的分页锚点，无法确认更早记录。';break;}
        rows=rows.slice(0,boundary);
      }
      const added=rows.filter(row=>{
        const key=messageId(row)||JSON.stringify(row);
        if(seen.has(key))return false;
        seen.add(key);return true;
      });
      if(!added.length){note='接口重复返回分页边界，未能继续向前读取；不代表没有更早记录。';break;}
      // Preserve server order even when timestamps tie; compatibility sequences may be message hashes.
      messages=[...added,...messages];
      if(messages.length>=count)break;
      cursor=messageId(rows[0]);
      if(!cursor){note='最早记录缺少消息编号，无法继续向前翻页；已保留获取的记录。';break;}
    }
  }catch(caught){error=caught;}
  return {messages:messages.slice(-count),error,note};
}

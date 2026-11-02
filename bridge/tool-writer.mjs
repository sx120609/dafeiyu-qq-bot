// Writes the code of a my_ tool for the agent (11-03: "这个写工具的部分可以外包给codex的Astra去做，但是你还是要检验").
// The local Codex with the Astra model gets the requirement, the tool API and, on a retry, the code that failed
// and its error; it may search the web for the API it needs. agent-tools.mjs runs every draft with the test
// arguments and keeps it only when it works.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const win=p=>process.platform==='win32'?p:execFileSync('wslpath',['-w',p],{encoding:'utf8'}).trim();
export const writerModel='gpt-6-astra';

export const toolAPI=`The tool is the body of an async JavaScript function (Node 26), called as (args, tools):
- args: the call's arguments, an object matching the tool's JSON Schema.
- fetch(url, {method, headers, body, responseType}) reaches any http(s) address, intranet and localhost included. The
  response has ok, status, statusText, url, headers.get(name), text(), json(), and base64() when responseType is 'base64'
  (for binary bodies such as images or files). Up to 500 requests a run, 20 MB each, redirects followed.
- tools.store: the tool's own storage that lasts between runs (use it to cache, remember and learn):
  await tools.store.get(key), await tools.store.set(key, value) (JSON-serialisable), await tools.store.delete(key),
  await tools.store.keys(), await tools.store.all().
- await tools.qq(action, params): OneBot v11 (NapCat-compatible) actions on the bot's QQ account, returning the action's
  data. Sending works (send_group_msg {group_id,message}, send_private_msg {user_id,message}, upload_group_file
  {group_id,file,name}, send_like, group_poke, send_qzone_msg…); kicking, muting, leaving, deleting friends or files,
  changing the bot's profile and reading login credentials are refused. Useful reads: get_group_member_list {group_id}, get_group_member_info {group_id,user_id}, get_group_info {group_id},
  get_group_honor_info {group_id,type:'all'}, get_group_root_files {group_id}, get_group_files_by_folder {group_id,folder_id},
  get_group_file_url {group_id,file_id,busid}, get_group_msg_history {group_id,count}, get_friend_msg_history {user_id,count},
  get_msg {message_id}, get_forward_msg {message_id}, get_stranger_info {user_id}, get_friend_list, get_group_list,
  get_essence_msg_list {group_id}, _get_group_notice {group_id}, get_qzone_feeds, and other get_* actions.
- tools.log(...) / console.log(...) write to the tool's log.
- No file system, no child processes, no require/import of local modules. Must finish within 300 seconds.
- Return a string, or an object (it is shown as JSON). Keep the result readable for a chat model: the key facts, not raw dumps.`;

const schema={type:'object',additionalProperties:false,required:['description','parameters_json','code'],properties:{
  description:{type:'string',description:'What the tool does, when to use it, what it returns (Chinese, under 400 characters).'},
  parameters_json:{type:'string',description:'The JSON Schema of the arguments as JSON text: {"type":"object","properties":{...},"required":[...]}; each property has type and description.'},
  code:{type:'string',description:'The async function body.'}}};

/** One draft: {description, parameters, code}. `previous` is {code, error, logs} when the last draft failed its test. */
export async function writeToolCode({name,requirement,description,parameters,testArguments,previous,existing},config,{launch=spawn,signal}={}){
  const dir=await fs.mkdtemp(path.join(config.tempRoot,'tool-writer-'));
  const schemaFile=path.join(dir,'schema.json');
  await fs.writeFile(schemaFile,JSON.stringify(schema));
  const prompt=[
    `Write the tool "${name}" for a QQ group chat bot. Reply only with the JSON the output schema asks for.`,
    'Requirement (from the bot, in Chinese):',requirement,
    description?'Suggested description: '+description:'',
    parameters?'Suggested parameters schema: '+JSON.stringify(parameters):'',
    'Test arguments it will be run with right away (it must work with them): '+JSON.stringify(testArguments??{}),
    existing?'The current version of this tool, to improve:\n'+existing:'',
    previous?`The last draft failed its test run.\nCode:\n${previous.code}\nError:\n${previous.error}\nLog:\n${(previous.logs||[]).join('\n')}`:'',
    toolAPI,
    'Find a working data source (search the web if you need an API, prefer ones without keys), handle errors with clear Chinese messages, and make the result useful to the bot.'
  ].filter(Boolean).join('\n\n');
  const args=['--search','exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only',
    '--model',writerModel,'-c','model_reasoning_effort="high"','-c','features.shell_tool=false','-c','features.apply_patch_freeform=false',
    '-c','features.apps=false','-c','features.multi_agent=false','-c','features.image_generation=false','-c','project_doc_max_bytes=0',
    '--cd',win(config.tempRoot),'--output-schema',win(schemaFile),'--json','-'];
  try{
    const text=await new Promise((resolve,reject)=>{
      const child=launch(config.codex,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:win(config.tempRoot),TMP:win(config.tempRoot)}});
      let buffer='',last='',failure='',stderr='';
      const abort=()=>{child.kill();reject(new Error('写工具取消了'));};
      if(signal?.aborted)return abort();
      signal?.addEventListener('abort',abort,{once:true});
      child.on('error',()=>reject(new Error('Codex 没能启动')));
      child.stdin.on('error',()=>{});
      child.stdout.on('data',data=>{
        buffer+=data;const lines=buffer.split('\n');buffer=lines.pop();
        for(const line of lines){let event;try{event=JSON.parse(line);}catch{continue;}
          if(event.type==='item.completed'&&event.item?.type==='agent_message')last=event.item.text;
          if(event.type==='turn.failed'||event.type==='error')failure=String(event.error?.message||event.message||'写代码失败').slice(0,300);}
      });
      child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
      child.on('close',code=>{signal?.removeEventListener('abort',abort);(code===0&&last&&!failure)?resolve(last):reject(new Error('写代码的模型没交出结果：'+(failure||stderr.trim().split('\n').pop()||'退出码 '+code)));});
      child.stdin.end(prompt);
    });
    const draft=JSON.parse(text);
    let parametersParsed;try{parametersParsed=JSON.parse(draft.parameters_json);}catch{throw new Error('写代码的模型给的参数定义不是合法 JSON');}
    return {description:String(draft.description||description||''),parameters:parametersParsed,code:String(draft.code||'')};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}

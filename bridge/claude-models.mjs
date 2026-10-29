// Runs on Windows using the official Anthropic SDK and the installed official CLI.
import {query} from '@anthropic-ai/claude-agent-sdk';
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),30000);
async function* input(){await new Promise(r=>controller.signal.addEventListener('abort',r,{once:true}));}
const q=query({prompt:input(),options:{pathToClaudeCodeExecutable:process.argv[2],cwd:process.argv[3],
  tools:[],settingSources:[],strictMcpConfig:true,mcpServers:{},persistSession:false,
  extraArgs:{'safe-mode':null,'no-chrome':null},abortController:controller}});
try{console.log(JSON.stringify(await q.supportedModels()));}
finally{clearTimeout(timeout);controller.abort();q.close();}

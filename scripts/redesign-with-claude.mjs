import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const work=path.join(root,'.runtime','claude-ui');
await fs.mkdir(work,{recursive:true});
for(const file of ['index.html','style.css','app.js'])await fs.copyFile(path.join(root,'console',file),path.join(work,file));
const prompt=`用户明确要求：控制台功能完成后，让官方 Claude 把界面重写一遍，因为原界面太丑。请你亲自重新设计并改写 index.html 和 style.css。不是提建议：必须使用 Write/Edit 工具完成两份文件。

这是一个已可用的中文本地 QQ 机器人模型控制台。功能有三种连接：本机 Codex（ChatGPT 登录）、云端 API（OpenAI 兼容 / Anthropic）、本机官方 Claude Code。右侧是从官方客户端 / 服务商动态读取的模型目录，支持搜索和选择；中间保存、测试连接、启用，顶部是当前实际生效的连接和 QQ 状态。保持这些功能真实清楚。

请先读 app.js 理解 DOM 合同。不得修改 app.js。保留所有现有 id，保留 data-provider=codex/cloud/claude，button type 和 form。可以完全重写 HTML 布局和 CSS 类名，但 app.js 依赖的 .model-card .success .error .empty [hidden] 状态必须有样式。模型卡片由 JS 动态生成 strong、code、p、small，你应为它们设计精致的列表。CSP 仅允许本站资源，不要外链字体、脚本、图片、不要内联样式/脚本/事件。可以使用行内 SVG 做小图标，不使用 emoji 图标。不添加假数据、假统计、假状态或不能工作的控件。

设计目标：精致、成熟、克制、有识别度的产品控制台。用大肥鱼 / 深海作为轻微视觉线索，不要幼稚卡通，也不要常见的紫色 AI 渐变大卡片。桌面上有清楚的主次、舒服的密度和高质量的排版；手机 375px 也能完整操作。你独立决定设计，不必沿用当前布局，可以采用侧栏导航式结构或其他适合配置页的布局。中文字体用系统字体。所有交互目标至少 44px，高对比，清楚的键盘焦点，尊重 reduced-motion。需要区分正在编辑、当前生效、已识别和已实测，少用没必要的内部技术术语。

只处理当前目录中的这三份文件（app.js只读）。不读任何其他目录，不用网络或 shell。完成后简要描述设计变化。`;
await fs.writeFile(path.join(work,'REQUEST.txt'),prompt);
const exe=path.join(process.env.APPDATA,'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const env={...process.env,TEMP:work,TMP:work};for(const key of Object.keys(env))if(key.startsWith('ANTHROPIC_')||key.startsWith('CLAUDE_CODE_USE_')||key==='CLAUDE_CODE_OAUTH_TOKEN')delete env[key];
const args=['-p','--safe-mode','--restricted','--tools','Read,Edit,Write','--allowedTools','Read,Edit,Write','--permission-mode','acceptEdits','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--no-chrome','--no-session-persistence','--model','opus','--effort','high','--output-format','json'];
const child=spawn(exe,args,{cwd:work,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);child.stdin.end(prompt);
const timer=setTimeout(()=>child.kill(),600000);
child.on('close',async code=>{clearTimeout(timer);await fs.writeFile(path.join(work,'result.json'),output);await fs.writeFile(path.join(work,'stderr.log'),errors);
  if(code!==0){console.error('Official Claude rewrite exited '+code);process.exitCode=1;return;}
  const result=JSON.parse(output);if(result.is_error){console.error('Official Claude rewrite failed');process.exitCode=1;return;}
  console.log(JSON.stringify({ok:true,model:Object.keys(result.modelUsage||{}),result:result.result,files:await fs.readdir(work)}));
});

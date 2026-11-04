# 大肥鱼 QQ 机器人 · AI 接手手册

给接手这个项目的 AI（Codex、Claude Code 等）看的：它是什么、怎么从零部署、日常怎么改和发布、哪些规矩不能破。README 是功能和历史的说明，这份是操作手册。两者冲突时以代码为准，再更新文档。

## 1. 它是什么

一个跑在 Windows 上的 QQ 群聊机器人“大肥鱼”（DeepSeek 的鲸鱼娘同人角色）。它用一个独立的 QQ 号在群和私聊里聊天，每一轮由大模型像人一样操作 QQ：看消息、决定说不说、调用工具（发消息、发表情包、贴表情、画图、查资料、看 B 站、读文件、听语音……），每个动作的结果立刻回给模型，再决定下一步（代理模式）。

整机只有这几样进程，全部在 Windows 上，不用 WSL、不用 Docker：

```
机器人的 QQ 窗口（官方 QQNT，单独登录机器人号）
   ▲ 钩子
SnowLuma（D:\Dev\Projects\SnowLuma，node.exe index.mjs）
   OneBot v11：WebSocket 127.0.0.1:3001、HTTP 127.0.0.1:3000；管理页 127.0.0.1:5099
   ▲ OneBot WebSocket
引擎（node engine/main.mjs）——收消息、跑代理循环、发消息、记忆、存状态
   控制接口：127.0.0.1 随机端口，地址写在 .runtime/control-url.txt
   ▲ HTTP /v1/chat/completions 等
网关（node bridge/main.mjs，127.0.0.1:18191）
   模型接口 /v1/*（转给本机 Codex、本机 Claude Code 或云端 API）
   控制台 /console/（网页，密码登录）；/bot/ 代理引擎的原面板
   127.0.0.1:18192：SnowLuma 管理页的嵌入代理
   兼管 SnowLuma 和引擎的启停（bridge/qq-host.mjs）
托盘程序 Dafeiyu.exe——隐藏启动网关，托盘菜单，开机自启
```

主人自己的 QQ 也在这台电脑上运行。SnowLuma 的自动挂载必须关闭，网关只给“登录着机器人号”的那个 QQ.exe 挂钩子。任何改动都不能碰主人自己的 QQ。

## 2. 目录

| 路径 | 内容 |
|---|---|
| `bridge/` | 网关。`main.mjs` 入口；`gateway.mjs` 路由；`providers.mjs` 模型提供方和合规提示；`server.mjs` 本机 Codex 调用和回复格式；`qq-host.mjs` 管 SnowLuma 和引擎；`snowluma-proxy.mjs` 嵌入代理；`agent-tools.mjs`、`tool-sandbox.mjs`、`tool-writer.mjs` 机器人自写工具；`public-content.mjs`、`bilibili-live.mjs` 联网和 B 站；`voice.mjs` 语音；`computer.mjs` 超级模式；`usage.mjs` 用量；`runtime-control.mjs` 控制台的运行操作 |
| `engine/` | 引擎，由原作者的 Swift 引擎逐文件改写成 Node。`main.mjs` 入口；`QQEngine.mjs` 核心（收发、存盘、提醒、插画、记忆整理）；`QQEngine.agent.mjs` 代理循环和全部工具的执行；`QQAgent.mjs` 工具定义和指挥模型调用；`QQControlServer.mjs` 控制接口；`OneBotConnection.mjs` QQ 连接；`core/` 纯逻辑（策略、人设、记忆、权限档、消息解析）；`swift.mjs`、`foundation.mjs`、`core/_support.mjs` 改写用的公共函数 |
| `console/` | 控制台网页（`index.html`、`app.js`、`style.css`），网关直接读文件，改完刷新就生效 |
| `launcher/` | 托盘程序源码 `Launcher.cs`，`build.ps1` 用 Windows 自带的 C# 编译器编成根目录的 `Dafeiyu.exe` |
| `personas/dafeiyu.txt` | 大肥鱼的人设，`scripts/apply-persona.mjs` 推到运行中的引擎 |
| `scripts/` | `setup-windows.mjs` 初始化配置；`Start.ps1`/`Stop.ps1`/`Status.ps1` 不经托盘启停查看；`apply-persona.mjs`；`test.mjs` 跑全部测试；带 `wsl`/`.sh`/`supervisor.py` 的是旧的 WSL 部署，只用于回滚 |
| `tests/` | `node:test` 测试。`engine-*.test.mjs` 是引擎的（由 Swift 测试改写），`engine-fixtures.mjs` 是假的 OneBot 服务和脚本化模型 |
| `stickers/` | 公开的表情包素材 |
| `upstream/` | 原作者的 Swift 项目（git subtree）。不再运行，只作对照；`upstream/Resources` 里的 faces.json、表情、`Linux/image-helper.py`、原面板仍被引擎使用 |
| `.runtime/` | 运行数据，不进 git（见第 5 节） |

## 3. 从零部署（Windows 10/11）

需要主人亲自做的只有四件：装 QQ、扫码或密码登录机器人号、第一次在 SnowLuma 管理页同意协议、在控制台设密码。其余都可以由 AI 完成。

1. **装软件**
   - Node.js 24 或更新（`node -v`）。
   - Git。
   - Python 3 和 Pillow（`python -m pip install pillow`），图片处理用。
   - ffmpeg：下载 gyan.dev 的 `ffmpeg-release-essentials.zip`，核对 `.sha256`，解压到 `D:\Dev\Tools\ffmpeg`。
   - Poppler 的 `pdftotext`（读 PDF；Git for Windows 自带一个也能用）。
   - QQNT 官方 Windows 客户端。
   - 模型：本机 Codex CLI（`npm install` 会装到项目里，需在本机用 ChatGPT 账号登录一次 `codex login`），或本机 Claude Code，或云端 API Key（在控制台「模型」里填）。
2. **取代码**：`git clone https://github.com/sx120609/dafeiyu-qq-bot D:\Dev\Workspaces\bot-gpt-ds-codex-qq`，进目录 `npm install`。
3. **SnowLuma**：从 SnowLuma 的 GitHub Releases 下载 win-x64 包，核对哈希，解压到 `D:\Dev\Projects\SnowLuma`。
4. **生成配置**：`node scripts/setup-windows.mjs <机器人QQ号>`。它写：
   - `.runtime/bridge-windows.json`：网关设置和随机令牌；
   - `.runtime/snowluma.json`：SnowLuma 位置和机器人号；
   - SnowLuma 的 `config/onebot_<机器人QQ号>.json`：只给机器人号开 OneBot，只听 127.0.0.1，随机 access token；
   - `config/runtime.json`：`hookAutoLoad:false`。

   最后列出还缺什么。重复运行不会换掉已有的令牌和密码。
5. **托盘程序**：`powershell -File launcher\build.ps1` 生成 `Dafeiyu.exe`（托盘在运行时先 `Stop-Process -Name Dafeiyu`，文件被占用会编译失败）。
6. **第一次启动**：双击 `Dafeiyu.exe`，等托盘图标出现、浏览器打开控制台。
   - 网关会拉起 SnowLuma（隐藏窗口），并自己生成 SnowLuma 管理密码写进它的 `webui.json`，谁都不用记。
   - 主人在控制台设控制台密码。
   - 主人在控制台「QQ 登录」页的嵌入管理页里同意 SnowLuma 的协议。只有第一次需要；如果嵌入页显示要登录，等网关接管密码后刷新。
7. **登录机器人号**：主人在这台电脑上另开一个 QQ 窗口，登录机器人号；主人自己的 QQ 照常开着。网关在 5 秒内找到这个进程、挂钩子、核对账号、连上引擎。「QQ 登录」页显示“已连上”即成功。
8. **人设和默认设置**：`node scripts/apply-persona.mjs`。它会：
   - 推送 `personas/dafeiyu.txt`；
   - 回复长度上限设为 2000；
   - 关掉复读保护；
   - 两条消息间隔设为 1 秒，同一会话不设冷却。
9. **会话名单**：在控制台「会话」里勾选要说话的群和好友，「管理员」里填主人的 QQ 号，托盘或「设置」里开开机自启。

搬迁旧数据时，把旧机器的 `.runtime/engine/qq-state.json` 和 `.runtime/engine/QQStickers/` 拷进来即可：状态格式和 Swift 版完全相同，日期按“2001-01-01 起的秒数”存。

## 4. 日常操作

- **改了 `bridge/`、`engine/` 的代码：不用重启，热加载。** 网关监视这两个目录，文件改完 3 秒后自动换上新代码（`engine/HotReload.mjs`，网关里是 `Reloader`）：
  - 网关在同一个进程里载入新一代模块，新请求走新代码，正在处理的请求在旧代码上做完；设置、用量、工具、自我修复记录、常驻 Claude 会话是同一批对象，换上新代码继续用。
  - 引擎在两轮之间换（有会话在想时等它想完，最多等十分钟），QQ 连接、会话、记忆、代理记录都不动。
  - 新代码载入失败（语法错、少导出）就继续跑原来的，并当程序错误交给自我修复。控制台「工具 → 自我修复」显示两边各是第几版、什么时候换的，也有“热加载”按钮手动触发。
  - 换不了的只有这几个常驻文件：`bridge/main.mjs`、`qq-host.mjs`、`snowluma-proxy.mjs`、`auth.mjs`（改了要重启全部），`engine/main.mjs`、`engine/HotReload.mjs`（只重启引擎进程）。`bridge/claude-models.mjs`、`tool-sandbox.mjs` 每次单独起进程，本来就是新代码。
  - 每次热加载会多占一点内存（旧模块不能卸载），改了几十次之后找个群里安静的时候重启一次。
- **重启全部**（只有上面那几个常驻文件改了才需要）：
  1. `Stop-Process -Name Dafeiyu`
  2. `scripts\Stop.ps1`
  3. 改过 `launcher/Launcher.cs` 才需要 `launcher\build.ps1`
  4. `Start-Process Dafeiyu.exe`

  重启 SnowLuma 不会让 QQ 下线。机器人会离线十几秒，群里正活跃时别重启，频繁重连是被风控的诱因之一。
- **只改控制台**（`console/*`）：不用重启，刷新页面。
- **只改人设**：`node scripts/apply-persona.mjs`，不用重启。
- **看状态**：`.runtime/status.json`；`scripts\Status.ps1` 列出三个进程和内存；引擎的完整状态（会话、代理记录、错误）用控制接口 `GET /api/status`（地址和令牌在 `.runtime/control-url.txt`，令牌放请求头 `X-QQ-Control`，`Origin` 填同一个地址）。
- **日志**：`.runtime/logs/gateway.log`、`engine.log`、`snowluma.log`，超过 20 MB 换新。SnowLuma 日志会含初始密码一类的东西，读的时候过滤 `password`/`密码`。
- **测试**：`npm test`（即 `node scripts/test.mjs`，跑 `tests/*.test.mjs`，临时文件在 `.runtime/test-temp`）。提交前全部通过。
- **端到端试一下**：用 `tests/engine-fixtures.mjs` 的 `OneBotFixture` 起一个假 QQ，让引擎接真网关（`DAFEIYU_CODEX_URL=http://127.0.0.1:18191/v1`，密钥是 `bridge-windows.json` 的 `token`），注入一条消息看回复。测试一律不连真实的 3000/3001。
- **提交**：
  - 仓库公开。提交前扫一遍差异里有没有真实 QQ 号、群号（来源：`qq-state.json` 的 `config.targets`、`memoryBooks` 的键、`adminIDs`）、密钥（`sk-` 开头、令牌）、群友名字。
  - 提交信息用英文，末尾带 `Co-Authored-By`。
  - 主人允许直接推 `main`。
  - 网络偶尔连不上 GitHub，重试即可。
- **换行符**：`bridge/`、`engine/`、`tests/` 用 LF；`console/` 和部分旧文件是 CRLF。改文件时保持原来的换行符。PowerShell 或 Python 默认写法会把 LF 变成 CRLF，用二进制方式写或在提交前检查。

## 5. 运行数据（`.runtime/`）

| 文件 | 内容 |
|---|---|
| `bridge-windows.json` | 网关设置：`token`（引擎调网关的密钥）、`consoleToken`（控制台首次登录令牌，也是会话签名密钥）、端口、`codex`/`imageCodex`/`claude`/`node`/`ffmpeg` 路径、`tempRoot` |
| `bridge.json` | 旧 WSL 版的网关设置，只用于回滚 |
| `providers.json` | 模型连接和“每种活交给哪个模型”（用途：chat、director、operator、rewrite、review、memory、summary、imageplan、react、poke、outreach、video） |
| `console-auth.json` | 控制台密码（哈希） |
| `snowluma.json` | SnowLuma 目录、机器人号、网关生成的 SnowLuma 管理密码 |
| `engine/qq-state.json` | 引擎全部状态：设置（会话名单、人设、权限档、管理员）、记忆、代理记录、发送记录、被踢记录 |
| `engine/QQStickers/` | 表情库里收进来的图 |
| `agent-tools.json`、`agent-tool-data/` | 机器人自写的 `my_` 工具和它们各自的存储 |
| `voice.json`、`computer.json`、`usage.json`、`public-activity.json` | 语音设置（含 OpenAI Key）、超级模式、用量账本、联网记录 |
| `status.json`、`desired-running.json`、`control-url.txt`、`console-url.txt` | 当前状态、主人上次选的“回复/暂停”、引擎控制地址、控制台地址 |
| `host.pid`、`engine.pid`、`snowluma.pid` | 三个进程的 pid（Windows 不会随父进程结束子进程，新网关靠这些结束旧进程） |
| `logs/` | 日志 |

这些文件都可能含密钥或聊天内容。不要打印令牌和密码，也不要把它们写进任何会提交的文件。

## 6. 引擎怎么工作

- **收消息**：`QQPolicy.incoming` 把 OneBot 事件变成 `QQIncoming`。超过 1 小时的旧消息不处理（只为重启后不回很久以前的话）。各种消息段（图片、表情、卡片、文件、语音、视频、合并转发……）都转成时间线里可读的文字，并提示用哪个工具打开。
- **攒批**：新消息进会话时间线。叫到它的（@、引用它、叫名字或群名片、私聊）立刻开一轮；别的群聊安静 2 秒（或攒满 8 秒）成一批，交给指挥模型（用途 `director`）。
- **代理循环**（`QQEngine.agent.mjs` 的 `deliverAgentTurn` → `DeepSeekClient.operateAgent`）：
  - 每轮最多 60 步，每步最多 24 个工具调用；一次回复里的查询类工具（`agentLookups`）一开始就同时执行，动作按顺序执行。
  - 动作旁边带 `end_turn` 就不再多问一轮（动作没成、查询回来、有新消息时才回去给它看）。处理函数返回 `{content, attention}`，`attention:false` 表示做成了、不用再看。
  - 每批记下 `rounds`、`roundUsage`、`modelSeconds`、`toolSeconds`、`waitSeconds`、`firstSendSeconds`（`QQAgentTurn`，可选字段）。
  - 程序错误（`QQRepair.isBug`）报给网关 `/v1/repair/report`；工具里的 bug 不让整轮失败，告诉代理“已报告”。代理自己用 `report_bug` 报。
  - 慢工具超时转后台（`agentPatience`），做完的结果、途中的新消息、戳一戳、贴表情、到点的提醒都送进正在跑的那一轮（`agentNews`）。
  - 8 个会话同时跑。
- **权限档**（`core/QQAgentPlan.mjs` 的 `QQAgentLevel`）：基础、标准、完全，默认完全。决定能用哪些工具和动作。
- **人的身份由程序核对，不靠模型**：拉黑、禁言、设精华、改群里性格、存表情这类要求，工具要带 `requested_by`（提要求的那条消息），程序查那个人是不是管理员。
- **记忆**：每个会话一本记忆（`core/QQMemoryBook.mjs`），后台整理（用途 `memory`），检索后放进每轮开头。代理也能用 `remember` 当场记、用笔记本记正在跟进的事。
- **存盘**：`persist()` 原子写 `qq-state.json`，有锁文件防两个引擎同时写；每批代理做完立刻存。
- **控制接口**：`QQControlServer` 的 `/api/status`、`/api/action`（`configurationRevision` 防并发修改）、`/api/import-sticker`、`/api/sticker/:id`。网关和控制台都通过它读写引擎。
- **改写规矩**（从 Swift 来的代码保持这些约定）：类型名、字段名和 JSON 形状与 Swift 一致；结构体是带 `decode()`、`toJSON()`、`clone()` 的类；带原始值的枚举是值本身，加一个同名类放静态函数；日期在内存里是 `Date`，存盘用 2001 年起的秒数（`engine/swift.mjs`）；面向用户的文字长度按字素数（`count`/`prefix`）。

## 7. 网关怎么工作

- **模型**：本机 Codex（复用 ChatGPT 登录）、本机 Claude Code、云端 API（OpenAI 兼容或 Anthropic）、本机 dsh（`bridge/dsh.mjs`：读这台电脑上 DeepSeek Harness 的 `settings.yaml` 里 `llm-pi-ai.providers` 配的服务商和模型，密钥按 dsh 的顺序找：环境变量、`.credentials.yaml` 的 refs、`.env`；DSH_HOME 默认 `~/.dsh`。直接按 OpenAI 兼容或 Anthropic 接口调用这些服务商，不启动 dsh 自己的代理：那是带命令行和文件工具的编程代理。模型 ID 写成 `服务商/模型`，每次调用都重新读配置，在 dsh 里改了立即生效）。指挥的一批（`metadata.dafeiyu_session`）在 Claude Code 上是一个 Agent SDK 会话（`claude-session.mjs`），后面几轮只发新消息；其他调用仍是一次一个 `claude -p`。每种用途可以指定不同的模型，没指定就用当前连接。不设输出 token 上限。同时 8 路交互、2 路后台。每条面向聊天的调用都会附上一句底线：不聊国家领导人和时政敏感话题，不写色情和性暗示。
- **画图**：先云端 API，再本机 Codex 的生图；多张同时画，不排队。`/v1/images/generations` 收 `prompt`，可选 `images`（参考图 base64，最多 8 张；有就走云端的 `/images/edits`，本机 Codex 用 `--image` 附上）、`size`（square / portrait / landscape）、`quality`（low / medium / high）、`background: 'transparent'`、`n`（1–4）。API 不认某个可选字段回 400 时，只带基本字段再试一次。
- **自写工具**：机器人用 `create_tool` 说要求，`tool-writer.mjs` 让本机 Codex（Astra 模型，可联网查文档）写代码，网关用测试参数真跑，跑不通把报错还给它改，最多三稿，跑通才启用。工具可访问任何地址（含内网），有自己的存储，能调 QQ 的 OneBot 接口（只挡踢人、禁言、退群、删好友、删群文件、改机器人资料、拿登录凭证）。
- **控制台接口**：`/console/api/*`，要登录。
- **引擎调网关**：`/v1/*`，只认本机地址和 `token`。例如：
  - `/v1/chat/completions`
  - `/v1/images/generations`
  - `/v1/agent-tools*`
  - `/v1/audio/transcriptions`（语音转文字，用语音设置里的 OpenAI Key）
  - `/v1/voice`
  - `/v1/computer/run`
  - 联网工具

## 8. 怎么加一个内置工具

1. 在 `engine/QQAgent.mjs` 定义：
   - 会发东西、做动作的放 `agentActionTools`，按权限种类（`kinds`）给；
   - 只查东西的用 `fn(...)` 放进查询工具，并加进 `agentLookups`，让它能和别的查询同时跑。
2. 在 `engine/core/QQAgentPlan.mjs` 的 `QQAgentLevel` 里决定哪一档有它。
3. 在 `engine/QQEngine.agent.mjs` 里实现：
   - QQ 操作用 `this.connection.action(名字, 参数)`（SnowLuma 支持的动作和参数见它源码 `packages/onebot/src/actions/*.ts`）；
   - 发消息走 `agentSend`，这样会登记 ID、进时间线和记忆。
   - 慢的工具在 `agentPatience` 里设几秒后转后台。
4. 在 `QQAgentPlan.prompt` 的【怎么做事】里加一句它是干什么的。
5. 在 `tests/engine-QQAgentTests.test.mjs` 用假 OneBot 和脚本化模型写测试；假 OneBot 不认识的动作要在 `engine-fixtures.mjs` 里补。
6. 跑 `npm test`；保存后会自动热加载，在真群里看一次。

## 9. 主人的偏好（必须遵守）

- **用中文回复主人**；代码注释和提交信息用英文，注释写“为什么”，并带上主人的原话和日期。
- **不要过度防御**（2026-11-03：“把乱七八糟的过度防护全拆了”）：
  - 不加条数、次数、频率上限，不加关键词拒绝，不加“为安全起见”的门槛。
  - 只保留挡外人、护主人账号和电脑的那几道：管理员核对、超级模式确认、不碰主人的 QQ、密钥打码。
  - 要加限制前先问。
- **画图不排队**（“网关不要做只画一个的排队”）。
- **找根因，不糊提示词**：主人用截图指出群里的毛病时，去 `qq-state.json` 的代理记录（`agentTurns` 的 `errands` 和 `note`）、接话判断（`decisions`）、运行记录（`logs`）里还原当时它看到了什么、做了什么，改代码或工具，而不是往提示词里加一句禁令。
- **人设**：
  - 像大肥鱼本鱼：可爱但不做作，可以抖机灵，接群里的梗；
  - 不能一个字不说、敷衍；
  - 被质疑有依据就坚持；
  - 不编借口，做不到就说原因；
  - 不说自己是“AI 群友”。
- **提示词写法**：不在提示词里点名禁词（写“不要说某词”反而会诱发），用第一人称写她是什么样的人，示例只放正面的。群里聊出来的梗（糖、token、尾巴……）是正常的，不要禁。
- **成本**：主人说过成本不用 AI 操心，好模型照用。
- **对外动作**：
  - 推 `main` 可以直接做；
  - 发 QQ 消息、发帖、删数据这类对外或不可逆的事先问主人；
  - 主人的 QQ 账号、密码、密钥不经手。
- **存储**：项目、缓存、临时文件都在 D 盘；本项目的东西放 `.runtime/`。
- **少重启**：代码改动靠热加载；只有常驻文件改了才重启全部，且挑群里安静的时候。

## 10. 排错

| 现象 | 先看 |
|---|---|
| 不回消息 | 控制台总览；`/api/status` 的 `connected`、`running`、`error`；`decisions` 里那条消息的原因；`agentTurns` 最后几批 |
| 回了但内容怪 | `agentTurns` 那一批的 `errands`（每个工具的参数和结果）和 `note`；它看到的时间线 |
| 「QQ 登录」显示没找到 | 机器人号的 QQ 窗口有没有登录；`snowluma.log` 里有没有 `login detected`；`.runtime/snowluma.json` 的 `account` |
| SnowLuma 密码错 | 删掉 `.runtime/snowluma.json` 里的 `password` 并重启，网关会重新生成并写进 SnowLuma |
| 被踢下线 | 总览“被踢记录”；在机器人那个 QQ 窗口重新登录，登上后自动恢复 |
| 发消息被拒（1200） | 被禁言、被风控或已被踢；运行记录里有原因 |
| 端口被占（18191、3001） | 旧 WSL 版是不是又起来了（`wsl -l -v`），或有残留的 node 进程（看 `.runtime/*.pid`） |
| 画图失败 | 网关日志；本机 Codex 是否登录（`codex login status`）；云端 Key |
| 图片、表情处理失败 | Python 和 Pillow 是否可用（`python -c "import PIL"`） |
| B 站画面、视频截帧失败 | `bridge-windows.json` 的 `ffmpeg` 路径 |
| 语音听不了 | 控制台「能力 → 语音」里有没有 OpenAI Key |

## 11. 回滚到旧的 WSL 版

WSL 里的旧部署（Docker 里的 NapCat、systemd 管的 Swift 引擎和网关）原样保留但已停用。需要回滚时：

1. 结束托盘和 `scripts\Stop.ps1`；
2. 机器人号在 Windows QQ 里退出登录；
3. 在 WSL 里 `sudo /usr/local/bin/dafeiyu-qq-runtime start`；
4. 再 `systemctl --user start dafeiyu-codex.service dafeiyu-bot.service`。

那边的状态停在 2026-11-03 切换的那一刻。

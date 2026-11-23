# winbot

跑在你自己的 Windows 电脑上的 AI 机器人团队。每个机器人有自己的人设、默认模型、工作区和记忆；可以在应用内聊天，也可以接到 Telegram / Slack / Discord。它能读写文件、执行命令；**要写到工作区以外，会先问你**。

对话、记忆、文件和 API Key 都存在这台电脑上（`data/` 目录，不进 Git）。

## 安装（Windows）

下载 `winbot-Setup-0.6.6.exe`，双击安装即可。

- **按用户安装**，不需要管理员权限，装到 `%LOCALAPPDATA%\Programs\winbot`
- 装完桌面和开始菜单各有一个 `winbot` 快捷方式；卸载在「设置 → 应用」里
- 第一次启动会在 `%APPDATA%\winbot\data` 建数据目录（机器人、对话、密钥都在这里）
- 界面是**原生桌面窗口**（Electron），不是浏览器标签页；关窗口不退出，缩到托盘
- 托盘菜单：打开、复制地址、重启服务、开机自启、查看日志、退出
- 安装包没有代码签名，Windows 可能弹 SmartScreen，点「更多信息 → 仍要运行」

![桌面窗口](docs/ui-desktop.png)

从源码跑也行：`npm install` 然后 `npm start`；想用桌面窗口就 `npm run desktop`。

## 它是什么

- **一个机器人 = 一个目录**（`data/bots/<id>/`）：`bot.json` 存身份和配置，`persona.md` 存人设，`memory.md` 存长期记忆，`workspace/` 是它的工作区。
- **智能体内核用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**：每个机器人一个常驻子进程（SDK over stdio JSON-RPC），工具、沙箱、会话持久化、上下文压缩都由它负责；本项目负责机器人管理、权限审批、渠道接入和界面。
- **三档权限**：只读 / 工作区（默认）/ 完全权限。工作区模式下，DSH 沙箱把写入限制在机器人的 `workspace/`，越界操作会经审批接口停下来，在界面和聊天渠道里等你点头。
- **模型自由**：OpenAI 兼容接口（DeepSeek、Kimi、GLM、Qwen、OpenRouter、Ollama…）、OpenAI Responses、Anthropic Messages 都走 `llm-pi-ai`，每个接口一条配置，每个机器人选自己的默认模型。

## 现在的功能

| 能力 | 说明 |
| --- | --- |
| 机器人 | 多机器人，各自的人设、模型、工作区、记忆、权限 |
| 聊天 | 应用内对话，工具步骤实时显示，审批卡片 |
| **图片 / 文件输入** | 按钮、粘贴、拖拽三种方式；图片当作图片给模型看，其它文件放进工作区由它自己读 |
| **上下文用量** | 每条回复显示 ↑上下文 ↓输出，顶部显示这段对话的累计 token |
| **定时任务** | 每天/每周/每隔一段时间让机器人自己干活；没什么可说时它回 `[安静]`，不打扰你 |
| 渠道 | Telegram（文字/图片/文件）、Slack、Discord；飞书/微信留了接口位 |
| 记忆 | 跨机器人共享的「关于我」（4000 字；电话/邮箱/住址先问、密钥拒记），加每个机器人的 `MEMORY.md` |
| 技能 | 每个机器人自己的技能目录；粘贴 SKILL.md 或导入 ZIP，模型自己调用 |
| 连接器（MCP） | 本地命令或远程 HTTP 服务，工具以 `mcp__名字__工具` 出现 |
| 电脑操作 | 截屏、看窗口免审批；点鼠标/敲键盘默认每次问；每个机器人可关 |
| 规则的分寸 | 单次/每月 token 预算、观察模式（真只读）、免打扰、每日上限、连续失败暂停 |
| 送达队列 | 主动消息先落盘，夜里排队、超限合并、失败退避重试 |
| 搜索 | 本机聊天记录搜索（`Ctrl+K`），可按机器人过滤、点结果跳转 |
| 每日预算 | 每个机器人可设「每天最多多少 token」，聊天和定时任务都算；超了直接拒绝并说明 |
| 交付文件 | 机器人用 `present` 交付的文件会显示成可点开的卡片 |
| **实时输出** | 模型边想边说，文字逐字出现（不是等整段）；工具步骤也实时显示 |
| **生图** | 接本机 ComfyUI：Z-Image Turbo（8 步，质量最好）优先，SDXL 兜底；结果直接显示在对话里 |
| **生视频** | 同一套 ComfyUI + MiniMax H3：512×512、带音轨。单段可以长到 90 帧（滑窗一次生成，无接缝）；多段 `chain` 用首尾帧接续；`first_frame`/`last_frame` 可锁定首尾画面 |
| **生 3D** | 本机 Hunyuan3D 2.1：一句话先出底图，再转成 glb（纯几何，无贴图；约 1.5 分钟），文件落工作区 |
| **停止这一轮** | 忙碌时输入框旁出现「停止」，随时掐断，不会记成失败 |
| **审批记住一小时** | 弹审批时可以选「允许，1 小时内同类」，同类操作不再打扰 |
| **看它跑** | 生图/生视频时右侧自动打开 ComfyUI 界面（可手点顶部 `ComfyUI` 打开），能看队列和进度；面板左缘可拖动调宽，双击复位 |
| 崩溃恢复 | 重启后，没处理完的那条消息会在原会话里提示你重发，不会静默消失 |
| 群聊 | 一个群拉几个机器人共享消息；`@名字` 指定谁答，没 @ 时上一个接着说 |
| 机器人互派 | 说「交给小八」，它用自己的模型/权限/工作区做完，结论回到发起方 |
| 审批 | 工作区外写入先问；只授权这一次；10 分钟没答按拒绝 |
| **托盘常驻** | `winbot.exe` 常驻托盘，看护服务，崩了自动重启，双击打开控制台 |
| **开机自启** | 托盘菜单一键开关（写 `HKCU\...\Run`） |
| 数据本地 | 会话、记忆、文件、Key 全在 `data/`；控制台只听 127.0.0.1 且要令牌 |

## 快速开始

1. 装 Node.js **24.9+**（DSH 的引擎要求）。
2. 在本目录执行一次：

   ```bat
   npm install
   powershell -ExecutionPolicy Bypass -File launcher\build.ps1   REM 编出 winbot.exe（只需一次）
   ```

3. 以后就**双击 `winbot.exe`**：它常驻托盘，自动拉起服务，然后右键托盘图标 →「打开控制台」。
4. 在控制台 **设置 → 模型接口** 选接口；**＋** 建机器人；直接聊。

不想用托盘也可以走命令行：`start.cmd`（或 `node src/main.js`），关掉终端服务就停。

### 不用填 Key：用本机 DSH 的 DeepSeek 登录态

如果这台电脑装过 DeepSeek Harness 并且登录了 DeepSeek 账号，启动时会自动多出一个接口
**「DeepSeek（本机 DSH 登录态）」**，模型是 `deepseek-flash` / `deepseek-v4-pro`，**不用填任何 Key**。

原理：DSH 的账号令牌只在请求时由它的账号服务注入（`x-dsh-auth-token`），而且只认
`https://api.deepseek.com` 这个目标。winbot 每个机器人有独立的 `DSH_HOME`，所以在拉起子进程前
会把 `~/.dsh/.credentials.yaml` 复制进去（`src/dsh-account.js` 的 `syncDshCredentials`），
机器人就能用上同一个登录态。令牌不在 `data/config.json` 里，也不进日志。

## 托盘与开机自启

`winbot.exe` 是一个 .NET WinForms 小托盘程序（源码 `launcher/WinbotTray.cs`，用系统自带的
`csc.exe` 编译，不需要装 Electron 或任何 SDK）。

- 右键菜单：打开控制台 / 复制访问地址 / 重启服务 / 随 Windows 启动 / 查看日志 / 退出。
- 它会看护 Node 服务：进程意外退出时自动重启（10 分钟内最多 3 次，避免死循环）。
- 退出时只停自己拉起的服务；如果你之前用 `start.cmd` 手动起过，它只接管显示，不会动你的进程。
- 命令行也能用：`winbot.exe --install-autostart` / `--remove-autostart` / `--stop`。
- 找不到 Node 时，把它写进 `data/node-path.txt`。

日志：`data/tray.log`（服务输出也转到这里）。

## 图片、文件与定时任务怎么用

- **发图**：输入框左边的回形针、直接 `Ctrl+V` 粘贴截图、或者把文件拖进输入框。图片缩小后随消息一起给模型看；其它文件存进 `data/bots/<id>/workspace/assets/`，模型按需自己读。
- **用量**：每条回复下面有 `↑上下文 ↓输出 tokens`，右上角是这段对话的累计。上下文包含缓存命中的部分。
- **定时任务**：左下角「⏰ 定时任务」→ 新建：选机器人、写清楚到点做什么、选每天/每周/每隔多久。可以「立即运行」试一次。结果会回到它自己的 `⏰ 标题` 会话里；如果这次没有新东西值得说，它会只回 `[安静]`，不推送。

## 开发

```bat
node test/real-smoke.mjs bot-<id> "说句话"     REM 真实模型冒烟
node test/real-tools.mjs                       REM 真实模型下的写文件与审批（工作区内/越界拒绝/越界批准）
node test/real-attachments.mjs                 REM 图片+文件上传、模型读图、用量记账
node test/real-schedule.mjs                    REM 定时任务：立即运行 + 到点自动触发
node test/run-e2e.mjs                          REM 离线全链路（本地 mock 模型，不需要 Key）
node test/ui-check.mjs [宽] [高]               REM 截图 + 打印关键元素位置（改界面必跑）
```

`ui-check.mjs` 支持环境变量：`WINBOT_DARK=1` 深色、`WINBOT_OPEN=settings|bot|schedules` 先打开对应面板。

## 界面

| 亮色 | 附件与用量 |
| --- | --- |
| ![亮色](docs/ui-chat-light.png) | ![附件](docs/ui-attachments.png) |

| 定时任务 | 设置 |
| --- | --- |
| ![定时](docs/ui-schedules.png) | ![设置](docs/ui-settings.png) |

## 接聊天渠道

在 **设置 → 聊天渠道** 里填 token 并启用，保存即连接（都是长连接/长轮询，不需要公网地址）：

| 渠道 | 需要的凭证 | 怎么拿 |
| --- | --- | --- |
| Telegram | Bot Token | 找 [@BotFather](https://t.me/BotFather) `/newbot` |
| Slack | App Token（`xapp-`）+ Bot Token（`xoxb-`） | 建 App → 开 Socket Mode → 加 `chat:write`、`app_mentions:read`、`im:history` 等权限 |
| Discord | Bot Token | Developer Portal 建应用 → Bot → Reset Token；开 Message Content Intent |

连上后，**第一个给它发消息的人自动成为这个渠道的主人**，其余人只会收到一句提示。每个渠道可以用 `/bot 名字` 换机器人，用 `/new` 开新对话，回复“同意 `<id>`”“拒绝 `<id>`”处理审批。

飞书和微信这一期只留了接口位（`src/channels/`），原因写在下面「还没做的」里。

## 权限与审批

- **只读**：可以读、可以查，不能改。
- **工作区（默认）**：只能写 `data/bots/<id>/workspace/`；写到外面（比如 `C:\Windows`、桌面）时，DSH 会弹审批，界面上是一张卡片，渠道里是一条消息，10 分钟没人答就按拒绝处理。
- **完全权限**：不进沙箱，删整个目录前仍会问。

审批只认主人。界面里点「允许这一次」，或渠道里回 `同意 <id>`；授权一次只对这一条命令有效。

## 目录结构

```text
winbot/
  start.cmd              启动器（自动挑 Node 24+）
  src/
    main.js              入口：起控制台 + 渠道
    server.js            本地 HTTP API + SSE + 静态页
    config.js            全局配置（接口/Key/渠道），data/config.json
    bots.js              机器人注册表：目录、人设、记忆、工作区
    db.js                SQLite：会话、消息、审批
    dsh.js               智能体内核：每个机器人一个 DSH 子进程
    channels/
      core.js            谁能用、会话归属、斜杠命令、审批回复
      telegram.js        Telegram 长轮询
      slack.js           Slack Socket Mode
      discord.js         Discord Gateway
      ws.js              最小 WebSocket 客户端（零依赖）
      placeholder.js     飞书/微信的接口位
  ui/                    控制台前端（原生 ES 模块，无构建）
  data/                  运行时数据（git 忽略）：config.json、bots/、dsh/、winbot.db
  test/                  冒烟测试与本地 mock 模型
```

## 数据与隐私

- `data/config.json`：模型接口、API Key、渠道令牌（只在子进程环境里出现，不写成命令参数）。
- `data/winbot.db`：给人看的会话记录、审批记录。
- `data/dsh/<botId>/`：DSH 的会话日志、配置、技能，机器人自己的上下文。
- 控制台只监听 `127.0.0.1`，API 需要 `data/ui-token` 里的令牌；想换端口设 `WINBOT_PORT`，想固定令牌设 `WINBOT_TOKEN`。
- 发给模型的内容会到厂商那边（这是任何模型调用的前提），其余都在本机。

## 内置工具（来自 DSH）

读写/搜索文件、PowerShell 命令、后台任务、技能、子代理、待办、网页抓取。工具调用在界面里逐步显示；长命令会转后台，不阻塞对话。

## 还没做的

- **飞书**：要企业自建应用（App ID/Secret + 事件订阅 + 卡片权限），接入面已经在 `src/channels/` 留好。
- **微信**：个人号没有官方机器人接口；可行路线是 iLink/扫码桥接，或本机微信客户端 UI 自动化（有风控风险，需要单独授权）。
- **群聊只在应用内**：Telegram/Slack/Discord 目前只处理单聊，群里还不认。
- **语音消息转写**：Telegram 语音只当文件存下来，没有转文字。
- **多语言**：界面只有中文，词条没抽出来。
- **自动更新**：exe 能常驻和自愈，但没有版本检查与替换流程（需要有发布地址才有意义）。
- **桌面操作的输入动作**：截屏/看窗口已经验证；点击和打字只验证了「审批拦截」，没有真的去动键鼠。

## 它是怎么跑起来的

```text
winbot.exe（托盘）──看护──> node src/main.js
                              ├── src/server.js ──HTTP/SSE──> 浏览器
                              ├── src/schedules.js ──到点──┐
                              └── src/channels/* ─────────┤
                                                          ▼
                                src/dsh.js ──stdio JSON-RPC──> dsh --profile sdk（每个机器人一个进程）
                                     │                              │
                                     ├── 审批请求 <── approval/request ─┤
                                     ├── 工具事件 <── session.event ────┤
                                     └── 用量统计 <── usage ────────────┘
```

机器人配置被翻译成 DSH 的补丁文件（`data/dsh/<botId>/winbot.patch.yml`）：

- `llm-pi-ai`：这个机器人能用的模型接口（Key 只进子进程环境变量）；
- `sandbox-policy`：工作区根目录 + 权限模式；
- `approval` / `permission`：越界一律 `ask`。

## 复盘与路线图

- [复盘与 2.0 规划（可视化）](docs/winbot-2.0-review.html)：43 条问题、能力自评、里程碑
- [2.0 计划](docs/superpowers/plans/2026-11-23-winbot-2.0-plan.md)：M1–M4、验收标准、风险
- [功能清单](docs/FEATURES.md)：已做 / 没做 / 粗糙点

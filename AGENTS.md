# AGENTS.md — winbot

给人看的项目约定。改代码前先读这里，收工前更新 `PROGRESS.md`。

## 怎么跑

```bat
npm install                                  REM 只有 @deepseek-ai/dsh + dsh-sdk-client 两个依赖
powershell -ExecutionPolicy Bypass -File launcher\build.ps1   REM 编出 winbot.exe（托盘）
winbot.exe                                   REM 日常入口：常驻托盘、看护服务
start.cmd                                    REM 只想命令行跑时用（自动挑 Node 24+）
node test/real-smoke.mjs bot-<id> "说句话"   REM 真实模型冒烟
node test/run-e2e.mjs                        REM 离线全链路（本地 mock 模型，不需要 Key）
node test/ui-check.mjs 1440 900              REM 截图 + 打印关键元素位置
```

- Node 必须 ≥ 24.9（DSH 的 `engines` 要求）。本机全局 Node 26 可用；`winbot.exe` 会优先用 PATH 里的
  node，再找本机已知的 24.x，最后看 `data/node-path.txt`。
- 控制台地址带令牌：`http://127.0.0.1:5178/?token=<data/ui-token>`。改端口用 `WINBOT_PORT`。

## 不能动的东西

- `data/` 是用户数据（机器人、会话、Key、定时规则），不要提交、不要清空。测试要清也不要删别的机器人的目录。
- `data/config.json` 里有明文 API Key，任何日志、报错、界面响应都不要把它打印出去；接口返回统一走 `publicConfig()` 打码。
- 权限的默认值不能放宽：`bots.js` 的 `PERMISSIONS` 与 `dsh.js` 的 `writePatch()` 里，越界写入必须 `approval: ask`。
- 每个机器人的 DSH 子进程 `cwd` 必须留在应用根目录（子进程要靠它找 `node_modules` 里的插件），会话工作区只能用 `cwd` 参数。这条踩过坑，别改回去。
- 用本机 DSH 登录态时，必须先把 `~/.dsh/.credentials.yaml` 复制进该机器人的 `DSH_HOME`（`syncDshCredentials`），否则账号服务读不到令牌。

## 架构约定

- **机器人 = 目录**：`data/bots/<id>/{bot.json,persona.md,memory.md,workspace/}`。加字段要同步 `normalize()` 和 `publicConfig()`。
- **内核不重写**：文件、命令、沙箱、会话持久化、上下文压缩都交给 DSH；本项目只做「配置翻译（补丁 YAML）+ 消息收发 + 审批转接 + 渠道」。
- **配置翻译**只在 `dsh.js` 的 `writePatch()`；加能力优先用 DSH 的补丁行（`- id: <row>`），不要在 app 里自己实现工具。
- **人设进系统提示**（`system-prompt.personaPrefix`），不要拼进用户消息，否则模型会把整段人设当成用户说的话。
- **渠道适配器**只负责收/发；权限、会话归属、命令处理、附件落盘都在 `channels/core.js`。
- **定时规则**在 `schedules.js`：每 30 秒扫一次到期项（不用链式 setTimeout），结果写回规则自己的会话；模型回 `[安静]` 就不推送。
- **托盘程序**是独立的小 C#（`launcher/WinbotTray.cs`），只负责看护 Node 进程和菜单，不重复实现业务。
- 前端零构建（原生 ES 模块），改完刷新即可；没有 npm 依赖。

## 风格

- 中文注释，解释「为什么」而不是「是什么」。
- 零第三方依赖优先；实在需要再讨论。
- 每个新增 API 在 `server.js` 里注册路由，并在 `ui/assets/app.js` 里有对应调用或说明。
- 改了界面就跑 `ui-check.mjs`，不要靠肉眼猜布局。

## Windows 上的坑

- `.ps1` 里有中文必须存成 **UTF-8 with BOM**，否则 PowerShell 5.1 按 ANSI 读会变成乱码并解析失败。
- `.cmd` 里不要写中文注释，同理。
- PowerShell 5.1 的 `Invoke-RestMethod` 发中文会乱码，测试客户端一律用 Node。
- C# 子进程读 Node 的 stdout 时要显式设 `StandardOutputEncoding = UTF8`，否则日志乱码。

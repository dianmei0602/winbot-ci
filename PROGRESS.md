# PROGRESS

## 2026-11-22 · 0.5.0 Superpowers 审查

计划：`docs/superpowers/plans/2026-11-22-winbot-0.5.0-closure.md`

### 基线
0.5.0 / HEAD `b24bd71` / 工作区干净 / Release v0.4.0、v0.5.0 各带安装包 /
57 个测试脚本（快检 4、--model 18、--ui 5）。

### 跑了什么
- `run-verify.mjs` 快检 **4/4**
- `run-verify.mjs --model` **18/18**（审批记住 481s、路由、团队包、更新检查全过）
- `docs-check` 扩展后 **16 条断言全过**

### 审查发现并修掉
1. FEATURES 仍把「自动更新」列在「没做」——实际 0.4.0 已做。已移到已做。
2. FEATURES 根本没有「手机访问」行——0.5.0 已做，补上；远程公网登记为没做。
3. 对比页仍写 winbot 自动更新 ❌、手机访问 ❌、「只监听 127.0.0.1」——改成实际状态（覆盖度 28→30/41）。
4. `docs-check` 之前只查版本号/包名/几条关键词，抓不到这类漂移——加 5 条断言（自动更新已做、
   手机访问存在、对比页不再写旧状态）。

### 安全
- 全仓扫密钥：只命中 `test/p0-rules.mjs` 里的假 key 用例（sk-abcdef…）。
- `data/`、`dist/` 都被忽略；默认仍只监听 `127.0.0.1`。
- 局域网开启后无 token 请求 401、带 token 200。

### 遗留风险
R1 `mobile-check` 依赖已开启局域网访问；R2 令牌在 URL（应改 Cookie）；
R3 无 CI；R4 未签名；R5 远程公网未做。

## 2026-11-22 · 收口补遗：全量回归、卸载回归、3D 贴图结论、GitHub 私有仓

### 1. `--model` 全量回归：13/13 通过

`node test/run-verify.mjs --model`（快检 4 项 + 需要真模型的 9 项）：

P0 规则 13s、P0 失败 0s、记忆即时生效 20s、每日预算+交付 9s、群聊+互派 11s、
聊天搜索 8s、流式输出 2s、停止这一轮 27s、**审批记住一小时 482s**（模型轮次多），全绿。

### 2. 卸载回归：通过

- 卸载前：19,502 个文件、桌面快捷方式在、数据 397 个文件。
- 卸载后：目录存在但 **0 文件**、桌面/开始菜单快捷方式消失、卸载项消失，**数据 397 个文件原样保留**。
- 重装 0.3.0 后：exe、快捷方式、数据都在。

### 3. 相对路径：已验

新 `test/relative-path.mjs`：让它写 `outputs/note-rel.txt` 并汇报，回复是
`[outputs/note-rel.txt](outputs/note-rel.txt)`，**没有盘符绝对路径**。已进 `--model` 档。

### 4. 3D 贴图：做不了，且纠正一个错误结论

之前文档写「带颜色的 glb / 几何 + 顶点色」——**是错的**。检查实际产物：

```
属性: {"POSITION":0}         ← 没有 COLOR_0
材质: baseColorFactor 0.22 灰  ← 纯灰
图片: 0  贴图: 0
```

试了两条贴图路线，都失败：

| 路线 | 结果 |
|---|---|
| `BakeTextureFromVoxel(mesh, voxel_colors)` | 先报 `input mesh has no UVs`（补 `UnwrapMesh` 后），再报 `'NoneType' object has no attribute 'detach'` |
| `PaintMesh(mesh, voxel_colors)` → `RenderUVAtlas` → `ApplyTextureToMesh` | 报 `unsupported operand type(s) for /: 'float' and 'NoneType'` |

根因：Hunyuan3D 2.1 的**体素没有颜色数据**，颜色要靠单独的 paint 模型（约 6 GB），本机没有；
ComfyUI 原生模板也只有几何（`SaveGLB` 直连 `VoxelToMesh`）。

已把 README / FEATURES / 工具描述统一改成「纯几何，无贴图」，贴图登记为未做。

### 5. GitHub 私有仓

`https://github.com/dianmei0602/winbot`（private）。4 条提交 + 标签 `v0.2.1` / `v0.3.0`。

- 直连 github.com:443 不通（和 AGENTS 记录一致），push 走 `-c http.proxy=http://127.0.0.1:12450`。
- 凭据从 Windows 凭据管理器取（`git credential fill`），没有写进仓库或全局配置。

## 2026-11-22 · 0.3.0 收口（Superpowers 流程：基线 → 计划 → 任务 → 测试 → 审查）

计划：`docs/superpowers/plans/2026-11-22-winbot-0.3.0-closure.md`

### 基线核对（发现的关键事实）

- **项目没有 git**：`fatal: not a git repository`，所有历史只在 PROGRESS 里，无法回滚/对比。
- `test/` 60 个脚本，9 个单元、9 个 UI/CDP、42 个一次性探针与生成验证混在一起，没有统一入口。
- 版本 0.2.1，安装版可跑，ComfyUI 0.45 在线。

### 做了什么

1. **版本基线**：`git init` → 首个提交 `325becd` → 标签 `v0.2.1`；`.gitignore` 去掉图标（打包必需），
   补上 `data-packtest*/`；清掉两个误留的临时数据目录。
2. **回归入口** `test/run-verify.mjs`：`快检 / --model / --ui / --slow` 四档，带超时和失败摘要；
   15 个一次性探针（probe-*、debug-*、comfy-*、fix-deps…）移到 `test/scratch/`。
3. **文档自检** `test/docs-check.mjs`：版本号、README 里写的安装包是否真的存在且是最新、
   FEATURES 是否把未做的写成已做、`.gitignore` 是否挡住 data/dist/node_modules。**它会真的以非 0 退出**。
4. **回复路径**：personaPrefix 加硬约束，汇报文件一律用工作区相对路径。
5. **Slack/Discord @ 收敛**：新增 `src/channels/mention.js`（纯函数 + 12 条单测），
   频道里只在被 @ 或发命令时接，@ 会被去掉；私聊照常。Slack 启动时 `auth.test` 取 user id，
   Discord READY 时取 bot id。
6. **版本与发布物**：0.3.0、CHANGELOG（0.1→0.3 三段）、`winbot-Setup-0.3.0.exe`（249.9 MB）、
   `dist/SHA256SUMS.txt`（sha256 `3de1d120…`）。

### 审查结果

- `node test/run-verify.mjs` → **4/4 通过**（telegram 群聊、频道 @、打包自检、文档一致性）。
- 安装版 0.3.0：窗口打开、`/health` OK；`ui-stop-installed.mjs` 5 条断言全过（停止按钮出现/消失）。
- 提交 `b57648b` + 标签 `v0.3.0`，工作区干净。
- 没做：卸载回归这一轮没重跑（0.2.0 验过）；3D 贴图仍未做。

## 2026-11-22 · 停止本轮 / 审批记住一小时 / Telegram 群聊 / 多段视频

用户点了清单里的 1、2、4。

### 1a. 停止这一轮

DSH 的 SDK 没有 cancel/abort 接口，只能在进程层面中断：

- `BotRuntime.abort()` 记下「哪一轮被停了」再 `stop()` 掐掉子进程；
- `sendToBot` 捕获到这条错误时改写成 `code='aborted'`，服务端**不记成失败**，只留一条
  「已停止（你按的停止）」；
- 接口 `POST /api/conversations/:id/stop` 和 `/api/groups/:id/stop`；
- 界面：忙碌时发送按钮旁出现「停止」。

代价：进程重启约 1 秒，会话靠 sessionId 续上。实测停完再发「只回答两个字」能正常回。

### 1b. 审批「1 小时内同类」

- 审批按**类别**归档：写文件 / 命令 / 桌面 / MCP / sandbox 升级。
- 创建审批行时就把类别记下来（`kindOf` 映射），回答时直接查——一开始用中文标签重新分类，
  分类结果对不上，豁免永远不命中。
- 命中豁免后直接返回 `allowed-once`（和手动允许同一个值），不再弹卡。
- 界面审批卡加第三个按钮「允许，1 小时内同类」。

实测：第一次跨工作区写要点同意 → 点「允许，1 小时内同类」→ 第二次写另一个路径
**没有弹卡**，文件也真的写出来了（`data/approval-test2` 已清理）。

### 2. Telegram 群聊

- `shouldHandleTelegramMessage()`：私聊全接；群里只在 **@机器人 / 回复它的消息 / 命令** 时接，
  并把 `@bot` 从文本里去掉、把 `/help@bot` 还原成 `/help`。
- 群会话按 `g:<chatId>::<botId>` 归档：**同一个群所有人共享上下文**，换群/换机器人才另开。
- 群里没授权时 10 分钟最多提示一次，不刷屏。
- 启动时 `getMe` 拿 bot 用户名，判断 @ 用。

单测 `test/telegram-group.mjs`：9 条断言全过（私聊/没@/@了/回复/命令/群会话共享/群之间隔离/私聊隔离）。
**注意**：没有真实 bot token，网络侧（getUpdates 收群消息）没实测。

### 4. 多段视频（长视频）

一个 workflow 里跑 N 段 MiniMax（不同种子），用 `ImageBatch` 把解码后的画面接起来，
再 `CreateVideo` → `SaveVideo`，所以不用外部 ffmpeg、也不用把片段落盘再读回。

- `generate_video` 新增 `segments`（1–4）。
- 实测：2 段 × 33 帧 = 78 帧 / 3.25 秒，119 秒出片；走 App 链路 129 秒、927 KB。
- 每段提示词会加 "(continued shot i of n, same scene...)"，让镜头更像接着的。

### 没做：3D 带贴图

Hunyuan3D 的 paint 模型（约 6 GB）这条管线还没接：ComfyUI 里 `PaintMesh` / `BakeTextureFromVoxel`
是通用网格工具，不是 Hunyuan 的纹理阶段；要接得先确认权重和节点组合，属于下一轮的事。

## 2026-11-22 · 生 3D：本地 Hunyuan3D 2.1

用户问「ComfyUI 能部署 Tripo 3.1 吗」。结论：**Tripo 3.1 权重不开源，只能走它/Comfy 的云 API**
（ComfyUI 里那 28 个 `Tripo*` 节点全是 API 节点，要 key、按次扣费）。本地能跑的是 ComfyUI
自带的 **Hunyuan3D 2.1**（节点齐全，只缺权重），用户选了这条。

### 用的文件（一个就够）

`Comfy-Org/Hunyuan-3D-2.1` 的 `hunyuan_3d_v2.1.safetensors`（6.86 GB）——
ComfyUI 把它当 checkpoint 载入（`ImageOnlyCheckpointLoader`），**同时给出 MODEL、CLIP_VISION、VAE**，
所以不用再单独找 clip vision 和 vae。放在 `models/checkpoints/`。

管线（照 `3d_hunyuan3d-v2.1.json` 模板）：`ImageOnlyCheckpointLoader` →
`CLIPVisionEncode` → `Hunyuan3Dv2Conditioning` → `EmptyLatentHunyuan3Dv2` →
`ModelSamplingAuraFlow(shift=1)` → `KSampler(30步,cfg5,euler)` → `VAEDecodeHunyuan3D`（体素）→
`VoxelToMesh`（surface net, 0.6）→ `SaveGLB`。

### App 侧

新工具 `generate_3d`：给 `image` 就直接转；给 `prompt` 就先用 Z-Image 画一张底图再转。
文件落在 `outputs/models/*.glb`，消息里显示成 🧊 卡片（3D 预览没做，用系统查看器/Blender 打开）。

### 8G 显存的两个坑

1. **输出 key 不是 images**：`SaveGLB` 把结果放在 `outputs.*.3d` 里，我原来的等待函数只收
   `images/videos/gifs`，于是**永远等不到**，卡到 900 秒超时，界面上一直转圈。
   改成「只要对象里有 filename 就收」，一次修好图片/视频/模型的通用等待。
2. **Z-Image 和 Hunyuan3D 抢显存**：先画底图再建模时，Z-Image 的权重还占着 8G 里的一大部分，
   换成 6.9G 的 3D 模型就开始换页，慢到不可用。画完底图后调 `POST /free {unload_models:true}`
   主动释放，再跑 3D。

### 实测（3070 Ti 8G）

| 参数 | 耗时 | 产物 |
|---|---|---|
| 1536 / 15 步 / octree 192 | 28 s | 1.2 MB glb |
| 3072 / 25 步 / octree 256 | 77 s | ~4 MB glb |
| App 端（含 Z-Image 画底图） | 82–86 s | 3.8–4.7 MB glb，13 万顶点 |

glb 校验：magic 正确、v2、1 个 mesh / 1 个 material / 13 万顶点（Hunyuan3D 2.1 几何阶段是顶点色，没有贴图图片）。

## 2026-11-22 · 生图 / 生视频（接本机 ComfyUI）

**思路**：不接云 API，直接用这台机器上已经在跑的 ComfyUI（0.45.0，`127.0.0.1:8188`），
数据不出门、不按张收费。机器人通过插件里新增的工具调用它。

### 新增

- `src/comfy.js`：ComfyUI 客户端（状态/排工作流/轮询/下载产物），零依赖。
- `src/media.js`：本轮生成的文件先记在这里，回合结束挂到消息 `meta.files`，界面直接显示。
- `src/dsh-plugins/winbot-media.mjs`：三个工具
  - `generate_image`：SDXL 文生图（默认 Juggernaut XL，1024×1024、24 步，可批量 1–4 张）
  - `generate_video`：MiniMax H3 文生视频（8 步 turbo + 音频），**权重不在时会列出缺的 4 个文件**
  - `media_status`：ComfyUI 在不在、有哪些模型、视频能不能跑
- 设置页新增「生图 / 生视频」：ComfyUI 地址 + 默认模型 + 一键检测（改完自动重启机器人）。
- 界面：`meta.files` 里的图片直接内嵌显示，视频给播放器，其它仍是文件卡片。

### 补：Z-Image Turbo（质量比 SDXL 高一档）

用户在 ComfyUI 里看到「缺失模型」提示（z_image_turbo_bf16 11.46 GB + qwen_3_4b 7.49 GB）。
这两个文件在 HuggingFace `Comfy-Org/Z-Image-Turbo` 的 `split_files/` 下，用代理直接下：

- `diffusion_models/z_image_turbo_bf16.safetensors`（11.46 GB）
- `text_encoders/qwen_3_4b.safetensors`（7.49 GB）
- `vae/ae.safetensors`（0.31 GB，模板里也要）

从工作流模板 `image_z_image_turbo.json` 的 subgraph 里抠出真实参数：
`CLIPLoader(type=lumina2)` + `ModelSamplingAuraFlow(shift=3)` + `KSampler(8 步, cfg 1, res_multistep, simple)` +
`EmptySD3LatentImage` + `ConditioningZeroOut`（负面条件置零）。

插件里加了 `zimageWorkflow`，`generate_image` 新增 `model` 参数（auto/zimage/sdxl）：
auto 时检测到 Z-Image 就用它。实测 25 秒出 1024×1024（含首次加载），比 SDXL 的 20 秒略慢但质量明显更好。

`/api/comfy/status` 增加 `zimageReady`；设置页状态行区分「Z-Image / SDXL」。

### 顺带

- 视频模型匹配改成按关键片段（`minimax` + `fl2va` 等），int8 / fp16 变体都能认，
  不再写死文件名；`videoReady` 也不会被 Z-Image 误判成 true。
- 用户当时正在用 ComfyUI 自己下 MiniMax 的 unet（12.9 GB）和 qwen3vl 文本编码器（12.2 GB），
  下完后 `generate_video` 不用改代码就能跑。

### 补：右侧面板可以拖拽调宽

用户反馈「内置浏览器有了，但窗口大小不能调」。

- 面板左缘加了一条 7px 的分隔条（`#pane-resizer`），`cursor: col-resize`，悬停高亮。
- 拖拽时实时改 CSS 变量 `--panel-w`（`.app.with-panel` 的第三列用它），宽度存进
  `localStorage.winbot.panelW`，下次打开沿用；**双击复位**回各面板默认（普通 380px / ComfyUI 的 52vw）。
- 拖拽期间给 `body` 加 `resizing-pane`：`iframe { pointer-events: none }`，
  否则指针一进到 ComfyUI 就被它吃掉、拖不动了。
- 上限给对话留 420px（左侧栏 232px），下限 320px；≤820px 的窄屏隐藏分隔条（那边是抽屉式面板）。

验证：`node test/ui-resize.mjs` —— 拖 300px 后宽度 720 → 788（被上限截住）、`localStorage` 记住 788、
刷新后仍是 788、双击复位回 720；安装版里同样通过。

**坑**：第一次测的时候打到了上一轮装好的应用（5178 被 winbot.exe 占着，我只杀了 node），
所以页面里根本没有分隔条。以后改前端要么先关掉安装版，要么换端口测。

### 加：右侧内嵌 ComfyUI（看着它跑）

要求：「生图的时候，右边可以有个内置浏览器，打开 ComfyUI，让我能看到运行」。

- 插件在 `submit` 之前 POST `/api/media/started`，宿主转成 SSE 的 `media-start` 事件。
- 界面收到 `media-start` 就自动把右侧面板切到 ComfyUI（`openComfyPanel`），标题栏也加了常驻的
  `ComfyUI` 按钮，随时手动打开。
- ComfyUI 没设 `X-Frame-Options`/CSP，可以直接 iframe 内嵌；面板加宽到 `min(720px, 52vw)`，
  中栏变窄时聊天头自动换行。
- 打开面板不 await 状态请求（ComfyUI 忙时接口会慢），先出界面，地址随后校正。

验证：`node test/ui-comfy.mjs` —— 发一句「画一张柴犬」→ 右侧自动出现 ComfyUI、
iframe 指向 8188、高度 710px；截图里能看到它的「1 个活动任务」和 Z-Image 工作流节点。

### 视频跑通了（权重齐了之后）

用户自己把 MiniMax H3 的权重下完了（unet 19.53 GB int8、qwen3vl 32B nvfp4、视频/音频 VAE），
工具不用改就能跑：**512×512、39 帧、8 步 turbo + LoRA，121 秒出片**，自带音轨。

- 模型匹配按片段认（`minimax`+`fl2va`、`minimax`+`video_vae` 等），int8/fp16 变体通用；
  LoRA 自动找带 `minimax`+`turbo` 的那个（找到才用 8 步，否则退化成 30 步）。
- `videoReady` 判定收紧，不再被 Z-Image 误判成 true。
- 产物 `meta.files` 按路径去重（present 的和自动生成的是同一个文件，之前会显示两遍）。
- 界面上视频有播放器，可直接播放（`docs/ui-video.png`）。

实测：App 里一句「生成一段咖啡冒热气的清晨视频」→ 107–119 秒出片，落盘 283 KB。
### 视频为什么现在还不能跑

MiniMax H3 需要 4 个权重（原来在 `D:\AI_work\...\ComfyUI-aki\models`，迁移时随 D 盘一起删了）：

- `models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- `models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `models/vae/minimax_h3_video_vae_fp16.safetensors`
- `models/vae/minimax_h3_audio_vae_fp32.safetensors`

现在 ComfyUI 的 `UNETLoader` / `CLIPLoader` 枚举都是空的，`VAELoader` 只剩 `pixel_space`，
所以工具会直接拒绝并列出清单；把文件放回去，代码不用改就能出视频。
LoRA `minimax_h3_fl2v_turbo_8step_v1.0` 还在 `models/loras` 里。

### 踩的坑

- 插件忘写 `inject: ['tools']`，`apply` 里拿不到 `ctx.tools`，工具静默不注册，
  模型就会说「我没有 generate_image 这个工具」。
- 默认 checkpoint 取的是枚举第一个（Illustrious，偏插画），出图风格不对；改成 Juggernaut XL。
- `SaveVideo` 的 `format` 在 0.45 里是动态下拉，旧工作流里的 `"mp4"` 仍然有效。

### 验证

- `node test/media-check.mjs`：状态探测 → 让机器人真画一张 → 检查文件落盘（1 MB+ PNG）、
  消息带 `files`；再要视频 → 回复里列出缺的文件。
- 实测出图 9.5 秒 / 768×768，约 20 秒 / 1024×1024（RTX 3070 Ti 8 GB）。
- 界面截图见 `docs/ui-image.png`（雨夜街角那张，直接显示在对话里）。

## 2026-11-22 · 实时输出：把 token 增量接进界面

**问题**：之前是一轮跑完才整段出现，期间只有「…」。DSH 的 SDK 通道（`session.event`）只发
**已定稿**的 `assistant/message`，没有逐字增量。

**找到的路子**：DSH 进程里有 `llm/stream` **waterfall** 事件
（`(options, next) => AsyncIterable<StreamChunk>`）。我们本来就往每个机器人进程里插自己的插件，
于是新增 `src/dsh-plugins/winbot-stream.mjs`：注入 `['llm']`，把 `next()` 的流 tee 一份，
把 `text-delta` 攒 90ms / 160 字就 POST 回宿主；宿主 `/api/stream/delta` 再经 SSE
（`{type:'delta'}`）推给界面。

界面这边：`delta` 累加进 `state.liveText`，用和正式消息同一套 markdown 渲染成气泡
（虚线边框 + 行尾光标），`assistant-step` 定稿时收进进度、回合结束再整段重拉。
渲染用 `requestAnimationFrame` 合帧，避免每个 token 重画。

### 踩的坑

1. **插件要先 `inject: ['llm']`**，否则 `ctx.on('llm/stream')` 收不到（DSH 里监听它的插件都这么写）。
2. **`server.js` 里 `log` 没导入**，delta 接口 500；插件侧又把失败吞掉了，看起来像「没推」。
   现在插件对失败会写调试日志（`WINBOT_STREAM_DEBUG=1` 时落到工作区 `stream-debug.log`）。
3. **测试订阅错端点**：SSE 是 `/api/conversations/:id/events`，不是 `/api/bots/:id/events`。
   自测脚本因此一直 0 增量，白查了半天。
4. 逐字气泡一开始把 `md()` 的 HTML 当文本插进去，页面上出现字面量 `<strong>`；
   改成 `innerHTML = md(text)` 再挂光标。

### 验证

- `node test/stream-check.mjs`：订阅会话 SSE → 发消息 → 断言「收到 ≥2 个增量、首字早于结束、
  拼起来与最终回复一致」。实测 3 个包、跨度 115ms、首字 5543ms / 结束 5663ms（这一轮模型很慢）。
- `node test/ui-stream.mjs`：在真实页面里发一条长回答，每 150ms 采样流式气泡字数，
  并从 76 → 118 → 189 → 270 → … 一路增长，最后落到正式气泡；中途截图 `docs/ui-streaming.png`。
- 打包安装后用同一脚本复测：逐字输出正常。

## 2026-11-22 · 修：安装版一点发送就永远转圈

**现象**：装好的应用里发「你能干什么」，气泡一直转圈、状态显示「未启动」，最后报
`Cannot find package '@deepseek-ai/dsh-sdk-protocol'`。

**原因**：`electron-builder` 只打包 package.json 依赖树里的包，而 DSH 的 21 个子包是
**peerDependencies**（`dsh-sdk-protocol`、`dsh-llm`、`dsh-session`、`dsh-fs`、`dsh-sandbox`…），
不在树里就没进安装包。开发目录有（npm 扁平安装顺带装上了），所以源码跑没问题，
装完就缺。

**修法**：把这 21 个包按实际版本写进 `dependencies`（`test/fix-deps.mjs` 一次性补齐），
再重新打包；安装包里 `@deepseek-ai` 从 318 个变成 339 个，跟开发目录一致。

**防复发**：
- `node test/check-pack.mjs`：对比开发目录与安装/解包产物的 `@deepseek-ai` 包集合，
  缺一个就非零退出，并抽查 `dsh-sdk-protocol`/`dsh-llm`/`dsh-session`。
- `node test/probe-dsh.mjs <appDir> <dataDir>`：用安装版自己的 electron 以 Node 身份跑
  「建机器人 → 发一条消息」，失败时把被吞掉的堆栈打出来。打包后的 DSH 启动问题用这个查最快。

**验证**：
- `check-pack` 两个产物都是 339/缺失 0。
- `probe-dsh` 针对打包产物：`[dsh] started pid=…`，回复「可以」。
- 覆盖安装后，在装好的窗口里重新发「你能干什么」，正常长回复（截图 docs/ui-desktop.png）。

## 2026-11-22 · 做成 Windows 桌面应用 + 安装程序

用户要求：「写成 windows 安装程序，不是网页版」。

### 结构

- **Electron 外壳**（`electron/main.js`）：原生窗口 + 托盘。关窗口不退出（缩到托盘），
  双击托盘还原。菜单：打开、复制地址、重启服务、开机自启、查看日志、退出。
- **后端不动**：外壳用 `ELECTRON_RUN_AS_NODE=1` 把原来的 `src/main.js` 当子进程拉起来，
  健康检查通过后窗口再指向它；端口已被占用就直接复用，不会起第二个。
  后端挂了会自动拉起（退出后 1.5s 重启）。
- **DSH 子进程**：childEnv 里也补 `ELECTRON_RUN_AS_NODE=1`，否则它按 GUI 身份启动。
- **数据目录**：开发用项目 `data/`；安装版用 `%APPDATA%\winbot\data`。
- **单实例**：再启动一次只是把已有窗口叫到前台。

### 打包

`electron-builder` → NSIS 安装包（**按用户安装，不需要管理员**）：
桌面 + 开始菜单快捷方式、可改安装目录、卸载项；卸载保留数据。

### 打包踩到的坑（值得记住）

1. **Electron 版本被 DSH 白名单卡住**：DSH 的本地插件 `node-addon-require-builtin` 只认
   Electron `43.0.0 / 44.0.0 / 44.7.0 / 44.11.5 / 45.0.0-alpha.6`。先装的 45.4.1 报
   `unsupported Electron runtime fingerprint`，DSH 直接起不来。**固定用 44.11.5**。
2. **npm 默认不跑 postinstall**：electron 的二进制靠它下载，得手动
   `node node_modules/electron/install.js`（配 `ELECTRON_MIRROR` 走镜像）。
3. **打包后 `cwd` 不能是 `app.asar`**（那是文件不是目录），子进程直接起不来。
   现在打包版把后端 cwd 设成 userData，DSH 的 bin 改成按模块自身位置找 node_modules。
4. **asar 关掉**：开着时原生插件加载失败（`node-addon-require-builtin` 在 asar 里不认），
   改平铺到 `resources/app/` 后正常；代价是安装目录大一点（945 MB）。
5. **关掉原生模块重编**（`npmRebuild: false`）：koffi / node-pty 是 N-API，直接复用现成二进制；
   否则会调 MSBuild，缺 Spectre 库直接失败。
6. **package.json 不能带 BOM**：PowerShell `Set-Content` 默认加 BOM，electron-builder 的
   `JSON.parse` 报 `Unexpected token '﻿'`。
7. **卸载只留一个空目录**（NSIS 常见行为），文件与快捷方式都清干净，数据保留。

### 验证

- `node test/electron-check.mjs`（可指定 `WINBOT_CDP_PORT`）：连 CDP，确认窗口里加载了界面、
  能看到机器人、**在桌面窗口里发消息真的收到回复**。
- 静默安装 `winbot-Setup-0.2.0.exe /S` → 退出码 0；`%LOCALAPPDATA%\Programs\winbot` 945 MB；
  桌面 + 开始菜单快捷方式、卸载项「winbot 0.2.0」齐全。
- 启动后窗口标题「winbot · 我自己的机器人」，`/health` 正常，带原来的小七、小八、
  群「写作小组」和「关于我」。
- 卸载 → 快捷方式消失、目录清空、`%APPDATA%\winbot\data` 保留 → 重装后数据自动回来。

## 2026-11-22 · 修记忆不生效 + 预算/交付/崩溃恢复

### 1. 记忆不生效（真 bug）

`remember` 写进「关于我」后，机器人**看不到**——系统提示是进程启动时生成的，不重启就一直用旧的那份。
界面里加一条也一样。

修法：`about.js` 暴露 `aboutMtime()`；`BotRuntime` 记下启动时的版本，
`ensureRuntime()` 发现文件变新且机器人空闲就重启进程；界面增删「关于我」时也主动重启所有机器人。

验证（`test/p0-memory-fresh.mjs`）：界面加一条 → 新对话立刻答得出；让它自己 remember → 新对话也立刻用得上；
删掉 → 新对话说不知道。

### 2. 每日预算（聊天也管）

之前预算只管定时任务。现在每个机器人有「每天最多用多少 token」（0 = 不限）：
聊天和定时任务都算，超了直接拒绝并说明原因；定时任务遇到预算会暂停而不是记失败。
`/api/bots/:id` 返回 `usageToday`，设置页显示今天已用多少。

验证（`test/p1-budget-present.mjs`）：预算设 1 → 发消息被拒绝并提示每日上限；还原后正常。

### 3. 交付文件（present 工具）

机器人调用 `present` 交付的文件以前被忽略。现在：
`dsh.js` 在 `tool/call` 里收集 `present` 的路径 → 回合结果带回 → 消息 `meta.files` →
界面渲染成可点开的文件卡片（下载/打开走工作区文件接口）。

验证：让它写 `outputs/present-test.md` 再 present → 文件真的存在、消息里带路径、界面出卡片。

### 4. 崩溃恢复提示

启动时找出「最后一条消息是用户发的」会话（说明处理途中断了），补一条
「上次这条消息没处理完（应用退出或崩溃了），麻烦重发一次」的提示，而不是让它沉默。

验证：直接造一条只有用户消息的会话 → `danglingUserConversations()` 能检测到 → 重启服务后日志打印
「补了 1 条未完成的提示」，会话里出现 `[note]` 消息。

### 5. 顺手修的：群会话丢失自愈

清理脚本误删了群的那条会话，群就发不出消息了。现在 `ensureGroupConversation()` 会在
`GET /api/groups/:id` 和发消息时按成员重建会话；清理脚本也加了「不删 group 会话」的保护。
验证：删掉群会话后重新打开群 → 自动重建 → 群里发消息正常出气泡。

## 2026-11-22 · 修：回复显示成灰字备注

**现象**：一轮答完，机器人的回复显示成一行灰色小字（还带省略号），看着像脚注而不是对话；刷新或切换会话后才恢复成气泡。

**原因**：界面只处理了流式的 `assistant-step` 事件（塞进 `state.progress`，按「灰字」渲染），
**turn 结束后没有把服务端落好的最终消息重新拉回来**。所以停在那里的就是一段被截断的流式片段。

**修法**：
- `assistant-step` 改成按正常气泡渲染（带发言人头像和名字，虚线边框表示还在说），不再是灰字；
- 收到 `turn-status: idle` 或 `status.busy=false` 时调用 `endOfTurn()`：清空流式片段并重新拉取消息，
  用服务端那份正式记录替换掉临时渲染；
- `emit()` 给所有事件补上 `botId`，群聊里流式阶段也能标对发言人。

**验证**（新增两个真机脚本）：
- `node test/ui-live.mjs`：在页面里真的输入并点发送 → 5 秒后只有「…」，结束后是正常气泡、零灰字、零「正在说」。
- `node test/ui-live-group.mjs`：群里同样 → 气泡带「小七 · 时间」、零灰字。旧的那条 02:57 消息刷新后也恢复成气泡。

## 2026-11-22 · P3：群聊 + 机器人互派

### 群聊（`src/groups.js` + `groups`/`group_sessions` 表）

- 一个群拉几个机器人，共享一条群会话；每个机器人在群里各有自己的 DSH 会话
  （`group_sessions`），互不污染上下文。
- 发言规则：`@名字` 指定谁答；没 @ 就上一个回答的接着说；都没就第一个成员。
- 第一次在某群发言时注入一段群上下文（群名、成员），之后靠历史就记得。
- 界面：侧栏「群聊」区、建群弹窗（选成员）、群聊顶部显示成员、消息带发言人名字和头像。
- 群里的审批卡照常工作（审批落在群会话里）。

### 机器人互派（`src/dsh-plugins/winbot-collab.mjs`）

- 新工具 `list_other_bots` / `ask_another_bot`：把一件自包含的活交给另一个机器人，
  它用自己的模型、权限、工作区和预算，在独立的 `handoff` 会话里做完，结论回到发起方。
- 委托时会告诉目标「来自谁、你看不到它的会话、请写成可转述的完整回复」。
- 发起方拿到结论后自己核对再转述给用户；两边花费分别记在各自会话。

### 验证（`node test/p3-groups.mjs`）

建群 → 没 @ 时第一个成员回答（记了发言人）→ `@小八` 时确实是小八回答 →
消息都在同一会话且发言人不同 → 发起方用 `ask_another_bot` 拿到对方原话
（「收到任务」）→ 目标机器人有自己的 handoff 会话 → 删群正常。

### 没做的（有意留白）

- **多语言**：界面只有中文，词条没抽出来。自己用中文的话收益很低，真要做是一个独立工程。
- **自动更新**：exe 已经能常驻和自愈，但没有版本检查/下载/替换流程；这要先有一个发布地址，
  没有发布渠道时做它只是空转。

## 2026-11-22 · P2 + P3（部分）：技能、连接器、电脑操作、搜索

### P2-1 技能（`src/skills.js`）

- 每个机器人一个技能目录 `data/bots/<id>/skills/<slug>/SKILL.md`，通过补丁里的
  `skill-filesystem.customSkillDirs` 接进 DSH；装完自动重启机器人，下一条消息生效。
- 支持三种装法：粘贴 SKILL.md、导入 ZIP（自带极简解压器，只认 store/deflate；Windows
  Compress-Archive 的反斜杠会被归一化）、删除。
- 界面在「机器人设置」里；模型能看到技能目录并自己调用。

验证（`node test/p2-skills.mjs`）：粘贴安装 → 列表解析出 description → 模型回复里列出
`demo-weekly-note` → ZIP 导入（SKILL.md + scripts/run.js 都解出来）→ 删除。

### P2-2 连接器（MCP）（`src/mcp.js`）

- 配置存在 `data/config.json` 的 `mcp[]`：stdio（命令/参数/环境变量）或 streamable-http（地址/头）。
- 注入成补丁里的 `@deepseek-ai/dsh-mcp-client` 行，工具以 `mcp__<名字>__<工具>` 出现；
  可整体停用或删除，改动后自动重启机器人生效。
- 界面在设置页「连接器（MCP）」；环境变量在接口返回时打码。

验证（`node test/p2-mcp.mjs`）：加一个自写的 `test/mcp-echo-server.mjs`（60 行、按行 JSON-RPC）
→ 模型真的调用到 `mcp__echo__echo`，回复里带上 `echo: 连接器已接通` → 停用/删除正常。

### P2-3 电脑操作（`src/dsh-plugins/winbot-desktop.mjs`）

DSH 自带的 CUA 包只支持 macOS（Windows「in development」），所以自己接了一套：

- `desktop_screenshot`：截全屏到工作区 `tmp/screenshots/`，**不需要审批**。
- `desktop_windows`：列带标题的窗口，**不需要审批**。
- `desktop_action`：点鼠标 / 输文字 / 按键 / 切窗口，**默认每次弹审批**，走得是本地 HTTP
  → 宿主 `/api/desktop/request` → 审批卡片落进当前会话 → 用户点「允许这一次」才执行。
- 每个机器人有一个「电脑操作」开关：关（默认）/ 每次问我 / 自动执行。
- 顺手修了两处：PowerShell 输出按 UTF-8 解码（否则中文窗口标题乱码）；`createApproval` 漏导入。

验证（`node test/p2-desktop.mjs`）：截屏生成了 PNG、窗口列表中文正常、点击请求弹出审批卡片
→ 拒绝 → 模型回「没点成，已停下」。测试截图（含屏幕内容）已删除，不留。

### P3-1 聊天记录搜索（`/api/search` + 界面搜索面板）

- 本机 SQLite LIKE 搜索消息，可按机器人过滤，结果带会话标题/渠道/时间；
  点结果直接跳到那个会话并滚到附近。`Ctrl+K` 打开。
- 验证（`node test/p3-search.mjs`）：造一条含暗号的消息 → 能搜到、带会话与机器人信息、
  按机器人过滤仍能搜到、搜不到返回空、空关键词返回空。

### 还没做的 P3

- **群聊 / 机器人互派**：需要新的路由和会话模型，是大件，没动。
- **多语言**：界面只有中文，词条也没抽出来。
- **自动更新**：exe 已能常驻，但没有版本检查与替换流程。

## 2026-11-22 · P0：规则的分寸 + 共享记忆

对照参考项目补齐最缺的一层：不是加能力，是让「把事交给它」变得安全。

### 做了什么

- **「关于我」共享记忆**（`src/about.js`）：跨所有机器人共享，4000 字上限，注入每个机器人的系统提示。
  新增 DSH 插件 `src/dsh-plugins/winbot-memory.mjs`，注册 `remember` / `forget` / `recall_about_me` 三个工具。
  敏感信息（电话/邮箱/住址/证件）第一次调用只返回「先问用户」，确认后才落盘；密码/密钥一律拒绝。
- **规则的分寸**（`src/schedules.js`）：单次/每月 token 预算、观察模式（真的把会话切到只读）、
  免打扰、每日上限、连续 3 次失败自动暂停、暂停原因与恢复。
- **送达队列**（`src/outbox.js`）：主动消息先落盘，免打扰时段只排队，超每日上限合成一条排到次日早上，
  发送失败指数退避重试（最多 8 次）。
- **数据库迁移**（`src/db-migrate.js`）：老库自动加列/建表，不动已有数据。
- **设置页**：关于我编辑、主动消息（免打扰时段 + 每渠道每日上限）。
- **定时任务页**：模式/预算/免打扰开关；卡片显示「观察」、本月用量、暂停原因与「本来会说什么」。

### 验证（`node test/p0-rules.mjs`、`node test/p0-failure.mjs`）

- 观察模式：真的只读（想写的文件没被创建），状态 `observe`，记录了「本来会说什么」。
- 单次预算 1 token → 跑完 10379 tokens → 自动暂停「预算用完」。
- 关于我：电话需确认、确认后可记、密钥被拒、只留确认过的那条。
- 送达队列：免打扰只排队 → 解除后发出 → 每日上限 2 条时只发 1 条、其余合成 1 条排明天 → 失败退避不丢。
- 失败暂停：连跑 3 次失败 → `pausedReason=failures`，恢复后清零。
- 设置接口能保存免打扰时段。

## 2026-11-22 · 从「雏形演示」补成日常可用（三块功能）

用户拍板先做三块：图片/文件输入 + 用量、定时规则、托盘常驻/自启/打包 exe。

### 1. 图片 / 文件输入 + 上下文用量

- **上传**：`POST /api/bots/:id/upload`（JSON base64）→ 写进这个机器人的 `workspace/assets/`；
  单个上限 30MB，文件名做安全清洗。读取走 `GET /api/bots/:id/file?path=`（只允许工作区内）。
- **给模型**：`dsh.js` 的 `buildTurnInput()` 把附件拼成 SDK 内容块——图片用 `{type:'image'}` 真给模型看，
  其它文件只在文字里点名路径，让模型用读文件工具自己打开（比在宿主里解析各种格式可靠）。
- **界面**：回形针按钮 / 粘贴 / 拖拽三种入口，发送前有缩略图 chip 可删；消息里图片直接显示、
  文件显示成带名字的标签。
- **用量**：`assistant/message` 事件里的 `usage` 逐步累加 → `usage` 表 → 会话接口返回合计 →
  每条回复下面 `↑上下文 ↓输出`，顶部药丸显示累计。上下文含缓存命中（`input + cacheRead`）。

验证（`test/real-attachments.mjs`，真实模型）：上传 PNG + TXT → 模型准确读出图里的
`WINBOT-7421 / KX-9910` 和笔记里的开会时间；`usage` 记账 `input 2200 / output 388 / cacheRead 19072`。

### 2. 定时规则

- 表 `schedules`；`src/schedules.js` 负责算下次时间（每天/每周/间隔）、每 30 秒扫到期项、
  跑一轮、判断「安静」、推送。
- 结果写回规则自己的会话（`channel='schedule'`，标题 `⏰ xxx`）；没有新东西值得说时模型回
  `[安静]`，宿主不推送、不打扰。
- 可推送到 Telegram/Slack/Discord（适配器都加了 `deliver()`），默认只留在界面。
- 界面：左下角「⏰ 定时任务」→ 列表 + 新建（机器人、做什么、重复方式、时间）+ 立即运行/暂停/删除。

验证（`test/real-schedule.mjs`）：建 1 分钟间隔规则 → 立即运行成功 → 到点自动触发；
自动那次模型判断「没什么新内容」回了 `[安静]`，`last_status=quiet`，会话里只留用户消息。

### 3. 托盘常驻 + 开机自启 + winbot.exe

- `launcher/WinbotTray.cs`：.NET WinForms 托盘（系统自带 `csc.exe` 编译，**不引入 Electron**）。
  拉起 `node src/main.js`、把输出转存 `data/tray.log`、健康检查、崩溃自愈（10 分钟最多 3 次）、
  菜单（打开控制台/复制地址/重启服务/随 Windows 启动/查看日志/退出）、单实例互斥。
- `launcher/build.ps1`：画一个图标（PNG-in-ICO）→ 内嵌资源编译出 `winbot.exe`。
- 命令行开关：`--install-autostart` / `--remove-autostart` / `--stop`。
- 退出只停自己拉起的服务；如果检测到已有服务在跑（比如手动 `start.cmd`），只接管显示。

验证：双击 `winbot.exe` → 托盘起来、node 子进程起来、健康检查 OK；
`--stop` 把托盘和服务一起收干净；`--install-autostart` 写入 `HKCU\...\Run`、`--remove-autostart` 删除；
手动 kill 服务器进程后 8 秒内被看护重启（pid 变化、健康恢复）；真实模型在托盘拉起的服务下也能正常干活。

### 踩过的坑

- `.ps1` 里写中文必须 UTF-8 **带 BOM**，否则 PS 5.1 按 ANSI 读会乱码并报语法错。
- C# 读子进程 stdout 默认按系统代码页解码，Node 输出 UTF-8 会乱码；要显式设 `StandardOutputEncoding`。
- `ProcessStartInfo` 用 `EnvironmentVariables` 传 `WINBOT_PORT`，别指望继承 pwsh 的临时变量。
- 测试脚本把机器人切到 mock 后要**切回去**（`smoke.mjs` 已加还原），否则真实配置被留在 mock。

### 仍然没做

飞书（要企业自建应用）、微信（无官方个人机器人接口）、桌面操作（CUA 授权边界）、
群聊与机器人互派、语音转写、预算上限（目前只统计用量，不拦）。

## 2026-11-22 · 接上真实 DeepSeek（用本机 DSH 登录态）

# CI 与发版 Runbook

## CI（公共镜像跑 Actions）

GitHub 私有仓的 Actions 被账号账单卡住（job 根本不启动），所以 CI 跑在**公共镜像仓**：

- 镜像仓：https://github.com/dianmei0602/winbot-ci （源码公开；截图等个人内容不会进镜像）
- 同步命令：`node scripts/mirror-ci.mjs`（导出 HEAD 快照 → 排除 `docs/*.png`、`data/`、`dist/` → 推 main）
- workflow：`.github/workflows/ci.yml`，四步：语法自检 / Telegram 群聊判定 / Slack-Discord @ 收敛 / 文档一致性
- 最近一次运行：**成功**（4 步全绿）。查看：`https://github.com/dianmei0602/winbot-ci/actions`

发版脚本会自动刷新镜像，一般不用手动跑。

## 发版（一条命令）

```bash
node scripts/release.mjs --notes "这次改了什么"
```

它会依次：跑快检 → 升 patch 版本 → 改 README 安装包名 → 写 CHANGELOG → electron-builder 构建 →
写 SHA256SUMS → 提交 + 打 tag + 推私有仓 → 发 GitHub Release（私有仓）→ 发公开更新渠道（winbot-ci）→ 刷新 CI 镜像。

`--minor` 升次版本，`--skip-tests` 跳过快检（不建议）。

## 自动更新闭环

- 更新渠道：**公开镜像仓的 Release**（`winbot-ci`）——资产公开，不需要 token，`browser_download_url` 直接可用
- 私有仓的资产必须走 API 资产端点（`/releases/assets/:id` + `Accept: octet-stream`），下载代码已支持
- 代理：设置 → 更新里的「代理」会写进后端启动环境（`NODE_USE_ENV_PROXY`），下载/检查改用系统 `curl.exe` 走代理
- 端到端测试：`node test/update-e2e.mjs`（前置：安装版在跑、配置 `repo=winbot-ci`、`proxy` 已填）

### 已实测（2026-11-24）

- 检查 / 下载 / 排队：稳定。0.6.14 → 0.6.15：检查 1s、下载 31s、排队成功。
- 安装触发：**还不稳**，根因已定位：
  - Electron 退出时，detached 的 PowerShell 子进程会被一起带走（实测：父进程退出后子进程不再写文件）。
  - 改成「计划任务执行」后，**手动建任务并运行**可以完整装完（105s、exit 0、回执、版本变化）。
  - 从 App 内部 `schtasks /Create` + `/Run` 触发时，任务没有真正跑起安装器（无回执、版本不变、安装目录完整），
    最可能是 `/TR` 里带引号的命令经 `execFileSync` 传参被拆坏。
- 结论：**别再手搓 NSIS 调度**。下一版改用 electron-updater 的 `quitAndInstall()`；退而求其次用
  `schtasks /Create /XML`（任务 XML 文件，绕开 `/TR` 引号），并校验「任务确实启动」。

## 已知问题

1. **自动更新的安装触发不可靠**（O25）：见上节；文件没被破坏（安装目录完整），但版本不会变。
2. **推送 Bitbucket 需要一次凭据**：浏览器登录状态无法用于 git push，
   需要 Bitbucket「应用密码」（Repositories: Read/Write）+ workspace 名。
3. 私有仓 Actions 仍不可用（账单），公共镜像是目前的替代方案。
4. 发布脚本上传资产偶发 http2 中断（release 建了但资产为空）；
   用 curl.exe --http1.1 手动补传即可，已在 0.6.8 上验证。



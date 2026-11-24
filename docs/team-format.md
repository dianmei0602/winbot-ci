# 团队包格式

一段 Markdown（或纯 JSON）就能建好几个机器人 + 一个群。

```winbot-team
{
  "name": "写作小组",
  "bots": [
    { "name": "小七", "summary": "总编：写稿、改稿、排版", "avatar": "green", "persona": "你是编辑，说话简洁，先给结论。" },
    { "name": "小八", "summary": "调研：查资料、跑脚本、写代码", "avatar": "blue", "persona": "你是工程师。" }
  ],
  "group": { "name": "写作小组", "members": ["小七", "小八"], "router": "model" }
}
```

## 字段

| 字段 | 说明 |
|---|---|
| `name` | 团队名（可留空） |
| `bots[].name` | 机器人名字（必填）。**同名会更新简介/人设，不会重建** |
| `bots[].summary` | 一句话简介，路由会用它判断该谁答 |
| `bots[].avatar` | blue / green / yellow / red / purple / orange，不填自动分配 |
| `bots[].persona` | 人设，进系统提示 |
| `group.name` | 群名 |
| `group.members` | 成员名字数组（按名字对应上面的 bots） |
| `group.router` | `rules`（默认，零成本）或 `model`（每句多一次小模型调用） |

## 导入

- 控制台 → 设置 → 团队包 → 粘贴或「从文件读」→ 导入团队
- 接口：`POST /api/teams/import { "text": "..." }`

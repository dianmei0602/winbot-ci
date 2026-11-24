// 应用连接模板：常见服务的 MCP 服务器预设，一键加进「连接器」。
// 不依赖第三方账号（不做 Composio 那种托管），需要 OAuth/Token 的地方由用户自己填。
export const CONNECTOR_PRESETS = [
  {
    id: 'filesystem',
    name: 'filesystem',
    title: '本地文件（指定目录）',
    description: '让机器人读你指定目录里的文件。不需要任何账号。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'E:\\AI_work'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'github',
    title: 'GitHub',
    description: '读写 issue / PR / 仓库文件。需要一个 Personal Access Token。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Token（repo 权限）', required: true, secret: true }],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'slack',
    name: 'slack',
    title: 'Slack（MCP）',
    description: '读频道、发消息。需要 Slack Bot Token（MCP 服务器另装）。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack Bot Token（xoxb-）', required: true, secret: true },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team ID', required: true, secret: false },
    ],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id: 'notion',
    name: 'notion',
    title: 'Notion',
    description: '读页面、写笔记。需要 Notion Integration Token。',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: [{ key: 'NOTION_API_KEY', label: 'Notion Integration Token（ntn_）', required: true, secret: true }],
    docs: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'playwright',
    name: 'playwright',
    title: '浏览器自动化',
    description: '打开网页、点按钮、抓内容。不需要账号，但要装浏览器内核。',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: [],
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'fetch',
    name: 'fetch',
    title: '网页抓取（fetch）',
    description: '把网页转成 markdown 给模型读。不需要账号。',
    command: 'npx',
    args: ['-y', '@kazuph/mcp-fetch'],
    env: [],
    docs: 'https://github.com/kazuph/mcp-fetch',
  },
  {
    id: 'postgres',
    name: 'postgres',
    title: 'PostgreSQL（只读）',
    description: '连数据库做只读查询。需要连接串，建议只给只读账号。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: [{ key: 'POSTGRES_URL', label: '连接串（postgres://…）', required: true, secret: true }],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
];

export function findPreset(id) {
  return CONNECTOR_PRESETS.find((p) => p.id === id) || null;
}

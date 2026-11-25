// 连接器（MCP）：把用户填的一条配置变成 DSH patch 里的 mcp-client 行。
// 只做「配置 + 注入」，连接、工具发现、调用都由 DSH 的 mcp-client 负责。
import { loadConfig } from './config.js';
import { newId } from './util.js';

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function listMcp() {
  return loadConfig().mcp || [];
}

/** 这个机器人要不要加载这条连接器（bots 为空 = 全部） */
export function mcpForBot(botId) {
  return listMcp().filter((m) => m.enabled !== false && (!Array.isArray(m.bots) || m.bots.length === 0 || m.bots.includes(botId)));
}

export function validateMcp(m) {
  if (!m || typeof m !== 'object') return '配置为空';
  if (!MCP_SERVER_NAME_RE.test(String(m.name || ''))) return '名字只能是小写字母、数字、下划线或连字符，最多 32 个字符';
  if (!['stdio', 'streamable-http'].includes(m.transport)) return '传输方式只能是 stdio 或 streamable-http';
  if (m.transport === 'stdio' && !String(m.command || '').trim()) return 'stdio 模式要填命令，比如 npx 或 node';
  if (m.transport === 'streamable-http' && !/^https?:\/\//.test(String(m.url || ''))) return 'HTTP 模式要填 http(s) 地址';
  return null;
}

const yamlStr = (v) => JSON.stringify(String(v));

/** 一条连接器写成 YAML 行（缩进从 4 空格起，和别的 insert 行对齐） */
export function mcpLines(m, indent = '    ') {
  const lines = [
    `${indent}- id: ${yamlStr(`mcp-${m.id}`)}`,
    `${indent}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${indent}  config:`,
    `${indent}    serverName: ${yamlStr(m.name)}`,
    `${indent}    transport: ${m.transport === 'streamable-http' ? 'streamable-http' : 'stdio'}`,
  ];
  if (m.transport === 'streamable-http') {
    lines.push(`${indent}    url: ${yamlStr(m.url)}`);
    const headers = m.headers && Object.keys(m.headers).length ? m.headers : null;
    if (headers) {
      lines.push(`${indent}    headers:`);
      for (const [k, v] of Object.entries(headers)) lines.push(`${indent}      ${k}: ${yamlStr(v)}`);
    }
  } else {
    lines.push(`${indent}    command: ${yamlStr(m.command)}`);
    if (Array.isArray(m.args) && m.args.length) {
      lines.push(`${indent}    args:`);
      for (const a of m.args) lines.push(`${indent}      - ${yamlStr(a)}`);
    }
    const env = m.env && Object.keys(m.env).length ? m.env : null;
    if (env) {
      lines.push(`${indent}    env:`);
      for (const [k, v] of Object.entries(env)) lines.push(`${indent}      ${k}: ${yamlStr(v)}`);
    }
    if (m.cwd) lines.push(`${indent}    cwd: ${yamlStr(m.cwd)}`);
  }
  // 起不来别把整个机器人拖死
  lines.push(`${indent}    failOnStartupError: false`);
  if (m.timeoutMs) lines.push(`${indent}    toolCallTimeoutMs: ${Number(m.timeoutMs)}`);
  return lines;
}

export function buildMcp(input) {
  const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const m = {
    id: input.id || newId('mcp'),
    name: String(input.name || '').trim(),
    title: String(input.title || input.name || '').trim(),
    transport,
    enabled: input.enabled !== false,
    bots: Array.isArray(input.bots) ? input.bots.filter(Boolean) : [],
    ...(transport === 'streamable-http'
      ? { url: String(input.url || '').trim(), headers: input.headers || {} }
      : {
          command: String(input.command || '').trim(),
          args: Array.isArray(input.args) ? input.args.map(String) : String(input.args || '').split(/\s+/).filter(Boolean),
          env: input.env || {},
          cwd: input.cwd ? String(input.cwd) : undefined,
        }),
    ...(input.timeoutMs ? { timeoutMs: Number(input.timeoutMs) } : {}),
    createdAt: Date.now(),
  };
  return m;
}

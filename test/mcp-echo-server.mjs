// 最小 MCP 服务器（stdio，按行 JSON-RPC），只为验证连接器链路。
// 暴露一个 echo 工具：调用后返回 "echo: <text>"。
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const TOOLS = [
  {
    name: 'echo',
    description: '把传入的文本原样回显，用于验证连接器是否接通。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
];

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const error = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'winbot-echo', version: '1.0.0' },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== 'echo') return error(-32602, `unknown tool: ${name}`);
      reply({ content: [{ type: 'text', text: `echo: ${String(args.text ?? '')}` }] });
      return;
    }
    case 'resources/list':
      reply({ resources: [] });
      return;
    case 'prompts/list':
      reply({ prompts: [] });
      return;
    default:
      error(-32601, `method not found: ${method}`);
  }
});

process.stderr.write('[mcp-echo] ready\n');

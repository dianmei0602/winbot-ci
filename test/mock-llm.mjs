// 模拟一个 OpenAI Chat Completions 端点，用来离线验证智能体回路与审批。
// 带 OUTSIDE：写工作区外 → 被沙箱拒 → 按提示带 sandbox_permissions 升级重试（触发审批）
//             → 看结果给结论（批准了 / 被拒了），不再重试。
// 否则：写 outputs/hello.txt。
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 5199);
let calls = 0;

function sse(res, frames, model, id) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  for (const f of frames) res.write(`data: ${JSON.stringify({ ...base, ...f })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function toolCall(name, args) {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: `call_mock_${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      },
    ],
  };
}

function say(text) {
  return { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    calls += 1;
    const messages = parsed.messages || [];
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    const allUserText = messages
      .filter((m) => m.role === 'user')
      .map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.text || '').join(' ') : String(m.content || '')))
      .join('\n');
    const outside = allUserText.includes('OUTSIDE');
    const toolText = toolMsgs.map((m) => JSON.stringify(m.content || '')).join('\n');
    const escalated = /rejected escalating this operation/.test(toolText);
    const rejected = /rejected escalating|user rejected|denied under workspace-write/i.test(toolText);
    const written = /Created file|Updated file/.test(toolText);
    const model = parsed.model || 'mock-model';
    const id = `chatcmpl-mock-${calls}`;
    console.log(`[mock] #${calls} msgs=${messages.length} toolMsgs=${toolMsgs.length} outside=${outside} escalated=${escalated} rejected=${rejected} written=${written}`);

    // 还没调过工具：直接写
    if (toolMsgs.length === 0) {
      const target = outside ? 'E:/AI_work/winbot/outside-test.txt' : 'outputs/hello.txt';
      sse(
        res,
        [
          say(outside ? '好，我写到工作区外面去。' : '我先把结果写进工作区。'),
          toolCall('write', { file_path: target, content: 'winbot 测试内容\n' }),
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ],
        model,
        id,
      );
      return;
    }

    // 写外面、还没升级过：按提示申请一次升级（这一步会触发审批），之后无论成败都收尾
    if (outside && toolMsgs.length < 2) {
      sse(
        res,
        [
          say('沙箱拒了，我按提示申请一次升级。'),
          toolCall('write', {
            file_path: 'E:/AI_work/winbot/outside-test.txt',
            content: 'winbot 测试内容\n',
            sandbox_permissions: 'danger-full-access',
            justification: '用户明确要求把这个测试文件写到工作区外的 E:\\AI_work\\winbot\\outside-test.txt',
          }),
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ],
        model,
        id,
      );
      return;
    }

    // 收尾
    let text;
    if (outside) {
      if (written) text = '写好了：`E:/AI_work/winbot/outside-test.txt`（这次审批通过了）。';
      else if (rejected) text = '文件没写成：这个路径在工作区外面，审批没有通过。要不要改到工作区里？';
      else text = '没能写到工作区外面（原因见上面的工具结果）。';
    } else {
      text = '写好了：工作区 `outputs/hello.txt`，内容是「winbot 测试内容」。需要我改措辞吗？';
    }
    sse(res, [say(text), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], model, id);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] listening on http://127.0.0.1:${PORT}`));





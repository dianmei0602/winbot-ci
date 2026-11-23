// ComfyUI 客户端：排工作流、等结果、把产物拉回来。
// 不引入任何依赖，只用 fetch —— 这样打包时不用多带东西。
import { loadConfig } from './config.js';
import { log } from './util.js';

export function comfyConfig() {
  const cfg = loadConfig();
  const c = cfg.comfy || {};
  return {
    url: String(c.url || process.env.WINBOT_COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    checkpoint: c.checkpoint || 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
    enabled: c.enabled !== false,
    timeoutMs: Number(c.timeoutMs) || 180_000,
  };
}

async function get(path, opts = {}) {
  const { url } = comfyConfig();
  const res = await fetch(`${url}${path}`, { ...opts, signal: opts.signal || AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ComfyUI ${path} -> HTTP ${res.status}`);
  return res;
}

/** ComfyUI 在不在、有哪些模型、视频能不能跑 */
export async function comfyStatus() {
  const { url, checkpoint } = comfyConfig();
  const out = { up: false, url, checkpoint, checkpoints: [], unet: [], clip: [], vae: [], videoReady: false, version: null };
  try {
    const stats = await (await get('/system_stats')).json();
    out.up = true;
    out.version = stats?.system?.comfyui_version || null;
    const info = await (await get('/object_info')).json();
    const enumOf = (node, input) => info[node]?.input?.required?.[input]?.[0] || info[node]?.input?.optional?.[input]?.[0] || [];
    out.checkpoints = enumOf('CheckpointLoaderSimple', 'ckpt_name');
    out.unet = enumOf('UNETLoader', 'unet_name');
    out.clip = enumOf('CLIPLoader', 'clip_name');
    out.vae = enumOf('VAELoader', 'vae_name');
    out.loras = enumOf('LoraLoaderModelOnly', 'lora_name');
    out.nodes = { video: !!info.MiniMaxH3ImageToVideo, saveVideo: !!info.SaveVideo, audio: !!info.VAEDecodeAudio };
    // 视频要：MiniMax 的 unet + 文本编码器 + 视频/音频两个 VAE（名字有 int8/fp16 变体，按片段认）
    const some = (list, parts) => list.some((x) => parts.every((p) => String(x).toLowerCase().includes(p)));
    out.videoReady =
      out.nodes.video &&
      some(out.unet, ['minimax']) &&
      some(out.clip, ['minimax']) &&
      some(out.vae, ['minimax', 'video_vae']) &&
      some(out.vae, ['minimax', 'audio_vae']);
    out.zimageReady = out.unet.some((x) => x.includes('z_image')) && out.clip.some((x) => x.includes('qwen_3_4b')) && out.vae.includes('ae.safetensors');
  } catch {
    out.up = false;
  }
  return out;
}

/** 提交工作流，返回 prompt_id */
export async function queueWorkflow(workflow) {
  const { url } = comfyConfig();
  const res = await fetch(`${url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const data = await res.json();
  if (!res.ok || !data.prompt_id) {
    const detail = JSON.stringify(data?.node_errors || data).slice(0, 600);
    throw new Error(`ComfyUI 拒绝了工作流：${detail}`);
  }
  return data.prompt_id;
}

/** 等一个任务跑完，返回产物 [{filename, subfolder, type}] */
export async function waitFor(promptId, { timeoutMs = 180_000, pollMs = 1000 } = {}) {
  const { url } = comfyConfig();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await fetch(`${url}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) continue;
    const hist = await res.json();
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      const msg = JSON.stringify(entry.status?.messages || entry.status).slice(0, 500);
      throw new Error(`ComfyUI 执行失败：${msg}`);
    }
    const files = [];
    for (const [nodeId, output] of Object.entries(entry.outputs || {})) {
      for (const key of ['images', 'videos', 'gifs', 'audio']) {
        for (const f of output?.[key] || []) {
          if (f?.filename) files.push({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output', node: nodeId });
        }
      }
    }
    if (files.length) return files;
    if (entry.status?.completed) return [];
  }
  throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没出结果（ComfyUI 队列可能堵着）`);
}

/** 把产物文件下载成 Buffer */
export async function downloadFile({ filename, subfolder = '', type = 'output' }) {
  const { url } = comfyConfig();
  const q = new URLSearchParams({ filename, subfolder, type });
  const res = await fetch(`${url}/view?${q}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 一次「提交并等结果」的便捷封装 */
export async function runWorkflow(workflow, { timeoutMs } = {}) {
  const { timeoutMs: cfgTimeout } = comfyConfig();
  const id = await queueWorkflow(workflow);
  log('comfy', `queued ${id}`);
  return waitFor(id, { timeoutMs: timeoutMs || cfgTimeout });
}


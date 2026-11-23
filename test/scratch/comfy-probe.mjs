// 探针：确认 ComfyUI 的生图流程能跑通（提交 → 轮询 → 拿到文件）。
const BASE = 'http://127.0.0.1:8188';

const wf = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a cozy desk with a small robot figurine, soft window light, photorealistic', clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, watermark, text', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 768, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: { seed: 12345, steps: 20, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { filename_prefix: 'winbot/probe', images: ['6', 0] } },
};

const t0 = Date.now();
const res = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: wf }),
});
const queued = await res.json();
console.log('queue:', JSON.stringify(queued).slice(0, 200));
if (!queued.prompt_id) process.exit(1);

for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = await (await fetch(`${BASE}/history/${queued.prompt_id}`)).json();
  const entry = h[queued.prompt_id];
  if (!entry) continue;
  const outs = Object.values(entry.outputs || {}).flatMap((o) => o.images || []);
  if (outs.length) {
    console.log(`完成 ${Date.now() - t0}ms:`, JSON.stringify(outs));
    process.exit(0);
  }
  if (entry.status?.status_str === 'error') {
    console.log('执行出错:', JSON.stringify(entry.status).slice(0, 500));
    process.exit(1);
  }
}
console.log('超时');
process.exit(1);

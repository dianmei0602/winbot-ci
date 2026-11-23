// 直接用 Z-Image Turbo 跑一张，验证节点参数和速度。
const BASE = 'http://127.0.0.1:8188';
const wf = {
  28: { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
  30: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
  29: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
  27: { class_type: 'CLIPTextEncode', inputs: { text: 'a red panda barista making coffee, cozy cafe, warm morning light, shallow depth of field, photorealistic', clip: ['30', 0] } },
  33: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['27', 0] } },
  13: { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  11: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['28', 0], shift: 3 } },
  3: {
    class_type: 'KSampler',
    inputs: { seed: 7, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: ['11', 0], positive: ['27', 0], negative: ['33', 0], latent_image: ['13', 0] },
  },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['29', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'winbot/zimage-probe', images: ['8', 0] } },
};
const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await r.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 700));
  process.exit(1);
}
for (let i = 0; i < 300; i += 1) {
  await new Promise((x) => setTimeout(x, 1000));
  const h = await (await fetch(`${BASE}/history/${q.prompt_id}`)).json();
  const e = h[q.prompt_id];
  if (!e) continue;
  if (e.status?.status_str === 'error') {
    console.log('执行失败:', JSON.stringify(e.status).slice(0, 800));
    process.exit(1);
  }
  const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || []);
  if (imgs.length) {
    console.log(`Z-Image 出图 ${Date.now() - t0}ms:`, JSON.stringify(imgs));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

// 双锚点探针：首帧 + 尾帧同时锚定，把输出的第一帧和最后一帧存成 PNG 比对。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8188';
const LEN = 22;
const info = await (await fetch(`${BASE}/object_info`)).json();
const enumOf = (n, i) => info[n]?.input?.required?.[i]?.[0] || [];
const unet = enumOf('UNETLoader', 'unet_name').find((x) => x.includes('minimax') && x.includes('fl2va'));
const clip = enumOf('CLIPLoader', 'clip_name').find((x) => x.includes('qwen3vl'));
const vae = enumOf('VAELoader', 'vae_name');
const videoVae = vae.find((x) => x.includes('minimax') && x.includes('video_vae'));
const audioVae = vae.find((x) => x.includes('minimax') && x.includes('audio_vae'));
const lora = enumOf('LoraLoaderModelOnly', 'lora_name').find((x) => x.includes('minimax') && x.includes('turbo'));

// 取工作区里两张不同的图
const imgs = [];
for (const root of ['E:/AI_work/winbot/data/bots', 'C:/Users/Administrator/AppData/Roaming/winbot/data/bots']) {
  if (!fs.existsSync(root)) continue;
  for (const bot of fs.readdirSync(root)) {
    const d = path.join(root, bot, 'workspace', 'outputs', 'images');
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.(png|jpg|jpeg)$/i.test(f)) imgs.push(path.join(d, f));
  }
}
imgs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (imgs.length < 2) throw new Error('需要两张图');
const [srcA, srcB] = imgs;
console.log('首帧:', path.basename(srcA), '尾帧:', path.basename(srcB));

const upload = async (p, name) => {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(p)], { type: 'image/png' }), name);
  form.append('overwrite', 'true');
  const r = await (await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })).json();
  return r.name;
};
const a = await upload(srcA, 'anchor-first.png');
const b = await upload(srcB, 'anchor-last.png');

const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
  4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1 } },
  900: { class_type: 'LoadImage', inputs: { image: a } },
  901: { class_type: 'LoadImage', inputs: { image: b } },
  113: { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: 'A smooth camera move between two scenes, continuous motion, cinematic.', width: 512, height: 512, length: LEN } },
  800: { class_type: 'MiniMaxH3AddGuide', inputs: { positive: ['113', 0], vae: ['3', 0], latent: ['113', 1], image: ['900', 0], frame_idx: 0 } },
  801: { class_type: 'MiniMaxH3AddGuide', inputs: { positive: ['800', 0], vae: ['3', 0], latent: ['113', 1], image: ['901', 0], frame_idx: LEN - 1 } },
  112: { class_type: 'BasicScheduler', inputs: { model: ['5', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
  110: { class_type: 'RandomNoise', inputs: { noise_seed: 31337 } },
  111: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  114: { class_type: 'BasicGuider', inputs: { model: ['5', 0], conditioning: ['801', 0] } },
  115: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['110', 0], guider: ['114', 0], sampler: ['111', 0], sigmas: ['112', 0], latent_image: ['113', 1] } },
  116: { class_type: 'VAEDecode', inputs: { samples: ['115', 0], vae: ['3', 0] } },
  117: { class_type: 'VAEDecodeAudio', inputs: { samples: ['115', 0], vae: ['4', 0] } },
  300: { class_type: 'CreateVideo', inputs: { images: ['116', 0], fps: 24, audio: ['117', 0], bit_depth: 8, color_space: 'sRGB', chroma_subsampling: '420', codec: 'none' } },
  301: { class_type: 'SaveVideo', inputs: { video: ['300', 0], filename_prefix: 'winbot/anchor-probe', format: 'mp4' } },
  400: { class_type: 'ImageFromBatch', inputs: { image: ['116', 0], batch_index: 0, length: 1 } },
  401: { class_type: 'SaveImage', inputs: { images: ['400', 0], filename_prefix: 'winbot/anchor-out-first' } },
  402: { class_type: 'ImageFromBatch', inputs: { image: ['116', 0], batch_index: LEN - 1, length: 1 } },
  403: { class_type: 'SaveImage', inputs: { images: ['402', 0], filename_prefix: 'winbot/anchor-out-last' } },
};

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await r.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 1200));
  process.exit(1);
}
console.log('queued', q.prompt_id);
for (let i = 0; i < 300; i += 1) {
  await new Promise((x) => setTimeout(x, 2000));
  const h = await (await fetch(`${BASE}/history/${q.prompt_id}`)).json();
  const e = h[q.prompt_id];
  if (!e) continue;
  if (e.status?.status_str === 'error') {
    console.log('执行失败:', JSON.stringify(e.status?.messages || {}).slice(0, 1200));
    process.exit(1);
  }
  const files = Object.values(e.outputs || {}).flatMap((o) => o.images || []);
  if (files.length >= 2) {
    console.log(`完成 ${Math.round((Date.now() - t0) / 1000)}s:`, files.map((f) => f.filename).join(', '));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

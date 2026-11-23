// 探针：首尾帧接续（seg1 最后一帧 → seg2 第 0 帧的 guide），并把边界帧存成 PNG 方便比对。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8188';
const LEN = Number(process.env.LEN || 33); // 必须符合 17k+5：5 / 22 / 39 / 56…
const info = await (await fetch(`${BASE}/object_info`)).json();
const enumOf = (n, i) => info[n]?.input?.required?.[i]?.[0] || [];
const unet = enumOf('UNETLoader', 'unet_name').find((x) => x.includes('minimax') && x.includes('fl2va'));
const clip = enumOf('CLIPLoader', 'clip_name').find((x) => x.includes('qwen3vl'));
const vae = enumOf('VAELoader', 'vae_name');
const videoVae = vae.find((x) => x.includes('minimax') && x.includes('video_vae'));
const audioVae = vae.find((x) => x.includes('minimax') && x.includes('audio_vae'));
const lora = enumOf('LoraLoaderModelOnly', 'lora_name').find((x) => x.includes('minimax') && x.includes('turbo'));
console.log({ unet, clip, videoVae, audioVae, lora, LEN });

const P1 = 'A white ceramic cup on a warm wooden table, morning sun, steam rising, slow push in.';
const P2 = 'The same white ceramic cup, camera keeps pushing in slowly, steam still rising, same warm light.';

const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
  4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1 } },
  // 第一段
  110: { class_type: 'RandomNoise', inputs: { noise_seed: 999 } },
  111: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  112: { class_type: 'BasicScheduler', inputs: { model: ['5', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
  113: { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: P1, width: 512, height: 512, length: LEN } },
  114: { class_type: 'BasicGuider', inputs: { model: ['5', 0], conditioning: ['113', 0] } },
  115: {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['110', 0], guider: ['114', 0], sampler: ['111', 0], sigmas: ['112', 0], latent_image: ['113', 1] },
  },
  116: { class_type: 'VAEDecode', inputs: { samples: ['115', 0], vae: ['3', 0] } },
  117: { class_type: 'VAEDecodeAudio', inputs: { samples: ['115', 0], vae: ['4', 0] } },
  // 取第一段最后一帧
  120: { class_type: 'ImageFromBatch', inputs: { image: ['116', 0], batch_index: LEN - 1, length: 1 } },
  // 第二段：guide 锚定第一段最后一帧到第 0 帧
  130: { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: P2, width: 512, height: 512, length: LEN } },
  131: {
    class_type: 'MiniMaxH3AddGuide',
    inputs: { positive: ['130', 0], vae: ['3', 0], latent: ['130', 1], image: ['120', 0], frame_idx: 0 },
  },
  132: { class_type: 'BasicGuider', inputs: { model: ['5', 0], conditioning: ['131', 0] } },
  133: {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['110', 0], guider: ['132', 0], sampler: ['111', 0], sigmas: ['112', 0], latent_image: ['130', 1] },
  },
  134: { class_type: 'VAEDecode', inputs: { samples: ['133', 0], vae: ['3', 0] } },
  135: { class_type: 'VAEDecodeAudio', inputs: { samples: ['133', 0], vae: ['4', 0] } },
  // 拼接
  200: { class_type: 'ImageBatch', inputs: { image1: ['116', 0], image2: ['134', 0] } },
  210: { class_type: 'AudioConcat', inputs: { audio1: ['117', 0], audio2: ['135', 0], direction: 'after' } },
  300: { class_type: 'CreateVideo', inputs: { images: ['200', 0], fps: 24, audio: ['210', 0], bit_depth: 8, color_space: 'sRGB', chroma_subsampling: '420', codec: 'none' } },
  301: { class_type: 'SaveVideo', inputs: { video: ['300', 0], filename_prefix: 'winbot/chain-probe', format: 'mp4' } },
  // 边界帧存图，用来肉眼比对
  400: { class_type: 'SaveImage', inputs: { images: ['120', 0], filename_prefix: 'winbot/boundary-seg1-last' } },
  401: { class_type: 'ImageFromBatch', inputs: { image: ['134', 0], batch_index: 0, length: 1 } },
  402: { class_type: 'SaveImage', inputs: { images: ['401', 0], filename_prefix: 'winbot/boundary-seg2-first' } },
};

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await r.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 1200));
  process.exit(1);
}
console.log('queued', q.prompt_id);
for (let i = 0; i < 600; i += 1) {
  await new Promise((x) => setTimeout(x, 2000));
  const h = await (await fetch(`${BASE}/history/${q.prompt_id}`)).json();
  const e = h[q.prompt_id];
  if (!e) {
    if (i % 20 === 0) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s …`);
    continue;
  }
  if (e.status?.status_str === 'error') {
    console.log('执行失败:', JSON.stringify(e.status?.messages || {}).slice(0, 1500));
    process.exit(1);
  }
  const files = Object.values(e.outputs || {}).flatMap((o) => Object.values(o || {})).flat().filter((f) => f && f.filename);
  if (files.length) {
    console.log(`完成 ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(files).slice(0, 400));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

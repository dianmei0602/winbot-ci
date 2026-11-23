// 试 ContextWindows：一次生成 90 帧（17*5+5），看 8G 显存能不能跑、多久。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:8188';
const LEN = Number(process.env.LEN || 90);
const info = await (await fetch(`${BASE}/object_info`)).json();
const enumOf = (n, i) => info[n]?.input?.required?.[i]?.[0] || [];
const unet = enumOf('UNETLoader', 'unet_name').find((x) => x.includes('minimax') && x.includes('fl2va'));
const clip = enumOf('CLIPLoader', 'clip_name').find((x) => x.includes('qwen3vl'));
const vae = enumOf('VAELoader', 'vae_name');
const videoVae = vae.find((x) => x.includes('minimax') && x.includes('video_vae'));
const audioVae = vae.find((x) => x.includes('minimax') && x.includes('audio_vae'));
const lora = enumOf('LoraLoaderModelOnly', 'lora_name').find((x) => x.includes('minimax') && x.includes('turbo'));
const cwOptions = info.MiniMaxH3ContextWindows.input.required.fuse_method?.[0] || [];
console.log({ LEN, cwOptions });

const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
  4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1 } },
  // 滑窗：让模型跨窗口连起来，一次生成更长的片子
  6: {
    class_type: 'MiniMaxH3ContextWindows',
    inputs: { model: ['5', 0], context_length: 39, context_overlap: 17, fuse_method: 'pyramid', freenoise: false, split_conds_to_windows: false },
  },
  113: { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: 'A slow cinematic pan across a wooden table in morning light, a white cup with rising steam, dust motes in the air.', width: 512, height: 512, length: LEN } },
  112: { class_type: 'BasicScheduler', inputs: { model: ['6', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
  110: { class_type: 'RandomNoise', inputs: { noise_seed: 4242 } },
  111: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  114: { class_type: 'BasicGuider', inputs: { model: ['6', 0], conditioning: ['113', 0] } },
  115: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['110', 0], guider: ['114', 0], sampler: ['111', 0], sigmas: ['112', 0], latent_image: ['113', 1] } },
  116: { class_type: 'VAEDecode', inputs: { samples: ['115', 0], vae: ['3', 0] } },
  117: { class_type: 'VAEDecodeAudio', inputs: { samples: ['115', 0], vae: ['4', 0] } },
  300: { class_type: 'CreateVideo', inputs: { images: ['116', 0], fps: 24, audio: ['117', 0], bit_depth: 8, color_space: 'sRGB', chroma_subsampling: '420', codec: 'none' } },
  301: { class_type: 'SaveVideo', inputs: { video: ['300', 0], filename_prefix: 'winbot/cw-probe', format: 'mp4' } },
};

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await r.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 1000));
  process.exit(1);
}
console.log('queued', q.prompt_id);
for (let i = 0; i < 900; i += 1) {
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
  const outs = Object.values(e.outputs || {}).flatMap((o) => o.images || []);
  if (outs.length) {
    console.log(`出片 ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(outs).slice(0, 400));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

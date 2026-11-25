// 验证多段拼接：直接调 ComfyUI 跑 2 段，看输出帧数和时长。
const BASE = 'http://127.0.0.1:8188';
const info = await (await fetch(`${BASE}/object_info`)).json();
const enumOf = (n, i) => info[n]?.input?.required?.[i]?.[0] || [];
const unet = enumOf('UNETLoader', 'unet_name').find((x) => x.includes('minimax') && x.includes('fl2va'));
const clip = enumOf('CLIPLoader', 'clip_name').find((x) => x.includes('qwen3vl'));
const vae = enumOf('VAELoader', 'vae_name');
const videoVae = vae.find((x) => x.includes('minimax') && x.includes('video_vae'));
const audioVae = vae.find((x) => x.includes('minimax') && x.includes('audio_vae'));
const lora = enumOf('LoraLoaderModelOnly', 'lora_name').find((x) => x.includes('minimax') && x.includes('turbo'));
const SEGMENTS = Number(process.env.SEGMENTS || 2);
const LEN = Number(process.env.LEN || 33);
console.log({ unet, clip, videoVae, audioVae, lora, SEGMENTS, LEN });

const modelRef = ['5', 0];
const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
  4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1 } },
};
for (let i = 0; i < SEGMENTS; i += 1) {
  const b = 100 + i * 10;
  wf[b] = { class_type: 'RandomNoise', inputs: { noise_seed: 4242 + i * 101 } };
  wf[b + 1] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } };
  wf[b + 2] = { class_type: 'BasicScheduler', inputs: { model: modelRef, scheduler: 'simple', steps: 8, denoise: 1 } };
  wf[b + 3] = {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: `A white ceramic cup on a warm wooden table, morning sun, steam rising, slow push in. (shot ${i + 1} of ${SEGMENTS})`,
      width: 512,
      height: 512,
      length: LEN,
    },
  };
  wf[b + 4] = { class_type: 'BasicGuider', inputs: { model: modelRef, conditioning: [String(b + 3), 0] } };
  wf[b + 5] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: [String(b), 0], guider: [String(b + 4), 0], sampler: [String(b + 1), 0], sigmas: [String(b + 2), 0], latent_image: [String(b + 3), 1] },
  };
  wf[b + 6] = { class_type: 'VAEDecode', inputs: { samples: [String(b + 5), 0], vae: ['3', 0] } };
  wf[b + 7] = { class_type: 'VAEDecodeAudio', inputs: { samples: [String(b + 5), 0], vae: ['4', 0] } };
}
let images = ['106', 0];
for (let i = 1; i < SEGMENTS; i += 1) {
  wf[200 + i] = { class_type: 'ImageBatch', inputs: { image1: images, image2: [String(100 + i * 10 + 6), 0] } };
  images = [String(200 + i), 0];
}
const lastAudio = [String(100 + (SEGMENTS - 1) * 10 + 7), 0];
wf[300] = { class_type: 'CreateVideo', inputs: { images, fps: 24, audio: lastAudio, bit_depth: 8, color_space: 'sRGB', chroma_subsampling: '420', codec: 'none' } };
wf[301] = { class_type: 'SaveVideo', inputs: { video: ['300', 0], filename_prefix: 'winbot/multiseg-probe', format: 'mp4' } };

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await r.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 900));
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
  const outs = Object.values(e.outputs || {}).flatMap((o) => o.images || o.videos || []);
  if (outs.length) {
    console.log(`出片 ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(outs).slice(0, 400));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

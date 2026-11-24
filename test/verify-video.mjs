// 直接跑 MiniMax H3 文生视频（8 步 turbo + LoRA），看耗时和显存表现。
const BASE = 'http://127.0.0.1:8188';
const info = await (await fetch(`${BASE}/object_info`)).json();
const enumOf = (n, i) => info[n]?.input?.required?.[i]?.[0] || [];
const unet = enumOf('UNETLoader', 'unet_name').find((x) => x.includes('minimax') && x.includes('fl2va'));
const clip = enumOf('CLIPLoader', 'clip_name').find((x) => x.includes('qwen3vl'));
const vae = enumOf('VAELoader', 'vae_name');
const videoVae = vae.find((x) => x.includes('minimax') && x.includes('video_vae'));
const audioVae = vae.find((x) => x.includes('minimax') && x.includes('audio_vae'));
const lora = enumOf('LoraLoaderModelOnly', 'lora_name').find((x) => x.includes('minimax') && x.includes('turbo'));
console.log({ unet, clip, videoVae, audioVae, lora });
if (!unet || !clip || !videoVae || !audioVae) {
  console.log('模型不全');
  process.exit(1);
}

const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
  4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  6: { class_type: 'RandomNoise', inputs: { noise_seed: 20261122 } },
  7: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  8: { class_type: 'BasicScheduler', inputs: { model: [lora ? '5' : '1', 0], scheduler: 'simple', steps: lora ? 8 : 30, denoise: 1 } },
  9: {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: 'A slow cinematic push-in on a white ceramic coffee cup on a warm wooden table. Morning sunlight moves across the rim while soft steam rises. Calm room tone, quiet birds outside, no music, no voice, no text.',
      width: 512,
      height: 512,
      length: 33,
    },
  },
  10: { class_type: 'BasicGuider', inputs: { model: [lora ? '5' : '1', 0], conditioning: ['9', 0] } },
  11: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['10', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['9', 1] } },
  12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
  13: { class_type: 'VAEDecodeAudio', inputs: { samples: ['11', 0], vae: ['4', 0] } },
  14: { class_type: 'CreateVideo', inputs: { images: ['12', 0], fps: 24, audio: ['13', 0], bit_depth: 8, color_space: 'sRGB', chroma_subsampling: '420', codec: 'none' } },
  15: { class_type: 'SaveVideo', inputs: { video: ['14', 0], filename_prefix: 'winbot/video-probe', format: 'mp4' } },
};
if (lora) wf[5] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1 } };

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
    if (i % 15 === 0) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s …`);
    continue;
  }
  if (e.status?.status_str === 'error') {
    console.log('执行失败:', JSON.stringify(e.status?.messages || {}).slice(0, 1200));
    process.exit(1);
  }
  const outs = Object.values(e.outputs || {}).flatMap((o) => [...(o.images || []), ...(o.videos || []), ...(o.gifs || [])]);
  if (outs.length) {
    console.log(`出视频 ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(outs));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

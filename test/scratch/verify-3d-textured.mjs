// 试「几何 + 烘焙贴图」：Hunyuan3D 体素 → VoxelToMesh → BakeTextureFromVoxel → ApplyTextureToMesh → SaveGLB
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8188';
const RES = Number(process.env.RES || 1536);
const STEPS = Number(process.env.STEPS || 15);
const OCTREE = Number(process.env.OCTREE || 192);
const TEX = Number(process.env.TEX || 1024);

// 用一张现成的图当输入
let image = null;
for (const root of ['E:/AI_work/winbot/data/bots', 'C:/Users/Administrator/AppData/Roaming/winbot/data/bots']) {
  if (!fs.existsSync(root)) continue;
  for (const bot of fs.readdirSync(root)) {
    const dir = path.join(root, bot, 'workspace', 'outputs', 'images');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(f)) continue;
      const p = path.join(dir, f);
      if (!image || fs.statSync(p).mtimeMs > fs.statSync(image).mtimeMs) image = p;
    }
  }
}
if (!image) throw new Error('没有可用图片');
console.log('输入图:', image);

const form = new FormData();
form.append('image', new Blob([fs.readFileSync(image)], { type: 'image/png' }), 'winbot-3d-tex-input.png');
form.append('overwrite', 'true');
const up = await (await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })).json();

const wf = {
  1: { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: 'hunyuan_3d_v2.1.safetensors' } },
  2: { class_type: 'LoadImage', inputs: { image: up.name } },
  13: { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['1', 1], image: ['2', 0], crop: 'center' } },
  3: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 1 } },
  6: { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['13', 0] } },
  4: { class_type: 'EmptyLatentHunyuan3Dv2', inputs: { resolution: RES, batch_size: 1 } },
  7: {
    class_type: 'KSampler',
    inputs: { seed: 20261122, steps: STEPS, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['3', 0], positive: ['6', 0], negative: ['6', 1], latent_image: ['4', 0] },
  },
  // 体素：解码出来是 VOXEL，直接给贴图烘焙用
  8: { class_type: 'VAEDecodeHunyuan3D', inputs: { samples: ['7', 0], vae: ['1', 2], num_chunks: 8000, octree_resolution: OCTREE } },
  9: { class_type: 'VoxelToMesh', inputs: { voxel: ['8', 0], algorithm: 'surface net', threshold: 0.6 } },
  // 贴图：烘焙要有 UV —— 先展 UV，再从体素颜色烘 base color，最后贴回网格
  30: { class_type: 'UnwrapMesh', inputs: { mesh: ['9', 0], segmenter: 'pec', resolution: 512, padding: 4, weld_distance: 0.001 } },
  20: { class_type: 'PaintMesh', inputs: { mesh: ['30', 0], voxel_colors: ['8', 0] } },
  23: { class_type: 'RenderUVAtlas', inputs: { mesh: ['20', 0], resolution: TEX } },
  21: { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['20', 0], base_color: ['23', 0] } },
  22: { class_type: 'SaveGLB', inputs: { mesh: ['21', 0], filename_prefix: 'winbot/tex-probe' } },
};

const t0 = Date.now();
const res = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await res.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 900));
  process.exit(1);
}
console.log('queued', q.prompt_id);
for (let i = 0; i < 300; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await (await fetch(`${BASE}/history/${q.prompt_id}`)).json();
  const e = h[q.prompt_id];
  if (!e) {
    if (i % 10 === 0) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s …`);
    continue;
  }
  if (e.status?.status_str === 'error') {
    console.log('执行失败:', JSON.stringify(e.status?.messages || {}).slice(0, 1200));
    process.exit(1);
  }
  const files = Object.values(e.outputs || {}).flatMap((o) => Object.values(o || {})).flat().filter((f) => f && f.filename);
  if (files.length) {
    console.log(`出 glb ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(files).slice(0, 300));
    process.exit(0);
  }
}
console.log('超时');
process.exit(1);

// 直接验证 Hunyuan3D 2.1：上传一张图 → 跑 3D → 出 glb。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8188';
const RES = Number(process.env.RES || 2048);
const STEPS = Number(process.env.STEPS || 20);
const OCTREE = Number(process.env.OCTREE || 256);

// 找一张现成的图
const roots = ['E:/AI_work/winbot/data/bots', 'C:/Users/Administrator/AppData/Roaming/winbot/data/bots'];
let image = null;
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const bot of fs.readdirSync(root)) {
    const dir = path.join(root, bot, 'workspace', 'outputs', 'images');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
    for (const f of files) {
      const p = path.join(dir, f);
      if (!image || fs.statSync(p).mtimeMs > fs.statSync(image).mtimeMs) image = p;
    }
  }
}
if (!image) throw new Error('没找到可用图片');
console.log('输入图:', image, `${Math.round(fs.statSync(image).size / 1024)} KB`);

// 上传到 ComfyUI 的 input 目录
const buf = fs.readFileSync(image);
const form = new FormData();
form.append('image', new Blob([buf], { type: 'image/png' }), 'winbot-3d-input.png');
form.append('overwrite', 'true');
const up = await (await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })).json();
console.log('上传:', JSON.stringify(up));
const uploaded = up.name;

const wf = {
  1: { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: 'hunyuan_3d_v2.1.safetensors' } },
  2: { class_type: 'LoadImage', inputs: { image: uploaded } },
  13: { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['1', 1], image: ['2', 0], crop: 'center' } },
  3: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 1 } },
  6: { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['13', 0] } },
  4: { class_type: 'EmptyLatentHunyuan3Dv2', inputs: { resolution: RES, batch_size: 1 } },
  7: {
    class_type: 'KSampler',
    inputs: {
      seed: 20261122,
      steps: STEPS,
      cfg: 5,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['3', 0],
      positive: ['6', 0],
      negative: ['6', 1],
      latent_image: ['4', 0],
    },
  },
  8: { class_type: 'VAEDecodeHunyuan3D', inputs: { samples: ['7', 0], vae: ['1', 2], num_chunks: 8000, octree_resolution: OCTREE } },
  9: { class_type: 'VoxelToMesh', inputs: { voxel: ['8', 0], algorithm: 'surface net', threshold: 0.6 } },
  10: { class_type: 'SaveGLB', inputs: { mesh: ['9', 0], filename_prefix: 'winbot/mesh-probe' } },
};

const t0 = Date.now();
const res = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
const q = await res.json();
if (!q.prompt_id) {
  console.log('提交失败:', JSON.stringify(q).slice(0, 900));
  process.exit(1);
}
console.log(`queued（分辨率 ${RES}，步数 ${STEPS}，octree ${OCTREE}）`);
for (let i = 0; i < 900; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await (await fetch(`${BASE}/history/${q.prompt_id}`)).json();
  const e = h[q.prompt_id];
  if (!e) {
    if (i % 15 === 0) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s …`);
    continue;
  }
  if (e.status?.status_str === 'error') {
    console.log('执行失败:', JSON.stringify(e.status?.messages || {}).slice(0, 1500));
    process.exit(1);
  }
  const outs = Object.values(e.outputs || {}).flatMap((o) => [...(o.images || []), ...(o.gifs || []), ...(o.result || [])]);
  const keys = Object.keys(e.outputs || {}).map((k) => Object.keys(e.outputs[k])).flat();
  console.log('输出 keys:', JSON.stringify(keys), JSON.stringify(outs).slice(0, 300));
  console.log(`完成 ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(0);
}
console.log('超时');
process.exit(1);

// winbot 的生成能力：接本机 ComfyUI 生图、生视频。
// 产物落在机器人工作区 outputs/ 下，同时告诉宿主，让界面直接显示。
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'winbot-media';
export const inject = ['tools'];

const HOST = process.env.WINBOT_HOST || 'http://127.0.0.1:5178';
const TOKEN = process.env.WINBOT_UI_TOKEN || '';
const BOT_ID = process.env.WINBOT_BOT_ID || '';
const WORKSPACE = process.env.WINBOT_WORKSPACE || process.cwd();
const COMFY = (process.env.WINBOT_COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const CHECKPOINT = process.env.WINBOT_COMFY_CHECKPOINT || 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors';

const textOut = (text) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_a, v) => [{ type: 'text', text: v.text }],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function comfyJson(p, init) {
  const res = await fetch(`${COMFY}${p}`, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ComfyUI ${p} -> HTTP ${res.status}`);
  return res.json();
}

async function comfyStatus() {
  try {
    const stats = await comfyJson('/system_stats');
    const info = await comfyJson('/object_info');
    const enumOf = (n, i) => info[n]?.input?.required?.[i]?.[0] || info[n]?.input?.optional?.[i]?.[0] || [];
    return {
      up: true,
      version: stats?.system?.comfyui_version || '',
      checkpoints: enumOf('CheckpointLoaderSimple', 'ckpt_name'),
      unet: enumOf('UNETLoader', 'unet_name'),
      clip: enumOf('CLIPLoader', 'clip_name'),
      vae: enumOf('VAELoader', 'vae_name').filter((v) => v !== 'pixel_space'),
      loras: enumOf('LoraLoaderModelOnly', 'lora_name'),
      videoNode: !!info.MiniMaxH3ImageToVideo,
    };
  } catch {
    return { up: false };
  }
}

async function submit(wf) {
  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf }),
  });
  const data = await res.json();
  if (!res.ok || !data.prompt_id) throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(data?.node_errors || data).slice(0, 500)}`);
  return data.prompt_id;
}

async function waitOutputs(promptId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(1000);
    const h = await comfyJson(`/history/${promptId}`).catch(() => ({}));
    const entry = h[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error(`ComfyUI 执行失败：${JSON.stringify(entry.status?.messages || {}).slice(0, 400)}`);
    const files = [];
    // 不同节点的产物 key 不一样：SaveImage=images、SaveVideo 走 images/videos、SaveGLB=3d…
    // 所以只要有 filename 就收，别写死 key。
    for (const out of Object.values(entry.outputs || {})) {
      for (const v of Object.values(out || {})) {
        const list = Array.isArray(v) ? v : [v];
        for (const f of list) {
          if (f && typeof f === 'object' && typeof f.filename === 'string') files.push(f);
        }
      }
    }
    if (files.length) return files;
    if (entry.status?.completed) return [];
  }
  throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没出结果，ComfyUI 队列可能堵着`);
}

async function pull(file, destDir, ext) {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
  const res = await fetch(`${COMFY}/view?${q}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(destDir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`;
  const abs = path.join(destDir, name);
  fs.writeFileSync(abs, bytes);
  return path.relative(WORKSPACE, abs).split(path.sep).join('/');
}

/** 开跑前告诉宿主：界面可以顺势把 ComfyUI 面板打开，让用户看着跑 */
function tellStart(kind, prompt) {
  fetch(`${HOST}/api/media/started`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, kind, prompt: String(prompt || '').slice(0, 120) }),
  }).catch(() => {});
}

function tellHost(files) {
  fetch(`${HOST}/api/media/generated`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, files }),
  }).catch(() => {});
}

/** Z-Image Turbo：8 步、cfg 1、lumina2 文本编码器，比 SDXL 快很多 */
function zimageWorkflow({ prompt, width, height, steps, seed, count }) {
  return {
    28: { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    30: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
    29: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    27: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['30', 0] } },
    33: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['27', 0] } },
    13: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: count } },
    11: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['28', 0], shift: 3 } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1,
        model: ['11', 0],
        positive: ['27', 0],
        negative: ['33', 0],
        latent_image: ['13', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['29', 0] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'winbot/zimage', images: ['8', 0] } },
  };
}

function imageWorkflow({ prompt, negative, width, height, steps, cfg, seed, count }) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: count } },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: 'winbot/image', images: ['6', 0] } },
  };
}

/** MiniMax H3：文本 → 带声音的短视频（8 步 turbo）
 *  segments > 1 时同一张图里跑多段（不同种子），用 ImageBatch 把画面接起来再编码成一条视频。
 */
function videoWorkflow({ prompt, width, height, length, fps, seed, unet, clip, videoVae, audioVae, lora, segments = 1, transition = 'chain', firstFrame = null, lastFrame = null }) {
  const n = Math.min(Math.max(Number(segments) || 1, 1), 4);
  const chain = transition !== 'cut' && n > 1;
  // 模型只接受 17k+5 帧的长度（5/22/39/56…），这里顺手夹一下，免得白跑
  const len = Math.max(5, Math.round((Number(length) - 5) / 17) * 17 + 5);
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
    4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  };
  if (lora) wf[5] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1 } };
  let modelRef = [lora ? '5' : '1', 0];
  const steps = lora ? 8 : 30;
  const nid = (i, k) => String(100 + i * 10 + k);

  // 长片段（>39 帧）且只有一段：用滑窗一次生成，天然没有接缝
  if (n === 1 && len > 39) {
    wf[6] = {
      class_type: 'MiniMaxH3ContextWindows',
      inputs: { model: modelRef, context_length: 39, context_overlap: 17, fuse_method: 'pyramid', freenoise: false, split_conds_to_windows: false },
    };
    modelRef = ['6', 0];
  }

  // 用户给的首/尾帧（已上传到 ComfyUI input）
  let guideNodes = [];
  if (firstFrame) {
    wf[900] = { class_type: 'LoadImage', inputs: { image: firstFrame } };
    guideNodes.push({ node: '900', frame: 0 });
  }
  if (lastFrame) {
    wf[901] = { class_type: 'LoadImage', inputs: { image: lastFrame } };
    guideNodes.push({ node: '901', frame: len - 1 });
  }

  for (let i = 0; i < n; i += 1) {
    const base = 100 + i * 10;
    wf[base + 0] = { class_type: 'RandomNoise', inputs: { noise_seed: seed + i * 101 } };
    wf[base + 1] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } };
    wf[base + 2] = { class_type: 'BasicScheduler', inputs: { model: modelRef, scheduler: 'simple', steps, denoise: 1 } };
    const p = chain
      ? `${prompt}${i > 0 ? ' (continuing the same shot, same scene, same light, motion carries on)' : ''}`
      : prompt;
    wf[base + 3] = { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: p, width, height, length: len } };

    // 条件：先挂用户给的首尾帧，再接上一段的末帧
    let cond = [nid(i, 3), 0];
    let guideId = 800;
    for (const g of guideNodes) {
      wf[guideId] = {
        class_type: 'MiniMaxH3AddGuide',
        inputs: { positive: cond, vae: ['3', 0], latent: [nid(i, 3), 1], image: [g.node, 0], frame_idx: g.frame },
      };
      cond = [String(guideId), 0];
      guideId += 1;
    }
    // 接续：把上一段的最后一帧锚定到这一段的第 0 帧
    if (chain && i > 0) {
      wf[300 + i] = { class_type: 'ImageFromBatch', inputs: { image: [nid(i - 1, 6), 0], batch_index: len - 1, length: 1 } };
      wf[400 + i] = {
        class_type: 'MiniMaxH3AddGuide',
        inputs: { positive: cond, vae: ['3', 0], latent: [nid(i, 3), 1], image: [String(300 + i), 0], frame_idx: 0 },
      };
      cond = [String(400 + i), 0];
    }
    wf[base + 4] = { class_type: 'BasicGuider', inputs: { model: modelRef, conditioning: cond } };
    wf[base + 5] = {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: [nid(i, 0), 0], guider: [nid(i, 4), 0], sampler: [nid(i, 1), 0], sigmas: [nid(i, 2), 0], latent_image: [nid(i, 3), 1] },
    };
    wf[base + 6] = { class_type: 'VAEDecode', inputs: { samples: [nid(i, 5), 0], vae: ['3', 0] } };
    wf[base + 7] = { class_type: 'VAEDecodeAudio', inputs: { samples: [nid(i, 5), 0], vae: ['4', 0] } };
  }

  // 画面串起来
  let images = [nid(0, 6), 0];
  for (let i = 1; i < n; i += 1) {
    wf[500 + i] = { class_type: 'ImageBatch', inputs: { image1: images, image2: [nid(i, 6), 0] } };
    images = [String(500 + i), 0];
  }
  // 声音也接起来（之前只用了最后一段的音频，会突然换声）
  let audio = [nid(0, 7), 0];
  for (let i = 1; i < n; i += 1) {
    wf[600 + i] = { class_type: 'AudioConcat', inputs: { audio1: audio, audio2: [nid(i, 7), 0], direction: 'after' } };
    audio = [String(600 + i), 0];
  }

  wf[700] = { class_type: 'CreateVideo', inputs: { images, fps, audio, bit_depth: 8, color_space: 'sRGB', chroma_subsampling: '420', codec: 'none' } };
  wf[701] = { class_type: 'SaveVideo', inputs: { video: ['700', 0], filename_prefix: 'winbot/video', format: 'mp4' } };
  return wf;
}

/** 把一张图传到 ComfyUI 的 input 目录，返回它的名字 */
async function uploadImage(bytes, filename) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), filename);
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`上传图片到 ComfyUI 失败：HTTP ${res.status}`);
  const data = await res.json();
  return data.name;
}

/** Hunyuan3D 2.1：一张图 → 一个带纹理的 glb 网格 */
function model3dWorkflow({ image, resolution, steps, octree, seed }) {
  return {
    1: { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: 'hunyuan_3d_v2.1.safetensors' } },
    2: { class_type: 'LoadImage', inputs: { image } },
    13: { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['1', 1], image: ['2', 0], crop: 'center' } },
    3: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 1 } },
    6: { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['13', 0] } },
    4: { class_type: 'EmptyLatentHunyuan3Dv2', inputs: { resolution, batch_size: 1 } },
    7: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
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
    8: { class_type: 'VAEDecodeHunyuan3D', inputs: { samples: ['7', 0], vae: ['1', 2], num_chunks: 8000, octree_resolution: octree } },
    9: { class_type: 'VoxelToMesh', inputs: { voxel: ['8', 0], algorithm: 'surface net', threshold: 0.6 } },
    10: { class_type: 'SaveGLB', inputs: { mesh: ['9', 0], filename_prefix: 'winbot/mesh' } },
  };
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'generate_image',
      description:
        'Generate an image on this machine with the local ComfyUI (SDXL). Returns files under the workspace outputs/ folder; ' +
        'the chat shows them automatically. Good for illustrations, mockups, product/room renders. ' +
        'Write the prompt in English for best results, and describe subject, style, lighting, composition.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'What to draw, in English. Be concrete about subject, style, light, framing.' },
        negative: { type: 'string', description: 'What to avoid. Defaults to a quality-oriented negative.' },
        width: { type: 'integer', description: 'Width in px, multiple of 8. Default 1024.' },
        height: { type: 'integer', description: 'Height in px, multiple of 8. Default 1024.' },
        steps: { type: 'integer', description: 'Sampling steps, default 24. More = slower and usually better.' },
        cfg: { type: 'number', description: 'Prompt strength, default 5.' },
        count: { type: 'integer', description: 'How many images, default 1 (max 4).' },
        seed: { type: 'integer', description: 'Fixed seed for reproducibility.' },
        model: {
          type: 'string',
          description: "Which image model: 'auto' (Z-Image when installed, else SDXL), 'zimage' (fast, 8 steps), 'sdxl' (checkpoint based).",
        },
      },
      output: textOut('ok'),
      async execute(args) {
        const st = await comfyStatus();
        if (!st.up) throw new Error(`本机 ComfyUI 没启动（${COMFY}）。请先启动 ComfyUI，再让我生成。`);
        const want = String(args.model || 'auto').toLowerCase();
        const zReady = st.unet.includes('z_image_turbo_bf16.safetensors') && st.clip.includes('qwen_3_4b.safetensors') && st.vae.includes('ae.safetensors');
        const useZ = zReady && want !== 'sdxl';
        if (want === 'zimage' && !zReady) throw new Error('Z-Image Turbo 的模型还没装齐（需要 unet z_image_turbo_bf16、text_encoder qwen_3_4b、vae ae.safetensors）。');
        const checkpoint = st.checkpoints.includes(CHECKPOINT) ? CHECKPOINT : st.checkpoints[0];
        if (!useZ && !checkpoint) throw new Error('ComfyUI 里没有可用的 checkpoint。');
        const count = Math.min(Math.max(Number(args.count) || 1, 1), 4);
        const width = Math.round((Number(args.width) || 1024) / 8) * 8;
        const height = Math.round((Number(args.height) || 1024) / 8) * 8;
        const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : Math.floor(Math.random() * 1e9);
        const wf = useZ
          ? zimageWorkflow({ prompt: String(args.prompt || '').trim(), width, height, steps: Math.min(Math.max(Number(args.steps) || 8, 4), 30), seed, count })
          : imageWorkflow({
              prompt: String(args.prompt || '').trim(),
              negative: String(args.negative || 'blurry, low quality, jpeg artifacts, watermark, text, extra fingers').trim(),
              width,
              height,
              steps: Math.min(Math.max(Number(args.steps) || 24, 4), 60),
              cfg: Math.min(Math.max(Number(args.cfg) || 5, 1), 15),
              seed,
              count,
            });
        if (!useZ) wf[1].inputs.ckpt_name = checkpoint;
        tellStart('image', args.prompt);
        const id = await submit(wf);
        const outs = await waitOutputs(id, 240_000);
        const files = [];
        for (const f of outs) {
          const rel = await pull(f, path.join(WORKSPACE, 'outputs', 'images'), '.png');
          files.push({ path: rel, description: String(args.prompt || '').slice(0, 60), kind: 'image' });
        }
        if (!files.length) throw new Error('ComfyUI 跑完了但没有产出图片。');
        tellHost(files);
        return {
          text: `画好了 ${files.length} 张（${useZ ? 'Z-Image Turbo' : checkpoint}）：\n${files.map((f) => `- ${f.path}`).join('\n')}\n\n界面上会直接显示。要换风格/尺寸/种子，跟我说。`,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'generate_video',
      description:
        'Generate a short video (a few seconds, with audio) on this machine using the local MiniMax H3 model in ComfyUI. ' +
        'Requires the video weights to be installed; if they are missing you will get a list of files to install. ' +
        'Describe motion, camera move and sound in the prompt.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Shot description in English: subject, motion, camera, lighting, sound.' },
        width: { type: 'integer', description: 'Default 512.' },
        height: { type: 'integer', description: 'Default 512.' },
        length: { type: 'integer', description: 'Frames per segment, default 39 (~1.6s at 24fps). 90+ frames in one segment switches to context windows (one continuous shot, no seam).' },
        segments: { type: 'integer', description: 'How many segments to generate and join (1-4). Each adds ~2 minutes.' },
        first_frame: { type: 'string', description: 'Optional workspace-relative image used as the very first frame.' },
        last_frame: { type: 'string', description: 'Optional workspace-relative image to steer the final frame (first/last-frame conditioning).' },
        transition: {
          type: 'string',
          description: "chain (default): each segment starts from the previous one's last frame, so motion continues. cut: independent segments with a hard cut.",
        },
        fps: { type: 'number', description: 'Default 24.' },
        seed: { type: 'integer' },
      },
      output: textOut('ok'),
      async execute(args) {
        const st = await comfyStatus();
        if (!st.up) throw new Error(`本机 ComfyUI 没启动（${COMFY}）。请先启动 ComfyUI。`);
        // 模型名有 int8 / fp16 几个变体，按关键片段匹配，别写死全名
        const pick = (list, parts) => list.find((x) => parts.every((p) => x.toLowerCase().includes(p))) || null;
        const unet = pick(st.unet, ['minimax', 'fl2va']);
        const clip = pick(st.clip, ['minimax']) || pick(st.clip, ['qwen3vl']);
        const videoVae = pick(st.vae, ['minimax', 'video_vae']);
        const audioVae = pick(st.vae, ['minimax', 'audio_vae']);
        // 8 步 turbo 靠这个 LoRA，缺了就退化成 30 步
        const lora = (st.loras || []).find((x) => x.includes('minimax') && x.includes('turbo')) || null;
        if (!st.videoNode || !unet || !clip || !videoVae || !audioVae) {
          const missing = [];
          if (!unet) missing.push('models/diffusion_models/minimax_h3_fl2va_*.safetensors（int8 或 fp16 都行）');
          if (!clip) missing.push('models/text_encoders/qwen3vl_32b_minimax_h3_*.safetensors');
          if (!videoVae) missing.push('models/vae/minimax_h3_video_vae_*.safetensors');
          if (!audioVae) missing.push('models/vae/minimax_h3_audio_vae_*.safetensors');
          throw new Error(
            `视频模型没装齐，还缺：\n${missing.map((m) => `- ${m}`).join('\n')}\n` +
              `放进 ComfyUI 的对应目录后我就能直接生视频。\n` +
              `现在能用的：生图（Z-Image Turbo / SDXL）。`,
          );
        }
        // 首/尾帧：读工作区里的图 → 上传到 ComfyUI input → 交给 workflow 做锚定
        const uploadIfGiven = async (rel, tag) => {
          if (!rel) return null;
          const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
          const abs = path.join(WORKSPACE, clean);
          if (!fs.existsSync(abs)) throw new Error(`工作区里没有这张图：${clean}`);
          return uploadImage(fs.readFileSync(abs), `winbot-video-${tag}.png`);
        };
        const firstFrame = await uploadIfGiven(args.first_frame, 'first');
        const lastFrame = await uploadIfGiven(args.last_frame, 'last');

        const wf = videoWorkflow({
          prompt: String(args.prompt || '').trim(),
          width: Math.round((Number(args.width) || 512) / 64) * 64,
          height: Math.round((Number(args.height) || 512) / 64) * 64,
          length: Math.min(Math.max(Number(args.length) || 39, 9), 121),
          segments: Math.min(Math.max(Number(args.segments) || 1, 1), 4),
          transition: String(args.transition || 'chain'),
          firstFrame,
          lastFrame,
          fps: Number(args.fps) || 24,
          seed: Number.isFinite(Number(args.seed)) ? Number(args.seed) : Math.floor(Math.random() * 1e9),
          unet,
          clip,
          videoVae,
          audioVae,
          lora,
        });
        tellStart('video', args.prompt);
        const id = await submit(wf);
        const outs = await waitOutputs(id, 900_000 * Math.min(Math.max(Number(args.segments) || 1, 1), 4));
        const files = [];
        for (const f of outs) {
          const rel = await pull(f, path.join(WORKSPACE, 'outputs', 'videos'), '.mp4');
          files.push({ path: rel, description: String(args.prompt || '').slice(0, 60), kind: 'video' });
        }
        if (!files.length) throw new Error('ComfyUI 跑完了但没有产出视频。');
        tellHost(files);
        return { text: `视频生成好了：\n${files.map((f) => `- ${f.path}`).join('\n')}\n\n界面上会直接播放。` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'generate_3d',
      description:
        'Turn a picture into a 3D mesh (geometry only, no texture) on this machine using Hunyuan3D 2.1 in ComfyUI, and save a .glb into the workspace. ' +
        'If you pass `image` (a workspace path) it uses that picture; otherwise it draws the picture first from `prompt` and then turns it into 3D. ' +
        'Takes 1-3 minutes. Use it when the user wants a 3D model, a game asset, or something to open in a 3D viewer.',
      parameters: {
        prompt: { type: 'string', description: 'What the object is (English). Ignored when `image` is given.' },
        image: { type: 'string', description: 'Workspace-relative image path to convert (e.g. outputs/images/xxx.png).' },
        resolution: { type: 'integer', description: 'Mesh resolution, default 3072 (2048 is faster, 4096 needs more VRAM).' },
        steps: { type: 'integer', description: 'Sampling steps, default 25.' },
        octree: { type: 'integer', description: 'Marching-cubes octree resolution: 192 / 256 / 320. Higher = finer.' },
        seed: { type: 'integer' },
      },
      output: textOut('ok'),
      async execute(args) {
        const st = await comfyStatus();
        if (!st.up) throw new Error(`本机 ComfyUI 没启动（${COMFY}）。请先启动 ComfyUI。`);
        if (!st.checkpoints.includes('hunyuan_3d_v2.1.safetensors')) {
          throw new Error('Hunyuan3D 2.1 的权重不在：models/checkpoints/hunyuan_3d_v2.1.safetensors（约 6.86 GB）。');
        }
        const resolution = Math.min(Math.max(Number(args.resolution) || 3072, 1024), 4096);
        const steps = Math.min(Math.max(Number(args.steps) || 25, 8), 40);
        const octree = Math.min(Math.max(Number(args.octree) || 256, 96), 320);
        const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 20261122;
        tellStart('model', args.prompt || args.image);

        // 1) 准备一张图：直接用给的，或者先画一张
        let bytes;
        let source = '';
        if (args.image) {
          const rel = String(args.image).replace(/\\/g, '/').replace(/^\/+/, '');
          const abs = path.join(WORKSPACE, rel);
          if (!fs.existsSync(abs)) throw new Error(`工作区里没有这张图：${rel}`);
          bytes = fs.readFileSync(abs);
          source = rel;
        } else {
          const prompt = String(args.prompt || '').trim();
          if (!prompt) throw new Error('要么给 prompt，要么给 image。');
          const id = await submit(zimageWorkflow({ prompt, width: 1024, height: 1024, steps: 8, seed: Math.floor(Math.random() * 1e9), count: 1 }));
          const outs = await waitOutputs(id, 240_000);
          if (!outs.length) throw new Error('先用 Z-Image 画底图失败。');
          const view = await fetch(`${COMFY}/view?${new URLSearchParams({ filename: outs[0].filename, subfolder: outs[0].subfolder || '', type: outs[0].type || 'output' })}`);
          bytes = Buffer.from(await view.arrayBuffer());
          const imgDir = path.join(WORKSPACE, 'outputs', 'images');
          fs.mkdirSync(imgDir, { recursive: true });
          const imgName = `${Date.now()}-3d-source.png`;
          fs.writeFileSync(path.join(imgDir, imgName), bytes);
          source = `outputs/images/${imgName}`;
          // 画图模型（Z-Image）先放掉，给 8G 显存腾地方，否则 Hunyuan3D 会一直换页、慢到离谱
          await fetch(`${COMFY}/free`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
          }).catch(() => {});
        }

        // 2) 上传到 ComfyUI，跑 Hunyuan3D
        const uploaded = await uploadImage(bytes, 'winbot-3d-input.png');
        const id3 = await submit(model3dWorkflow({ image: uploaded, resolution, steps, octree, seed }));
        const outs3 = await waitOutputs(id3, 900_000);
        const glbs = outs3.filter((f) => /\.(glb|gltf)$/i.test(f.filename));
        if (!glbs.length) throw new Error('3D 跑完了但没有产出 glb。');
        const rel = await pull(glbs[0], path.join(WORKSPACE, 'outputs', 'models'), '.glb');
        const files = [{ path: rel, description: String(args.prompt || source).slice(0, 60), kind: 'model' }];
        tellHost(files);
        return {
          text: `3D 模型好了：${rel}\n（底图：${source}；分辨率 ${resolution}，步数 ${steps}，octree ${octree}）\n用系统 3D 查看器或 Blender 打开这个 glb 就能看。`,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'media_status',
      description: 'Check whether local image/video generation is available and which models are installed.',
      parameters: {},
      output: textOut('ok'),
      async execute() {
        const st = await comfyStatus();
        if (!st.up) return { text: `ComfyUI 没在跑（${COMFY}），生图生视频都用不了。` };
        const zReady = st.unet.includes('z_image_turbo_bf16.safetensors') && st.clip.includes('qwen_3_4b.safetensors') && st.vae.includes('ae.safetensors');
        const hReady = st.checkpoints.includes('hunyuan_3d_v2.1.safetensors');
        const lines = [
          `ComfyUI ${st.version} 在线（${COMFY}）`,
          `生图：可用（${zReady ? 'Z-Image Turbo + ' : ''}SDXL ${st.checkpoints.length} 个 checkpoint）`,
          `视频：${st.videoNode && st.unet.some((x) => x.includes('minimax')) ? 'MiniMax H3 已就绪' : '缺模型'}`,
          `3D：${hReady ? 'Hunyuan3D 2.1 已就绪' : '缺 hunyuan_3d_v2.1.safetensors'}`,
        ];
        if (st.unet.length) lines.push(`unet：${st.unet.slice(0, 3).join('、')}`);
        if (st.clip.length) lines.push(`文本编码器：${st.clip.slice(0, 3).join('、')}`);
        return { text: lines.join('\n') };
      },
    }),
  );
}









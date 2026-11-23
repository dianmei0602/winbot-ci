// 查 ComfyUI 能力：视频节点在不在、各 loader 里有哪些模型。
const BASE = 'http://127.0.0.1:8188';
const info = await (await fetch(`${BASE}/object_info`)).json();
const has = (n) => !!info[n];
console.log('MiniMaxH3ImageToVideo:', has('MiniMaxH3ImageToVideo'));
console.log('SaveVideo:', has('SaveVideo'), 'CreateVideo:', has('CreateVideo'), 'VAEDecodeAudio:', has('VAEDecodeAudio'));
console.log('UNETLoader:', has('UNETLoader'), 'CLIPLoader:', has('CLIPLoader'));
const enumOf = (node, input) => info[node]?.input?.required?.[input]?.[0] ?? info[node]?.input?.optional?.[input]?.[0];
console.log('checkpoints:', JSON.stringify(enumOf('CheckpointLoaderSimple', 'ckpt_name')));
console.log('unet:', JSON.stringify(enumOf('UNETLoader', 'unet_name')));
console.log('clip:', JSON.stringify(enumOf('CLIPLoader', 'clip_name')));
console.log('vae:', JSON.stringify(enumOf('VAELoader', 'vae_name')));
console.log('clip type enum:', JSON.stringify(info.CLIPLoader?.input?.required?.type?.[0]?.slice?.(0, 12)));
console.log('SaveVideo inputs:', JSON.stringify(info.SaveVideo?.input?.required));

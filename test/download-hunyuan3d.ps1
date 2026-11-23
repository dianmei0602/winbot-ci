# 下载 Hunyuan3D 2.1（ComfyUI 打包版，单文件含 DiT + CLIP vision + VAE）
$ErrorActionPreference = 'Continue'
$env:HTTP_PROXY = 'http://127.0.0.1:12450'
$env:HTTPS_PROXY = 'http://127.0.0.1:12450'
$dest = 'E:\AI_work\AI_codex\tools\ComfyUI\models\checkpoints\hunyuan_3d_v2.1.safetensors'
$url = 'https://huggingface.co/Comfy-Org/Hunyuan-3D-2.1/resolve/main/hunyuan_3d_v2.1.safetensors'
$dir = Split-Path $dest -Parent
New-Item -ItemType Directory -Force -Path $dir | Out-Null
for ($try = 1; $try -le 8; $try++) {
  $before = if (Test-Path $dest) { (Get-Item $dest).Length } else { 0 }
  Write-Output ("[try " + $try + "] 已有 " + [math]::Round($before/1MB) + " MB  " + (Get-Date -Format "HH:mm:ss"))
  & curl.exe -sS -L --fail --retry 5 --retry-delay 3 --retry-all-errors -C - --connect-timeout 30 --speed-time 60 --speed-limit 10240 -o $dest $url
  $code = $LASTEXITCODE
  $now = if (Test-Path $dest) { (Get-Item $dest).Length } else { 0 }
  Write-Output ("[try " + $try + "] exit=" + $code + " 现在 " + [math]::Round($now/1GB, 2) + " GB")
  if ($code -eq 0 -and $now -gt 6GB) { break }
  Start-Sleep -Seconds 5
}
if (Test-Path $dest) { Write-Output ("[done] " + [math]::Round((Get-Item $dest).Length/1GB, 2) + " GB") }
Write-Output 'DONE'

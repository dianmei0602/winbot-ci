# 下载 Z-Image Turbo 需要的模型（走本机代理，支持断点续传）。
$ErrorActionPreference = 'Continue'
$env:HTTP_PROXY = 'http://127.0.0.1:12450'
$env:HTTPS_PROXY = 'http://127.0.0.1:12450'
$root = 'E:\AI_work\AI_codex\tools\ComfyUI\models'
$repo = 'https://huggingface.co/Comfy-Org/Z-Image-Turbo/resolve/main/split_files'
$jobs = @(
  @{ url = "$repo/diffusion_models/z_image_turbo_bf16.safetensors"; dest = Join-Path $root 'diffusion_models\z_image_turbo_bf16.safetensors' },
  @{ url = "$repo/text_encoders/qwen_3_4b.safetensors";        dest = Join-Path $root 'text_encoders\qwen_3_4b.safetensors' },
  @{ url = "$repo/vae/ae.safetensors";                         dest = Join-Path $root 'vae\ae.safetensors' }
)
foreach ($j in $jobs) {
  $dir = Split-Path $j.dest -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $size = if (Test-Path $j.dest) { (Get-Item $j.dest).Length } else { 0 }
  Write-Output ("[start] " + (Split-Path $j.dest -Leaf) + " 已有 " + [math]::Round($size/1MB) + " MB")
  for ($try = 1; $try -le 8; $try++) {
    & curl.exe -sS -L --fail --retry 5 --retry-delay 3 --retry-all-errors -C - --connect-timeout 30 --speed-time 60 --speed-limit 10240 -o $j.dest $j.url
    $code = $LASTEXITCODE
    $now = if (Test-Path $j.dest) { (Get-Item $j.dest).Length } else { 0 }
    Write-Output ("[try " + $try + "] exit=" + $code + " 现在 " + [math]::Round($now/1MB) + " MB")
    if ($code -eq 0 -and $now -gt 100MB) { break }
    Start-Sleep -Seconds 5
  }
  if (Test-Path $j.dest) {
    Write-Output ("[done] " + (Split-Path $j.dest -Leaf) + " " + [math]::Round((Get-Item $j.dest).Length/1GB, 2) + " GB")
  }
}
Write-Output 'ALL FINISHED'

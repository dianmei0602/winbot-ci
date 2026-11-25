# 把托盘启动器编译成 winbot.exe（用系统自带 .NET Framework 的 csc.exe，不装任何东西）
# 用法: powershell -ExecutionPolicy Bypass -File launcher\build.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw '找不到 csc.exe（需要 .NET Framework 4）' }

$ico = Join-Path $root 'launcher\winbot.ico'
if (-not (Test-Path $ico)) {
  Write-Host '生成图标…'
  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::FromArgb(15, 17, 21))
  $accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(215, 255, 0))
  # 两只竖胶囊眼 + 一个点，和界面 logo 一致
  $g.FillEllipse($accent, 58, 74, 40, 104)
  $g.FillEllipse($accent, 158, 74, 40, 104)
  $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, 168, 254))
  $g.FillEllipse($dot, 116, 198, 24, 24)
  $g.Dispose()
  $png = Join-Path $env:TEMP ('winbot-icon-' + [guid]::NewGuid().ToString('N') + '.png')
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $pngBytes = [System.IO.File]::ReadAllBytes($png)
  # 写成 ICO（PNG 压缩格式，Vista 以上都认）
  $fs = [System.IO.File]::Create($ico)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)      # 头：保留/类型/数量
  $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)  # 256 宽高、无色板、保留
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)                          # 平面/位深
  $bw.Write([UInt32]$pngBytes.Length)
  $bw.Write([UInt32]22)                                                # 数据偏移
  $bw.Write($pngBytes)
  $bw.Close(); $fs.Close()
  Remove-Item $png -Force
  Write-Host "图标已生成: $ico"
}

$out = Join-Path $root 'winbot.exe'
$cs = Join-Path $root 'launcher\WinbotTray.cs'
Write-Host "编译 $cs → $out"
& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
  "/out:$out" `
  "/resource:$ico,winbot.ico" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Core.dll `
  $cs
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }
Get-Item $out | Select-Object FullName, Length, LastWriteTime

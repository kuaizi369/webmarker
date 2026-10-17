# 背景图片同步脚本（零绝对路径，铁律 4）
# 用法：在项目任意位置运行  powershell -ExecutionPolicy Bypass -File "<本项目>\extension\tools\sync-backgrounds.ps1"
# 功能：把项目根「背景图片」文件夹内的图片复制到 extension\backgrounds\，
#       并自动更新 newtab.js 的 BGM_LIST 文件名列表（随机换背景用）。
# 之后想换背景：把图片放进「背景图片」文件夹 → 运行本脚本 → 重载扩展即可。

$ErrorActionPreference = "Stop"

# —— 路径全部由 $PSScriptRoot 相对推导，不写死盘符 ——
$extDir = Split-Path $PSScriptRoot -Parent      # extension\
$root   = Split-Path $extDir -Parent            # 项目根
$srcDir = Join-Path $root "背景图片"
$destDir = Join-Path $extDir "backgrounds"
$newtabJs = Join-Path $extDir "newtab.js"

# ① 源目录校验
if (-not (Test-Path $srcDir -PathType Container)) {
  throw "源目录不存在: $srcDir（请在项目根创建「背景图片」文件夹并放入图片）"
}

# ② 目标目录安全校验
$destFull = [IO.Path]::GetFullPath($destDir)
if ([string]::IsNullOrWhiteSpace($destFull)) { throw "目标路径为空" }
if ($destFull -eq [IO.Path]::GetPathRoot($destFull)) { throw "目标为盘符根目录，拒绝" }
if (-not $destFull.StartsWith([IO.Path]::GetFullPath($extDir), [StringComparison]::OrdinalIgnoreCase)) {
  throw "目标超出预期范围: $destFull"
}

# ③ 复制图片（仅常见图片格式，忽略缩略图/隐藏文件）
$files = Get-ChildItem $srcDir -File | Where-Object {
  $_.Extension -match '^\.(jpg|jpeg|png|webp|gif|bmp)$' -and -not $_.Name.StartsWith(".")
}
if ($files.Count -eq 0) { throw "「背景图片」文件夹中没有可用的图片（支持 jpg/png/webp/gif/bmp）" }

New-Item -ItemType Directory -Force -Path $destFull | Out-Null
Copy-Item -Path $files.FullName -Destination $destFull -Force

# ④ 更新 newtab.js 的 BGM_LIST（按文件名排序，保持稳定）
$names = @(Get-ChildItem $destFull -File | Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|webp|gif|bmp)$' } |
  Select-Object -ExpandProperty Name | Sort-Object)
$listJson = "[" + (($names | ForEach-Object { '"' + $_ + '"' }) -join ", ") + "]"

$content = [IO.File]::ReadAllText($newtabJs)   # 保留原有编码/换行
$pattern = '(BGM_LIST\s*=\s*)\[[^\]]*\]'
if ($content -notmatch $pattern) { throw "newtab.js 中未找到 BGM_LIST 常量，请检查文件" }
$updated = [regex]::Replace($content, $pattern, ('$1' + $listJson), 1)
[IO.File]::WriteAllText($newtabJs, $updated)

Write-Host "同步完成：共 $($names.Count) 张背景图 -> extension\backgrounds\"
Write-Host "BGM_LIST 已更新：$listJson"
Write-Host "请重新加载扩展（edge://extensions 点击扩展的刷新按钮）后生效。"

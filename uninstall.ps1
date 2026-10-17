# ==================================================================
# uninstall.ps1  —  WebAnnotator 一键卸载脚本
#
# 作用：移除 Native Messaging Host 的注册（注册表 + host manifest + 部署的 exe）。
# 重要：数据目录 WebAnnotatorData 不会被删除，换电脑后可原样拷贝复用。
#       extension 目录（浏览器扩展本体）也不会被改动。
#
# 用法：在 PowerShell 中执行  .\uninstall.ps1
#       （若注册过系统级 HKLM，则需要以管理员身份运行）
# ==================================================================

$ErrorActionPreference = "Continue"

$HostName = "com.codearts.webannotator"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$localAppDataDir = Join-Path $env:LOCALAPPDATA "WebAnnotator"

function Write-Ok([string]$m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

Write-Host ""
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host "  WebAnnotator 一键卸载脚本" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host ""

$removedManifests = @()

# 1. 先记录注册表指向的 manifest 路径（卸载前，便于一并清理）
$regPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKLM:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKLM:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKLM:\Software\WOW6432Node\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKLM:\Software\WOW6432Node\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        try {
            $val = (Get-ItemProperty $rp -Name "(default)" -ErrorAction Stop)."(default)"
            if ($val) { $removedManifests += $val }
        } catch {}
    }
}

# 2. 删除注册表键
foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        Remove-Item $rp -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $rp)) { Write-Ok "已删除注册表键: $rp" }
    }
}

# 3. 删除 host manifest 文件（注册表指向的 + 项目根 + 旧的 %LOCALAPPDATA%）
$removedManifests += (Join-Path $scriptDir "com.codearts.webannotator.json")
$removedManifests += (Join-Path $localAppDataDir "com.codearts.webannotator.json")
$seen = @{}
foreach ($m in ($removedManifests | Select-Object -Unique)) {
    if ($m -and (Test-Path $m) -and -not $seen.ContainsKey($m)) {
        $seen[$m] = $true
        Remove-Item $m -Force -ErrorAction SilentlyContinue
        Write-Ok "已删除 manifest: $m"
    }
}

# 4. 删除部署的本地程序 exe（项目根 + 旧的 %LOCALAPPDATA%）
foreach ($exe in @(
        #(Join-Path $scriptDir "WebAnnotatorHost.exe"),
        (Join-Path $localAppDataDir "WebAnnotatorHost.exe")
    )) {
    if (Test-Path $exe) {
        Remove-Item $exe -Force -ErrorAction SilentlyContinue
        Write-Ok "已删除本地程序: $exe"
    }
}

# 5. 数据目录保留（明确提示，不删除）
$dataDir = Join-Path $scriptDir "WebAnnotatorData"
Write-Host ""
Write-Warn "数据目录已保留（未删除）：$dataDir"
if (Test-Path $dataDir) {
    $db = Join-Path $dataDir "webannotator.db"
    if (Test-Path $db) {
        Write-Ok "数据库存在：$db"
    } else {
        Write-Warn "未找到 webannotator.db（可能尚未产生数据）。"
    }
}

Write-Host ""
Write-Ok "卸载完成。浏览器扩展本体（extension 目录）未改动，可自行移除。"
Write-Host "换电脑后：把整个 WebAnnotator 文件夹拷贝过去，运行 native-host\auto-register.ps1 即可继续使用原有数据。" -ForegroundColor Cyan
pause

# ==================================================================
# uninstall.ps1  —  页签 WebMarker 一键卸载脚本
#
# 作用：移除 Native Messaging Host 的注册（注册表键 + host manifest 清单）。
# 重要：数据目录 WebAnnotatorData 不会被删除，换电脑后可原样拷贝复用。
#       extension 目录（浏览器扩展本体）与项目根的 WebAnnotatorHost.exe
#       均保留不删（exe 保留便于之后重跑 auto-register.ps1 快速重装），
#       仅清理旧版安装在 %LOCALAPPDATA%\WebAnnotator 的 exe。
#
# 用法：在 PowerShell 中执行  .\uninstall.ps1
#       默认流程：① 自动从已加载该扩展的浏览器（Chrome / Edge，含多 Profile）中移除扩展
#                 ② 清理 Native Messaging 注册（注册表键 + host manifest）
#       加 -KeepExtension 参数：跳过浏览器扩展移除，仅清理注册。
#       （若注册过系统级 HKLM，则需要以管理员身份运行，否则仅清理 HKCU）
# ==================================================================

param(
    # 保留浏览器中的扩展（默认自动从浏览器移除扩展后再清理注册）
    [switch]$KeepExtension
)

$ErrorActionPreference = "Continue"

$HostName = "com.codearts.webannotator"
$scriptDir = $PSScriptRoot
$localAppDataDir = Join-Path $env:LOCALAPPDATA "WebAnnotator"

function Write-Ok([string]$m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

Write-Host ""
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host "  页签 WebMarker 一键卸载脚本" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host ""

# ==================================================================
# 步骤 0：从浏览器中移除扩展（默认执行；-KeepExtension 跳过）
# 原理：脚本按 Profile 打开扩展自己的 options.html#uninstall 页面，
#       由扩展调用 chrome.management.uninstallSelf 完成自移除。
#       顺序上先移扩展后清注册，避免出现"扩展还在但 host 已删"的报错窗口期。
# ==================================================================
$EXT_KEYWORDS = @("WebAnnotator", "WebMarker", "页签")

function Get-BrowserExe {
    param([string]$BrowserName)
    $cands = @()
    if ($BrowserName -eq "Chrome") {
        $cands = @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
        )
    } else {
        $cands = @(
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
        )
    }
    foreach ($c in $cands) { if (Test-Path $c) { return $c } }
    return $null
}

# 扫描浏览器各 Profile 的 Preferences / Secure Preferences，
# 返回【已加载】的本扩展记录（判定规则与 auto-register.ps1 一致：
# 跳过空墓碑条目；条目含关键词，或其 path 下 manifest.json 含关键词）
function Find-LoadedExtensions {
    param([string]$BrowserName, [string]$BaseDir)
    $result = @()
    $seen = @{}
    if (-not (Test-Path $BaseDir)) { return $result }
    $profiles = @("Default") + @(
        Get-ChildItem $BaseDir -Directory -Filter "Profile*" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name
    )
    foreach ($profile in $profiles) {
        foreach ($f in @("Preferences", "Secure Preferences")) {
            $pf = Join-Path $BaseDir "$profile\$f"
            if (-not (Test-Path $pf)) { continue }
            $json = $null
            try { $json = [System.IO.File]::ReadAllText($pf) | ConvertFrom-Json } catch { continue }
            if ($null -eq $json -or $null -eq $json.extensions -or $null -eq $json.extensions.settings) { continue }
            foreach ($p in $json.extensions.settings.PSObject.Properties) {
                $entry = $p.Value
                if ($null -eq $entry -or $entry.PSObject.Properties.Count -eq 0) { continue }
                $key = "$BrowserName|$profile|$($p.Name)"
                if ($seen.ContainsKey($key)) { continue }
                $serialized = ($entry | ConvertTo-Json -Depth 10 -Compress)
                $isWA = $false
                foreach ($kw in $EXT_KEYWORDS) {
                    if ($serialized -match [regex]::Escape($kw)) { $isWA = $true; break }
                }
                if (-not $isWA -and $entry.path -and (Test-Path $entry.path)) {
                    $mf = Join-Path $entry.path "manifest.json"
                    if (Test-Path $mf) {
                        try {
                            $mfText = [System.IO.File]::ReadAllText($mf)
                            foreach ($kw in $EXT_KEYWORDS) {
                                if ($mfText.Contains($kw)) { $isWA = $true; break }
                            }
                        } catch {}
                    }
                }
                if ($isWA) {
                    $seen[$key] = $true
                    $result += @{ Browser = $BrowserName; Profile = $profile; Id = $p.Name; Path = $entry.path }
                }
            }
        }
    }
    return $result
}

Write-Host "步骤 1：从浏览器移除扩展" -ForegroundColor Cyan
if ($KeepExtension) {
    Write-Info "已指定 -KeepExtension：跳过浏览器扩展移除，仅清理注册。"
} else {
    $all = @()
    foreach ($b in @(
        @{ N = "Chrome"; Base = "$env:LOCALAPPDATA\Google\Chrome\User Data" },
        @{ N = "Edge";   Base = "$env:LOCALAPPDATA\Microsoft\Edge\User Data" }
    )) {
        $exe = Get-BrowserExe $b.N
        if (-not $exe) { Write-Warn "未找到 $($b.N) 主程序，跳过该浏览器。"; continue }
        $all += Find-LoadedExtensions -BrowserName $b.N -BaseDir $b.Base
    }
    if (@($all).Count -eq 0) {
        Write-Info "浏览器中未检测到已加载的页签扩展（可能已移除）。"
    } else {
        foreach ($ext in $all) {
            Write-Host ("  [{0} · {1}] 请求移除扩展 {2}" -f $ext.Browser, $ext.Profile, $ext.Id)
            $exe = Get-BrowserExe $ext.Browser
            $url = "chrome-extension://" + $ext.Id + "/options.html#uninstall"
            try {
                Start-Process -FilePath $exe -ArgumentList (('--profile-directory="{0}"' -f $ext.Profile), $url) | Out-Null
            } catch {
                Write-Warn ("  打开浏览器失败，请手动移除: " + $_.Exception.Message)
            }
        }
        Write-Info "已请求浏览器移除扩展，等待执行（5 秒）…"
        Start-Sleep -Seconds 5
        Write-Info "若个别浏览器仍残留扩展，请到其扩展管理页手动移除。"
    }
}
Write-Host ""

$removedManifests = @()

# 2. 先记录注册表指向的 manifest 路径（卸载前，便于一并清理）
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

# 3. 删除注册表键（HKLM 删除失败通常因权限不足，需管理员身份运行）
foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        Remove-Item $rp -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $rp)) {
            Write-Ok "已删除注册表键: $rp"
        } else {
            Write-Warn "注册表键删除失败（通常需管理员权限）: $rp"
        }
    }
}

# 4. 删除 host manifest 文件（注册表指向的 + 项目根 + 旧的 %LOCALAPPDATA%）
$removedManifests += (Join-Path $scriptDir "com.codearts.webannotator.json")
$removedManifests += (Join-Path $localAppDataDir "com.codearts.webannotator.json")
$seen = @{}
foreach ($m in ($removedManifests | Select-Object -Unique)) {
    if ($m -and (Test-Path $m) -and -not $seen.ContainsKey($m)) {
        $seen[$m] = $true
        Remove-Item $m -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $m)) {
            Write-Ok "已删除 manifest: $m"
        } else {
            Write-Warn "manifest 删除失败（可能被占用或无权限，可手动删除）: $m"
        }
    }
}

# 5. 删除部署的本地程序 exe（项目根 + 旧的 %LOCALAPPDATA%）
foreach ($exe in @(
        #(Join-Path $scriptDir "WebAnnotatorHost.exe"),
        (Join-Path $localAppDataDir "WebAnnotatorHost.exe")
    )) {
    if (Test-Path $exe) {
        Remove-Item $exe -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $exe)) {
            Write-Ok "已删除本地程序: $exe"
        } else {
            Write-Warn "本地程序删除失败（可能被占用或无权限，可手动删除）: $exe"
        }
    }
}

# 6. 数据目录保留（明确提示，不删除）
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
Write-Ok "卸载完成。extension 目录文件未改动（可随项目整体删除）。"
if ($KeepExtension) {
    Write-Host "浏览器中的扩展已按 -KeepExtension 保留。" -ForegroundColor Cyan
}
Write-Host "换电脑后：把整个 WebMarker 文件夹拷贝过去，运行 native-host\auto-register.ps1 即可继续使用原有数据。" -ForegroundColor Cyan
pause

# ==================================================================
# auto-register.ps1
#
# 用途：在浏览器"加载已解压的扩展程序"之后，自动检测 WebAnnotator / 页签(WebMarker)
#       扩展的真实 ID，并注册 Native Messaging Host（写清单 + 写注册表）。
#
# 注册逻辑：扫描主流浏览器（Edge / Chrome），在哪个浏览器找到已加载的扩展 ID，
#           就注册哪个浏览器；未找到的浏览器直接跳过；相同 ID 只注册一次。
#
# 用法：
#   .\auto-register.ps1                 # 自动检测 Edge / Chrome 中的扩展，找到哪个注册哪个
#   .\auto-register.ps1 -EdgeId xxx     # 手动指定 Edge 扩展 ID（覆盖自动检测）
#   .\auto-register.ps1 -ChromeId xxx   # 手动指定 Chrome 扩展 ID
#   .\auto-register.ps1 -System         # 注册到系统级（HKLM，需管理员）
#
# 说明：扩展 ID 由加载路径决定，卸载后重新加载同一目录 ID 不变；
#       换目录加载会得到新 ID，重跑本脚本即可。
# ==================================================================

[CmdletBinding()]
param(
    [string]$EdgeId,
    [string]$ChromeId,
    [switch]$System
)

$ErrorActionPreference = "Stop"

# 扩展在 Preferences 中出现的识别名（manifest.json 的 name 字段）。
# 项目已更名"页签 WebMarker"；旧名 WebAnnotator 仍需识别（已加载但未重新加载的旧记录），故用多关键词数组匹配。
$EXT_KEYWORDS = @("WebAnnotator", "WebMarker", "页签")

# ==================================================================
# 从浏览器配置文件中提取【已加载】的 WebAnnotator 扩展 ID（返回字符串数组）
#
# 权威来源：extensions.settings
#   - Edge 155+ 存放在 Secure Preferences，Chrome 存放在 Preferences
#   - 脚本对两个文件都检查
#
# 判定规则（本次修复的核心）：
#   1. 条目必须【非空】——空对象 {} 是扩展卸载后留下的墓碑记录，
#      表示该扩展当前【未加载】，绝不能用来注册
#   2. 非空条目的内容必须包含 WebAnnotator（manifest 名），或其 path
#      目录下的 manifest.json 是 WebAnnotator
# 不再信任 safebrowsing 遥测段：它卸载后不清理，会拿旧 ID 谎报成功。
# ==================================================================
function Get-WebAnnotatorIdsFromPreferences {
    param(
        [string]$PrefFile,
        [string]$BrowserName
    )

    $found = @()

    if (-not (Test-Path $PrefFile)) { return $found }
    $raw = $null
    try { $raw = [System.IO.File]::ReadAllText($PrefFile) }
    catch {
        Write-Host "    读取失败: $PrefFile" -ForegroundColor DarkGray
        return $found
    }

    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch { $json = $null }
    if ($null -eq $json -or $null -eq $json.extensions -or $null -eq $json.extensions.settings) {
        return $found
    }

    foreach ($p in $json.extensions.settings.PSObject.Properties) {
        $entry = $p.Value

        # 空对象 = 卸载残留墓碑，跳过（这是本次修复的核心）
        if ($null -eq $entry -or $entry.PSObject.Properties.Count -eq 0) { continue }

        $serialized = ($entry | ConvertTo-Json -Depth 10 -Compress)
        $isWA = $false
        foreach ($kw in $EXT_KEYWORDS) {
            if ($serialized -match [regex]::Escape($kw)) { $isWA = $true; break }
        }

        $path = $entry.path
        $pathOk = $false
        if ($path) {
            $pathOk = Test-Path $path
            if ($pathOk -and -not $isWA) {
                # 条目里没有 manifest 名时，校验 path 目录下的 manifest.json
                $mf = Join-Path $path "manifest.json"
                if (Test-Path $mf) {
                    try {
                        $mfText = [System.IO.File]::ReadAllText($mf)
                        foreach ($kw in $EXT_KEYWORDS) {
                            if ($mfText.Contains($kw)) { $isWA = $true; break }
                        }
                    } catch {}
                }
            }
        }

        if ($isWA) {
            if ($found -notcontains $p.Name) {
                $found += $p.Name
                Write-Host "  [${BrowserName}] $PrefFile（已加载扩展记录）" -ForegroundColor DarkGray
                Write-Host "      → 扩展 ID: $($p.Name)  path存在=$pathOk" -ForegroundColor Green
            }
        }
    }

    return $found
}

# ==================================================================
# 1. 扫描浏览器，收集扩展 ID
# ==================================================================
Write-Host "== 1. 扫描已加载的 WebAnnotator 扩展 ID ==" -ForegroundColor Cyan

$edgeIds = @()
$chromeIds = @()

$browsers = @(
    @{ Name = "Edge";   Base = "$env:LOCALAPPDATA\Microsoft\Edge\User Data" },
    @{ Name = "Chrome"; Base = "$env:LOCALAPPDATA\Google\Chrome\User Data" }
)

foreach ($b in $browsers) {
    if (-not (Test-Path $b.Base)) { continue }

    $profiles = @("Default") + @(
        Get-ChildItem $b.Base -Directory -Filter "Profile*" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name
    )

    $collected = @()
    foreach ($profile in $profiles) {
        # 权威记录可能在 Preferences（Chrome）或 Secure Preferences（Edge 155+）
        $collected += Get-WebAnnotatorIdsFromPreferences (Join-Path $b.Base "$profile\Preferences") $b.Name
        $collected += Get-WebAnnotatorIdsFromPreferences (Join-Path $b.Base "$profile\Secure Preferences") $b.Name
    }

    if ($b.Name -eq "Edge")   { $edgeIds   = $collected | Select-Object -Unique }
    else                      { $chromeIds = $collected | Select-Object -Unique }
}

# 手动指定时覆盖自动检测结果
if ($EdgeId)   { $edgeIds   = @($EdgeId);   Write-Host "  [Edge]   使用手动指定的扩展 ID: $EdgeId" -ForegroundColor Cyan }
if ($ChromeId) { $chromeIds = @($ChromeId); Write-Host "  [Chrome] 使用手动指定的扩展 ID: $ChromeId" -ForegroundColor Cyan }

# 汇总：找到哪个浏览器注册哪个，未找到的浏览器直接跳过（不注册）
foreach ($b in $browsers) {
    $n = if ($b.Name -eq "Edge") { @($edgeIds).Count } else { @($chromeIds).Count }
    if ($n -gt 0) {
        Write-Host "  [$($b.Name)] 检测到 $n 个扩展 ID → 将注册该浏览器" -ForegroundColor Green
    } else {
        Write-Host "  [$($b.Name)] 未检测到扩展 ID → 跳过（不注册）" -ForegroundColor DarkGray
    }
}

if (@($edgeIds).Count -eq 0 -and @($chromeIds).Count -eq 0) {
    Write-Host ""
    Write-Host "未检测到【已加载】的 WebAnnotator 扩展。" -ForegroundColor Yellow
    Write-Host "（即使浏览器里留有旧 ID 的残留记录，也不会注册——那不能证明扩展已加载。）" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "请先完成第 1 步：在浏览器中加载扩展" -ForegroundColor Yellow
    Write-Host "  edge://extensions（或 chrome://extensions）→ 开发者模式 → 加载已解压的扩展程序 → 选择 extension 目录" -ForegroundColor Yellow
    Write-Host "加载后再重跑本脚本；或直接用 -EdgeId / -ChromeId 手动指定 ID。" -ForegroundColor Yellow
    pause
    exit 1
}

# ==================================================================
# 2. 定位本地程序 exe（没有则从 publish 部署）
# ==================================================================
Write-Host ""
Write-Host "== 2. 定位本地程序 ==" -ForegroundColor Cyan

# 部署目录 = WebAnnotator 项目根目录（native-host 的上一级），
# 使 exe 与 WebAnnotatorData 同目录，整个文件夹可整体迁移（换电脑数据不丢）
$installDir = Split-Path $PSScriptRoot -Parent
$deployedExe = Join-Path $installDir "WebAnnotatorHost.exe"

if (-not (Test-Path $deployedExe)) {
    # 只在 WebAnnotator 项目内【相对】查找，不写死盘符/路径（换电脑、换盘符也能用）：
    #   1. 项目根目录（便携包布局：exe 与 WebAnnotatorData 同根）
    #   2. native-host\publish（开发编译产物）
    #   3. 项目根\publish
    #   4. native-host 根目录
    $candidates = @(
        (Join-Path $installDir "WebAnnotatorHost.exe"),
        (Join-Path $PSScriptRoot "publish\WebAnnotatorHost.exe"),
        (Join-Path $installDir "publish\WebAnnotatorHost.exe"),
        (Join-Path $PSScriptRoot "WebAnnotatorHost.exe")
    )
    $sourceExe = $null
    foreach ($cand in $candidates) {
        if (Test-Path $cand) { $sourceExe = $cand; break }
    }
    if ($sourceExe) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        try {
            Copy-Item $sourceExe $deployedExe -Force
        } catch {
            Write-Host "  复制失败：$($_.Exception.Message)" -ForegroundColor Red
            Write-Host "  本地程序可能正被浏览器占用，请关闭所有浏览器窗口后重试。" -ForegroundColor Red
            pause
            exit 1
        }
        Write-Host "  已从 $sourceExe 部署到 $installDir"
    } else {
        Write-Host "  未找到 WebAnnotatorHost.exe。" -ForegroundColor Red
        Write-Host "  请把 WebAnnotatorHost.exe 放到项目根目录（WebAnnotator\ 下），或先编译（native-host\publish\）。" -ForegroundColor Red
        pause
        exit 1
    }
} else {
    Write-Host "  使用已部署程序: $deployedExe"
}

# ==================================================================
# 3. 注册 host
# ==================================================================
Write-Host ""
Write-Host "== 3. 注册 Native Messaging Host ==" -ForegroundColor Cyan

# 逐个浏览器注册：找到哪个注册哪个；未找到的浏览器不传参（不注册）；
# 相同 ID 只注册一次（跨浏览器重复时跳过，不重复注册）
$installArgs = @("--install")
$registeredIds = @()   # 已注册的扩展 ID（全局去重）

foreach ($id in @($edgeIds | Select-Object -Unique)) {
    if ($registeredIds -notcontains $id) {
        Write-Host "  注册 Edge 扩展: $id" -ForegroundColor Green
        $installArgs += "--edge-id"; $installArgs += $id
        $registeredIds += $id
    } else {
        Write-Host "  Edge 扩展 $id 与已注册 ID 相同 → 跳过（不重复注册）" -ForegroundColor DarkGray
    }
}
foreach ($id in @($chromeIds | Select-Object -Unique)) {
    if ($registeredIds -notcontains $id) {
        Write-Host "  注册 Chrome 扩展: $id" -ForegroundColor Green
        $installArgs += "--chrome-id"; $installArgs += $id
        $registeredIds += $id
    } else {
        Write-Host "  Chrome 扩展 $id 与已注册 ID 相同 → 跳过（不重复注册）" -ForegroundColor DarkGray
    }
}
if ($registeredIds.Count -eq 0) {
    Write-Host "  没有可注册的扩展 ID，退出。" -ForegroundColor Red
    pause
    exit 1
}
if ($System) { $installArgs += "--system" }

& $deployedExe @installArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "  注册失败（exit=$LASTEXITCODE）" -ForegroundColor Red
    pause
    exit 1
}

# ==================================================================
# 4. 回读清单确认
# ==================================================================
Write-Host ""
Write-Host "== 4. 注册结果：允许的来源 ==" -ForegroundColor Cyan
$manifest = Join-Path $installDir "com.codearts.webannotator.json"
if (Test-Path $manifest) {
    $j = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($o in $j.allowed_origins) { Write-Host "  $o" -ForegroundColor Green }
} else {
    Write-Host "  未找到清单文件！" -ForegroundColor Red
}

Write-Host ""
Write-Host "完成。请到 edge://extensions（或 chrome://extensions）刷新扩展后使用。" -ForegroundColor Green
pause

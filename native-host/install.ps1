# 日常安装推荐使用 auto-register.ps1（自动检测浏览器中已加载的扩展 ID，找到哪个注册哪个）；
# 本脚本用于手动指定扩展 ID / 自定义安装路径的场景。
<#
.SYNOPSIS
    WebAnnotator 安装脚本 - 部署本地程序并注册 Native Messaging Host。

.DESCRIPTION
    将 WebAnnotatorHost.exe 部署到指定路径，并通过 C# 内置安装逻辑
    完成注册表写入与 host manifest 生成（Chrome + Edge）。
    默认使用 HKCU（无需管理员权限），-System 参数使用 HKLM（需管理员权限）。

.PARAMETER ChromeExtensionId
    Chrome 扩展 ID（用于 host manifest allowed_origins）。

.PARAMETER EdgeExtensionId
    Edge 扩展 ID（用于 host manifest allowed_origins）。

.PARAMETER InstallPath
    安装目录，默认 $env:LOCALAPPDATA\WebAnnotator。

.PARAMETER System
    使用 HKLM 系统级安装（需管理员权限）。

.EXAMPLE
    .\install.ps1 -ChromeExtensionId "abcdef..." -EdgeExtensionId "ghijkl..."
    .\install.ps1 -ChromeExtensionId "abcdef..." -InstallPath "D:\MyApps\WebAnnotator"
    .\install.ps1 -ChromeExtensionId "abcdef..." -System
#>

param(
    [string]$ChromeExtensionId,
    [string]$EdgeExtensionId,
    [string]$InstallPath = "",
    [switch]$System
)

$ErrorActionPreference = "Stop"

# 未指定安装路径时，部署到 WebAnnotator 项目根目录（native-host 的上一级），
# 使 exe 与 WebAnnotatorData 同目录，整个文件夹可整体迁移（换电脑数据不丢）
if ([string]::IsNullOrWhiteSpace($InstallPath)) {
    $InstallPath = Split-Path -Parent $PSScriptRoot
}

# 输出带颜色的信息
function Write-Info([string]$msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "[OK]   $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "[ERR]  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "=========================================" -ForegroundColor Yellow
Write-Host "  WebAnnotator 安装脚本 v1.0.0" -ForegroundColor Yellow
Write-Host "=========================================" -ForegroundColor Yellow
Write-Host ""

try {
    # 1. 定位 WebAnnotatorHost.exe（全部【相对】查找，不写死盘符，换电脑可用）
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $projectRoot = Split-Path -Parent $scriptDir
    $exeCandidates = @(
        (Join-Path $projectRoot "WebAnnotatorHost.exe"),          # 项目根目录（便携包布局）
        (Join-Path $scriptDir "publish\WebAnnotatorHost.exe"),    # native-host\publish（编译产物）
        (Join-Path $projectRoot "publish\WebAnnotatorHost.exe"),  # 项目根\publish
        (Join-Path $scriptDir "WebAnnotatorHost.exe")             # native-host 根目录
    )
    $sourceExe = $null
    foreach ($candidate in $exeCandidates) {
        if (Test-Path $candidate) {
            $sourceExe = $candidate
            break
        }
    }

    if ($null -eq $sourceExe) {
        Write-Err "未找到 WebAnnotatorHost.exe。请将其放到项目根目录（WebAnnotator\ 下），"
        Write-Err "或先执行 dotnet publish 生成发布产物："
        Write-Err "  dotnet publish WebAnnotatorHost.csproj -c Release -r win-x64 -o .\publish"
        exit 1
    }

    Write-Info "源程序：$sourceExe"
    Write-Info "安装目录：$InstallPath"

    # 2. 创建安装目录
    if (-not (Test-Path $InstallPath)) {
        New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
        Write-Info "已创建安装目录。"
    }

    # 3. 部署本地程序到安装路径（源与目标相同时跳过复制）
    $destExe = Join-Path $InstallPath "WebAnnotatorHost.exe"
    if ($sourceExe -ne $destExe) {
        Copy-Item -Path $sourceExe -Destination $destExe -Force
        Write-Ok "已部署 WebAnnotatorHost.exe 到 $InstallPath"
    } else {
        Write-Ok "源与目标相同，无需复制（$destExe）"
    }

    # 4. 调用 WebAnnotatorHost.exe --install 执行 C# 内置安装逻辑
    $installArgs = @("--install")
    if ($ChromeExtensionId) { $installArgs += @("--chrome-id", $ChromeExtensionId) }
    if ($EdgeExtensionId)   { $installArgs += @("--edge-id", $EdgeExtensionId) }
    if ($System)            { $installArgs += "--system" }

    Write-Info "执行注册：$destExe $installArgs"
    $process = Start-Process -FilePath $destExe -ArgumentList $installArgs -NoNewWindow -Wait -PassThru

    if ($process.ExitCode -ne 0) {
        Write-Err "注册失败（退出码 $($process.ExitCode)）。"
        exit $process.ExitCode
    }

    # 5. 输出安装完成提示与扩展加载指引
    Write-Host ""
    Write-Ok "安装完成！"
    Write-Host ""
    Write-Host "下一步：在浏览器中加载扩展" -ForegroundColor Yellow
    Write-Host "  Chrome:" -ForegroundColor White
    Write-Host "    1. 打开 chrome://extensions" -ForegroundColor Gray
    Write-Host "    2. 开启右上角「开发者模式」" -ForegroundColor Gray
    Write-Host "    3. 点击「加载已解压的扩展程序」" -ForegroundColor Gray
    Write-Host "    4. 选择 extension 目录" -ForegroundColor Gray
    Write-Host "    5. 加载后在扩展卡片查看 ID（若未传 -ChromeExtensionId 则需手动编辑 host manifest）" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Edge:" -ForegroundColor White
    Write-Host "    1. 打开 edge://extensions" -ForegroundColor Gray
    Write-Host "    2. 开启左下角「开发人员模式」" -ForegroundColor Gray
    Write-Host "    3. 点击「加载解压缩的扩展」" -ForegroundColor Gray
    Write-Host "    4. 选择 extension 目录" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  首次使用：点击扩展图标，按引导选择数据存放路径。" -ForegroundColor Yellow
    Write-Host ""

    if (-not $ChromeExtensionId -and -not $EdgeExtensionId) {
        Write-Host "提示：未传入扩展 ID，host manifest 的 allowed_origins 为空。" -ForegroundColor Yellow
        Write-Host "      加载扩展后获取 ID，重新运行此脚本传入 -ChromeExtensionId / -EdgeExtensionId。" -ForegroundColor Yellow
        Write-Host ""
    }

}
catch {
    Write-Err "安装过程发生错误：$($_.Exception.Message)"
    Write-Err "请检查权限与路径后重试。"
    exit 1
}
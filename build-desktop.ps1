param(
    [string]$Python = "python.exe",
    [string]$IndexUrl = "https://pypi.tuna.tsinghua.edu.cn/simple",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $projectRoot ".venv-desktop"
$venvPython = Join-Path $venvPath "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
    & $Python -m venv $venvPath
}

if (-not $SkipInstall) {
    $pipArguments = @("-m", "pip", "install", "-r", (Join-Path $projectRoot "requirements-desktop.txt"))
    if ($IndexUrl) {
        $pipArguments += @("--index-url", $IndexUrl)
    }
    & $venvPython @pipArguments
}

& $venvPython (Join-Path $projectRoot "scripts\create_icon.py")
& $venvPython -m PyInstaller --noconfirm --clean (Join-Path $projectRoot "SnowFlake.spec")

$exePath = Join-Path $projectRoot "dist\SnowFlake\SnowFlake.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "构建完成，但未找到 SnowFlake.exe"
}

Write-Host ""
Write-Host "桌面版构建完成：" -ForegroundColor Green
Write-Host $exePath

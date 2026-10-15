#Requires -Version 5.1
# 停掉本分享版占用的本地服务（默认 5177），关掉界面窗口后用它收尾。
param([int]$Port = 0)

$ErrorActionPreference = 'SilentlyContinue'

# 不指定端口时，用 data\config.json 里的那个（和启动脚本保持一致）
if ($Port -eq 0) {
    $Port = 5177
    try {
        $root = Split-Path -Parent $MyInvocation.MyCommand.Path
        $cfg = Join-Path $root 'data\config.json'
        if (Test-Path $cfg) {
            $json = (Get-Content $cfg -Raw -Encoding UTF8) | ConvertFrom-Json
            if ($json.port) { $Port = [int]$json.port }
        }
    } catch { $Port = 5177 }
}

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "端口 $Port 上没有正在运行的服务。" -ForegroundColor Yellow
    exit 0
}

foreach ($c in $conns) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p) {
        Write-Host ('正在停止 ' + $p.ProcessName + ' (pid=' + $p.Id + ')') -ForegroundColor Cyan
        Stop-Process -Id $p.Id -Force
    }
}

Start-Sleep -Seconds 1
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host '仍有进程占用端口，请手动结束。' -ForegroundColor Red
    exit 1
}
Write-Host '已停止。' -ForegroundColor Green
exit 0

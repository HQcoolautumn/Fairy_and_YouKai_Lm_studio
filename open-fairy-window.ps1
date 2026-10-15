#Requires -Version 5.1
<#
open-fairy-window.ps1 —— 用一个「没有地址栏/搜索栏」的独立应用窗口打开界面，并且启动即全屏。

原理：Edge / Chrome 的 --app=<url> 会开一个不带标签页和工具栏的独立窗口，
      --start-fullscreen 等价于刚打开就按了 F11，所以看不到网址栏，按 Esc 就能退出全屏。
      独立 --user-data-dir 保证即使浏览器本来就在运行，命令行参数也一定生效。
#>

param(
    [string]$Url = 'http://127.0.0.1:5177/?fs=1'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $root 'browser-profile'
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }

function Get-ExeFromCommand {
    param([string]$Command)
    if (-not $Command) { return $null }
    $m = [regex]::Match($Command, '"([^"]+\.exe)"')
    if ($m.Success) { return $m.Groups[1].Value }
    $m = [regex]::Match($Command, '([^\s]+\.exe)')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Find-Browser {
    # 1) 先试系统默认浏览器（只有 Edge / Chrome 支持 --app 模式）
    $progId = $null
    try {
        $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction Stop).ProgId
    } catch { $progId = $null }

    if ($progId) {
        foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
            $key = Join-Path $hive ($progId + '\shell\open\command')
            try {
                $exe = Get-ExeFromCommand ((Get-ItemProperty $key -ErrorAction Stop).'(default)')
                if ($exe -and (Test-Path $exe) -and ($exe -match 'msedge\.exe$|chrome\.exe$')) { return $exe }
            } catch { } # 这个键不存在就继续找下一个
        }
    }

    # 2) 退回常见安装路径
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

$browser = Find-Browser

if (-not $browser) {
    Write-Host '没找到 Edge / Chrome，已用默认浏览器打开。请手动按 F11 进入全屏。' -ForegroundColor Yellow
    Start-Process $Url
    exit 0
}

$appArgs = @(
    '--app=' + $Url,
    '--start-fullscreen',
    '--user-data-dir=' + $profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    # 本地界面：允许自动播放，避免开场动画和语音被浏览器拦截
    '--autoplay-policy=no-user-gesture-required'
)

Write-Host ('正在以全屏应用窗口打开：' + (Split-Path -Leaf $browser)) -ForegroundColor Cyan
Start-Process -FilePath $browser -ArgumentList $appArgs
exit 0

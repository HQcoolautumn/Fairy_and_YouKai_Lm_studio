param([switch]$NoBrowser)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'server.js'

# 分享版：配置与日志都放在本目录的 data\ 下（不碰 %USERPROFILE%\.fairy-lmstudio，
# 也不影响原版），整个文件夹拷到哪都能直接跑。
$env:FAIRY_HOME = Join-Path $root 'data'
if (-not (Test-Path $env:FAIRY_HOME)) { New-Item -ItemType Directory -Force -Path $env:FAIRY_HOME | Out-Null }

# 每个候选都真的跑一次 -v，能出版本号才算可用（避免挑到一个残缺的 node）
function Test-NodeExe {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path $Path)) { return $false }
    try {
        $out = & $Path -v 2>$null
        return ($out -match '^v\d+')
    } catch {
        return $false
    }
}

function Get-Node {
    # 1) 包内自带的运行时（对方电脑没装 Node.js 也能直接跑）
    $bundled = Join-Path $root 'runtime\node.exe'
    if (Test-NodeExe $bundled) { return $bundled }
    # 2) 系统里装过的
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and (Test-NodeExe $cmd.Source)) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-NodeExe $p) { return $p }
    }
    return $null
}

$node = Get-Node
if (-not $node) {
    Write-Host '' 
    Write-Host '没找到可用的 Node.js 运行时。' -ForegroundColor Red
    Write-Host '本压缩包里应该自带一个 runtime\node.exe，请确认解压完整（不要只把文件拖出来）。' -ForegroundColor Yellow
    Write-Host '也可以自己装一个：https://nodejs.org/' -ForegroundColor Yellow
    exit 1
}

# 启动前的体检：LM Studio 没开的话界面能打开但对话会失败，提前说清楚
function Test-LmStudio {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:1234/v1/models' -TimeoutSec 3 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# 端口以 data\config.json 里的为准（改过端口也不会误判成「已经启动了」）
function Get-FairyPort {
    $port = 5177
    try {
        $cfg = Join-Path $env:FAIRY_HOME 'config.json'
        if (Test-Path $cfg) {
            $json = (Get-Content $cfg -Raw -Encoding UTF8) | ConvertFrom-Json
            if ($json.port) { $port = [int]$json.port }
        }
    } catch { $port = 5177 }
    return $port
}

$fairyPort = Get-FairyPort

function Test-FairyAlive {
    try {
        $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $fairyPort + '/') -TimeoutSec 3 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# 用「无地址栏的独立应用窗口 + 启动即全屏」打开界面（Esc 退出全屏）
function Open-FairyWindow {
    $url = 'http://127.0.0.1:' + $fairyPort + '/?fs=1'
    $launcher = Join-Path $root 'open-fairy-window.ps1'
    if (Test-Path $launcher) {
        try {
            & $launcher -Url $url
            return
        } catch {
            Write-Host ('全屏窗口启动失败，退回普通浏览器：' + $_.Exception.Message) -ForegroundColor Yellow
        }
    }
    Start-Process $url
}

# 已经在跑时直接把页面调出来，不要重复起 node（否则会撞端口后静默失败）
if (Test-FairyAlive) {
    Write-Host 'Fairy 已在运行，正在打开界面…' -ForegroundColor Green
    if (-not $NoBrowser) { Open-FairyWindow }
    exit 0
}

$configPath = Join-Path $env:FAIRY_HOME 'config.json'
if (Test-Path $configPath) {
    Write-Host "配置: $configPath"
}

$logDir = $env:FAIRY_HOME
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'server.log'

if ($NoBrowser) { $env:FAIRY_NO_BROWSER = '1' }

# Fairy 真声：确保本地音色服务在运行（后台启动，不阻塞界面）
$voiceScript = Join-Path $root 'start-voice.ps1'
if (Test-Path $voiceScript) {
    try {
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File $voiceScript
    } catch {
        Write-Host '真声服务启动异常，将回退到系统音色。' -ForegroundColor Yellow
    }
}

# YouKai 真声：与主音色并行（9881），没有训练好的权重时脚本会自行跳过
$voiceYouKaiScript = Join-Path $root 'start-voice-youkai.ps1'
if (Test-Path $voiceYouKaiScript) {
    try {
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File $voiceYouKaiScript
    } catch {
        Write-Host 'YouKai 真声服务启动异常，将回退到系统音色。' -ForegroundColor Yellow
    }
}

if (-not (Test-LmStudio)) {
    Write-Host '' 
    Write-Host '体检提示：LM Studio 的本地服务（127.0.0.1:1234）现在连不上。' -ForegroundColor Yellow
    Write-Host '  界面照样能打开，但对话会失败。请打开 LM Studio，' -ForegroundColor Yellow
    Write-Host '  加载一个模型，并把左侧 Developer 里的本地服务打开（Started）。' -ForegroundColor Yellow
}

Write-Host '正在启动 FAIRY // LOCAL MODEL LINK ...' -ForegroundColor Cyan
Write-Host ('运行时: ' + $node) -ForegroundColor DarkGray
Start-Process -FilePath $node -ArgumentList ('"' + $server + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $logDir 'server.err.log')

if (-not $NoBrowser) {
    for ($i = 0; $i -lt 20; $i += 1) {
        Start-Sleep -Milliseconds 500
        if (Test-FairyAlive) {
            Open-FairyWindow
            break
        }
    }
}

if (Test-FairyAlive) {
    Write-Host ('已就绪：http://127.0.0.1:' + $fairyPort + '/') -ForegroundColor Green
} else {
    Write-Host '启动未完成，请查看日志：' -NoNewline; Write-Host $logFile -ForegroundColor DarkGray
    Write-Host ('如 ' + $fairyPort + ' 端口被占用，先运行 Stop-Fairy.bat 再重试。') -ForegroundColor DarkYellow
    $errLog = Join-Path $logDir 'server.err.log'
    if (Test-Path $errLog) {
        $tail = (Get-Content $errLog -Encoding UTF8 -Tail 6 -ErrorAction SilentlyContinue) -join "`n"
        if ($tail) { Write-Host '--- 错误日志 ---' -ForegroundColor DarkGray; Write-Host $tail }
    }
}

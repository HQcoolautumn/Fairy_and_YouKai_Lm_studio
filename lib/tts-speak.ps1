param(
    [string]$TextFile,
    [string]$Voice,
    [int]$Rate = 0,
    [int]$Pitch = 0,
    [string]$Out
)

$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($TextFile, (New-Object System.Text.UTF8Encoding($false)))

function Build-Ssml([string]$content, [int]$r, [int]$p, [string]$lang) {
    $rate = if ($r -ge 0) { '+' + $r + '%' } else { [string]$r + '%' }
    $pitch = if ($p -ge 0) { '+' + $p + '%' } else { [string]$p + '%' }
    $escaped = [System.Security.SecurityElement]::Escape($content)
    return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + $lang + '"><prosody rate="' + $rate + '" pitch="' + $pitch + '">' + $escaped + '</prosody></speak>'
}

if ($Voice -like 'MSTTS_*') {
    # 系统语音（SAPI 看不到的那些）走 WinRT 合成
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' -ErrorAction SilentlyContinue
    $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]

    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    # 注意：PowerShell 变量名大小写不敏感，不能用 $voice，否则会覆盖参数 $Voice
    $resolvedVoice = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) |
        Where-Object { (([string]$_.Id).Split('\'))[-1] -eq $Voice } |
        Select-Object -First 1
    if (-not $resolvedVoice) {
        $resolvedVoice = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) |
            Where-Object { ([string]$_.Id) -like '*MSTTS_V110_zhCN_HuihuiM' } |
            Select-Object -First 1
    }
    if (-not $resolvedVoice) { throw "WinRT voice not available: $Voice" }
    $synth.Voice = $resolvedVoice

    $lang = 'zh-CN'
    if ($resolvedVoice.Language) { $lang = [string]$resolvedVoice.Language }
    $ssml = Build-Ssml $text $Rate $Pitch $lang
    $async = $synth.SynthesizeSsmlToStreamAsync($ssml)

    $extType = [Type]::GetType('System.WindowsRuntimeSystemExtensions, System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
    $streamType = [Type]::GetType('Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime')
    if (-not $streamType) {
        $streamType = [Type]::GetType('Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
    }
    $asTask = $extType.GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 } |
        Select-Object -First 1
    $task = $asTask.MakeGenericMethod($streamType).Invoke($null, @($async))
    $task.Wait()

    $streamExt = [Type]::GetType('System.IO.WindowsRuntimeStreamExtensions, System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
    $asStream = $streamExt.GetMethods() |
        Where-Object { $_.Name -eq 'AsStream' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IRandomAccessStream' } |
        Select-Object -First 1
    $netStream = $asStream.Invoke($null, @($task.Result))
    try {
        if (Test-Path $Out) { Remove-Item $Out -Force -ErrorAction SilentlyContinue }
        $fileStream = [System.IO.File]::Create($Out)
        try { $netStream.CopyTo($fileStream) } finally { $fileStream.Close() }
    } finally { $netStream.Close() }
} else {
    # 常规 SAPI 合成
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.Volume = 100
    $synth.Rate = $Rate

    $lang = 'zh-CN'
    if ($Voice) {
        try { $synth.SelectVoice($Voice) } catch { }
        foreach ($info in $synth.GetInstalledVoices()) {
            if ($info.VoiceInfo.Name -eq $Voice -and $info.VoiceInfo.Culture) { $lang = [string]$info.VoiceInfo.Culture }
        }
    }

    if (Test-Path $Out) { Remove-Item $Out -Force -ErrorAction SilentlyContinue }
    $synth.SetOutputToWaveFile($Out)
    try {
        if ($Pitch -ne 0) {
            $synth.SpeakSsml((Build-Ssml $text $Rate $Pitch $lang))
        } else {
            $synth.Speak($text)
        }
    } finally {
        $synth.SetOutputToNull()
        $synth.Dispose()
    }
}

if (-not (Test-Path $Out)) { throw 'TTS failed: no audio file was produced' }
exit 0

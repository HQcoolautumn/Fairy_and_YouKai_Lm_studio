$ErrorActionPreference = 'Stop'

$result = New-Object System.Collections.ArrayList

Add-Type -AssemblyName System.Speech
$sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($info in $sapi.GetInstalledVoices()) {
    $culture = ''
    if ($info.VoiceInfo.Culture) { $culture = [string]$info.VoiceInfo.Culture }
    $null = $result.Add(@{
        id      = $info.VoiceInfo.Name
        name    = $info.VoiceInfo.Name
        culture = $culture
        source  = 'sapi'
    })
}
$sapi.Dispose()

try {
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' -ErrorAction SilentlyContinue
    $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices

    $existing = @($result | ForEach-Object { [string]$_.name })
    foreach ($v in $all) {
        $display = [string]$v.DisplayName
        $duplicate = $false
        foreach ($n in $existing) { if ($n.StartsWith($display)) { $duplicate = $true; break } }
        if ($duplicate) { continue }

        $id = ([string]$v.Id).Split('\')[-1]
        if (-not $id) { continue }
        $null = $result.Add(@{
            id      = $id
            name    = $display
            culture = [string]$v.Language
            source  = 'winrt'
        })
    }
} catch {
    # WinRT 不可用时只返回 SAPI 音色
}

if ($result.Count -eq 1) {
    Write-Output ('[{0}]' -f ($result[0] | ConvertTo-Json -Compress -Depth 4))
} else {
    Write-Output ($result | ConvertTo-Json -Compress -Depth 4)
}
exit 0
